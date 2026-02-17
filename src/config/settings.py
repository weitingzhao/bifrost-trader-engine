"""Typed settings: state_space follows O,D,M,L,E,S (delta, market, liquidity, system, execution)."""

from typing import Any, Dict, Optional


def get_state_space_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return state_space config with defaults. Sections: delta(D), market(M), liquidity(L), system(S), execution(E)."""
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
        "execution": {
            "min_hedge_shares": 10,
            "cooldown_seconds": 60,
            "max_hedge_shares_per_order": 500,
            "min_price_move_pct": 0.2,
        },
    }
    ss = (config or {}).get("state_space", {})
    out: Dict[str, Any] = {}
    for section, keys in defaults.items():
        out[section] = {**keys, **(ss.get(section) or {})}
    return out


def get_hedge_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Return hedge config: delta_threshold from state_space.delta, rest from state_space.execution (E).
    Normalizes cooldown_seconds -> cooldown_sec. Fallback: top-level execution, then state_space.hedge.
    """
    cfg = config or {}
    ss = cfg.get("state_space") or {}
    delta = ss.get("delta") or {}
    exec_cfg = ss.get("execution") or cfg.get("execution") or {}
    legacy_hedge = ss.get("hedge") or cfg.get("hedge") or {}
    defaults = {
        "delta_threshold_shares": 25,
        "max_hedge_shares_per_order": 500,
        "min_price_move_pct": 0.2,
        "cooldown_sec": 60,
        "min_hedge_shares": 10,
    }
    merged = {**defaults}
    merged["delta_threshold_shares"] = delta.get("hedge_threshold", merged["delta_threshold_shares"])
    for key, cfg_key in [
        ("min_hedge_shares", "min_hedge_shares"),
        ("min_price_move_pct", "min_price_move_pct"),
        ("max_hedge_shares_per_order", "max_hedge_shares_per_order"),
    ]:
        v = exec_cfg.get(cfg_key) if exec_cfg else None
        if v is None and legacy_hedge:
            v = legacy_hedge.get(cfg_key)
        if v is not None:
            merged[key] = v
    cooldown = exec_cfg.get("cooldown_seconds") if exec_cfg else None
    if cooldown is None and legacy_hedge:
        cooldown = legacy_hedge.get("cooldown_seconds")
    if cooldown is not None:
        merged["cooldown_sec"] = int(cooldown)
    for k, v in (cfg.get("hedge") or {}).items():
        if v is not None and k in ("delta_threshold_shares", "max_hedge_shares_per_order", "min_hedge_shares", "min_price_move_pct"):
            merged[k] = v
        if v is not None and k == "cooldown_sec":
            merged["cooldown_sec"] = int(v)
    return merged
