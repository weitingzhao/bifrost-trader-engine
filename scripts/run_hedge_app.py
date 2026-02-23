#!/usr/bin/env python3
"""Hedging app: runs the gamma scalping strategy. Can run standalone or as subprocess of the stable daemon (run_daemon.py).

When started by the stable daemon, BIFROST_HEDGE_CLIENT_ID and BIFROST_UNDER_DAEMON are set; the daemon
holds the primary IB Client ID and starts/stops this process on monitor resume/suspend.
"""

import logging
import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO,
)

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    config_path = args[0] if args else None
    if config_path and not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    elif config_path is None:
        config_path = os.environ.get("BIFROST_CONFIG", str(_PROJECT_ROOT / "config" / "config.yaml"))

    from src.app.gs_trading import run_daemon
    run_daemon(config_path)
