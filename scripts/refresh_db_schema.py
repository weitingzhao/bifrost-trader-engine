#!/usr/bin/env python3
"""刷新 status 用 PostgreSQL 库表结构（与 PostgreSQLSink._ensure_tables 一致，见 docs/DATABASE.md）。

创建或补齐表：status_current、status_history、operations、daemon_control、daemon_run_status、
daemon_heartbeat、settings、accounts、account_positions、instrument_prices、account_executions、
account_execution_commissions、stock_day、stock_min、option_day、option_min、watchlist。
不再创建 ohlc_bars（已弃用）。从项目根目录执行。

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


def _progress(msg: str) -> None:
    """Print progress to stderr and flush so it appears immediately (e.g. when blocking on lock)."""
    print(f"[schema] {msg}", file=sys.stderr, flush=True)


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
        from src.sink.postgres_sink import _ensure_tables, _get_conn_params
    except ImportError as e:
        print(f"Missing dependency: {e}", file=sys.stderr)
        print("  Install with: pip install -e .  (or pip install pyyaml psycopg2-binary)", file=sys.stderr)
        return 1

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    pg = config.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        print("postgres or PGHOST required. Configure postgres in config.", file=sys.stderr)
        return 1
    params = _get_conn_params(config)
    params["connect_timeout"] = 10
    dbname = params["dbname"]

    _progress("Connecting to PostgreSQL...")
    conn = None
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        print(f"PostgreSQL connect failed: {e}", file=sys.stderr)
        return 1
    _progress("Connected. Setting lock_timeout=20s, statement_timeout=60s.")

    # Make timeouts session-level and commit them immediately so _ensure_tables()'s
    # initial rollback will not clear them.
    try:
        with conn.cursor() as cur:
            cur.execute("SET lock_timeout = '20s'")
            cur.execute("SET statement_timeout = '60s'")
        conn.commit()
    except Exception as e:
        print(f"Setting lock_timeout failed: {e}", file=sys.stderr)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            conn = None
        return 1

    try:
        _progress("Running _ensure_tables (see step logs below; if it hangs, last step is where lock is held).")
        _ensure_tables(conn, log=_progress)
        conn.commit()
        tables_list = (
            "status_current, status_history, operations, daemon_control, "
            "daemon_run_status, daemon_heartbeat, settings, accounts, account_positions, "
            "instrument_prices, account_executions, account_execution_commissions, "
            "stock_day, stock_min, option_day, option_min, watchlist, bars_backfill_jobs, "
            "position_categories, position_category_tags, us_market_holidays"
        )
        print(f"Schema refreshed in database {dbname!r}.")
        print(f"  Tables: {tables_list}")
        return 0
    except Exception as e:
        err = str(e).strip()
        if "lock_timeout" in err or "timeout" in err.lower():
            print(
                "Schema refresh timed out (another backend is holding locks).\n"
                "  Stop the API server, daemon, and bars worker; or run: python scripts/release_pg_locks.py [--yes]",
                file=sys.stderr,
            )
        print(f"Schema refresh failed: {e}", file=sys.stderr)
        return 1
    finally:
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
            try:
                conn.close()
            except Exception:
                pass
            _progress("Connection closed.")


if __name__ == "__main__":
    sys.exit(main())
