#!/usr/bin/env python3
"""Refresh PostgreSQL schema (aligned with PostgreSQLSink._ensure_tables, see docs/DATABASE.md).

Tables are applied in batches by category. Run from project root.

Usage:
  python scripts/db_refresh_schema.py [--config PATH]
  --config  Config file path (default config/config.yaml)
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)

# Category order (1–12). Tables are reported in this order.
CATEGORY_ORDER = [
    "account",
    "contract",
    "daemon",
    "gate_safety",
    "job",
    "option",
    "preference",
    "reference",
    "settings",
    "stock",
    "strategy",
    "watchlist",
]

# Expected 38 tables by category (canonical list). Used to report counts and missing tables.
EXPECTED_TABLES_BY_CATEGORY: Dict[str, List[str]] = {
    "account": [
        "account",
        "account_execution_commissions",
        "account_executions",
        "account_positions",
        "account_transactions",
    ],
    "contract": ["contract_quote_live"],
    "daemon": [
        "daemon_auto_operations",
        "daemon_auto_status_current",
        "daemon_auto_status_history",
        "daemon_control",
        "daemon_heartbeat",
        "daemon_open_orders",
        "daemon_run_status",
    ],
    "gate_safety": [
        "gate_safety_guard",
        "gate_safety_intent",
        "gate_safety_state",
        "gate_safety_strategy",
        "gate_safety_strategy_earnings_dates",
    ],
    "job": ["job_bars_backfill"],
    "option": ["option_contracts", "option_day", "option_min", "option_snapshots"],
    "preference": [
        "preference_market_streams_symbol_order",
        "preference_position_categories",
        "preference_position_category_tags",
    ],
    "reference": ["reference_us_holidays"],
    "settings": ["settings", "settings_ib_flex"],
    "stock": ["stock_day", "stock_min", "stocks"],
    "strategy": [
        "strategy_allocation",
        "strategy_allocation_opportunity",
        "strategy_history",
        "strategy_instance",
        "strategy_opportunity",
        "strategy_opportunity_entry_condition",
        "strategy_opportunity_symbol",
        "strategy_structure",
        "strategy_structure_constraint",
        "strategy_structure_leg",
        "strategy_structure_meta",
        "strategy_structure_type",
        "strategy_structure_type_leg",
        "strategy_structure_subtype",
        "strategy_structure_subtype_characteristic",
        "strategy_structure_subtype_meta_param",
        "strategy_structure_subtype_rule",
    ],
    "watchlist": ["watchlist"],
}

# Table -> category (for logging during _ensure_tables)
TABLE_TO_CATEGORY: Dict[str, str] = {
    t: cat for cat, tables in EXPECTED_TABLES_BY_CATEGORY.items() for t in tables
}

# ANSI colors (only applied when stderr is a TTY or when USE_COLOR is set)
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
CYAN = "\033[36m"
MAGENTA = "\033[35m"
BLUE = "\033[34m"


def _color_enabled(no_color: bool) -> bool:
    return not no_color and hasattr(sys.stderr, "isatty") and sys.stderr.isatty()


def _c(no_color: bool, code: str, text: str) -> str:
    """Wrap text in ANSI color if color is enabled."""
    return f"{code}{text}{RESET}" if _color_enabled(no_color) else text


def _progress(msg: str, no_color: bool = False) -> None:
    """Script-level progress (connect, run, close)."""
    tag = _c(no_color, BOLD + BLUE, "[refresh]")
    print(f"{tag} {msg}", file=sys.stderr, flush=True)


def _step(msg: str, no_color: bool = False) -> None:
    """DDL section / step (e.g. which group of tables is being processed)."""
    tag = _c(no_color, BOLD + MAGENTA, "[step]")
    print(f"{tag} {_c(no_color, CYAN, msg)}", file=sys.stderr, flush=True)


def _log_table(table_name: str, purpose: str, no_color: bool = False) -> None:
    """One line per table: name and short purpose."""
    tag = _c(no_color, DIM, "[table]")
    name = _c(no_color, GREEN, table_name)
    print(f"  {tag}   {name}  {_c(no_color, DIM, '--')} {purpose}", file=sys.stderr, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="刷新 status 用 PostgreSQL 库表结构（与 DATABASE.md 一致）。")
    parser.add_argument("--config", default="config/config.yaml", help="配置文件路径")
    parser.add_argument("--no-color", action="store_true", help="Disable colored output")
    args = parser.parse_args()
    no_color = args.no_color
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    if not Path(config_path).exists():
        print(f"{_c(no_color, RED, 'Config not found:')} {config_path}", file=sys.stderr)
        return 1

    try:
        import yaml
        import psycopg2
        from src.sink.postgres_sink import _ensure_tables, _get_conn_params
    except ImportError as e:
        print(f"{_c(no_color, RED, 'Missing dependency:')} {e}", file=sys.stderr)
        print("  Install with: pip install -e .  (or pip install pyyaml psycopg2-binary)", file=sys.stderr)
        return 1

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    pg = config.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        print(_c(no_color, RED, "postgres or PGHOST required. Configure postgres in config."), file=sys.stderr)
        return 1
    params = _get_conn_params(config)
    params["connect_timeout"] = 10
    dbname = params["dbname"]

    _progress("Connecting to PostgreSQL...", no_color)
    conn = None
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        print(f"{_c(no_color, RED, 'PostgreSQL connect failed:')} {e}", file=sys.stderr)
        return 1
    _progress("Connected. Setting lock_timeout=20s, statement_timeout=60s.", no_color)

    # Make timeouts session-level and commit them immediately so _ensure_tables()'s
    # initial rollback will not clear them.
    try:
        with conn.cursor() as cur:
            cur.execute("SET lock_timeout = '20s'")
            cur.execute("SET statement_timeout = '60s'")
        conn.commit()
    except Exception as e:
        print(f"{_c(no_color, RED, 'Setting lock_timeout failed:')} {e}", file=sys.stderr)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
            conn = None
        return 1

    try:
        _progress("Running _ensure_tables (if it hangs, the last table in progress holds the lock).", no_color)
        tables_by_category: Dict[str, List[Tuple[str, str]]] = {c: [] for c in CATEGORY_ORDER}
        last_cat: List[Optional[str]] = [None]

        def step_for_category(cat: str) -> None:
            idx = CATEGORY_ORDER.index(cat) + 1 if cat in CATEGORY_ORDER else 0
            label = f"{idx}. {cat}" if idx else cat
            _step(f"Category {label}", no_color)

        def flush_category(cat: str) -> None:
            items = tables_by_category.get(cat, [])
            if not items:
                return
            step_for_category(cat)
            for table_name, purpose in items:
                _log_table(table_name, purpose, no_color)

        def log_table_by_category(table_name: str, purpose: str) -> None:
            cat = TABLE_TO_CATEGORY.get(table_name, "other")
            if cat not in tables_by_category:
                tables_by_category[cat] = []
            if last_cat[0] is not None and cat != last_cat[0]:
                flush_category(last_cat[0])
            tables_by_category[cat].append((table_name, purpose))
            last_cat[0] = cat

        def step_log(msg: str) -> None:
            _step(msg, no_color)

        _ensure_tables(conn, log=step_log, log_table=log_table_by_category)
        if last_cat[0] is not None:
            flush_category(last_cat[0])
        conn.commit()

        total_expected = sum(len(tables) for tables in EXPECTED_TABLES_BY_CATEGORY.values())
        total_updated = 0
        missing_all: List[str] = []

        print("", file=sys.stderr)
        print(_c(no_color, BOLD + GREEN, "═══ Schema refreshed ═══"), file=sys.stderr)
        print(_c(no_color, DIM, f"Database: {dbname!r}"), file=sys.stderr)
        print("", file=sys.stderr)
        for i, cat in enumerate(CATEGORY_ORDER, start=1):
            expected_list = EXPECTED_TABLES_BY_CATEGORY.get(cat, [])
            expected_count = len(expected_list)
            updated_list = [name for name, _ in tables_by_category.get(cat, [])]
            updated_count = len(updated_list)
            total_updated += updated_count
            missing = [t for t in expected_list if t not in updated_list]
            missing_all.extend(missing)

            if expected_count == 0:
                continue
            cat_header = _c(no_color, BOLD + CYAN, f"  {i:2}. {cat}")
            line = f"{cat_header}: {expected_count} table(s) in category"
            if updated_count == expected_count:
                line += _c(no_color, GREEN, f", {updated_count} updated")
                line += f"  {_c(no_color, DIM, '--')} {', '.join(updated_list)}"
            else:
                line += _c(no_color, YELLOW, f", {updated_count} updated")
                if missing:
                    line += _c(no_color, RED, f", {len(missing)} missing ({', '.join(missing)})")
                line += f"  {_c(no_color, DIM, '--')} updated: {', '.join(updated_list)}"
            print(line, file=sys.stderr)

        others = [name for name, _ in tables_by_category.get("other", [])]
        if others:
            total_updated += len(others)
            print(f"     {_c(no_color, DIM, 'other')}: {len(others)} table(s)  -- {', '.join(others)}", file=sys.stderr)

        print("", file=sys.stderr)
        sep = _c(no_color, BOLD, "────────────────────────────────────────")
        print(sep, file=sys.stderr)
        total_line = _c(no_color, BOLD, "  Total: ")
        total_line += _c(no_color, CYAN, f"{total_expected}")
        total_line += " table(s) expected, "
        total_line += _c(no_color, GREEN, f"{total_updated}")
        total_line += " table(s) updated."
        print(total_line, file=sys.stderr)
        if missing_all:
            print(_c(no_color, RED, f"  Missing ({len(missing_all)}): ") + ", ".join(missing_all), file=sys.stderr)
        print(sep, file=sys.stderr)
        return 0
    except Exception as e:
        err = str(e).strip()
        if "lock_timeout" in err or "timeout" in err.lower():
            print(
                _c(no_color, YELLOW, "Schema refresh timed out (another backend is holding locks)."),
                file=sys.stderr,
            )
            print("  Stop the API server, daemon, and bars worker; or run: python scripts/db_release_dblock.py [--yes]", file=sys.stderr)
        print(f"{_c(no_color, RED + BOLD, 'Schema refresh failed:')} {e}", file=sys.stderr)
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
        _progress("Connection closed.", no_color)


if __name__ == "__main__":
    sys.exit(main())
