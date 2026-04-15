"""Unit tests for IV volatility cone helpers (option_discovery router)."""

from __future__ import annotations

from backend.research.routers.option_discovery import (
    _atm_iv_from_expiry_items,
    _build_exp_iv_map,
    _hist_iv_parametrics,
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


def test_hist_iv_parametrics_empty():
    p = _hist_iv_parametrics([])
    assert p["iv_hist_mean"] is None and p["iv_hist_stdev"] is None


def test_hist_iv_parametrics_one_sample():
    p = _hist_iv_parametrics([0.25])
    assert abs(p["iv_hist_mean"] - 0.25) < 1e-9
    assert p["iv_hist_stdev"] is None
    assert p["iv_hist_plus_1sd"] is None
    assert abs(p["iv_hist_min"] - 0.25) < 1e-9
    assert abs(p["iv_hist_max"] - 0.25) < 1e-9


def test_hist_iv_parametrics_two_samples_stdev_and_bands():
    p = _hist_iv_parametrics([0.20, 0.30])
    assert p["iv_hist_mean"] is not None and p["iv_hist_stdev"] is not None
    mu = p["iv_hist_mean"]
    sig = p["iv_hist_stdev"]
    assert abs(p["iv_hist_plus_1sd"] - (mu + sig)) < 1e-9
    assert abs(p["iv_hist_minus_1sd"] - max(0.0, mu - sig)) < 1e-9


def test_hist_iv_parametrics_clamps_lower_band_to_zero():
    p = _hist_iv_parametrics([0.01, 0.02, 0.03])
    assert p["iv_hist_minus_2sd"] is not None
    assert p["iv_hist_minus_2sd"] >= 0


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
