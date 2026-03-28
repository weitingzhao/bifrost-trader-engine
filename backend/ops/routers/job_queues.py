"""Bars and Massive Celery job tables — moved from main server / Massive API to Ops."""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Query, Request

from backend.massive.routers.routes import _massive_job_to_api
from backend.ops.routers.workers import _require_role
from src.monitor.reader import (
    delete_all_job_bars_backfill,
    delete_job_bars_backfill,
    get_job_bars_backfill,
    get_job_bars_backfill_list,
    trim_job_bars_backfill,
)
from src.monitor.services.market_jobs import job_row_to_api as _job_row_to_api

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ops-job-queues"])


def _db_config(request: Request) -> Optional[dict]:
    return request.app.state.control_via_db or getattr(request.app.state, "status_cfg_for_read", None)


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


def _purge_all_massive_jobs_response(request: Request, status: Optional[str]) -> Dict[str, Any]:
    from src.vendor.massive.reader import delete_all_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = delete_all_job_massive_backfill(db, status_filter=status)
    return {"ok": True, "deleted": deleted}


@router.get("/ops/research/massive/jobs")
def ops_list_massive_jobs(
    request: Request,
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    status: Optional[str] = Query(None, description="Filter by job status"),
    kind: Optional[str] = Query(None, description="Filter by job kind"),
) -> Dict[str, Any]:
    from src.vendor.massive.reader import list_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "jobs": []}
    rows = list_job_massive_backfill(
        db, limit=limit, offset=offset, status_filter=status, kind_filter=kind
    )
    jobs = [_massive_job_to_api(dict(r)) for r in rows]
    return {"ok": True, "jobs": jobs}


@router.post("/ops/research/massive/jobs/trim")
def ops_trim_massive_jobs(
    request: Request,
    keep: int = Query(200, ge=1, le=50000, description="Keep newest N jobs by id; delete older rows"),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    from src.vendor.massive.reader import trim_job_massive_backfill

    db = _db_config(request)
    if not db:
        return {"ok": False, "error": "No DB", "deleted": 0}
    deleted = trim_job_massive_backfill(db, keep=keep)
    return {"ok": True, "deleted": deleted}


@router.delete("/ops/research/massive/jobs")
def ops_delete_all_massive_jobs(
    request: Request,
    status: Optional[str] = Query(None, description="If set, only delete jobs with this status"),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    return _purge_all_massive_jobs_response(request, status)


@router.post("/ops/research/massive/jobs/purge")
def ops_purge_all_massive_jobs(
    request: Request,
    status: Optional[str] = Query(None, description="If set, only delete jobs with this status"),
) -> Any:
    denied = _require_role(request, "operator")
    if denied:
        return denied
    return _purge_all_massive_jobs_response(request, status)


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
