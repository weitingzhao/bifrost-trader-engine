from __future__ import annotations

import json
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Request

from src.research.sepa.readiness_snapshot import (
    compute_data_inventory_stats,
    compute_sepa_criteria_stats,
    fetch_sepa_readiness_summary,
    get_sepa_grouped_backfill_dates,
    get_sepa_price_gap_details,
    get_sepa_price_gap_symbols,
    run_fundamentals_local_backfill,
    run_sepa_universe_readiness_snapshot,
    run_technical_local_backfill,
)
from src.research.sepa.stock_unified_snapshot_refresh import run_refresh_cache_stock_unified_snapshots

router = APIRouter(tags=["research"])


def _db_config(request: Request) -> Optional[dict]:
    return request.app.state.control_via_db or getattr(request.app.state, "status_cfg_for_read", None)


@router.get("/research/data/readiness/summary")
def get_sepa_readiness_summary(request: Request) -> Dict[str, Any]:
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return fetch_sepa_readiness_summary(db)


@router.post("/research/data/readiness/snapshot")
def post_sepa_readiness_snapshot(request: Request) -> Dict[str, Any]:
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return run_sepa_universe_readiness_snapshot(db)


@router.post("/research/data/readiness/stock-unified-snapshot")
def post_sepa_stock_unified_snapshot(request: Request) -> Dict[str, Any]:
    """Batch GET /v3/snapshot (stocks) for v_us_equity_universe; UPSERT cache_stock_snapshot."""
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    reader = getattr(request.app.state, "reader", None)
    merged_config = reader._config if reader else {}
    return run_refresh_cache_stock_unified_snapshots(db, merged_config)


@router.get("/research/data/readiness/price-gaps")
def get_sepa_price_gaps(request: Request) -> Dict[str, Any]:
    """Return detailed per-symbol gap list for symbols in the SEPA universe that are NOT price_ready."""
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return get_sepa_price_gap_details(db)


@router.post("/research/data/readiness/backfill-price-gaps")
def post_sepa_backfill_price_gaps(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    """Fan-out daily_smart Celery jobs for universe symbols that are NOT price_ready.

    If body.symbols is provided (list of ticker strings), only those symbols are backfilled.
    Otherwise all gap symbols are queried from the DB (default bulk behaviour).
    """
    from src.massive.celery_queues import celery_queue_for_massive_job
    from src.massive.tasks import run_massive_job
    from src.vendor.massive.reader import (
        insert_job_massive_backfill,
        update_job_massive_backfill_celery_task_id,
    )

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    custom_symbols: list = body.get("symbols") or []
    # Smaller batches: each Celery job runs daily_smart per symbol (sequential REST); large batches risk timeouts.
    batch_size = max(5, min(int(body.get("batch_size") or 25), 80))
    if custom_symbols:
        symbols = [str(s).strip().upper() for s in custom_symbols if s]
        batches: list = [symbols[i : i + batch_size] for i in range(0, len(symbols), batch_size)]
        gap_count: int = len(symbols)
    else:
        gap_result = get_sepa_price_gap_symbols(db, batch_size=batch_size)
        if not gap_result.get("ok"):
            return gap_result
        gap_count = gap_result["gap_count"]
        batches = gap_result["batches"]

    if not batches:
        return {
            "ok": True,
            "gap_count": 0,
            "chunks": 0,
            "job_ids": [],
            "message": "No price gaps — all universe symbols are price_ready.",
        }

    queue_name = celery_queue_for_massive_job("feed_stocks_aggregate", priority_high=False)
    job_ids: list = []
    dispatch_errors: list = []

    for idx, batch in enumerate(batches):
        payload: Dict[str, Any] = {
            "mode": "custom_bars",
            "sync_all_periods": True,
            "custom_bars_period_group": "daily",
            "custom_bars_sync_mode": "daily_smart",
            "start_ms": 0,
            "end_ms": 0,
            "symbols": batch,
        }
        try:
            jid, deduplicated = insert_job_massive_backfill(db, "feed_stocks_aggregate", payload)
            if jid is None:
                dispatch_errors.append("insert_job returned None for a batch")
                continue
            if not deduplicated:
                countdown = min(float(idx) * 0.35, 120.0)
                ar = run_massive_job.apply_async(args=[jid], queue=queue_name, countdown=countdown)
                update_job_massive_backfill_celery_task_id(db, jid, ar.id)
            job_ids.append(str(jid))
        except Exception as exc:
            dispatch_errors.append(str(exc))

    return {
        "ok": True,
        "gap_count": gap_count,
        "chunks": len(batches),
        "job_ids": job_ids,
        **({"errors": dispatch_errors} if dispatch_errors else {}),
    }


@router.post("/research/data/readiness/backfill-fundamentals")
def post_sepa_backfill_fundamentals(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    """Evaluate SEPA fundamentals for all universe symbols and write directly to stock_readiness_daily.

    Reads from stock_income_statements (already downloaded by Steps 4/5) and evaluates the 8 SEPA
    fundamental conditions for every symbol whose today's stock_readiness_daily row lacks fundamental_eval.
    No Phase1 / CRS filtering is applied — this is a data-completeness backfill, not a screening run.
    The heavy work is done in a background thread so the endpoint returns immediately.
    """
    import threading

    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.persistence.postgres.connection import _get_conn_params

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    params = _get_conn_params(db)
    params["connect_timeout"] = 15
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": f"DB connect failed: {e}"}

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 30000")
            cur.execute(
                """
                SELECT u.symbol
                FROM public.v_us_equity_universe u
                LEFT JOIN public.stock_readiness_daily srd
                    ON srd.symbol = u.symbol
                   AND srd.as_of_date = CURRENT_DATE
                   AND srd.universe_rule_version = 'v1'
                   AND srd.price_source = 'massive'
                   AND srd.fundamental_eval IS NOT NULL
                WHERE srd.symbol IS NULL
                ORDER BY u.symbol
                """
            )
            rows = cur.fetchall() or []
    except Exception as e:
        return {"ok": False, "error": f"Query failed: {e}"}
    finally:
        conn.close()

    symbols = [str(r["symbol"]) for r in rows]
    if not symbols:
        return {
            "ok": True,
            "gap_count": 0,
            "message": "All universe symbols already have valid fundamentals cache.",
        }

    max_symbols = int(body.get("max_symbols", 50000))
    symbols = symbols[:max_symbols]
    cache_ttl_sec = int(body.get("cache_ttl_sec", 21600))

    t = threading.Thread(
        target=run_fundamentals_local_backfill,
        kwargs={
            "status_config": db,
            "symbols": symbols,
            "cache_ttl_sec": cache_ttl_sec,
        },
        daemon=True,
    )
    t.start()

    return {
        "ok": True,
        "gap_count": len(symbols),
        "message": f"Local fundamentals backfill started for {len(symbols)} symbols (no Phase1/CRS filter).",
    }


@router.post("/research/data/readiness/backfill-technical")
def post_sepa_backfill_technical(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    """Evaluate 11 SEPA technical conditions (10 Phase-1 + CRS) for universe symbols and
    write directly to stock_readiness_daily.technical_eval.

    Reads only from local stock_day (massive). No vendor calls. CRS is computed
    universe-wide so the rank percentile is meaningful. The heavy work runs in a
    background thread so this endpoint returns immediately.
    """
    import threading

    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.persistence.postgres.connection import _get_conn_params

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    params = _get_conn_params(db)
    params["connect_timeout"] = 15
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": f"DB connect failed: {e}"}

    only_missing = bool(body.get("only_missing", True))
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 30000")
            if only_missing:
                cur.execute(
                    """
                    SELECT u.symbol
                    FROM public.v_us_equity_universe u
                    LEFT JOIN public.stock_readiness_daily srd
                        ON srd.symbol = u.symbol
                       AND srd.as_of_date = CURRENT_DATE
                       AND srd.universe_rule_version = 'v1'
                       AND srd.price_source = 'massive'
                       AND srd.technical_eval IS NOT NULL
                    WHERE srd.symbol IS NULL
                    ORDER BY u.symbol
                    """
                )
            else:
                cur.execute(
                    """
                    SELECT symbol FROM public.v_us_equity_universe ORDER BY symbol
                    """
                )
            rows = cur.fetchall() or []
    except Exception as e:
        return {"ok": False, "error": f"Query failed: {e}"}
    finally:
        conn.close()

    symbols = [str(r["symbol"]) for r in rows]
    if not symbols:
        return {
            "ok": True,
            "gap_count": 0,
            "message": "All universe symbols already have a technical_eval row for today.",
        }

    max_symbols = int(body.get("max_symbols", 50000))
    symbols = symbols[:max_symbols]
    min_crs = float(body.get("min_crs", 70.0))
    lookback_days = int(body.get("lookback_days", 420))

    t = threading.Thread(
        target=run_technical_local_backfill,
        kwargs={
            "status_config": db,
            "symbols": symbols,
            "min_crs": min_crs,
            "lookback_days": lookback_days,
        },
        daemon=True,
    )
    t.start()

    return {
        "ok": True,
        "gap_count": len(symbols),
        "message": (
            f"Local technical backfill started for {len(symbols)} symbols "
            f"(Phase-1 + CRS ≥ {min_crs:g})."
        ),
    }


@router.post("/research/data/readiness/sync-holidays")
def post_sepa_sync_holidays(request: Request) -> Dict[str, Any]:
    """Pull market holidays from Massive REST and upsert into reference_us_holidays.

    Triggered alongside Step 1 (Sync All Tickers) on the SEPA Data Ready page so
    downstream gap detection can exclude NYSE closed days.
    """
    from src.vendor.massive.holidays_sync import sync_market_holidays_from_massive

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    reader = getattr(request.app.state, "reader", None)
    cfg = getattr(reader, "_config", None) if reader else None
    return sync_market_holidays_from_massive(db, cfg=cfg)


@router.post("/research/data/readiness/backfill-grouped-history")
def post_sepa_backfill_grouped_history(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    """Enqueue one daily_market_summary Celery job per missing trading date in the lookback window.

    Uses Massive Grouped Daily Bars API (GET /v2/aggs/grouped/locale/us/market/stocks/{date}).
    One API call per date returns OHLCV for all 5,000+ US stocks simultaneously.
    Efficient for 420-day full-market historical backfill (420 calls vs 5000×420 for per-symbol).
    """
    from src.massive.celery_queues import celery_queue_for_massive_job
    from src.massive.tasks import run_massive_job
    from src.vendor.massive.reader import (
        insert_job_massive_backfill,
        update_job_massive_backfill_celery_task_id,
    )

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    days_back = min(int(body.get("days_back") or 420), 1500)

    dates_result = get_sepa_grouped_backfill_dates(db, days_back=days_back)
    if not dates_result.get("ok"):
        return dates_result

    missing_dates: list = dates_result["missing_dates"]
    checked_dates: int = dates_result.get("checked_dates", 0)

    if not missing_dates:
        return {
            "ok": True,
            "dates_queued": 0,
            "checked_dates": checked_dates,
            "job_ids": [],
            "message": f"All {checked_dates} trading dates in the {days_back}d window already have full coverage (≥1,000 symbols/day).",
        }

    queue_name = celery_queue_for_massive_job("feed_stocks_aggregate", priority_high=False)
    job_ids: list = []
    dispatch_errors: list = []

    for idx, date_str in enumerate(missing_dates):
        payload: Dict[str, Any] = {
            "mode": "daily_market_summary",
            "date": date_str,
            "adjusted": True,
        }
        try:
            jid, deduplicated = insert_job_massive_backfill(db, "feed_stocks_aggregate", payload)
            if jid is None:
                dispatch_errors.append(f"insert failed for {date_str}")
                continue
            if not deduplicated:
                countdown = min(float(idx) * 0.35, 120.0)
                ar = run_massive_job.apply_async(args=[jid], queue=queue_name, countdown=countdown)
                update_job_massive_backfill_celery_task_id(db, jid, ar.id)
            job_ids.append(str(jid))
        except Exception as exc:
            dispatch_errors.append(f"{date_str}: {exc}")

    return {
        "ok": True,
        "dates_queued": len(missing_dates),
        "checked_dates": checked_dates,
        "days_back": days_back,
        "job_ids": job_ids,
        **({"errors": dispatch_errors} if dispatch_errors else {}),
    }


def _post_sepa_financials_backfill(
    request: Request,
    body: Dict[str, Any],
    *,
    kind: str,
) -> Dict[str, Any]:
    """Insert ``job_massive_backfill`` rows and ``apply_async`` for a fundamentals feed kind."""
    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.massive.celery_queues import celery_queue_for_massive_job
    from src.massive.tasks import run_massive_job
    from src.persistence.postgres.connection import _get_conn_params
    from src.research.sepa import financials_data as fd
    from src.vendor.massive.reader import (
        insert_job_massive_backfill,
        update_job_massive_backfill_celery_task_id,
    )

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    custom_symbols: list = body.get("symbols") or []
    batch_size = int(body.get("batch_size") or 50)
    if custom_symbols:
        symbols = [str(s).strip().upper() for s in custom_symbols if s]
        batches = [symbols[i : i + batch_size] for i in range(0, len(symbols), batch_size)]
        gap_count = len(symbols)
    else:
        params = _get_conn_params(db)
        params["connect_timeout"] = 15
        try:
            conn = psycopg2.connect(**params)
        except Exception as e:
            return {"ok": False, "error": str(e)}
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                gap_result = fd.financials_gap_symbols_from_db(cur, kind, batch_size=batch_size)
        finally:
            conn.close()
        if not gap_result.get("ok"):
            return gap_result
        gap_count = int(gap_result.get("gap_count") or 0)
        batches = gap_result.get("batches") or []

    if not batches:
        return {
            "ok": True,
            "gap_count": 0,
            "chunks": 0,
            "job_ids": [],
            "message": f"No {kind} gaps — universe coverage meets thresholds.",
        }

    queue_name = celery_queue_for_massive_job(kind, priority_high=False)
    job_ids: list = []
    dispatch_errors: list = []
    for idx, batch in enumerate(batches):
        payload: Dict[str, Any] = {"symbols": batch, "throttle_sec": float(body.get("throttle_sec") or 0.22)}
        if kind == "feed_stocks_ratios" and "use_v1_endpoint" in body:
            payload["use_v1_endpoint"] = bool(body.get("use_v1_endpoint"))
        try:
            jid, deduplicated = insert_job_massive_backfill(db, kind, payload)
            if jid is None:
                dispatch_errors.append("insert_job returned None for a batch")
                continue
            if not deduplicated:
                countdown = min(float(idx) * 0.35, 120.0)
                ar = run_massive_job.apply_async(args=[jid], queue=queue_name, countdown=countdown)
                update_job_massive_backfill_celery_task_id(db, jid, ar.id)
            job_ids.append(str(jid))
        except Exception as exc:
            dispatch_errors.append(str(exc))

    return {
        "ok": True,
        "gap_count": gap_count,
        "chunks": len(batches),
        "job_ids": job_ids,
        "kind": kind,
        **({"errors": dispatch_errors} if dispatch_errors else {}),
    }


def _get_sepa_financials_gaps(
    request: Request,
    *,
    detail_fetcher: str,
    limit: int = 2000,
) -> Dict[str, Any]:
    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.persistence.postgres.connection import _get_conn_params
    from src.research.sepa import financials_data as fd

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(db)
    params["connect_timeout"] = 15
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            fn = getattr(fd, detail_fetcher)
            rows, total = fn(cur, limit=limit)
    finally:
        conn.close()
    return {
        "ok": True,
        "gaps": rows,
        "total_gap_count": total,
        "returned": len(rows),
    }


@router.get("/research/data/readiness/income-statements-gaps")
def get_sepa_income_statements_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_income_statements_gap_details")


@router.post("/research/data/readiness/backfill-income-statements")
def post_sepa_backfill_income_statements(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_income_statements")


@router.get("/research/data/readiness/balance-sheets-gaps")
def get_sepa_balance_sheets_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_balance_sheet_gap_details")


@router.post("/research/data/readiness/backfill-balance-sheets")
def post_sepa_backfill_balance_sheets(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_balance_sheets")


@router.get("/research/data/readiness/cash-flows-gaps")
def get_sepa_cash_flows_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_cash_flow_gap_details")


@router.post("/research/data/readiness/backfill-cash-flows")
def post_sepa_backfill_cash_flows(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_cash_flows")


@router.get("/research/data/readiness/ratios-gaps")
def get_sepa_ratios_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_ratios_gap_details")


@router.post("/research/data/readiness/backfill-ratios")
def post_sepa_backfill_ratios(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_ratios")


@router.get("/research/data/readiness/short-interest-gaps")
def get_sepa_short_interest_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_short_interest_gap_details")


@router.post("/research/data/readiness/backfill-short-interest")
def post_sepa_backfill_short_interest(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_short_interest")


@router.get("/research/data/readiness/short-volume-gaps")
def get_sepa_short_volume_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_short_volume_gap_details")


@router.post("/research/data/readiness/backfill-short-volume")
def post_sepa_backfill_short_volume(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_short_volume")


_VALID_GAP_ACK_TYPES = frozenset(
    ("income_statements", "balance_sheets", "cash_flows", "ratios", "short_interest", "short_volume")
)


def _gap_ack_db(request: Request):
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from src.persistence.postgres.connection import _get_conn_params

    db = _db_config(request)
    if not db:
        return None, {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(db)
    params["connect_timeout"] = 10
    try:
        conn = psycopg2.connect(**params)
        return conn, None
    except Exception as e:
        return None, {"ok": False, "error": str(e)}


@router.get("/research/data/readiness/gap-ack")
def get_sepa_gap_ack(request: Request) -> Dict[str, Any]:
    from psycopg2.extras import RealDictCursor

    conn, err = _gap_ack_db(request)
    if err:
        return err
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT data_type, is_void, acked_gap_count, void_reason, acked_at::text AS acked_at "
                "FROM public.preference_data_gap_ack ORDER BY data_type"
            )
            rows = [dict(r) for r in (cur.fetchall() or [])]
    finally:
        conn.close()
    return {"ok": True, "acks": rows}


@router.post("/research/data/readiness/gap-ack")
def post_sepa_gap_ack(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    data_type = str(body.get("data_type", "")).strip()
    if data_type not in _VALID_GAP_ACK_TYPES:
        return {"ok": False, "error": f"Invalid data_type: {data_type!r}"}
    is_void = bool(body.get("is_void", False))
    # gap_count is the current total gap count at acknowledgment time — used as the baseline
    gap_count = max(0, int(body.get("gap_count") or 0))
    void_reason = body.get("void_reason") or None

    conn, err = _gap_ack_db(request)
    if err:
        return err
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO public.preference_data_gap_ack
                    (data_type, is_void, acked_gap_count, void_reason, acked_at)
                VALUES (%s, %s, %s, %s, now())
                ON CONFLICT (data_type) DO UPDATE
                    SET is_void = EXCLUDED.is_void,
                        acked_gap_count = EXCLUDED.acked_gap_count,
                        void_reason = EXCLUDED.void_reason,
                        acked_at = now()
                """,
                (data_type, is_void, gap_count, void_reason),
            )
        conn.commit()
    finally:
        conn.close()
    return {"ok": True, "data_type": data_type, "is_void": is_void, "acked_gap_count": gap_count}


@router.get("/research/data/readiness/criteria-stats")
def get_sepa_criteria_stats(request: Request) -> Dict[str, Any]:
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return compute_sepa_criteria_stats(db)


@router.get("/research/data/readiness/fundamental-distribution/symbols")
def get_fundamental_distribution_symbols(
    request: Request,
    conditions_passed: int = 0,
) -> Dict[str, Any]:
    """Return symbols that passed exactly N out of 8 SEPA fundamental conditions today."""
    import psycopg2
    from psycopg2.extras import RealDictCursor
    from src.persistence.postgres.connection import _get_conn_params

    if conditions_passed < 0 or conditions_passed > 8:
        return {"ok": False, "error": "conditions_passed must be 0–8"}
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(db)
    params["connect_timeout"] = 10
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 15000")
            cur.execute(
                """
                SELECT
                    symbol,
                    coalesce((fundamental_eval->>'pass_count')::int, 0) AS pass_count,
                    coalesce((fundamental_eval->>'fundamental_pass')::boolean, false) AS fund_pass,
                    fundamental_eval->'conditions' AS conditions
                FROM public.stock_readiness_daily
                WHERE as_of_date = CURRENT_DATE
                  AND included_in_universe = true
                  AND fundamental_eval IS NOT NULL
                  AND coalesce((fundamental_eval->>'insufficient_data')::boolean, false) IS NOT TRUE
                  AND coalesce((fundamental_eval->>'pass_count')::int, 0) = %(n)s
                ORDER BY symbol
                """,
                {"n": conditions_passed},
            )
            rows = cur.fetchall() or []
        symbols = []
        for r in rows:
            cond_list = r.get("conditions") or []
            passed_ids = [c.get("id") for c in cond_list if c.get("pass") is True] if isinstance(cond_list, list) else []
            symbols.append({
                "symbol": r["symbol"],
                "pass_count": int(r.get("pass_count") or 0),
                "passed_conditions": passed_ids,
            })
        return {"ok": True, "conditions_passed": conditions_passed, "count": len(symbols), "symbols": symbols}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


@router.get("/research/data/readiness/data-inventory")
def get_sepa_data_inventory(request: Request) -> Dict[str, Any]:
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return compute_data_inventory_stats(db)


@router.get("/research/data/readiness/fundamental-conditions")
def get_fundamental_conditions_by_symbol(
    request: Request,
    symbol: str = "",
) -> Dict[str, Any]:
    """Return today's SEPA fundamental conditions snapshot for a single symbol.

    Reads from ``public.stock_readiness_daily.fundamental_eval`` (jsonb) for the latest
    ``as_of_date <= CURRENT_DATE``. Falls back to the most recent stored row when today's
    snapshot is missing (e.g. before the daily Phase4 run).
    """
    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.persistence.postgres.connection import _get_conn_params

    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "symbol is required"}
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(db)
    params["connect_timeout"] = 10
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 8000")
            cur.execute(
                """
                SELECT
                    symbol,
                    as_of_date::text                                       AS as_of_date,
                    coalesce(fundamental_pass, false)                      AS fundamental_pass,
                    coalesce(fundamental_pass_count, 0)                    AS pass_count,
                    coalesce(fundamental_insufficient, false)              AS insufficient_data,
                    fundamental_eval
                FROM public.stock_readiness_daily
                WHERE symbol = %(sym)s
                  AND fundamental_eval IS NOT NULL
                ORDER BY as_of_date DESC, universe_rule_version DESC, price_source DESC
                LIMIT 1
                """,
                {"sym": sym},
            )
            row = cur.fetchone()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()

    if not row:
        return {"ok": True, "symbol": sym, "found": False}

    eval_json = row.get("fundamental_eval") or {}
    conditions_raw = eval_json.get("conditions") if isinstance(eval_json, dict) else []
    conditions = []
    if isinstance(conditions_raw, list):
        for c in conditions_raw:
            if not isinstance(c, dict):
                continue
            conditions.append(
                {
                    "id": str(c.get("id") or ""),
                    "pass": bool(c.get("pass") or False),
                    "actual": c.get("actual"),
                    "threshold": c.get("threshold"),
                    "reason": c.get("reason"),
                }
            )
    return {
        "ok": True,
        "symbol": sym,
        "found": True,
        "as_of_date": row.get("as_of_date"),
        "pass_count": int(row.get("pass_count") or 0),
        "fundamental_pass": bool(row.get("fundamental_pass") or False),
        "insufficient_data": bool(row.get("insufficient_data") or False),
        "conditions": conditions,
    }


_SEPA_VALID_CONDITION_IDS = frozenset(
    (
        "eps_q2q_ge_25pct",
        "rev_q2q_ge_25pct",
        "eps_acc_2q",
        "rev_acc_2q",
        "eps_3y_ge_15pct",
        "rev_3y_ge_15pct",
        "eps_acc_fy",
        "rev_acc_fy",
    )
)


@router.get("/research/data/readiness/fundamental-filter")
def get_fundamental_filter(
    request: Request,
    include: str = "",
    limit: int = 500,
) -> Dict[str, Any]:
    """Return universe symbols whose today's SEPA snapshot **passes every** condition in ``include``.

    Query parameter ``include`` is a comma-separated list of canonical condition IDs (see
    ``_SEPA_VALID_CONDITION_IDS``). Insufficient-data rows and rows outside the universe are
    excluded. Results are sorted by descending ``pass_count``, then symbol.
    """
    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.persistence.postgres.connection import _get_conn_params

    raw_ids = [s.strip() for s in (include or "").split(",") if s.strip()]
    cond_ids = [c for c in raw_ids if c in _SEPA_VALID_CONDITION_IDS]
    if not raw_ids:
        return {"ok": True, "include": [], "count": 0, "symbols": [], "limit": limit}
    if not cond_ids:
        return {"ok": False, "error": "no valid condition IDs"}

    try:
        eff_limit = max(1, min(int(limit), 5000))
    except Exception:
        eff_limit = 500

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(db)
    params["connect_timeout"] = 10
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    # Build dynamic WHERE: one jsonb containment predicate per required condition.
    where_clauses = [
        "as_of_date = CURRENT_DATE",
        "included_in_universe = true",
        "fundamental_eval IS NOT NULL",
        "coalesce((fundamental_eval->>'insufficient_data')::boolean, false) IS NOT TRUE",
    ]
    sql_params: Dict[str, Any] = {"lim": eff_limit}
    for i, cid in enumerate(cond_ids):
        key = f"c{i}"
        where_clauses.append(f"fundamental_eval->'conditions' @> %({key})s::jsonb")
        sql_params[key] = json.dumps([{"id": cid, "pass": True}])

    sql = (
        "SELECT symbol, "
        "       coalesce((fundamental_eval->>'pass_count')::int, 0) AS pass_count, "
        "       fundamental_eval->'conditions' AS conditions "
        "FROM public.stock_readiness_daily "
        f"WHERE {' AND '.join(where_clauses)} "
        "ORDER BY pass_count DESC, symbol ASC "
        "LIMIT %(lim)s"
    )

    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 10000")
            cur.execute(sql, sql_params)
            rows = cur.fetchall() or []
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()

    symbols = []
    for r in rows:
        cond_list = r.get("conditions") or []
        passed_ids = (
            [c.get("id") for c in cond_list if isinstance(c, dict) and c.get("pass") is True]
            if isinstance(cond_list, list)
            else []
        )
        symbols.append(
            {
                "symbol": r["symbol"],
                "pass_count": int(r.get("pass_count") or 0),
                "passed_conditions": passed_ids,
            }
        )
    return {
        "ok": True,
        "include": cond_ids,
        "count": len(symbols),
        "symbols": symbols,
        "limit": eff_limit,
    }


@router.get("/research/data/readiness/symbols-snapshot")
def get_symbols_readiness_snapshot(
    request: Request,
    symbols: str = "",
) -> Dict[str, Any]:
    """Return the latest ``stock_readiness_daily`` row for each requested symbol.

    Used by the Stock Screener main results table: instead of re-running Phase1/CRS/
    Fundamentals on demand, just read what the unified Stock Data Readiness daily
    pipeline already wrote. For each symbol we pick the row with the largest
    ``as_of_date`` (typically today), regardless of which ``universe_rule_version``
    or ``price_source`` produced it (priority: most recent computed_at).
    """
    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.persistence.postgres.connection import _get_conn_params

    raw = (symbols or "").strip()
    if not raw:
        return {"ok": True, "as_of_date": None, "count": 0, "symbols": []}
    syms = [s.strip().upper() for s in raw.replace(";", ",").split(",") if s.strip()]
    syms = [s for s in syms if s][:500]
    if not syms:
        return {"ok": True, "as_of_date": None, "count": 0, "symbols": []}

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(db)
    params["connect_timeout"] = 10
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": str(e)}

    rows_by_symbol: Dict[str, Dict[str, Any]] = {}
    latest_as_of: Optional[str] = None
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 10000")
            # DISTINCT ON keeps the most recent row per symbol (largest as_of_date,
            # then largest computed_at as tiebreaker).
            cur.execute(
                """
                SELECT DISTINCT ON (symbol)
                  symbol,
                  as_of_date,
                  included_in_universe,
                  price_ready,
                  bar_count_lookback,
                  first_bar_date,
                  last_bar_date,
                  income_stmt_ready,
                  income_stmt_q_count,
                  income_stmt_a_count,
                  balance_sheet_present,
                  cash_flow_present,
                  ratios_present,
                  short_interest_present,
                  short_volume_present,
                  fundamental_pass,
                  fundamental_pass_count,
                  fundamental_insufficient,
                  fundamental_eval
                FROM public.stock_readiness_daily
                WHERE symbol = ANY(%(syms)s)
                ORDER BY symbol, as_of_date DESC, computed_at DESC
                """,
                {"syms": syms},
            )
            for r in cur.fetchall() or []:
                sym = r["symbol"]
                fund_eval = r.get("fundamental_eval") or {}
                cond_list = fund_eval.get("conditions") if isinstance(fund_eval, dict) else None
                passed_conditions = (
                    [c.get("id") for c in cond_list if isinstance(c, dict) and c.get("pass") is True]
                    if isinstance(cond_list, list)
                    else []
                )
                ao = r.get("as_of_date")
                ao_str = ao.isoformat() if hasattr(ao, "isoformat") else (str(ao) if ao else None)
                first_bar = r.get("first_bar_date")
                last_bar = r.get("last_bar_date")
                rows_by_symbol[sym] = {
                    "symbol": sym,
                    "found": True,
                    "as_of_date": ao_str,
                    "included_in_universe": bool(r.get("included_in_universe") or False),
                    "price_ready": bool(r.get("price_ready") or False),
                    "bar_count_lookback": int(r.get("bar_count_lookback") or 0),
                    "first_bar_date": first_bar.isoformat() if hasattr(first_bar, "isoformat") else (str(first_bar) if first_bar else None),
                    "last_bar_date": last_bar.isoformat() if hasattr(last_bar, "isoformat") else (str(last_bar) if last_bar else None),
                    "income_stmt_ready": bool(r.get("income_stmt_ready") or False),
                    "income_stmt_q_count": int(r.get("income_stmt_q_count") or 0),
                    "income_stmt_a_count": int(r.get("income_stmt_a_count") or 0),
                    "balance_sheet_present": bool(r.get("balance_sheet_present") or False),
                    "cash_flow_present": bool(r.get("cash_flow_present") or False),
                    "ratios_present": bool(r.get("ratios_present") or False),
                    "short_interest_present": bool(r.get("short_interest_present") or False),
                    "short_volume_present": bool(r.get("short_volume_present") or False),
                    "fundamental_pass": bool(r.get("fundamental_pass") or False),
                    "fundamental_pass_count": int(r.get("fundamental_pass_count") or 0),
                    "fundamental_insufficient": bool(r.get("fundamental_insufficient") or False),
                    "passed_conditions": passed_conditions,
                }
                if ao_str and (latest_as_of is None or ao_str > latest_as_of):
                    latest_as_of = ao_str
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()

    # Preserve request order; fill missing symbols with placeholder rows.
    ordered = []
    for s in syms:
        if s in rows_by_symbol:
            ordered.append(rows_by_symbol[s])
        else:
            ordered.append({"symbol": s, "found": False})

    return {
        "ok": True,
        "as_of_date": latest_as_of,
        "count": len(ordered),
        "symbols": ordered,
    }


@router.get("/research/data/readiness/symbol-fundamental-raw-data")
def get_symbol_fundamental_raw_data(
    request: Request,
    symbol: str = "",
) -> Dict[str, Any]:
    """Return raw quarterly/annual income statement rows + computed metrics for one symbol.

    Used by the Stock Inspector sidebar to display the underlying EPS/revenue data
    behind each SEPA fundamental condition and highlight which rows feed each condition.
    """
    import psycopg2
    from psycopg2.extras import RealDictCursor

    from src.persistence.postgres.connection import _get_conn_params

    sym = (symbol or "").strip().upper()
    if not sym:
        return {"ok": False, "error": "symbol is required"}
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    params = _get_conn_params(db)
    params["connect_timeout"] = 10
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SET statement_timeout = 8000")

            # Last 10 quarterly rows (EPS + revenues)
            cur.execute(
                """
                SELECT
                    fiscal_year,
                    fiscal_quarter,
                    basic_earnings_per_share  AS eps,
                    revenues
                FROM public.stock_income_statements
                WHERE symbol = %(sym)s
                  AND source = 'massive'
                  AND timeframe = 'quarterly'
                ORDER BY fiscal_year DESC, fiscal_quarter DESC
                LIMIT 10
                """,
                {"sym": sym},
            )
            quarterly = [dict(r) for r in cur.fetchall()]

            # Last 5 annual rows (EPS + revenues)
            cur.execute(
                """
                SELECT
                    fiscal_year,
                    basic_earnings_per_share  AS eps,
                    revenues
                FROM public.stock_income_statements
                WHERE symbol = %(sym)s
                  AND source = 'massive'
                  AND timeframe = 'annual'
                ORDER BY fiscal_year DESC
                LIMIT 5
                """,
                {"sym": sym},
            )
            annual = [dict(r) for r in cur.fetchall()]

            # Computed metrics stored inside fundamental_eval jsonb
            cur.execute(
                """
                SELECT fundamental_eval
                FROM public.stock_readiness_daily
                WHERE symbol = %(sym)s
                  AND fundamental_eval IS NOT NULL
                ORDER BY as_of_date DESC
                LIMIT 1
                """,
                {"sym": sym},
            )
            srd = cur.fetchone()
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()

    metrics: Dict[str, Any] = {}
    if srd and isinstance(srd.get("fundamental_eval"), dict):
        metrics = srd["fundamental_eval"].get("metrics") or {}

    return {
        "ok": True,
        "symbol": sym,
        "quarterly": quarterly,
        "annual": annual,
        "metrics": metrics,
    }
