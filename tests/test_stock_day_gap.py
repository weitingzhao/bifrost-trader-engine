"""Regression tests for stock_day gap reference calendar."""

from __future__ import annotations

from datetime import date
from unittest.mock import MagicMock

from src.vendor.massive.stock_day_gap import compute_stock_day_gap


def test_compute_stock_day_gap_uses_generate_series_calendar():
    """Ref must enumerate NYSE trading days, not DISTINCT dates present in stock_day."""
    cur = MagicMock()
    cur.fetchone.return_value = (10, 9)
    cur.fetchall.return_value = []

    compute_stock_day_gap(cur, "NVDA", lookback_years=1, cap_date=date(2026, 4, 27))

    gap_sql = cur.execute.call_args_list[0][0][0]
    assert "generate_series" in gap_sql
    assert "reference_us_holidays" in gap_sql
    assert "DISTINCT bar_time" not in gap_sql.split("covered AS")[0]


def test_ref_total_zero_triggers_exists_probe():
    cur = MagicMock()
    cur.fetchone.side_effect = [(0, 0), (False,)]
    cur.fetchall.return_value = []

    out = compute_stock_day_gap(cur, "XYZ", lookback_years=1, cap_date=date(2020, 1, 3))

    assert out["ok"] is True
    assert out["ref_total"] == 0
    assert "No stock_day rows" in (out.get("message") or "")
    assert cur.execute.call_count == 2
