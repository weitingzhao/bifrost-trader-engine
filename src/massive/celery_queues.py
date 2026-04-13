"""Celery queue names for Massive jobs.

Options sync uses ``massive`` / ``massive_high``. Ticker reference jobs use dedicated queues
``massive_stocks`` / ``massive_stocks_high`` so workers can scale or isolate pipelines without
sharing the same Redis list as options.
"""

from __future__ import annotations

from typing import Final

# Kinds routed to massive_stocks* (see run_massive_job + insert_job_massive_backfill).
TICKER_REFERENCE_KINDS: Final[frozenset[str]] = frozenset(
    {
        "ticker_reference_universe",
        "ticker_reference_overview",
        "ticker_reference_related",
        "ticker_reference_ticker_types",
        "ticker_reference_instrument_types",
        "stock_reference_universe",
        "stock_reference_overview",
        "stock_reference_related",
        "stock_reference_instrument_types",
    }
)

# Stock OHLC → PostgreSQL (Massive REST); same worker pool as reference for isolation from options.
STOCK_OHLC_SYNC_KINDS: Final[frozenset[str]] = frozenset({"stock_ohlc_sync"})

STOCK_REFERENCE_KINDS = TICKER_REFERENCE_KINDS  # backward compat for reader/tests

MASSIVE_STOCKS_QUEUE_KINDS: Final[frozenset[str]] = TICKER_REFERENCE_KINDS | STOCK_OHLC_SYNC_KINDS


def celery_queue_for_massive_job(kind: str, *, priority_high: bool) -> str:
    """Return broker queue for ``run_massive_job`` given job kind and API priority."""
    k = (kind or "").strip().lower()
    if k in MASSIVE_STOCKS_QUEUE_KINDS:
        return "massive_stocks_high" if priority_high else "massive_stocks"
    return "massive_high" if priority_high else "massive"
