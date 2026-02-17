"""Application entry: gamma scalping daemon and run_daemon."""

from src.app.daemon import TradingDaemon, run_daemon

__all__ = ["TradingDaemon", "run_daemon"]
