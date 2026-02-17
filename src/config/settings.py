"""Unified config: gates (strategy, state, intent, guard) for hedge logic and ExecutionGuard.

Option 2 (gates): pipeline-aligned structure. Backward compat: top-level and state_space.
"""

from typing import Any, Dict, Optional


# Defaults per section (match gates structure)
_DEFAULTS = {
    "structure": {"min_dte": 21, "max_dte": 35, "atm_band_pct": 0.03},
    "earnings": {
        "blackout_days_before": 3,
        "blackout_days_after": 1,
        "dates": [],
    },
    "delta": {"hedge_threshold": 25},
    "hedge": {
        "min_hedge_shares": 10,
        "cooldown_seconds": 60,
        "max_hedge_shares_per_order": 500,
        "min_price_move_pct": 0.2,
    },
    "risk": {
        "max_daily_hedge_count": 50,
        "max_position_shares": 2000,
        "max_daily_loss_usd": 5000.0,
        "max_net_delta_shares": None,
        "max_spread_pct": None,
        "trading_hours_only": True,
        "paper_trade": True,
    },
}


def _gates_section(cfg: Dict[str, Any], gate: str, section: str) -> Dict[str, Any]:
    """Get section from gates.gate.section. Returns {} if not found."""
    g = cfg.get("gates") or {}
    gate_cfg = g.get(gate) or {}
    return gate_cfg.get(section) if isinstance(gate_cfg.get(section), dict) else {}


def _section(cfg: Dict[str, Any], section: str) -> Dict[str, Any]:
    """Get section with fallback order: gates → top-level → state_space."""
    # gates mapping: delta,market,liquidity,system -> state; hedge -> intent; risk,earnings,structure -> strategy/guard
    if section in ("delta", "market", "liquidity", "system"):
        out = _gates_section(cfg, "state", section)
        if out:
            return out
    elif section == "hedge":
        out = _gates_section(cfg, "intent", "hedge")
        if out:
            return out
    elif section == "risk":
        out = _gates_section(cfg, "guard", "risk")
        if out:
            return out
    elif section == "earnings":
        out = _gates_section(cfg, "strategy", "earnings")
        if out:
            return out
    elif section == "structure":
        out = _gates_section(cfg, "strategy", "structure")
        if out:
            return out

    return cfg.get(section) or (cfg.get("state_space") or {}).get(section) or {}


def get_structure_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return structure config (min_dte, max_dte, atm_band_pct). From gates.strategy.structure or top-level."""
    cfg = config or {}
    s = _section(cfg, "structure")
    d = _DEFAULTS["structure"]
    return {k: s.get(k, d.get(k)) for k in d}


def get_risk_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return risk config (paper_trade, etc.). From gates.guard.risk or top-level risk."""
    cfg = config or {}
    return _section(cfg, "risk")


def get_hedge_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Return unified hedge + guard config from config.yaml.

    Reads from gates (strategy, state, intent, guard); fallback: top-level, state_space.
    Returns flat dict for GsTrading, ExecutionGuard, gamma_scalper_intent.
    """
    cfg = config or {}
    delta = _section(cfg, "delta")
    hedge = _section(cfg, "hedge")
    risk = _section(cfg, "risk")
    earnings = _section(cfg, "earnings")

    # trading_hours_only: strategy or risk
    strategy = (cfg.get("gates") or {}).get("strategy") or {}
    trading_hours = strategy.get("trading_hours_only")
    if trading_hours is None:
        trading_hours = risk.get("trading_hours_only", _DEFAULTS["risk"]["trading_hours_only"])

    cooldown = hedge.get("cooldown_seconds")
    if cooldown is None:
        cooldown = _DEFAULTS["hedge"]["cooldown_seconds"]
    else:
        cooldown = int(cooldown)

    return {
        # Hedge params (delta + hedge)
        "delta_threshold_shares": delta.get(
            "hedge_threshold",
            _DEFAULTS["delta"]["hedge_threshold"],
        ),
        "min_hedge_shares": hedge.get(
            "min_hedge_shares",
            _DEFAULTS["hedge"]["min_hedge_shares"],
        ),
        "cooldown_sec": cooldown,
        "max_hedge_shares_per_order": hedge.get(
            "max_hedge_shares_per_order",
            _DEFAULTS["hedge"]["max_hedge_shares_per_order"],
        ),
        "min_price_move_pct": hedge.get(
            "min_price_move_pct",
            _DEFAULTS["hedge"]["min_price_move_pct"],
        ),
        # Guard params (risk)
        "max_daily_hedge_count": risk.get(
            "max_daily_hedge_count",
            _DEFAULTS["risk"]["max_daily_hedge_count"],
        ),
        "max_position_shares": risk.get(
            "max_position_shares",
            _DEFAULTS["risk"]["max_position_shares"],
        ),
        "max_daily_loss_usd": risk.get(
            "max_daily_loss_usd",
            _DEFAULTS["risk"]["max_daily_loss_usd"],
        ),
        "max_net_delta_shares": risk.get(
            "max_net_delta_shares",
            _DEFAULTS["risk"]["max_net_delta_shares"],
        ),
        "max_spread_pct": risk.get(
            "max_spread_pct",
            _DEFAULTS["risk"]["max_spread_pct"],
        ),
        "trading_hours_only": trading_hours,
        # Guard params (earnings)
        "earnings_dates": [d for d in (earnings.get("dates") or []) if d],
        "blackout_days_before": earnings.get(
            "blackout_days_before",
            _DEFAULTS["earnings"]["blackout_days_before"],
        ),
        "blackout_days_after": earnings.get(
            "blackout_days_after",
            _DEFAULTS["earnings"]["blackout_days_after"],
        ),
    }


def get_state_space_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return state space config with defaults. Sections: delta, market, liquidity, system, hedge.
    Reads from gates.state, gates.intent; falls back to top-level, state_space."""
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
            "cooldown_seconds": 60,
            "max_hedge_shares_per_order": 500,
            "min_price_move_pct": 0.2,
        },
    }
    cfg = config or {}
    out: Dict[str, Any] = {}
    for section, keys in defaults.items():
        sec = _section(cfg, section)
        out[section] = {**keys, **sec}
    return out


def get_config_for_guards(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return config dict suitable for TradingGuard and StateClassifier.
    Merges gates.state, gates.intent into flat sections; adds risk for max_spread_pct."""
    cfg = config or {}
    state_cfg = get_state_space_config(cfg)
    # TradingGuard also needs risk for is_liquidity_ok (max_spread_pct)
    risk = _section(cfg, "risk")
    state_cfg["risk"] = risk
    return state_cfg
