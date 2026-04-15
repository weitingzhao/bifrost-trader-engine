"""Unit tests for IV volatility cone helpers (option_discovery router)."""

from __future__ import annotations

from backend.research.routers.option_discovery import (
    _atm_iv_from_expiry_items,
    _build_exp_iv_map,
    _linear_percentiles,
)


def test_linear_percentiles_sorted_three_values():
    p = _linear_percentiles([0.2, 0.5, 0.8])
    assert p["min"] == 0.2
    assert p["max"] == 0.8
    assert abs(p["p50"] - 0.5) < 1e-9
    assert p["p10"] is not None and p["p90"] is not None


def test_linear_percentiles_empty():
    p = _linear_percentiles([])
    assert p["p10"] is None and p["p50"] is None


def test_atm_iv_call_put_average():
    items = [
        (1.0, 0.30, None, 100.0),
        (1.0, None, 0.34, 100.0),
    ]
    atm, c, p, st = _atm_iv_from_expiry_items(items)
    assert atm is not None and abs(atm - 0.32) < 1e-9
    assert c == 0.30 and p == 0.34


def test_build_exp_iv_map_groups_by_expiry():
    key_map = {
        "SPY|OPT|20261218|450.0|C": "20261218",
        "SPY|OPT|20261218|450.0|P": "20261218",
    }
    rows = [
        {"contract_key": "SPY|OPT|20261218|450.0|C", "iv": 0.25},
        {"contract_key": "SPY|OPT|20261218|450.0|P", "iv": 0.27},
    ]
    m = _build_exp_iv_map(rows, key_map, last_price=450.0)
    assert "20261218" in m
    atm, _, _, _ = _atm_iv_from_expiry_items(m["20261218"])
    assert atm is not None and abs(atm - 0.26) < 1e-9
