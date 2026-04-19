"""Canonical Redis broker queue names for Celery (single source of truth).

Used by Ops queue summary, worker profiles, and UI — same strings as ``celery -Q`` lists.

Display names in the monitor UI (see ``frontend/src/utils/celeryQueueLabels.ts``):
  * ``BROKER_QUEUE_MASSIVE_OPTIONS`` (``massive``) → "Massive options"
  * ``BROKER_QUEUE_MASSIVE_OPTIONS_HIGH`` (``massive_high``) → "Massive options (high priority)"
  * ``BROKER_QUEUE_MASSIVE_STOCKS`` / ``_HIGH`` → "Massive stocks" / "(high priority)"
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
