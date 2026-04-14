"""Unit tests for Massive stock daily smart range (gap-fill / full backfill)."""

from __future__ import annotations

from datetime import date
from unittest.mock import patch

from src.massive.stock_ohlc_daily_smart import (
    compute_daily_smart_range,
    date_to_utc_epoch_ms_day_end_inclusive,
    days_for_calendar_years,
    full_backfill_start_date,
    ms_to_ny_date,
)


def test_full_backfill_start_date_span() -> None:
    end_d = date(2026, 4, 10)
    years = 20.0
    start_d = full_backfill_start_date(end_d, full_backfill_years=years)
    assert (end_d - start_d).days == days_for_calendar_years(years)


def test_full_backfill_start_date_five_years() -> None:
    end_d = date(2026, 4, 10)
    start_d = full_backfill_start_date(end_d, full_backfill_years=5.0)
    assert (end_d - start_d).days == 5 * 365


def test_ms_to_ny_date_roundtrip() -> None:
    d = date(2026, 6, 3)
    ms = date_to_utc_epoch_ms_day_end_inclusive(d)
    assert ms_to_ny_date(ms) == d


def test_compute_daily_smart_full_policy() -> None:
    with patch(
        "src.massive.stock_ohlc_daily_smart.ny_calendar_today",
        return_value=date(2026, 6, 1),
    ):
        start_ms, end_ms, policy, meta = compute_daily_smart_range(
            {}, None, None, full_backfill_years=20.0
        )
    assert policy == "full_20y"
    assert meta["daily_sync_policy"] == "full_20y"
    assert meta["max_bar_date"] is None
    assert meta["full_backfill_years"] == 20.0
    assert start_ms < end_ms


def test_compute_daily_smart_gapfill_overlap() -> None:
    """2 trading-day overlap before calendar day after max_bar."""
    end_cap = date_to_utc_epoch_ms_day_end_inclusive(date(2026, 4, 15))
    max_bar = date(2026, 4, 1)

    def _always_trading(_cfg: dict, ds: str) -> bool:
        _ = _cfg
        d = date.fromisoformat(ds)
        return d.weekday() < 5

    with patch(
        "src.monitor.reader.market.get_is_us_trading_day",
        side_effect=_always_trading,
    ):
        start_ms, end_ms, policy, meta = compute_daily_smart_range(
            {}, max_bar, end_cap, full_backfill_years=5.0
        )
    assert policy == "gapfill_overlap"
    assert meta["daily_sync_policy"] == "gapfill_overlap"
    assert meta["max_bar_date"] == "2026-04-01"
    assert start_ms <= end_ms
    # gap_next_calendar = 2026-04-02; two trading days back from 2026-04-01 → 2026-03-31
    assert meta["resolved_start_date"] == "2026-03-31"
    assert meta["resolved_end_date"] == "2026-04-15"
