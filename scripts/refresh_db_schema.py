#!/usr/bin/env python3
"""刷新 status 用 PostgreSQL 库表结构（与 PostgreSQLSink._ensure_tables 一致，见 docs/DATABASE.md）。

创建或补齐表：status_current、status_history、operations、daemon_control、daemon_run_status、
daemon_heartbeat、settings、accounts、account_positions。账户数据仅存于 accounts / account_positions，
status_current、status_history 不含 account 相关列。从项目根目录执行。

Usage:
  python scripts/refresh_db_schema.py [--config PATH]
  --config  配置文件路径（默认 config/config.yaml）
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


def main() -> int:
    parser = argparse.ArgumentParser(description="刷新 status 用 PostgreSQL 库表结构（与 DATABASE.md 一致）。")
    parser.add_argument("--config", default="config/config.yaml", help="配置文件路径")
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
        from src.sink.postgres_sink import _ensure_tables
    except ImportError as e:
        print(f"Missing dependency: {e}", file=sys.stderr)
        print("  Install with: pip install -e .  (or pip install pyyaml psycopg2-binary)", file=sys.stderr)
        return 1

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    status = config.get("status") or {}
    pg = status.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        print("status.postgres or PGHOST required. Configure status.sink and status.postgres in config.", file=sys.stderr)
        return 1

    db_from_config = pg.get("database") or pg.get("Database") or pg.get("db")
    if not db_from_config and pg:
        for k, v in pg.items():
            if k and isinstance(v, str) and v.strip() and k.strip().lower() in ("database", "db"):
                db_from_config = v.strip()
                break
    dbname = db_from_config or os.environ.get("PGDATABASE", "bifrost")
    params = {
        "host": pg.get("host") or os.environ.get("PGHOST", "127.0.0.1"),
        "port": int(pg.get("port") or os.environ.get("PGPORT", "5432")),
        "dbname": dbname,
        "user": pg.get("user") or os.environ.get("PGUSER", "bifrost"),
        "password": pg.get("password") or os.environ.get("PGPASSWORD", ""),
        "connect_timeout": 10,
    }

    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        print(f"PostgreSQL connect failed: {e}", file=sys.stderr)
        return 1

    try:
        _ensure_tables(conn)
        conn.commit()
        tables_list = (
            "status_current, status_history, operations, daemon_control, "
            "daemon_run_status, daemon_heartbeat, settings, accounts, account_positions"
        )
        print(f"Schema refreshed in database {dbname!r}.")
        print(f"  Tables: {tables_list}")
        return 0
    except Exception as e:
        print(f"Schema refresh failed: {e}", file=sys.stderr)
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
