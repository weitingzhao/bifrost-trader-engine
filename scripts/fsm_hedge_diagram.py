#!/usr/bin/env python3
"""Generate Hedge FSM diagram: HedgeState, HedgeEvent, on_ methods mapping.

Run: python scripts/fsm_hedge_diagram.py  (or python fsm_hedge_diagram.py from scripts/)
Output: Mermaid diagram (paste into https://mermaid.live) or DOT for graphviz.
"""
import sys
from pathlib import Path

# Add project root so "from src..." works when run from scripts/ or project root
_project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_project_root))

from src.core.state.enums import HedgeState
from src.fsm.events import HedgeEvent
from src.fsm.hedge_fsm import _TRANSITIONS

# on_method -> (class_name, file_path)
ON_METHOD_SOURCE: dict[str, tuple[str, str]] = {
    m: ("HedgeFSM", "src/fsm/hedge_fsm.py") for m in [
        "on_target", "on_plan_decide", "on_partial_replan", "on_order_placed",
        "on_ack_ok", "on_ack_reject", "on_timeout_ack", "on_partial_fill",
        "on_full_fill", "on_timeout_working", "on_risk_trip", "on_manual_cancel",
        "on_broker_down", "on_cancel_sent", "on_positions_resynced",
        "on_cannot_recover", "on_try_resync",
    ]
}

# on_method -> HedgeEvent(s) it can emit
ON_TO_EVENTS: dict[str, list[HedgeEvent]] = {
    "on_target": [HedgeEvent.RECV_TARGET],
    "on_plan_decide": [HedgeEvent.PLAN_SEND, HedgeEvent.PLAN_SKIP],
    "on_partial_replan": [HedgeEvent.PLAN_SEND, HedgeEvent.PLAN_SKIP],
    "on_order_placed": [HedgeEvent.PLACE_ORDER],
    "on_ack_ok": [HedgeEvent.ACK_OK],
    "on_ack_reject": [HedgeEvent.ACK_REJECT],
    "on_timeout_ack": [HedgeEvent.TIMEOUT_ACK],
    "on_partial_fill": [HedgeEvent.PARTIAL_FILL],
    "on_full_fill": [HedgeEvent.FULL_FILL],
    "on_timeout_working": [HedgeEvent.TIMEOUT_WORKING],
    "on_risk_trip": [HedgeEvent.RISK_TRIP],
    "on_manual_cancel": [HedgeEvent.MANUAL_CANCEL],
    "on_broker_down": [HedgeEvent.BROKER_DOWN],
    "on_cancel_sent": [HedgeEvent.CANCEL_SENT],
    "on_positions_resynced": [HedgeEvent.POSITIONS_RESYNCED],
    "on_cannot_recover": [HedgeEvent.CANNOT_RECOVER],
    "on_try_resync": [HedgeEvent.TRY_RESYNC],
}


def build_event_to_on() -> dict[HedgeEvent, list[str]]:
    """Reverse: event -> list of on_ methods that emit it."""
    event_to_on: dict[HedgeEvent, list[str]] = {}
    for on_method, events in ON_TO_EVENTS.items():
        for ev in events:
            event_to_on.setdefault(ev, []).append(on_method)
    return event_to_on


def emit_mermaid() -> str:
    """Generate Mermaid stateDiagram for transitions."""
    lines = [
        "stateDiagram-v2",
        "    direction TB",
        "",
    ]
    # Add all states
    for s in HedgeState:
        lines.append(f"    {s.value}")
    lines.append("")

    # Add transitions: from --> to : event
    for (from_s, ev), to_s in _TRANSITIONS.items():
        lines.append(f'    {from_s.value} --> {to_s.value} : {ev.value}')
    return "\n".join(lines)


def _format_on_with_source(on_list: list[str]) -> str:
    """Format on_methods with class and file, e.g. 'on_X, on_Y (HedgeFSM, hedge_fsm.py)'."""
    if not on_list:
        return ""
    # All methods are in HedgeFSM/hedge_fsm.py; show once
    cls, path = ON_METHOD_SOURCE.get(on_list[0], ("?", "?"))
    short_file = path.split("/")[-1] if "/" in path else path
    methods = ", ".join(on_list)
    return f"{methods} ({cls}, {short_file})"


def emit_mermaid_with_on_methods() -> str:
    """Generate Mermaid with on_method + class/file annotations in transition labels."""
    event_to_on = build_event_to_on()
    lines = [
        "stateDiagram-v2",
        "    direction TB",
        "",
    ]
    for s in HedgeState:
        lines.append(f"    {s.value}")
    lines.append("")

    for (from_s, ev), to_s in _TRANSITIONS.items():
        on_list = event_to_on.get(ev, [])
        label = ev.value
        if on_list:
            src_str = _format_on_with_source(on_list)
            label = f"{ev.value} [{src_str}]"
        lines.append(f'    {from_s.value} --> {to_s.value} : {label}')
    return "\n".join(lines)


def emit_markdown_table() -> str:
    """Emit markdown table: on_method | class | file | from_state | event | to_state."""
    event_to_on = build_event_to_on()
    rows: list[tuple[str, str, str, str, str, str]] = []
    for (from_s, ev), to_s in _TRANSITIONS.items():
        on_list = event_to_on.get(ev, [])
        on_str = ", ".join(on_list)
        cls, path = ON_METHOD_SOURCE.get(on_list[0], ("?", "?")) if on_list else ("", "")
        rows.append((on_str, cls, path, from_s.value, ev.value, to_s.value))
    rows.sort(key=lambda r: (r[3], r[4]))

    lines = [
        "| on_method | class | file | from_state | event | to_state |",
        "|-----------|-------|------|------------|-------|----------|",
    ]
    for on_m, cls, path, fr, ev, to in rows:
        lines.append(f"| {on_m} | {cls} | {path} | {fr} | {ev} | {to} |")
    return "\n".join(lines)


def emit_html(out_path: str | None = None) -> str:
    """Generate standalone HTML with Mermaid diagram (open in browser)."""
    if out_path is None:
        out_path = str(_project_root / "docs" / "fsm" / "fsm_hedge_diagram.html")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    mermaid_code = emit_mermaid_with_on_methods()
    escaped = mermaid_code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Hedge FSM Diagram</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
</head>
<body>
  <h1>Hedge FSM: HedgeState &rarr; HedgeEvent &rarr; on_method</h1>
  <div class="mermaid">
{escaped}
  </div>
</body>
</html>"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    return out_path


def emit_md(out_path: str | None = None) -> str:
    """Generate Markdown for MkDocs: title, Mermaid diagram, table."""
    if out_path is None:
        out_path = str(_project_root / "docs" / "fsm" / "hedge.md")
    mermaid_code = emit_mermaid_with_on_methods()
    table = emit_markdown_table()
    md = f"""# Hedge FSM

HedgeState, HedgeEvent, and `on_*` methods in `HedgeFSM` (src/fsm/hedge_fsm.py).

## State Diagram

[Open in browser](../fsm_hedge_diagram.html) — zoomable standalone HTML

```mermaid
{mermaid_code}
```

## Transition Table

{table}
"""
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    return out_path


def main() -> None:
    import sys

    mode = "mermaid" if len(sys.argv) <= 1 else sys.argv[1]
    if mode == "mermaid":
        print(emit_mermaid())
    elif mode == "mermaid_on":
        print(emit_mermaid_with_on_methods())
    elif mode == "table":
        print(emit_markdown_table())
    elif mode == "md":
        out = emit_md()
        print(f"Wrote {out}")
    elif mode == "html":
        out = emit_html()
        print(f"Wrote {out} - open in browser")
    else:
        print("Usage: python scripts/fsm_hedge_diagram.py [mode]")
        print("  mermaid     - state diagram (paste into https://mermaid.live)")
        print("  mermaid_on  - state diagram with on_method labels")
        print("  table       - markdown table")
        print("  md          - generate docs/fsm/hedge.md for MkDocs")
        print("  html        - generate docs/fsm/fsm_hedge_diagram.html")


if __name__ == "__main__":
    main()
