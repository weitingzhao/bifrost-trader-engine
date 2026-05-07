"""Cash-flow ingest maps Massive v1 JSON keys (including negatives) into PG columns."""

from datetime import date
from unittest.mock import MagicMock

from src.research.sepa.financials_data import (
    _STOCK_CASH_FLOW_UPSERT_BIND_COLUMNS,
    _cash_flow_bind_tuple,
    _f_any,
    _normalize_massive_statement_timeframe,
    _normalize_sec_cik,
    upsert_cash_flow_rows,
)


def test_normalize_massive_statement_timeframe_ttm_alias():
    assert _normalize_massive_statement_timeframe(None) == "quarterly"
    assert _normalize_massive_statement_timeframe("") == "quarterly"
    assert _normalize_massive_statement_timeframe("TTM") == "trailing_twelve_months"
    assert _normalize_massive_statement_timeframe("trailing_twelve_months") == "trailing_twelve_months"
    assert _normalize_massive_statement_timeframe("quarterly") == "quarterly"


def test_normalize_sec_cik_zero_pads_numeric_json():
    assert _normalize_sec_cik("0001090872") == "0001090872"
    assert _normalize_sec_cik(1090872) == "0001090872"


def test_f_any_preserves_negative_and_zero():
    assert _f_any({"net_cash_from_operating_activities": -46500000}, "net_cash_from_operating_activities") == -46500000.0
    assert _f_any({"a": 0, "b": 99}, "a", "b") == 0.0
    assert _f_any({"x": -1}, "missing", "x") == -1.0


def test_massive_v1_cash_flow_aliases():
    row = {
        "net_cash_from_operating_activities": 54500000,
        "net_cash_from_investing_activities": -47900000,
        "net_cash_from_financing_activities": -53100000,
        "change_in_cash_and_equivalents": -46500000,
        "purchase_of_property_plant_and_equipment": -25900000,
        "depreciation_depletion_and_amortization": 56200000,
    }
    assert _f_any(row, "net_cash_from_operating_activities") == 54500000.0
    assert _f_any(
        row,
        "net_cash_from_operating_activities",
        "net_cash_flow_from_operating_activities",
    ) == 54500000.0
    assert _f_any(
        row,
        "change_in_cash_and_equivalents",
        "net_change_in_cash_and_equivalents",
    ) == -46500000.0
    assert _f_any(row, "purchase_of_property_plant_and_equipment", "capital_expenditure") == -25900000.0


def test_upsert_cash_flow_sql_bind_count_matches_params():
    """Regression: psycopg2 raises tuple index out of range if %s count != len(params)."""
    cur = MagicMock()
    row = {
        "tickers": ["ZZZ"],
        "period_end": "2025-06-28",
        "timeframe": "quarterly",
        "fiscal_year": 2025,
        "fiscal_quarter": 3,
        "net_cash_from_operating_activities": 1.0,
    }
    upsert_cash_flow_rows(cur, [row])
    assert cur.execute.called
    sql, params = cur.execute.call_args[0]
    assert sql.count("%s") == len(params), (sql.count("%s"), len(params))


def test_cash_flow_bind_slots_match_named_columns():
    """Ensure JSON keys land in the DB bind slot for the column with the same name."""
    row = {
        "tickers": ["TST"],
        "period_end": "2024-06-30",
        "timeframe": "quarterly",
        "fiscal_year": 2024,
        "fiscal_quarter": 2,
        "dividends": -1001.0,
        "net_income": 2002.0,
        "short_term_debt_issuances_repayments": 3003.0,
        "net_cash_from_operating_activities": 4004.0,
        "change_in_cash_and_equivalents": 5005.0,
    }
    bind = _cash_flow_bind_tuple(
        row,
        sym="TST",
        tf="quarterly",
        pe=date(2024, 6, 30),
        fd=None,
        fy=2024,
        fq=2,
        cik_v=None,
        source="massive",
    )
    cols = _STOCK_CASH_FLOW_UPSERT_BIND_COLUMNS
    assert len(bind) == len(cols)
    assert bind[cols.index("dividends")] == -1001.0
    assert bind[cols.index("net_income")] == 2002.0
    assert bind[cols.index("short_term_debt_issuances_repayments")] == 3003.0
    assert bind[cols.index("net_cash_from_operating_activities")] == 4004.0
    assert bind[cols.index("change_in_cash_and_equivalents")] == 5005.0
