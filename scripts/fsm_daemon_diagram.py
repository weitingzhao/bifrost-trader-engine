#!/usr/bin/env python3
"""Generate Daemon FSM diagram: DaemonState, transition + caller mapping.

Run: python scripts/fsm_daemon_diagram.py  (or python fsm_daemon_diagram.py from scripts/)
Output: Mermaid diagram (paste into https://mermaid.live) or markdown table.
"""
import sys
from pathlib import Path

# Add project root so "from src..." works when run from scripts/ or project root
_project_root = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_project_root))

from src.fsm.daemon_fsm import DaemonState

# (from_state, to_state) -> (trigger_method, trigger_class, trigger_file, condition)
# condition: short note e.g. "connect ok" / "connect fail"
DAEMON_TRANSITIONS: list[tuple[DaemonState, DaemonState, str, str, str, str]] = [
    # from, to, method, class, file, condition
    (DaemonState.IDLE, DaemonState.CONNECTING, "_handle_idle", "GsTrading", "src/app/gs_trading.py", ""),
    (DaemonState.IDLE, DaemonState.STOPPED, "request_stop", "GsTrading", "src/app/gs_trading.py", "when IDLE"),
    (DaemonState.CONNECTING, DaemonState.CONNECTED, "_handle_connecting", "GsTrading", "src/app/gs_trading.py", "connect ok"),
    (DaemonState.CONNECTING, DaemonState.STOPPED, "_handle_connecting", "GsTrading", "src/app/gs_trading.py", "connect fail"),
    (DaemonState.CONNECTING, DaemonState.STOPPING, "request_stop", "GsTrading", "src/app/gs_trading.py", "during connect"),
    (DaemonState.CONNECTED, DaemonState.RUNNING, "_handle_connected", "GsTrading", "src/app/gs_trading.py", ""),
    (DaemonState.CONNECTED, DaemonState.STOPPING, "request_stop", "GsTrading", "src/app/gs_trading.py", "stop()"),
    (DaemonState.RUNNING, DaemonState.STOPPING, "_handle_running", "GsTrading", "src/app/gs_trading.py", "loop exit"),
    (DaemonState.RUNNING, DaemonState.STOPPING, "request_stop", "GsTrading", "src/app/gs_trading.py", "stop()"),
    (DaemonState.STOPPING, DaemonState.STOPPED, "_handle_stopping", "GsTrading", "src/app/gs_trading.py", ""),
]


def emit_mermaid() -> str:
    """Generate Mermaid stateDiagram for Daemon FSM transitions."""
    lines = [
        "stateDiagram-v2",
        "    direction LR",
        "",
    ]
    for s in DaemonState:
        lines.append(f"    {s.value}")
    lines.append("")

    for from_s, to_s, method, cls, path, cond in DAEMON_TRANSITIONS:
        short_file = path.split("/")[-1] if "/" in path else path
        label = f"{method} ({cls}, {short_file})"
        if cond:
            label += f" [{cond}]"
        safe_label = label.replace('"', "'")
        lines.append(f'    {from_s.value} --> {to_s.value} : "{safe_label}"')
    return "\n".join(lines)


def emit_markdown_table() -> str:
    """Emit markdown table: from | to | method | class | file | condition."""
    rows = []
    for from_s, to_s, method, cls, path, cond in DAEMON_TRANSITIONS:
        rows.append((from_s.value, to_s.value, method, cls, path, cond))
    rows.sort(key=lambda r: (r[0], r[1]))

    lines = [
        "| from_state | to_state | method | class | file | condition |",
        "|------------|----------|--------|-------|------|----------|",
    ]
    for fr, to, method, cls, path, cond in rows:
        lines.append(f"| {fr} | {to} | {method} | {cls} | {path} | {cond} |")
    return "\n".join(lines)


def emit_html(out_path: str | None = None) -> str:
    """Generate standalone HTML with Mermaid diagram (open in browser)."""
    if out_path is None:
        out_path = str(_project_root / "docs" / "fsm" / "fsm_daemon_diagram.html")
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    mermaid_code = emit_mermaid()
    escaped = mermaid_code.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    html = f"""<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Daemon FSM Diagram</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid/dist/mermaid.min.js"></script>
</head>
<body>
  <h1>Daemon FSM: DaemonState &rarr; transition + caller</h1>
  <p><b>transition</b> in DaemonFSM (src/fsm/daemon_fsm.py). <b>Callers</b> in GsTrading (src/app/gs_trading.py).</p>
  <div class="mermaid">
{escaped}
  </div>
</body>
</html>"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    return out_path


def main() -> None:
    mode = "mermaid" if len(sys.argv) <= 1 else sys.argv[1]
    if mode == "mermaid":
        print(emit_mermaid())
    elif mode == "table":
        print(emit_markdown_table())
    elif mode == "html":
        out = emit_html()
        print(f"Wrote {out} - open in browser")
    else:
        print("Usage: python scripts/fsm_daemon_diagram.py [mode]")
        print("  mermaid - state diagram (paste into https://mermaid.live)")
        print("  table   - markdown table")
        print("  html    - generate docs/fsm/fsm_daemon_diagram.html")


if __name__ == "__main__":
    main()
