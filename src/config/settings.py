"""Typed settings and state_space config with defaults. Single source: state_space."""

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
            "delta_threshold_shares": 25,
            "max_hedge_shares_per_order": 500,
        },
    }
    ss = (config or {}).get("state_space", {})
    out: Dict[str, Any] = {}
    for section, keys in defaults.items():
        out[section] = {**keys, **(ss.get(section) or {})}
    return out


def get_hedge_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Return hedge config from state_space only (single source).
    Normalizes keys: cooldown_seconds -> cooldown_sec; delta_threshold from state_space.delta.hedge_threshold.
    Optional top-level 'hedge' is merged as override for backward compatibility.
    """
    cfg = config or {}
    ss = cfg.get("state_space") or {}
    delta = ss.get("delta") or {}
    hedge = ss.get("hedge") or {}
    legacy_hedge = cfg.get("hedge") or {}
    defaults = {
        "delta_threshold_shares": 25,
        "max_hedge_shares_per_order": 500,
        "min_price_move_pct": 0.2,
        "cooldown_sec": 60,
        "min_hedge_shares": 10,
    }
    merged = {**defaults}
    merged["delta_threshold_shares"] = delta.get("hedge_threshold", merged["delta_threshold_shares"])
    merged["min_hedge_shares"] = hedge.get("min_hedge_shares", merged["min_hedge_shares"])
    merged["min_price_move_pct"] = hedge.get("min_price_move_pct", merged["min_price_move_pct"])
    cooldown = hedge.get("cooldown_seconds", merged["cooldown_sec"])
    merged["cooldown_sec"] = int(cooldown) if cooldown is not None else merged["cooldown_sec"]
    merged["max_hedge_shares_per_order"] = hedge.get("max_hedge_shares_per_order", merged["max_hedge_shares_per_order"])
    for k, v in legacy_hedge.items():
        if v is not None and k in ("delta_threshold_shares", "max_hedge_shares_per_order", "min_hedge_shares", "min_price_move_pct"):
            merged[k] = v
        if v is not None and k == "cooldown_sec":
            merged["cooldown_sec"] = int(v)
    return merged
