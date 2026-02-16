"""Event-driven daemon: connector -> state -> greeks -> scalper -> guard -> order."""

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import yaml

from src.connector.ib import IBConnector
from src.engine.state import TradingState
from src.positions.portfolio import parse_positions, portfolio_delta
from src.pricing.black_scholes import delta as bs_delta
from src.risk.guard import RiskGuard
from src.strategy.gamma_scalper import gamma_scalper_hedge

logger = logging.getLogger(__name__)


def load_config(config_path: Optional[str] = None) -> tuple[dict, str]:
    """Load YAML config with env overrides for IB. Returns (config, resolved_path)."""
    path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(path).exists():
        path = "config/config.yaml.example"
    path = str(Path(path).resolve())
    with open(path, "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f) or {}
    # Env overrides (only when config does not explicitly set the value)
    ib_cfg = cfg.setdefault("ib", {})
    if os.environ.get("IB_HOST") and not ib_cfg.get("host"):
        ib_cfg["host"] = os.environ["IB_HOST"]
    if os.environ.get("IB_PORT") and ib_cfg.get("port") is None:
        ib_cfg["port"] = int(os.environ["IB_PORT"])
    if os.environ.get("IB_CLIENT_ID") and ib_cfg.get("client_id") is None:
        ib_cfg["client_id"] = int(os.environ["IB_CLIENT_ID"])
    return cfg, path


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
        self._hedge_lock = asyncio.Lock()
        self._last_config_mtime: Optional[float] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None

        # 3. Static Defaults
        self._running = False
        self._heartbeat_interval = 10.0
        self._config_reload_interval = 30.0

    def _apply_reloaded_config(self, config: dict) -> None:
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
            min_price_move_pct=self.hedge_cfg.get("hedge", {}).get(
                "min_price_move_pct"
            ),
            earnings_dates=self.earnings_cfg.get("dates"),
            blackout_days_before=self.earnings_cfg.get("blackout_days_before"),
            blackout_days_after=self.earnings_cfg.get("blackout_days_after"),
            trading_hours_only=self.risk_cfg.get("trading_hours_only"),
        )

    async def _config_reload_loop(self) -> None:
        """Periodically check config file mtime and reload if changed."""
        if not self._config_path or not Path(self._config_path).exists():
            return
        while self._running:
            await asyncio.sleep(self._config_reload_interval)
            if not self._running:
                return
            try:
                mtime = Path(self._config_path).stat().st_mtime
                if (
                    self._last_config_mtime is not None
                    and mtime > self._last_config_mtime
                ):
                    cfg, _ = load_config(self._config_path)
                    self._apply_reloaded_config(cfg)
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
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._maybe_hedge(), loop=self._loop)
            )

    def _maybe_hedge_in_loop(self) -> None:
        """Schedule maybe_hedge on the event loop (must be called from within the event loop)."""
        if self._loop and self._loop.is_running():
            asyncio.ensure_future(self._maybe_hedge(), loop=self._loop)

    async def _compute_hedge_decision(self) -> Optional[tuple]:
        """Compute hedge from current state. Returns (hedge, port_delta, stock_shares, spot) or None."""
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
        port_delta = portfolio_delta(legs, stock_shares, spot, r, vol)
        threshold = self.hedge_cfg.get("delta_threshold_shares", 25)
        max_qty = self.hedge_cfg.get("max_hedge_shares_per_order", 500)
        hedge = gamma_scalper_hedge(
            port_delta,
            stock_shares,
            delta_threshold_shares=threshold,
            max_hedge_shares_per_order=max_qty,
        )
        if hedge is None:
            logger.debug("Portfolio delta %.1f within band, no hedge", port_delta)
            return None
        return (hedge, port_delta, stock_shares, spot)

    async def _maybe_hedge(self) -> None:
        """Run hedge logic once: delta -> scalper -> guard -> order."""
        async with self._hedge_lock:
            pass
        result = await self._compute_hedge_decision()
        if result is None:
            return
        hedge, port_delta, stock_shares, spot = result
        now_ts = time.time()
        allowed, reason = self.guard.allow_hedge(
            now_ts,
            stock_shares,
            hedge.side,
            hedge.quantity,
            portfolio_delta=port_delta,
            spot=spot,
            last_hedge_price=self.state.get_last_hedge_price(),
            spread_pct=self.state.get_spread_pct(),
        )
        if not allowed:
            logger.info(
                "Hedge blocked: %s (delta=%.1f would %s %s)",
                reason,
                port_delta,
                hedge.side,
                hedge.quantity,
            )
            return
        if self.paper_trade:
            logger.info(
                "PAPER: would %s %s shares (delta=%.1f)",
                hedge.side,
                hedge.quantity,
                port_delta,
            )
            self.guard.record_hedge_sent()
            self.state.set_last_hedge_time(now_ts)
            self.state.set_last_hedge_price(spot)
            self.state.inc_daily_hedge_count()
            return
        trade = await self.connector.place_order(
            self.symbol,
            hedge.side,
            hedge.quantity,
            order_type=self.order_type,
        )
        if trade is not None:
            self.guard.record_hedge_sent()
            self.state.set_last_hedge_time(now_ts)
            self.state.set_last_hedge_price(spot)
            self.state.inc_daily_hedge_count()
            logger.info("Hedge sent: %s %s %s", hedge.side, hedge.quantity, self.symbol)
        else:
            logger.warning("Order failed (trade is None)")

    async def _heartbeat(self) -> None:
        """Periodic heartbeat to run maybe_hedge even without tick updates."""
        while self._running:
            print(f"[HEARTBEAT] Sleeping for {self._heartbeat_interval} seconds...")
            await asyncio.sleep(self._heartbeat_interval)
            if self._running:
                print("[HEARTBEAT] Woke up, running maybe_hedge()...")
                await self._maybe_hedge()

    async def run(self) -> None:
        """Connect, subscribe, and run until stopped."""
        self._running = True
        self._loop = asyncio.get_running_loop()
        logger.debug("Step 1: Connecting to IB...")
        ok = await self.connector.connect()
        if not ok:
            logger.error("Could not connect to IB; exiting")
            return
        logger.debug("Step 2: Fetching positions...")
        await self._refresh_positions()
        logger.debug("Step 3: Getting underlying price for %s...", self.symbol)
        spot = await self.connector.get_underlying_price(self.symbol)
        self.state.set_underlying_price(spot)
        logger.debug("Step 4: Subscribing to ticker and positions...")
        self.connector.subscribe_ticker(self.symbol, self._on_ticker)
        self.connector.subscribe_positions(self._maybe_hedge_threadsafe)
        heartbeat_task = asyncio.create_task(self._heartbeat())
        config_reload_task = asyncio.create_task(self._config_reload_loop())
        logger.info(
            "Daemon running (symbol=%s, paper_trade=%s, config=%s)",
            self.symbol,
            self.paper_trade,
            self._config_path or "default",
        )
        try:
            while self._running:
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass
        finally:
            self._running = False
            heartbeat_task.cancel()
            config_reload_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            try:
                await config_reload_task
            except asyncio.CancelledError:
                pass
            await self.connector.disconnect()

    def stop(self) -> None:
        self._running = False


async def run_daemon(config_path: Optional[str] = None) -> None:
    """Load config and run the daemon."""
    config, resolved_path = load_config(config_path)
    daemon = TradingDaemon(config, config_path=resolved_path)
    await daemon.run()
