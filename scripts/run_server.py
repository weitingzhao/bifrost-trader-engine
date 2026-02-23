#!/usr/bin/env python3
"""Phase 2: Standalone status/control server. Reads PostgreSQL sink; GET /status, GET /operations, POST /control/stop.

On startup, reads status_server.port (or server.port) from config and frees the port if already in use (kills existing process), then starts the server (servers.app)."""

import logging
import os
import signal
import subprocess
import sys
import time

# Project root: same as run_engine.py
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)

logging.basicConfig(
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    level=logging.INFO,
)


def _port_from_config(config: dict) -> int:
    """Port from config (same as servers.app.run_server)."""
    port = (
        config.get("status_server", {}).get("port")
        or config.get("server", {}).get("port")
        or 8765
    )
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
    from src.app.gs_trading import read_config

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    config_path = args[0] if args else None
    if config_path and not os.path.isabs(config_path):
        config_path = os.path.join(_PROJECT_ROOT, config_path)
    elif config_path is None:
        config_path = os.path.join(_PROJECT_ROOT, "config", "config.yaml")
    config, _ = read_config(config_path)
    port = _port_from_config(config)
    if not _free_port(port):
        print(f"Could not free port {port}. Run: lsof -i :{port}", file=sys.stderr)
        sys.exit(1)
    from servers.app import run_server
    run_server(config)


if __name__ == "__main__":
    main()
