"""Manifest rows stay aligned with ``celery_queue_for_massive_job`` and documented job kinds."""

from __future__ import annotations

from src.massive.celery_queues import celery_queue_for_massive_job
from src.massive.run_massive_job_manifest import (
    RUN_MASSIVE_JOB_MATRIX,
    RUN_MASSIVE_JOB_TOP_LEVEL_KINDS,
    queue_for_row,
)


def test_matrix_queues_match_celery_router() -> None:
    for row in RUN_MASSIVE_JOB_MATRIX:
        assert (
            row.broker_queue_standard
            == celery_queue_for_massive_job(row.kind, priority_high=False)
        )
        assert (
            row.broker_queue_high
            == celery_queue_for_massive_job(row.kind, priority_high=True)
        )
        assert row.broker_queue_standard == queue_for_row(
            row.kind, row.mode, priority_high=False
        )
        assert row.broker_queue_high == queue_for_row(
            row.kind, row.mode, priority_high=True
        )


def test_matrix_kinds_are_known_top_level_kinds() -> None:
    kinds_in_matrix = {r.kind for r in RUN_MASSIVE_JOB_MATRIX}
    unknown = kinds_in_matrix - RUN_MASSIVE_JOB_TOP_LEVEL_KINDS
    assert not unknown, f"matrix kinds not in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS: {unknown}"


def test_top_level_kinds_cover_celery_routing_universe() -> None:
    """``RUN_MASSIVE_JOB_TOP_LEVEL_KINDS`` must list every kind string that routes via ``celery_queue_for_massive_job``."""
    from src.massive.celery_queues import MASSIVE_STOCKS_QUEUE_KINDS

    for k in MASSIVE_STOCKS_QUEUE_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS, f"missing stocks-queue kind: {k!r}"
    for k in ("feed_option_snapshots", "aggregates", "contracts", "trades_quotes", "oi"):
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS
