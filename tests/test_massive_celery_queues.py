"""Routing of Massive Celery jobs to broker queues."""

from __future__ import annotations

from src.massive.celery_queues import STOCK_REFERENCE_KINDS, celery_queue_for_massive_job


def test_stock_kinds_use_massive_stocks_queues() -> None:
    for k in STOCK_REFERENCE_KINDS:
        assert celery_queue_for_massive_job(k, priority_high=False) == "massive_stocks"
        assert celery_queue_for_massive_job(k, priority_high=True) == "massive_stocks_high"


def test_option_kinds_use_options_queues() -> None:
    assert celery_queue_for_massive_job("feed_option_snapshots", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("feed_option_snapshots", priority_high=True) == "massive_high"
    assert celery_queue_for_massive_job("snapshot", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("aggregates", priority_high=False) == "massive"


def test_stock_ohlc_sync_uses_stocks_queues() -> None:
    assert celery_queue_for_massive_job("stock_ohlc_sync", priority_high=False) == "massive_stocks"
    assert celery_queue_for_massive_job("stock_ohlc_sync", priority_high=True) == "massive_stocks_high"
