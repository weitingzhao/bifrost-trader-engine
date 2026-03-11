"""Daemon entry: load config, register signals, run GsTrading. SIGTERM/SIGINT stop."""

import asyncio
import logging
import signal
from typing import Any, Optional

from src.app.config import read_config
from src.app.gs_trading import GsTrading

logger = logging.getLogger(__name__)


async def _run_daemon_main(config_path: Optional[str] = None) -> None:
    """Load config, register signals, run GsTrading. SIGTERM/SIGINT call app.stop() on main loop."""
    config, resolved_path = read_config(config_path)
    app = GsTrading(config, config_path=resolved_path)
    loop = asyncio.get_running_loop()

    def _on_stop_signal(*_args: Any) -> None:
        logger.info(
            "[Daemon] received SIGTERM/SIGINT → requesting stop (RUNNING → STOPPING)"
        )
        loop.call_soon_threadsafe(app.stop)

    try:
        loop.add_signal_handler(signal.SIGTERM, _on_stop_signal)
    except (NotImplementedError, OSError):
        pass  # add_signal_handler not supported on Windows
    try:
        loop.add_signal_handler(signal.SIGINT, _on_stop_signal)
    except (NotImplementedError, OSError):
        pass
    try:
        await app.run()
    finally:
        # So monitoring can show "Stopped at ..." (SIGTERM/SIGINT or consumed stop); no-op on SIGKILL
        if getattr(app, "_status_sink", None) and hasattr(
            app._status_sink, "write_daemon_graceful_shutdown"
        ):
            app._status_sink.write_daemon_graceful_shutdown()


def run_daemon(config_path: Optional[str] = None) -> None:
    """Entry: run the gamma scalping daemon (SIGTERM/SIGINT stop)."""
    asyncio.run(_run_daemon_main(config_path))
