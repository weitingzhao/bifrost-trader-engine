#!/usr/bin/env python3
"""Thin wrapper — implementation lives in ``scripts/systemd/run_account_sync_daemon.py``.

Prefer invoking the systemd script directly for production.
"""

from __future__ import annotations

import runpy
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

if __name__ == "__main__":
    _impl = _PROJECT_ROOT / "scripts/systemd/run_account_sync_daemon.py"
    runpy.run_path(str(_impl), run_name="__main__")
