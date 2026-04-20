"""Unit tests for Massive option_day upsert from daily aggregates (no live API)."""

from __future__ import annotations

from datetime import datetime, timezone
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


def test_apply_option_day_open_close_update_executes() -> None:
    from src.massive.tasks import _apply_option_day_open_close_update

    mock_cur = MagicMock()
    mock_cur.rowcount = 1
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    bt = datetime(2024, 1, 2, 21, 0, tzinfo=timezone.utc)
    data = {"open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 99.0}
    n = _apply_option_day_open_close_update(
        mock_conn, "NVDA", "20251219", 180.0, "C", bt, data
    )
    assert n == 1
    mock_cur.execute.assert_called_once()
    sql = mock_cur.execute.call_args[0][0]
    assert "UPDATE option_day" in sql
    params = mock_cur.execute.call_args[0][1]
    assert params[9] == bt


def test_ny_day_bounds_ms_ordering() -> None:
    from src.massive.tasks import _ny_day_bounds_ms

    a, b = _ny_day_bounds_ms("2024-06-15")
    assert a < b
    # NY calendar day span in ms (24h except DST fold; keep loose)
    assert 86_300_000 <= (b - a) <= 90_100_000


def test_option_day_pool_row_gap_no_targets() -> None:
    from src.massive.option_day_pool_fill import run_option_day_pool_aggregates

    mock_cur = MagicMock()
    mock_cur.fetchall.return_value = []
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    client = MagicMock()
    out = run_option_day_pool_aggregates(
        mock_conn,
        client,
        {
            "underlying": "NVDA",
            "row_lookback_days": 730,
            "max_contracts": 10,
            "max_expiries": 60,
        },
        mode="option_day_pool_row_gap",
        apply_open_close_update=lambda *a, **k: 0,
        apply_option_day_aggs=lambda *a, **k: 0,
        patch_vwap=lambda *a, **k: 0,
        rest_throttle=lambda: None,
    )
    assert out.get("ok") is True
    assert out["summary"]["contracts_processed"] == 0
    client.fetch_option_aggs.assert_not_called()


def test_option_day_pool_row_gap_passes_expiration_date(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.massive.option_day_pool_fill import run_option_day_pool_aggregates

    captured: dict = {}

    def fake_fetch(
        cur: object,
        sym: str,
        max_expiries: int,
        max_contracts: int,
        *,
        expiration_date: str | None = None,
    ) -> list:
        captured["expiration_date"] = expiration_date
        return []

    monkeypatch.setattr(
        "src.massive.option_day_pool_fill.list_option_day_row_gap_targets",
        fake_fetch,
    )

    mock_cur = MagicMock()
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    mock_conn = MagicMock()
    mock_conn.cursor.return_value = cm

    client = MagicMock()
    out = run_option_day_pool_aggregates(
        mock_conn,
        client,
        {
            "underlying": "NVDA",
            "row_lookback_days": 730,
            "max_contracts": 10,
            "max_expiries": 60,
            "expiration_date": "20250620",
        },
        mode="option_day_pool_row_gap",
        apply_open_close_update=lambda *a, **k: 0,
        apply_option_day_aggs=lambda *a, **k: 0,
        patch_vwap=lambda *a, **k: 0,
        rest_throttle=lambda: None,
    )
    assert out.get("ok") is True
    assert captured.get("expiration_date") == "20250620"
    assert out["summary"].get("expiration_date") == "20250620"


def test_chunk_option_day_row_gap_targets() -> None:
    from src.massive.option_day_pool_fill import chunk_option_day_row_gap_targets

    t = [("O:A", "X", "20250101", 1.0, "C"), ("O:B", "X", "20250102", 2.0, "P"), ("O:C", "X", "20250103", 3.0, "C")]
    assert chunk_option_day_row_gap_targets(t, 2) == [t[:2], t[2:]]
    assert chunk_option_day_row_gap_targets(t, 10) == [t]
    assert chunk_option_day_row_gap_targets([], 5) == []


def test_parse_row_gap_targets_from_payload() -> None:
    from src.massive.option_day_pool_fill import parse_row_gap_targets_from_payload

    raw = [
        {"options_ticker": "O:TEST1", "symbol": "QQQ", "expiry": "20251219", "strike": 100, "option_right": "C"},
    ]
    out = parse_row_gap_targets_from_payload(raw, "NVDA")
    assert len(out) == 1
    assert out[0][0] == "O:TEST1"
    assert out[0][1] == "QQQ"


def test_option_day_pool_row_gap_explicit_targets_skips_db_query(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.massive.option_day_pool_fill import run_option_day_pool_aggregates

    called = {"n": 0}

    def should_not_list(*_a: object, **_k: object) -> list:
        called["n"] += 1
        return []

    monkeypatch.setattr(
        "src.massive.option_day_pool_fill.list_option_day_row_gap_targets",
        should_not_list,
    )

    mock_conn = MagicMock()
    client = MagicMock()
    client.fetch_option_aggs.return_value = {"results": [], "error": None}

    out = run_option_day_pool_aggregates(
        mock_conn,
        client,
        {
            "underlying": "NVDA",
            "row_gap_targets": [
                {
                    "options_ticker": "O:NVDA251219C00100000",
                    "symbol": "NVDA",
                    "expiry": "20251219",
                    "strike": 100.0,
                    "option_right": "C",
                },
            ],
        },
        mode="option_day_pool_row_gap",
        apply_open_close_update=lambda *a, **k: 0,
        apply_option_day_aggs=lambda *a, **k: 2,
        patch_vwap=lambda *a, **k: 0,
        rest_throttle=lambda: None,
    )
    assert called["n"] == 0
    assert out["summary"]["targets_found"] == 1
    assert out["summary"]["targets_source"] == "explicit"
    assert client.fetch_option_aggs.call_count == 1
    assert out["summary"]["contracts_ok"] == 1
    assert out["summary"]["bars_upserted"] == 2


def test_fetch_option_aggs_with_retry_succeeds_after_transient() -> None:
    from src.massive.option_day_pool_fill import fetch_option_aggs_with_retry

    client = MagicMock()
    client.fetch_option_aggs.side_effect = [
        {"results": [], "error": "Remote end closed connection without response"},
        {"results": [{"t": 1}]},
    ]
    out = fetch_option_aggs_with_retry(client, "O:X", 1, "day", 0, 1, lambda: None, max_attempts=3)
    assert not out.get("error")
    assert out.get("results") == [{"t": 1}]
    assert client.fetch_option_aggs.call_count == 2
