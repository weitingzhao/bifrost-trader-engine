"""Tests for GET /research/option-snapshots row helpers (mark, snapshot_ts)."""

from datetime import datetime, timezone

from backend.research.routers.option_discovery import _mark_from_snapshot_row, _snapshot_ts_iso


def test_mark_prefers_mid() -> None:
    assert _mark_from_snapshot_row({"mid": 2.0}) == 2.0


def test_mark_bid_ask_midpoint() -> None:
    assert _mark_from_snapshot_row({"bid": 1.0, "ask": 3.0}) == 2.0


def test_mark_last() -> None:
    assert _mark_from_snapshot_row({"last": 1.25}) == 1.25


def test_mark_day_close() -> None:
    assert _mark_from_snapshot_row({"day_close": 9.99}) == 9.99


def test_mark_empty() -> None:
    assert _mark_from_snapshot_row({}) is None


def test_snapshot_ts_iso_datetime() -> None:
    dt = datetime(2026, 4, 16, 12, 0, 0, tzinfo=timezone.utc)
    assert _snapshot_ts_iso({"snapshot_ts": dt}) == "2026-04-16T12:00:00+00:00"


def test_snapshot_ts_iso_none() -> None:
    assert _snapshot_ts_iso({}) is None
