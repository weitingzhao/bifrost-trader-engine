#!/usr/bin/env python3
"""Seed strategy_dim and strategy_template* (Option Template Config defaults).

Run after schema refresh, e.g.:
  python scripts/db_refresh_schema.py
  python scripts/db_init/seed_structure_type_config.py [--config PATH]
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
_db_init = _PROJECT_ROOT / "scripts" / "db_init"
if str(_db_init) not in sys.path:
    sys.path.insert(0, str(_db_init))
os.chdir(_PROJECT_ROOT)

from strategy_template_definitions import upsert_strategy_dims, upsert_strategy_templates


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Seed strategy_dim and strategy_template tables."
    )
    parser.add_argument(
        "--config",
        default="config/config.yaml",
        help="Config file path",
    )
    args = parser.parse_args()
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    if not Path(config_path).exists():
        print(f"Config not found: {config_path}", file=sys.stderr)
        return 1

    try:
        import yaml
        import psycopg2
        from src.sink.postgres_sink import _get_conn_params
    except ImportError as e:
        print(f"Missing dependency: {e}", file=sys.stderr)
        return 1

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    pg = config.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        print("postgres or PGHOST required.", file=sys.stderr)
        return 1

    params = _get_conn_params(config)
    params["connect_timeout"] = 10

    conn = None
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        print(f"Connect failed: {e}", file=sys.stderr)
        return 1

    try:
        with conn.cursor() as cur:
            upsert_strategy_dims(cur)
            upsert_strategy_templates(cur)
        conn.commit()
        print("Seed completed: strategy_dim, strategy_template (+ legs, params, characteristics).")
        return 0
    except Exception as e:
        conn.rollback()
        print(f"Seed failed: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
