#!/usr/bin/env python3
"""启动 MkDocs 文档服务。默认 http://127.0.0.1:8000，可通过环境变量 DOCS_PORT 或 --port 指定端口。
若端口已被占用，会先 kill 占用该端口的进程，再启动 serve。"""

import argparse
import os
import signal
import subprocess
import sys
import time

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(_PROJECT_ROOT)


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


def main() -> int:
    parser = argparse.ArgumentParser(description="启动 MkDocs 文档服务 (mkdocs serve)")
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=int(os.environ.get("DOCS_PORT", "8000")),
        help="监听端口 (默认 8000，或环境变量 DOCS_PORT)",
    )
    parser.add_argument(
        "-a", "--addr",
        default="127.0.0.1",
        help="监听地址 (默认 127.0.0.1)",
    )
    args = parser.parse_args()
    if not _free_port(args.port):
        print(f"Could not free port {args.port}. Run: lsof -i :{args.port}", file=sys.stderr)
        return 1
    addr_spec = f"{args.addr}:{args.port}"
    print(f"Starting MkDocs serve at http://{addr_spec} ...")
    try:
        return subprocess.run(
            [sys.executable, "-m", "mkdocs", "serve", "-a", addr_spec],
            cwd=_PROJECT_ROOT,
        ).returncode
    except FileNotFoundError:
        print("Error: mkdocs not found. Install with: pip install mkdocs mkdocs-material", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
