#!/usr/bin/env python3
"""Account Sync Daemon — consume ib:account:stream:v1 → diff → PostgreSQL.

Persists Account, Position, Execution, and Open Order data independently of the
Trading Daemon.  Uses Redis Stream XREADGROUP for incremental consumption.

Usage::
  python scripts/run_account_sync_daemon.py
  python scripts/run_account_sync_daemon.py --config config/config.prod.yaml
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(str(_PROJECT_ROOT))

from src.core.logging_redis_stream import RedisStreamLogHandler
from src.daemon.account_sync.redis_keys import ACCOUNT_SYNC_LOG_STREAM_KEY

_LOG_STREAM_MAXLEN = 2000

logger = logging.getLogger("account_sync_daemon")


def _console_log_redis_url(config_path: str | None) -> str:
    try:
        from src.app.config import read_config
        from src.core.redis_url import effective_redis_dict, format_redis_url

        config, _ = read_config(config_path)
    except Exception:
        config = {}
    return format_redis_url(effective_redis_dict(config, default_db=0))


def _setup_logging(level: int, config_path: str | None) -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(logging.Formatter("%(asctime)s %(name)s %(levelname)s  %(message)s"))
    redis_handler = RedisStreamLogHandler(
        _console_log_redis_url(config_path),
        ACCOUNT_SYNC_LOG_STREAM_KEY,
        maxlen=_LOG_STREAM_MAXLEN,
    )
    redis_handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(h)
    root.addHandler(redis_handler)
    root.setLevel(level)


def _load_config(config_path: str | None) -> dict:
    from src.app.config import read_config

    cfg, _ = read_config(config_path)
    return cfg


def main() -> None:
    parser = argparse.ArgumentParser(description="Account Sync Daemon (Redis stream → PostgreSQL)")
    parser.add_argument("--config", type=str, default=None)
    parser.add_argument(
        "--log-level",
        type=str,
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )
    args = parser.parse_args()
    cfg_path: str | None = args.config
    if cfg_path:
        p = Path(cfg_path)
        if not p.is_absolute():
            p = _PROJECT_ROOT / p
        if not p.is_file():
            print(f"ERROR: --config file not found: {args.config}", file=sys.stderr)
            sys.exit(2)
        cfg_path = str(p.resolve())
    else:
        for candidate in ("config/config.dev.yaml", "config/config.prod.yaml"):
            cp = _PROJECT_ROOT / candidate
            if cp.is_file():
                cfg_path = str(cp.resolve())
                break

    _setup_logging(getattr(logging, args.log_level), cfg_path)
    cfg = _load_config(cfg_path)

    from src.daemon.account_sync.app import AccountSyncDaemon

    app = AccountSyncDaemon(cfg)
    asyncio.run(app.run())


if __name__ == "__main__":
    main()
