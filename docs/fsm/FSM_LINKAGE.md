# FSM 串联：Daemon ↔ Trading ↔ Hedge

三个 FSM 在 `GsTrading`（gs_trading.py）中协同工作。本文说明它们如何交互以及各自在何时发生迁移。

## 层级关系

```
┌─────────────────────────────────────────────────────────────────────────┐
│  DaemonFSM（生命周期）                                                    │
│  「何时可以运行？」  IDLE → CONNECTING → CONNECTED → RUNNING → STOPPING   │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  仅当 RUNNING 时
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  TradingFSM（策略）                                                       │
│  「何时应对冲？」  BOOT → SYNC → IDLE → ARMED → MONITOR                   │
│                  → NEED_HEDGE ⇄ HEDGING ⇄ SAFE                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │  仅当 NEED_HEDGE 时
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  HedgeFSM（执行）                                                         │
│  「如何执行？」  EXEC_IDLE → PLAN → SEND → WAIT_ACK → WORKING/FILLED      │
└─────────────────────────────────────────────────────────────────────────┘
```

## 触发点

| 触发 | DaemonFSM | TradingFSM | HedgeFSM |
|------|-----------|------------|----------|
| `run()` 主循环 | `transition()` | - | - |
| `_handle_connected` | - | `apply_transition(START, SYNCED)` | - |
| `_on_ticker` / `_eval_hedge_threadsafe` | - | `apply_transition(TICK)` | - |
| `_eval_hedge`（TradingFSM→NEED_HEDGE） | - | `apply_transition(TARGET_EMITTED)` | `on_target`、`on_plan_decide` |
| `_hedge` | - | `apply_transition(HEDGE_DONE/FAILED)` | `on_order_placed`、`on_ack_ok/reject`、`on_full_fill` |
| `stop()` | `request_stop()` | - | - |

## 流程：启动 → 首次对冲

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
    │                   │ apply(SYNCED)    │                 │
    │                   │ IDLE/SAFE        │                 │
    │ transition(RUNNING)                  │                 │
    │ RUNNING           │                  │                 │
    │                   │                  │                 │
    │ _handle_running   │                  │ subscribe_ticker │
    │ (loop)            │                  │ _on_ticker ────┼──► _eval_hedge_threadsafe
    │                   │                  │                 │
    │                   │ apply(TICK)      │                 │
    │                   │ MONITOR/...      │                 │
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

## 门控条件

### 在 _eval_hedge 运行前
- `_fsm_daemon.is_running()` 必须为 True（DaemonFSM = RUNNING）
- 否则 `_eval_hedge_threadsafe` 不执行任何逻辑

### 在 _hedge 运行前
- `_fsm_trading.state == TradingState.NEED_HEDGE`
- `_fsm_hedge.can_place_order()`（HedgeFSM 处于 EXEC_IDLE 或 FILLED）
- `apply_hedge_gates()` 返回通过（ExecutionGuard）

### HedgeFSM → TradingFSM 反馈
- `HEDGE_DONE` → TradingFSM：`apply_transition(HEDGE_DONE)` → MONITOR
- `HEDGE_FAILED` → TradingFSM：`apply_transition(HEDGE_FAILED)` → NEED_HEDGE（重试）或 SAFE

## Composite State 中的对冲状态 (E)

`OrderManager.effective_e_state()` 委托给 `HedgeFSM.effective_execution_state()`：
- HedgeFSM EXEC_IDLE / FILLED → ExecutionState.IDLE
- HedgeFSM PLAN/SEND/WORKING/... → ExecutionState.ORDER_WORKING
- HedgeFSM FAIL → ExecutionState.BROKER_ERROR

该 E 状态进入 `StateClassifier` → `CompositeState` → `StateSnapshot` → TradingFSM 的 guards。

## 文件

| FSM | 定义位置 | 驱动来源 |
|-----|----------|----------|
| DaemonFSM | src/fsm/daemon_fsm.py | gs_trading.run()、_handle_*、stop() |
| TradingFSM | src/fsm/trading_fsm.py | gs_trading._eval_hedge、_handle_connected、_hedge |
| HedgeFSM | src/fsm/hedge_fsm.py | gs_trading._hedge |

## 小结

- **DaemonFSM** 决定主循环与 ticker 回调是否运行。
- **TradingFSM** 决定是否进入需要对冲（NEED_HEDGE）并接收反馈（HEDGE_DONE/FAILED）。
- **HedgeFSM** 执行订单流程；其状态 (E) 通过 composite state 影响 TradingFSM 的 guards。
