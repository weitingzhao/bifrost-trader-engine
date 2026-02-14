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


def load_config(config_path: Optional[str] = None) -> dict:
    """Load YAML config with env overrides for IB."""
    path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(path).exists():
        path = "config/config.yaml.example"
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
    return cfg


class TradingDaemon:
    """Single-process event-driven gamma scalping daemon."""

    def __init__(self, config: dict):
        self.config = config
        ib_cfg = config.get("ib", {})
        self.connector = IBConnector(
            host=ib_cfg.get("host", "127.0.0.1"),
            port=ib_cfg.get("port", 4001),
            client_id=ib_cfg.get("client_id", 1),
        )
        self.state = TradingState()
        risk_cfg = config.get("risk", {})
        earn_cfg = config.get("earnings", {})
        self.guard = RiskGuard(
            cooldown_sec=config.get("hedge", {}).get("cooldown_sec", 60),
            max_daily_hedge_count=risk_cfg.get("max_daily_hedge_count", 50),
            max_position_shares=risk_cfg.get("max_position_shares", 2000),
            max_daily_loss_usd=risk_cfg.get("max_daily_loss_usd", 5000.0),
            earnings_dates=earn_cfg.get("dates", []),
            blackout_days_before=earn_cfg.get("blackout_days_before", 3),
            blackout_days_after=earn_cfg.get("blackout_days_after", 1),
            trading_hours_only=risk_cfg.get("trading_hours_only", True),
        )
        self.symbol = config.get("symbol", "NVDA")
        self.structure = config.get("structure", {})
        self.hedge_cfg = config.get("hedge", {})
        self.greeks_cfg = config.get("greeks", {})
        self.paper_trade = risk_cfg.get("paper_trade", True)
        self.order_type = config.get("order", {}).get("order_type", "market")
        self._hedge_lock = asyncio.Lock()
        self._running = False
        self._heartbeat_interval = 10.0
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    def _on_ticker(self, ticker: Any) -> None:
        """Called on each ticker update from IB (may be from IB thread)."""
        try:
            mid = (ticker.bid + ticker.ask) / 2.0 if (ticker.bid and ticker.ask) else getattr(ticker, "last", None)
            if mid is not None:
                self.state.set_underlying_price(float(mid))
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._maybe_hedge(), loop=self._loop))
        except Exception as e:
            logger.debug("ticker callback error: %s", e)

    def _on_position_update(self) -> None:
        """Called when positions change (may be from IB thread)."""
        if self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(lambda: asyncio.ensure_future(self._maybe_hedge(), loop=self._loop))

    def _schedule_maybe_hedge(self) -> None:
        """Schedule maybe_hedge on the event loop (call from same loop)."""
        if self._loop and self._loop.is_running():
            asyncio.ensure_future(self._maybe_hedge(), loop=self._loop)

    async def _refresh_positions(self) -> None:
        """Fetch positions from IB and update state."""
        positions = await self.connector.get_positions()
        min_dte = self.structure.get("min_dte", 21)
        max_dte = self.structure.get("max_dte", 35)
        atm_band = self.structure.get("atm_band_pct", 0.03)
        spot = self.state.get_underlying_price()
        legs, stock_shares = parse_positions(
            positions,
            self.symbol,
            min_dte=min_dte,
            max_dte=max_dte,
            atm_band_pct=atm_band,
            spot=spot,
        )
        self.state.set_positions(positions, stock_shares)

    async def _maybe_hedge(self) -> None:
        """Run hedge logic once: delta -> scalper -> guard -> order."""
        async with self._hedge_lock:
            pass
        # Re-fetch positions for current state
        await self._refresh_positions()
        spot = self.state.get_underlying_price()
        if spot is None or spot <= 0:
            logger.debug("No spot price, skip hedge")
            return
        positions = self.state.get_positions()
        stock_position = self.state.get_stock_position()
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
        hedge = gamma_scalper_hedge(port_delta, delta_threshold_shares=threshold, max_hedge_shares_per_order=max_qty)
        if hedge is None:
            logger.debug("Portfolio delta %.1f within band, no hedge", port_delta)
            return
        now_ts = time.time()
        allowed, reason = self.guard.allow_hedge(now_ts, stock_shares, hedge.side, hedge.quantity)
        if not allowed:
            logger.info("Hedge blocked: %s (delta=%.1f would %s %s)", reason, port_delta, hedge.side, hedge.quantity)
            return
        if self.paper_trade:
            logger.info("PAPER: would %s %s shares (delta=%.1f)", hedge.side, hedge.quantity, port_delta)
            self.guard.record_hedge_sent()
            self.state.set_last_hedge_time(now_ts)
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
            self.state.inc_daily_hedge_count()
            logger.info("Hedge sent: %s %s %s", hedge.side, hedge.quantity, self.symbol)
        else:
            logger.warning("Order failed (trade is None)")

    async def _heartbeat(self) -> None:
        """Periodic heartbeat to run maybe_hedge even without tick updates."""
        while self._running:
            await asyncio.sleep(self._heartbeat_interval)
            if self._running:
                await self._maybe_hedge()

    async def run(self) -> None:
        """Connect, subscribe, and run until stopped."""
        self._running = True
        self._loop = asyncio.get_running_loop()
        ok = await self.connector.connect()
        if not ok:
            logger.error("Could not connect to IB; exiting")
            return
        await self._refresh_positions()
        spot = await self.connector.get_underlying_price(self.symbol)
        self.state.set_underlying_price(spot)
        self.connector.subscribe_ticker(self.symbol, self._on_ticker)
        self.connector.subscribe_positions(self._on_position_update)
        heartbeat_task = asyncio.create_task(self._heartbeat())
        logger.info("Daemon running (symbol=%s, paper_trade=%s)", self.symbol, self.paper_trade)
        try:
            while self._running:
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            pass
        finally:
            self._running = False
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            await self.connector.disconnect()

    def stop(self) -> None:
        self._running = False


async def run_daemon(config_path: Optional[str] = None) -> None:
    """Load config and run the daemon."""
    config = load_config(config_path)
    daemon = TradingDaemon(config)
    await daemon.run()
