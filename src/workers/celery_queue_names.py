"""Canonical Redis broker queue names for Celery (single source of truth).

Used by Ops queue summary, worker profiles, and UI — same strings as ``celery -Q`` lists.

Stock aggregate jobs use kind ``feed_stocks_aggregate`` (legacy ``stock_ohlc_sync``) on ``massive_stocks`` / ``massive_stocks_high``.

Option contract OHLC / pool jobs use kind ``feed_options_aggregate`` (legacy ``aggregates``) on ``massive`` / ``massive_high``.

Options last-trade / quotes / historical trades proxy jobs use kind ``feed_options_trades_quotes`` (legacy ``trades_quotes``) on ``massive`` / ``massive_high``.

Option reference contracts (list/detail/upsert/backfill) jobs use kind ``feed_option_contracts`` (legacy ``contracts``) on ``massive`` / ``massive_high``.

Full tickers reference universe sync uses kind ``feed_stocks_tickers_reference_universe`` (legacy ``ticker_reference_universe`` / ``stock_reference_universe``) on ``massive_stocks`` / ``massive_stocks_high``.

Ticker-reference overview jobs use kind ``feed_stocks_tickers_overview`` (legacy ``ticker_reference_overview`` / ``stock_reference_overview``) on ``massive_stocks`` / ``massive_stocks_high``.

Ticker-reference related-peers jobs use kind ``feed_stocks_tickers_related`` (legacy ``ticker_reference_related`` / ``stock_reference_related``) on ``massive_stocks`` / ``massive_stocks_high``.

Ticker types dictionary jobs (GET /v3/reference/tickers/types) use kind ``feed_stocks_tickers_types`` (legacy ``ticker_reference_ticker_types`` / ``ticker_reference_instrument_types`` / ``stock_reference_instrument_types``) on ``massive_stocks`` / ``massive_stocks_high``.

Display names in the monitor UI (see ``frontend/src/utils/celeryQueueLabels.ts``):
  * ``BROKER_QUEUE_MASSIVE_OPTIONS`` (``massive``) → "Massive options"
  * ``BROKER_QUEUE_MASSIVE_OPTIONS_HIGH`` (``massive_high``) → "Massive options (H)"
  * ``BROKER_QUEUE_MASSIVE_STOCKS`` / ``_HIGH`` → "Massive stocks" / "Massive stocks (H)"
  * ``BROKER_QUEUE_BARS`` → "Bars (IB)"
"""

from __future__ import annotations

from typing import Final, Tuple

# Redis LIST keys (stable for workers and broker).
BROKER_QUEUE_BARS: Final[str] = "bars"
BROKER_QUEUE_MASSIVE_STOCKS_HIGH: Final[str] = "massive_stocks_high"
BROKER_QUEUE_MASSIVE_STOCKS: Final[str] = "massive_stocks"
BROKER_QUEUE_MASSIVE_OPTIONS_HIGH: Final[str] = "massive_high"
BROKER_QUEUE_MASSIVE_OPTIONS: Final[str] = "massive"

# Order matches default multi-queue worker in scripts/systemd/run_celery.py
CANONICAL_BROKER_QUEUE_NAMES: Final[Tuple[str, ...]] = (
    BROKER_QUEUE_BARS,
    BROKER_QUEUE_MASSIVE_STOCKS_HIGH,
    BROKER_QUEUE_MASSIVE_STOCKS,
    BROKER_QUEUE_MASSIVE_OPTIONS_HIGH,
    BROKER_QUEUE_MASSIVE_OPTIONS,
)
