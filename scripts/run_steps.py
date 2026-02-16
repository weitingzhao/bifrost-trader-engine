#!/usr/bin/env python3
"""
Step runner: run discrete daemon steps for debugging and isolation.

Usage:
  python scripts/run_steps.py --step 1          # Connect only
  python scripts/run_steps.py --step 1,2,3     # Connect, positions, spot
  python scripts/run_steps.py --step 5          # Full daemon
  python scripts/run_steps.py --step 1 --debug   # Verbose
"""

import argparse
import asyncio
import logging
import os
import sys

# Project root: always resolve relative to script location, not cwd
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

# ANSI color codes (match run_engine.py)
_RESET = "\033[0m"
_BOLD = "\033[1m"
_GRAY = "\033[90m"
_YELLOW = "\033[33m"
_RED = "\033[31m"
_CYAN = "\033[36m"

_LEVEL_COLORS = {
    logging.DEBUG: _GRAY,
    logging.INFO: _CYAN,
    logging.WARNING: _YELLOW,
    logging.ERROR: _RED + _BOLD,
    logging.CRITICAL: _RED + _BOLD,
}


class ColoredFormatter(logging.Formatter):
    """Formatter that adds colors per log level."""

    def format(self, record: logging.LogRecord) -> str:
        color = _LEVEL_COLORS.get(record.levelno, _RESET)
        record.levelname = f"{color}[{record.levelname}]{_RESET}"
        return super().format(record)


def setup_logging(debug: bool = False) -> None:
    """Configure colorful logging."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        ColoredFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logging.root.handlers.clear()
    logging.root.addHandler(handler)
    level = logging.DEBUG if debug else logging.INFO
    logging.root.setLevel(level)
    if debug:
        logging.getLogger("ib_insync").setLevel(logging.DEBUG)


class StepRunner:
    """Run daemon steps in isolation for debugging."""

    def __init__(self, config: dict, config_path: str | None):
        from src.connector.ib import IBConnector
        from src.engine.state import TradingState
        from src.positions.portfolio import parse_positions
        from src.risk.guard import RiskGuard

        self.config = config
        self._config_path = config_path
        ib_cfg = config.get("ib", {})
        self.connector = IBConnector(
            host=ib_cfg.get("host", "127.0.0.1"),
            port=ib_cfg.get("port", 4001),
            client_id=ib_cfg.get("client_id", 1),
            connect_timeout=ib_cfg.get("connect_timeout", 60.0),
        )
        self.state = TradingState()
        risk_cfg = config.get("risk", {})
        earn_cfg = config.get("earnings", {})
        self.guard = RiskGuard(
            cooldown_sec=config.get("hedge", {}).get("cooldown_sec", 60),
            max_daily_hedge_count=risk_cfg.get("max_daily_hedge_count", 50),
            max_position_shares=risk_cfg.get("max_position_shares", 2000),
            max_daily_loss_usd=risk_cfg.get("max_daily_loss_usd", 5000.0),
            max_net_delta_shares=risk_cfg.get("max_net_delta_shares"),
            max_spread_pct=risk_cfg.get("max_spread_pct"),
            min_price_move_pct=config.get("hedge", {}).get("min_price_move_pct", 0.0),
            earnings_dates=earn_cfg.get("dates", []),
            blackout_days_before=earn_cfg.get("blackout_days_before", 3),
            blackout_days_after=earn_cfg.get("blackout_days_after", 1),
            trading_hours_only=risk_cfg.get("trading_hours_only", True),
        )
        self.symbol = config.get("symbol", "NVDA")
        self.structure = config.get("structure", {})
        self._parse_positions = parse_positions

    async def run_step_1(self) -> bool:
        """Step 1: Connect to IB only."""
        logging.getLogger(__name__).info("Step 1: Connecting to IB...")
        ok = await self.connector.connect()
        if ok:
            logging.getLogger(__name__).info("Step 1 OK: connected")
        return ok

    async def run_step_2(self) -> bool:
        """Step 2: Connect + get positions."""
        ok = await self.run_step_1()
        if not ok:
            return False
        logging.getLogger(__name__).info("Step 2: Fetching positions...")
        positions = await self.connector.get_positions()
        min_dte = self.structure.get("min_dte", 21)
        max_dte = self.structure.get("max_dte", 35)
        atm_band = self.structure.get("atm_band_pct", 0.03)
        spot = self.state.get_underlying_price()
        legs, stock_shares = self._parse_positions(
            positions, self.symbol,
            min_dte=min_dte, max_dte=max_dte,
            atm_band_pct=atm_band, spot=spot,
        )
        self.state.set_positions(positions, stock_shares)
        logging.getLogger(__name__).info("Step 2 OK: %d positions, %d legs, %d stock", len(positions), len(legs), stock_shares)
        return True

    async def run_step_3(self) -> bool:
        """Step 3: Connect + positions + get underlying price."""
        ok = await self.run_step_2()
        if not ok:
            return False
        logging.getLogger(__name__).info("Step 3: Getting underlying price for %s...", self.symbol)
        spot = await self.connector.get_underlying_price(self.symbol)
        self.state.set_underlying_price(spot)
        if spot is not None and spot > 0:
            logging.getLogger(__name__).info("Step 3 OK: %s spot=%.2f", self.symbol, spot)
            return True
        logging.getLogger(__name__).warning("Step 3: spot=%s (may be None outside market hours)", spot)
        return True  # Still consider OK for debugging

    async def run_step_4(self) -> bool:
        """Step 4: Connect + positions + spot + subscribe ticker and positions."""
        ok = await self.run_step_3()
        if not ok:
            return False
        logging.getLogger(__name__).info("Step 4: Subscribing to ticker and positions...")

        ticks_received: list = []

        def on_ticker(ticker):
            ticks_received.append(ticker)

        def on_position():
            pass

        ticker = self.connector.subscribe_ticker(self.symbol, on_ticker)
        self.connector.subscribe_positions(on_position)
        if ticker is None:
            logging.getLogger(__name__).error("Step 4: subscribe_ticker returned None")
            return False
        # Wait 2s for at least one tick
        await asyncio.sleep(2.0)
        logging.getLogger(__name__).info("Step 4 OK: subscribed, received %d ticks", len(ticks_received))
        return True

    async def run_step_5(self) -> None:
        """Step 5: Full daemon (all steps + heartbeat loop)."""
        from src.engine.daemon import TradingDaemon, load_config

        config, resolved_path = load_config(self._config_path)
        daemon = TradingDaemon(config, config_path=resolved_path)
        await daemon.run()

    async def run_steps(self, steps: list[int]) -> bool:
        """Run the specified steps. Steps are cumulative: max step runs (e.g. 1,2,3 -> step 3)."""
        if not steps:
            return False
        max_step = max(s for s in steps if 1 <= s <= 5)
        try:
            if max_step == 5:
                await self.run_step_5()
                return True  # Daemon runs until stopped
            if max_step == 1:
                ok = await self.run_step_1()
            elif max_step == 2:
                ok = await self.run_step_2()
            elif max_step == 3:
                ok = await self.run_step_3()
            elif max_step == 4:
                ok = await self.run_step_4()
            else:
                logging.getLogger(__name__).error("Unknown step: %s", max_step)
                return False
            return ok
        finally:
            if max_step != 5:
                await self.connector.disconnect()


def parse_steps(s: str) -> list[int]:
    """Parse --step 1,2,3 into [1, 2, 3]."""
    return [int(x.strip()) for x in s.split(",") if x.strip()]


async def main() -> int:
    parser = argparse.ArgumentParser(description="Run daemon steps in isolation")
    parser.add_argument("--step", default="1,2,3", help="Steps to run: 1,2,3,4,5 (e.g. 1 or 1,2,3 or 5)")
    parser.add_argument("--config", default=None, help="Config path (default: config/config.yaml)")
    parser.add_argument("--debug", action="store_true", help="Verbose logging")
    args = parser.parse_args()

    setup_logging(debug=args.debug)

    from src.engine.daemon import load_config

    config_path = args.config or os.path.join(_PROJECT_ROOT, "config", "config.yaml")
    if config_path and not os.path.isabs(config_path):
        config_path = os.path.join(_PROJECT_ROOT, config_path)
    if not os.path.exists(config_path):
        config_path = os.path.join(_PROJECT_ROOT, "config", "config.yaml.example")

    config, resolved_path = load_config(config_path)
    runner = StepRunner(config, resolved_path)

    try:
        steps = parse_steps(args.step)
        ok = await runner.run_steps(steps)
        return 0 if ok else 1
    except KeyboardInterrupt:
        return 0
    except Exception as e:
        logging.getLogger(__name__).exception("Error: %s", e)
        return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
