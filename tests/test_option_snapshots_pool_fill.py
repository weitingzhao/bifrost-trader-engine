"""Tests for option_snapshots_pool_contract_fill orchestration."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest


def test_run_option_snapshots_pool_contract_fill_no_targets(monkeypatch: pytest.MonkeyPatch) -> None:
    from src.massive.option_snapshots_pool_fill import run_option_snapshots_pool_contract_fill

    monkeypatch.setattr(
        "src.massive.option_snapshots_pool_fill._fetch_column_fill_targets",
        lambda *a, **k: [],
    )

    mock_cur = MagicMock()
    cm = MagicMock()
    cm.__enter__.return_value = mock_cur
    cm.__exit__.return_value = None
    conn = MagicMock()
    conn.cursor.return_value = cm
    client = MagicMock()

    out = run_option_snapshots_pool_contract_fill(
        conn,
        client,
        {"underlying": "NVDA", "max_contracts": 10},
    )
    assert out.get("ok") is True
    assert out["contracts_processed"] == 0
    assert out["targets_found"] == 0
    client.fetch_option_contract_snapshot.assert_not_called()
