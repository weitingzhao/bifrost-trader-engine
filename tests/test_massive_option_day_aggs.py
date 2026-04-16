"""Unit tests for Massive option_day upsert from daily aggregates (no live API)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


@pytest.mark.parametrize(
    ("expiry_in", "expiry_expected"),
    [
        ("2025-12-19", "20251219"),
        ("20251219", "20251219"),
    ],
)
def test_apply_option_day_aggs_upserts(expiry_in: str, expiry_expected: str) -> None:
    from src.massive.tasks import _apply_option_day_aggs

    mock_cur = MagicMock()
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    # Bar timestamp ms → UTC (Polygon-style)
    t_ms = 1_704_067_200_000
    aggs = {
        "results": [
            {"t": t_ms, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 100.0, "vw": 1.25},
        ]
    }
    n = _apply_option_day_aggs(mock_conn, "NVDA", expiry_in, 180.0, "C", aggs)
    assert n == 1
    mock_cur.execute.assert_called_once()
    call_args = mock_cur.execute.call_args[0]
    sql = call_args[0]
    params = call_args[1]
    assert "INSERT INTO option_day" in sql
    assert "vwap" in sql
    assert "ON CONFLICT (symbol, expiry, strike, option_right, bar_time, source)" in sql
    assert params[0] == "NVDA"
    assert params[1] == expiry_expected
    assert params[2] == 180.0
    assert params[3] == "C"
    assert params[10] == 1.25


def test_apply_option_day_aggs_put_right_normalized() -> None:
    from src.massive.tasks import _apply_option_day_aggs

    mock_cur = MagicMock()
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    aggs = {"results": [{"t": 1_704_067_200_000, "o": 1, "h": 1, "l": 1, "c": 1, "v": 1}]}
    n = _apply_option_day_aggs(mock_conn, "NVDA", "20251219", 180.0, "PUT", aggs)
    assert n == 1
    params = mock_cur.execute.call_args[0][1]
    assert params[3] == "P"


def test_option_min_bar_vwap_typical_price_when_vw_missing() -> None:
    from src.massive.tasks import _apply_aggs

    mock_cur = MagicMock()
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    t_ms = 1_704_067_200_000
    aggs = {
        "results": [
            {"t": t_ms, "o": 1.0, "h": 2.0, "l": 1.0, "c": 1.5, "v": 100.0},
        ]
    }
    n = _apply_aggs(mock_conn, "NVDA", "20251219", 180.0, "C", "1 min", aggs)
    assert n == 1
    params = mock_cur.execute.call_args[0][1]
    # (2 + 1 + 1.5) / 3 = 1.5
    assert abs(params[11] - 1.5) < 1e-9


def test_apply_aggs_option_min_upserts_vwap() -> None:
    from src.massive.tasks import _apply_aggs

    mock_cur = MagicMock()
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    t_ms = 1_704_067_200_000
    aggs = {
        "results": [
            {"t": t_ms, "o": 1.0, "h": 2.0, "l": 0.5, "c": 1.5, "v": 100.0, "vw": 1.4},
        ]
    }
    n = _apply_aggs(mock_conn, "NVDA", "20251219", 180.0, "C", "1 min", aggs)
    assert n == 1
    sql = mock_cur.execute.call_args[0][0]
    params = mock_cur.execute.call_args[0][1]
    assert "INSERT INTO option_min" in sql
    assert "vwap" in sql
    assert params[4] == "1 min"
    assert params[11] == 1.4


def test_apply_option_day_aggs_skips_bad_rows() -> None:
    from src.massive.tasks import _apply_option_day_aggs

    mock_cur = MagicMock()
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    aggs = {"results": [{}, "not-a-dict", {"t": None}]}
    n = _apply_option_day_aggs(mock_conn, "NVDA", "20251219", 180.0, "C", aggs)
    assert n == 0
    mock_cur.execute.assert_not_called()
