"""Typed settings and state_space config with defaults."""

from typing import Any, Dict, Optional


def get_state_space_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return state_space config with defaults. Merges config.get('state_space', {})."""
    defaults: Dict[str, Any] = {
        "delta": {
            "epsilon_band": 10.0,
            "hedge_threshold": 25.0,
            "max_delta_limit": 500.0,
        },
        "market": {
            "vol_window_min": 5,
            "stale_ts_threshold_ms": 5000.0,
        },
        "liquidity": {
            "wide_spread_pct": 0.1,
            "extreme_spread_pct": 0.5,
        },
        "system": {
            "data_lag_threshold_ms": 1000.0,
        },
        "hedge": {
            "min_hedge_shares": 10,
            "min_price_move_pct": 0.2,
            "cooldown_seconds": 60,
        },
    }
    ss = (config or {}).get("state_space", {})
    out: Dict[str, Any] = {}
    for section, keys in defaults.items():
        out[section] = {**keys, **(ss.get(section) or {})}
    return out


def get_hedge_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return hedge config (hedge + state_space.hedge) with defaults."""
    cfg = config or {}
    hedge = dict(cfg.get("hedge", {}))
    ss_hedge = (cfg.get("state_space") or {}).get("hedge") or {}
    defaults = {
        "delta_threshold_shares": 25,
        "max_hedge_shares_per_order": 500,
        "min_price_move_pct": 0.2,
        "cooldown_sec": 60,
        "min_hedge_shares": 10,
    }
    merged = {**defaults, **hedge, **ss_hedge}
    return merged
