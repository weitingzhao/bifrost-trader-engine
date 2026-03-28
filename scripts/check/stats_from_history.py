#!/usr/bin/env python3
"""R-H2 history stats: read-only daemon_auto_status_history, daemon_auto_operations; daily/weekly hedge counts and PnL.

Does not run FSM/Guard/StateClassifier; offline OK; no daemon required.
Data matches phase-1 sink writes to those tables.

Usage:
  python scripts/check/stats_from_history.py [--config PATH] [--format json|text] [--days N]
  --config  Path to config (default config/config.yaml)
  --format  json or text (default text)
  --days    Last N days (default 30; 0 = all)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


def _load_config(config_path: str) -> Optional[dict]:
    """Load YAML config."""
    try:
        import yaml
    except ImportError:
        print("Missing dependency: pip install pyyaml", file=sys.stderr)
        return None
    path = Path(config_path)
    if not path.is_absolute():
        path = _PROJECT_ROOT / path
    if not path.exists():
        print(f"Config not found: {path}", file=sys.stderr)
        return None
    with open(path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    return config


def _connect(status_config: dict):
    """Connect to PostgreSQL using root postgres config."""
    try:
        import psycopg2
        from psycopg2.extras import RealDictCursor
        from src.persistence.postgres.connection import _get_conn_params
    except ImportError as e:
        print(f"Missing dependency: {e}", file=sys.stderr)
        print("  Install with: pip install -e .  (or pip install psycopg2-binary)", file=sys.stderr)
        return None, None
    pg = status_config.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        print("postgres or PGHOST required.", file=sys.stderr)
        return None, None
    params = _get_conn_params(status_config)
    try:
        conn = psycopg2.connect(**params)
        return conn, RealDictCursor
    except Exception as e:
        print(f"PostgreSQL connect failed: {e}", file=sys.stderr)
        return None, None


def run_stats(
    conn,
    cursor_factory,
    days: int = 30,
) -> Dict[str, Any]:
    """Read daemon_auto_status_history and daemon_auto_operations; aggregate daily/weekly hedge counts and PnL.

    Returns dict with:
      - daily_hedge_counts: [{date, fill_count, hedge_intent_count, total}, ...]
      - weekly_hedge_counts: [{week_start, fill_count, hedge_intent_count, total}, ...]
      - daily_pnl: [{date, daily_pnl, snapshot_count}, ...]  (from daemon_auto_status_history last snapshot per day)
      - summary: {total_fills, total_hedge_intents, total_daily_pnl, ...}
    """
    out: Dict[str, Any] = {
        "daily_hedge_counts": [],
        "weekly_hedge_counts": [],
        "daily_pnl": [],
        "summary": {},
    }
    with conn.cursor(cursor_factory=cursor_factory) as cur:
        # Time filter: ts is Unix timestamp (double precision)
        time_filter = ""
        params: List[Any] = []
        if days > 0:
            # 最近 N 天的起始 ts
            from datetime import timedelta
            cutoff = datetime.now(timezone.utc) - timedelta(days=days)
            cutoff_ts = cutoff.timestamp()
            time_filter = " WHERE ts >= %s"
            params.append(cutoff_ts)

        # 1. 按日对冲次数（daemon_auto_operations: fill 与 hedge_intent）
        cur.execute(
            f"""
            SELECT
                date_trunc('day', to_timestamp(ts))::date AS d,
                COUNT(*) FILTER (WHERE type = 'fill') AS fill_count,
                COUNT(*) FILTER (WHERE type = 'hedge_intent') AS intent_count,
                COUNT(*) AS total
            FROM daemon_auto_operations{time_filter}
            GROUP BY date_trunc('day', to_timestamp(ts))::date
            ORDER BY d DESC
            LIMIT 500
            """,
            params if time_filter else [],
        )
        rows = cur.fetchall()
        for r in rows:
            d = r.get("d")
            if d:
                date_str = d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)
                out["daily_hedge_counts"].append({
                    "date": date_str,
                    "fill_count": int(r.get("fill_count") or 0),
                    "hedge_intent_count": int(r.get("intent_count") or 0),
                    "total": int(r.get("total") or 0),
                })

        # 2. 按周对冲次数
        cur.execute(
            f"""
            SELECT
                date_trunc('week', to_timestamp(ts))::date AS w,
                COUNT(*) FILTER (WHERE type = 'fill') AS fill_count,
                COUNT(*) FILTER (WHERE type = 'hedge_intent') AS intent_count,
                COUNT(*) AS total
            FROM daemon_auto_operations{time_filter}
            GROUP BY date_trunc('week', to_timestamp(ts))::date
            ORDER BY w DESC
            LIMIT 100
            """,
            params if time_filter else [],
        )
        rows = cur.fetchall()
        for r in rows:
            w = r.get("w")
            if w:
                week_str = w.strftime("%Y-%m-%d") if hasattr(w, "strftime") else str(w)
                out["weekly_hedge_counts"].append({
                    "week_start": week_str,
                    "fill_count": int(r.get("fill_count") or 0),
                    "hedge_intent_count": int(r.get("intent_count") or 0),
                    "total": int(r.get("total") or 0),
                })

        # 3. 按日盈亏（daemon_auto_status_history：每天取 ts 最大的一条的 daily_pnl）
        hist_filter = " WHERE h.ts >= %s" if time_filter else ""
        cur.execute(
            f"""
            WITH ranked AS (
                SELECT
                    date_trunc('day', to_timestamp(h.ts))::date AS d,
                    h.daily_pnl,
                    ROW_NUMBER() OVER (PARTITION BY date_trunc('day', to_timestamp(h.ts))::date ORDER BY h.ts DESC) AS rn
                FROM daemon_auto_status_history h{hist_filter}
            )
            SELECT d, daily_pnl,
                   (SELECT COUNT(*) FROM daemon_auto_status_history h2
                    WHERE date_trunc('day', to_timestamp(h2.ts))::date = ranked.d) AS snapshot_count
            FROM ranked
            WHERE rn = 1
            ORDER BY d DESC
            LIMIT 500
            """,
            params if time_filter else [],
        )
        rows = cur.fetchall()
        for r in rows:
            d = r.get("d")
            if d:
                date_str = d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)
                pnl = r.get("daily_pnl")
                out["daily_pnl"].append({
                    "date": date_str,
                    "daily_pnl": float(pnl) if pnl is not None else None,
                    "snapshot_count": int(r.get("snapshot_count") or 0),
                })

        # 4. 汇总
        cur.execute(
            f"""
            SELECT
                COUNT(*) FILTER (WHERE type = 'fill') AS total_fills,
                COUNT(*) FILTER (WHERE type = 'hedge_intent') AS total_intents,
                COUNT(*) AS total_ops
            FROM daemon_auto_operations{time_filter}
            """,
            params if time_filter else [],
        )
        sum_row = cur.fetchone()
        out["summary"]["total_fills"] = int(sum_row.get("total_fills") or 0)
        out["summary"]["total_hedge_intents"] = int(sum_row.get("total_intents") or 0)
        out["summary"]["total_operations"] = int(sum_row.get("total_ops") or 0)

        # 盈亏汇总：从 daily_pnl 已计算的数据再汇总（避免重复查）
        total_pnl = 0.0
        for item in out["daily_pnl"]:
            p = item.get("daily_pnl")
            if p is not None and isinstance(p, (int, float)):
                total_pnl += p
        out["summary"]["total_daily_pnl_sum"] = round(total_pnl, 2)
        out["summary"]["days_with_pnl"] = len([x for x in out["daily_pnl"] if x.get("daily_pnl") is not None])

    return out


def format_text(data: Dict[str, Any]) -> str:
    """Format stats as human-readable text."""
    lines: List[str] = []
    lines.append("=== R-H2 history stats (read-only daemon_auto_status_history, daemon_auto_operations) ===")
    lines.append("")
    s = data.get("summary") or {}
    lines.append("[Summary]")
    lines.append(f"  Total fills: {s.get('total_fills', 0)}")
    lines.append(f"  Total hedge intents: {s.get('total_hedge_intents', 0)}")
    lines.append(f"  Total operations: {s.get('total_operations', 0)}")
    lines.append(f"  Days with PnL: {s.get('days_with_pnl', 0)}")
    lines.append(f"  Sum of daily_pnl: {s.get('total_daily_pnl_sum', 0)}")
    lines.append("")
    lines.append("[Daily hedge counts]")
    for item in (data.get("daily_hedge_counts") or [])[:14]:
        lines.append(f"  {item.get('date', '')}: fill={item.get('fill_count', 0)}, intent={item.get('hedge_intent_count', 0)}, total={item.get('total', 0)}")
    if not data.get("daily_hedge_counts"):
        lines.append("  (no data)")
    lines.append("")
    lines.append("[Weekly hedge counts]")
    for item in (data.get("weekly_hedge_counts") or [])[:8]:
        lines.append(f"  {item.get('week_start', '')}: fill={item.get('fill_count', 0)}, intent={item.get('hedge_intent_count', 0)}, total={item.get('total', 0)}")
    if not data.get("weekly_hedge_counts"):
        lines.append("  (no data)")
    lines.append("")
    lines.append("[Daily PnL (daily_pnl)]")
    for item in (data.get("daily_pnl") or [])[:14]:
        pnl = item.get("daily_pnl")
        pnl_str = f"{pnl:.2f}" if pnl is not None else "—"
        lines.append(f"  {item.get('date', '')}: {pnl_str} (snapshots={item.get('snapshot_count', 0)})")
    if not data.get("daily_pnl"):
        lines.append("  (no data)")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="R-H2 history stats: read-only daemon_auto_status_history, daemon_auto_operations; daily/weekly hedge counts and PnL summary."
    )
    parser.add_argument("--config", default="config/config.yaml", help="Path to config file")
    parser.add_argument("--format", choices=["json", "text"], default="text", help="Output format")
    parser.add_argument("--days", type=int, default=30, help="Last N days (0 = all)")
    args = parser.parse_args()

    status_config = _load_config(args.config)
    if not status_config:
        return 1

    conn, cursor_factory = _connect(status_config)
    if conn is None:
        return 1

    try:
        data = run_stats(conn, cursor_factory, days=args.days)
        if args.format == "json":
            print(json.dumps(data, ensure_ascii=False, indent=2))
        else:
            print(format_text(data))
        return 0
    except Exception as e:
        print(f"Stats failed: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc()
        return 1
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
