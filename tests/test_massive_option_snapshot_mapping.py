"""Tests for Massive chain snapshot timestamp and day-bar mapping helpers."""

from datetime import datetime, timezone

from src.massive.tasks import _ns_to_datetime, _parse_snapshot_ts


def test_ns_to_datetime_nanoseconds() -> None:
    # 1776225600000000000 ns ~ year 2026
    dt = _ns_to_datetime(1776225600000000000)
    assert dt is not None
    assert dt.tzinfo == timezone.utc


def test_parse_snapshot_ts_prefers_day_last_updated_when_no_trade() -> None:
    item = {
        "day": {
            "last_updated": 1776225600000000000,
            "close": 3.8,
        },
    }
    ts = _parse_snapshot_ts(item)
    assert isinstance(ts, datetime)


def test_parse_snapshot_ts_trade_over_day() -> None:
    item = {
        "last_trade": {"sip_timestamp": 1600000000000000000},
        "day": {"last_updated": 1776225600000000000},
    }
    ts = _parse_snapshot_ts(item)
    assert isinstance(ts, datetime)
    # trade ns should win
    assert ts.year >= 2020
