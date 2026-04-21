"""Compare stock_day coverage against the global trading-day calendar derived from stock_day itself.

No external calendar library — reference set = DISTINCT bar_time WHERE source='massive' across all symbols.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional


def compute_stock_day_gap(
    cur: Any,
    symbol: str,
    lookback_years: int = 10,
) -> Dict[str, Any]:
    """Compare stock_day bar coverage for *symbol* against the global trading-day calendar.

    Gap logic:
      ref     = DISTINCT bar_time FROM stock_day WHERE source='massive'
                  AND bar_time >= NOW() - lookback_years (all symbols)
      covered = DISTINCT bar_time for this symbol in same window
      gap     = ref_total - covered_total

    Returns a dict compatible with StockDayGapResult (frontend).
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "symbol is required"}

    compared_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # ── Query A: ref total vs covered total ───────────────────────────────────
    cur.execute(
        """
        WITH ref AS (
          SELECT DISTINCT bar_time
          FROM stock_day
          WHERE source = 'massive'
            AND bar_time >= CURRENT_DATE - (%(years)s || ' years')::interval
        ),
        covered AS (
          SELECT DISTINCT bar_time
          FROM stock_day
          WHERE source = 'massive'
            AND UPPER(TRIM(symbol)) = %(symbol)s
            AND bar_time >= CURRENT_DATE - (%(years)s || ' years')::interval
        )
        SELECT
          (SELECT COUNT(*) FROM ref)::bigint     AS ref_total,
          (SELECT COUNT(*) FROM covered)::bigint AS covered_total
        """,
        {"years": lookback_years, "symbol": sym},
    )
    row = cur.fetchone()
    ref_total = int(row[0] or 0) if row else 0
    covered_total = int(row[1] or 0) if row else 0

    has_rows = covered_total > 0

    if ref_total == 0:
        return {
            "ok": True,
            "symbol": sym,
            "has_rows": has_rows,
            "ref_total": 0,
            "covered_total": covered_total,
            "gap": 0,
            "coverage_pct": 100.0 if covered_total == 0 else None,
            "missing_by_year": [],
            "compared_at": compared_at,
            "message": "No stock_day rows with source='massive' in the database yet.",
        }

    gap = ref_total - covered_total
    coverage_pct: Optional[float]
    if ref_total > 0:
        coverage_pct = round(100.0 * covered_total / ref_total, 1)
    else:
        coverage_pct = 100.0

    # ── Query B: missing by year ───────────────────────────────────────────────
    cur.execute(
        """
        WITH ref AS (
          SELECT DISTINCT bar_time
          FROM stock_day
          WHERE source = 'massive'
            AND bar_time >= CURRENT_DATE - (%(years)s || ' years')::interval
        ),
        covered AS (
          SELECT DISTINCT bar_time
          FROM stock_day
          WHERE source = 'massive'
            AND UPPER(TRIM(symbol)) = %(symbol)s
            AND bar_time >= CURRENT_DATE - (%(years)s || ' years')::interval
        )
        SELECT
          EXTRACT(YEAR FROM r.bar_time)::int AS year,
          COUNT(*)::bigint                   AS count,
          MIN(r.bar_time)::text              AS first_missing,
          MAX(r.bar_time)::text              AS last_missing
        FROM ref r
        LEFT JOIN covered c USING (bar_time)
        WHERE c.bar_time IS NULL
        GROUP BY year
        ORDER BY year DESC
        """,
        {"years": lookback_years, "symbol": sym},
    )
    missing_by_year: List[Dict[str, Any]] = []
    for yr_row in (cur.fetchall() or []):
        missing_by_year.append(
            {
                "year": int(yr_row[0]),
                "count": int(yr_row[1]),
                "first_missing": str(yr_row[2])[:10] if yr_row[2] else None,
                "last_missing": str(yr_row[3])[:10] if yr_row[3] else None,
            }
        )

    return {
        "ok": True,
        "symbol": sym,
        "has_rows": has_rows,
        "ref_total": ref_total,
        "covered_total": covered_total,
        "gap": gap,
        "coverage_pct": coverage_pct,
        "missing_by_year": missing_by_year,
        "compared_at": compared_at,
    }


def compute_stock_day_quality_detail(
    cur: Any,
    symbol: str,
    days: int = 90,
) -> Dict[str, Any]:
    """Return per-day OHLC / volume / VWAP completeness for a symbol.

    Returns a dict compatible with StockDayQualityDetailResponse (frontend).
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "symbol": "", "latest_date": None, "daily": [], "error": "symbol is required"}

    cur.execute(
        """
        SELECT
          bar_time::text                                                        AS bar_date,
          CASE WHEN open IS NOT NULL AND high IS NOT NULL
                    AND low  IS NOT NULL AND close IS NOT NULL
               THEN 100.0 ELSE 0.0 END                                         AS ohlc_pct,
          CASE WHEN volume IS NOT NULL THEN 100.0 ELSE 0.0 END                 AS volume_pct,
          CASE WHEN vwap   IS NOT NULL THEN 100.0 ELSE 0.0 END                 AS vwap_pct
        FROM stock_day
        WHERE source = 'massive'
          AND UPPER(TRIM(symbol)) = %(symbol)s
          AND bar_time >= CURRENT_DATE - (%(days)s || ' days')::interval
        ORDER BY bar_time DESC
        LIMIT %(days)s
        """,
        {"symbol": sym, "days": days},
    )
    rows = cur.fetchall() or []

    daily = [
        {
            "bar_date": str(r[0])[:10],
            "ohlc_pct": float(r[1]) if r[1] is not None else None,
            "volume_pct": float(r[2]) if r[2] is not None else None,
            "vwap_pct": float(r[3]) if r[3] is not None else None,
        }
        for r in rows
    ]
    latest_date = daily[0]["bar_date"] if daily else None

    return {
        "ok": True,
        "symbol": sym,
        "latest_date": latest_date,
        "daily": daily,
    }
