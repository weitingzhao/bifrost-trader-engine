"""Gamma scalping strategy: connector -> state -> greeks -> scalper -> guard -> order."""

import asyncio
import logging
import os
import signal
import time
from pathlib import Path
from typing import Any, Optional, Tuple

import yaml

from src.config.settings import (
    get_config_for_guards,
    get_hedge_config,
    get_state_space_config,
    get_structure_config,
    get_risk_config,
)
from src.connector.ib import IBConnector
from src.core.metrics import get_metrics
from src.core.state.classifier import StateClassifier
from src.core.state.composite import CompositeState
from src.core.state.snapshot import StateSnapshot, GreeksSnapshot
from src.core.state.enums import HedgeState, TradingState
from src.core.logging_utils import (
    log_composite_state,
    log_target_position,
    log_order_status,
)
from src.core.store import Store
from src.fsm.daemon_fsm import DaemonFSM, DaemonState
from src.execution.order_manager import OrderManager
from src.fsm.events import TargetPositionEvent, TradingEvent
from src.fsm.hedge_fsm import HedgeFSM
from src.fsm.trading_fsm import TradingFSM
from src.market.market_data import MarketData
from src.positions.portfolio import get_option_legs, get_stock_shares
from src.positions.position_book import PositionBook
from src.pricing.greeks import Greeks
from src.guards.execution_guard import ExecutionGuard
from src.sink import StatusSink
from src.sink.postgres_sink import PostgreSQLSink
from src.strategy.gamma_scalper import gamma_scalper_intent
from src.strategy.hedge_gate import apply_hedge_gates

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


class GsTrading:
    """Single-process event-driven gamma scalping strategy."""

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

        # 1.b Config sections (unified _*_cfg naming)
        self._structure_cfg = get_structure_config(config)
        self._risk_cfg = get_risk_config(config)
        self._greeks_cfg = config.get("greeks", {})

        # 1.c Symbol and Order Type
        self.symbol = config.get("symbol", "NVDA")
        self.paper_trade = self._risk_cfg.get("paper_trade", True)
        self.order_type = config.get("order", {}).get("order_type", "market")

        # 1.d Hedge Configuration
        self._hedge_cfg = get_hedge_config(config)
        self.guard = ExecutionGuard(
            cooldown_sec=self._hedge_cfg["cooldown_sec"],
            max_daily_hedge_count=self._hedge_cfg["max_daily_hedge_count"],
            max_position_shares=self._hedge_cfg["max_position_shares"],
            max_daily_loss_usd=self._hedge_cfg["max_daily_loss_usd"],
            max_net_delta_shares=self._hedge_cfg["max_net_delta_shares"],
            max_spread_pct=self._hedge_cfg["max_spread_pct"],
            min_price_move_pct=self._hedge_cfg["min_price_move_pct"],
            earnings_dates=self._hedge_cfg["earnings_dates"],
            blackout_days_before=self._hedge_cfg["blackout_days_before"],
            blackout_days_after=self._hedge_cfg["blackout_days_after"],
            trading_hours_only=self._hedge_cfg["trading_hours_only"],
        )

        # 1.e FSMs
        self._fsm_daemon = DaemonFSM()
        self._fsm_hedge = HedgeFSM(min_hedge_shares=self._hedge_cfg["min_hedge_shares"])
        self._fsm_trading = TradingFSM(
            config=get_config_for_guards(config),
            guard=self.guard,
            on_transition=None,
        )

        # 2. Object References
        self.store = Store()
        self._hedge_lock = asyncio.Lock()
        self._last_config_mtime: Optional[float] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._position_book = PositionBook(
            self.store,
            self.symbol,
            min_dte=self._structure_cfg.get("min_dte", 21),
            max_dte=self._structure_cfg.get("max_dte", 35),
            atm_band_pct=self._structure_cfg.get("atm_band_pct", 0.03),
        )
        self._market_data = MarketData(self.store)
        self._order_manager = OrderManager()
        # Status sink (Phase 1: PostgreSQL). None if not configured.
        status_cfg = config.get("status", {}) or {}
        self._status_sink: Optional[StatusSink] = None
        if status_cfg.get("sink") == "postgres" and (status_cfg.get("postgres") or os.environ.get("PGHOST")):
            try:
                self._status_sink = PostgreSQLSink(status_cfg)
            except Exception as e:
                logger.warning("Status sink (postgres) init failed: %s", e)
        self._order_manager.set_hedge_fsm(self._fsm_hedge)
        self._metrics = get_metrics()

        # 3. Static Defaults
        self._heartbeat_interval = 10.0
        self._config_reload_interval = 30.0

    def _reload_config(self, config: dict) -> None:
        """Apply hot-reloadable config (IB host/port require restart)."""
        self.config = config

        self._structure_cfg = get_structure_config(config)
        self._hedge_cfg = get_hedge_config(config)
        self._greeks_cfg = config.get("greeks", self._greeks_cfg)
        self._risk_cfg = get_risk_config(config)
        if "paper_trade" in self._risk_cfg:
            self.paper_trade = self._risk_cfg["paper_trade"]
        self.order_type = config.get("order", {}).get("order_type", self.order_type)
        self.guard.update_config(
            cooldown_sec=self._hedge_cfg["cooldown_sec"],
            max_daily_hedge_count=self._hedge_cfg["max_daily_hedge_count"],
            max_position_shares=self._hedge_cfg["max_position_shares"],
            max_daily_loss_usd=self._hedge_cfg["max_daily_loss_usd"],
            max_net_delta_shares=self._hedge_cfg["max_net_delta_shares"],
            max_spread_pct=self._hedge_cfg["max_spread_pct"],
            min_price_move_pct=self._hedge_cfg["min_price_move_pct"],
            earnings_dates=self._hedge_cfg["earnings_dates"],
            blackout_days_before=self._hedge_cfg["blackout_days_before"],
            blackout_days_after=self._hedge_cfg["blackout_days_after"],
            trading_hours_only=self._hedge_cfg["trading_hours_only"],
        )

    async def _reload_config_loop(self) -> None:
        """Periodically check config file mtime and reload if changed."""
        if not self._config_path or not Path(self._config_path).exists():
            return
        while self._fsm_daemon.is_running():
            await asyncio.sleep(self._config_reload_interval)
            if not self._fsm_daemon.is_running():
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
        """Fetch positions from IB and update store (raw positions + stock_shares only). No option parse."""
        positions = await self.connector.get_positions()
        stock_shares = get_stock_shares(positions, self.symbol)
        self.store.set_positions(positions, stock_shares)

    def _build_snapshot(
        self,
        cs: CompositeState,
        spot: Optional[float],
        greeks: Optional[Any],
        option_legs_count: int = 0,
    ) -> StateSnapshot:
        """Build StateSnapshot from CompositeState for TradingFSM."""
        gs = None
        if greeks is not None:
            gs = GreeksSnapshot(
                delta=getattr(greeks, "delta", 0.0),
                gamma=getattr(greeks, "gamma", 0.0),
                valid=getattr(greeks, "valid", False),
            )
        return StateSnapshot.from_composite_state(
            cs,
            spot=spot,
            greeks_snapshot=gs,
            option_legs_count=option_legs_count,
        )

    def _build_snapshot_dict(
        self,
        snapshot: StateSnapshot,
        spot: float,
        cs: CompositeState,
        data_lag_ms: Optional[float],
    ) -> dict:
        """Build dict for StatusSink (status_current / status_history). Keys per docs/DATABASE.md §2.1."""
        return {
            "daemon_state": self._fsm_daemon.current.value,
            "trading_state": self._fsm_trading.state.value,
            "symbol": self.symbol,
            "spot": float(spot),
            "bid": self.store.get_bid(),
            "ask": self.store.get_ask(),
            "net_delta": float(cs.net_delta),
            "stock_position": int(cs.stock_pos),
            "option_legs_count": int(getattr(snapshot, "option_legs_count", 0)),
            "daily_hedge_count": self.store.get_daily_hedge_count(),
            "daily_pnl": float(self.store.get_daily_pnl()),
            "data_lag_ms": float(data_lag_ms) if data_lag_ms is not None else None,
            "config_summary": f"paper_trade={self.paper_trade}",
            "ts": time.time(),
        }

    async def _refresh_and_build_snapshot(
        self,
    ) -> Optional[Tuple[StateSnapshot, float, CompositeState, Optional[float]]]:
        """
        Refresh positions and spot, parse legs, greeks, classify, build snapshot.
        Returns (snapshot, spot, cs, data_lag_ms) or None if no valid spot.
        Shared by _handle_connected (bootstrap) and _eval_hedge (tick).
        """
        # 1.a. Refresh positions and spot
        await self._refresh_positions()
        # 1.b. Get stock shares and spot price
        stock_shares = self.store.get_stock_position()
        spot = self.store.get_underlying_price()
        if spot is None or spot <= 0:
            spot = await self.connector.get_underlying_price(self.symbol)
            if spot is not None and spot > 0:
                self.store.set_underlying_price(spot)
        if spot is None or spot <= 0:
            return None
        # 1.c. Get option legs
        positions = self.store.get_positions()
        min_dte = self._structure_cfg.get("min_dte", 21)
        max_dte = self._structure_cfg.get("max_dte", 35)
        atm_band = self._structure_cfg.get("atm_band_pct", 0.03)
        legs = get_option_legs(
            positions,
            self.symbol,
            min_dte=min_dte,
            max_dte=max_dte,
            atm_band_pct=atm_band,
            spot=spot,
        )
        # 1.d. Get greeks
        r = self._greeks_cfg.get("risk_free_rate", 0.05)
        vol = self._greeks_cfg.get("volatility", 0.35)
        greeks = Greeks(legs, stock_shares, spot, r, vol)

        # 2.a. Build data lag
        data_lag_ms: Optional[float] = None
        if self._market_data.last_ts is not None:
            data_lag_ms = (time.time() - self._market_data.last_ts) * 1000.0
        
        # 2.b. Build Classify
        state_space_cfg = get_state_space_config(self.config)
        risk_halt = getattr(self.guard, "_circuit_breaker", False)
        cs = StateClassifier.classify(
            self._position_book,
            self._market_data,
            greeks,
            self._order_manager,
            last_hedge_price=self.store.get_last_hedge_price(),
            last_hedge_ts=self.store.get_last_hedge_time(),
            data_lag_ms=data_lag_ms,
            risk_halt=risk_halt,
            config=state_space_cfg,
        )
        # 2.c. Build snapshot
        snapshot = self._build_snapshot(cs, spot, greeks, option_legs_count=len(legs))
        
        # 3. Return snapshot, spot, cs, data_lag_ms
        return (snapshot, spot, cs, data_lag_ms)

    def _on_ticker(self, ticker: Any) -> None:
        """Called on each ticker update from IB (may be from IB thread)."""
        try:
            self._market_data.touch_ts()
            bid = getattr(ticker, "bid", None)
            ask = getattr(ticker, "ask", None)
            if bid is not None and ask is not None:
                self.store.set_underlying_quote(float(bid), float(ask))
            else:
                last = getattr(ticker, "last", None)
                if last is not None:
                    self.store.set_underlying_price(float(last))
            self._eval_hedge_threadsafe()
        except Exception as e:
            logger.debug("ticker callback error: %s", e)

    def _eval_hedge_threadsafe(self) -> None:
        """Threadsafe: schedule _on_tick to be run safely from any thread using call_soon_threadsafe."""
        if self._fsm_daemon.is_running() and self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._eval_hedge_sync(), loop=self._loop)
            )

    async def _eval_hedge_sync(self) -> None:
        """Run FSM-driven tick once (under lock)."""
        async with self._hedge_lock:
            await self._eval_hedge()

    async def _eval_hedge(self) -> None:
        """FSM-driven tick: refresh + snapshot -> TradingFSM (TICK) -> maybe _hedge."""
        result = await self._refresh_and_build_snapshot()
        if result is None:
            logger.debug("No spot price, skip hedge")
            return
        snapshot, spot, cs, data_lag_ms = result
        log_composite_state(cs=cs)
        self._metrics.set_data_lag_ms(data_lag_ms)
        self._metrics.set_delta_abs(abs(cs.net_delta))
        self._metrics.set_spread_bucket(cs.L.value if cs.L else None)

        self._fsm_trading.apply_transition(TradingEvent.TICK, snapshot)
        if self._fsm_trading.state != TradingState.NEED_HEDGE:
            return

        stock_shares = self.store.get_stock_position()
        intent = gamma_scalper_intent(
            cs.net_delta,
            stock_shares,
            threshold_hedge_shares=self._hedge_cfg["threshold_hedge_shares"],
            max_hedge_shares_per_order=self._hedge_cfg["max_hedge_shares_per_order"],
            config=self._hedge_cfg,
        )
        if intent is None:
            logger.debug("No hedge intent (delta within threshold)")
            return
        approved = apply_hedge_gates(
            intent,
            cs,
            self.guard,
            now_ts=time.time(),
            spot=spot,
            last_hedge_price=self.store.get_last_hedge_price(),
            spread_pct=self.store.get_spread_pct(),
            min_hedge_shares=self._hedge_cfg["min_hedge_shares"],
        )
        if approved is None:
            logger.info(
                "Hedge blocked by gates (delta=%.1f would %s %s)",
                cs.net_delta,
                intent.side,
                intent.quantity,
            )
            return
        if not self._fsm_hedge.can_place_order():
            logger.warning(
                "Execution not IDLE (E=%s), skip order",
                self._order_manager.effective_e_state().value,
            )
            return
        log_target_position(target_shares=intent.target_shares, cs=cs)

        # 3.c. Status sink: hedge_intent operation (and optional history row)
        if self._status_sink:
            self._status_sink.write_operation({
                "ts": time.time(),
                "type": "hedge_intent",
                "side": approved.side,
                "quantity": approved.quantity,
                "price": spot,
                "state_reason": cs.D.value if cs.D else None,
            })
            snap_dict = self._build_snapshot_dict(snapshot, spot, cs, data_lag_ms)
            self._status_sink.write_snapshot(snap_dict, append_history=True)

        # 3.d. FSM apply transition to target emitted and start hedge
        self._fsm_trading.apply_transition(TradingEvent.TARGET_EMITTED, snapshot)
        await self._hedge(approved, cs, spot, snapshot)

    async def _hedge(
        self,
        intent: Any,
        cs: CompositeState,
        spot: float,
        snapshot: StateSnapshot,
    ) -> None:
        """Run HedgeFSM flow and place order; fire HEDGE_DONE or HEDGE_FAILED on TradingFSM."""
        now_ts = time.time()
        target_ev = TargetPositionEvent(
            target_shares=intent.target_shares,
            reason="delta_hedge",
            ts=now_ts,
            trace_id=None,
            side=intent.side,
            quantity=intent.quantity,
        )
        self._fsm_hedge.on_target(target_ev, cs.stock_pos)
        self._fsm_hedge.on_plan_decide(
            send_order=intent.quantity >= self._hedge_cfg["min_hedge_shares"]
        )
        if self._fsm_hedge.state != HedgeState.SEND:
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_DONE, snapshot)
            return
        def _write_op(op_type: str, state_reason: Optional[str] = None) -> None:
            if self._status_sink:
                self._status_sink.write_operation({
                    "ts": time.time(),
                    "type": op_type,
                    "side": intent.side,
                    "quantity": intent.quantity,
                    "price": spot,
                    "state_reason": state_reason or (cs.D.value if cs.D else None),
                })

        if self.paper_trade:
            _write_op("order_sent")
            log_order_status(
                order_status="paper_send", side=intent.side, quantity=intent.quantity
            )
            logger.info(
                "PAPER: would %s %s shares (delta=%.1f)",
                intent.side,
                intent.quantity,
                cs.net_delta,
            )
            self._fsm_hedge.on_order_placed()
            self._fsm_hedge.on_ack_ok()
            self.guard.record_hedge_sent()
            self.store.set_last_hedge_time(now_ts)
            self.store.set_last_hedge_price(spot)
            self.store.inc_daily_hedge_count()
            self._metrics.inc_hedge_count()
            self._fsm_hedge.on_full_fill()
            _write_op("fill")
            if self._status_sink:
                snap_dict = self._build_snapshot_dict(snapshot, spot, cs, snapshot.data_lag_ms)
                self._status_sink.write_snapshot(snap_dict, append_history=True)
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_DONE, snapshot)
            return
        self._fsm_hedge.on_order_placed()
        _write_op("order_sent")
        log_order_status(
            order_status="sent", side=intent.side, quantity=intent.quantity
        )
        trade = await self.connector.place_order(
            self.symbol,
            intent.side,
            intent.quantity,
            order_type=self.order_type,
        )
        if trade is not None:
            self._fsm_hedge.on_ack_ok()
            self.guard.record_hedge_sent()
            self.store.set_last_hedge_time(now_ts)
            self.store.set_last_hedge_price(spot)
            self.store.inc_daily_hedge_count()
            self._metrics.inc_hedge_count()
            logger.info(
                "Hedge sent: %s %s %s", intent.side, intent.quantity, self.symbol
            )
            self._fsm_hedge.on_full_fill()
            _write_op("fill")
            if self._status_sink:
                snap_dict = self._build_snapshot_dict(snapshot, spot, cs, snapshot.data_lag_ms)
                self._status_sink.write_snapshot(snap_dict, append_history=True)
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_DONE, snapshot)
        else:
            _write_op("reject", "order_failed")
            if self._status_sink:
                snap_dict = self._build_snapshot_dict(snapshot, spot, cs, snapshot.data_lag_ms)
                self._status_sink.write_snapshot(snap_dict, append_history=True)
            logger.warning("Order failed (trade is None)")
            self._fsm_hedge.on_ack_reject()
            self._fsm_hedge.on_try_resync()
            self._fsm_hedge.on_positions_resynced()
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_FAILED, snapshot)

    async def _heartbeat(self) -> None:
        """Periodic heartbeat to run maybe_hedge even without tick updates; write status snapshot if sink configured."""
        while self._fsm_daemon.is_running():
            print(f"[HEARTBEAT] Sleeping for {self._heartbeat_interval} seconds...")
            await asyncio.sleep(self._heartbeat_interval)
            if not self._fsm_daemon.is_running():
                return
            if self._status_sink:
                result = await self._refresh_and_build_snapshot()
                if result is not None:
                    snapshot, spot, cs, data_lag_ms = result
                    snap_dict = self._build_snapshot_dict(snapshot, spot, cs, data_lag_ms)
                    self._status_sink.write_snapshot(snap_dict, append_history=False)
            print("[HEARTBEAT] Woke up, running maybe_hedge()...")
            await self._eval_hedge_sync()

    # --- State handlers: each runs its logic and returns the next state ---

    async def _handle_idle(self) -> DaemonState:
        """IDLE: ready to start. Transition to CONNECTING."""
        logger.debug("Daemon:IDLE: ready to start. Transition to CONNECTING.")
        return DaemonState.CONNECTING

    async def _handle_connecting(self) -> DaemonState:
        """CONNECTING: connect to IB. Returns CONNECTED or STOPPED."""
        logger.debug("Daemon:CONNECTING: connecting to IB...")
        ok = await self.connector.connect()
        if not ok:
            logger.error("Could not connect to IB; exiting")
            return DaemonState.STOPPED
        return DaemonState.CONNECTED

    async def _handle_connected(self) -> DaemonState:
        """CONNECTED: fetch positions + spot, bootstrap TradingFSM (START/SYNCED). Transition to RUNNING."""
        logger.debug("Daemon:CONNECTED: fetching positions...")
        result = await self._refresh_and_build_snapshot()
        if result is not None:
            snapshot, _spot, _cs, _data_lag_ms = result
            self._fsm_trading.apply_transition(TradingEvent.START, snapshot)
            self._fsm_trading.apply_transition(TradingEvent.SYNCED, snapshot)
        return DaemonState.RUNNING

    async def _handle_running(self) -> DaemonState:
        """RUNNING: subscribe, start background tasks, loop until stop requested."""
        logger.debug("Daemon:RUNNING: subscribing to ticker and positions...")
        self.connector.subscribe_ticker(self.symbol, self._on_ticker)
        self.connector.subscribe_positions(self._eval_hedge_threadsafe)
        self._heartbeat_task = asyncio.create_task(self._heartbeat())
        self._config_reload_task = asyncio.create_task(self._reload_config_loop())
        logger.info(
            "Daemon running (symbol=%s, paper_trade=%s, config=%s)",
            self.symbol,
            self.paper_trade,
            self._config_path or "default",
        )
        try:
            while self._fsm_daemon.is_running():
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass
        return DaemonState.STOPPING

    async def _handle_stopping(self) -> DaemonState:
        """STOPPING: cancel tasks, disconnect. Transition to STOPPED."""
        logger.debug("Daemon:STOPPING: cancel tasks, disconnect...")
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
        if getattr(self._status_sink, "close", None):
            try:
                self._status_sink.close()
            except Exception as e:
                logger.debug("Status sink close: %s", e)
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
            while self._fsm_daemon.current != DaemonState.STOPPED:
                current = self._fsm_daemon.current
                handler = handlers.get(current)
                if handler is None:
                    logger.warning("Daemon: No handler for state %s; stopping", current.value)
                    break
                try:
                    next_state = await handler()
                    if not self._fsm_daemon.transition(next_state):
                        logger.error(
                            "Daemon: invalid transition from %s to %s; stopping",
                            current.value,
                            next_state.value,
                        )
                        if self._fsm_daemon.can_transition_to(DaemonState.STOPPING):
                            self._fsm_daemon.transition(DaemonState.STOPPING)
                        break
                except Exception as e:
                    logger.exception("Handler %s raised: %s", current.value, e)
                    if self._fsm_daemon.can_transition_to(DaemonState.STOPPING):
                        self._fsm_daemon.transition(DaemonState.STOPPING)
                    else:
                        self._fsm_daemon.transition(DaemonState.STOPPED)
        finally:
            if self._fsm_daemon.current != DaemonState.STOPPED:
                if self._fsm_daemon.current != DaemonState.STOPPING:
                    self._fsm_daemon.transition(DaemonState.STOPPING)
                try:
                    await self._handle_stopping()
                except Exception as e:
                    logger.exception("Cleanup (_handle_stopping) failed: %s", e)
                self._fsm_daemon.transition(DaemonState.STOPPED)

    def stop(self) -> None:
        self._fsm_daemon.request_stop()


async def _run_daemon_main(config_path: Optional[str] = None) -> None:
    """Load config, register signals, run GsTrading. SIGTERM/SIGINT call app.stop() on main loop."""
    config, resolved_path = read_config(config_path)
    app = GsTrading(config, config_path=resolved_path)
    loop = asyncio.get_running_loop()

    def _on_stop_signal(*_args: Any) -> None:
        logger.info("Received stop signal, requesting daemon stop")
        loop.call_soon_threadsafe(app.stop)

    try:
        loop.add_signal_handler(signal.SIGTERM, _on_stop_signal)
    except (NotImplementedError, OSError):
        pass  # add_signal_handler not supported on Windows
    try:
        loop.add_signal_handler(signal.SIGINT, _on_stop_signal)
    except (NotImplementedError, OSError):
        pass
    await app.run()


def run_daemon(config_path: Optional[str] = None) -> None:
    """Entry: run the gamma scalping daemon (SIGTERM/SIGINT stop)."""
    asyncio.run(_run_daemon_main(config_path))
