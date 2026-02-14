#!/usr/bin/env python3
"""Entry point: run the gamma scalping daemon."""

import asyncio
import logging
import os
import sys

# Add project root so "src" and "config" are resolvable
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# ANSI color codes
_RESET = "\033[0m"
_BOLD = "\033[1m"
_GRAY = "\033[90m"
_GREEN = "\033[32m"
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


def setup_logging() -> None:
    """Configure colorful logging with distinct styles per level."""
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        ColoredFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logging.root.handlers.clear()
    logging.root.addHandler(handler)
    logging.root.setLevel(logging.INFO)


setup_logging()

from src.engine.daemon import run_daemon

if __name__ == "__main__":
    config_path = sys.argv[1] if len(sys.argv) > 1 else None
    asyncio.run(run_daemon(config_path))
