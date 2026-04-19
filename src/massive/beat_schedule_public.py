"""Single source of truth for Celery Beat schedules (Massive-related tasks).

Used by ``src.workers.celery_app`` and ``GET /research/massive/celery-beat-schedule``.
"""

from __future__ import annotations

from typing import Any, Dict, List

from celery.schedules import crontab

# Each entry: name, Celery task path, human label, kwargs for celery.schedules.crontab (UTC).
MASSIVE_BEAT_SCHEDULE_SPEC: List[Dict[str, Any]] = [
    {
        "name": "massive-eod-pipeline",
        "task": "src.massive.tasks.beat_eod_pipeline",
        "label": "EOD pipeline (OI + Max Pain)",
        "crontab_kwargs": {"hour": 22, "minute": 0},
    },
    {
        "name": "massive-corporate-watchlist",
        "task": "src.massive.tasks.beat_corporate_watchlist",
        "label": "Corporate actions (watchlist)",
        "crontab_kwargs": {"hour": 23, "minute": 0},
    },
    {
        "name": "massive-reconcile",
        "task": "src.massive.tasks.beat_reconcile",
        "label": "Reconcile (watchlist vs DB OI)",
        "crontab_kwargs": {"hour": 22, "minute": 45},
    },
    {
        "name": "massive-trim-jobs",
        "task": "src.massive.tasks.beat_trim_massive_jobs",
        "label": "Trim Massive job table",
        "crontab_kwargs": {"hour": 2, "minute": 15},
    },
    {
        "name": "massive-refresh-expirations",
        "task": "src.massive.tasks.beat_refresh_expirations",
        "label": "Refresh option expirations",
        "crontab_kwargs": {"hour": "*/6", "minute": 20},
    },
]


def build_celery_beat_schedule() -> Dict[str, Any]:
    """Return ``beat_schedule`` dict for ``app.conf.update(beat_schedule=...)``."""
    out: Dict[str, Any] = {}
    for spec in MASSIVE_BEAT_SCHEDULE_SPEC:
        name = str(spec["name"])
        kw = dict(spec["crontab_kwargs"])
        out[name] = {
            "task": str(spec["task"]),
            "schedule": crontab(**kw),
        }
    return out


def public_celery_beat_schedule_response() -> Dict[str, Any]:
    """JSON-serializable payload for Research API (no Celery runtime required)."""
    entries = []
    for spec in MASSIVE_BEAT_SCHEDULE_SPEC:
        entries.append(
            {
                "name": spec["name"],
                "task": spec["task"],
                "label": spec["label"],
                "crontab": dict(spec["crontab_kwargs"]),
            }
        )
    return {
        "ok": True,
        "timezone": "UTC",
        "entries": entries,
    }
