# FSM Linkage: Daemon ↔ Trading ↔ Hedge

Three FSMs work together in `GsTrading` (gs_trading.py). This doc explains how they interact and when each transitions.

## Hierarchy

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DaemonFSM (lifecycle)                                                   │
│  "When can we run?"  IDLE → CONNECTING → CONNECTED → RUNNING → STOPPING  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  only when RUNNING
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  TradingFSM (strategy)                                                   │
│  "When should we hedge?"  BOOT → SYNC → IDLE → ARMED → MONITOR           │
│                          → NEED_HEDGE ⇄ HEDGING ⇄ SAFE                   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  only when NEED_HEDGE
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  HedgeFSM (execution)                                                    │
│  "How to execute?"  EXEC_IDLE → PLAN → SEND → WAIT_ACK → WORKING/FILLED  │
└─────────────────────────────────────────────────────────────────────────┘
```

## Trigger Points

| Trigger | DaemonFSM | TradingFSM | HedgeFSM |
|---------|-----------|------------|----------|
| `run()` loop | `transition()` | - | - |
| `_handle_connected` | - | `apply_transition(START, SYNCED)` | - |
| `_on_ticker` / `_eval_hedge_threadsafe` | - | `apply_transition(TICK)` | - |
| `_eval_hedge` (TradingFSM→NEED_HEDGE) | - | `apply_transition(TARGET_EMITTED)` | `on_target`, `on_plan_decide` |
| `_hedge` | - | `apply_transition(HEDGE_DONE/FAILED)` | `on_order_placed`, `on_ack_ok/reject`, `on_full_fill` |
| `stop()` | `request_stop()` | - | - |

## Flow: Startup → First Hedge

```
DaemonFSM          TradingFSM         HedgeFSM          GsTrading
    │                   │                  │                 │
    │ IDLE              │ BOOT             │ EXEC_IDLE       │
    │                   │                  │                 │
    │ _handle_idle      │                  │                 │
    │ CONNECTING        │                  │                 │
    │                   │                  │                 │
    │ _handle_connecting│                  │                 │
    │ CONNECTED         │                  │                 │
    │                   │                  │                 │
    │ _handle_connected │ apply(START)     │                 │
    │                   │ SYNC             │                 │
    │                   │ apply(SYNCED)     │                 │
    │                   │ IDLE/SAFE         │                 │
    │ transition(RUNNING)                  │                 │
    │ RUNNING           │                  │                 │
    │                   │                  │                 │
    │ _handle_running   │                  │ subscribe_ticker│
    │ (loop)            │                  │ _on_ticker ────┼──► _eval_hedge_threadsafe
    │                   │                  │                 │
    │                   │ apply(TICK)      │                 │
    │                   │ MONITOR/...       │                 │
    │                   │ NEED_HEDGE       │                 │
    │                   │                  │                 │
    │                   │ apply(TARGET_EMITTED)              │
    │                   │ HEDGING          │ on_target       │
    │                   │                  │ PLAN            │
    │                   │                  │ on_plan_decide  │
    │                   │                  │ SEND            │
    │                   │                  │ on_order_placed │
    │                   │                  │ WAIT_ACK        │
    │                   │                  │ on_ack_ok       │
    │                   │                  │ WORKING         │
    │                   │                  │ on_full_fill    │
    │                   │ apply(HEDGE_DONE)│ FILLED          │
    │                   │ MONITOR          │                 │
```

## Guard Conditions

### Before _eval_hedge runs
- `_fsm_daemon.is_running()` must be True (DaemonFSM = RUNNING)
- Otherwise `_eval_hedge_threadsafe` / `_eval_hedge_in_loop` do nothing

### Before _hedge runs
- `_fsm_trading.state == TradingState.NEED_HEDGE`
- `_fsm_hedge.can_place_order()` (HedgeFSM in EXEC_IDLE or FILLED)
- `apply_hedge_gates()` returns approved (ExecutionGuard)

### HedgeFSM → TradingFSM feedback
- `HEDGE_DONE` → TradingFSM: `apply_transition(HEDGE_DONE)` → MONITOR
- `HEDGE_FAILED` → TradingFSM: `apply_transition(HEDGE_FAILED)` → NEED_HEDGE (retry) or SAFE

## Hedge State (E) in Composite State

`OrderManager.effective_e_state()` delegates to `HedgeFSM.effective_execution_state()`:
- HedgeFSM EXEC_IDLE / FILLED → ExecutionState.IDLE
- HedgeFSM PLAN/SEND/WORKING/... → ExecutionState.ORDER_WORKING
- HedgeFSM FAIL → ExecutionState.BROKER_ERROR

This E state feeds into `StateClassifier` → `CompositeState` → `StateSnapshot` → TradingFSM guards.

## Files

| FSM | Definition | Driven by |
|-----|------------|-----------|
| DaemonFSM | src/fsm/daemon_fsm.py | gs_trading.run(), _handle_*, stop() |
| TradingFSM | src/fsm/trading_fsm.py | gs_trading._eval_hedge, _handle_connected, _hedge |
| HedgeFSM | src/fsm/hedge_fsm.py | gs_trading._hedge |

## Summary

- **DaemonFSM** gates whether the main loop and ticker callbacks run.
- **TradingFSM** decides whether to hedge (NEED_HEDGE) and receives feedback (HEDGE_DONE/FAILED).
- **HedgeFSM** executes the order flow; its state (E) influences TradingFSM guards via composite state.
