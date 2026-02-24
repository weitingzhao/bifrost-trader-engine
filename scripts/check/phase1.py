#!/usr/bin/env python3
"""Phase 1 self-check: sink config, schema, runtime env (IB), and optional signal handling.

Aligns with PLAN_NEXT_STEPS.md stage 1 Test Case list and 运行环境验证. Run from project root.

Phase 1 includes runtime env verification: PostgreSQL schema + IB TWS/Gateway connectivity
(project already contains IB connection code). IB check runs by default; use --skip-ib when
TWS/Gateway is not available (e.g. CI).

Usage:
  python scripts/check/phase1.py [--config PATH] [--skip-db] [--skip-ib] [--signal-test] [--signal-verbose]
  --config         Config file (default: config/config.yaml)
  --skip-db        Skip PostgreSQL connection and schema checks
  --skip-ib        Skip IB TWS/Gateway connectivity check (use when TWS not running)
  --signal-test    Spawn daemon, wait for "Daemon running" (max 15s), then SIGTERM; assert exit within 10s
  --signal-verbose With --signal-test: print verification evidence (exit code, stdout tail) for each scenario/transition
"""

from __future__ import annotations

import argparse
import asyncio
import os
import subprocess
import sys
import threading
import traceback
import time
from pathlib import Path

# Project root (scripts/check/ -> scripts/ -> project root)
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))
os.chdir(_PROJECT_ROOT)


# ANSI colors (only when stdout is a TTY)
def _color(s: str, code: str) -> str:
    if sys.stdout.isatty():
        return f"\033[{code}m{s}\033[0m"
    return s


PASS_STR = _color("PASS", "32")   # green
SKIP_STR = _color("SKIP", "33")   # yellow
FAIL_STR = _color("FAIL", "31")   # red
CATEGORY_WIDTH = 12  # align [Config], [PostgreSQL], etc.


# Required columns per docs/DATABASE.md §2
STATUS_CURRENT_COLS = {
    "id", "daemon_state", "trading_state", "symbol", "spot", "bid", "ask",
    "net_delta", "stock_position", "option_legs_count", "daily_hedge_count",
    "daily_pnl", "data_lag_ms", "config_summary", "ts",
}
STATUS_HISTORY_COLS = STATUS_CURRENT_COLS  # same as status_current per DATABASE.md §2.2
OPERATIONS_COLS = {"id", "ts", "type", "side", "quantity", "price", "state_reason"}
DAEMON_CONTROL_COLS = {"id", "command", "created_at", "consumed_at"}  # Phase 2, DATABASE.md §2.4
DAEMON_RUN_STATUS_COLS = {"id", "suspended", "updated_at"}  # Phase 2, DATABASE.md §2.5
DAEMON_HEARTBEAT_COLS = {"id", "last_ts", "hedge_running", "ib_connected", "ib_client_id", "next_retry_ts", "seconds_until_retry", "graceful_shutdown_at"}  # Phase 2, DATABASE.md §2.6 (RE-7)

SCHEMA_FIX_TIP = " Run: python scripts/refresh_db_schema.py to create/repair tables (see docs/DATABASE.md)."


def _fail_msg(exc: BaseException, prefix: str = "") -> str:
    """One-line summary plus optional traceback for debugging."""
    msg = f"{prefix}{exc!r}".strip()
    return msg


def _fail_with_traceback(exc: BaseException, prefix: str = "", verbose: bool = False) -> str:
    """Summary; if verbose, append full traceback."""
    msg = _fail_msg(exc, prefix)
    if verbose:
        msg += "\n" + "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    return msg


def check_config(config_path: str, verbose: bool = False) -> tuple[bool, str]:
    """TC-1-R-H1-3: when status.sink=postgres, connection params must be present."""
    try:
        import yaml
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
    except Exception as e:
        return False, _fail_with_traceback(e, "Config load: ", verbose)
    status = config.get("status") or {}
    sink = status.get("sink")
    if not sink:
        return True, "ok (sink disabled)"
    if sink != "postgres":
        return False, f"status.sink must be 'postgres' (got {sink!r})"
    pg = status.get("postgres") or {}
    if not pg and not os.environ.get("PGHOST"):
        return False, "status.postgres or PGHOST required when sink=postgres"
    return True, "ok"


def check_sink_interface(verbose: bool = False) -> tuple[bool, str]:
    """TC-1-R-M1a-3 / R-M4a-2: StatusSink and snapshot/operation keys match DATABASE.md."""
    try:
        # Import from package; PostgreSQLSink is lazy so no psycopg2 needed for this check
        from src.sink import StatusSink, SNAPSHOT_KEYS, OPERATION_KEYS
    except Exception as e:
        return False, _fail_with_traceback(e, "Import sink: ", verbose)
    required_snapshot = STATUS_CURRENT_COLS - {"id"}
    if set(SNAPSHOT_KEYS) != required_snapshot:
        return False, f"SNAPSHOT_KEYS mismatch: want {required_snapshot}, got {set(SNAPSHOT_KEYS)}"
    if set(OPERATION_KEYS) != OPERATIONS_COLS - {"id"}:
        return False, f"OPERATION_KEYS mismatch: want {OPERATIONS_COLS - {'id'}}, got {set(OPERATION_KEYS)}"
    if not hasattr(StatusSink, "write_snapshot") or not hasattr(StatusSink, "write_operation"):
        return False, "StatusSink missing write_snapshot or write_operation"
    return True, "ok"


def check_pg_schema(config_path: str, verbose: bool = False) -> tuple[bool, str]:
    """TC-1-R-M1a-2/3, R-M4a-3, R-H1-1: PostgreSQL tables exist with required columns."""
    try:
        import yaml
        import psycopg2
    except ImportError as e:
        interp = getattr(sys, "executable", "python")
        hint = (
            f"Missing dependency in this Python: {interp}\n"
            "  Install with:  pip install -e .   (or:  pip install psycopg2-binary )\n"
            "  If you use a venv/conda env, run that pip for the same environment you run this script with."
        )
        return False, f"{hint}\n  Error: {e}"
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f) or {}
        status = config.get("status") or {}
        pg = status.get("postgres") or {}
        # Database: prefer config (support database, Database, db) then env then default
        db_from_config = pg.get("database") or pg.get("Database") or pg.get("db")
        if not db_from_config and pg:
            for k, v in pg.items():
                if k and isinstance(v, str) and v.strip() and k.strip().lower() in ("database", "db"):
                    db_from_config = v.strip()
                    break
        dbname = db_from_config or os.environ.get("PGDATABASE") or "bifrost"
        db_source = "config" if db_from_config else ("PGDATABASE" if os.environ.get("PGDATABASE") else "default")
        params = {
            "host": pg.get("host") or os.environ.get("PGHOST", "127.0.0.1"),
            "port": int(pg.get("port") or os.environ.get("PGPORT", "5432")),
            "dbname": dbname,
            "user": pg.get("user") or os.environ.get("PGUSER", "bifrost"),
            "password": pg.get("password") or os.environ.get("PGPASSWORD", ""),
            "connect_timeout": 3,
        }
        if verbose and pg:
            print(f"  [PostgreSQL]  (verbose) status.postgres keys: {list(pg.keys())}, database from config: {db_from_config!r}")
        # So user can see why DBeaver works but script fails (e.g. different database name)
        print(f"  [PostgreSQL]  DB: config={config_path!s}, host={params['host']}, database={params['dbname']!r} ({db_source}), user={params['user']!r}")
        conn = psycopg2.connect(**params)
    except Exception as e:
        err_msg = str(e)
        hint = ""
        if "pg_hba.conf" in err_msg and "database" in err_msg:
            hint = (
                "\n  Tip: This script uses the database name from config (status.postgres.database) or PGDATABASE. "
                "If DBeaver uses a different database (e.g. options_db), ensure your config has that same database, "
                "or set PGDATABASE=options_db when running this script."
            )
        return False, _fail_with_traceback(e, "PostgreSQL connect: ", verbose) + hint

    try:
        with conn.cursor() as cur:
            for table, required in (
                ("status_current", STATUS_CURRENT_COLS),
                ("status_history", STATUS_HISTORY_COLS),
                ("operations", OPERATIONS_COLS),
                ("daemon_control", DAEMON_CONTROL_COLS),
                ("daemon_run_status", DAEMON_RUN_STATUS_COLS),
                ("daemon_heartbeat", DAEMON_HEARTBEAT_COLS),
            ):
                cur.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_name = %s ORDER BY ordinal_position
                    """,
                    (table,),
                )
                found = {r[0] for r in cur.fetchall()}
                if not found:
                    return False, f"Table {table!r} missing or empty columns.{SCHEMA_FIX_TIP}"
                missing = required - found
                if missing:
                    return False, f"Table {table!r} missing columns: {missing}.{SCHEMA_FIX_TIP}"
        return True, "ok"
    finally:
        conn.close()


# When this string appears on daemon stdout, it has reached RUNNING state (single-threaded loop).
DAEMON_READY_MARKER = "Daemon running"
# Markers to infer exit stage (aligned with gs_trading + daemon_fsm).
MARKER_IB_CONNECT_FAIL = "Could not connect to IB"
MARKER_RECEIVED_STOP = "Received stop signal"

# 提前退出时视为「按状态机安全退出」的退出码（daemon_fsm: CONNECTING->STOPPED 或 CONNECTED->STOPPING->STOPPED 后进程结束）
SAFE_EXIT_CODES = (0, 1, -15, 143, 124)

# 与 src/fsm/daemon_fsm.py 一致的合法流转（含 RUNNING <-> RUNNING_SUSPENDED，daemon_run_status；RE-7 WAITING_IB）
FSM_TRANSITIONS = [
    ("IDLE", "CONNECTING"),           # _handle_idle
    ("IDLE", "STOPPED"),              # request_stop() when IDLE
    ("CONNECTING", "CONNECTED"),      # connect success
    ("CONNECTING", "WAITING_IB"),     # connect fail (RE-7: daemon stays up)
    ("CONNECTING", "STOPPING"),       # request_stop() during connect
    ("WAITING_IB", "CONNECTING"),     # retry (then success -> CONNECTED)
    ("WAITING_IB", "CONNECTED"),      # retry success from _handle_waiting_ib
    ("WAITING_IB", "STOPPING"),       # request_stop() or control stop
    ("CONNECTED", "RUNNING"),         # _handle_connected
    ("CONNECTED", "STOPPING"),        # request_stop() or exception
    ("RUNNING", "STOPPING"),          # request_stop() / SIGTERM
    ("RUNNING", "RUNNING_SUSPENDED"), # daemon_run_status.suspended=true (heartbeat poll)
    ("RUNNING", "WAITING_IB"),        # IB disconnected during RUNNING (heartbeat writes DB)
    ("RUNNING_SUSPENDED", "RUNNING"), # daemon_run_status.suspended=false (heartbeat poll)
    ("RUNNING_SUSPENDED", "STOPPING"),  # request_stop()
    ("RUNNING_SUSPENDED", "WAITING_IB"),  # IB disconnected during RUNNING_SUSPENDED
    ("STOPPING", "STOPPED"),          # _handle_stopping
]
# 各 Signal 场景设计覆盖的流转（场景名 -> 设计覆盖的 (from, to) 列表）
FSM_COVERAGE_BY_SCENARIO = {
    "立即/极早信号(0.3s)": [("IDLE", "STOPPED"), ("CONNECTING", "STOPPING"), ("STOPPING", "STOPPED")],
    "早期信号(2s)": [("CONNECTING", "STOPPING"), ("CONNECTING", "STOPPED"), ("CONNECTED", "STOPPING"), ("STOPPING", "STOPPED")],
    "就绪后信号": [("IDLE", "CONNECTING"), ("CONNECTING", "CONNECTED"), ("CONNECTED", "RUNNING"), ("RUNNING", "STOPPING"), ("STOPPING", "STOPPED")],
}
# 未由任何场景设计覆盖的流转（需补充用例或代码评审后考虑精简）
FSM_TRANSITIONS_UNCOVERED: list[tuple[str, str]] = []


def _infer_exit_stage(stdout_lines: list[str]) -> str:
    """Infer daemon exit stage from stdout for Chinese report. Based on daemon_fsm: IDLE->CONNECTING->CONNECTED->RUNNING->STOPPING->STOPPED."""
    text = "\n".join(stdout_lines)
    if MARKER_IB_CONNECT_FAIL in text:
        return "CONNECTING 阶段退出（IB 连接失败）"
    if DAEMON_READY_MARKER in text:
        return "已进入 RUNNING"
    if "Daemon:CONNECTED" in text or "fetching positions" in text:
        return "CONNECTED 阶段退出（拉取持仓/快照或后续步骤异常）"
    if "CONNECTING" in text or "connecting to IB" in text:
        return "CONNECTING 阶段退出（连接超时或其它错误）"
    return "未进入 RUNNING（可能为 IDLE/CONNECTING/CONNECTED 阶段异常）"


def _run_signal_scenario(
    config_path: str,
    scenario_name: str,
    delay_before_signal: float,
    wait_for_ready: bool,
    timeout_ready: float,
    timeout_exit: float,
) -> tuple[bool, str, str]:
    """Run one daemon process; returns (ok, msg, evidence). evidence 用于验证 PASS：退出码 + stdout 末几行等。"""
    run_engine = _PROJECT_ROOT / "scripts" / "run_engine.py"
    if not run_engine.exists():
        return False, f"{scenario_name}: scripts/run_engine.py 未找到", ""

    def make_evidence(rc: int, out_tail: list[str], err_tail: str = "") -> str:
        parts = [f"退出码 {rc}（允许 {SAFE_EXIT_CODES}）"]
        if out_tail:
            parts.append("stdout 末 5 行：" + " | ".join(out_tail[-5:]))
        if err_tail:
            parts.append("stderr 末 200 字：" + (err_tail[-200:] if len(err_tail) > 200 else err_tail))
        return "；".join(parts)

    proc = subprocess.Popen(
        [sys.executable, str(run_engine), config_path],
        cwd=str(_PROJECT_ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    daemon_ready = threading.Event()
    stdout_lines: list[str] = []

    def read_stdout() -> None:
        if proc.stdout is None:
            return
        max_lines = 50
        for line in proc.stdout:
            stdout_lines.append(line.rstrip())
            if len(stdout_lines) > max_lines:
                stdout_lines.pop(0)
            if DAEMON_READY_MARKER in line:
                daemon_ready.set()
                return

    reader = threading.Thread(target=read_stdout, daemon=True)
    reader.start()

    try:
        if wait_for_ready:
            deadline = time.monotonic() + timeout_ready
            while time.monotonic() < deadline:
                if daemon_ready.is_set():
                    break
                if proc.poll() is not None:
                    stage = _infer_exit_stage(stdout_lines)
                    rc = proc.returncode or 0
                    stderr = (proc.stderr.read() or "").strip()
                    err_tail = stderr[-500:] if len(stderr) > 500 else stderr
                    out_tail = stdout_lines[-20:] if stdout_lines else []
                    if rc in SAFE_EXIT_CODES:
                        return True, f"{scenario_name}: 未进 RUNNING 但已安全退出。推断：{stage}；退出码 {rc}", make_evidence(rc, out_tail, err_tail)
                    return False, f"{scenario_name}: 未进 RUNNING 且退出码异常 {rc}。推断：{stage}\nStdout:\n" + "\n".join(out_tail) + "\nStderr:\n" + err_tail, make_evidence(rc, out_tail, err_tail)
                time.sleep(0.2)
            else:
                proc.kill()
                proc.wait()
                return False, f"{scenario_name}: {timeout_ready:.0f}s 内未看到「Daemon running」", ""
            proc.terminate()
            try:
                proc.wait(timeout=timeout_exit)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                return False, f"{scenario_name}: RUNNING 后 SIGTERM，{timeout_exit}s 内未退出", ""
            rc = proc.returncode or 0
            if rc not in SAFE_EXIT_CODES:
                return False, f"{scenario_name}: 退出码异常 {proc.returncode}", make_evidence(rc, stdout_lines[-10:] if stdout_lines else [], (proc.stderr.read() or "")[-200:])
            return True, f"{scenario_name}: RUNNING→STOPPING→STOPPED 正常退出", make_evidence(rc, stdout_lines[-10:] if stdout_lines else [])
        else:
            time.sleep(delay_before_signal)
            if proc.poll() is not None:
                stage = _infer_exit_stage(stdout_lines)
                rc = proc.returncode or 0
                stderr = (proc.stderr.read() or "").strip()
                err_tail = stderr[-500:] if len(stderr) > 500 else stderr
                out_tail = stdout_lines[-20:] if stdout_lines else []
                if rc in SAFE_EXIT_CODES:
                    return True, f"{scenario_name}: 进程已先退出，安全。推断：{stage}；退出码 {rc}", make_evidence(rc, out_tail, err_tail)
                return False, f"{scenario_name}: 进程已先退出且退出码异常 {rc}。推断：{stage}\nStderr:\n{err_tail}", make_evidence(rc, out_tail, err_tail)
            proc.terminate()
            try:
                proc.wait(timeout=timeout_exit)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
                return False, f"{scenario_name}: SIGTERM 后 {timeout_exit}s 内未退出", ""
            rc = proc.returncode or 0
            if rc not in SAFE_EXIT_CODES:
                return False, f"{scenario_name}: 退出码异常 {proc.returncode}", make_evidence(rc, stdout_lines[-10:] if stdout_lines else [], (proc.stderr.read() or "")[-200:])
            return True, f"{scenario_name}: {delay_before_signal}s 后 SIGTERM，安全退出", make_evidence(rc, stdout_lines[-10:] if stdout_lines else [])
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def _write_signal_log(
    scenario_results: list[tuple[str, bool, str, str]],
    coverage_summary: str,
    transition_rows: list[tuple[str, bool, str]],
) -> None:
    """将 Signal 测试结果写入日志文件，便于留存与检验。"""
    log_dir = _PROJECT_ROOT / "scripts" / "check" / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    log_path = log_dir / f"phase1_signal_{ts}.log"
    lines = [f"# Phase1 Signal 测试日志 {ts}", f"# 覆盖摘要: {coverage_summary}", ""]
    for desc, ok, msg, evidence in scenario_results:
        lines.append(f"[{'PASS' if ok else 'FAIL'}] {desc}")
        lines.append(f"  验证证据: {evidence or '-'}")
        lines.append("")
    lines.append("# 状态机流转逐条")
    for trans_str, trans_ok, trans_evidence in transition_rows:
        lines.append(f"[{'PASS' if trans_ok is True else '未覆盖'}] {trans_str}")
        lines.append(f"  验证证据: {trans_evidence}")
        lines.append("")
    try:
        log_path.write_text("\n".join(lines), encoding="utf-8")
        print(f"  (Signal 日志已写入: {log_path.relative_to(_PROJECT_ROOT)})")
    except Exception as e:
        print(f"  (Signal 日志写入失败: {e})")


def _build_fsm_coverage_report(
    scenario_passed: dict[str, bool],
    scenario_evidence: dict[str, str],
    include_evidence: bool = False,
) -> tuple[str, list[tuple[str, bool, str]]]:
    """生成状态机流转覆盖：每条流转单独 (流转描述, PASS/未覆盖, 验证证据)。
    include_evidence=False 时仅输出「场景通过」，不附带证据详情；True 时写入证据（退出码、stdout 等）。
    """
    transition_to_scenarios: dict[tuple[str, str], list[str]] = {}
    for scenario_name, transitions in FSM_COVERAGE_BY_SCENARIO.items():
        for t in transitions:
            transition_to_scenarios.setdefault(t, []).append(scenario_name)
    covered_set = set(transition_to_scenarios.keys())
    uncovered_set = set(FSM_TRANSITIONS_UNCOVERED)
    total = len(FSM_TRANSITIONS)
    covered_count = len(covered_set)
    uncovered_count = len(uncovered_set)
    summary = f"已覆盖 {covered_count}/{total} 条"
    if uncovered_set:
        summary += f"，未覆盖 {uncovered_count} 条"

    rows: list[tuple[str, bool, str]] = []
    for (a, b) in FSM_TRANSITIONS:
        trans_str = f"{a}→{b}"
        if (a, b) in uncovered_set:
            rows.append((trans_str, None, "未覆盖；需修改项目逻辑以覆盖（daemon_fsm/gs_trading）"))
        else:
            scenarios = transition_to_scenarios.get((a, b), [])
            passed_names = [s for s in scenarios if scenario_passed.get(s, False)]
            if passed_names:
                if include_evidence:
                    first_evidence = scenario_evidence.get(passed_names[0], "")
                    evidence_txt = f"证据：{first_evidence}" if first_evidence else "（见本报告上方该场景的验证证据）"
                    rows.append((trans_str, True, f"验证：场景「{'、'.join(passed_names)}」通过（{evidence_txt}）"))
                else:
                    rows.append((trans_str, True, f"验证：场景「{'、'.join(passed_names)}」通过"))
            else:
                rows.append((trans_str, True, f"设计覆盖（场景「{'、'.join(scenarios)}」；本次未触发可查日志）"))
    return summary, rows


def check_signal_exit(
    config_path: str,
    timeout_ready: float = 15.0,
    timeout_exit: float = 10.0,
    include_evidence: bool = False,
) -> tuple[list[tuple[str, bool, str, str]], tuple[str, list[tuple[str, bool, str]]]]:
    """TC-1-R-C1a-1: 守护进程安全退出与状态机流转校验。

    include_evidence: 是否在报告中包含验证证据（退出码、stdout 等）；默认 False，仅在有 --signal-verbose 时为 True。
    返回：(场景列表 (描述, ok, msg, evidence), (覆盖摘要, 每条流转 (流转, ok, 验证证据)))。
    """
    scenarios = [
        ("立即/极早信号(0.3s)", "0.3s 后 SIGTERM", 0.3, False),
        ("早期信号(2s)", "2s 后 SIGTERM", 2.0, False),
        ("就绪后信号", "就绪后 SIGTERM", 0, True),
    ]
    results: list[tuple[str, bool, str, str]] = []
    scenario_passed: dict[str, bool] = {}
    scenario_evidence: dict[str, str] = {}
    for name, short_desc, delay, wait_ready in scenarios:
        ok, msg, evidence = _run_signal_scenario(
            config_path,
            scenario_name=name,
            delay_before_signal=delay,
            wait_for_ready=wait_ready,
            timeout_ready=timeout_ready,
            timeout_exit=timeout_exit,
        )
        results.append((short_desc, ok, msg, evidence))
        scenario_passed[name] = ok
        scenario_evidence[name] = evidence or ""
    summary, transition_rows = _build_fsm_coverage_report(scenario_passed, scenario_evidence, include_evidence)
    return results, (summary, transition_rows)


def check_ib_connector(config_path: str, timeout: float = 10.0, verbose: bool = False) -> tuple[bool, str]:
    """Runtime env: connect to IB TWS/Gateway per config. Requires TWS/Gateway running."""
    try:
        import yaml
        from src.connector.ib import IBConnector
    except ImportError as e:
        return False, _fail_with_traceback(e, "Import: ", verbose)
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    ib_cfg = config.get("ib", {}) or {}
    host = ib_cfg.get("host", "127.0.0.1")
    port = int(ib_cfg.get("port", 4001))
    client_id = int(ib_cfg.get("client_id", 1))

    async def _connect_and_disconnect() -> tuple[bool, str]:
        connector = IBConnector(
            host=host,
            port=port,
            client_id=client_id,
            connect_timeout=timeout,
        )
        try:
            ok = await connector.connect()
            if not ok:
                return False, "connect() returned False"
            await connector.disconnect()
            return True, "ok"
        except Exception as e:
            return False, _fail_msg(e, "IB connect: ")

    try:
        ok, msg = asyncio.run(_connect_and_disconnect())
        return ok, msg
    except Exception as e:
        return False, _fail_with_traceback(e, "IB check: ", verbose)


def main() -> int:
    parser = argparse.ArgumentParser(description="Phase 1 self-check (TC-1-*).")
    parser.add_argument("--config", default="config/config.yaml", help="Config path")
    parser.add_argument("--skip-db", action="store_true", help="Skip PostgreSQL schema check")
    parser.add_argument("--signal-test", action="store_true", help="Run daemon and test SIGTERM exit")
    parser.add_argument("--signal-verbose", action="store_true", help="With --signal-test: print verification evidence (exit code, stdout tail)")
    parser.add_argument("--skip-ib", action="store_true", help="Skip IB TWS/Gateway connectivity check (use when TWS not running)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print full traceback on failure")
    args = parser.parse_args()
    verbose = args.verbose
    config_path = args.config
    if not os.path.isabs(config_path):
        config_path = str(_PROJECT_ROOT / config_path)
    if not Path(config_path).exists():
        config_path = str(_PROJECT_ROOT / "config" / "config.yaml.example")

    # (category, description, ok, msg)
    results: list[tuple[str, str, bool | None, str]] = []

    # 1. Config
    ok, msg = check_config(config_path, verbose=verbose)
    results.append(("Config", "status.sink + postgres", ok, msg))

    # 2. Sink interface
    ok, msg = check_sink_interface(verbose=verbose)
    results.append(("Sink", "SNAPSHOT/OPERATION keys", ok, msg))

    # 3. PostgreSQL schema (optional)
    if not args.skip_db:
        ok, msg = check_pg_schema(config_path, verbose=verbose)
        results.append(("PostgreSQL", "tables + columns", ok, msg))
    else:
        results.append(("PostgreSQL", "tables + columns", None, "skipped (--skip-db)"))

    # 4. Signal test (optional): 每条子场景独立一行 PASS/FAIL + 验证证据；每条流转独立一行 PASS/SKIP(未覆盖) + 验证证据
    signal_log_data = None
    if args.signal_test:
        scenario_results, (coverage_summary, transition_rows) = check_signal_exit(
            config_path, include_evidence=args.signal_verbose
        )
        for desc, ok, msg, evidence in scenario_results:
            display_msg = msg
            if args.signal_verbose and evidence:
                display_msg = msg + "\n验证证据：" + evidence
            results.append(("Signal", desc, ok, display_msg))
        results.append(("Signal", f"状态机覆盖 {coverage_summary}", True, ""))
        for trans_str, trans_ok, trans_evidence in transition_rows:
            # 始终输出每条流转的 PASS/未覆盖；仅 --signal-verbose 时附带验证解释
            msg = trans_evidence if args.signal_verbose else ""
            results.append(("Signal", f"  流转 {trans_str}", trans_ok, msg))
        signal_log_data = (scenario_results, coverage_summary, transition_rows)
    else:
        results.append(("Signal", "SIGTERM 多场景", None, "optional; use --signal-test to run"))

    # 5. IB connector (runtime env verification; default on, --skip-ib to skip)
    if not args.skip_ib:
        ok, msg = check_ib_connector(config_path, timeout=10.0, verbose=verbose)
        results.append(("IB", "TWS/Gateway connect", ok, msg))
    else:
        results.append(("IB", "TWS/Gateway connect", None, "skipped (--skip-ib)"))

    # Report: category prefix + colored PASS/SKIP/FAIL
    all_required_ok = True
    for category, description, ok, msg in results:
        pad = " " * max(0, CATEGORY_WIDTH - len(category) - 2)  # [Category] + padding
        if ok is True:
            print(f"  [{category}]{pad}  {PASS_STR}  {description}")
            if msg and msg != "ok":
                for line in msg.splitlines():
                    print(f"      {line}")
        elif ok is False:
            print(f"  [{category}]{pad}  {FAIL_STR}  {description}:")
            for line in msg.splitlines():
                print(f"      {line}")
            all_required_ok = False
        else:
            print(f"  [{category}]{pad}  {SKIP_STR}  {description}: {msg}")
    if not all_required_ok and not verbose:
        print("\nTip: run with -v/--verbose to see full error tracebacks.")
    if signal_log_data is not None:
        _write_signal_log(*signal_log_data)
    if all_required_ok:
        print("\nPhase 1 self-check: required checks passed.")
        if args.skip_ib or not args.signal_test:
            hints = []
            if args.skip_ib:
                hints.append("omit --skip-ib to verify IB TWS/Gateway connectivity")
            if not args.signal_test:
                hints.append("add --signal-test to verify SIGTERM exit")
            if hints:
                print(f"  (Optional: {'; '.join(hints)}.)")
        return 0
    print("\nPhase 1 self-check: some checks failed.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
