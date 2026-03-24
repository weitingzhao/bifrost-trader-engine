#!/usr/bin/env python3
"""Start Celery Beat for Massive scheduled tasks (EOD pipeline, corporate actions, reconcile, trim).

Requires the same Redis broker as ``run_celery.py``. Schedule is defined in
``servers/celery_app.py`` (``beat_schedule``). Run a **worker** that consumes the
``massive`` queue in parallel (e.g. ``python scripts/run_celery.py``).

Usage::

  python scripts/run_celery_beat.py
  python scripts/run_celery_beat.py --prod
  BIFROST_CONFIG=config/config.prod.yaml python scripts/run_celery_beat.py
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


if __name__ == "__main__":
    from src.app.config import resolve_startup_config_path

    argv_raw = sys.argv[1:]
    config_path, _ = resolve_startup_config_path(str(_PROJECT_ROOT), argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path
    raise SystemExit(
        subprocess.call(
            [
                sys.executable,
                "-m",
                "celery",
                "-A",
                "servers.celery_app",
                "beat",
                "-l",
                "info",
            ],
            cwd=str(_PROJECT_ROOT),
            env={**os.environ, "BIFROST_CONFIG": config_path},
        )
    )
