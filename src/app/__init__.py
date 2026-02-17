"""Application entry: gamma scalping strategy and run_daemon."""

from src.app.gs_trading import GsTrading, run_daemon

__all__ = ["GsTrading", "run_daemon"]
