#!/usr/bin/env python3
"""Phase 2: Standalone status/control server. Reads PostgreSQL; GET /status, GET /operations, POST /control/stop.

On startup, reads server.architecture.monitor_port (normalized to ``server.monitor_port``) from config and frees the port if already in use (kills existing process), then starts the Monitor FastAPI app (``backend.monitor.app``).

Default config: ``config/config.dev.yaml``. Use ``--prod`` or ``BIFROST_ENV=prod`` for ``config/config.prod.yaml``, or ``BIFROST_CONFIG`` / first positional path."""

import logging
import logging.config
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

try:
    import redis
except ImportError:  # pragma: no cover - optional at import time; handler falls back to no-op
    redis = None

# Project root: same as run_engine.py
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

logging.basicConfig(
    force=True,
)

_RESET = "\033[0m"
_BOLD = "\033[1m"
_GRAY = "\033[90m"
_CYAN = "\033[36m"
_YELLOW = "\033[33m"
_RED = "\033[31m"
_SERVER_LOG_STREAM_KEY = "bifrost:server_console"
_SERVER_LOG_STREAM_MAXLEN = 50

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
    """Push server log lines to Redis Stream for the web console.

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


def _console_log_redis_url() -> str:
    """Build Redis URL from config/env. Falls back to local Redis."""
    try:
        from src.app.config import read_config
        from src.core.redis_url import effective_redis_dict, format_redis_url

        config, _ = read_config()
    except (ImportError, OSError, ValueError, TypeError):
        config = {}
    return format_redis_url(effective_redis_dict(config, default_db=0))


def setup_logging() -> None:
    """Configure terminal logging and Redis stream logging for Server Console."""
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(
        ColoredFormatter(
            fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    redis_handler = RedisStreamLogHandler(
        _console_log_redis_url(),
        _SERVER_LOG_STREAM_KEY,
        maxlen=_SERVER_LOG_STREAM_MAXLEN,
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


def _port_from_config(config: dict) -> int:
    """Port from config (same as servers.app.run_server)."""
    port = config.get("server", {}).get("monitor_port") or 8765
    return int(port)


def _pids_on_port(port: int) -> list[int]:
    """PIDs listening on port (macOS/Linux: lsof)."""
    try:
        out = subprocess.run(
            ["lsof", "-i", f":{port}", "-t"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        if out.returncode != 0 and out.stderr and "cannot identify protocol" not in (out.stderr or "").lower():
            return []
        return [int(x) for x in (out.stdout or "").strip().splitlines() if x.strip()]
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        return []


def _kill_pids(pids: list[int], sig: int = signal.SIGTERM) -> None:
    for pid in pids:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            print(f"Warning: no permission to signal PID {pid}", file=sys.stderr)


def _free_port(port: int, wait_sec: float = 0.6) -> bool:
    """Kill process(es) on port so it is free. Return True if port is free."""
    pids = _pids_on_port(port)
    if not pids:
        return True
    print(f"Port {port} in use by PIDs {pids}; sending SIGTERM...")
    _kill_pids(pids, signal.SIGTERM)
    time.sleep(wait_sec)
    still = _pids_on_port(port)
    if still:
        print(f"Still in use by {still}; sending SIGKILL...")
        _kill_pids(still, signal.SIGKILL)
        time.sleep(wait_sec)
    return len(_pids_on_port(port)) == 0


def main() -> None:
    from src.app.config import get_effective_ib_config, read_config, resolve_startup_config_path

    argv_raw = sys.argv[1:]
    config_path, _ = resolve_startup_config_path(_PROJECT_ROOT, argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path
    setup_logging()
    config, resolved_config_path = read_config(config_path)
    print(f"bifrost status server: YAML loaded (env file): {resolved_config_path}", file=sys.stderr)
    # Same merge rule as read_config(): if config.yaml exists next to config.{dev,prod}.yaml, it was merged (env overlays base).
    _rp = Path(resolved_config_path)
    if _rp.name in ("config.dev.yaml", "config.prod.yaml"):
        _base = _rp.parent / "config.yaml"
        if _base.is_file():
            print(
                f"bifrost status server: merged config base {_base} + env {_rp.name} (env wins on conflicts).",
                file=sys.stderr,
            )
        else:
            print(
                f"bifrost status server: no {_base.name} beside env file; using {_rp.name} only.",
                file=sys.stderr,
            )
    # Status server requires a valid IB section in YAML for monitor IB clients and APIs (after merge
    # of config.yaml + config.{dev|prod}.yaml). Management-only: set server.skip_monitor_ib: true.
    if not (config.get("server") or {}).get("skip_monitor_ib", False):
        try:
            get_effective_ib_config(config)
        except ValueError as e:
            print(
                "Status server: invalid or missing IB config. "
                "Provide a full 'ib:' block in YAML (merge config.yaml with config.prod.yaml if split). "
                "Or set server.skip_monitor_ib: true for API-only management hosts. "
                f"Detail: {e}",
                file=sys.stderr,
            )
            sys.exit(1)
    port = _port_from_config(config)
    if not _free_port(port):
        print(f"Could not free port {port}. Run: lsof -i :{port}", file=sys.stderr)
        sys.exit(1)
    from backend.monitor.app import run_server
    run_server(config, resolved_config_path=resolved_config_path)


if __name__ == "__main__":
    main()
