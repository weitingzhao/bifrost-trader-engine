#!/usr/bin/env python3
"""Phase 1 self-check: verify sink config, schema, and optional signal handling.

Aligns with PLAN_NEXT_STEPS.md stage 1 Test Case list (TC-1-R-M1a-*, TC-1-R-M4a-*,
TC-1-R-H1-*, TC-1-R-C1a-*). Run from project root.

Phase 1 scope is "status sink + minimal control" (sink config, PG schema, SIGTERM).
IB connector is runtime environment, not a Phase 1 deliverable, so it is not run by
default. Use --check-ib to verify TWS/Gateway connectivity when available.

Usage:
  python scripts/check/phase1.py [--config PATH] [--skip-db] [--signal-test] [--check-ib]
  --config       Config file (default: config/config.yaml)
  --skip-db      Skip PostgreSQL connection and schema checks
  --signal-test  Spawn daemon, send SIGTERM, assert exit within 10s (needs runnable env)
  --check-ib     Connect to IB TWS/Gateway per config (needs TWS/Gateway running)
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
import traceback
import time
from pathlib import Path

# Project root (scripts/check/ -> scripts/ -> project root)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


# ANSI colors (only when stdout is a TTY)
def _color(s: str, code: str) -> str:
    if sys.stdout.isatty():
        return f"\033[{code}m{s}\033[0m"
    return s


PASS_STR = _color("PASS", "32")   # green
SKIP_STR = _color("SKIP", "33")   # yellow
FAIL_STR = _color("FAIL", "31")   # red
CATEGORY_WIDTH = 12  # align [Config], [PostgreSQL], etc.


# Required columns per docs/DATABASE.md §2
STATUS_CURRENT_COLS = {
    "id", "daemon_state", "trading_state", "symbol", "spot", "bid", "ask",
    "net_delta", "stock_position", "option_legs_count", "daily_hedge_count",
    "daily_pnl", "data_lag_ms", "config_summary", "ts",
}
STATUS_HISTORY_COLS = STATUS_CURRENT_COLS  # same as status_current per DATABASE.md §2.2
OPERATIONS_COLS = {"id", "ts", "type", "side", "quantity", "price", "state_reason"}

SCHEMA_FIX_TIP = " Run: python scripts/init_phase1_db.py to create/repair tables (see docs/DATABASE.md)."


def _fail_msg(exc: BaseException, prefix: str = "") -> str:
    """One-line summary plus optional traceback for debugging."""
    msg = f"{prefix}{exc!r}".strip()
    return msg


def _fail_with_traceback(exc: BaseException, prefix: str = "", verbose: bool = False) -> str:
    """Summary; if verbose, append full traceback."""
    msg = _fail_msg(exc, prefix)
    if verbose:
        msg += "\n" + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    return msg


def check_config(config_path: str, verbose: bool = False) -> tuple[bool, str]:
    """TC-1-R-H1-3: when status.sink=postgres, connection params must be present."""
    try:
        import yaml
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
    except Exception as e:
        return False, _fail_with_traceback(e, "Config load: ", verbose)
    status = config.get("status") or {}
    sink = status.get("sink")
    if not sink:
        return True, "ok (sink disabled)"
    if sink != "postgres":
        return False, f"status.sink must be 'postgres' (got {sink!r})"
    pg = status.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        return False, "status.postgres or PGHOST required when sink=postgres"
    return True, "ok"


def check_sink_interface(verbose: bool = False) -> tuple[bool, str]:
    """TC-1-R-M1a-3 / R-M4a-2: StatusSink and snapshot/operation keys match DATABASE.md."""
    try:
        # Import from package; PostgreSQLSink is lazy so no psycopg2 needed for this check
        from src.sink import StatusSink, SNAPSHOT_KEYS, OPERATION_KEYS
    except Exception as e:
        return False, _fail_with_traceback(e, "Import sink: ", verbose)
    required_snapshot = STATUS_CURRENT_COLS - {"id"}
    if set(SNAPSHOT_KEYS) != required_snapshot:
        return False, f"SNAPSHOT_KEYS mismatch: want {required_snapshot}, got {set(SNAPSHOT_KEYS)}"
    if set(OPERATION_KEYS) != OPERATIONS_COLS - {"id"}:
        return False, f"OPERATION_KEYS mismatch: want {OPERATIONS_COLS - {'id'}}, got {set(OPERATION_KEYS)}"
    if not hasattr(StatusSink, "write_snapshot") or not hasattr(StatusSink, "write_operation"):
        return False, "StatusSink missing write_snapshot or write_operation"
    return True, "ok"


def check_pg_schema(config_path: str, verbose: bool = False) -> tuple[bool, str]:
    """TC-1-R-M1a-2/3, R-M4a-3, R-H1-1: PostgreSQL tables exist with required columns."""
    try:
        import yaml
        import psycopg2
    except ImportError as e:
        interp = getattr(sys, "executable", "python")
        hint = (
            f"Missing dependency in this Python: {interp}\n"
            "  Install with:  pip install -e .   (or:  pip install psycopg2-binary )\n"
            "  If you use a venv/conda env, run that pip for the same environment you run this script with."
        )
        return False, f"{hint}\n  Error: {e}"
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
        status = config.get("status") or {}
        pg = status.get("postgres") or {}
        # Database: prefer config (support database, Database, db) then env then default
        db_from_config = pg.get("database") or pg.get("Database") or pg.get("db")
        if not db_from_config and pg:
            for k, v in pg.items():
                if k and isinstance(v, str) and v.strip() and k.strip().lower() in ("database", "db"):
                    db_from_config = v.strip()
                    break
        dbname = db_from_config or os.environ.get("PGDATABASE") or "bifrost"
        db_source = "config" if db_from_config else ("PGDATABASE" if os.environ.get("PGDATABASE") else "default")
        params = {
            "host": pg.get("host") or os.environ.get("PGHOST", "127.0.0.1"),
            "port": int(pg.get("port") or os.environ.get("PGPORT", "5432")),
            "dbname": dbname,
            "user": pg.get("user") or os.environ.get("PGUSER", "bifrost"),
            "password": pg.get("password") or os.environ.get("PGPASSWORD", ""),
            "connect_timeout": 3,
        }
        if verbose and pg:
            print(f"  [PostgreSQL]  (verbose) status.postgres keys: {list(pg.keys())}, database from config: {db_from_config!r}")
        # So user can see why DBeaver works but script fails (e.g. different database name)
        print(f"  [PostgreSQL]  DB: config={config_path!s}, host={params['host']}, database={params['dbname']!r} ({db_source}), user={params['user']!r}")
        conn = psycopg2.connect(**params)
    except Exception as e:
        err_msg = str(e)
        hint = ""
        if "pg_hba.conf" in err_msg and "database" in err_msg:
            hint = (
                "\n  Tip: This script uses the database name from config (status.postgres.database) or PGDATABASE. "
                "If DBeaver uses a different database (e.g. options_db), ensure your config has that same database, "
                "or set PGDATABASE=options_db when running this script."
            )
        return False, _fail_with_traceback(e, "PostgreSQL connect: ", verbose) + hint

    try:
        with conn.cursor() as cur:
            for table, required in (
                ("status_current", STATUS_CURRENT_COLS),
                ("status_history", STATUS_HISTORY_COLS),
                ("operations", OPERATIONS_COLS),
            ):
                cur.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = %s ORDER BY ordinal_position
                    """,
                    (table,),
                )
                found = {r[0] for r in cur.fetchall()}
                if not found:
                    return False, f"Table {table!r} missing or empty columns.{SCHEMA_FIX_TIP}"
                missing = required - found
                if missing:
                    return False, f"Table {table!r} missing columns: {missing}.{SCHEMA_FIX_TIP}"
        return True, "ok"
    finally:
        conn.close()


def check_signal_exit(config_path: str, timeout_start: float = 5.0, timeout_exit: float = 10.0) -> tuple[bool, str]:
    """TC-1-R-C1a-1: daemon exits within seconds on SIGTERM."""
    run_engine = _PROJECT_ROOT / "scripts" / "run_engine.py"
    if not run_engine.exists():
        return False, "scripts/run_engine.py not found"
    proc = subprocess.Popen(
        [sys.executable, str(run_engine), config_path],
        cwd=str(_PROJECT_ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        time.sleep(min(2.0, timeout_start))
        if proc.poll() is not None:
            return False, "Daemon exited before SIGTERM (check IB/config)"
        proc.terminate()
        try:
            proc.wait(timeout=timeout_exit)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            return False, f"Daemon did not exit within {timeout_exit}s of SIGTERM"
        # Exit 0 or -SIGTERM (e.g. 143 on many platforms)
        if proc.returncode not in (0, -15, 143, 124):
            stderr = (proc.stderr.read() or "")[-500:]
            return False, f"Unexpected exit code {proc.returncode} (stderr tail: {stderr!r})"
        return True, "ok"
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def check_ib_connector(config_path: str, timeout: float = 10.0, verbose: bool = False) -> tuple[bool, str]:
    """Optional: connect to IB TWS/Gateway per config. Requires TWS/Gateway running."""
    try:
        import yaml
        from src.connector.ib import IBConnector
    except ImportError as e:
        return False, _fail_with_traceback(e, "Import: ", verbose)
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    ib_cfg = config.get("ib", {}) or {}
    host = ib_cfg.get("host", "127.0.0.1")
    port = int(ib_cfg.get("port", 4001))
    client_id = int(ib_cfg.get("client_id", 1))

    async def _connect_and_disconnect() -> tuple[bool, str]:
        connector = IBConnector(
            host=host,
            port=port,
            client_id=client_id,
            connect_timeout=timeout,
        )
        try:
            ok = await connector.connect()
            if not ok:
                return False, "connect() returned False"
            await connector.disconnect()
            return True, "ok"
        except Exception as e:
            return False, _fail_msg(e, "IB connect: ")

    try:
        ok, msg = asyncio.run(_connect_and_disconnect())
        return ok, msg
    except Exception as e:
        return False, _fail_with_traceback(e, "IB check: ", verbose)


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 1 self-check (TC-1-*).")
    parser.add_argument("--config", default="config/config.yaml", help="Config path")
    parser.add_argument("--skip-db", action="store_true", help="Skip PostgreSQL schema check")
    parser.add_argument("--signal-test", action="store_true", help="Run daemon and test SIGTERM exit")
    parser.add_argument("--check-ib", action="store_true", help="Connect to IB TWS/Gateway (needs TWS/Gateway running)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print full traceback on failure")
    args = parser.parse_args()
    verbose = args.verbose
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    if not Path(config_path).exists():
        config_path = str(_PROJECT_ROOT / "config" / "config.yaml.example")

    # (category, description, ok, msg)
    results: list[tuple[str, str, bool | None, str]] = []

    # 1. Config
    ok, msg = check_config(config_path, verbose=verbose)
    results.append(("Config", "status.sink + postgres", ok, msg))

    # 2. Sink interface
    ok, msg = check_sink_interface(verbose=verbose)
    results.append(("Sink", "SNAPSHOT/OPERATION keys", ok, msg))

    # 3. PostgreSQL schema (optional)
    if not args.skip_db:
        ok, msg = check_pg_schema(config_path, verbose=verbose)
        results.append(("PostgreSQL", "tables + columns", ok, msg))
    else:
        results.append(("PostgreSQL", "tables + columns", None, "skipped (--skip-db)"))

    # 4. Signal test (optional)
    if args.signal_test:
        ok, msg = check_signal_exit(config_path)
        results.append(("Signal", "SIGTERM → daemon exit", ok, msg))
    else:
        results.append(("Signal", "SIGTERM → daemon exit", None, "optional; use --signal-test to run"))

    # 5. IB connector (optional; runtime env, not Phase 1 deliverable)
    if args.check_ib:
        ok, msg = check_ib_connector(config_path, timeout=10.0, verbose=verbose)
        results.append(("IB", "TWS/Gateway connect", ok, msg))
    else:
        results.append(("IB", "TWS/Gateway connect", None, "optional; use --check-ib to run (needs TWS/Gateway)"))

    # Report: category prefix + colored PASS/SKIP/FAIL
    all_required_ok = True
    for category, description, ok, msg in results:
        pad = " " * max(0, CATEGORY_WIDTH - len(category) - 2)  # [Category] + padding
        if ok is True:
            print(f"  [{category}]{pad}  {PASS_STR}  {description}")
        elif ok is False:
            print(f"  [{category}]{pad}  {FAIL_STR}  {description}: {msg}")
            all_required_ok = False
        else:
            print(f"  [{category}]{pad}  {SKIP_STR}  {description}: {msg}")
    if not all_required_ok and not verbose:
        print("\nTip: run with -v/--verbose to see full error tracebacks.")
    if all_required_ok:
        print("\nPhase 1 self-check: required checks passed.")
        if not args.signal_test or not args.check_ib:
            opts = []
            if not args.signal_test:
                opts.append("--signal-test")
            if not args.check_ib:
                opts.append("--check-ib")
            if opts:
                print(f"  (Optional: run with {' '.join(opts)} to verify signal exit / IB connectivity.)")
        return 0
    print("\nPhase 1 self-check: some checks failed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
