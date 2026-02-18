#!/usr/bin/env python3
"""Build FSM docs: run all fsm_* scripts in md mode, then optionally mkdocs build.

Run: python scripts/build_fsm_docs.py [--mkdocs]
  Without --mkdocs: only generate MD files.
  With --mkdocs: generate MD then run mkdocs build.
"""
import argparse
import subprocess
import sys
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_project_root))


def run_script(name: str, mode: str = "md") -> bool:
    """Run scripts/{name} {mode}. Return True on success."""
    script = _project_root / "scripts" / name
    result = subprocess.run(
        [sys.executable, str(script), mode],
        cwd=str(_project_root),
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(f"Error running {name} {mode}: {result.stderr}", file=sys.stderr)
        return False
    print(result.stdout.strip())
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description="Build FSM docs")
    parser.add_argument(
        "--mkdocs",
        action="store_true",
        help="Run mkdocs build after generating MD",
    )
    args = parser.parse_args()

    scripts = [
        "fsm_hedge_diagram.py",
        "fsm_trading_diagram.py",
        "fsm_daemon_diagram.py",
        "fsm_linkage_diagram.py",
    ]
    ok = True
    for s in scripts:
        if not run_script(s):
            ok = False
        # Also generate HTML for daemon, hedge, trading, linkage
        if s in ("fsm_daemon_diagram.py", "fsm_hedge_diagram.py", "fsm_trading_diagram.py", "fsm_linkage_diagram.py"):
            if not run_script(s, "html"):
                ok = False
    if not ok:
        sys.exit(1)

    if args.mkdocs:
        result = subprocess.run(
            ["mkdocs", "build"],
            cwd=str(_project_root),
        )
        if result.returncode != 0:
            sys.exit(result.returncode)
        print("MkDocs build complete: site/")


if __name__ == "__main__":
    main()
