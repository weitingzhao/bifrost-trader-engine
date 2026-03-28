#!/usr/bin/env python3
"""Start Celery Flower (web UI) for broker/worker/task monitoring.

Uses the same Redis broker as ``run_celery.py`` (via ``BIFROST_CONFIG`` → ``src.workers.celery_app``).

Requires: ``pip install flower`` (listed in requirements.txt).

Usage::

  python scripts/run_flower.py
  python scripts/run_flower.py --prod
  BIFROST_CONFIG=config/config.prod.yaml python scripts/run_flower.py

Bind / port (defaults: localhost only, port 5555)::

  FLOWER_ADDRESS=0.0.0.0 FLOWER_PORT=5555 python scripts/run_flower.py

Extra args are forwarded to ``celery flower`` (see ``celery flower --help``)::

  python scripts/run_flower.py -- --basic_auth=user:secret

Open in browser: http://127.0.0.1:5555 (or your FLOWER_ADDRESS:FLOWER_PORT).
"""

from __future__ import annotations

import errno
import os
import socket
import subprocess
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
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


def _ensure_listen_available(host: str, port_s: str) -> None:
    """Fail fast with a clear hint if the TCP port is already bound (avoids Flower traceback)."""
    try:
        port_n = int(port_s)
    except ValueError:
        return
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((host, port_n))
    except OSError as e:
        if e.errno != errno.EADDRINUSE:
            raise
        alt = port_n + 1
        sys.stderr.write(
            f"[run_flower] Address {host!r}:{port_s} is already in use. "
            f"Stop the other process (e.g. an existing Flower), or use another port:\n"
            f"  FLOWER_PORT={alt} python scripts/run_flower.py\n"
        )
        raise SystemExit(1) from e
    finally:
        s.close()


if __name__ == "__main__":
    from src.app.config import resolve_startup_config_path

    argv_raw = sys.argv[1:]
    config_path, flower_extra = resolve_startup_config_path(str(_PROJECT_ROOT), argv_raw)
    os.environ["BIFROST_CONFIG"] = config_path

    port = os.environ.get("FLOWER_PORT", "5555").strip() or "5555"
    address = os.environ.get("FLOWER_ADDRESS", "127.0.0.1").strip() or "127.0.0.1"
    port = _flag_value_from_extra(flower_extra, "port") or port
    address = _flag_value_from_extra(flower_extra, "address") or address

    _ensure_listen_available(address, port)

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
