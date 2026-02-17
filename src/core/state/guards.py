"""Pure guard functions for Trading FSM transitions (testable, no side effects)."""

import math
from typing import Any, Dict, Optional

from src.core.state.enums import (
    ExecutionState,
    LiquidityState,
    OptionPositionState,
    SystemHealthState,
)
from src.core.state.snapshot import StateSnapshot


def _get_cfg(config: Optional[Dict[str, Any]], section: str, key: str, default: Any) -> Any:
    cfg = config or {}
    ss = cfg.get("state_space", cfg)
    sec = cfg.get(section, ss.get(section, {}))
    if isinstance(sec, dict):
        return sec.get(key, default)
    return default


def data_ok(snapshot: StateSnapshot, config: Optional[Dict[str, Any]] = None) -> bool:
    """True when event lag is within threshold and quote exists."""
    threshold_ms = _get_cfg(config, "system", "data_lag_threshold_ms", 1000.0)
    if snapshot.event_lag_ms is not None and snapshot.event_lag_ms > threshold_ms:
        return False
    if snapshot.L == LiquidityState.NO_QUOTE:
        return False
    if snapshot.spot is None or snapshot.spot <= 0:
        return False
    return True


def data_stale(snapshot: StateSnapshot, config: Optional[Dict[str, Any]] = None) -> bool:
    """True when event lag exceeds threshold or quote missing."""
    return not data_ok(snapshot, config)


def greeks_bad(snapshot: StateSnapshot) -> bool:
    """True when greeks are NaN, inf, extreme, or invalid."""
    if not snapshot.greeks_valid:
        return True
    if snapshot.greeks is None:
        return True
    g = snapshot.greeks
    if not g.valid or not g.is_finite():
        return True
    # Extreme values (e.g. delta in shares > 1e6)
    if abs(g.delta) > 1e6 or abs(g.gamma) > 1e6:
        return True
    return False


def greeks_ok(snapshot: StateSnapshot) -> bool:
    return not greeks_bad(snapshot)


def broker_down(snapshot: StateSnapshot) -> bool:
    """True when broker is disconnected or in error."""
    return snapshot.E in (ExecutionState.DISCONNECTED, ExecutionState.BROKER_ERROR)


def broker_up(snapshot: StateSnapshot) -> bool:
    return not broker_down(snapshot)


def have_option_position(snapshot: StateSnapshot) -> bool:
    """True when O is LONG_GAMMA or SHORT_GAMMA."""
    return snapshot.O in (OptionPositionState.LONG_GAMMA, OptionPositionState.SHORT_GAMMA)


def no_option_position(snapshot: StateSnapshot) -> bool:
    return snapshot.O == OptionPositionState.NONE


def delta_band_ready(
    snapshot: StateSnapshot,
    config: Optional[Dict[str, Any]] = None,
) -> bool:
    """True when gamma/iv/threshold params are ready to make delta-band decisions."""
    if not snapshot.greeks_valid:
        return False
    epsilon = _get_cfg(config, "delta", "epsilon_band", 10.0)
    hedge_threshold = _get_cfg(config, "delta", "hedge_threshold", 25.0)
    # Must have valid thresholds and greeks
    return (
        isinstance(epsilon, (int, float))
        and isinstance(hedge_threshold, (int, float))
        and hedge_threshold >= epsilon
    )


def in_no_trade_band(
    snapshot: StateSnapshot,
    config: Optional[Dict[str, Any]] = None,
) -> bool:
    """True when |net_delta| <= epsilon_band (no trade needed)."""
    epsilon = _get_cfg(config, "delta", "epsilon_band", 10.0)
    return abs(snapshot.net_delta) <= epsilon


def out_of_band(
    snapshot: StateSnapshot,
    config: Optional[Dict[str, Any]] = None,
) -> bool:
    """True when |net_delta| > epsilon_band (potential hedge)."""
    return not in_no_trade_band(snapshot, config)


def cost_ok(
    snapshot: StateSnapshot,
    config: Optional[Dict[str, Any]] = None,
    min_price_move_pct: Optional[float] = None,
) -> bool:
    """
    True when expected benefit > cost; at least spread+fee threshold.
    Simplified: spread not extreme and (optional) price moved enough since last hedge.
    """
    max_spread = _get_cfg(config, "liquidity", "extreme_spread_pct", 0.5)
    if snapshot.spread_pct is not None and snapshot.spread_pct >= max_spread:
        return False
    move_pct = min_price_move_pct or _get_cfg(
        config, "hedge", "min_price_move_pct", 0.2
    )
    if move_pct <= 0:
        return True
    if (
        snapshot.last_hedge_price is None
        or snapshot.spot is None
        or snapshot.last_hedge_price <= 0
    ):
        return True
    pct = 100.0 * abs(snapshot.spot - snapshot.last_hedge_price) / snapshot.last_hedge_price
    return pct >= move_pct


def liquidity_ok(
    snapshot: StateSnapshot,
    config: Optional[Dict[str, Any]] = None,
) -> bool:
    """True when spread <= max_spread and quote exists."""
    if snapshot.L == LiquidityState.NO_QUOTE:
        return False
    if snapshot.L == LiquidityState.EXTREME_WIDE:
        return False
    max_spread_pct = None
    if config:
        risk = config.get("risk", {})
        max_spread_pct = risk.get("max_spread_pct")
    if max_spread_pct is not None and snapshot.spread_pct is not None:
        if snapshot.spread_pct > max_spread_pct:
            return False
    return True


def retry_allowed(
    snapshot: StateSnapshot,
    guard: Any,
    config: Optional[Dict[str, Any]] = None,
) -> bool:
    """True when daily retry/cancel-replace limits not exceeded."""
    if guard is None:
        return True
    max_daily = getattr(guard, "max_daily_hedge_count", 50)
    daily_count = getattr(guard, "_daily_hedge_count", 0)
    return daily_count < max_daily


def exec_fault(snapshot: StateSnapshot) -> bool:
    """True when execution layer is in FAIL or broker error."""
    return snapshot.E in (ExecutionState.DISCONNECTED, ExecutionState.BROKER_ERROR)


def positions_ok(snapshot: StateSnapshot) -> bool:
    """True when we have a coherent position view (data_ok implies we can trust it)."""
    return data_ok(snapshot) and snapshot.S != SystemHealthState.RISK_HALT


def strategy_enabled(_snapshot: StateSnapshot, config: Optional[Dict[str, Any]] = None) -> bool:
    """True when strategy is enabled (e.g. not disabled in config)."""
    if not config:
        return True
    return config.get("strategy_enabled", True)
