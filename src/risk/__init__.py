"""Risk guard: re-export from FSM layer (Hedge Execution FSM order-send gate)."""

from src.core.guards.execution_guard import RiskGuard

__all__ = ["RiskGuard"]
