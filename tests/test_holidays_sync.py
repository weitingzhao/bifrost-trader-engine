"""Unit tests for src.vendor.massive.holidays_sync — field parsing only.

The full DB upsert path is exercised against psycopg2 in integration; here we
just verify date/timestamp/status normalization helpers.
"""

from datetime import date, timezone

from src.vendor.massive.holidays_sync import (
    _normalize_status,
    _parse_date,
    _parse_iso,
)


def test_parse_date_basic():
    assert _parse_date("2024-11-28") == date(2024, 11, 28)
    assert _parse_date("2024-11-28T00:00:00Z") == date(2024, 11, 28)
    assert _parse_date(None) is None
    assert _parse_date("") is None
    assert _parse_date("not-a-date") is None
    assert _parse_date(date(2025, 1, 1)) == date(2025, 1, 1)


def test_parse_iso_handles_z_suffix():
    dt = _parse_iso("2024-11-29T18:00:00.000Z")
    assert dt is not None
    assert dt.tzinfo is not None
    assert dt.utcoffset() == timezone.utc.utcoffset(dt)
    assert dt.year == 2024 and dt.month == 11 and dt.day == 29
    assert dt.hour == 18

    assert _parse_iso(None) is None
    assert _parse_iso("") is None
    assert _parse_iso("garbage") is None


def test_normalize_status_variants():
    assert _normalize_status("closed") == "closed"
    assert _normalize_status("CLOSED") == "closed"
    assert _normalize_status("close") == "closed"
    assert _normalize_status("early-close") == "early-close"
    assert _normalize_status("Early_Close") == "early-close"
    assert _normalize_status("earlyclose") == "early-close"
    assert _normalize_status(None) is None
    assert _normalize_status("") is None
    # Unknown values pass through normalized to lowercase
    assert _normalize_status("Holiday") == "holiday"
