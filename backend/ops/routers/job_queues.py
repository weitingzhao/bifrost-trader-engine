"""Bars and Massive Celery job tables — moved from main server / Massive API to Ops."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query, Request

from backend.massive.routers.routes import _massive_job_to_api
from backend.ops.routers.workers import _require_role
from src.monitor.reader import (
    count_job_bars_backfill_by_status,
    delete_all_job_bars_backfill,
    delete_job_bars_backfill,
    get_job_bars_backfill,
    get_job_bars_backfill_list,
    reset_failed_job_bars_backfill_to_pending,
    reset_failed_jobs_bars_backfill_to_pending_batch,
    trim_job_bars_backfill,
)
from src.monitor.services.market_jobs import job_row_to_api as _job_row_to_api
from src.monitor.services.market_jobs import reenqueue_bars_backfill_from_row

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ops-job-queues"])

_FALLBACK_QUEUE_LABELS: Dict[str, str] = {
    "bars": "IB",
    "massive": "Massive options",
    "massive_high": "Massive options (H)",
    "massive_stocks": "Massive stocks",
    "massive_stocks_high": "Massive stocks (H)",
}


def _db_config(request: Request) -> Optional[dict]:
    return request.app.state.control_via_db or getattr(request.app.state, "status_cfg_for_read", None)


@router.get("/ops/jobs/queues/summary")
def ops_aggregated_job_queues_summary(request: Request) -> Dict[str, Any]:
    """One sheet: status counts for every Celery queue from ``ops.worker_profiles`` (fallback: canonical queues)."""
    from src.vendor.massive.reader import count_job_massive_backfill_by_status

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No Postgres config", "rows": []}

    rows: List[Dict[str, Any]] = []
    seen: set[str] = set()
    reg = getattr(request.app.state, "worker_profile_registry", None)
    if reg is not None and getattr(reg, "profiles", None):
        for pk, prof in reg.profiles.items():
            qlist = prof.queues if isinstance(prof.queues, list) else []
            base_label = str(prof.label or pk).strip()
            multi = len(qlist) > 1
            for q in qlist:
                qn = str(q).strip()
                if not qn or qn in seen:
                    continue
                seen.add(qn)
                if multi:
                    label = f"{base_label} ({qn})" if base_label else qn
                else:
                    label = base_label or qn
                if qn == "bars":
                    counts = count_job_bars_backfill_by_status(db)
                    rows.append(
                        {
                            "profile_key": str(pk),
                            "label": label,
                            "celery_queue": qn,
                            "pipeline": "bars",
                            "counts": counts,
                        },
                    )
                else:
                    counts = count_job_massive_backfill_by_status(db, celery_queue=qn)
                    rows.append(
                        {
                            "profile_key": str(pk),
                            "label": label,
                            "celery_queue": qn,
                            "pipeline": "massive",
                            "counts": counts,
                        },
                    )

    if not rows:
        from backend.ops.services.worker_state import SUPPORTED_CELERY_QUEUES

        for qn in SUPPORTED_CELERY_QUEUES:
            label = _FALLBACK_QUEUE_LABELS.get(qn, qn)
            if qn == "bars":
                counts = count_job_bars_backfill_by_status(db)
                rows.append(
                    {
                        "profile_key": "ib" if qn == "bars" else qn,
                        "label": label,
                        "celery_queue": qn,
                        "pipeline": "bars",
                        "counts": counts,
                    },
                )
            else:
                counts = count_job_massive_backfill_by_status(db, celery_queue=qn)
                rows.append(
                    {
                        "profile_key": qn,
                        "label": label,
                        "celery_queue": qn,
                        "pipeline": "massive",
                        "counts": counts,
                    },
                )

    return {"ok": True, "rows": rows}


# --- Bars (job_bars_backfill) ---


@router.get("/ops/bars/jobs")
def ops_get_bars_jobs(
    request: Request,
    limit: int = Query(20, ge=0, le=500),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None, description="Filter: pending, running, done, failed"),
) -> Dict[str, Any]:
    db_config = _db_config(request)
    if not db_config:
        logger.info("GET /ops/bars/jobs: no Postgres config, returning empty list")
        return {"jobs": [], "total": 0, "error": "No Postgres config. Set postgres in config or PGHOST."}
    effective_limit = limit if limit and limit > 0 else 500
    try:
        rows, total = get_job_bars_backfill_list(
            db_config, limit=effective_limit, offset=offset, status=status
        )
    except Exception as e:
        logger.warning("GET /ops/bars/jobs: get_job_bars_backfill_list failed: %s", e)
        return {"jobs": [], "total": 0, "error": str(e)}
    list_jobs = [_job_row_to_api(r) for r in rows]
    return {"jobs": list_jobs, "total": total}


@router.get("/ops/bars/jobs/summary")
def ops_bars_jobs_summary(request: Request) -> Dict[str, Any]:
    """Aggregated status counts for ``job_bars_backfill``."""
    db_config = _db_config(request)
    if not db_config:
        return {"ok": False, "error": "No Postgres config", "counts": {}}
    try:
        counts = count_job_bars_backfill_by_status(db_config)
    except Exception as e:
        logger.warning("GET /ops/bars/jobs/summary failed: %s", e)
        return {"ok": False, "error": str(e), "counts": {}}
    return {"ok": True, "counts": counts}


@router.post("/ops/bars/jobs/clear-done")
def ops_bars_jobs_clear_done(request: Request) -> Any:
    """Delete all rows with status ``done`` in ``job_bars_backfill``."""
    denied = _require_role(request, "operator")
    if denied:
        return denied
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = delete_all_job_bars_backfill(control_via_db, status_filter="done")
    return {"ok": True, "deleted": deleted}


@router.post("/ops/bars/jobs/retry-failed")
async def ops_retry_failed_bars_jobs(
    request: Request,
    limit: int = Query(100, ge=1, le=500, description="Max failed jobs to reset (oldest first)"),
) -> Any:
    """Reset failed jobs to pending and re-submit Celery tasks (same job IDs).

    Must be ``async`` so this handler runs on uvicorn's event-loop thread. Sync handlers run in an
    AnyIO worker thread with no asyncio loop; ``reenqueue_bars_backfill_from_row`` imports
    ``src.bars.tasks`` (ib_insync / eventkit) which expects a current loop in Python 3.10+.
    """
    denied = _require_role(request, "operator")
    if denied:
        return denied
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "No DB", "reset": 0, "enqueued": 0, "enqueue_errors": []}
    rows = reset_failed_jobs_bars_backfill_to_pending_batch(control_via_db, limit)
    enqueued = 0
    enqueue_errors: List[Dict[str, str]] = []
    for row in rows:
        ok, err = reenqueue_bars_backfill_from_row(control_via_db, row)
        if ok:
            enqueued += 1
        else:
            enqueue_errors.append(
                {"job_id": str(row.get("job_bars_backfill_id", "")), "error": err or "unknown"}
            )
    return {
        "ok": True,
        "reset": len(rows),
        "enqueued": enqueued,
        "enqueue_errors": enqueue_errors,
    }


@router.post("/ops/bars/jobs/{job_id}/retry")
async def ops_retry_one_bars_job(request: Request, job_id: str) -> Any:
    """Reset one failed job to pending and re-submit its Celery task.

    Async for the same reason as ``ops_retry_failed_bars_jobs`` (avoid AnyIO thread pool + ib_insync).
    """
    denied = _require_role(request, "operator")
    if denied:
        return denied
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "No DB"}
    row = reset_failed_job_bars_backfill_to_pending(control_via_db, job_id)
    if row is None:
        return {"ok": False, "error": "Job not found or not in failed status"}
    row["status"] = "pending"
    row["result"] = None
    ok, err = reenqueue_bars_backfill_from_row(control_via_db, row)
    if not ok:
        return {"ok": False, "error": err or "Re-enqueue failed"}
    return {"ok": True, "job": _job_row_to_api(row)}


@router.get("/ops/bars/jobs/{job_id}")
def ops_get_bars_job(request: Request, job_id: str) -> Dict[str, Any]:
    db_config = _db_config(request)
    if not db_config:
        return {"ok": False, "error": "No DB"}
    job = get_job_bars_backfill(db_config, job_id)
    if job is None:
        return {"ok": False, "error": "Job not found"}
    return {"ok": True, "job": _job_row_to_api(job)}


@router.delete("/ops/bars/jobs/{job_id}")
def ops_delete_bars_job(request: Request, job_id: str) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "No DB"}
    if delete_job_bars_backfill(control_via_db, job_id):
        return {"ok": True}
    return {"ok": False, "error": "Delete failed"}


@router.delete("/ops/bars/jobs")
def ops_delete_all_bars_jobs(
    request: Request,
    status: Optional[str] = Query(None, description="If set, only delete jobs with this status"),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = delete_all_job_bars_backfill(control_via_db, status_filter=status)
    return {"ok": True, "deleted": deleted}


@router.post("/ops/bars/jobs/trim")
def ops_trim_bars_jobs(
    request: Request,
    keep: int = Query(200, ge=1, le=50000, description="Keep newest N bars backfill jobs by id; delete older rows"),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = trim_job_bars_backfill(control_via_db, keep=keep)
    return {"ok": True, "deleted": deleted}


# --- Massive (job_massive_backfill) ---


def _purge_all_massive_jobs_response(
    request: Request, status: Optional[str], celery_queue: Optional[str] = None,
) -> Dict[str, Any]:
    from src.vendor.massive.reader import delete_all_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = delete_all_job_massive_backfill(
        db, status_filter=status, celery_queue=celery_queue,
    )
    return {"ok": True, "deleted": deleted}


@router.get("/ops/research/massive/jobs")
def ops_list_massive_jobs(
    request: Request,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None, description="Filter by job status"),
    kind: Optional[str] = Query(None, description="Filter by job kind"),
    celery_queue: Optional[str] = Query(
        None,
        description="Filter by broker queue (massive, massive_high, massive_stocks, massive_stocks_high)",
    ),
) -> Dict[str, Any]:
    from src.vendor.massive.reader import list_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "jobs": []}
    rows = list_job_massive_backfill(
        db,
        limit=limit,
        offset=offset,
        status_filter=status,
        kind_filter=kind,
        celery_queue=celery_queue,
    )
    jobs = [_massive_job_to_api(dict(r)) for r in rows]
    return {"ok": True, "jobs": jobs}


@router.get("/ops/research/massive/jobs/summary")
def ops_massive_jobs_summary(
    request: Request,
    celery_queue: Optional[str] = Query(
        None,
        description="If set, counts only rows routed to this broker queue",
    ),
) -> Dict[str, Any]:
    """Aggregated status counts for ``job_massive_backfill`` (optionally per Celery queue slice)."""
    from src.vendor.massive.reader import count_job_massive_backfill_by_status

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "counts": {}}
    try:
        counts = count_job_massive_backfill_by_status(db, celery_queue=celery_queue)
    except Exception as e:
        logger.warning("GET /ops/research/massive/jobs/summary failed: %s", e)
        return {"ok": False, "error": str(e), "counts": {}}
    return {"ok": True, "counts": counts}


@router.post("/ops/research/massive/jobs/clear-done")
def ops_massive_jobs_clear_done(
    request: Request,
    celery_queue: Optional[str] = Query(
        None,
        description="If set, only delete done rows in this broker queue slice",
    ),
) -> Any:
    """Delete rows with status ``done`` (optionally scoped to one broker queue)."""
    denied = _require_role(request, "operator")
    if denied:
        return denied
    from src.vendor.massive.reader import delete_all_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = delete_all_job_massive_backfill(
        db, status_filter="done", celery_queue=celery_queue,
    )
    return {"ok": True, "deleted": deleted}


@router.post("/ops/research/massive/jobs/retry-failed")
async def ops_retry_failed_massive_jobs(
    request: Request,
    celery_queue: Optional[str] = Query(
        None,
        description="Only reset failed jobs in this broker queue slice (recommended)",
    ),
    limit: int = Query(200, ge=1, le=2000, description="Max failed jobs to reset (oldest first)"),
) -> Any:
    """Reset failed Massive jobs to pending and re-submit Celery tasks (same job IDs)."""
    denied = _require_role(request, "operator")
    if denied:
        return denied
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "No DB", "reset": 0, "enqueued": 0, "enqueue_errors": []}
    from src.massive.tasks import reenqueue_massive_job_from_row
    from src.vendor.massive.reader import reset_failed_job_massive_backfill_batch

    rows = reset_failed_job_massive_backfill_batch(control_via_db, celery_queue, limit)
    enqueued = 0
    enqueue_errors: List[Dict[str, str]] = []
    for row in rows:
        ok, err = reenqueue_massive_job_from_row(control_via_db, row)
        if ok:
            enqueued += 1
        else:
            enqueue_errors.append(
                {"job_id": str(row.get("job_massive_backfill_id", "")), "error": err or "unknown"},
            )
    return {
        "ok": True,
        "reset": len(rows),
        "enqueued": enqueued,
        "enqueue_errors": enqueue_errors,
    }


@router.post("/ops/research/massive/jobs/trim")
def ops_trim_massive_jobs(
    request: Request,
    keep: int = Query(200, ge=1, le=50000, description="Keep newest N jobs by id; delete older rows"),
    celery_queue: Optional[str] = Query(
        None,
        description="If set, trim only within this broker queue slice (same as GET filter)",
    ),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    from src.vendor.massive.reader import trim_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = trim_job_massive_backfill(db, keep=keep, celery_queue=celery_queue)
    return {"ok": True, "deleted": deleted}


@router.delete("/ops/research/massive/jobs")
def ops_delete_all_massive_jobs(
    request: Request,
    status: Optional[str] = Query(None, description="If set, only delete jobs with this status"),
    celery_queue: Optional[str] = Query(
        None,
        description="If set, only delete jobs routed to this broker queue",
    ),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    return _purge_all_massive_jobs_response(request, status, celery_queue=celery_queue)


@router.post("/ops/research/massive/jobs/purge")
def ops_purge_all_massive_jobs(
    request: Request,
    status: Optional[str] = Query(None, description="If set, only delete jobs with this status"),
    celery_queue: Optional[str] = Query(
        None,
        description="If set, only delete jobs routed to this broker queue",
    ),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    return _purge_all_massive_jobs_response(request, status, celery_queue=celery_queue)


@router.get("/ops/research/massive/jobs/{job_id}")
def ops_get_massive_job(request: Request, job_id: str) -> Dict[str, Any]:
    from src.vendor.massive.reader import get_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB"}
    job = get_job_massive_backfill(db, job_id)
    if job is None:
        return {"ok": False, "error": "Job not found"}
    return {"ok": True, "job": _massive_job_to_api(job)}


@router.delete("/ops/research/massive/jobs/{job_id}")
def ops_delete_massive_job(request: Request, job_id: str) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    from src.vendor.massive.reader import delete_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB"}
    if delete_job_massive_backfill(db, job_id):
        return {"ok": True}
    return {"ok": False, "error": "Delete failed"}
