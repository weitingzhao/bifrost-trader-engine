#!/usr/bin/env python3
"""Generate Trading FSM diagram: TradingState, TradingEvent, apply_transition + caller mapping.

Run: python scripts/fsm_trading_diagram.py  (or python fsm_trading_diagram.py from scripts/)
Output: Mermaid diagram (paste into https://mermaid.live) or markdown table.
"""
import sys
from pathlib import Path

# Add project root so "from src..." works when run from scripts/ or project root
_project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_project_root))

from src.core.state.enums import TradingState
from src.fsm.events import TradingEvent

# (from_state, event, to_state, guard_short)
# Guard: short description for diagram; empty = no guard
TRADING_TRANSITIONS: list[tuple[TradingState, TradingEvent, TradingState, str]] = [
    # Any -> SAFE on fault guards (broker_down|data_stale|greeks_bad|exec_fault)
    (TradingState.BOOT, TradingEvent.START, TradingState.SYNC, ""),
    (TradingState.SYNC, TradingEvent.SYNCED, TradingState.IDLE, "positions_ok & data_ok"),
    (TradingState.SYNC, TradingEvent.SYNCED, TradingState.SAFE, "!data_ok | broker_down"),
    (TradingState.SYNC, TradingEvent.TICK, TradingState.IDLE, "positions_ok & data_ok"),
    (TradingState.SYNC, TradingEvent.TICK, TradingState.SAFE, "!data_ok | broker_down"),
    (TradingState.SYNC, TradingEvent.QUOTE, TradingState.IDLE, "positions_ok & data_ok"),
    (TradingState.SYNC, TradingEvent.QUOTE, TradingState.SAFE, "!data_ok | broker_down"),
    (TradingState.SYNC, TradingEvent.GREEKS_UPDATE, TradingState.IDLE, "positions_ok & data_ok"),
    (TradingState.SYNC, TradingEvent.GREEKS_UPDATE, TradingState.SAFE, "!data_ok | broker_down"),
    # IDLE
    (TradingState.IDLE, TradingEvent.SYNCED, TradingState.SAFE, "data_stale|greeks_bad|broker_down"),
    (TradingState.IDLE, TradingEvent.SYNCED, TradingState.ARMED, "have_option|strategy_enabled"),
    (TradingState.IDLE, TradingEvent.TICK, TradingState.SAFE, "data_stale|greeks_bad|broker_down"),
    (TradingState.IDLE, TradingEvent.TICK, TradingState.ARMED, "have_option|strategy_enabled"),
    (TradingState.IDLE, TradingEvent.QUOTE, TradingState.SAFE, "data_stale|greeks_bad|broker_down"),
    (TradingState.IDLE, TradingEvent.QUOTE, TradingState.ARMED, "have_option|strategy_enabled"),
    (TradingState.IDLE, TradingEvent.GREEKS_UPDATE, TradingState.SAFE, "data_stale|greeks_bad|broker_down"),
    (TradingState.IDLE, TradingEvent.GREEKS_UPDATE, TradingState.ARMED, "have_option|strategy_enabled"),
    # ARMED
    (TradingState.ARMED, TradingEvent.SYNCED, TradingState.MONITOR, "delta_band_ready"),
    (TradingState.ARMED, TradingEvent.TICK, TradingState.MONITOR, "delta_band_ready"),
    (TradingState.ARMED, TradingEvent.QUOTE, TradingState.MONITOR, "delta_band_ready"),
    (TradingState.ARMED, TradingEvent.GREEKS_UPDATE, TradingState.MONITOR, "delta_band_ready"),
    # MONITOR
    (TradingState.MONITOR, TradingEvent.SYNCED, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.MONITOR, TradingEvent.SYNCED, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.MONITOR, TradingEvent.SYNCED, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.MONITOR, TradingEvent.SYNCED, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    (TradingState.MONITOR, TradingEvent.TICK, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.MONITOR, TradingEvent.TICK, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.MONITOR, TradingEvent.TICK, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.MONITOR, TradingEvent.TICK, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    (TradingState.MONITOR, TradingEvent.QUOTE, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.MONITOR, TradingEvent.QUOTE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.MONITOR, TradingEvent.QUOTE, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.MONITOR, TradingEvent.QUOTE, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    (TradingState.MONITOR, TradingEvent.GREEKS_UPDATE, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.MONITOR, TradingEvent.GREEKS_UPDATE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.MONITOR, TradingEvent.GREEKS_UPDATE, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.MONITOR, TradingEvent.GREEKS_UPDATE, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    # NO_TRADE
    (TradingState.NO_TRADE, TradingEvent.SYNCED, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.NO_TRADE, TradingEvent.SYNCED, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.NO_TRADE, TradingEvent.SYNCED, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    (TradingState.NO_TRADE, TradingEvent.TICK, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.NO_TRADE, TradingEvent.TICK, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.NO_TRADE, TradingEvent.TICK, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    (TradingState.NO_TRADE, TradingEvent.QUOTE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.NO_TRADE, TradingEvent.QUOTE, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.NO_TRADE, TradingEvent.QUOTE, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    (TradingState.NO_TRADE, TradingEvent.GREEKS_UPDATE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.NO_TRADE, TradingEvent.GREEKS_UPDATE, TradingState.PAUSE_COST, "!in_no_trade_band & !cost_ok"),
    (TradingState.NO_TRADE, TradingEvent.GREEKS_UPDATE, TradingState.PAUSE_LIQ, "!in_no_trade_band & !liq_ok"),
    # PAUSE_COST
    (TradingState.PAUSE_COST, TradingEvent.SYNCED, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_COST, TradingEvent.SYNCED, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.PAUSE_COST, TradingEvent.TICK, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_COST, TradingEvent.TICK, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.PAUSE_COST, TradingEvent.QUOTE, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_COST, TradingEvent.QUOTE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.PAUSE_COST, TradingEvent.GREEKS_UPDATE, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_COST, TradingEvent.GREEKS_UPDATE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    # PAUSE_LIQ
    (TradingState.PAUSE_LIQ, TradingEvent.SYNCED, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_LIQ, TradingEvent.SYNCED, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.PAUSE_LIQ, TradingEvent.TICK, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_LIQ, TradingEvent.TICK, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.PAUSE_LIQ, TradingEvent.QUOTE, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_LIQ, TradingEvent.QUOTE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    (TradingState.PAUSE_LIQ, TradingEvent.GREEKS_UPDATE, TradingState.NO_TRADE, "in_no_trade_band"),
    (TradingState.PAUSE_LIQ, TradingEvent.GREEKS_UPDATE, TradingState.NEED_HEDGE, "!in_no_trade_band & cost_ok & liq_ok"),
    # NEED_HEDGE -> HEDGING
    (TradingState.NEED_HEDGE, TradingEvent.TARGET_EMITTED, TradingState.HEDGING, ""),
    # HEDGING
    (TradingState.HEDGING, TradingEvent.HEDGE_DONE, TradingState.MONITOR, ""),
    (TradingState.HEDGING, TradingEvent.HEDGE_FAILED, TradingState.NEED_HEDGE, "retry_allowed"),
    (TradingState.HEDGING, TradingEvent.HEDGE_FAILED, TradingState.SAFE, "!retry_allowed"),
    # SAFE
    (TradingState.SAFE, TradingEvent.MANUAL_RESUME, TradingState.SYNC, "broker_up & data_ok"),
    (TradingState.SAFE, TradingEvent.BROKER_UP, TradingState.SYNC, "data_ok"),
]

# event -> (caller_method, caller_class, caller_file) - where apply_transition(event) is invoked
EVENT_CALLER: dict[TradingEvent, tuple[str, str, str]] = {
    TradingEvent.START: ("_handle_connected", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.SYNCED: ("_handle_connected", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.TICK: ("_eval_hedge", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.QUOTE: ("_eval_hedge", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.GREEKS_UPDATE: ("_eval_hedge", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.TARGET_EMITTED: ("_eval_hedge", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.HEDGE_DONE: ("_hedge", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.HEDGE_FAILED: ("_hedge", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.MANUAL_RESUME: ("(manual)", "GsTrading", "src/app/gs_trading.py"),
    TradingEvent.BROKER_UP: ("(broker_cb)", "GsTrading", "src/app/gs_trading.py"),
}

# apply_transition lives in TradingFSM
APPLY_SOURCE = ("apply_transition", "TradingFSM", "src/fsm/trading_fsm.py")


def _format_label(ev: TradingEvent, guard: str, caller: tuple[str, str, str], short: bool = False) -> str:
    """Format transition label: event [caller (class, file)] [guard]."""
    caller_method, cls, path = caller
    short_file = path.split("/")[-1] if "/" in path else path
    if short:
        return f"{ev.value} [{caller_method} @ {short_file}]"
    parts = [f"{ev.value} [{caller_method} ({cls}, {short_file})]"]
    if guard:
        parts.append(f"[{guard}]")
    return " ".join(parts)


def emit_mermaid(short_labels: bool = True) -> str:
    """Generate Mermaid stateDiagram for Trading FSM transitions.
    short_labels: event [caller @ file]; else full with guard.
    """
    lines = [
        "stateDiagram-v2",
        "    direction TB",
        "",
    ]
    for s in TradingState:
        lines.append(f"    {s.value}")
    lines.append("")

    for from_s, ev, to_s, guard in TRADING_TRANSITIONS:
        caller = EVENT_CALLER.get(ev, ("?", "?", "?"))
        label = _format_label(ev, guard, caller, short=short_labels)
        safe_label = label.replace('"', "'")
        lines.append(f'    {from_s.value} --> {to_s.value} : "{safe_label}"')
    return "\n".join(lines)


def emit_mermaid_simple() -> str:
    """Simpler Mermaid: merge (from,to), show events + caller/file for first event."""
    from_to_info: dict[tuple[str, str], list[tuple[str, tuple[str, str, str]]]] = {}
    for from_s, ev, to_s, guard in TRADING_TRANSITIONS:
        key = (from_s.value, to_s.value)
        caller = EVENT_CALLER.get(ev, ("?", "?", "?"))
        from_to_info.setdefault(key, []).append((ev.value, caller))
    # Dedupe events, keep first caller
    from_to_merged: dict[tuple[str, str], tuple[list[str], tuple[str, str, str]]] = {}
    for (fr, to), items in from_to_info.items():
        events = list(dict.fromkeys(e for e, _ in items))
        caller = items[0][1] if items else ("?", "?", "?")
        from_to_merged[(fr, to)] = (events, caller)

    lines = [
        "stateDiagram-v2",
        "    direction TB",
        "",
    ]
    for s in TradingState:
        lines.append(f"    {s.value}")
    lines.append("")

    for (from_s, to_s), (events, caller) in sorted(from_to_merged.items()):
        ev_str = ", ".join(events[:3])
        if len(events) > 3:
            ev_str += "..."
        caller_m, cls, path = caller
        short_file = path.split("/")[-1] if "/" in path else path
        label = f"{ev_str} [{caller_m} ({cls}, {short_file})]"
        safe_label = label.replace('"', "'")
        lines.append(f'    {from_s} --> {to_s} : "{safe_label}"')
    return "\n".join(lines)


def _safe_cell(s: str) -> str:
    """Escape pipe for Markdown table (| is column delimiter)."""
    return s.replace(" | ", " or ").replace("|", " or ")


def emit_markdown_table() -> str:
    """Emit markdown table: from_state | event | to_state | guard | caller | class | file."""
    rows: list[tuple[str, str, str, str, str, str, str]] = []
    for from_s, ev, to_s, guard in TRADING_TRANSITIONS:
        caller = EVENT_CALLER.get(ev, ("?", "?", "?"))
        caller_method, cls, path = caller
        rows.append((from_s.value, ev.value, to_s.value, guard, caller_method, cls, path))
    rows.sort(key=lambda r: (r[0], r[1], r[2]))

    lines = [
        "| from_state | event | to_state | guard | caller | class | file |",
        "|------------|-------|----------|-------|--------|-------|------|",
    ]
    for fr, ev, to, guard, caller_m, cls, path in rows:
        line = f"| {fr} | {ev} | {to} | {_safe_cell(guard)} | {caller_m} | {cls} | {path} |"
        lines.append(line)
    return "\n".join(lines)


def emit_html(out_path: str | None = None) -> str:
    """Generate standalone HTML with Mermaid diagram (open in browser)."""
    if out_path is None:
        out_path = str(_project_root / "docs" / "fsm" / "fsm_trading_diagram.html")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    mermaid_code = emit_mermaid_simple()
    escaped = mermaid_code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Trading FSM Diagram</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
</head>
<body>
  <h1>Trading FSM: TradingState &rarr; TradingEvent &rarr; apply_transition + caller</h1>
  <p><b>apply_transition</b> in TradingFSM (src/fsm/trading_fsm.py). <b>Callers</b> in GsTrading (src/app/gs_trading.py).</p>
  <p><i>Note: Any state &rarr; SAFE when broker_down | data_stale | greeks_bad | exec_fault.</i></p>
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
        out_path = str(_project_root / "docs" / "fsm" / "trading.md")
    mermaid_code = emit_mermaid_simple()
    table = emit_markdown_table()
    md = f"""# Trading FSM

TradingState, TradingEvent, and `apply_transition` + caller in `TradingFSM` (src/fsm/trading_fsm.py).
Callers in `GsTrading` (src/app/gs_trading.py).

!!! note
    Any state → SAFE when `broker_down | data_stale | greeks_bad | exec_fault`.

## State Diagram

[Open in browser](../fsm_trading_diagram.html) — zoomable standalone HTML

```mermaid
{mermaid_code}
```

## Transition Table

The table below lists **every possible transition** the Trading FSM can take. It is **manually authored** in `scripts/fsm_trading_diagram.py` as `TRADING_TRANSITIONS` and kept in sync with the runtime logic in `src/fsm/trading_fsm.py`.

- **One row** = one (from_state, event, to_state) with the **guard** that selects that outcome.
- The same (from_state, event) can appear in **multiple rows** with different (to_state, guard), because the handler evaluates guards in order and picks one next state (e.g. from MONITOR, event TICK → NO_TRADE if `in_no_trade_band`, else NEED_HEDGE if cost and liquidity OK, else PAUSE_COST or PAUSE_LIQ).
- **Why so many rows?** States like MONITOR, NO_TRADE, PAUSE_COST, PAUSE_LIQ all react to the same four events (SYNCED, TICK, QUOTE, GREEKS_UPDATE), and each (state, event) can lead to several next states depending on guards — so we get 4 events × 4 outcomes per state, plus IDLE/SYNC/ARMED/NEED_HEDGE/HEDGING/SAFE transitions.

{table}
"""
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md)
    return out_path


def main() -> None:
    mode = "mermaid" if len(sys.argv) <= 1 else sys.argv[1]
    if mode == "mermaid":
        print(emit_mermaid())
    elif mode == "mermaid_simple":
        print(emit_mermaid_simple())
    elif mode == "table":
        print(emit_markdown_table())
    elif mode == "md":
        out = emit_md()
        print(f"Wrote {out}")
    elif mode == "html":
        out = emit_html()
        print(f"Wrote {out} - open in browser")
    else:
        print("Usage: python scripts/fsm_trading_diagram.py [mode]")
        print("  mermaid       - full state diagram with caller/guard labels")
        print("  mermaid_simple - simplified (merged edges)")
        print("  table         - markdown table")
        print("  md            - generate docs/fsm/trading.md for MkDocs")
        print("  html          - generate docs/fsm/fsm_trading_diagram.html")


if __name__ == "__main__":
    main()
