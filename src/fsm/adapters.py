"""Adapters: bridge legacy ExecutionFSM / OrderManager with HedgeExecutionFSM for gradual migration."""

from typing import Any, Optional

from src.core.state.enums import ExecutionState
from src.fsm.hedge_execution_fsm import HedgeExecutionFSM
from src.fsm.events import TargetPositionEvent


def execution_state_from_hedge_fsm(
    hedge_fsm: Optional[HedgeExecutionFSM],
    connected: bool = True,
) -> ExecutionState:
    """
    Map HedgeExecutionFSM to legacy ExecutionState (E0..E4) for CompositeState/StateClassifier.
    When hedge_fsm is None, return IDLE (caller uses legacy path).
    """
    if hedge_fsm is None:
        return ExecutionState.IDLE
    return hedge_fsm.effective_execution_state()


def target_position_event_from_intent(
    target_shares: int,
    side: str,
    quantity: int,
    reason: str = "delta_hedge",
    ts: Optional[float] = None,
    trace_id: Optional[str] = None,
) -> TargetPositionEvent:
    """Build TargetPositionEvent from strategy HedgeIntent / TargetPosition for HedgeExecutionFSM."""
    import time
    return TargetPositionEvent(
        target_shares=target_shares,
        reason=reason,
        ts=ts or time.time(),
        trace_id=trace_id,
        side=side,
        quantity=quantity,
    )
