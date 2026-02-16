"""Execution FSM tests: E0->E1->E2->E0, no duplicate order when E1, timeout/reconnect."""

import pytest

from src.core.state.enums import ExecutionState
from src.execution.execution_fsm import ExecutionFSM
from src.execution.order_manager import OrderManager


class TestExecutionFSMTransitions:
    def test_e0_to_e1_on_order_sent(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        assert om.effective_e_state() == ExecutionState.IDLE
        assert fsm.can_place_order() is True
        assert fsm.on_order_sent() is True
        assert om.execution_state == ExecutionState.ORDER_WORKING
        assert fsm.can_place_order() is False

    def test_e1_to_e2_on_partial_fill(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_order_sent()
        assert fsm.on_partial_fill() is True
        assert om.execution_state == ExecutionState.PARTIAL_FILL

    def test_e2_to_e0_on_fill_complete(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_order_sent()
        fsm.on_partial_fill()
        assert fsm.on_fill_complete() is True
        assert om.execution_state == ExecutionState.IDLE
        assert fsm.can_place_order() is True

    def test_e1_to_e0_on_fill_complete(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_order_sent()
        assert fsm.on_fill_complete() is True
        assert om.execution_state == ExecutionState.IDLE

    def test_e1_to_e0_on_cancel(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_order_sent()
        assert fsm.on_order_cancelled() is True
        assert om.execution_state == ExecutionState.IDLE

    def test_no_duplicate_when_e1(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_order_sent()
        assert fsm.can_place_order() is False


class TestExecutionFSMDisconnect:
    def test_e1_to_e3_on_disconnect(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_order_sent()
        fsm.on_disconnect()
        assert om.effective_e_state() == ExecutionState.DISCONNECTED

    def test_e3_to_e0_on_reconnect(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_disconnect()
        fsm.on_reconnect()
        assert om.effective_e_state() == ExecutionState.IDLE
        assert fsm.can_place_order() is True


class TestExecutionFSMBrokerError:
    def test_e4_on_broker_error(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_broker_error("timeout")
        assert om.effective_e_state() == ExecutionState.BROKER_ERROR

    def test_e4_to_e0_on_recovery(self):
        om = OrderManager()
        fsm = ExecutionFSM(om)
        fsm.on_broker_error("timeout")
        fsm.on_broker_recovery()
        assert om.effective_e_state() == ExecutionState.IDLE
