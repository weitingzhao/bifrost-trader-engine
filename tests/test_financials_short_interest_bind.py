"""Short interest upsert bind order matches Massive ``GET /stocks/v1/short-interest`` ``results[]`` keys."""

from datetime import date
from unittest.mock import MagicMock

from src.research.sepa.financials_data import (
    _STOCK_SHORT_INTEREST_UPSERT_BIND_COLUMNS,
    _short_interest_bind_tuple,
    upsert_short_interest_rows,
)


def test_short_interest_sql_placeholder_matches_bind_columns():
    cur = MagicMock()
    row = {
        "ticker": "TST",
        "settlement_date": "2025-03-14",
        "short_interest": 3906231,
        "avg_daily_volume": 2340158,
        "days_to_cover": 1.67,
    }
    upsert_short_interest_rows(cur, [row])
    sql, params = cur.execute.call_args[0]
    assert sql.count("%s") == len(params)
    assert len(params) == len(_STOCK_SHORT_INTEREST_UPSERT_BIND_COLUMNS)


def test_short_interest_named_slots_align_results_keys():
    row = {
        "ticker": "TST",
        "settlement_date": "2025-03-14",
        "short_interest": 100,
        "avg_daily_volume": 200,
        "days_to_cover": 0.5,
    }
    bind = _short_interest_bind_tuple(
        row,
        sym="TST",
        sd=date(2025, 3, 14),
        cik_v="0001090872",
        source="massive",
    )
    cols = _STOCK_SHORT_INTEREST_UPSERT_BIND_COLUMNS
    assert bind[cols.index("short_interest")] == 100
    assert bind[cols.index("avg_daily_volume")] == 200
    assert bind[cols.index("days_to_cover")] == 0.5
    assert bind[cols.index("cik")] == "0001090872"
