#!/usr/bin/env python3
"""Force-release PostgreSQL locks on daemon_heartbeat (and related Phase 2 tables).

Use when daemon_heartbeat (or status_current, daemon_control) appears locked and
normal operation is blocked. Finds backends holding or waiting for locks on these
tables and terminates them (pg_terminate_backend). Run from project root.

Usage:
  python scripts/release_pg_locks.py [--config PATH] [--yes]
  --config   Config file (default: config/config.yaml)
  --yes      Skip confirmation and terminate all listed backends
  --dry-run  Only list locking backends, do not terminate
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


# Tables we care about (Phase 2 single-row or hot tables)
_TABLES = ("daemon_heartbeat", "status_current", "daemon_control", "daemon_run_status")


def _load_config(config_path: str) -> tuple[dict, dict]:
    import yaml
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    status = config.get("status") or {}
    pg = status.get("postgres") or {}
    return config, pg


def _conn_params(pg: dict) -> dict:
    from src.sink.postgres_sink import _get_conn_params
    return _get_conn_params({"postgres": pg})


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Release PostgreSQL locks on daemon_heartbeat and related tables."
    )
    parser.add_argument("--config", default="config/config.yaml", help="Config path")
    parser.add_argument("--yes", "-y", action="store_true", help="Skip confirmation, terminate all listed backends")
    parser.add_argument("--dry-run", action="store_true", help="Only list backends, do not terminate")
    args = parser.parse_args()

    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    if not Path(config_path).exists():
        print(f"Config not found: {config_path}", file=sys.stderr)
        return 1

    try:
        import psycopg2
    except ImportError:
        print("Missing psycopg2. Install with: pip install -e .", file=sys.stderr)
        return 1

    _, pg = _load_config(config_path)
    if not pg and not os.environ.get("PGHOST"):
        print("status.postgres or PGHOST required in config.", file=sys.stderr)
        return 1

    params = _conn_params(pg)
    params["connect_timeout"] = 10

    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        print(f"PostgreSQL connect failed: {e}", file=sys.stderr)
        return 1

    my_pid = conn.get_backend_pid()

    try:
        with conn.cursor() as cur:
            # Backends that have a lock on any of our tables (granted or waiting)
            cur.execute(
                """
                SELECT DISTINCT l.pid, l.mode, l.granted,
                       a.usename, a.application_name, a.state,
                       a.query_start, a.wait_event_type, a.wait_event,
                       left(a.query, 80) AS query,
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
            rows = cur.fetchall()
    except Exception as e:
        print(f"Query failed: {e}", file=sys.stderr)
        conn.close()
        return 1

    if not rows:
        print("No other backends holding or waiting for locks on daemon_heartbeat / status_current / daemon_control / daemon_run_status.")
        conn.close()
        return 0

    print("Backends with locks on Phase 2 tables (excluding this script):")
    print("-" * 100)
    pids_to_terminate = []
    for r in rows:
        pid, mode, granted, usename, app, state, query_start, we_type, we_event, query, relname = r
        pids_to_terminate.append(pid)
        granted_str = "holder" if granted else "waiter"
        print(f"  pid={pid}  {granted_str}  mode={mode}  relation={relname}")
        print(f"    user={usename}  app={app or '(none)'}  state={state}")
        if query_start:
            print(f"    query_start={query_start}")
        if we_type and we_event:
            print(f"    wait_event={we_type}.{we_event}")
        if query:
            print(f"    query: {query.strip()[:100]}...")
        print()
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
