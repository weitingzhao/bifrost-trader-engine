#!/usr/bin/env python3
"""Standalone IB Operator: one TWS client_id for Redis cmd RPC (account + market ops).

Uses merged YAML (same as run_server.py). Requires ``redis.enabled`` and ``ib:`` host block.

  python scripts/systemd/run_ib_operator.py
  python scripts/systemd/run_ib_operator.py config/config.prod.yaml
  BIFROST_ENV=prod python scripts/systemd/run_ib_operator.py

Troubleshooting:

- IB ``Error 326`` / ``client id is already in use``: another process is using the same
  ``ib.host.client_id.operator`` (e.g. second Operator, or overlapping id with daemon/Celery/ingest).
  Stop the duplicate or assign distinct client_ids in YAML.
- **Port**: Operator uses ``ib.host.port_type`` (``ib.port``). ``IBConnector`` may try
  ``port+1…`` on connection refused (``max_port_steps=5``).
- Redis ``NOGROUP``: stream or consumer group was missing. The operator recreates the group on NOGROUP;
  ensure FastAPI and Operator use the same ``redis`` URL and DB index.
- **Dashboard log**: Redis stream ``bifrost:console:ws_ib_operator`` (Socket Services IB Operator log panel).
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
from pathlib import Path

_PROJECT_ROOT = str(Path(__file__).resolve().parent.parent.parent)
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

_IB_OPERATOR_LOG_STREAM_MAXLEN = 2000


def _console_log_redis_url() -> str:
    try:
        from src.app.config import read_config
        from src.core.redis_url import effective_redis_dict, format_redis_url

        config, _ = read_config()
    except (ImportError, OSError, ValueError, TypeError):
        config = {}
    return format_redis_url(effective_redis_dict(config, default_db=0))


def _setup_ib_operator_logging(level: int = logging.INFO) -> None:
    from backend.monitor.routers.deps import IB_OPERATOR_LOG_STREAM_KEY
    from src.core.logging_redis_stream import RedisStreamLogHandler

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(
        logging.Formatter(
            fmt="%(asctime)s %(levelname)s %(name)s: %(message)s",
            datefmt="%Y-%m-%d %H:%M:%S",
        )
    )
    redis_handler = RedisStreamLogHandler(
        _console_log_redis_url(),
        IB_OPERATOR_LOG_STREAM_KEY,
        maxlen=_IB_OPERATOR_LOG_STREAM_MAXLEN,
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
    root.setLevel(level)


def main() -> None:
    from src.app.config import get_effective_ib_config, read_config, resolve_startup_config_path
    from src.ib_operator.config import effective_ib_operator_settings
    from src.ib_operator.service import run_ib_operator_loop

    argv_raw = sys.argv[1:]
    config_path, _ = resolve_startup_config_path(_PROJECT_ROOT, argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path
    config, resolved = read_config(config_path)
    _setup_ib_operator_logging(logging.INFO)
    log = logging.getLogger("run_ib_operator")
    log.info("IB Operator: config loaded %s", resolved)
    _rp = Path(resolved)
    if _rp.name in ("config.dev.yaml", "config.prod.yaml"):
        _base = _rp.parent / "config.yaml"
        if _base.is_file():
            log.info("IB Operator: merged with base %s", _base)

    op = effective_ib_operator_settings(config)
    log.info("IB Operator Redis health hash: %s", op["health_key"])
    if not op["enabled"]:
        log.error("IB Operator disabled (set ib_operator.enabled: true and enable Redis).")
        sys.exit(1)
    try:
        get_effective_ib_config(config)
    except ValueError as e:
        log.error("Invalid or missing ib: block: %s", e)
        sys.exit(1)

    stop = threading.Event()

    def _handle_sig(_signum: int, _frame: object) -> None:
        log.info("Signal received, stopping...")
        stop.set()

    signal.signal(signal.SIGTERM, _handle_sig)
    signal.signal(signal.SIGINT, _handle_sig)

    run_ib_operator_loop(config, stop_event=stop)


if __name__ == "__main__":
    main()
