"""SSOT for ``run_massive_job`` kind/mode combinations and broker queue routing (with tests).

Queue columns use :func:`celery_queue_for_massive_job` — same logic as Massive API enqueue.
Mode is for documentation/UI only; routing depends on ``kind`` only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from src.massive.celery_queues import (
    STOCK_OHLC_SYNC_KINDS,
    TICKER_REFERENCE_KINDS,
    celery_queue_for_massive_job,
)


@dataclass(frozen=True)
class RunMassiveJobMatrixRow:
    kind: str
    mode: Optional[str]
    mode_source: str
    broker_queue_standard: str
    broker_queue_high: str

    def to_api_dict(self) -> Dict[str, Any]:
        return {
            "kind": self.kind,
            "mode": self.mode,
            "mode_source": self.mode_source,
            "broker_queue_standard": self.broker_queue_standard,
            "broker_queue_high": self.broker_queue_high,
        }


def queue_for_row(kind: str, mode: Optional[str], *, priority_high: bool) -> str:
    """Broker queue for a matrix row; ``mode`` is ignored (same as Massive API routing)."""
    del mode
    return celery_queue_for_massive_job(kind, priority_high=priority_high)


def _qpair(kind: str) -> Tuple[str, str]:
    return (
        celery_queue_for_massive_job(kind, priority_high=False),
        celery_queue_for_massive_job(kind, priority_high=True),
    )


def _row(kind: str, mode: Optional[str], mode_source: str) -> RunMassiveJobMatrixRow:
    qs, qh = _qpair(kind)
    return RunMassiveJobMatrixRow(
        kind=kind,
        mode=mode,
        mode_source=mode_source,
        broker_queue_standard=qs,
        broker_queue_high=qh,
    )


def build_run_massive_job_matrix() -> Tuple[RunMassiveJobMatrixRow, ...]:
    """All documented kind/mode combinations implemented in ``run_massive_job``."""
    rows: List[RunMassiveJobMatrixRow] = []

    # feed_option_snapshots — payload.mode (legacy payload.snapshot_type still accepted in worker)
    for m in ("chain", "contract", "unified"):
        rows.append(_row("feed_option_snapshots", m, "payload.mode"))

    # stock_ohlc_sync — payload.mode
    for m in ("custom_bars", "daily_market_summary", "daily_ticker_summary", "previous_day_bar"):
        rows.append(_row("stock_ohlc_sync", m, "payload.mode"))

    # aggregates — payload.mode
    for m in (
        "open_close",
        "option_day_pool_row_gap",
        "option_day_pool_column_fill",
        "prev",
        "option_min_pool_row_gap",
        "option_min_pool_column_fill",
        "option_snapshots_pool_contract_fill",
        "custom_bars",
    ):
        rows.append(_row("aggregates", m, "payload.mode"))

    # oi
    rows.append(_row("oi", "watchlist_eod", "payload.mode"))

    for k in ("eod_pipeline", "max_pain", "reconcile", "trim_jobs"):
        rows.append(_row(k, None, "n/a"))

    rows.append(_row("corporate_action", None, "n/a"))

    # contracts — payload.mode
    for m in ("list", "detail", "reference_upsert", "nullable_column_backfill"):
        rows.append(_row("contracts", m, "payload.mode"))

    # trades_quotes — payload.mode
    for m in ("last_trade", "quotes", "trades"):
        rows.append(_row("trades_quotes", m, "payload.mode"))

    # Ticker / stock reference — payload.mode where applicable (see tasks.py)
    overview_modes = ("all", "symbols", "missing", "stale")
    for k in TICKER_REFERENCE_KINDS:
        if k in (
            "ticker_reference_overview",
            "ticker_reference_related",
            "stock_reference_overview",
            "stock_reference_related",
        ):
            for m in overview_modes:
                rows.append(_row(k, m, "payload.mode"))
        else:
            rows.append(_row(k, None, "n/a"))

    return tuple(rows)


RUN_MASSIVE_JOB_MATRIX: Tuple[RunMassiveJobMatrixRow, ...] = build_run_massive_job_matrix()

# Top-level ``if kind ==`` branches in run_massive_job (for drift tests).
# Top-level ``kind`` values accepted by ``run_massive_job`` (before ``normalize_ticker_ref_kind``).
RUN_MASSIVE_JOB_TOP_LEVEL_KINDS: frozenset[str] = frozenset(
    {
        "feed_option_snapshots",
        "stock_ohlc_sync",
        "aggregates",
        "oi",
        "eod_pipeline",
        "max_pain",
        "reconcile",
        "trim_jobs",
        "corporate_action",
        "contracts",
        "trades_quotes",
    }
    | TICKER_REFERENCE_KINDS
    | STOCK_OHLC_SYNC_KINDS
)
