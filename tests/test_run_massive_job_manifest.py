"""Manifest rows stay aligned with ``celery_queue_for_massive_job`` and documented job kinds."""

from __future__ import annotations

from src.massive.celery_queues import celery_queue_for_massive_job
from src.massive.run_massive_job_manifest import (
    RUN_MASSIVE_JOB_MATRIX,
    RUN_MASSIVE_JOB_TOP_LEVEL_KINDS,
    RUN_MASSIVE_JOB_CELERY_TASK_NAME,
    matrix_row_task_name_and_job_style,
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
    from src.massive.celery_queues import (
        FEED_OPTION_CONTRACTS_KINDS,
        FEED_OPTIONS_AGGREGATE_KINDS,
        FEED_OPTIONS_TRADES_QUOTES_KINDS,
        FEED_STOCKS_FINANCIALS_KINDS,
        FEED_STOCKS_TICKERS_REFERENCE_UNIVERSE_KINDS,
        FEED_STOCKS_TICKERS_TYPES_KINDS,
        MASSIVE_STOCKS_QUEUE_KINDS,
    )

    for k in MASSIVE_STOCKS_QUEUE_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS, f"missing stocks-queue kind: {k!r}"
    for k in FEED_OPTIONS_AGGREGATE_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS, f"missing options-aggregate kind: {k!r}"
    for k in FEED_OPTIONS_TRADES_QUOTES_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS, f"missing options trades-quotes kind: {k!r}"
    for k in FEED_OPTION_CONTRACTS_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS, f"missing option-contracts kind: {k!r}"
    for k in FEED_STOCKS_TICKERS_REFERENCE_UNIVERSE_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS, f"missing feed_stocks_tickers_reference_universe kind: {k!r}"
    for k in FEED_STOCKS_TICKERS_TYPES_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS, f"missing feed_stocks_tickers_types kind: {k!r}"
    for k in ("feed_option_snapshots", "feed_stocks_aggregate", "feed_options_aggregate", "feed_option_contracts", "feed_options_trades_quotes", "oi"):
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS
    for k in FEED_STOCKS_FINANCIALS_KINDS:
        assert k in RUN_MASSIVE_JOB_TOP_LEVEL_KINDS


def test_matrix_api_dict_includes_task_name_and_job_style() -> None:
    eod = next(r for r in RUN_MASSIVE_JOB_MATRIX if r.kind == "eod_pipeline")
    d = eod.to_api_dict()
    assert d["job_style"] == "scheduled"
    assert d["task_name"] == "src.massive.tasks.beat_eod_pipeline"
    agg = next(r for r in RUN_MASSIVE_JOB_MATRIX if r.kind == "feed_options_aggregate")
    d2 = agg.to_api_dict()
    assert d2["job_style"] == "on_demand"
    assert d2["task_name"] == RUN_MASSIVE_JOB_CELERY_TASK_NAME


def test_matrix_row_task_name_mapping_covers_beat_kinds() -> None:
    assert matrix_row_task_name_and_job_style("trim_jobs")[1] == "scheduled"
    assert matrix_row_task_name_and_job_style("reconcile")[1] == "scheduled"
    assert matrix_row_task_name_and_job_style("feed_stocks_corporate_action")[1] == "scheduled"
