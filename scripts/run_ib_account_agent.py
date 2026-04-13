#!/usr/bin/env python3
"""Delegates to scripts/systemd/run_ib_account_agent.py (compat entrypoint)."""
from __future__ import annotations

import os
import sys
from pathlib import Path

_root = Path(__file__).resolve().parent.parent
_target = _root / "scripts" / "systemd" / "run_ib_account_agent.py"
os.execv(sys.executable, [sys.executable, str(_target), *sys.argv[1:]])
