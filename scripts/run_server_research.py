#!/usr/bin/env python3
"""Standalone Research API server — option discovery and max pain reports.

Console logs are mirrored to Redis (bifrost:console:{dev|prod}:api_research) for Settings → API → Research,
same pattern as Trading. Default config: config/config.dev.yaml. Use --prod or BIFROST_ENV=prod for prod."""

import logging
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

from src.core.logging_redis_stream import RedisStreamLogHandler

_RESEARCH_LOG_STREAM_MAXLEN = 50

logging.basicConfig(force=True)

_RESET = "\033[0m"
_BOLD = "\033[1m"
_GRAY = "\033[90m"
_CYAN = "\033[36m"
_YELLOW = "\033[33m"
_RED = "\033[31m"

_LEVEL_COLORS = {
    logging.DEBUG: _GRAY,
    logging.INFO: _CYAN,
    logging.WARNING: _YELLOW,
    logging.ERROR: _RED + _BOLD,
    logging.CRITICAL: _RED + _BOLD,
}


class ColoredFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        color = _LEVEL_COLORS.get(record.levelno, _RESET)
        original_levelname = record.levelname
        try:
            record.levelname = f"{color}[{record.levelname}]{_RESET}"
            return super().format(record)
        finally:
            record.levelname = original_levelname


def _console_log_redis_url() -> str:
    try:
        from src.app.config import read_config
        from src.core.redis_url import effective_redis_dict, format_redis_url

        config, _ = read_config()
    except (ImportError, OSError, ValueError, TypeError):
        config = {}
    return format_redis_url(effective_redis_dict(config, default_db=0))


def setup_logging(*, research_log_stream_key: str, redis_url: str | None = None) -> None:
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(
        ColoredFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    resolved_redis = redis_url if redis_url else _console_log_redis_url()
    redis_handler = RedisStreamLogHandler(
        resolved_redis,
        research_log_stream_key,
        maxlen=_RESEARCH_LOG_STREAM_MAXLEN,
    )
    redis_handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(console_handler)
    root.addHandler(redis_handler)
    root.setLevel(logging.INFO)

    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        uv_logger = logging.getLogger(name)
        uv_logger.handlers.clear()
        uv_logger.propagate = True


def _pids_on_port(port: int) -> list:
    try:
        out = subprocess.run(
            ["lsof", "-i", f":{port}", "-t"],
            capture_output=True, text=True, timeout=5, check=False,
        )
        if out.returncode != 0 and out.stderr and "cannot identify protocol" not in (out.stderr or "").lower():
            return []
        return [int(x) for x in (out.stdout or "").strip().splitlines() if x.strip()]
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        return []


def _kill_pids(pids: list, sig: int = signal.SIGTERM) -> None:
    for pid in pids:
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def _free_port(port: int, wait_sec: float = 0.6) -> bool:
    pids = _pids_on_port(port)
    if not pids:
        return True
    print(f"Port {port} in use by PIDs {pids}; sending SIGTERM...", file=sys.stderr)
    _kill_pids(pids, signal.SIGTERM)
    time.sleep(wait_sec)
    still = _pids_on_port(port)
    if still:
        _kill_pids(still, signal.SIGKILL)
        time.sleep(wait_sec)
    return len(_pids_on_port(port)) == 0


def main() -> None:
    from src.app.config import (
        config_profile_from_resolved_path,
        read_config,
        research_api_console_stream_key,
        resolve_startup_config_path,
    )
    from src.core.redis_url import effective_redis_dict, format_redis_url

    argv_raw = sys.argv[1:]
    config_path, _ = resolve_startup_config_path(_PROJECT_ROOT, argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path
    config, resolved_config_path = read_config(config_path)
    profile = config_profile_from_resolved_path(resolved_config_path)

    redis_url = format_redis_url(effective_redis_dict(config, default_db=0))
    setup_logging(
        research_log_stream_key=research_api_console_stream_key(profile),
        redis_url=redis_url,
    )
    print(f"bifrost research server: YAML loaded: {resolved_config_path}", file=sys.stderr)
    port = int(config["server"]["research_port"])
    if not _free_port(port):
        print(f"Could not free port {port}.", file=sys.stderr)
        sys.exit(1)
    from backend.research.app import run_research_server

    run_research_server(config, resolved_config_path=resolved_config_path)


if __name__ == "__main__":
    main()
