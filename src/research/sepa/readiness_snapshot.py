"""SEPA universe + stock_day readiness snapshot (shared by Research API and scripts)."""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

import psycopg2
from psycopg2.extras import RealDictCursor

from src.persistence.postgres.connection import _get_conn_params

logger = logging.getLogger(__name__)

# SEPA Data Ready Step 3 (per-symbol stock_day backfill check): symbols that need attention.
# Primary: cache_stock_snapshot.last_minute_updated → NY calendar date vs max(stock_day.bar_time)
# for source=massive (all history). Raw vendor date gap: vendor_day > last_bar_max (or no bars).
# Then clear vendor gap if latest massive daily close matches cache.session_close (abs diff < eps).
# If session_close is NULL on the snapshot row, skip **all** snapshot-driven gap checks for that symbol
# (no vendor gap, no readiness fallback — stock_day / price_ready are ignored for Step 3 gaps).
# No row in cache_stock_snapshot for a symbol: never a gap (ignore stock_day / readiness for that symbol).
# Exclude tickers.instrument_type = 'WARRANT' (case-insensitive) from all gaps.
# Fallback when snapshot row exists, session_close and last_minute_updated semantics apply:
# last_minute_updated NULL only then NOT price_ready on v_sepa_symbol_price_readiness (or no p row);
# still excluding warrants. session_close must be non-null (same as vendor path).
# Close "equality" uses absolute tolerance (same as SQL) — see _STOCK_DAY_GAP_CLOSE_MATCH_ABS_EPS.
_STOCK_DAY_GAP_CLOSE_MATCH_ABS_EPS = 0.0001

# Fast-path lookback window for the latest massive daily bar via LATERAL + partition prune.
# Most actively-traded tickers have a bar within a few trading days; 90 calendar days is a
# comfortable headroom and prunes ~60 monthly partitions to ~3-4 per probe.
_STOCK_DAY_GAP_LATEST_BAR_LOOKBACK_DAYS = 90

# SEPA Data Ready Step 3 — two-stage CTE pipeline.
#   1. cand_fast  : MATERIALIZED 90-day LATERAL probe per snap symbol (hot path; ~12k rows).
#   2. older_lookup: MATERIALIZED full-history LATERAL only for symbols where the fast probe
#      returned NULL (cold path; typically <100 rows), so SPAC units / thinly traded tickers
#      whose latest bar is older than 90 days are still considered.
#   3. cand       : combine via COALESCE(recent, older) and evaluate vendor / fallback gap.
# `MATERIALIZED` is essential here so the small `older_lookup` set is computed once on the
# pre-filtered subset; without it the planner inlines the LATERAL into every reference and
# the query degrades to whole-table scans.
_STOCK_DAY_VENDOR_GAP_CANDIDATE_SQL = f"""
cand_fast AS MATERIALIZED (
    SELECT
        u.symbol,
        c.last_minute_updated,
        c.session_close,
        recent.bt AS last_bar_max_recent,
        recent.cl AS last_bar_day_close_recent
    FROM public.v_sepa_us_equity_universe u
    JOIN public.cache_stock_snapshot c
        ON c.symbol = u.symbol
       AND c.session_close IS NOT NULL
    LEFT JOIN LATERAL (
        SELECT sd.bar_time::date AS bt, sd.close AS cl
        FROM public.stock_day sd
        WHERE sd.symbol = c.symbol
          AND sd.source = 'massive'
          AND sd.bar_time >= (CURRENT_DATE - integer '{_STOCK_DAY_GAP_LATEST_BAR_LOOKBACK_DAYS}')::date
        ORDER BY sd.bar_time DESC NULLS LAST
        LIMIT 1
    ) recent ON true
    WHERE lower(coalesce(u.instrument_type, '')) <> 'warrant'
),
older_lookup AS MATERIALIZED (
    SELECT s.symbol, dl.bt AS last_bar_max_older, dl.cl AS last_bar_day_close_older
    FROM (SELECT symbol FROM cand_fast WHERE last_bar_max_recent IS NULL) s
    LEFT JOIN LATERAL (
        SELECT sd.bar_time::date AS bt, sd.close AS cl
        FROM public.stock_day sd
        WHERE sd.symbol = s.symbol
          AND sd.source = 'massive'
        ORDER BY sd.bar_time DESC NULLS LAST
        LIMIT 1
    ) dl ON true
),
fallback_p AS MATERIALIZED (
    SELECT
        sd.symbol,
        count(*)::integer AS bar_rows,
        min(sd.bar_time)::date AS first_bar_date,
        max(sd.bar_time)::date AS last_bar_date,
        count(*) FILTER (WHERE sd.close IS NULL)::integer AS null_close_rows,
        count(*) FILTER (WHERE sd.volume IS NULL)::integer AS null_volume_rows,
        (
            count(*) >= 240
            AND max(sd.bar_time) >= (CURRENT_DATE - integer '7')::date
            AND count(*) FILTER (WHERE sd.close IS NULL) = 0
            AND count(*) FILTER (WHERE sd.volume IS NULL) = 0
        ) AS price_ready
    FROM public.stock_day sd
    JOIN public.cache_stock_snapshot fc
      ON fc.symbol = sd.symbol
     AND fc.session_close IS NOT NULL
     AND fc.last_minute_updated IS NULL
    WHERE sd.source = 'massive'
      AND sd.bar_time >= (CURRENT_DATE - integer '420')::date
      AND sd.bar_time <= CURRENT_DATE
    GROUP BY sd.symbol
),
cand AS (
    SELECT
        cf.symbol,
        cf.last_minute_updated,
        (cf.last_minute_updated AT TIME ZONE 'America/New_York')::date AS vendor_day,
        COALESCE(cf.last_bar_max_recent, ol.last_bar_max_older) AS last_bar_max,
        COALESCE(cf.last_bar_day_close_recent, ol.last_bar_day_close_older) AS last_bar_day_close,
        cf.session_close,
        COALESCE(p.bar_rows, 0)::integer AS bar_rows,
        p.first_bar_date::text AS first_bar_date,
        p.last_bar_date::text AS last_bar_date,
        COALESCE(p.null_close_rows, 0)::integer AS null_close_rows,
        COALESCE(p.null_volume_rows, 0)::integer AS null_volume_rows,
        p.price_ready,
        (
            cf.last_minute_updated IS NOT NULL
            AND (
                COALESCE(cf.last_bar_max_recent, ol.last_bar_max_older) IS NULL
                OR (cf.last_minute_updated AT TIME ZONE 'America/New_York')::date
                       > COALESCE(cf.last_bar_max_recent, ol.last_bar_max_older)
            )
            AND NOT (
                COALESCE(cf.last_bar_day_close_recent, ol.last_bar_day_close_older) IS NOT NULL
                AND abs(
                    COALESCE(cf.last_bar_day_close_recent, ol.last_bar_day_close_older)
                    - cf.session_close
                ) < {_STOCK_DAY_GAP_CLOSE_MATCH_ABS_EPS!s}
            )
        ) AS is_vendor_gap,
        (
            cf.last_minute_updated IS NULL
            AND (p.symbol IS NULL OR NOT COALESCE(p.price_ready, false))
        ) AS is_fallback_gap
    FROM cand_fast cf
    LEFT JOIN older_lookup ol ON ol.symbol = cf.symbol
    LEFT JOIN fallback_p p ON p.symbol = cf.symbol
)
""".strip()

# Shipped with GET /readiness/summary for UI: raw DB objects vs derived views/tables (English labels).
READINESS_DATA_CATALOG: Dict[str, Any] = {
    "raw_sources": [
        {
            "id": "tickers",
            "object": "public.tickers",
            "role": "Massive reference universe (All Tickers).",
            "typical_ingest": "Celery kind feed_stocks_tickers_reference_universe",
            "data_points": [
                "ticker",
                "name",
                "market",
                "locale",
                "primary_exchange",
                "instrument_type",
                "active",
                "delisted_utc",
                "cik",
                "composite_figi",
                "share_class_figi",
                "last_updated_utc",
            ],
        },
        {
            "id": "ticker_overview",
            "object": "public.ticker_overview",
            "role": "Per-ticker detail joined to tickers (sector, list_date, …).",
            "typical_ingest": "Celery kind feed_stocks_tickers_overview",
            "data_points": [
                "tickers_id (FK)",
                "sector",
                "industry",
                "exchange",
                "list_date",
                "ticker_root",
                "market_cap",
                "description",
                "overview_updated_at",
            ],
        },
        {
            "id": "stock_day",
            "object": "public.stock_day",
            "role": "Daily OHLCV bars; SEPA Phase1/CRS read source=massive.",
            "typical_ingest": "Celery kind feed_stocks_aggregate (and related)",
            "data_points": [
                "symbol",
                "bar_time",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "source",
                "vwap (optional)",
                "trade_count (optional)",
                "adjusted (optional)",
            ],
        },
        {
            "id": "research_sepa_fundamentals_cache",
            "object": "public.research_sepa_fundamentals_cache",
            "role": "Cached income-statement payload for SEPA fundamentals / Phase4.",
            "typical_ingest": "Written by SEPA Phase4 or fundamentals batch jobs",
            "data_points": [
                "symbol",
                "rule_version",
                "payload (jsonb: evaluation + rows)",
                "source",
                "fetched_at",
                "expire_at",
                "updated_at",
            ],
        },
        {
            "id": "cache_stock_snapshot",
            "object": "public.cache_stock_snapshot",
            "role": "Massive GET /v3/snapshot via ticker.any_of (no type param) — per-symbol session + last_minute baseline before stock_day backfill.",
            "typical_ingest": "POST /research/screening/sepa/readiness/stock-unified-snapshot",
            "data_points": [
                "symbol (PK)",
                "fetched_at",
                "updated_at",
                "last_minute_updated",
                "snapshot_asset_type",
                "market_status",
                "snapshot_display_name",
                "session_* OHLC/volume/change scalars",
                "last_minute_* bar scalars",
                "last_trade_* / last_quote_* scalars",
                "source",
            ],
        },
    ],
    "computed_layers": [
        {
            "id": "v_sepa_us_equity_universe",
            "object": "public.v_sepa_us_equity_universe",
            "role": "Filtered US equity candidate list from tickers + overview.",
            "depends_on": ["tickers", "ticker_overview"],
            "data_points": [
                "tickers_id",
                "symbol",
                "name",
                "market",
                "locale",
                "primary_exchange",
                "instrument_type",
                "active",
                "delisted_utc",
                "list_date",
                "sector",
                "industry",
            ],
        },
        {
            "id": "v_sepa_symbol_price_readiness",
            "object": "public.v_sepa_symbol_price_readiness",
            "role": "Per-symbol bar counts and price_ready over a fixed lookback window (live).",
            "depends_on": ["stock_day"],
            "data_points": [
                "as_of_date",
                "symbol",
                "price_source",
                "bar_rows",
                "first_bar_date",
                "last_bar_date",
                "null_close_rows",
                "null_volume_rows",
                "price_ready (boolean)",
            ],
        },
        {
            "id": "sepa_universe_readiness_daily",
            "object": "public.sepa_universe_readiness_daily",
            "role": "Materialized daily snapshot (UPSERT) combining universe + bars + optional fund cache hit.",
            "depends_on": [
                "v_sepa_us_equity_universe",
                "stock_day",
                "research_sepa_fundamentals_cache",
            ],
            "data_points": [
                "as_of_date",
                "symbol",
                "tickers_id",
                "universe_rule_version",
                "price_source",
                "included_in_universe",
                "bar_count_lookback",
                "first_bar_date",
                "last_bar_date",
                "null_close_rows",
                "null_volume_rows",
                "price_ready",
                "fund_cache_present",
                "fund_cache_expire_at",
                "notes",
                "computed_at",
            ],
        },
        {
            "id": "v_sepa_symbol_fund_cache_readiness",
            "object": "public.v_sepa_symbol_fund_cache_readiness",
            "role": "Symbols with non-expired fundamentals cache (optional view).",
            "depends_on": ["research_sepa_fundamentals_cache"],
            "data_points": [
                "symbol",
                "rule_version",
                "fund_cache_valid",
                "expire_at",
                "fetched_at",
            ],
        },
    ],
}

_ENSURE_FUND_CACHE_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS public.research_sepa_fundamentals_cache (
    symbol text NOT NULL,
    rule_version text NOT NULL,
    payload jsonb NOT NULL,
    source text DEFAULT 'massive',
    fetched_at timestamptz NOT NULL DEFAULT now(),
    expire_at timestamptz NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (symbol, rule_version)
)
"""

_ENSURE_FUND_CACHE_INDEX_SQL = """
CREATE INDEX IF NOT EXISTS idx_research_sepa_fund_cache_expire
ON public.research_sepa_fundamentals_cache (expire_at)
"""

_SNAPSHOT_INSERT_SQL = """
INSERT INTO public.sepa_universe_readiness_daily (
    as_of_date,
    symbol,
    tickers_id,
    universe_rule_version,
    price_source,
    included_in_universe,
    bar_count_lookback,
    first_bar_date,
    last_bar_date,
    null_close_rows,
    null_volume_rows,
    price_ready,
    fund_cache_present,
    fund_cache_expire_at,
    notes,
    computed_at
)
WITH params AS (
    SELECT
        CURRENT_DATE AS as_of_date,
        'v1'::text AS universe_rule_version,
        'massive'::text AS price_source,
        (CURRENT_DATE - integer '420') AS window_start,
        240::integer AS min_bar_rows,
        7::integer AS max_stale_calendar_days
),
u AS (
    SELECT v.tickers_id, v.symbol
    FROM public.v_sepa_us_equity_universe v
),
bars AS (
    SELECT
        p.as_of_date,
        upper(trim(sd.symbol)) AS symbol,
        p.price_source,
        count(*)::integer AS bar_rows,
        min(sd.bar_time)::date AS first_bar_date,
        max(sd.bar_time)::date AS last_bar_date,
        count(*) FILTER (WHERE sd.close IS NULL)::integer AS null_close_rows,
        count(*) FILTER (WHERE sd.volume IS NULL)::integer AS null_volume_rows
    FROM params p
    JOIN public.stock_day sd
        ON sd.source = p.price_source
       AND sd.bar_time >= p.window_start
       AND sd.bar_time <= p.as_of_date
    GROUP BY p.as_of_date, p.price_source, p.window_start, upper(trim(sd.symbol))
),
symbols AS (
    SELECT symbol FROM u
    UNION
    SELECT symbol FROM bars
)
SELECT
    p.as_of_date,
    s.symbol,
    u.tickers_id,
    p.universe_rule_version,
    p.price_source,
    (u.tickers_id IS NOT NULL) AS included_in_universe,
    coalesce(b.bar_rows, 0) AS bar_count_lookback,
    b.first_bar_date,
    b.last_bar_date,
    coalesce(b.null_close_rows, 0) AS null_close_rows,
    coalesce(b.null_volume_rows, 0) AS null_volume_rows,
    (
        coalesce(b.bar_rows, 0) >= p.min_bar_rows
        AND b.last_bar_date IS NOT NULL
        AND b.last_bar_date >= (
            p.as_of_date - (p.max_stale_calendar_days || ' days')::interval
        )::date
        AND coalesce(b.null_close_rows, 0) = 0
        AND coalesce(b.null_volume_rows, 0) = 0
    ) AS price_ready,
    (fc.symbol IS NOT NULL) AS fund_cache_present,
    fc.expire_at AS fund_cache_expire_at,
    CASE
        WHEN u.tickers_id IS NULL THEN 'symbol not in v_sepa_us_equity_universe'
        WHEN coalesce(b.bar_rows, 0) < p.min_bar_rows THEN 'insufficient stock_day rows in lookback window'
        WHEN b.last_bar_date IS NULL THEN 'no stock_day rows in window'
        WHEN b.last_bar_date < (
            p.as_of_date - (p.max_stale_calendar_days || ' days')::interval
        )::date THEN 'stale last bar_time'
        WHEN coalesce(b.null_close_rows, 0) > 0 OR coalesce(b.null_volume_rows, 0) > 0
            THEN 'null close or volume in window'
        ELSE NULL
    END AS notes,
    now() AS computed_at
FROM params p
CROSS JOIN symbols s
LEFT JOIN u ON u.symbol = s.symbol
LEFT JOIN bars b
    ON b.symbol = s.symbol
   AND b.as_of_date = p.as_of_date
   AND b.price_source = p.price_source
LEFT JOIN LATERAL (
    SELECT upper(trim(c.symbol)) AS symbol, c.expire_at
    FROM public.research_sepa_fundamentals_cache c
    WHERE upper(trim(c.symbol)) = s.symbol
      AND c.rule_version = 'sepa_fundamentals_v1'
      AND c.expire_at > now()
    LIMIT 1
) fc ON true
ON CONFLICT (as_of_date, symbol, universe_rule_version, price_source)
DO UPDATE SET
    tickers_id = EXCLUDED.tickers_id,
    included_in_universe = EXCLUDED.included_in_universe,
    bar_count_lookback = EXCLUDED.bar_count_lookback,
    first_bar_date = EXCLUDED.first_bar_date,
    last_bar_date = EXCLUDED.last_bar_date,
    null_close_rows = EXCLUDED.null_close_rows,
    null_volume_rows = EXCLUDED.null_volume_rows,
    price_ready = EXCLUDED.price_ready,
    fund_cache_present = EXCLUDED.fund_cache_present,
    fund_cache_expire_at = EXCLUDED.fund_cache_expire_at,
    notes = EXCLUDED.notes,
    computed_at = EXCLUDED.computed_at;
"""


def _db_ok(status_config: Optional[dict]) -> bool:
    if not status_config:
        return False
    return status_config.get("sink") == "postgres" or bool(status_config.get("postgres"))


def run_sepa_universe_readiness_snapshot(
    status_config: dict,
    *,
    statement_timeout_ms: int = 120_000,
) -> Dict[str, Any]:
    """Ensure fund cache table, then upsert today's sepa_universe_readiness_daily rows."""
    if not _db_ok(status_config):
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(status_config)
    params["connect_timeout"] = 15
    t0 = time.monotonic()
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        logger.warning("readiness snapshot connect failed: %s", e)
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor() as cur:
            cur.execute(f"SET statement_timeout = {int(max(5_000, statement_timeout_ms))}")
            cur.execute(_ENSURE_FUND_CACHE_TABLE_SQL)
            cur.execute(_ENSURE_FUND_CACHE_INDEX_SQL)
            cur.execute(_SNAPSHOT_INSERT_SQL)
            n = cur.rowcount
        conn.commit()
        elapsed_ms = int((time.monotonic() - t0) * 1000)
        return {"ok": True, "rows_affected": n, "elapsed_ms": elapsed_ms}
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        logger.warning("readiness snapshot failed: %s", e)
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


def _view_exists(conn, schema: str, name: str) -> bool:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT EXISTS (
                SELECT 1 FROM information_schema.views
                WHERE table_schema = %s AND table_name = %s
            )
            """,
            (schema, name),
        )
        row = cur.fetchone()
    return bool(row and row[0])


def fetch_sepa_readiness_summary(status_config: dict) -> Dict[str, Any]:
    """Aggregate counts for UI (live views + today's snapshot table)."""
    if not _db_ok(status_config):
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(status_config)
    params["connect_timeout"] = 15
    out: Dict[str, Any] = {"ok": True}
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # JIT helps long analytical queries but adds latency to short summary queries; disable per-session.
            try:
                cur.execute("SET LOCAL jit = off")
            except Exception:
                pass
            cur.execute("SELECT count(*)::bigint AS n FROM public.v_sepa_us_equity_universe")
            out["universe_count"] = int((cur.fetchone() or {}).get("n") or 0)

            # Tickers table counts and last-sync timestamp (Step 1 check)
            cur.execute(
                """
                SELECT
                    count(*)::bigint AS active_count,
                    max(updated_at)::text AS last_synced_at
                FROM public.tickers
                WHERE active = true AND locale = 'us' AND market = 'stocks'
                """
            )
            tr = cur.fetchone() or {}
            out["tickers_active_count"] = int(tr.get("active_count") or 0)
            out["tickers_last_synced_at"] = tr.get("last_synced_at")

            cur.execute(
                """
                SELECT
                    count(*)::bigint AS total,
                    count(*) FILTER (WHERE price_ready)::bigint AS price_ready
                FROM public.v_sepa_symbol_price_readiness
                """
            )
            pr = cur.fetchone() or {}
            out["price_readiness_live"] = {
                "total_symbols": int(pr.get("total") or 0),
                "price_ready": int(pr.get("price_ready") or 0),
            }

            fund_view = _view_exists(conn, "public", "v_sepa_symbol_fund_cache_readiness")
            out["fund_cache_view_exists"] = fund_view
            if fund_view:
                cur.execute(
                    """
                    SELECT count(*)::bigint AS n
                    FROM public.v_sepa_symbol_fund_cache_readiness
                    WHERE fund_cache_valid = true
                    """
                )
                out["fund_cache_valid_count"] = int((cur.fetchone() or {}).get("n") or 0)
            else:
                out["fund_cache_valid_count"] = None

            try:
                cur.execute(
                    """
                    SELECT count(*)::bigint AS n, max(fetched_at)::text AS mx
                    FROM public.cache_stock_snapshot
                    """
                )
                cr = cur.fetchone() or {}
                out["stock_unified_snapshot_row_count"] = int(cr.get("n") or 0)
                out["stock_unified_snapshot_last_fetched_at"] = cr.get("mx")
            except Exception:
                out["stock_unified_snapshot_row_count"] = None
                out["stock_unified_snapshot_last_fetched_at"] = None

            try:
                cur.execute(
                    f"""
                    WITH {_STOCK_DAY_VENDOR_GAP_CANDIDATE_SQL}
                    SELECT count(*)::bigint AS n
                    FROM cand
                    WHERE is_vendor_gap OR is_fallback_gap
                    """
                )
                out["stock_day_vendor_fill_gap_count"] = int((cur.fetchone() or {}).get("n") or 0)
            except Exception as e:
                logger.debug("stock_day_vendor_fill_gap_count query failed: %s", e)
                out["stock_day_vendor_fill_gap_count"] = None

            cur.execute(
                """
                SELECT count(*)::bigint AS n
                FROM public.sepa_universe_readiness_daily
                WHERE as_of_date = CURRENT_DATE
                  AND universe_rule_version = 'v1'
                  AND price_source = 'massive'
                """
            )
            snap_total = int((cur.fetchone() or {}).get("n") or 0)
            out["snapshot_populated"] = snap_total > 0

            cur.execute(
                """
                SELECT count(*)::bigint AS n
                FROM public.sepa_universe_readiness_daily
                WHERE as_of_date = CURRENT_DATE
                  AND universe_rule_version = 'v1'
                  AND price_source = 'massive'
                  AND included_in_universe
                """
            )
            snap_included = int((cur.fetchone() or {}).get("n") or 0)

            cur.execute(
                """
                SELECT count(*)::bigint AS n
                FROM public.sepa_universe_readiness_daily
                WHERE as_of_date = CURRENT_DATE
                  AND universe_rule_version = 'v1'
                  AND price_source = 'massive'
                  AND included_in_universe
                  AND price_ready
                """
            )
            snap_ready = int((cur.fetchone() or {}).get("n") or 0)

            out["snapshot_today"] = {
                "rows_total": snap_total,
                "included_in_universe": snap_included,
                "price_ready": snap_ready,
            }

            cur.execute(
                """
                SELECT coalesce(notes, '(ready)') AS notes_key, count(*)::bigint AS cnt
                FROM public.sepa_universe_readiness_daily
                WHERE as_of_date = CURRENT_DATE
                  AND universe_rule_version = 'v1'
                  AND price_source = 'massive'
                  AND included_in_universe
                  AND NOT price_ready
                GROUP BY 1
                ORDER BY cnt DESC
                LIMIT 20
                """
            )
            rows: List[Dict[str, Any]] = []
            for r in cur.fetchall() or []:
                rows.append({"notes": r.get("notes_key"), "count": int(r.get("cnt") or 0)})
            out["notes_breakdown"] = rows

            # Holidays summary — covers the same Step 1 as ticker universe sync.
            try:
                cur.execute(
                    """
                    SELECT
                        count(*)::bigint AS total,
                        count(*) FILTER (WHERE status = 'early-close')::bigint AS early_close_count,
                        count(*) FILTER (WHERE source = 'massive')::bigint AS massive_count,
                        count(*) FILTER (WHERE source = 'manual_seed')::bigint AS seed_count,
                        count(*) FILTER (WHERE source = 'manual')::bigint AS manual_count,
                        min(holiday_date)::text AS earliest_date,
                        max(holiday_date)::text AS latest_date,
                        max(updated_at) FILTER (WHERE source = 'massive')::text AS last_massive_sync
                    FROM public.reference_us_holidays
                    """
                )
                hr = cur.fetchone() or {}
                cur.execute(
                    """
                    SELECT exchange, count(*)::bigint AS cnt
                    FROM public.reference_us_holidays
                    GROUP BY exchange
                    ORDER BY exchange
                    """
                )
                by_exchange = [
                    {"exchange": r.get("exchange"), "count": int(r.get("cnt") or 0)}
                    for r in (cur.fetchall() or [])
                ]
                out["holidays_summary"] = {
                    "total": int(hr.get("total") or 0),
                    "early_close_count": int(hr.get("early_close_count") or 0),
                    "massive_count": int(hr.get("massive_count") or 0),
                    "seed_count": int(hr.get("seed_count") or 0),
                    "manual_count": int(hr.get("manual_count") or 0),
                    "earliest_date": hr.get("earliest_date"),
                    "latest_date": hr.get("latest_date"),
                    "last_massive_sync": hr.get("last_massive_sync"),
                    "by_exchange": by_exchange,
                }
            except Exception as e:
                logger.debug("holidays_summary query failed: %s", e)
                out["holidays_summary"] = {
                    "total": 0,
                    "early_close_count": 0,
                    "massive_count": 0,
                    "seed_count": 0,
                    "manual_count": 0,
                    "earliest_date": None,
                    "latest_date": None,
                    "last_massive_sync": None,
                    "by_exchange": [],
                }
        out["data_catalog"] = READINESS_DATA_CATALOG
    finally:
        conn.close()
    return out


def get_sepa_grouped_backfill_dates(
    status_config: dict,
    *,
    days_back: int = 420,
) -> Dict[str, Any]:
    """Return weekday dates in the past `days_back` days where stock_day has fewer than 1000 symbols.

    Dates with < 1000 symbols indicate either no data at all or watchlist-only partial data.
    Grouped Daily API covers the full market in one call, so any date it ran should have 5000+ rows.

    Returns: {ok, missing_dates: [str], missing_count, checked_dates}
    """
    if not _db_ok(status_config):
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(status_config)
    params["connect_timeout"] = 15
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        logger.warning("get_sepa_grouped_backfill_dates connect failed: %s", e)
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor() as cur:
            cur.execute("SET statement_timeout = 45000")
            cur.execute(
                """
                WITH date_series AS (
                    SELECT generate_series(
                        (CURRENT_DATE - %(days_back)s::int)::date,
                        (CURRENT_DATE - 1)::date,
                        '1 day'::interval
                    )::date AS d
                ),
                weekdays AS (
                    SELECT d FROM date_series
                    WHERE EXTRACT(dow FROM d) BETWEEN 1 AND 5
                      AND d NOT IN (
                          SELECT holiday_date FROM public.reference_us_holidays
                          WHERE exchange = 'NYSE'
                            AND (status IS NULL OR status = 'closed')
                      )
                ),
                coverage AS (
                    SELECT
                        w.d,
                        count(DISTINCT sd.symbol)::int AS symbol_count
                    FROM weekdays w
                    LEFT JOIN public.stock_day sd
                        ON sd.bar_time::date = w.d
                        AND sd.source = 'massive'
                    GROUP BY w.d
                )
                SELECT
                    d::text AS dt,
                    symbol_count,
                    count(*) OVER () AS total_checked
                FROM coverage
                WHERE symbol_count < 1000
                ORDER BY d
                """,
                {"days_back": int(days_back)},
            )
            rows = cur.fetchall() or []
        total_checked = int(rows[0][2]) if rows else 0
        missing_dates: List[str] = [str(r[0]) for r in rows]
        return {
            "ok": True,
            "missing_dates": missing_dates,
            "missing_count": len(missing_dates),
            "checked_dates": total_checked,
        }
    except Exception as e:
        logger.warning("get_sepa_grouped_backfill_dates query failed: %s", e)
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


def _stock_day_gap_reason_row(r: Dict[str, Any]) -> str:
    """Human-readable reason for one gap row (vendor calendar vs readiness fallback)."""
    if r.get("is_vendor_gap"):
        vd = r.get("vendor_day") or "?"
        mx = r.get("last_bar_max")
        mx_s = str(mx) if mx is not None else "none"
        return f"vendor NY date {vd} ahead of last massive daily bar ({mx_s})"
    br = int(r.get("bar_rows") or 0)
    last_bar = r.get("last_bar_date")
    null_close = int(r.get("null_close_rows") or 0)
    null_vol = int(r.get("null_volume_rows") or 0)
    if br == 0 or last_bar is None:
        return "snapshot row but no last_minute_updated — fallback: no bars in 420d window (readiness)"
    if br < 240:
        return f"snapshot row but no last_minute_updated — fallback: insufficient bars ({br}/240 required)"
    if null_close > 0 or null_vol > 0:
        return (
            "snapshot row but no last_minute_updated — fallback: null data "
            f"(close={null_close} volume={null_vol})"
        )
    return "snapshot row but no last_minute_updated — fallback: stale last bar (> 7 calendar days ago)"


def get_sepa_price_gap_details(
    status_config: dict,
    *,
    limit: int = 2000,
) -> Dict[str, Any]:
    """Return per-symbol gaps for Step 3 stock_day checks.

    Any snapshot-based gap requires a ``cache_stock_snapshot`` row with **non-null**
    ``session_close``; otherwise that symbol is not checked against ``stock_day`` or readiness
    for Step 3 gaps. **Vendor fill gap**: ``last_minute_updated`` set, NY calendar date strictly
    after ``max(stock_day.bar_time)``, and latest daily ``close`` not within tolerance of
    ``session_close``. **Fallback gap**: same non-null ``session_close``, ``last_minute_updated``
    NULL, and ``NOT price_ready`` on the readiness view (or no row there). ``WARRANT`` tickers
    are excluded. **No snapshot row** → never a gap.

    Returns: {ok, total_gap_count, returned, items: [..., last_stock_day_close, session_close, reason]}
    """
    if not _db_ok(status_config):
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(status_config)
    params["connect_timeout"] = 15
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        logger.warning("get_sepa_price_gap_details connect failed: %s", e)
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 45000")
            try:
                cur.execute("SET LOCAL jit = off")
            except Exception:
                pass
            cur.execute(
                f"""
                WITH {_STOCK_DAY_VENDOR_GAP_CANDIDATE_SQL},
                gap_rows AS (
                    SELECT * FROM cand WHERE is_vendor_gap OR is_fallback_gap
                )
                SELECT
                    symbol,
                    bar_rows,
                    first_bar_date,
                    last_bar_date,
                    null_close_rows,
                    null_volume_rows,
                    vendor_day::text AS vendor_day,
                    last_bar_max::text AS last_bar_max_date,
                    last_bar_day_close::float8 AS last_stock_day_close,
                    session_close::float8 AS session_close,
                    is_vendor_gap,
                    is_fallback_gap,
                    count(*) OVER () AS total_count
                FROM gap_rows
                ORDER BY is_vendor_gap DESC, bar_rows ASC NULLS LAST, symbol
                LIMIT %(limit)s
                """,
                {"limit": int(limit)},
            )
            rows = cur.fetchall() or []
        total_gap_count = int(rows[0]["total_count"]) if rows else 0
        items: List[Dict[str, Any]] = []
        for r in rows:
            bar_rows = int(r.get("bar_rows") or 0)
            null_close = int(r.get("null_close_rows") or 0)
            null_vol = int(r.get("null_volume_rows") or 0)
            last_bar = r.get("last_bar_date")
            items.append({
                "symbol": r.get("symbol"),
                "bar_rows": bar_rows,
                "first_bar_date": r.get("first_bar_date"),
                "last_bar_date": last_bar,
                "null_close_rows": null_close,
                "null_volume_rows": null_vol,
                "vendor_day": r.get("vendor_day"),
                "last_bar_max_date": r.get("last_bar_max_date"),
                "last_stock_day_close": r.get("last_stock_day_close"),
                "session_close": r.get("session_close"),
                "reason": _stock_day_gap_reason_row(r),
            })
        return {
            "ok": True,
            "total_gap_count": total_gap_count,
            "returned": len(items),
            "items": items,
        }
    except Exception as e:
        logger.warning("get_sepa_price_gap_details query failed: %s", e)
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


def get_sepa_price_gap_symbols(
    status_config: dict,
    *,
    batch_size: int = 50,
) -> Dict[str, Any]:
    """Return symbols matching the Step 3 vendor-calendar / readiness fallback gap rule (see get_sepa_price_gap_details).

    Returns: {ok, gap_count, batches: [[symbol, ...], ...]}
    """
    if not _db_ok(status_config):
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(status_config)
    params["connect_timeout"] = 15
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        logger.warning("get_sepa_price_gap_symbols connect failed: %s", e)
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor() as cur:
            cur.execute("SET statement_timeout = 30000")
            try:
                cur.execute("SET LOCAL jit = off")
            except Exception:
                pass
            cur.execute(
                f"""
                WITH {_STOCK_DAY_VENDOR_GAP_CANDIDATE_SQL}
                SELECT symbol
                FROM cand
                WHERE is_vendor_gap OR is_fallback_gap
                ORDER BY symbol
                """
            )
            rows = cur.fetchall() or []
        symbols: List[str] = [str(r[0]) for r in rows]
        batches: List[List[str]] = [
            symbols[i : i + batch_size] for i in range(0, len(symbols), batch_size)
        ]
        return {"ok": True, "gap_count": len(symbols), "batches": batches}
    except Exception as e:
        logger.warning("get_sepa_price_gap_symbols query failed: %s", e)
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()
