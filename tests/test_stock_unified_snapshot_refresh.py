"""Tests for Massive unified snapshot → cache_stock_snapshot scalar flattening."""

from __future__ import annotations

from datetime import datetime, timezone

from src.research.sepa.stock_unified_snapshot_refresh import (
    _INSERT_COLS,
    row_tuple_for_unified_result,
)


def test_insert_cols_count_matches_row_tuple():
    batch = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
    row = {
        "ticker": "AAPL",
        "type": "stocks",
        "market_status": "closed",
        "name": "Apple Inc.",
        "session": {
            "open": 22.49,
            "high": 22.49,
            "low": 21.35,
            "close": 21.4,
            "previous_close": 22.45,
            "volume": 37,
            "change": -1.05,
            "change_percent": -4.67,
        },
        "last_minute": {
            "open": 412.1,
            "high": 412.1,
            "low": 412.05,
            "close": 412.05,
            "vwap": 412.0881,
            "volume": 610,
            "transactions": 26,
        },
    }
    tup = row_tuple_for_unified_result(row, batch)
    assert tup is not None
    assert len(tup) == len(_INSERT_COLS)
    assert tup[0] == "AAPL"
    assert tup[4] == "massive"
    assert tup[5] == "stocks"
    assert tup[6] == "closed"
    assert tup[7] == "Apple Inc."
    assert tup[8] == 22.49
    assert tup[23] == 412.1
    assert tup[30] == 26


def test_row_tuple_skips_option_contract():
    batch = datetime.now(timezone.utc)
    row = {"ticker": "O:SPY", "type": "options", "session": {}}
    assert row_tuple_for_unified_result(row, batch) is None
