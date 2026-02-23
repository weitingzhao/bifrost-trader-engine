#!/usr/bin/env python3
"""Wrapper to start the status server: read port from config, free the port if occupied, then run run_status_server.py."""

import os
import signal
import subprocess
import sys
import time

# Project root
_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)


def get_port_from_config(config_path: str) -> int:
    """Read status_server.port from config YAML; default 8765."""
    import yaml
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    port = (
        config.get("status_server", {}).get("port")
        or config.get("server", {}).get("port")
        or 8765
    )
    return int(port)


def get_pids_on_port(port: int) -> list[int]:
    """Return list of PIDs listening on the given port (macOS/Linux via lsof)."""
    try:
        out = subprocess.run(
            ["lsof", "-i", f":{port}", "-t"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        if out.returncode != 0 and out.stderr and "cannot identify protocol" not in out.stderr.lower():
            return []
        pids = [int(x) for x in out.stdout.strip().splitlines() if x.strip()]
        return pids
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError):
        return []


def kill_pids(pids: list[int], sig: int = signal.SIGTERM) -> None:
    """Send signal to each PID; ignore missing processes."""
    for pid in pids:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError:
            print(f"Warning: no permission to signal PID {pid}", file=sys.stderr)


def free_port(port: int, wait_after_sec: float = 0.5) -> bool:
    """If port is in use, kill the process(es) and wait for port to be free. Return True if port is free (or freed)."""
    pids = get_pids_on_port(port)
    if not pids:
        return True
    print(f"Port {port} in use by PIDs: {pids}; sending SIGTERM...")
    kill_pids(pids, signal.SIGTERM)
    time.sleep(wait_after_sec)
    still = get_pids_on_port(port)
    if still:
        print(f"Still in use by {still}; sending SIGKILL...")
        kill_pids(still, signal.SIGKILL)
        time.sleep(wait_after_sec)
    return len(get_pids_on_port(port)) == 0


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    config_path = args[0] if args else None
    if config_path and not os.path.isabs(config_path):
        config_path = os.path.join(_PROJECT_ROOT, config_path)
    elif config_path is None:
        config_path = os.path.join(_PROJECT_ROOT, "config", "config.yaml")

    if not os.path.isfile(config_path):
        print(f"Config not found: {config_path}", file=sys.stderr)
        return 1

    port = get_port_from_config(config_path)
    print(f"Status server port from config: {port}")

    if not free_port(port):
        print(f"Could not free port {port}. Try: lsof -i :{port}", file=sys.stderr)
        return 1

    run_script = os.path.join(_PROJECT_ROOT, "scripts", "run_status_server.py")
    cmd = [sys.executable, run_script]
    if args:
        cmd.append(args[0])
    print(f"Starting: {' '.join(cmd)}")
    # Replace current process so signals (Ctrl+C) go to the server
    try:
        os.execv(sys.executable, cmd)
    except OSError as e:
        print(f"Failed to start status server: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
