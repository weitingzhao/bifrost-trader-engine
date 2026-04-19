"""Aggregate Celery self-description: task routes, canonical broker queues, ``run_massive_job`` matrix."""

from __future__ import annotations

from typing import Any, Dict, List

from backend.ops.services.celery_supported_tasks import build_supported_tasks_payload
from src.massive.run_massive_job_manifest import RUN_MASSIVE_JOB_MATRIX
from src.workers.celery_queue_names import CANONICAL_BROKER_QUEUE_NAMES


def build_celery_capabilities_payload(celery_app: Any) -> Dict[str, Any]:
    """Return registered tasks + canonical queue names + ``run_massive_job`` kind/mode matrix + beat tasks."""
    base = build_supported_tasks_payload(celery_app)
    registered: List[Dict[str, str]] = []
    for t in base.get("tasks") or []:
        if not isinstance(t, dict):
            continue
        name = str(t.get("name") or "")
        dq = str(t.get("default_queue") or t.get("task_route_default_queue") or "")
        registered.append(
            {
                "name": name,
                "default_queue": dq,
                "task_route_default_queue": dq,
            }
        )

    # Notes: business intent only — routing (task_routes queue) and Beat vs on-demand are in other columns.
    beat_tasks: List[Dict[str, str]] = [
        {
            "name": "src.massive.tasks.beat_eod_pipeline",
            "note": "Inserts eod_pipeline job: watchlist EOD OI + max pain for the trade date.",
        },
        {
            "name": "src.massive.tasks.beat_corporate_watchlist",
            "note": "Inserts corporate_action job with all watchlist optionable STK symbols.",
        },
        {
            "name": "src.massive.tasks.beat_reconcile",
            "note": "Inserts reconcile job: watchlist vs DB open-interest counts.",
        },
        {
            "name": "src.massive.tasks.beat_trim_massive_jobs",
            "note": "Inserts trim_jobs: cap job_massive_backfill history (newest 500 rows).",
        },
        {
            "name": "src.massive.tasks.beat_refresh_expirations",
            "note": "Runs expiration cache + option_contracts refresh in-process; not a run_massive_job enqueue.",
        },
    ]

    matrix = [r.to_api_dict() for r in RUN_MASSIVE_JOB_MATRIX]

    out: Dict[str, Any] = {
        "ok": bool(base.get("ok")),
        "registered_tasks": registered,
        "count": len(registered),
        "canonical_broker_queues": list(CANONICAL_BROKER_QUEUE_NAMES),
        "run_massive_job_matrix": matrix,
        "beat_tasks": beat_tasks,
    }
    return out
