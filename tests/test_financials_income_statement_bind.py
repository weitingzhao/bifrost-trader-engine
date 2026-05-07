"""Income statement upsert bind order matches Massive v1 ``results[]`` keys."""

from datetime import date
from unittest.mock import MagicMock

from psycopg2.extras import Json

from src.research.sepa.financials_data import (
    _STOCK_INCOME_UPSERT_BIND_COLUMNS,
    _income_statement_bind_tuple,
    upsert_income_statement_rows,
)


def test_income_statement_sql_placeholder_matches_bind_columns():
    cur = MagicMock()
    row = {
        "tickers": ["ZZZ"],
        "period_end": "2025-06-28",
        "timeframe": "quarterly",
        "fiscal_year": 2025,
        "fiscal_quarter": 3,
        "revenue": 9.4e10,
    }
    upsert_income_statement_rows(cur, [row])
    sql, params = cur.execute.call_args[0]
    assert sql.count("%s") == len(params)
    assert len(params) == len(_STOCK_INCOME_UPSERT_BIND_COLUMNS)


def test_income_statement_named_slots_align_results_keys():
    row = {
        "tickers": ["TST", "TST.CL"],
        "period_end": "2025-06-28",
        "timeframe": "quarterly",
        "fiscal_year": 2025,
        "fiscal_quarter": 3,
        "gross_profit": 111.0,
        "operating_income": 222.0,
        "total_operating_expenses": 333.0,
    }
    bind = _income_statement_bind_tuple(
        row,
        sym="TST",
        tf="quarterly",
        pe=date(2025, 6, 28),
        fd=None,
        fy=2025,
        fq=3,
        cik_v="0000320193",
        source="massive",
    )
    cols = _STOCK_INCOME_UPSERT_BIND_COLUMNS
    assert bind[cols.index("gross_profit")] == 111.0
    assert bind[cols.index("operating_income")] == 222.0
    assert bind[cols.index("total_operating_expenses")] == 333.0
    tk = bind[cols.index("tickers")]
    assert isinstance(tk, Json)
    assert tk.adapted == ["TST", "TST.CL"]
