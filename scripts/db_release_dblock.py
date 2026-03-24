#!/usr/bin/env python3
"""Diagnose and release PostgreSQL locks / idle-in-transaction backends.

Modes:
  (default)   Show backends holding locks on Phase 2 / settings / stock tables.
  --all       Show ALL backends in 'idle in transaction' state (full DB diagnostic).
  --dry-run   Only list, do not terminate.
  --yes       Skip confirmation and terminate all listed backends.

Usage:
  python scripts/db_release_dblock.py [--config PATH] [--all] [--yes] [--dry-run]
  python scripts/db_release_dblock.py --dev [--yes]          # config/config.dev.yaml
  python scripts/db_release_dblock.py --prod [--yes]         # config/config.prod.yaml
  python scripts/db_release_dblock.py --env prod [--yes]

Config resolution (when ``--config`` is omitted) matches ``run_server`` / ``db_refresh_schema.py``:
``BIFROST_CONFIG``, ``--prod`` / ``--dev`` / ``--env``, ``BIFROST_ENV``, then
``config/config.{dev|prod}.yaml``, ``config/config.yaml``, ``config/config.yaml.example``.
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


_TABLES = (
    "daemon_heartbeat",
    "daemon_auto_status_current",
    "daemon_control",
    "daemon_run_status",
    "settings",
    "stock_day",
    "stock_min",
)


def _load_config(config_path: str) -> dict:
    import yaml

    with open(config_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _conn_params_from_root_config(config: dict) -> dict:
    from src.sink.postgres_sink import _get_conn_params

    return _get_conn_params(config)


def _print_backend_row(r: tuple, *, show_relation: bool = True) -> None:
    if show_relation:
        pid, mode, granted, usename, app, state, query_start, *_ = r
        relname = r[10]
        granted_str = "holder" if granted else "waiter"
        print(f"  pid={pid}  {granted_str}  mode={mode}  relation={relname}")
    else:
        pid, usename, app, state, query_start, *_ = r
        age_sec = r[8]
        age_str = f"{int(age_sec)}s" if age_sec is not None else "?"
        print(f"  pid={pid}  state={state}  idle_for={age_str}")
    print(f"    user={usename}  app={app or '(none)'}  state={state}")
    if query_start:
        print(f"    query_start={query_start}")
    if show_relation:
        we_type_val, we_event_val = r[7], r[8]
    else:
        we_type_val, we_event_val = r[5], r[6]
    if we_type_val and we_event_val:
        print(f"    wait_event={we_type_val}.{we_event_val}")
    query_val = r[9] if show_relation else r[7]
    if query_val:
        print(f"    query: {query_val.strip()[:120]}")
    print()


def _query_table_locks(conn, my_pid: int) -> list:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT DISTINCT l.pid, l.mode, l.granted,
                   a.usename, a.application_name, a.state,
                   a.query_start, a.wait_event_type, a.wait_event,
                   left(a.query, 120) AS query,
                   c.relname AS relation
            FROM pg_locks l
            JOIN pg_stat_activity a ON l.pid = a.pid
            JOIN pg_class c ON l.relation = c.oid
            WHERE c.relname = ANY(%s)
              AND l.pid != %s
            ORDER BY l.granted DESC, l.pid
            """,
            (list(_TABLES), my_pid),
        )
        return cur.fetchall()


def _query_all_idle_in_transaction(conn, my_pid: int) -> list:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT a.pid,
                   a.usename, a.application_name, a.state,
                   a.query_start, a.wait_event_type, a.wait_event,
                   left(a.query, 120) AS query,
                   extract(epoch from (now() - a.state_change)) AS age_sec
            FROM pg_stat_activity a
            WHERE a.state = 'idle in transaction'
              AND a.pid != %s
            ORDER BY a.state_change ASC
            """,
            (my_pid,),
        )
        return cur.fetchall()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Diagnose and release PostgreSQL locks / idle-in-transaction backends."
    )
    parser.add_argument(
        "--config",
        default=None,
        metavar="PATH",
        help="YAML config with postgres block. If omitted, same rules as run_server / db_refresh_schema.py.",
    )
    parser.add_argument("--yes", "-y", action="store_true", help="Skip confirmation, terminate all listed backends")
    parser.add_argument("--dry-run", action="store_true", help="Only list backends, do not terminate")
    parser.add_argument("--all", action="store_true", help="Show ALL idle-in-transaction backends (full diagnostic)")
    args, argv_remainder = parser.parse_known_args(sys.argv[1:])

    if args.config:
        config_path = args.config
        if not os.path.isabs(config_path):
            config_path = str(_PROJECT_ROOT / config_path)
        config_path = str(Path(config_path).resolve())
    else:
        from src.app.config import resolve_startup_config_path

        config_path, _ = resolve_startup_config_path(str(_PROJECT_ROOT), argv_remainder)

    if not Path(config_path).exists():
        print(f"Config not found: {config_path}", file=sys.stderr)
        return 1

    try:
        import psycopg2
    except ImportError:
        print("Missing psycopg2. Install with: pip install -e .", file=sys.stderr)
        return 1

    config = _load_config(config_path)
    pg = config.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        print(
            "postgres block required in config (or set PGHOST). "
            f"Try: python scripts/db_release_dblock.py --dev   (uses config/config.dev.yaml if present)\n"
            f"  Resolved config path was: {config_path}",
            file=sys.stderr,
        )
        return 1

    try:
        from src.app.config import config_profile_from_resolved_path

        profile = config_profile_from_resolved_path(config_path)
    except ImportError:
        profile = None
    print(f"Using config: {config_path}" + (f"  (profile: {profile})" if profile else ""), file=sys.stderr)

    params = _conn_params_from_root_config(config)
    params["connect_timeout"] = 10

    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        print(f"PostgreSQL connect failed: {e}", file=sys.stderr)
        return 1

    my_pid = conn.get_backend_pid()

    try:
        if args.all:
            rows = _query_all_idle_in_transaction(conn, my_pid)
        else:
            rows = _query_table_locks(conn, my_pid)
    except Exception as e:
        print(f"Query failed: {e}", file=sys.stderr)
        conn.close()
        return 1

    show_relation = not args.all

    if not rows:
        if args.all:
            print("No backends in 'idle in transaction' state.")
        else:
            print("No other backends holding or waiting for locks on Phase 2 tables / settings / stock_day / stock_min.")
        conn.close()
        return 0

    if args.all:
        print(f"All idle-in-transaction backends ({len(rows)}):")
    else:
        print("Backends with locks on Phase 2 tables + settings + stock_day/stock_min (excluding this script):")
    print("-" * 100)
    pids_to_terminate = []
    for r in rows:
        pid = r[0]
        pids_to_terminate.append(pid)
        _print_backend_row(r, show_relation=show_relation)
    print("-" * 100)

    if args.dry_run:
        print("Dry-run: not terminating any backend.")
        conn.close()
        return 0

    pids_to_terminate = sorted(set(pids_to_terminate))
    if not args.yes:
        try:
            ans = input(f"Terminate {len(pids_to_terminate)} backend(s) above? [y/N]: ").strip().lower()
        except EOFError:
            ans = "n"
        if ans not in ("y", "yes"):
            print("Aborted.")
            conn.close()
            return 0

    terminated = []
    failed = []
    for pid in pids_to_terminate:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_terminate_backend(%s)", (pid,))
                ok = cur.fetchone()[0]
            if ok:
                terminated.append(pid)
                print(f"Terminated backend pid={pid}")
            else:
                failed.append(pid)
        except Exception as e:
            failed.append(pid)
            print(f"Failed to terminate pid={pid}: {e}", file=sys.stderr)
    conn.close()

    if failed:
        print(f"Terminated: {terminated}; failed: {failed}", file=sys.stderr)
        return 1
    print(f"Done. Terminated {len(terminated)} backend(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
