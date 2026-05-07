"""Massive v1 ratios upsert bind order matches ``results[]`` keys."""

from datetime import date
from unittest.mock import MagicMock

from src.research.sepa.financials_data import (
    _STOCK_RATIOS_UPSERT_BIND_COLUMNS,
    _ratios_bind_tuple,
    upsert_ratios_rows,
)


def test_ratios_sql_placeholder_matches_bind_columns():
    cur = MagicMock()
    row = {
        "ticker": "TST",
        "date": "2024-09-19",
        "price": 228.87,
        "price_to_earnings": 34.84,
    }
    upsert_ratios_rows(cur, [row])
    sql, params = cur.execute.call_args[0]
    assert sql.count("%s") == len(params)
    assert len(params) == len(_STOCK_RATIOS_UPSERT_BIND_COLUMNS)


def test_ratios_named_slots_align_results_keys():
    row = {
        "ticker": "TST",
        "date": "2024-09-19",
        "cash": 0.19,
        "current": 0.68,
        "debt_to_equity": 1.52,
    }
    cols = _STOCK_RATIOS_UPSERT_BIND_COLUMNS
    bind = _ratios_bind_tuple(
        row,
        sym="TST",
        d=date(2024, 9, 19),
        cik_v=None,
        source="massive",
    )
    assert bind[cols.index("cash")] == 0.19
    assert bind[cols.index("current")] == 0.68
    assert bind[cols.index("debt_to_equity")] == 1.52
