#!/usr/bin/env python3
"""
Debug script to isolate IB connection issues.

Deprecated: Use run_steps.py instead.
  python scripts/run_steps.py --step 1,2,3 [--debug]

This script delegates to run_steps.py --step 1,2,3 for backward compatibility.
"""

import os
import subprocess
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_PROJECT_ROOT = os.path.dirname(_SCRIPT_DIR)

if __name__ == "__main__":
    args = [sys.executable, os.path.join(_SCRIPT_DIR, "run_steps.py"), "--step", "1,2,3"]
    if "--debug" in sys.argv:
        args.append("--debug")
    passthrough = [a for a in sys.argv[1:] if not a.startswith("--") and a != "--debug"]
    if passthrough:
        args.extend(["--config", passthrough[0]])
    sys.exit(subprocess.run(args, cwd=_PROJECT_ROOT).returncode)
