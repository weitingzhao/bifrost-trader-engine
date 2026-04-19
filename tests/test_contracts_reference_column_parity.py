"""Unit tests for reference vs PG column parity (L2)."""

from __future__ import annotations

from unittest.mock import MagicMock

from src.vendor.massive.contracts_reference_column_parity import (
    compute_option_contracts_reference_column_parity,
)


def test_column_parity_no_contract_rows_returns_empty_compare():
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (5,),  # db count
        (1,),  # distinct exp
    ]
    cur.fetchall.return_value = [("20260116", 5)]

    client = MagicMock()
    client.collect_option_contract_reference_rows_paginated.return_value = {
        "count": 0,
        "rows": [],
        "truncated": False,
        "error": None,
    }

    out = compute_option_contracts_reference_column_parity(cur, client, "NVDA", max_expiries=60)
    assert out["ok"] is True
    assert out["api_rows_compared"] == 0
    assert out["value_mismatch_rows"] == 0
    assert out["pg_rows_missing"] == 0


def test_column_parity_missing_pg_row_increments_missing():
    cur = MagicMock()
    cur.fetchone.side_effect = [
        (1,),  # db count
        (1,),  # distinct exp
        None,  # SELECT by contract_key — no row
    ]
    cur.fetchall.return_value = [("20260116", 1)]

    api_row = {
        "expiration_date": "2026-01-16",
        "strike_price": 100.0,
        "contract_type": "call",
        "ticker": "O:NVDA260116C00100000",
    }
    client = MagicMock()
    client.collect_option_contract_reference_rows_paginated.return_value = {
        "count": 1,
        "rows": [{"contract_key": "NVDA|OPT|20260116|100.0|C", "result": api_row}],
        "truncated": False,
        "error": None,
    }

    out = compute_option_contracts_reference_column_parity(cur, client, "NVDA", max_expiries=60)
    assert out["ok"] is True
    assert out["api_rows_compared"] == 1
    assert out["pg_rows_missing"] == 1
    assert out["value_mismatch_rows"] == 0
