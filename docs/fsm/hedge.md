# Hedge FSM

HedgeState, HedgeEvent, and `on_*` methods in `HedgeFSM` (src/fsm/hedge_fsm.py).

## State Diagram

[Open in browser](../fsm_hedge_diagram.html) — zoomable standalone HTML

```mermaid
stateDiagram-v2
    direction TB

    EXEC_IDLE
    PLAN
    SEND
    WAIT_ACK
    WORKING
    PARTIAL
    REPRICE
    CANCEL
    RECOVER
    FILLED
    FAIL

    EXEC_IDLE --> PLAN : recv_target [on_target (HedgeFSM, hedge_fsm.py)]
    PLAN --> EXEC_IDLE : plan_skip [on_plan_decide, on_partial_replan (HedgeFSM, hedge_fsm.py)]
    PLAN --> SEND : plan_send [on_plan_decide, on_partial_replan (HedgeFSM, hedge_fsm.py)]
    SEND --> WAIT_ACK : place_order [on_order_placed (HedgeFSM, hedge_fsm.py)]
    WAIT_ACK --> WORKING : ack_ok [on_ack_ok (HedgeFSM, hedge_fsm.py)]
    WAIT_ACK --> FAIL : ack_reject [on_ack_reject (HedgeFSM, hedge_fsm.py)]
    WAIT_ACK --> FAIL : timeout_ack [on_timeout_ack (HedgeFSM, hedge_fsm.py)]
    WAIT_ACK --> FAIL : broker_down [on_broker_down (HedgeFSM, hedge_fsm.py)]
    WORKING --> PARTIAL : partial_fill [on_partial_fill (HedgeFSM, hedge_fsm.py)]
    WORKING --> FILLED : full_fill [on_full_fill (HedgeFSM, hedge_fsm.py)]
    WORKING --> REPRICE : timeout_working [on_timeout_working (HedgeFSM, hedge_fsm.py)]
    WORKING --> CANCEL : risk_trip [on_risk_trip (HedgeFSM, hedge_fsm.py)]
    WORKING --> CANCEL : manual_cancel [on_manual_cancel (HedgeFSM, hedge_fsm.py)]
    WORKING --> CANCEL : broker_down [on_broker_down (HedgeFSM, hedge_fsm.py)]
    PARTIAL --> SEND : plan_send [on_plan_decide, on_partial_replan (HedgeFSM, hedge_fsm.py)]
    PARTIAL --> EXEC_IDLE : plan_skip [on_plan_decide, on_partial_replan (HedgeFSM, hedge_fsm.py)]
    REPRICE --> WAIT_ACK : place_order [on_order_placed (HedgeFSM, hedge_fsm.py)]
    CANCEL --> RECOVER : cancel_sent [on_cancel_sent (HedgeFSM, hedge_fsm.py)]
    RECOVER --> EXEC_IDLE : positions_resynced [on_positions_resynced (HedgeFSM, hedge_fsm.py)]
    RECOVER --> FAIL : cannot_recover [on_cannot_recover (HedgeFSM, hedge_fsm.py)]
    FAIL --> RECOVER : try_resync [on_try_resync (HedgeFSM, hedge_fsm.py)]
    FILLED --> PLAN : recv_target [on_target (HedgeFSM, hedge_fsm.py)]
```

## Transition Table

| on_method | class | file | from_state | event | to_state |
|-----------|-------|------|------------|-------|----------|
| on_cancel_sent | HedgeFSM | src/fsm/hedge_fsm.py | CANCEL | cancel_sent | RECOVER |
| on_target | HedgeFSM | src/fsm/hedge_fsm.py | EXEC_IDLE | recv_target | PLAN |
| on_try_resync | HedgeFSM | src/fsm/hedge_fsm.py | FAIL | try_resync | RECOVER |
| on_target | HedgeFSM | src/fsm/hedge_fsm.py | FILLED | recv_target | PLAN |
| on_plan_decide, on_partial_replan | HedgeFSM | src/fsm/hedge_fsm.py | PARTIAL | plan_send | SEND |
| on_plan_decide, on_partial_replan | HedgeFSM | src/fsm/hedge_fsm.py | PARTIAL | plan_skip | EXEC_IDLE |
| on_plan_decide, on_partial_replan | HedgeFSM | src/fsm/hedge_fsm.py | PLAN | plan_send | SEND |
| on_plan_decide, on_partial_replan | HedgeFSM | src/fsm/hedge_fsm.py | PLAN | plan_skip | EXEC_IDLE |
| on_cannot_recover | HedgeFSM | src/fsm/hedge_fsm.py | RECOVER | cannot_recover | FAIL |
| on_positions_resynced | HedgeFSM | src/fsm/hedge_fsm.py | RECOVER | positions_resynced | EXEC_IDLE |
| on_order_placed | HedgeFSM | src/fsm/hedge_fsm.py | REPRICE | place_order | WAIT_ACK |
| on_order_placed | HedgeFSM | src/fsm/hedge_fsm.py | SEND | place_order | WAIT_ACK |
| on_ack_ok | HedgeFSM | src/fsm/hedge_fsm.py | WAIT_ACK | ack_ok | WORKING |
| on_ack_reject | HedgeFSM | src/fsm/hedge_fsm.py | WAIT_ACK | ack_reject | FAIL |
| on_broker_down | HedgeFSM | src/fsm/hedge_fsm.py | WAIT_ACK | broker_down | FAIL |
| on_timeout_ack | HedgeFSM | src/fsm/hedge_fsm.py | WAIT_ACK | timeout_ack | FAIL |
| on_broker_down | HedgeFSM | src/fsm/hedge_fsm.py | WORKING | broker_down | CANCEL |
| on_full_fill | HedgeFSM | src/fsm/hedge_fsm.py | WORKING | full_fill | FILLED |
| on_manual_cancel | HedgeFSM | src/fsm/hedge_fsm.py | WORKING | manual_cancel | CANCEL |
| on_partial_fill | HedgeFSM | src/fsm/hedge_fsm.py | WORKING | partial_fill | PARTIAL |
| on_risk_trip | HedgeFSM | src/fsm/hedge_fsm.py | WORKING | risk_trip | CANCEL |
| on_timeout_working | HedgeFSM | src/fsm/hedge_fsm.py | WORKING | timeout_working | REPRICE |
