"""Event-driven daemon: connector -> state -> greeks -> scalper -> guard -> order."""

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import yaml

from src.connector.ib import IBConnector
from src.core.metrics import get_metrics
from src.core.state.classifier import StateClassifier
from src.core.state.composite import CompositeState
from src.core.state.enums import HedgeExecState
from src.core.logging_utils import log_composite_state, log_target_position, log_order_status
from src.engine.state import TradingState
from src.engine.state_machine import DaemonState, DaemonStateMachine
from src.execution.execution_fsm import ExecutionFSM
from src.execution.order_manager import OrderManager
from src.fsm.adapters import target_position_event_from_intent
from src.fsm.hedge_execution_fsm import HedgeExecutionFSM
from src.market.market_data import MarketData
from src.positions.portfolio import parse_positions, portfolio_delta
from src.positions.position_book import PositionBook
from src.pricing.greeks import Greeks
from src.risk.guard import RiskGuard
from src.strategy.gamma_scalper import gamma_scalper_intent
from src.strategy.hedge_gate import apply_hedge_gates, should_output_target

logger = logging.getLogger(__name__)


def read_config(config_path: Optional[str] = None) -> tuple[dict, str]:
    """Load YAML config with env overrides for IB. Returns (config, resolved_path)."""
    config_path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(config_path).exists():
        config_path = "config/config.yaml.example"
    config_path = str(Path(config_path).resolve())
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    return config, config_path


class TradingDaemon:
    """Single-process event-driven gamma scalping daemon."""

    def __init__(self, config: dict, config_path: Optional[str] = None):
        # 1.Init Config
        self.config = config
        self._config_path = config_path

        # 1.a IB Connector
        ib_cfg = config.get("ib", {})
        self.connector = IBConnector(
            host=ib_cfg.get("host", "127.0.0.1"),
            port=ib_cfg.get("port", 4001),
            client_id=ib_cfg.get("client_id", 1),
            connect_timeout=ib_cfg.get("connect_timeout", 60.0),
        )

        # 1.b Dynamic Config
        self.structure = config.get("structure", {})
        self.hedge_cfg = config.get("hedge", {})
        self.risk_cfg = config.get("risk", {})
        self.greeks_cfg = config.get("greeks", {})
        self.earnings_cfg = config.get("earnings", {})
        self.symbol = config.get("symbol", "NVDA")
        self.paper_trade = self.risk_cfg.get("paper_trade", True)
        self.order_type = config.get("order", {}).get("order_type", "market")
        self.guard = RiskGuard(
            cooldown_sec=self.hedge_cfg.get("cooldown_sec", 60),
            max_daily_hedge_count=self.risk_cfg.get("max_daily_hedge_count", 50),
            max_position_shares=self.risk_cfg.get("max_position_shares", 2000),
            max_daily_loss_usd=self.risk_cfg.get("max_daily_loss_usd", 5000.0),
            max_net_delta_shares=self.risk_cfg.get("max_net_delta_shares"),
            max_spread_pct=self.risk_cfg.get("max_spread_pct"),
            min_price_move_pct=self.hedge_cfg.get("min_price_move_pct", 0.0),
            earnings_dates=self.earnings_cfg.get("dates", []),
            blackout_days_before=self.earnings_cfg.get("blackout_days_before", 3),
            blackout_days_after=self.earnings_cfg.get("blackout_days_after", 1),
            trading_hours_only=self.risk_cfg.get("trading_hours_only", True),
        )

        # 2. Object References
        self.state = TradingState()
        self._state_machine = DaemonStateMachine()
        self._hedge_lock = asyncio.Lock()
        self._last_config_mtime: Optional[float] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        min_dte = self.structure.get("min_dte", 21)
        max_dte = self.structure.get("max_dte", 35)
        atm_band = self.structure.get("atm_band_pct", 0.03)
        self._position_book = PositionBook(
            self.state, self.symbol, min_dte=min_dte, max_dte=max_dte, atm_band_pct=atm_band
        )
        self._market_data = MarketData(self.state)
        self._order_manager = OrderManager()
        self._execution_fsm = ExecutionFSM(self._order_manager)
        min_hedge_shares = self.hedge_cfg.get("min_hedge_shares", 10)
        state_space_hedge = (self.config.get("state_space") or {}).get("hedge") or {}
        min_hedge_shares = state_space_hedge.get("min_hedge_shares", min_hedge_shares)
        self._hedge_execution_fsm = HedgeExecutionFSM(min_hedge_shares=min_hedge_shares)
        self._order_manager.set_hedge_execution_fsm(self._hedge_execution_fsm)
        self._metrics = get_metrics()

        # 3. Static Defaults
        self._heartbeat_interval = 10.0
        self._config_reload_interval = 30.0

    def _reload_config(self, config: dict) -> None:
        """Apply hot-reloadable config (IB host/port require restart)."""
        self.config = config

        self.structure = config.get("structure", self.structure)
        self.hedge_cfg = config.get("hedge", self.hedge_cfg)
        self.greeks_cfg = config.get("greeks", self.greeks_cfg)
        self.risk_cfg = config.get("risk", self.risk_cfg)
        self.earnings_cfg = config.get("earnings", self.earnings_cfg)
        if "paper_trade" in self.risk_cfg:
            self.paper_trade = self.risk_cfg["paper_trade"]
        self.order_type = config.get("order", {}).get("order_type", self.order_type)
        self.guard.update_config(
            cooldown_sec=self.hedge_cfg.get("cooldown_sec"),
            max_daily_hedge_count=self.risk_cfg.get("max_daily_hedge_count"),
            max_position_shares=self.risk_cfg.get("max_position_shares"),
            max_daily_loss_usd=self.risk_cfg.get("max_daily_loss_usd"),
            max_net_delta_shares=self.risk_cfg.get("max_net_delta_shares"),
            max_spread_pct=self.risk_cfg.get("max_spread_pct"),
            min_price_move_pct=self.hedge_cfg.get("hedge", {}).get("min_price_move_pct"),
            earnings_dates=self.earnings_cfg.get("dates"),
            blackout_days_before=self.earnings_cfg.get("blackout_days_before"),
            blackout_days_after=self.earnings_cfg.get("blackout_days_after"),
            trading_hours_only=self.risk_cfg.get("trading_hours_only"),
        )

    async def _reload_config_loop(self) -> None:
        """Periodically check config file mtime and reload if changed."""
        if not self._config_path or not Path(self._config_path).exists():
            return
        while self._state_machine.is_running():
            await asyncio.sleep(self._config_reload_interval)
            if not self._state_machine.is_running():
                return
            try:
                mtime = Path(self._config_path).stat().st_mtime
                if (
                    self._last_config_mtime is not None
                    and mtime > self._last_config_mtime
                ):
                    config, _ = read_config(self._config_path)
                    self._reload_config(config)
                    self._last_config_mtime = mtime
                    logger.info("Config reloaded from %s", self._config_path)
                elif self._last_config_mtime is None:
                    self._last_config_mtime = mtime
            except Exception as e:
                logger.debug("Config reload check failed: %s", e)

    async def _refresh_positions(self) -> None:
        """Fetch positions from IB and update state."""
        positions = await self.connector.get_positions()
        min_dte = self.structure.get("min_dte", 21)
        max_dte = self.structure.get("max_dte", 35)
        atm_band = self.structure.get("atm_band_pct", 0.03)
        spot = self.state.get_underlying_price()
        _, stock_shares = parse_positions(
            positions,
            self.symbol,
            min_dte=min_dte,
            max_dte=max_dte,
            atm_band_pct=atm_band,
            spot=spot,
        )
        self.state.set_positions(positions, stock_shares)

    def _on_ticker(self, ticker: Any) -> None:
        """Called on each ticker update from IB (may be from IB thread)."""
        try:
            self._market_data.touch_ts()
            bid = getattr(ticker, "bid", None)
            ask = getattr(ticker, "ask", None)
            if bid is not None and ask is not None:
                self.state.set_underlying_quote(float(bid), float(ask))
            else:
                last = getattr(ticker, "last", None)
                if last is not None:
                    self.state.set_underlying_price(float(last))
            self._maybe_hedge_threadsafe()
        except Exception as e:
            logger.debug("ticker callback error: %s", e)

    def _maybe_hedge_threadsafe(self) -> None:
        """Threadsafe: schedule maybe_hedge to be run safely from any thread using call_soon_threadsafe."""
        if self._state_machine.is_running() and self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._maybe_hedge(), loop=self._loop)
            )

    def _maybe_hedge_in_loop(self) -> None:
        """Schedule maybe_hedge on the event loop (must be called from within the event loop)."""
        if self._state_machine.is_running() and self._loop and self._loop.is_running():
            asyncio.ensure_future(self._maybe_hedge(), loop=self._loop)

    async def _compute_hedge_decision(self) -> Optional[tuple]:
        """Compute hedge via state space: classify -> intent -> gates. Returns (intent, cs, spot) or None."""
        await self._refresh_positions()
        spot = self.state.get_underlying_price()
        if spot is None or spot <= 0:
            logger.debug("No spot price, skip hedge")
            return None
        positions = self.state.get_positions()
        min_dte = self.structure.get("min_dte", 21)
        max_dte = self.structure.get("max_dte", 35)
        atm_band = self.structure.get("atm_band_pct", 0.03)
        legs, stock_shares = parse_positions(
            positions,
            self.symbol,
            min_dte=min_dte,
            max_dte=max_dte,
            atm_band_pct=atm_band,
            spot=spot,
        )
        r = self.greeks_cfg.get("risk_free_rate", 0.05)
        vol = self.greeks_cfg.get("volatility", 0.35)
        greeks = Greeks(legs, stock_shares, spot, r, vol)
        state_space_cfg = self.config.get("state_space", {})
        risk_halt = getattr(self.guard, "_circuit_breaker", False)
        data_lag_ms = None
        if self._market_data.last_ts is not None:
            data_lag_ms = (time.time() - self._market_data.last_ts) * 1000.0
        cs = StateClassifier.classify(
            self._position_book,
            self._market_data,
            greeks,
            self._order_manager,
            last_hedge_price=self.state.get_last_hedge_price(),
            last_hedge_ts=self.state.get_last_hedge_time(),
            data_lag_ms=data_lag_ms,
            risk_halt=risk_halt,
            config=state_space_cfg,
        )
        log_composite_state(cs=cs)
        self._metrics.set_data_lag_ms(data_lag_ms)
        self._metrics.set_delta_abs(abs(cs.net_delta))
        self._metrics.set_spread_bucket(cs.L.value if cs.L else None)
        if not should_output_target(cs):
            logger.debug("State gate: no target (O=%s D=%s L=%s E=%s S=%s)", cs.O.value, cs.D.value, cs.L.value, cs.E.value, cs.S.value)
            return None
        hedge_cfg = {**self.hedge_cfg, **(state_space_cfg.get("hedge") or {})}
        intent = gamma_scalper_intent(
            greeks.delta,
            stock_shares,
            delta_threshold_shares=hedge_cfg.get("delta_threshold_shares", 25),
            max_hedge_shares_per_order=hedge_cfg.get("max_hedge_shares_per_order", 500),
            config=hedge_cfg,
        )
        if intent is None:
            logger.debug("No hedge intent (delta within threshold)")
            return None
        min_hedge_shares = hedge_cfg.get("min_hedge_shares", 10)
        approved = apply_hedge_gates(
            intent,
            cs,
            self.guard,
            now_ts=time.time(),
            spot=spot,
            last_hedge_price=self.state.get_last_hedge_price(),
            spread_pct=self.state.get_spread_pct(),
            min_hedge_shares=min_hedge_shares,
        )
        if approved is None:
            logger.info("Hedge blocked by gates (delta=%.1f would %s %s)", cs.net_delta, intent.side, intent.quantity)
            return None
        if not self._hedge_execution_fsm.can_place_order():
            logger.warning("Execution not IDLE (E=%s), skip order", self._order_manager.effective_e_state().value)
            return None
        log_target_position(target_shares=intent.target_shares, cs=cs)
        return (approved, cs, spot)

    async def _maybe_hedge(self) -> None:
        """Run hedge logic once: state space -> intent -> gates -> HedgeExecutionFSM -> order."""
        async with self._hedge_lock:
            pass
        result = await self._compute_hedge_decision()
        if result is None:
            return
        intent, cs, spot = result
        now_ts = time.time()
        min_hedge_shares = self.hedge_cfg.get("min_hedge_shares", 10)
        state_space_hedge = (self.config.get("state_space") or {}).get("hedge") or {}
        min_hedge_shares = state_space_hedge.get("min_hedge_shares", min_hedge_shares)
        target_ev = target_position_event_from_intent(
            intent.target_shares, intent.side, intent.quantity,
            reason="delta_hedge", ts=now_ts,
        )
        self._hedge_execution_fsm.on_target(target_ev, cs.stock_pos)
        self._hedge_execution_fsm.on_plan_decide(send_order=intent.quantity >= min_hedge_shares)
        if self._hedge_execution_fsm.state != HedgeExecState.SEND:
            return
        if self.paper_trade:
            log_order_status(order_status="paper_send", side=intent.side, quantity=intent.quantity)
            logger.info(
                "PAPER: would %s %s shares (delta=%.1f)",
                intent.side,
                intent.quantity,
                cs.net_delta,
            )
            self._hedge_execution_fsm.on_order_placed()
            self._hedge_execution_fsm.on_ack_ok()
            self.guard.record_hedge_sent()
            self.state.set_last_hedge_time(now_ts)
            self.state.set_last_hedge_price(spot)
            self.state.inc_daily_hedge_count()
            self._metrics.inc_hedge_count()
            self._hedge_execution_fsm.on_full_fill()
            return
        self._hedge_execution_fsm.on_order_placed()
        log_order_status(order_status="sent", side=intent.side, quantity=intent.quantity)
        trade = await self.connector.place_order(
            self.symbol,
            intent.side,
            intent.quantity,
            order_type=self.order_type,
        )
        if trade is not None:
            self._hedge_execution_fsm.on_ack_ok()
            self.guard.record_hedge_sent()
            self.state.set_last_hedge_time(now_ts)
            self.state.set_last_hedge_price(spot)
            self.state.inc_daily_hedge_count()
            self._metrics.inc_hedge_count()
            logger.info("Hedge sent: %s %s %s", intent.side, intent.quantity, self.symbol)
            self._hedge_execution_fsm.on_full_fill()
        else:
            logger.warning("Order failed (trade is None)")
            self._hedge_execution_fsm.on_ack_reject()
            self._hedge_execution_fsm.on_try_resync()
            self._hedge_execution_fsm.on_positions_resynced()

    async def _heartbeat(self) -> None:
        """Periodic heartbeat to run maybe_hedge even without tick updates."""
        while self._state_machine.is_running():
            print(f"[HEARTBEAT] Sleeping for {self._heartbeat_interval} seconds...")
            await asyncio.sleep(self._heartbeat_interval)
            if self._state_machine.is_running():
                print("[HEARTBEAT] Woke up, running maybe_hedge()...")
                await self._maybe_hedge()

    # --- State handlers: each runs its logic and returns the next state ---

    async def _handle_idle(self) -> DaemonState:
        """IDLE: ready to start. Transition to CONNECTING."""
        return DaemonState.CONNECTING

    async def _handle_connecting(self) -> DaemonState:
        """CONNECTING: connect to IB. Returns CONNECTED or STOPPED."""
        logger.debug("Connecting to IB...")
        ok = await self.connector.connect()
        if not ok:
            logger.error("Could not connect to IB; exiting")
            return DaemonState.STOPPED
        return DaemonState.CONNECTED

    async def _handle_connected(self) -> DaemonState:
        """CONNECTED: fetch positions, get underlying price. Transition to RUNNING."""
        logger.debug("Fetching positions...")
        await self._refresh_positions()
        logger.debug("Getting underlying price for %s...", self.symbol)
        spot = await self.connector.get_underlying_price(self.symbol)
        self.state.set_underlying_price(spot)
        return DaemonState.RUNNING

    async def _handle_running(self) -> DaemonState:
        """RUNNING: subscribe, start background tasks, loop until stop requested."""
        logger.debug("Subscribing to ticker and positions...")
        self.connector.subscribe_ticker(self.symbol, self._on_ticker)
        self.connector.subscribe_positions(self._maybe_hedge_threadsafe)
        self._heartbeat_task = asyncio.create_task(self._heartbeat())
        self._config_reload_task = asyncio.create_task(self._reload_config_loop())
        logger.info(
            "Daemon running (symbol=%s, paper_trade=%s, config=%s)",
            self.symbol,
            self.paper_trade,
            self._config_path or "default",
        )
        try:
            while self._state_machine.is_running():
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass
        return DaemonState.STOPPING

    async def _handle_stopping(self) -> DaemonState:
        """STOPPING: cancel tasks, disconnect. Transition to STOPPED."""
        heartbeat_task = getattr(self, "_heartbeat_task", None)
        config_reload_task = getattr(self, "_config_reload_task", None)
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug("Heartbeat task raised before cancel: %s", e)
        if config_reload_task is not None:
            config_reload_task.cancel()
            try:
                await config_reload_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug("Config reload task raised before cancel: %s", e)
        await self.connector.disconnect()
        return DaemonState.STOPPED

    def _get_state_handlers(self) -> dict:
        """Map state -> async handler that returns next state."""
        return {
            DaemonState.IDLE: self._handle_idle,
            DaemonState.CONNECTING: self._handle_connecting,
            DaemonState.CONNECTED: self._handle_connected,
            DaemonState.RUNNING: self._handle_running,
            DaemonState.STOPPING: self._handle_stopping,
        }

    async def run(self) -> None:
        """State-driven loop: run handler for current state, transition to returned state."""
        self._loop = asyncio.get_running_loop()
        handlers = self._get_state_handlers()
        try:
            while self._state_machine.current != DaemonState.STOPPED:
                current = self._state_machine.current
                handler = handlers.get(current)
                if handler is None:
                    logger.warning("No handler for state %s; stopping", current.value)
                    break
                try:
                    next_state = await handler()
                    self._state_machine.transition(next_state)
                except Exception as e:
                    logger.exception("Handler %s raised: %s", current.value, e)
                    if self._state_machine.can_transition_to(DaemonState.STOPPING):
                        self._state_machine.transition(DaemonState.STOPPING)
                    else:
                        self._state_machine.transition(DaemonState.STOPPED)
        finally:
            if self._state_machine.current != DaemonState.STOPPED:
                if self._state_machine.current != DaemonState.STOPPING:
                    self._state_machine.transition(DaemonState.STOPPING)
                try:
                    await self._handle_stopping()
                except Exception as e:
                    logger.exception("Cleanup (_handle_stopping) failed: %s", e)
                self._state_machine.transition(DaemonState.STOPPED)

    def stop(self) -> None:
        self._state_machine.request_stop()


async def run_daemon(config_path: Optional[str] = None) -> None:
    """Load config and run the daemon."""
    config, resolved_path = read_config(config_path)
    daemon = TradingDaemon(config, config_path=resolved_path)
    await daemon.run()
