#!/usr/bin/env python3
"""Start Celery worker for bars backfill.

Requires Redis (config.redis or REDIS_* env) and postgres. Usage:

  python scripts/run_celery.py [config_path]
  python scripts/run_celery.py --prod
  BIFROST_ENV=prod python scripts/run_celery.py

Before starting, kills any existing Celery worker process for this app (same script or celery -A backend.workers.celery_app worker -Q bars)
so the port/process is not left occupied. Uses --pool=solo (single process) so Stop button and IB connection work reliably.
Massive/Polygon option sync uses a separate queue (no IB):
  celery -A backend.workers.celery_app worker -l info -Q massive --pool=solo
Or run Celery directly:
  celery -A backend.workers.celery_app worker -l info -Q bars --pool=solo

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


def _strip_instance_from_argv(argv: list[str]) -> tuple[str | None, list[str]]:
    """Remove ``--instance <id>`` from argv (used by systemd template bifrost-celery-worker@.service)."""
    out: list[str] = []
    instance: str | None = None
    i = 0
    while i < len(argv):
        if argv[i] == "--instance" and i + 1 < len(argv):
            instance = argv[i + 1]
            i += 2
            continue
        out.append(argv[i])
        i += 1
    return instance, out


def _kill_pids_from_pgrep(cmd: list[str]) -> None:
    """SIGTERM PIDs from pgrep except current process; sleep 1s if any killed."""
    import subprocess

    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=5)
        if out.returncode != 0 or not out.stdout.strip():
            return
        pids = [x.strip() for x in out.stdout.strip().splitlines() if x.strip().isdigit()]
        my_pid = str(os.getpid())
        killed = False
        for pid in pids:
            if pid == my_pid:
                continue
            try:
                os.kill(int(pid), signal.SIGTERM)
                sys.stderr.write(f"[run_celery] Sent SIGTERM to existing worker PID {pid}\n")
                killed = True
            except (ProcessLookupError, ValueError):
                pass
        if killed:
            time.sleep(1)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def _kill_existing_celery_workers(instance: str | None) -> None:
    """SIGTERM duplicate workers: same instance only if ``--instance`` is set; else legacy single-worker behavior."""
    try:
        import subprocess

        if instance is not None:
            # Only stop another run_celery for this systemd instance (do not kill other @N workers).
            safe = instance.replace("\\", "\\\\").replace(".", "\\.")
            _kill_pids_from_pgrep(
                ["pgrep", "-f", f"python.*run_celery\\.py.*--instance {safe}"]
            )
            return

        _kill_pids_from_pgrep(["pgrep", "-f", "python.*run_celery\\.py"])
        _kill_pids_from_pgrep(["pgrep", "-f", "celery.*worker.*bars"])
    except Exception as e:
        sys.stderr.write(f"[run_celery] Warning: could not kill existing workers: {e}\n")


_DEFAULT_QUEUES = "bars,massive_high,massive"

_INSTANCE_PROFILE_RE = None


def _parse_instance_profile(instance_id: str) -> tuple[str | None, str | None]:
    """Extract ``(profile_key, seq)`` from instance ID like ``bars-1``."""
    import re

    global _INSTANCE_PROFILE_RE
    if _INSTANCE_PROFILE_RE is None:
        _INSTANCE_PROFILE_RE = re.compile(r"^(?P<profile>[a-zA-Z0-9_]+)-(?P<seq>\d+)$")
    m = _INSTANCE_PROFILE_RE.match(instance_id)
    if m:
        return m.group("profile"), m.group("seq")
    return None, None


def _resolve_queues_for_instance(
    instance: str | None, config_path: str,
) -> str:
    """Determine the comma-separated queue list for the given instance.

    When ``--instance bars-2`` is passed, the profile prefix ``bars`` is looked
    up in ``ops.worker_profiles`` from the loaded config.  If not found or no
    instance flag, falls back to the legacy all-queue list.
    """
    if instance is None:
        return _DEFAULT_QUEUES

    profile_key, _seq = _parse_instance_profile(instance)
    if profile_key is None:
        sys.stderr.write(
            f"[run_celery] WARNING: instance {instance!r} does not match "
            f"<profile>-<seq> pattern; using default queues.\n"
        )
        return _DEFAULT_QUEUES

    import yaml

    try:
        with open(config_path, "r") as fh:
            cfg = yaml.safe_load(fh) or {}
    except Exception as exc:
        sys.stderr.write(
            f"[run_celery] WARNING: cannot read {config_path}: {exc}; "
            f"using default queues.\n"
        )
        return _DEFAULT_QUEUES

    profiles = (cfg.get("ops") or {}).get("worker_profiles") or {}
    entry = profiles.get(profile_key)
    if entry is None or not isinstance(entry, dict):
        sys.stderr.write(
            f"[run_celery] ERROR: profile {profile_key!r} not found in "
            f"ops.worker_profiles ({config_path}). Exiting.\n"
        )
        sys.exit(1)

    queues = entry.get("queues") or []
    if isinstance(queues, str):
        queues = [queues]
    queues = [str(q).strip() for q in queues if str(q).strip()]
    if not queues:
        sys.stderr.write(
            f"[run_celery] ERROR: profile {profile_key!r} has empty queues. Exiting.\n"
        )
        sys.exit(1)

    return ",".join(queues)


if __name__ == "__main__":
    import socket

    from src.app.config import resolve_startup_config_path

    argv_raw = sys.argv[1:]
    instance, argv_for_config = _strip_instance_from_argv(argv_raw)
    config_path, _ = resolve_startup_config_path(str(_PROJECT_ROOT), argv_for_config)
    os.environ["BIFROST_CONFIG"] = config_path
    _kill_existing_celery_workers(instance)

    queue_str = _resolve_queues_for_instance(instance, config_path)
    sys.stderr.write(f"[run_celery] queues={queue_str} instance={instance}\n")

    from backend.workers.celery_app import app

    worker_argv = ["worker", "-l", "info", "-Q", queue_str, "--pool=solo"]
    if instance is not None:
        host = socket.gethostname()
        nodename = f"worker{instance}@{host}"
        worker_argv.extend(["-n", nodename])
        # worker_init runs before Celery sets Worker.hostname; Redis console key must match -n (see celery_app._resolve_celery_worker_id).
        os.environ["BIFROST_CELERY_NODENAME"] = nodename

    app.worker_main(argv=worker_argv)
