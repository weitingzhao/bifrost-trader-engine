"""Execution FSM: E0 <-> E1 <-> E2, E3, E4. No duplicate orders when E1/E2."""

import logging
from typing import Optional

from src.core.state.enums import ExecutionState
from src.execution.order_manager import OrderManager

logger = logging.getLogger(__name__)

# Valid transitions: from -> set(allowed to)
_TRANSITIONS: dict[ExecutionState, set[ExecutionState]] = {
    ExecutionState.IDLE: {
        ExecutionState.ORDER_WORKING,
        ExecutionState.DISCONNECTED,
        ExecutionState.BROKER_ERROR,
    },
    ExecutionState.ORDER_WORKING: {
        ExecutionState.IDLE,
        ExecutionState.PARTIAL_FILL,
        ExecutionState.DISCONNECTED,
        ExecutionState.BROKER_ERROR,
    },
    ExecutionState.PARTIAL_FILL: {
        ExecutionState.IDLE,
        ExecutionState.DISCONNECTED,
        ExecutionState.BROKER_ERROR,
    },
    ExecutionState.DISCONNECTED: {ExecutionState.IDLE},
    ExecutionState.BROKER_ERROR: {ExecutionState.IDLE},
}


class ExecutionFSM:
    """Execution state machine; drives OrderManager state."""

    def __init__(self, order_manager: OrderManager):
        self._om = order_manager

    def can_place_order(self) -> bool:
        """True only when E0 IDLE (and connected, no broker error)."""
        e = self._om.effective_e_state()
        return e == ExecutionState.IDLE

    def transition_to(self, to_state: ExecutionState) -> bool:
        """Transition OrderManager to to_state if valid."""
        current = self._om.execution_state
        allowed = _TRANSITIONS.get(current, set())
        if to_state not in allowed:
            logger.warning(
                "Invalid execution transition %s -> %s",
                current.value,
                to_state.value,
            )
            return False
        self._om.set_execution_state(to_state)
        logger.debug("Execution state: %s -> %s", current.value, to_state.value)
        return True

    def on_order_sent(self) -> bool:
        """Call when order is sent. E0 -> E1."""
        return self.transition_to(ExecutionState.ORDER_WORKING)

    def on_partial_fill(self) -> bool:
        """Call on partial fill. E1 -> E2."""
        return self.transition_to(ExecutionState.PARTIAL_FILL)

    def on_fill_complete(self) -> bool:
        """Call when order fully filled. E1 or E2 -> E0."""
        return self.transition_to(ExecutionState.IDLE)

    def on_order_cancelled(self) -> bool:
        """Call when order cancelled. E1 or E2 -> E0."""
        return self.transition_to(ExecutionState.IDLE)

    def on_disconnect(self) -> bool:
        """Call on connection loss. Any -> E3."""
        self._om.set_connected(False)
        self._om.set_execution_state(ExecutionState.DISCONNECTED)
        return True

    def on_reconnect(self) -> bool:
        """Call on reconnect. E3 -> E0."""
        self._om.set_connected(True)
        self._om.set_execution_state(ExecutionState.IDLE)
        self._om.set_broker_error(None)
        return True

    def on_broker_error(self, msg: Optional[str] = None) -> bool:
        """Call on broker error. Any -> E4."""
        self._om.set_broker_error(msg or "broker_error")
        self._om.set_execution_state(ExecutionState.BROKER_ERROR)
        return True

    def on_broker_recovery(self) -> bool:
        """Call when broker recovers. E4 -> E0."""
        self._om.set_broker_error(None)
        self._om.set_execution_state(ExecutionState.IDLE)
        return True
