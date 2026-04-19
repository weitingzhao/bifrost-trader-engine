"""Tests for option_min pool fill period mapping and orchestration."""

from __future__ import annotations

import time
from typing import Any, Dict, List
from unittest.mock import MagicMock

import pytest


def test_period_label_to_db_period_matches_discovery() -> None:
    from src.massive.option_bars_period import period_label_to_db_period

    assert period_label_to_db_period("1 min") == "1 min"
    assert period_label_to_db_period("5 mins") == "5 mins"
    assert period_label_to_db_period("1 hour") == "1 hour"


def test_period_label_invalid_raises() -> None:
    from src.massive.option_bars_period import period_label_to_aggs_timespan_multiplier

    with pytest.raises(ValueError):
        period_label_to_aggs_timespan_multiplier("1 D")


def test_run_option_min_pool_row_gap_skips_when_no_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.massive.option_min_pool_fill import run_option_min_pool_aggregates

    monkeypatch.setattr(
        "src.massive.option_min_pool_fill._fetch_row_gap_targets",
        lambda *a, **k: [],
    )

    conn = MagicMock()
    client = MagicMock()
    payload = {
        "underlying": "NVDA",
        "period": "5 mins",
        "lookback_days": 7,
        "max_contracts": 10,
    }
    out = run_option_min_pool_aggregates(
        conn, client, payload, mode="option_min_pool_row_gap"
    )
    assert out["ok"] is True
    assert out["mode"] == "option_min_pool_row_gap"
    assert out["summary"]["contracts_processed"] == 0
    client.fetch_option_aggs.assert_not_called()


def test_run_option_min_pool_row_gap_calls_aggs(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.massive import tasks as massive_tasks
    from src.massive.option_min_pool_fill import run_option_min_pool_aggregates

    targets: List[Any] = [
        ("O:NVDA250620C00180000", "NVDA", "20250620", 180.0, "C"),
    ]
    monkeypatch.setattr(
        "src.massive.option_min_pool_fill._fetch_row_gap_targets",
        lambda *a, **k: targets,
    )

    calls: List[Dict[str, Any]] = []

    def fake_apply(
        conn: Any,
        symbol: str,
        expiry: str,
        strike: float,
        option_right: str,
        period: str,
        aggs: Dict[str, Any],
    ) -> int:
        calls.append(
            {"symbol": symbol, "expiry": expiry, "strike": strike, "right": option_right, "period": period}
        )
        return 3

    monkeypatch.setattr(massive_tasks, "_apply_aggs", fake_apply)
    monkeypatch.setattr(massive_tasks, "_rest_throttle", lambda: None)

    conn = MagicMock()

    def commit() -> None:
        pass

    conn.commit = commit

    client = MagicMock()
    client.fetch_option_aggs = MagicMock(
        return_value={"results": [{"t": int(time.time() * 1000), "o": 1, "h": 2, "l": 0.5, "c": 1.5, "v": 100}]}
    )

    payload = {
        "underlying": "NVDA",
        "period": "5 mins",
        "lookback_days": 7,
        "max_contracts": 10,
    }
    out = run_option_min_pool_aggregates(
        conn, client, payload, mode="option_min_pool_row_gap"
    )
    assert out["ok"] is True
    assert out["summary"]["contracts_processed"] == 1
    assert out["summary"]["bars_upserted"] == 3
    assert calls and calls[0]["symbol"] == "NVDA"
    client.fetch_option_aggs.assert_called_once()


def test_run_option_min_pool_row_gap_passes_expiration_date(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.massive.option_min_pool_fill import run_option_min_pool_aggregates

    captured: dict = {}

    def fake_fetch(
        cur: object,
        sym: str,
        period_db: str,
        max_contracts: int,
        *,
        expiration_date: str | None = None,
    ) -> list:
        captured["sym"] = sym
        captured["period_db"] = period_db
        captured["expiration_date"] = expiration_date
        return []

    monkeypatch.setattr(
        "src.massive.option_min_pool_fill._fetch_row_gap_targets",
        fake_fetch,
    )

    conn = MagicMock()
    client = MagicMock()
    out = run_option_min_pool_aggregates(
        conn,
        client,
        {
            "underlying": "NVDA",
            "period": "5 mins",
            "lookback_days": 7,
            "max_contracts": 10,
            "expiration_date": "20250620",
        },
        mode="option_min_pool_row_gap",
    )
    assert out["ok"] is True
    assert captured.get("expiration_date") == "20250620"
    assert out["summary"].get("expiration_date") == "20250620"
