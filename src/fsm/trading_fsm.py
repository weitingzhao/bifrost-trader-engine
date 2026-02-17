"""Trading FSM (macro): BOOT -> SYNC -> IDLE -> ARMED -> MONITOR -> NEED_HEDGE/HEDGING/SAFE/etc."""

import logging
from typing import Any, Callable, Dict, Optional

from src.core.state.enums import TradingState
from src.guards.trading_guard import (
    broker_down,
    broker_up,
    cost_ok,
    data_ok,
    data_stale,
    delta_band_ready,
    exec_fault,
    greeks_bad,
    have_option_position,
    in_no_trade_band,
    liquidity_ok,
    out_of_band,
    positions_ok,
    retry_allowed,
    strategy_enabled,
)
from src.core.state.snapshot import StateSnapshot
from src.fsm.events import TradingEvent

logger = logging.getLogger(__name__)


def _eval_guards(
    snapshot: StateSnapshot,
    config: Optional[Dict[str, Any]],
    guard: Any,
) -> Dict[str, bool]:
    """Evaluate all guards used by TradingFSM; return dict of guard_name -> bool."""
    return {
        "data_ok": data_ok(snapshot, config),
        "data_stale": data_stale(snapshot, config),
        "greeks_bad": greeks_bad(snapshot),
        "broker_down": broker_down(snapshot),
        "broker_up": broker_up(snapshot),
        "have_option_position": have_option_position(snapshot),
        "delta_band_ready": delta_band_ready(snapshot, config),
        "in_no_trade_band": in_no_trade_band(snapshot, config),
        "out_of_band": out_of_band(snapshot, config),
        "cost_ok": cost_ok(snapshot, config),
        "liquidity_ok": liquidity_ok(snapshot, config),
        "retry_allowed": retry_allowed(snapshot, guard, config),
        "exec_fault": exec_fault(snapshot),
        "positions_ok": positions_ok(snapshot),
        "strategy_enabled": strategy_enabled(snapshot, config),
    }


class TradingFSM:
    """
    Top-level Trading FSM. Transition table driven by events and guards.
    Any -> SAFE on broker_down || data_stale || greeks_bad || exec_fault.
    """

    def __init__(
        self,
        config: Optional[Dict[str, Any]] = None,
        guard: Any = None,
        on_transition: Optional[
            Callable[[TradingState, TradingState, TradingEvent, Dict[str, bool]], None]
        ] = None,
    ):
        self._state = TradingState.BOOT
        self._config = config or {}
        self._guard = guard
        self._on_transition = on_transition

    @property
    def state(self) -> TradingState:
        return self._state

    def eval_guards(self, snapshot: StateSnapshot) -> Dict[str, bool]:
        """Return current guard evaluations for logging."""
        return _eval_guards(snapshot, self._config, self._guard)

    def transition(
        self,
        event: TradingEvent,
        snapshot: StateSnapshot,
    ) -> Optional[TradingState]:
        """
        Compute next state from current state, event, and guards.
        Returns new state if transition is valid, else None.
        Does not mutate state; caller should set state = return value.
        """
        s = self._state
        g = _eval_guards(snapshot, self._config, self._guard)

        # Any -> SAFE on broker_down || data_stale || greeks_bad || exec_fault
        if g["broker_down"] or g["data_stale"] or g["greeks_bad"] or g["exec_fault"]:
            if s != TradingState.SAFE:
                self._fire_transition(s, TradingState.SAFE, event, g)
                return TradingState.SAFE
            return None

        if event == TradingEvent.SHUTDOWN:
            return None  # caller handles shutdown

        if event == TradingEvent.START and s == TradingState.BOOT:
            self._fire_transition(s, TradingState.SYNC, event, g)
            return TradingState.SYNC

        if event in (TradingEvent.SYNCED, TradingEvent.QUOTE, TradingEvent.TICK, TradingEvent.GREEKS_UPDATE):
            if s == TradingState.SYNC:
                if g["positions_ok"] and g["data_ok"]:
                    self._fire_transition(s, TradingState.IDLE, event, g)
                    return TradingState.IDLE
                if not g["data_ok"] or g["broker_down"]:
                    self._fire_transition(s, TradingState.SAFE, event, g)
                    return TradingState.SAFE

            if s == TradingState.IDLE:
                if g["data_stale"] or g["greeks_bad"] or g["broker_down"]:
                    self._fire_transition(s, TradingState.SAFE, event, g)
                    return TradingState.SAFE
                if g["have_option_position"] and g["strategy_enabled"]:
                    self._fire_transition(s, TradingState.ARMED, event, g)
                    return TradingState.ARMED

            if s == TradingState.ARMED:
                if g["delta_band_ready"]:
                    self._fire_transition(s, TradingState.MONITOR, event, g)
                    return TradingState.MONITOR

            if s == TradingState.MONITOR:
                if g["in_no_trade_band"]:
                    self._fire_transition(s, TradingState.NO_TRADE, event, g)
                    return TradingState.NO_TRADE
                if g["out_of_band"] and g["cost_ok"] and g["liquidity_ok"]:
                    self._fire_transition(s, TradingState.NEED_HEDGE, event, g)
                    return TradingState.NEED_HEDGE
                if g["out_of_band"] and not g["cost_ok"]:
                    self._fire_transition(s, TradingState.PAUSE_COST, event, g)
                    return TradingState.PAUSE_COST
                if g["out_of_band"] and not g["liquidity_ok"]:
                    self._fire_transition(s, TradingState.PAUSE_LIQ, event, g)
                    return TradingState.PAUSE_LIQ

            if s == TradingState.NO_TRADE:
                if g["out_of_band"] and g["cost_ok"] and g["liquidity_ok"]:
                    self._fire_transition(s, TradingState.NEED_HEDGE, event, g)
                    return TradingState.NEED_HEDGE
                if g["out_of_band"] and not g["cost_ok"]:
                    self._fire_transition(s, TradingState.PAUSE_COST, event, g)
                    return TradingState.PAUSE_COST
                if g["out_of_band"] and not g["liquidity_ok"]:
                    self._fire_transition(s, TradingState.PAUSE_LIQ, event, g)
                    return TradingState.PAUSE_LIQ

            if s in (TradingState.PAUSE_COST, TradingState.PAUSE_LIQ):
                if g["in_no_trade_band"]:
                    self._fire_transition(s, TradingState.NO_TRADE, event, g)
                    return TradingState.NO_TRADE
                if g["out_of_band"] and g["cost_ok"] and g["liquidity_ok"]:
                    self._fire_transition(s, TradingState.NEED_HEDGE, event, g)
                    return TradingState.NEED_HEDGE

        if event == TradingEvent.TARGET_EMITTED and s == TradingState.NEED_HEDGE:
            self._fire_transition(s, TradingState.HEDGING, event, g)
            return TradingState.HEDGING

        if event == TradingEvent.HEDGE_DONE and s == TradingState.HEDGING:
            self._fire_transition(s, TradingState.MONITOR, event, g)
            return TradingState.MONITOR

        if event == TradingEvent.HEDGE_FAILED and s == TradingState.HEDGING:
            if g["retry_allowed"]:
                self._fire_transition(s, TradingState.NEED_HEDGE, event, g)
                return TradingState.NEED_HEDGE
            self._fire_transition(s, TradingState.SAFE, event, g)
            return TradingState.SAFE

        if event == TradingEvent.MANUAL_RESUME and s == TradingState.SAFE:
            if g["broker_up"] and g["data_ok"]:
                self._fire_transition(s, TradingState.SYNC, event, g)
                return TradingState.SYNC

        if event == TradingEvent.BROKER_UP and s == TradingState.SAFE:
            if g["data_ok"]:
                self._fire_transition(s, TradingState.SYNC, event, g)
                return TradingState.SYNC

        return None

    def apply_transition(
        self,
        event: TradingEvent,
        snapshot: StateSnapshot,
    ) -> bool:
        """
        Apply transition: compute next state and if valid, set _state and return True.
        """
        next_state = self.transition(event, snapshot)
        if next_state is not None:
            self._state = next_state
            return True
        return False

    def _fire_transition(
        self,
        from_state: TradingState,
        to_state: TradingState,
        event: TradingEvent,
        guards: Dict[str, bool],
    ) -> None:
        logger.debug(
            "TradingFSM %s -> %s on %s guards=%s",
            from_state.value,
            to_state.value,
            event.value,
            {k: v for k, v in guards.items() if v},
        )
        if self._on_transition:
            try:
                self._on_transition(from_state, to_state, event, guards)
            except Exception as e:
                logger.debug("on_transition error: %s", e)
