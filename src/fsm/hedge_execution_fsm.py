"""Hedge Execution FSM: EXEC_IDLE -> PLAN -> SEND -> WAIT_ACK -> WORKING -> FILLED/PARTIAL/REPRICE/CANCEL/FAIL."""

import logging
from typing import Callable, Optional

from src.core.state.enums import ExecutionState, HedgeExecState
from src.fsm.events import ExecEvent, TargetPositionEvent

logger = logging.getLogger(__name__)

# Valid transitions: from_state -> set of (event, to_state) or (event, guard_key, to_state)
# Simplified: we use a transition table (from, event) -> to_state with optional guard
_TRANSITIONS: dict[tuple[HedgeExecState, ExecEvent], HedgeExecState] = {
    (HedgeExecState.EXEC_IDLE, ExecEvent.RECV_TARGET): HedgeExecState.PLAN,
    (HedgeExecState.PLAN, ExecEvent.PLAN_SKIP): HedgeExecState.EXEC_IDLE,
    (HedgeExecState.PLAN, ExecEvent.PLAN_SEND): HedgeExecState.SEND,
    (HedgeExecState.SEND, ExecEvent.PLACE_ORDER): HedgeExecState.WAIT_ACK,
    (HedgeExecState.WAIT_ACK, ExecEvent.ACK_OK): HedgeExecState.WORKING,
    (HedgeExecState.WAIT_ACK, ExecEvent.ACK_REJECT): HedgeExecState.FAIL,
    (HedgeExecState.WAIT_ACK, ExecEvent.TIMEOUT_ACK): HedgeExecState.FAIL,
    (HedgeExecState.WAIT_ACK, ExecEvent.BROKER_DOWN): HedgeExecState.FAIL,
    (HedgeExecState.WORKING, ExecEvent.PARTIAL_FILL): HedgeExecState.PARTIAL,
    (HedgeExecState.WORKING, ExecEvent.FULL_FILL): HedgeExecState.FILLED,
    (HedgeExecState.WORKING, ExecEvent.TIMEOUT_WORKING): HedgeExecState.REPRICE,
    (HedgeExecState.WORKING, ExecEvent.RISK_TRIP): HedgeExecState.CANCEL,
    (HedgeExecState.WORKING, ExecEvent.MANUAL_CANCEL): HedgeExecState.CANCEL,
    (HedgeExecState.WORKING, ExecEvent.BROKER_DOWN): HedgeExecState.CANCEL,
    (HedgeExecState.PARTIAL, ExecEvent.PLAN_SEND): HedgeExecState.SEND,
    (HedgeExecState.PARTIAL, ExecEvent.PLAN_SKIP): HedgeExecState.EXEC_IDLE,
    (HedgeExecState.REPRICE, ExecEvent.PLACE_ORDER): HedgeExecState.WAIT_ACK,
    (HedgeExecState.CANCEL, ExecEvent.CANCEL_SENT): HedgeExecState.RECOVER,
    (HedgeExecState.RECOVER, ExecEvent.POSITIONS_RESYNCED): HedgeExecState.EXEC_IDLE,
    (HedgeExecState.RECOVER, ExecEvent.CANNOT_RECOVER): HedgeExecState.FAIL,
    (HedgeExecState.FAIL, ExecEvent.TRY_RESYNC): HedgeExecState.RECOVER,
    (HedgeExecState.FILLED, ExecEvent.RECV_TARGET): HedgeExecState.PLAN,
}
# FILLED and EXEC_IDLE both allow RECV_TARGET -> PLAN; EXEC_IDLE is terminal for a cycle
_TRANSITIONS[(HedgeExecState.FILLED, ExecEvent.RECV_TARGET)] = HedgeExecState.PLAN


def _to_execution_state(h: HedgeExecState, connected: bool) -> ExecutionState:
    """Map HedgeExecState to legacy ExecutionState (E0..E4) for composite state."""
    if not connected:
        return ExecutionState.DISCONNECTED
    if h == HedgeExecState.FAIL:
        return ExecutionState.BROKER_ERROR
    if h in (HedgeExecState.EXEC_IDLE, HedgeExecState.FILLED):
        return ExecutionState.IDLE
    if h == HedgeExecState.PARTIAL:
        return ExecutionState.PARTIAL_FILL
    if h in (
        HedgeExecState.PLAN,
        HedgeExecState.SEND,
        HedgeExecState.WAIT_ACK,
        HedgeExecState.WORKING,
        HedgeExecState.REPRICE,
        HedgeExecState.CANCEL,
        HedgeExecState.RECOVER,
    ):
        return ExecutionState.ORDER_WORKING
    return ExecutionState.IDLE


class HedgeExecutionFSM:
    """
    Execution sub-FSM: receives TargetPosition, plans, sends order, waits ack/fill,
    handles partial/reprice/cancel/recover.
    """

    def __init__(
        self,
        min_hedge_shares: int = 10,
        on_transition: Optional[Callable[[HedgeExecState, HedgeExecState, ExecEvent], None]] = None,
    ):
        self._state = HedgeExecState.EXEC_IDLE
        self._min_hedge_shares = min_hedge_shares
        self._on_transition = on_transition
        self._current_target: Optional[TargetPositionEvent] = None
        self._need_shares: int = 0  # signed: positive = buy, negative = sell
        self._connected = True

    @property
    def state(self) -> HedgeExecState:
        return self._state

    @property
    def need_shares(self) -> int:
        return self._need_shares

    @property
    def current_target(self) -> Optional[TargetPositionEvent]:
        return self._current_target

    def set_connected(self, connected: bool) -> None:
        self._connected = connected

    def effective_execution_state(self) -> ExecutionState:
        """E state for composite/snapshot (E0..E4)."""
        return _to_execution_state(self._state, self._connected)

    def can_place_order(self) -> bool:
        """True when in EXEC_IDLE or FILLED (ready to accept new target)."""
        return self._state in (HedgeExecState.EXEC_IDLE, HedgeExecState.FILLED)

    def _transition(self, to_state: HedgeExecState, event: ExecEvent) -> bool:
        from_state = self._state
        self._state = to_state
        logger.debug(
            "HedgeExecFSM %s -> %s on %s",
            from_state.value,
            to_state.value,
            event.value,
        )
        if self._on_transition:
            try:
                self._on_transition(from_state, to_state, event)
            except Exception as e:
                logger.debug("on_transition callback error: %s", e)
        return True

    def on_target(self, target: TargetPositionEvent, current_stock_pos: int) -> bool:
        """
        Receive TargetPosition: transition to PLAN. Stores need_shares = target_shares - current_stock_pos.
        """
        if not self.can_place_order():
            logger.warning("HedgeExecFSM received target in state %s", self._state.value)
            return False
        self._current_target = target
        self._need_shares = target.target_shares - current_stock_pos
        return self._transition(HedgeExecState.PLAN, ExecEvent.RECV_TARGET)

    def on_plan_decide(self, send_order: bool) -> bool:
        """
        After PLAN: if send_order (abs(need_shares) >= min_size) -> SEND; else -> EXEC_IDLE.
        """
        if self._state != HedgeExecState.PLAN:
            return False
        if send_order:
            return self._transition(HedgeExecState.SEND, ExecEvent.PLAN_SEND)
        self._current_target = None
        return self._transition(HedgeExecState.EXEC_IDLE, ExecEvent.PLAN_SKIP)

    def on_order_placed(self) -> bool:
        """After place_order called: SEND or REPRICE -> WAIT_ACK."""
        if self._state not in (HedgeExecState.SEND, HedgeExecState.REPRICE):
            return False
        return self._transition(HedgeExecState.WAIT_ACK, ExecEvent.PLACE_ORDER)

    def on_ack_ok(self) -> bool:
        """Broker ack ok: WAIT_ACK -> WORKING."""
        if self._state != HedgeExecState.WAIT_ACK:
            return False
        return self._transition(HedgeExecState.WORKING, ExecEvent.ACK_OK)

    def on_ack_reject(self) -> bool:
        """Broker ack reject: WAIT_ACK -> FAIL."""
        if self._state != HedgeExecState.WAIT_ACK:
            return False
        return self._transition(HedgeExecState.FAIL, ExecEvent.ACK_REJECT)

    def on_timeout_ack(self) -> bool:
        """Ack timeout: WAIT_ACK -> FAIL."""
        if self._state != HedgeExecState.WAIT_ACK:
            return False
        return self._transition(HedgeExecState.FAIL, ExecEvent.TIMEOUT_ACK)

    def on_partial_fill(self) -> bool:
        """Partial fill: WORKING -> PARTIAL."""
        if self._state != HedgeExecState.WORKING:
            return False
        return self._transition(HedgeExecState.PARTIAL, ExecEvent.PARTIAL_FILL)

    def on_full_fill(self) -> bool:
        """Full fill: WORKING -> FILLED; clear target."""
        if self._state != HedgeExecState.WORKING:
            return False
        self._current_target = None
        self._need_shares = 0
        return self._transition(HedgeExecState.FILLED, ExecEvent.FULL_FILL)

    def on_timeout_working(self) -> bool:
        """Working timeout (reprice): WORKING -> REPRICE."""
        if self._state != HedgeExecState.WORKING:
            return False
        return self._transition(HedgeExecState.REPRICE, ExecEvent.TIMEOUT_WORKING)

    def on_risk_trip(self) -> bool:
        """Risk trip: WORKING -> CANCEL."""
        if self._state != HedgeExecState.WORKING:
            return False
        return self._transition(HedgeExecState.CANCEL, ExecEvent.RISK_TRIP)

    def on_manual_cancel(self) -> bool:
        """Manual cancel: WORKING -> CANCEL."""
        if self._state != HedgeExecState.WORKING:
            return False
        return self._transition(HedgeExecState.CANCEL, ExecEvent.MANUAL_CANCEL)

    def on_broker_down(self) -> bool:
        """Broker down: WAIT_ACK -> FAIL, WORKING -> CANCEL."""
        if self._state == HedgeExecState.WAIT_ACK:
            return self._transition(HedgeExecState.FAIL, ExecEvent.BROKER_DOWN)
        if self._state == HedgeExecState.WORKING:
            return self._transition(HedgeExecState.CANCEL, ExecEvent.BROKER_DOWN)
        self._connected = False
        return True

    def on_cancel_sent(self) -> bool:
        """Cancel sent: CANCEL -> RECOVER."""
        if self._state != HedgeExecState.CANCEL:
            return False
        return self._transition(HedgeExecState.RECOVER, ExecEvent.CANCEL_SENT)

    def on_positions_resynced(self) -> bool:
        """Positions resynced: RECOVER -> EXEC_IDLE."""
        if self._state != HedgeExecState.RECOVER:
            return False
        self._current_target = None
        self._need_shares = 0
        return self._transition(HedgeExecState.EXEC_IDLE, ExecEvent.POSITIONS_RESYNCED)

    def on_cannot_recover(self) -> bool:
        """Cannot recover: RECOVER -> FAIL."""
        if self._state != HedgeExecState.RECOVER:
            return False
        return self._transition(HedgeExecState.FAIL, ExecEvent.CANNOT_RECOVER)

    def on_try_resync(self) -> bool:
        """Try resync: FAIL -> RECOVER."""
        if self._state != HedgeExecState.FAIL:
            return False
        return self._transition(HedgeExecState.RECOVER, ExecEvent.TRY_RESYNC)

    def on_partial_replan(self, send_order: bool) -> bool:
        """After PARTIAL: replan -> SEND or EXEC_IDLE."""
        if self._state != HedgeExecState.PARTIAL:
            return False
        if send_order:
            return self._transition(HedgeExecState.SEND, ExecEvent.PLAN_SEND)
        self._current_target = None
        self._need_shares = 0
        return self._transition(HedgeExecState.EXEC_IDLE, ExecEvent.PLAN_SKIP)
