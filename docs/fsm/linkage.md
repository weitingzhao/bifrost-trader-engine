# FSM Linkage: Daemon ↔ Trading ↔ Hedge

Sequence diagram showing how the three FSMs interact. See [FSM Linkage (detailed)](FSM_LINKAGE.md) for full explanation.

## Sequence Diagram

[Open in browser](../fsm_linkage_diagram.html) — zoomable standalone HTML

```mermaid
sequenceDiagram
    participant D as DaemonFSM
    participant T as TradingFSM
    participant H as HedgeFSM
    participant G as GsTrading

    Note over D: run() loop
    G->>D: _handle_idle()
    D->>D: IDLE → CONNECTING
    G->>D: _handle_connecting()
    D->>D: CONNECTING → CONNECTED
    G->>D: _handle_connected()
    G->>T: apply_transition(START)
    T->>T: BOOT → SYNC
    G->>T: apply_transition(SYNCED)
    T->>T: SYNC → IDLE/SAFE
    G->>D: transition(RUNNING)
    D->>D: CONNECTED → RUNNING

    Note over G: subscribe_ticker, _on_ticker
    G->>G: _eval_hedge_threadsafe (only if D.is_running())
    G->>G: _eval_hedge()
    G->>T: apply_transition(TICK)
    T->>T: ... → MONITOR/NO_TRADE/NEED_HEDGE

    alt T.state == NEED_HEDGE
        G->>T: apply_transition(TARGET_EMITTED)
        T->>T: NEED_HEDGE → HEDGING
        G->>H: on_target(target, stock_pos)
        H->>H: EXEC_IDLE → PLAN
        G->>H: on_plan_decide(send_order)
        H->>H: PLAN → SEND
        G->>H: on_order_placed()
        H->>H: SEND → WAIT_ACK
        G->>H: on_ack_ok()
        H->>H: WAIT_ACK → WORKING
        G->>H: on_full_fill()
        H->>H: WORKING → FILLED
        G->>T: apply_transition(HEDGE_DONE)
        T->>T: HEDGING → MONITOR
    end

    Note over D: stop() or loop exit
    G->>D: request_stop()
    D->>D: RUNNING → STOPPING
    G->>D: _handle_stopping()
    D->>D: STOPPING → STOPPED

```
