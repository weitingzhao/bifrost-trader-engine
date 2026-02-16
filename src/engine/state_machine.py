"""State machine for daemon lifecycle: IDLE -> CONNECTING -> CONNECTED -> RUNNING -> STOPPING -> STOPPED."""

import enum
import logging
from typing import Callable, Optional

logger = logging.getLogger(__name__)


class DaemonState(str, enum.Enum):
    """Daemon lifecycle states."""

    IDLE = "idle"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RUNNING = "running"
    STOPPING = "stopping"
    STOPPED = "stopped"


# Valid transitions: from_state -> set of allowed to_states
_TRANSITIONS: dict[DaemonState, set[DaemonState]] = {
    DaemonState.IDLE: {DaemonState.CONNECTING},
    DaemonState.CONNECTING: {DaemonState.CONNECTED, DaemonState.STOPPED},
    DaemonState.CONNECTED: {DaemonState.RUNNING, DaemonState.STOPPED},
    DaemonState.RUNNING: {DaemonState.STOPPING},
    DaemonState.STOPPING: {DaemonState.STOPPED},
    DaemonState.STOPPED: set(),
}


class DaemonStateMachine:
    """Manages daemon lifecycle state and transitions."""

    def __init__(
        self,
        on_transition: Optional[Callable[[DaemonState, DaemonState], None]] = None,
    ):
        self._current = DaemonState.IDLE
        self._on_transition = on_transition

    @property
    def current(self) -> DaemonState:
        return self._current

    def can_transition_to(self, to_state: DaemonState) -> bool:
        """Check if transition from current state to to_state is valid."""
        allowed = _TRANSITIONS.get(self._current, set())
        return to_state in allowed

    def transition(self, to_state: DaemonState) -> bool:
        """
        Transition to new state if valid. Returns True on success, False otherwise.
        Calls on_transition(from, to) callback if provided.
        """
        if not self.can_transition_to(to_state):
            logger.warning(
                "Invalid transition: %s -> %s (allowed: %s)",
                self._current.value,
                to_state.value,
                [s.value for s in _TRANSITIONS.get(self._current, set())],
            )
            return False
        from_state = self._current
        self._current = to_state
        logger.debug("State: %s -> %s", from_state.value, to_state.value)
        if self._on_transition:
            try:
                self._on_transition(from_state, to_state)
            except Exception as e:
                logger.debug("on_transition callback error: %s", e)
        return True

    def is_running(self) -> bool:
        """True when daemon is in RUNNING state (heartbeat, main loop active)."""
        return self._current == DaemonState.RUNNING

    def is_active(self) -> bool:
        """True when daemon can process hedges (CONNECTED or RUNNING)."""
        return self._current in (DaemonState.CONNECTED, DaemonState.RUNNING)

    def request_stop(self) -> bool:
        """Request transition to STOPPING from RUNNING. Returns True if transition applied."""
        if self._current == DaemonState.RUNNING:
            return self.transition(DaemonState.STOPPING)
        if self._current in (DaemonState.IDLE, DaemonState.CONNECTING, DaemonState.CONNECTED):
            return self.transition(DaemonState.STOPPED)
        return False
