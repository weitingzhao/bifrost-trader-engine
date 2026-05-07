"""Balance sheet upsert bind order matches Massive v1 ``results[]`` keys."""

from datetime import date
from unittest.mock import MagicMock

from src.research.sepa.financials_data import (
    _STOCK_BALANCE_UPSERT_BIND_COLUMNS,
    _balance_sheet_bind_tuple,
    upsert_balance_sheet_rows,
)


def test_balance_sheet_sql_placeholder_matches_bind_columns():
    cur = MagicMock()
    row = {
        "tickers": ["ZZZ"],
        "period_end": "2025-06-28",
        "timeframe": "quarterly",
        "fiscal_year": 2025,
        "fiscal_quarter": 3,
        "total_assets": 3.31e11,
    }
    upsert_balance_sheet_rows(cur, [row])
    sql, params = cur.execute.call_args[0]
    assert sql.count("%s") == len(params)
    assert len(params) == len(_STOCK_BALANCE_UPSERT_BIND_COLUMNS)


def test_balance_sheet_named_slots_align_results_keys():
    row = {
        "tickers": ["TST"],
        "period_end": "2025-06-28",
        "timeframe": "quarterly",
        "fiscal_year": 2025,
        "fiscal_quarter": 3,
        "accounts_payable": 111.0,
        "total_liabilities": 222.0,
        "treasury_stock": 333.0,
    }
    bind = _balance_sheet_bind_tuple(
        row,
        sym="TST",
        tf="quarterly",
        pe=date(2025, 6, 28),
        fd=None,
        fy=2025,
        fq=3,
        cik_v=None,
        source="massive",
    )
    cols = _STOCK_BALANCE_UPSERT_BIND_COLUMNS
    assert bind[cols.index("accounts_payable")] == 111.0
    assert bind[cols.index("total_liabilities")] == 222.0
    assert bind[cols.index("treasury_stock")] == 333.0
