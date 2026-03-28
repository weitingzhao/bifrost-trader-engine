#!/usr/bin/env python3
"""Fetch a single IB Flex Trades report using Host token and a given Query ID.

Use this to verify that the Flex API returns data for Query ID 1428383 (or another ID)
with the token stored in Settings (or passed via env). Run from project root.

Usage:
  python scripts/check/ib/flex_pull_primary.py [QUERY_ID]
  python scripts/check/ib/flex_pull_primary.py 1428383 --last-365
  python scripts/check/ib/flex_pull_primary.py 1428383 --mimic-web
  python scripts/check/ib/flex_pull_primary.py 1428383 --from-date 20250307 --to-date 20260306

  QUERY_ID     Default: 1428383.
  --last-365   Use Flex period p=5 (Last 365 Calendar Days). Does not send fd/td.
  --mimic-web  Use fd/td like web download: from_date=today-365, to_date=today (yyyyMMdd). Same as XML fromDate/toDate.
  --from-date  Start date yyyyMMdd (requires --to-date; max 366 days). Pass exact dates to match web XML (e.g. 20250307 20260306).
  --to-date    End date yyyyMMdd (requires --from-date).
  --token      Override: use this token instead of reading from DB.
  --config     Config path for postgres when reading token from DB.

If token is not provided and DB has no token, set IB_FLEX_HOST_TOKEN in the environment.
"""

from __future__ import annotations

import argparse
import os
import sys
from datetime import date, timedelta
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Pull Host IB Flex Trades report by Query ID using Host token."
    )
    parser.add_argument(
        "query_id",
        nargs="?",
        default="1428383",
        help="Flex Query ID (default: 1428383)",
    )
    parser.add_argument(
        "--token",
        default=os.environ.get("IB_FLEX_HOST_TOKEN", "").strip(),
        help="Flex token (default: from IB_FLEX_HOST_TOKEN or DB settings)",
    )
    parser.add_argument(
        "--config",
        default="config/config.yaml",
        help="Config path for postgres when reading token from DB",
    )
    parser.add_argument(
        "--last-365",
        action="store_true",
        help="Use Flex period p=5 (Last 365 Calendar Days)",
    )
    parser.add_argument(
        "--mimic-web",
        action="store_true",
        help="Use fd/td like web download: from=today-365, to=today (same as XML fromDate/toDate)",
    )
    parser.add_argument(
        "--from-date",
        default="",
        metavar="yyyyMMdd",
        help="Start date (requires --to-date; max 366 days range)",
    )
    parser.add_argument(
        "--to-date",
        default="",
        metavar="yyyyMMdd",
        help="End date (requires --from-date)",
    )
    args = parser.parse_args()
    query_id = (args.query_id or "1428383").strip()
    token = (args.token or "").strip()

    # Resolve token from DB if not provided
    if not token:
        config_path = args.config
        if not os.path.isabs(config_path):
            config_path = str(_PROJECT_ROOT / config_path)
        if Path(config_path).exists():
            try:
                import yaml
                import psycopg2
                from psycopg2.extras import RealDictCursor
                from src.persistence.postgres.connection import _get_conn_params
            except ImportError as e:
                print(f"Missing dependency: {e}", file=sys.stderr)
                return 1
            with open(config_path, "r", encoding="utf-8") as f:
                config = yaml.safe_load(f) or {}
            if config.get("postgres") or os.environ.get("PGHOST"):
                try:
                    params = _get_conn_params(config)
                    conn = psycopg2.connect(**params)
                    with conn.cursor(cursor_factory=RealDictCursor) as cur:
                        cur.execute(
                            "SELECT ib_flex_host_token FROM settings WHERE id = 1"
                        )
                        row = cur.fetchone()
                    conn.close()
                    if row and row.get("ib_flex_host_token"):
                        token = (row["ib_flex_host_token"] or "").strip()
                except Exception as e:
                    print(f"DB read failed: {e}", file=sys.stderr)
            else:
                print("No postgres in config and no PGHOST. Use --token or set IB_FLEX_HOST_TOKEN.", file=sys.stderr)
                return 1
        else:
            print("No config file. Use --token or set IB_FLEX_HOST_TOKEN.", file=sys.stderr)
            return 1

    if not token:
        print("Token is empty. Configure in Settings → IB Connection → Flex (Host token) or pass --token.", file=sys.stderr)
        return 1

    # Date range: --last-365 = p=5; --mimic-web = fd/td (today-365 .. today); or explicit --from-date + --to-date
    from_date = None
    to_date = None
    use_period_5 = False
    today_ymd = date.today().strftime("%Y%m%d")
    if args.last_365:
        use_period_5 = True
        print("Using Flex period p=5 (Last 365 Calendar Days), no fd/td.", file=sys.stderr)
    elif args.mimic_web:
        end = date.today()
        start = end - timedelta(days=365)
        from_date = start.strftime("%Y%m%d")
        to_date = end.strftime("%Y%m%d")
        print("Mimic web: fd/td = today-365 .. today (%s .. %s)" % (from_date, to_date), file=sys.stderr)
    elif (args.from_date or "").strip() and (args.to_date or "").strip():
        from_date = (args.from_date or "").strip()
        to_date = (args.to_date or "").strip()
        # Allow exact dates (e.g. 20250307 20260306 to match web XML); no clamp so user can match download
        print("Date range (explicit): %s .. %s" % (from_date, to_date), file=sys.stderr)
    else:
        print("No date range (using Flex query default period).", file=sys.stderr)

    print("Query ID: %s" % query_id, file=sys.stderr)
    print("Token: %s..." % (token[:8] if len(token) > 8 else "***"), file=sys.stderr)
    if use_period_5:
        print("Calling Flex SendRequest (p=5, Last 365 Calendar Days)...", file=sys.stderr, flush=True)
    elif from_date and to_date:
        print("Calling Flex SendRequest (fd=%s, td=%s)..." % (from_date, to_date), file=sys.stderr, flush=True)
    else:
        print("Calling Flex SendRequest (no date range, use query default)...", file=sys.stderr, flush=True)

    try:
        from src.connector.flex_client import request_report, get_statement, parse_trades_xml
    except ImportError as e:
        print("Import error: %s" % e, file=sys.stderr)
        return 1

    try:
        if use_period_5:
            ref = request_report(token, query_id, period=5)
        else:
            ref = request_report(token, query_id, from_date=from_date, to_date=to_date)
        print(f"SendRequest OK. ReferenceCode: {ref}", file=sys.stderr, flush=True)
        print("Calling GetStatement...", file=sys.stderr, flush=True)
        body = get_statement(token, ref)
        print(f"GetStatement OK. Response length: {len(body)} chars", file=sys.stderr, flush=True)
        rows = parse_trades_xml(body)
        print(f"Parsed Trades: {len(rows)} row(s)", file=sys.stderr)
        if rows:
            print("\nFirst 3 trades (summary):", file=sys.stderr)
            for i, r in enumerate(rows[:3]):
                print(f"  [{i+1}] {r.get('symbol')} {r.get('side')} {r.get('quantity')} @ {r.get('price')}  time={r.get('time')} account={r.get('account_id')}", file=sys.stderr)
        else:
            print("No trades in report (report may be Cash Transactions or empty date range).", file=sys.stderr)
        # Machine-readable summary to stdout
        print(f"OK\t{ref}\t{len(rows)}")
        return 0
    except ValueError as e:
        print(f"Flex error: {e}", file=sys.stderr)
        print(f"FAIL\t{e}")
        return 1
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        print(f"FAIL\t{e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
