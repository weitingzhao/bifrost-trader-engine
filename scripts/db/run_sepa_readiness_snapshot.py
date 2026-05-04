#!/usr/bin/env python3
"""Run SEPA universe + price readiness snapshot (same logic as POST /research/screening/sepa/readiness/snapshot).

Usage:
  python scripts/db/run_sepa_readiness_snapshot.py [--config PATH] [--prod|--dev]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


def main() -> int:
    parser = argparse.ArgumentParser(description="Upsert sepa_universe_readiness_daily for CURRENT_DATE.")
    parser.add_argument("--config", default=None, help="YAML with postgres block")
    parser.add_argument("--prod", action="store_true")
    parser.add_argument("--dev", action="store_true")
    args, argv_remainder = parser.parse_known_args()

    try:
        import yaml
    except ImportError:
        print("pip install pyyaml", file=sys.stderr)
        return 1

    if args.config:
        config_path = Path(args.config).resolve()
    else:
        from src.app.config import resolve_startup_config_path

        cli_flags = []
        if args.prod:
            cli_flags.append("--prod")
        if args.dev:
            cli_flags.append("--dev")
        config_path_str, _ = resolve_startup_config_path(
            str(_PROJECT_ROOT),
            cli_flags + argv_remainder,
        )
        config_path = Path(config_path_str).resolve()

    if not config_path.is_file():
        print(f"Config not found: {config_path}", file=sys.stderr)
        return 1

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}

    from src.research.sepa.readiness_snapshot import run_sepa_universe_readiness_snapshot

    out = run_sepa_universe_readiness_snapshot(config)
    print(json.dumps(out, indent=2))
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
