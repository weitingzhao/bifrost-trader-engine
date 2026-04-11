#!/usr/bin/env python3
"""Refresh PostgreSQL schema via persistence postgres ddl._ensure_tables (CREATE IF NOT EXISTS + indexes).

Use an empty database or recreate objects as needed; this script does not migrate existing tables.

Strategy templates: ``python scripts/db_init/seed_structure_type_config.py`` after refresh.

Usage:
  python scripts/db_refresh_schema.py [--config PATH] [--no-color]
  python scripts/db_refresh_schema.py --prod
  python scripts/db_refresh_schema.py --dev

Config resolution (when ``--config`` is omitted) matches ``run_server`` / ``run_engine``:
``BIFROST_CONFIG``, first positional YAML path, ``--prod`` / ``--dev`` / ``--env``,
``BIFROST_ENV``, then ``config/config.{dev|prod}.yaml`` if present, else ``config/config.yaml``,
else ``config/config.yaml.example``.
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

# Expected schema objects by category (canonical list for reporting / presence check only).
# Actual DDL is defined in src/persistence/postgres/ddl.py::_ensure_tables — this dict does NOT limit what gets created.
# Naming: category "account" = account snapshot tables only; tables named account_* that belong to
# executions / commissions / splits are listed under "execution".
# NOTE: `account_executions`, `account_executions_final`, and `account_executions_fly` are VIEWs.
EXPECTED_TABLES_BY_CATEGORY: Dict[str, List[str]] = {
    "account": [
        "account",
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
    "execution": [
        "account_execution_commissions",
        "account_execution_instance_allocation",
        "account_execution_option_stock_link",
        "account_executions",
        "account_executions_final",
        "account_executions_fly",
        "executions_raw_flex",
        "executions_raw_journal",
        "executions_raw_tws",
    ],
    "gate_safety": [
        "gate_safety_guard",
        "gate_safety_intent",
        "gate_safety_state",
        "gate_safety_strategy",
        "gate_safety_strategy_earnings_dates",
    ],
    "job": ["job_bars_backfill", "job_ticker_reference_state"],
    "option": ["option_contracts", "option_day", "option_min", "option_snapshots"],
    "preference": [
        "preference_market_streams_symbol_order",
        "preference_position_categories",
        "preference_position_category_tags",
    ],
    "reference": ["reference_us_holidays"],
    "settings": ["settings", "settings_ib_flex"],
    "stock": [
        "stock_day",
        "stock_min",
        "tickers",
        "ticker_overview",
        "ticker_types",
        "ticker_related_tickers",
    ],
    "strategy": [
        "strategy_allocation",
        "strategy_allocation_opportunity",
        "strategy_dim",
        "strategy_history",
        "strategy_instance",
        "strategy_opportunity",
        "strategy_opportunity_entry_condition",
        "strategy_opportunity_symbol",
        "strategy_structure",
        "strategy_structure_constraint",
        "strategy_structure_leg",
        "strategy_structure_meta",
        "strategy_template",
        "strategy_template_characteristic",
        "strategy_template_leg",
        "strategy_template_param",
    ],
    "watchlist": ["watchlist"],
}

# Category order is alphabetical.
CATEGORY_ORDER = sorted(EXPECTED_TABLES_BY_CATEGORY.keys())

# Table -> category (for logging during _ensure_tables)
TABLE_TO_CATEGORY: Dict[str, str] = {
    t: cat for cat, tables in EXPECTED_TABLES_BY_CATEGORY.items() for t in tables
}

# ANSI colors: stderr TTY, or FORCE_COLOR/CLICOLOR_FORCE; disabled by --no-color or NO_COLOR (https://no-color.org/).
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
    if no_color:
        return False
    if os.environ.get("NO_COLOR", "").strip():
        return False
    if os.environ.get("FORCE_COLOR", "").strip() or os.environ.get("CLICOLOR_FORCE", "").strip():
        return True
    return hasattr(sys.stderr, "isatty") and sys.stderr.isatty()


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
    parser = argparse.ArgumentParser(
        description="Refresh PostgreSQL schema for status (aligned with DATABASE.md)."
    )
    parser.add_argument(
        "--config",
        default=None,
        metavar="PATH",
        help="YAML config (must contain postgres). If omitted, same rules as run_server: "
        "BIFROST_CONFIG, positional path, --prod/--dev/--env, BIFROST_ENV, config.dev.yaml / config.yaml.",
    )
    parser.add_argument("--no-color", action="store_true", help="Disable colored output")
    args, argv_remainder = parser.parse_known_args(sys.argv[1:])
    no_color = args.no_color

    if args.config:
        config_path = args.config
        if not os.path.isabs(config_path):
            config_path = str(_PROJECT_ROOT / config_path)
        config_path = str(Path(config_path).resolve())
    else:
        from src.app.config import resolve_startup_config_path

        config_path, _ = resolve_startup_config_path(str(_PROJECT_ROOT), argv_remainder)

    if not Path(config_path).exists():
        print(f"{_c(no_color, RED, 'Config not found:')} {config_path}", file=sys.stderr)
        return 1

    try:
        import yaml
        import psycopg2
        from src.persistence.postgres.ddl import _ensure_tables
        from src.persistence.postgres.connection import _get_conn_params
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

    _progress(f"Using config: {config_path}", no_color)
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

        def log_table_by_category(table_name: str, purpose: str) -> None:
            cat = TABLE_TO_CATEGORY.get(table_name, "other")
            if cat not in tables_by_category:
                tables_by_category[cat] = []
            tables_by_category[cat].append((table_name, purpose))

        def step_log(msg: str) -> None:
            _step(msg, no_color)

        _ensure_tables(conn, log=step_log, log_table=log_table_by_category)
        conn.commit()

        # Print DDL touched objects grouped by category in alphabetical order.
        print("", file=sys.stderr)
        print(_c(no_color, BOLD + GREEN, "═══ DDL touch log (alphabetical) ═══"), file=sys.stderr)
        for i, cat in enumerate(CATEGORY_ORDER, start=1):
            items = sorted(tables_by_category.get(cat, []), key=lambda x: x[0])
            if not items:
                continue
            _step(f"Category {i}. {cat}", no_color)
            for table_name, purpose in items:
                _log_table(table_name, purpose, no_color)

        total_expected = sum(len(tables) for tables in EXPECTED_TABLES_BY_CATEGORY.values())
        total_present = 0
        missing_all: List[str] = []

        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT c.relname, c.relkind
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = current_schema()
                  AND c.relkind IN ('r', 'v', 'p')
                """
            )
            relkind_map = {r[0]: r[1] for r in cur.fetchall()}

        print("", file=sys.stderr)
        print(_c(no_color, BOLD + GREEN, "═══ Schema refreshed ═══"), file=sys.stderr)
        print(_c(no_color, DIM, f"Database: {dbname!r}"), file=sys.stderr)
        print("", file=sys.stderr)
        for i, cat in enumerate(CATEGORY_ORDER, start=1):
            expected_list = EXPECTED_TABLES_BY_CATEGORY.get(cat, [])
            expected_count = len(expected_list)
            present_list = [t for t in expected_list if t in relkind_map]
            present_count = len(present_list)
            total_present += present_count
            missing = [t for t in expected_list if t not in relkind_map]
            missing_all.extend(missing)

            if expected_count == 0:
                continue
            cat_header = _c(no_color, BOLD + CYAN, f"  {i:2}. {cat}")
            line = f"{cat_header}: {expected_count} table(s) in category"
            if present_count == expected_count:
                line += _c(no_color, GREEN, f", {present_count} present")
            else:
                line += _c(no_color, YELLOW, f", {present_count} present")
                if missing:
                    line += _c(no_color, RED, f", {len(missing)} missing ({', '.join(missing)})")
            def _relkind_label(k: Optional[str]) -> str:
                if k == "v":
                    return "view"
                if k == "p":
                    return "partitioned"
                return "table"

            detail = ", ".join(
                f"{name}[{_relkind_label(relkind_map.get(name))}]"
                for name in sorted(present_list)
            )
            if detail:
                line += f"  {_c(no_color, DIM, '--')} {detail}"
            print(line, file=sys.stderr)

        others = [name for name, _ in tables_by_category.get("other", [])]
        if others:
            print(
                f"     {_c(no_color, DIM, 'other')}: {len(others)} object(s)  -- {', '.join(sorted(others))}",
                file=sys.stderr,
            )

        print("", file=sys.stderr)
        sep = _c(no_color, BOLD, "────────────────────────────────────────")
        print(sep, file=sys.stderr)
        total_line = _c(no_color, BOLD, "  Total: ")
        total_line += _c(no_color, CYAN, f"{total_expected}")
        total_line += " object(s) expected, "
        total_line += _c(no_color, GREEN, f"{total_present}")
        total_line += " object(s) present."
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
