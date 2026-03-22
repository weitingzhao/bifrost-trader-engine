#!/usr/bin/env python3
"""Start Celery worker for bars backfill.

Requires Redis (config.redis or REDIS_* env) and postgres. Usage:

  python scripts/run_celery.py [config_path]
  python scripts/run_celery.py --prod
  BIFROST_ENV=prod python scripts/run_celery.py

Before starting, kills any existing Celery worker process for this app (same script or celery -A servers.celery_app worker -Q bars)
so the port/process is not left occupied. Uses --pool=solo (single process) so Stop button and IB connection work reliably.
Massive/Polygon option sync uses a separate queue (no IB):
  celery -A servers.celery_app worker -l info -Q massive --pool=solo
Or run Celery directly:
  celery -A servers.celery_app worker -l info -Q bars --pool=solo

Default config: config/config.dev.yaml (or BIFROST_CONFIG / first positional path / BIFROST_ENV=prod → config.prod.yaml).
"""

from __future__ import annotations

import os
import signal
import sys
import time
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


def _kill_existing_celery_workers() -> None:
    """Find and SIGTERM any existing Celery worker process for this app (run_celery.py or celery worker -Q bars)."""
    try:
        import subprocess
        # Find PIDs: this script or celery worker with our app and bars queue
        for pattern, cmd in [
            ("run_celery.py", ["pgrep", "-f", "python.*run_celery\\.py"]),
            ("celery worker bars", ["pgrep", "-f", "celery.*worker.*bars"]),
        ]:
            try:
                out = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
                if out.returncode != 0 or not out.stdout.strip():
                    continue
                pids = [x.strip() for x in out.stdout.strip().splitlines() if x.strip().isdigit()]
                my_pid = str(os.getpid())
                for pid in pids:
                    if pid == my_pid:
                        continue
                    try:
                        os.kill(int(pid), signal.SIGTERM)
                        sys.stderr.write(f"[run_celery] Sent SIGTERM to existing worker PID {pid}\n")
                    except (ProcessLookupError, ValueError):
                        pass
                if pids:
                    time.sleep(1)
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass
    except Exception as e:
        sys.stderr.write(f"[run_celery] Warning: could not kill existing workers: {e}\n")


if __name__ == "__main__":
    from src.app.config import resolve_startup_config_path

    argv_raw = sys.argv[1:]
    config_path, _ = resolve_startup_config_path(str(_PROJECT_ROOT), argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path
    _kill_existing_celery_workers()
    from servers.celery_app import app
    # Solo pool: single process, no fork; stop-poll started in worker_init. Prefork would need worker_process_init.
    app.worker_main(argv=["worker", "-l", "info", "-Q", "bars,massive", "--pool=solo"])
