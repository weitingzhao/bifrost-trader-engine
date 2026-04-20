"""Routing of Massive Celery jobs to broker queues."""

from __future__ import annotations

from src.massive.celery_queues import (
    FEED_STOCKS_TICKERS_REFERENCE_UNIVERSE_KINDS,
    FEED_STOCKS_TICKERS_TYPES_KINDS,
    STOCK_REFERENCE_KINDS,
    celery_queue_for_massive_job,
)


def test_stock_kinds_use_massive_stocks_queues() -> None:
    for k in STOCK_REFERENCE_KINDS:
        assert celery_queue_for_massive_job(k, priority_high=False) == "massive_stocks"
        assert celery_queue_for_massive_job(k, priority_high=True) == "massive_stocks_high"


def test_feed_stocks_tickers_reference_universe_legacy_kinds_use_stocks_queues() -> None:
    for k in FEED_STOCKS_TICKERS_REFERENCE_UNIVERSE_KINDS:
        assert celery_queue_for_massive_job(k, priority_high=False) == "massive_stocks"
        assert celery_queue_for_massive_job(k, priority_high=True) == "massive_stocks_high"


def test_feed_stocks_tickers_types_legacy_kinds_use_stocks_queues() -> None:
    for k in FEED_STOCKS_TICKERS_TYPES_KINDS:
        assert celery_queue_for_massive_job(k, priority_high=False) == "massive_stocks"
        assert celery_queue_for_massive_job(k, priority_high=True) == "massive_stocks_high"


def test_option_kinds_use_options_queues() -> None:
    assert celery_queue_for_massive_job("feed_option_snapshots", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("feed_option_snapshots", priority_high=True) == "massive_high"
    assert celery_queue_for_massive_job("snapshot", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("feed_options_aggregate", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("aggregates", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("feed_options_trades_quotes", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("trades_quotes", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("feed_option_contracts", priority_high=False) == "massive"
    assert celery_queue_for_massive_job("contracts", priority_high=False) == "massive"


def test_feed_stocks_aggregate_uses_stocks_queues() -> None:
    assert celery_queue_for_massive_job("feed_stocks_aggregate", priority_high=False) == "massive_stocks"
    assert celery_queue_for_massive_job("feed_stocks_aggregate", priority_high=True) == "massive_stocks_high"
    assert celery_queue_for_massive_job("stock_ohlc_sync", priority_high=False) == "massive_stocks"
