#!/usr/bin/env python3
"""Entry point: run the gamma scalping daemon.

Config resolution (see ``src.app.config.resolve_startup_config_path``):

- Default: ``config/config.dev.yaml``
- Prod: ``--prod``, ``--env prod``, or ``BIFROST_ENV=prod`` → ``config/config.prod.yaml``
- Explicit: first positional path, or ``BIFROST_CONFIG`` env
"""

import logging
import os
import sys

try:
    import redis
except ImportError:  # pragma: no cover - optional at import time; handler falls back to no-op
    redis = None

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
_DAEMON_LOG_STREAM_KEY = "bifrost:daemon_console"
_DAEMON_LOG_STREAM_MAXLEN = 50

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
        original_levelname = record.levelname
        try:
            record.levelname = f"{color}[{record.levelname}]{_RESET}"
            return super().format(record)
        finally:
            record.levelname = original_levelname


class RedisStreamLogHandler(logging.Handler):
    """Push plain daemon log lines to Redis Stream for the web console.

    Keep only the newest small window so hidden tabs can fetch recent logs
    later without needing frontend-triggered trim requests.
    """

    def __init__(self, redis_url: str, stream_key: str, maxlen: int = 50) -> None:
        super().__init__()
        self._redis_url = redis_url
        self._stream_key = stream_key
        self._maxlen = maxlen

    def emit(self, record: logging.LogRecord) -> None:
        if redis is None:
            return
        try:
            line = self.format(record)
            r = redis.from_url(self._redis_url)
            r.xadd(
                self._stream_key,
                {"line": line},
                maxlen=self._maxlen,
                approximate=True,
            )
        except (redis.RedisError, OSError, ValueError, TypeError):
            pass


def _daemon_log_redis_url() -> str:
    """Build Redis URL for daemon console stream from config/env. Falls back to local Redis."""
    try:
        from src.app.config import read_config
        from src.core.redis_url import effective_redis_dict, format_redis_url

        config, _ = read_config()
    except (ImportError, OSError, ValueError, TypeError):
        config = {}
    return format_redis_url(effective_redis_dict(config, default_db=0))


def setup_logging(debug: bool = False) -> None:
    """Configure colorful logging with distinct styles per level."""
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(
        ColoredFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    redis_handler = RedisStreamLogHandler(
        _daemon_log_redis_url(),
        _DAEMON_LOG_STREAM_KEY,
        maxlen=_DAEMON_LOG_STREAM_MAXLEN,
    )
    redis_handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    logging.root.handlers.clear()
    logging.root.addHandler(console_handler)
    logging.root.addHandler(redis_handler)
    level = logging.DEBUG if debug else logging.INFO
    logging.root.setLevel(level)
    if debug:
        logging.getLogger("ib_insync").setLevel(logging.DEBUG)


if __name__ == "__main__":
    from src.app.config import resolve_startup_config_path

    argv_raw = sys.argv[1:]
    config_path, _ = resolve_startup_config_path(_PROJECT_ROOT, argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path
    if "--debug" in sys.argv:
        setup_logging(debug=True)
    else:
        setup_logging(debug=False)

    from src.daemon.app.entry import run_daemon

    run_daemon(config_path)
