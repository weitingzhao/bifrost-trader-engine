"""Trading FSM guards: class over StateSnapshot + config, plus backward-compat free functions.

Used only by TradingFSM in fsm/trading_fsm.py. TradingGuard(snapshot, config) holds the
snapshot and exposes predicate methods (data_ok, greeks_bad, in_no_trade_band, etc.).
For the order-send gate used by the Hedge Execution FSM, see execution_guard.py (ExecutionGuard).
"""

from typing import Any, Dict, Optional

from src.core.state.enums import (
    ExecutionState,
    LiquidityState,
    OptionPositionState,
    SystemHealthState,
)
from src.core.state.snapshot import StateSnapshot


def _get_cfg(
    config: Optional[Dict[str, Any]], section: str, key: str, default: Any
) -> Any:
    cfg = config or {}
    ss = cfg.get("state_space", cfg)
    sec = cfg.get(section, ss.get(section, {}))
    if isinstance(sec, dict):
        return sec.get(key, default)
    return default


class TradingGuard:
    """Holds a StateSnapshot and optional config; exposes predicate methods for Trading FSM transitions."""

    def __init__(
        self,
        snapshot: StateSnapshot,
        config: Optional[Dict[str, Any]] = None,
        execution_guard: Any = None,
    ):
        self._snapshot = snapshot
        self._config = config or {}
        self._execution_guard = execution_guard

    def data_ok(self) -> bool:
        """True when event lag is within threshold and quote exists."""
        threshold_ms = _get_cfg(self._config, "system", "data_lag_threshold_ms", 1000.0)
        if (
            self._snapshot.event_lag_ms is not None
            and self._snapshot.event_lag_ms > threshold_ms
        ):
            return False
        if self._snapshot.L == LiquidityState.NO_QUOTE:
            return False
        if self._snapshot.spot is None or self._snapshot.spot <= 0:
            return False
        return True

    def greeks_bad(self) -> bool:
        """True when greeks are NaN, inf, extreme, or invalid."""
        if not self._snapshot.greeks_valid:
            return True
        if self._snapshot.greeks is None:
            return True
        g = self._snapshot.greeks
        if not g.valid or not g.is_finite():
            return True
        if abs(g.delta) > 1e6 or abs(g.gamma) > 1e6:
            return True
        return False

    def greeks_ok(self) -> bool:
        return not self.greeks_bad()

    def broker_down(self) -> bool:
        """True when broker is disconnected or in error."""
        return self._snapshot.E in (
            ExecutionState.DISCONNECTED,
            ExecutionState.BROKER_ERROR,
        )

    def broker_up(self) -> bool:
        return not self.broker_down()

    def have_option_position(self) -> bool:
        """True when O is LONG_GAMMA or SHORT_GAMMA."""
        return self._snapshot.O in (
            OptionPositionState.LONG_GAMMA,
            OptionPositionState.SHORT_GAMMA,
        )

    def no_option_position(self) -> bool:
        return self._snapshot.O == OptionPositionState.NONE

    def delta_band_ready(self) -> bool:
        """True when gamma/iv/threshold params are ready to make delta-band decisions."""
        if not self._snapshot.greeks_valid:
            return False
        epsilon = _get_cfg(self._config, "delta", "epsilon_band", 10.0)
        hedge_threshold = _get_cfg(self._config, "delta", "hedge_threshold", 25.0)
        return (
            isinstance(epsilon, (int, float))
            and isinstance(hedge_threshold, (int, float))
            and hedge_threshold >= epsilon
        )

    def in_no_trade_band(self) -> bool:
        """True when |net_delta| <= epsilon_band (no trade needed)."""
        epsilon = _get_cfg(self._config, "delta", "epsilon_band", 10.0)
        return abs(self._snapshot.net_delta) <= epsilon

    def out_of_band(self) -> bool:
        """True when |net_delta| > epsilon_band (potential hedge)."""
        return not self.in_no_trade_band()

    def cost_ok(self, min_price_move_pct: Optional[float] = None) -> bool:
        """
        True when expected benefit > cost; spread not extreme and (optional) price moved enough.
        Reads min_price_move_pct from state_space.execution (fallback: hedge).
        """
        max_spread = _get_cfg(self._config, "liquidity", "extreme_spread_pct", 0.5)
        if (
            self._snapshot.spread_pct is not None
            and self._snapshot.spread_pct >= max_spread
        ):
            return False
        move_pct = min_price_move_pct or _get_cfg(
            self._config,
            "execution",
            "min_price_move_pct",
            _get_cfg(self._config, "hedge", "min_price_move_pct", 0.2),
        )
        if move_pct <= 0:
            return True
        if (
            self._snapshot.last_hedge_price is None
            or self._snapshot.spot is None
            or self._snapshot.last_hedge_price <= 0
        ):
            return True
        pct = (
            100.0
            * abs(self._snapshot.spot - self._snapshot.last_hedge_price)
            / self._snapshot.last_hedge_price
        )
        return pct >= move_pct

    def liquidity_ok(self) -> bool:
        """True when spread <= max_spread and quote exists."""
        if self._snapshot.L == LiquidityState.NO_QUOTE:
            return False
        if self._snapshot.L == LiquidityState.EXTREME_WIDE:
            return False
        risk = self._config.get("risk", {})
        max_spread_pct = risk.get("max_spread_pct") if self._config else None
        if max_spread_pct is not None and self._snapshot.spread_pct is not None:
            if self._snapshot.spread_pct > max_spread_pct:
                return False
        return True

    def retry_allowed(self) -> bool:
        """True when daily retry/cancel-replace limits not exceeded (uses ExecutionGuard._daily_hedge_count)."""
        if self._execution_guard is None:
            return True
        max_daily = getattr(self._execution_guard, "max_daily_hedge_count", 50)
        daily_count = getattr(self._execution_guard, "_daily_hedge_count", 0)
        return daily_count < max_daily

    def exec_fault(self) -> bool:
        """True when execution layer is in FAIL or broker error."""
        return self._snapshot.E in (
            ExecutionState.DISCONNECTED,
            ExecutionState.BROKER_ERROR,
        )

    def positions_ok(self) -> bool:
        """True when we have a coherent position view (data_ok implies we can trust it)."""
        return self.data_ok() and self._snapshot.S != SystemHealthState.RISK_HALT

    def strategy_enabled(self) -> bool:
        """True when strategy is enabled (e.g. not disabled in config)."""
        if not self._config:
            return True
        return self._config.get("strategy_enabled", True)

    def eval_all(self) -> Dict[str, bool]:
        """Return dict of guard_name -> bool for all guards used by TradingFSM."""
        return {
            "data_ok": self.data_ok(),
            "greeks_bad": self.greeks_bad(),
            "broker_down": self.broker_down(),
            "broker_up": self.broker_up(),
            "have_option_position": self.have_option_position(),
            "delta_band_ready": self.delta_band_ready(),
            "in_no_trade_band": self.in_no_trade_band(),
            "out_of_band": self.out_of_band(),
            "cost_ok": self.cost_ok(),
            "liquidity_ok": self.liquidity_ok(),
            "retry_allowed": self.retry_allowed(),
            "exec_fault": self.exec_fault(),
            "positions_ok": self.positions_ok(),
            "strategy_enabled": self.strategy_enabled(),
        }
