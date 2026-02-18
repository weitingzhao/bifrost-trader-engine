#!/usr/bin/env python3
"""Generate FSM linkage diagram: Daemon ↔ Trading ↔ Hedge interaction.

Run: python scripts/fsm_linkage_diagram.py [mermaid|html]
Output: Mermaid sequence diagram showing how the three FSMs interact.
"""
import sys
from pathlib import Path

_project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_project_root))


def emit_mermaid() -> str:
    """Generate Mermaid sequence diagram for FSM linkage."""
    return """sequenceDiagram
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
"""


def emit_html(out_path: str | None = None) -> str:
    """Generate standalone HTML with Mermaid sequence diagram (open in browser)."""
    if out_path is None:
        out_path = str(_project_root / "docs" / "fsm" / "fsm_linkage_diagram.html")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    mermaid_code = emit_mermaid()
    escaped = mermaid_code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>FSM Linkage Diagram</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
</head>
<body>
  <h1>FSM Linkage: Daemon &harr; Trading &harr; Hedge</h1>
  <p>Sequence diagram showing how the three FSMs interact.</p>
  <div class="mermaid">
{escaped}
  </div>
</body>
</html>"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    return out_path


def emit_md(out_path: str | None = None) -> str:
    """Generate Markdown for MkDocs: title, Mermaid sequence diagram."""
    if out_path is None:
        out_path = str(_project_root / "docs" / "fsm" / "linkage.md")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    mermaid_code = emit_mermaid()
    md = f"""# FSM Linkage: Daemon ↔ Trading ↔ Hedge

Sequence diagram showing how the three FSMs interact. See [FSM Linkage (detailed)](FSM_LINKAGE.md) for full explanation.

## Sequence Diagram

[Open in browser](../fsm_linkage_diagram.html) — zoomable standalone HTML

```mermaid
{mermaid_code}
```
"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    return out_path


def main() -> None:
    mode = "mermaid" if len(sys.argv) <= 1 else sys.argv[1]
    if mode == "mermaid":
        print(emit_mermaid())
    elif mode == "md":
        out = emit_md()
        print(f"Wrote {out}")
    elif mode == "html":
        out = emit_html()
        print(f"Wrote {out} - open in browser")
    else:
        print("Usage: python scripts/fsm_linkage_diagram.py [mermaid|md|html]")
        print("  mermaid - sequence diagram (paste into https://mermaid.live)")
        print("  md     - generate docs/fsm/linkage.md for MkDocs")
        print("  html   - generate docs/fsm/fsm_linkage_diagram.html")


if __name__ == "__main__":
    main()
