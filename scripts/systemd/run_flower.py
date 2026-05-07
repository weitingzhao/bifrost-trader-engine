#!/usr/bin/env python3
"""Start Celery Flower (web UI) for broker/worker/task monitoring.

Uses the same Redis broker as ``run_celery.py`` (via ``BIFROST_CONFIG`` → ``src.workers.celery_app``).

Requires: ``pip install flower`` (listed in requirements.txt).

Usage::

  python scripts/systemd/run_flower.py
  python scripts/systemd/run_flower.py --prod
  BIFROST_CONFIG=config/config.prod.yaml python scripts/systemd/run_flower.py

Bind / port (defaults: localhost only, port 5555)::

  FLOWER_ADDRESS=0.0.0.0 FLOWER_PORT=5555 python scripts/systemd/run_flower.py

Extra args are forwarded to ``celery flower`` (see ``celery flower --help``)::

  python scripts/systemd/run_flower.py -- --basic_auth=user:secret

Open in browser: http://127.0.0.1:5555 (or your FLOWER_ADDRESS:FLOWER_PORT).
"""

from __future__ import annotations

import errno
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


def _flag_value_from_extra(extra: list[str], name: str) -> str | None:
    """Return value from ``--name=value`` in extra args (last wins)."""
    prefix = f"--{name}="
    out: str | None = None
    for a in extra:
        if a.startswith(prefix):
            out = a[len(prefix) :].strip()
    return out


def _without_listen_flags(extra: list[str]) -> list[str]:
    """Drop ``--port=`` / ``--address=`` so they are not duplicated after we merge them into the command."""
    return [
        a
        for a in extra
        if not a.startswith("--port=") and not a.startswith("--address=")
    ]


def _find_listen_pids(port: int) -> list[int]:
    """Return listener PIDs for a TCP port via lsof (macOS/Linux)."""
    try:
        result = subprocess.run(
            ["lsof", "-tiTCP:%d" % port, "-sTCP:LISTEN"],
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError:
        return []
    pids: list[int] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            pids.append(int(line))
        except ValueError:
            continue
    return sorted(set(pids))


def _is_listen_available(host: str, port_n: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, port_n))
        return True
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            return False
        raise
    finally:
        s.close()


def _kill_pids_for_port(port_n: int) -> bool:
    """Terminate listeners on a port. Returns True if any PID was targeted."""
    pids = _find_listen_pids(port_n)
    if not pids:
        return False
    this_pid = os.getpid()
    target_pids = [pid for pid in pids if pid != this_pid]
    if not target_pids:
        return False
    sys.stderr.write(
        f"[run_flower] Port {port_n} in use by PID(s): {', '.join(str(p) for p in target_pids)}. "
        "Sending SIGTERM...\n"
    )
    for pid in target_pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            sys.stderr.write(f"[run_flower] No permission to terminate PID {pid}.\n")
    time.sleep(0.8)
    for pid in target_pids:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            continue
        except PermissionError:
            continue
        sys.stderr.write(f"[run_flower] PID {pid} still alive, sending SIGKILL...\n")
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            sys.stderr.write(f"[run_flower] No permission to kill PID {pid}.\n")
    time.sleep(0.2)
    return True


def _ensure_listen_available(host: str, port_s: str, auto_kill: bool) -> None:
    """Ensure Flower target listen address is available, optionally killing conflicting listener."""
    try:
        port_n = int(port_s)
    except ValueError:
        return
    if _is_listen_available(host, port_n):
        return
    if auto_kill:
        killed = _kill_pids_for_port(port_n)
        if killed and _is_listen_available(host, port_n):
            sys.stderr.write(f"[run_flower] Port {port_n} released, continuing startup.\n")
            return
    alt = port_n + 1
    sys.stderr.write(
        f"[run_flower] Address {host!r}:{port_s} is already in use. "
        f"Could not auto-release the port. Use another port:\n"
        f"  FLOWER_PORT={alt} python scripts/systemd/run_flower.py\n"
    )
    raise SystemExit(1)


if __name__ == "__main__":
    from src.app.config import resolve_startup_config_path

    argv_raw = sys.argv[1:]
    config_path, flower_extra = resolve_startup_config_path(str(_PROJECT_ROOT), argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path

    port = os.environ.get("FLOWER_PORT", "5555").strip() or "5555"
    address = os.environ.get("FLOWER_ADDRESS", "127.0.0.1").strip() or "127.0.0.1"
    port = _flag_value_from_extra(flower_extra, "port") or port
    address = _flag_value_from_extra(flower_extra, "address") or address

    auto_kill_conflict = os.environ.get("FLOWER_KILL_PORT_CONFLICT", "1").strip() not in {
        "0",
        "false",
        "False",
        "no",
        "No",
    }
    _ensure_listen_available(address, port, auto_kill=auto_kill_conflict)

    cmd: list[str] = [
        sys.executable,
        "-m",
        "celery",
        "-A",
        "src.workers.celery_app",
        "flower",
        "-l",
        "info",
        f"--port={port}",
        f"--address={address}",
    ]
    cmd.extend(_without_listen_flags(flower_extra))

    raise SystemExit(
        subprocess.call(
            cmd,
            cwd=str(_PROJECT_ROOT),
            env={**os.environ, "BIFROST_CONFIG": config_path},
        )
    )
