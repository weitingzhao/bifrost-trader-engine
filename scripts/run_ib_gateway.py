#!/usr/bin/env python3
"""Standalone IB Gateway: sole TWS connections for API-side client_ids; Redis Stream RPC.

Uses merged YAML (same as run_server.py). Requires ``redis.enabled`` and ``ib:`` host block.

  python scripts/run_ib_gateway.py
  python scripts/run_ib_gateway.py config/config.prod.yaml
  BIFROST_ENV=prod python scripts/run_ib_gateway.py

Troubleshooting:

- IB ``Error 326`` / ``client id is already in use``: another process is using the same
  ``ib.host.client_id.account`` or ``markets`` (e.g. second Gateway, old code, or Celery bars
  worker). Stop the duplicate or assign distinct client_ids in YAML.
- Redis ``NOGROUP``: stream or consumer group was missing (e.g. key deleted, wrong DB).
  The gateway will try to recreate the group on NOGROUP; ensure FastAPI and Gateway use the
  same ``redis`` URL and DB index.
"""

from __future__ import annotations

import logging
import os
import signal
import sys
import threading
from pathlib import Path

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

logging.basicConfig(
    force=True,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("run_ib_gateway")


def main() -> None:
    from src.app.config import get_effective_ib_config, read_config, resolve_startup_config_path
    from src.ib_gateway.config import effective_ib_gateway_settings
    from src.ib_gateway.service import run_ib_gateway_loop

    argv_raw = sys.argv[1:]
    config_path, _ = resolve_startup_config_path(_PROJECT_ROOT, argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path
    config, resolved = read_config(config_path)
    log.info("IB Gateway: config loaded %s", resolved)
    _rp = Path(resolved)
    if _rp.name in ("config.dev.yaml", "config.prod.yaml"):
        _base = _rp.parent / "config.yaml"
        if _base.is_file():
            log.info("IB Gateway: merged with base %s", _base)

    gw = effective_ib_gateway_settings(config)
    if not gw["enabled"]:
        log.error("IB Gateway disabled (set ib_gateway.enabled: true and enable Redis).")
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

    run_ib_gateway_loop(config, stop_event=stop)


if __name__ == "__main__":
    main()
