#!/usr/bin/env python3
"""Entry point: run the gamma scalping daemon."""

import logging
import os
import sys

# Project root: always resolve relative to script location, not cwd
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)  # Ensure config paths resolve from project root

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


def setup_logging(debug: bool = False) -> None:
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
    level = logging.DEBUG if debug else logging.INFO
    logging.root.setLevel(level)
    if debug:
        logging.getLogger("ib_insync").setLevel(logging.DEBUG)


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if "--debug" in sys.argv:
        setup_logging(debug=True)
    else:
        setup_logging(debug=False)

    from src.app.gs_trading import run_daemon

    config_path = args[0] if args else None
    if config_path and not os.path.isabs(config_path):
        config_path = os.path.join(_PROJECT_ROOT, config_path)
    elif config_path is None:
        config_path = os.path.join(_PROJECT_ROOT, "config", "config.yaml")
    run_daemon(config_path)
