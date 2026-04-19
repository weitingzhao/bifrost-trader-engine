"""Ops Celery capabilities payload (matrix + canonical queues)."""

from __future__ import annotations


def test_build_celery_capabilities_payload_has_matrix_and_canonical_queues() -> None:
    import src.bars.tasks  # noqa: F401
    import src.massive.tasks  # noqa: F401
    from backend.ops.services.celery_capabilities import build_celery_capabilities_payload
    from src.workers.celery_app import app
    from src.workers.celery_queue_names import CANONICAL_BROKER_QUEUE_NAMES

    out = build_celery_capabilities_payload(app)
    assert out["ok"] is True
    assert out["canonical_broker_queues"] == list(CANONICAL_BROKER_QUEUE_NAMES)
    assert len(out["run_massive_job_matrix"]) >= 1
    assert out["run_massive_job_matrix"][0]["broker_queue_standard"]
    assert out["beat_tasks"] and len(out["beat_tasks"]) == 5
    assert out["registered_tasks"] and out["count"] == len(out["registered_tasks"])
    first = out["registered_tasks"][0]
    assert first["name"].startswith("src.")
    assert first["task_route_default_queue"] == first["default_queue"]
