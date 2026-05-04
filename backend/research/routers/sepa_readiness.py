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


@router.get("/research/screening/sepa/readiness/price-gaps")
def get_sepa_price_gaps(request: Request) -> Dict[str, Any]:
    """Return detailed per-symbol gap list for symbols in the SEPA universe that are NOT price_ready."""
    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}
    return get_sepa_price_gap_details(db)


@router.post("/research/screening/sepa/readiness/backfill-price-gaps")
def post_sepa_backfill_price_gaps(request: Request) -> Dict[str, Any]:
    """Fan-out daily_smart Celery jobs for all universe symbols that are NOT price_ready."""
    from src.massive.celery_queues import celery_queue_for_massive_job
    from src.massive.tasks import run_massive_job
    from src.vendor.massive.reader import (
        insert_job_massive_backfill,
        update_job_massive_backfill_celery_task_id,
    )

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "PostgreSQL not configured"}

    gap_result = get_sepa_price_gap_symbols(db, batch_size=50)
    if not gap_result.get("ok"):
        return gap_result

    gap_count: int = gap_result["gap_count"]
    batches: list = gap_result["batches"]

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
