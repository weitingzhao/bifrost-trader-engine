from __future__ import annotations

from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Request

from src.research.sepa.readiness_snapshot import (
    fetch_sepa_readiness_summary,
    get_sepa_grouped_backfill_dates,
    get_sepa_price_gap_details,
    get_sepa_price_gap_symbols,
    run_sepa_universe_readiness_snapshot,
)
from src.research.sepa.stock_unified_snapshot_refresh import run_refresh_cache_stock_unified_snapshots

router = APIRouter(tags=["research"])


def _db_config(request: Request) -> Optional[dict]:
    return request.app.state.control_via_db or getattr(request.app.state, "status_cfg_for_read", None)


@router.get("/research/screening/sepa/readiness/summary")
def get_sepa_readiness_summary(request: Request) -> Dict[str, Any]:
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return fetch_sepa_readiness_summary(db)


@router.post("/research/screening/sepa/readiness/snapshot")
def post_sepa_readiness_snapshot(request: Request) -> Dict[str, Any]:
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return run_sepa_universe_readiness_snapshot(db)


@router.post("/research/screening/sepa/readiness/stock-unified-snapshot")
def post_sepa_stock_unified_snapshot(request: Request) -> Dict[str, Any]:
    """Batch GET /v3/snapshot (stocks) for v_sepa_us_equity_universe; UPSERT cache_stock_snapshot."""
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    reader = getattr(request.app.state, "reader", None)
    merged_config = reader._config if reader else {}
    return run_refresh_cache_stock_unified_snapshots(db, merged_config)


@router.get("/research/screening/sepa/readiness/price-gaps")
def get_sepa_price_gaps(request: Request) -> Dict[str, Any]:
    """Return detailed per-symbol gap list for symbols in the SEPA universe that are NOT price_ready."""
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return get_sepa_price_gap_details(db)


@router.post("/research/screening/sepa/readiness/backfill-price-gaps")
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

    for batch in batches:
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
                async_result = run_massive_job.apply_async(
                    args=[jid], task_id=str(jid), queue=queue_name
                )
                update_job_massive_backfill_celery_task_id(db, jid, async_result.id)
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


@router.post("/research/screening/sepa/readiness/backfill-fundamentals")
def post_sepa_backfill_fundamentals(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    """Submit a Phase4 job to backfill research_sepa_fundamentals_cache for universe symbols.

    Queries v_sepa_us_equity_universe for symbols without a valid (non-expired) fundamentals
    cache entry and launches a background Phase4 job (Phase1 → CRS → Fundamentals fetch).
    """
    import threading

    from src.research.sepa.phase4_engine import (
        Phase4JobConfig,
        create_phase4_job,
        run_sepa_phase4_job,
    )
    from src.vendor.massive.client import MassiveClient
    from src.vendor.massive.config import get_massive_settings

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    reader = getattr(request.app.state, "reader", None)
    merged_config = reader._config if reader else {}
    ms = get_massive_settings(merged_config)
    if not ms.get("api_key"):
        return {"ok": False, "error": "Massive API key not configured"}

    import psycopg2
    from psycopg2.extras import RealDictCursor
    from src.persistence.postgres.connection import _get_conn_params

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
                FROM public.v_sepa_us_equity_universe u
                LEFT JOIN public.research_sepa_fundamentals_cache fc
                    ON upper(trim(fc.symbol)) = u.symbol
                   AND fc.rule_version = 'sepa_fundamentals_v1'
                   AND fc.expire_at > now()
                WHERE fc.symbol IS NULL
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
            "job_id": None,
            "message": "All universe symbols already have valid fundamentals cache.",
        }

    max_symbols = int(body.get("max_symbols", 5000))
    symbols = symbols[:max_symbols]

    payload = {
        "source": "massive",
        "lookback_days": 420,
        "volume_threshold": 100000.0,
        "strict_sma200_rising": False,
        "min_crs": 70.0,
        "max_workers": int(body.get("max_workers", 4)),
        "max_retries": 3,
        "rate_limit_rps": float(body.get("rate_limit_rps", 4.0)),
        "retry_base_sec": 0.6,
        "cache_ttl_sec": int(body.get("cache_ttl_sec", 21600)),
        "use_parallel": True,
    }
    job_id = create_phase4_job(db, symbols, payload=payload)
    cfg = Phase4JobConfig(**payload)
    client = MassiveClient(api_key=ms["api_key"], base_url=ms["rest_base"])

    t = threading.Thread(
        target=run_sepa_phase4_job,
        kwargs={
            "job_id": job_id,
            "symbols": symbols,
            "status_config": db,
            "merged_config": merged_config,
            "massive_client": client,
            "cfg": cfg,
        },
        daemon=True,
    )
    t.start()

    return {
        "ok": True,
        "gap_count": len(symbols),
        "job_id": job_id,
        "message": f"Phase4 job submitted for {len(symbols)} symbols without valid fundamentals cache.",
    }


@router.post("/research/screening/sepa/readiness/sync-holidays")
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


@router.post("/research/screening/sepa/readiness/backfill-grouped-history")
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

    for date_str in missing_dates:
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
                ar = run_massive_job.apply_async(args=[jid], task_id=str(jid), queue=queue_name)
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
    """Enqueue Celery ``run_massive_job`` for a fundamentals feed kind (symbol batches)."""
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
    for batch in batches:
        payload: Dict[str, Any] = {"symbols": batch, "throttle_sec": float(body.get("throttle_sec") or 0.22)}
        if kind == "feed_stocks_ratios" and "use_v1_endpoint" in body:
            payload["use_v1_endpoint"] = bool(body.get("use_v1_endpoint"))
        try:
            jid, deduplicated = insert_job_massive_backfill(db, kind, payload)
            if jid is None:
                dispatch_errors.append("insert_job returned None for a batch")
                continue
            if not deduplicated:
                ar = run_massive_job.apply_async(args=[jid], task_id=str(jid), queue=queue_name)
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


@router.get("/research/screening/sepa/readiness/income-statements-gaps")
def get_sepa_income_statements_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_income_statements_gap_details")


@router.post("/research/screening/sepa/readiness/backfill-income-statements")
def post_sepa_backfill_income_statements(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_income_statements")


@router.get("/research/screening/sepa/readiness/balance-sheets-gaps")
def get_sepa_balance_sheets_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_balance_sheet_gap_details")


@router.post("/research/screening/sepa/readiness/backfill-balance-sheets")
def post_sepa_backfill_balance_sheets(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_balance_sheets")


@router.get("/research/screening/sepa/readiness/cash-flows-gaps")
def get_sepa_cash_flows_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_cash_flow_gap_details")


@router.post("/research/screening/sepa/readiness/backfill-cash-flows")
def post_sepa_backfill_cash_flows(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_cash_flows")


@router.get("/research/screening/sepa/readiness/ratios-gaps")
def get_sepa_ratios_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_ratios_gap_details")


@router.post("/research/screening/sepa/readiness/backfill-ratios")
def post_sepa_backfill_ratios(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_ratios")


@router.get("/research/screening/sepa/readiness/short-interest-gaps")
def get_sepa_short_interest_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_short_interest_gap_details")


@router.post("/research/screening/sepa/readiness/backfill-short-interest")
def post_sepa_backfill_short_interest(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_short_interest")


@router.get("/research/screening/sepa/readiness/short-volume-gaps")
def get_sepa_short_volume_gaps(request: Request) -> Dict[str, Any]:
    return _get_sepa_financials_gaps(request, detail_fetcher="get_short_volume_gap_details")


@router.post("/research/screening/sepa/readiness/backfill-short-volume")
def post_sepa_backfill_short_volume(
    request: Request,
    body: Dict[str, Any] = Body(default={}),
) -> Dict[str, Any]:
    return _post_sepa_financials_backfill(request, body, kind="feed_stocks_short_volume")
