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

Display names: prefer ``broker_queue_labels`` from GET /ops/celery/capabilities (from ``ops.worker_profiles``); fallback in ``frontend/src/utils/celeryQueueLabels.ts``.
"""

from __future__ import annotations

import logging
from typing import Dict, Final, List, Optional, Tuple

logger = logging.getLogger(__name__)

# Redis LIST keys (stable for workers and broker).
BROKER_QUEUE_BARS: Final[str] = "bars"
BROKER_QUEUE_MASSIVE_STOCKS_HIGH: Final[str] = "massive_stocks_high"
BROKER_QUEUE_MASSIVE_STOCKS: Final[str] = "massive_stocks"
BROKER_QUEUE_MASSIVE_OPTIONS_HIGH: Final[str] = "massive_high"
BROKER_QUEUE_MASSIVE_OPTIONS: Final[str] = "massive"

# Default order when ``ops.celery.canonical_queue_order`` is absent (tests, tools without merged YAML).
CANONICAL_BROKER_QUEUE_NAMES: Final[Tuple[str, ...]] = (
    BROKER_QUEUE_BARS,
    BROKER_QUEUE_MASSIVE_STOCKS_HIGH,
    BROKER_QUEUE_MASSIVE_STOCKS,
    BROKER_QUEUE_MASSIVE_OPTIONS_HIGH,
    BROKER_QUEUE_MASSIVE_OPTIONS,
)


def load_canonical_broker_queue_names(config: Optional[dict]) -> Tuple[str, ...]:
    """Return ordered broker queue keys for default multi-queue worker and Ops summaries.

    Reads ``ops.celery.canonical_queue_order``; falls back to :data:`CANONICAL_BROKER_QUEUE_NAMES`.
    """
    if not config or not isinstance(config, dict):
        return CANONICAL_BROKER_QUEUE_NAMES
    ops = config.get("ops") or {}
    if not isinstance(ops, dict):
        return CANONICAL_BROKER_QUEUE_NAMES
    celery = ops.get("celery") or {}
    if not isinstance(celery, dict):
        return CANONICAL_BROKER_QUEUE_NAMES
    raw = celery.get("canonical_queue_order")
    if raw is None:
        return CANONICAL_BROKER_QUEUE_NAMES
    if not isinstance(raw, list):
        logger.warning("ops.celery.canonical_queue_order must be a list; using default canonical queues")
        return CANONICAL_BROKER_QUEUE_NAMES
    out: List[str] = []
    for x in raw:
        s = str(x).strip()
        if s:
            out.append(s)
    if not out:
        return CANONICAL_BROKER_QUEUE_NAMES
    return tuple(out)


def _queues_declared_in_worker_profiles(ops: dict) -> Tuple[str, ...]:
    """Union of all ``queues`` entries under ``ops.worker_profiles`` (stable order not guaranteed)."""
    raw = ops.get("worker_profiles") or {}
    if not isinstance(raw, dict):
        return ()
    seen: List[str] = []
    for _pk, ent in raw.items():
        if not isinstance(ent, dict):
            continue
        qs = ent.get("queues") or []
        if isinstance(qs, str):
            qs = [qs]
        for q in qs:
            s = str(q).strip()
            if s and s not in seen:
                seen.append(s)
    return tuple(seen)


def ops_celery_config_validation_errors(config: Optional[dict]) -> List[str]:
    """Return human-readable issues when ``canonical_queue_order`` and ``worker_profiles`` disagree."""
    errors: List[str] = []
    if not config or not isinstance(config, dict):
        return errors
    ops = config.get("ops") or {}
    if not isinstance(ops, dict):
        return errors
    celery = ops.get("celery") or {}
    if not isinstance(celery, dict):
        return errors
    order = celery.get("canonical_queue_order")
    if order is None:
        return errors
    if not isinstance(order, list):
        errors.append("ops.celery.canonical_queue_order must be a list of queue name strings")
        return errors
    profile_queues = set(_queues_declared_in_worker_profiles(ops))
    for x in order:
        qn = str(x).strip()
        if not qn:
            continue
        if profile_queues and qn not in profile_queues:
            errors.append(
                f"canonical_queue_order entry {qn!r} is not listed under ops.worker_profiles[*].queues",
            )
    return errors


def build_broker_queue_labels_from_worker_profiles(config: Optional[dict]) -> Dict[str, str]:
    """Map broker queue key → profile label from ``ops.worker_profiles`` (first profile wins on conflict)."""
    out: Dict[str, str] = {}
    if not config or not isinstance(config, dict):
        return out
    ops = config.get("ops") or {}
    if not isinstance(ops, dict):
        return out
    raw = ops.get("worker_profiles") or {}
    if not isinstance(raw, dict):
        return out
    for _pk, ent in raw.items():
        if not isinstance(ent, dict):
            continue
        label = str(ent.get("label", "")).strip() or str(_pk)
        qs = ent.get("queues") or []
        if isinstance(qs, str):
            qs = [qs]
        for q in qs:
            qn = str(q).strip()
            if not qn:
                continue
            if qn in out and out[qn] != label:
                logger.warning(
                    "Duplicate broker queue %r in worker_profiles with different labels (%r vs %r); keeping first",
                    qn,
                    out[qn],
                    label,
                )
                continue
            if qn not in out:
                out[qn] = label
    return out
