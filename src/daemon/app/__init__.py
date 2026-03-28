"""Application entry: gamma scalping strategy and run_daemon."""

from src.daemon.app.gs_trading import GsTrading
from src.daemon.app.entry import run_daemon

__all__ = ["GsTrading", "run_daemon"]
