#!/usr/bin/env python3
"""Print IB 账户与守护状态到 Console，数据来源与 UI 监控一致（FastAPI GET /status 或直连 PostgreSQL）。

便于复制粘贴给 AI Agent 做 Debug。用法:
  python scripts/check/ib_accounts_console.py              # 默认请求本地 API (与 UI 同源)
  python scripts/check/ib_accounts_console.py --api http://192.168.x.x:8765
  python scripts/check/ib_accounts_console.py --db         # 不依赖 API 进程，直连 PostgreSQL
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, _PROJECT_ROOT)
os.chdir(_PROJECT_ROOT)


def _load_config(config_path: str | None) -> tuple[dict, str]:
    from src.app.gs_trading import read_config
    path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(path).exists():
        path = "config/config.yaml.example"
    return read_config(path)


def _api_url_from_config(config: dict) -> str:
    port = (
        config.get("status_server", {}).get("port")
        or config.get("server", {}).get("port")
        or 8765
    )
    return f"http://127.0.0.1:{int(port)}"


def fetch_via_api(base_url: str) -> dict | None:
    """GET /status from FastAPI (same as UI). Returns None on failure."""
    try:
        import urllib.request
        req = urllib.request.Request(
            base_url.rstrip("/") + "/status",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode())
    except Exception as e:
        print(f"API 请求失败: {e}", file=sys.stderr)
        return None


def fetch_via_db(config: dict) -> dict:
    """Read from PostgreSQL (same reader as FastAPI). Build payload compatible with API response."""
    import time
    from servers.reader import StatusReader
    status_cfg = config.get("status") or {}
    reader = StatusReader(status_cfg)
    row = reader.get_status_current()
    hb = reader.get_daemon_heartbeat()
    accounts_from_tables = reader.get_accounts_from_tables()
    payload = {
        "status": dict(row) if row else None,
        "accounts": accounts_from_tables if accounts_from_tables is not None else [],
        "daemon_heartbeat": None,
    }
    payload["_db_diag"] = {
        "accounts_from_tables": accounts_from_tables is not None,
        "accounts_len": len(accounts_from_tables) if isinstance(accounts_from_tables, list) else 0,
    }
    if hb is not None:
        last_ts = hb.get("last_ts")
        now = time.time()
        payload["daemon_heartbeat"] = {
            "ib_connected": hb.get("ib_connected", False),
            "ib_client_id": hb.get("ib_client_id"),
            "daemon_alive": last_ts is not None and (now - last_ts) < 35,
            "last_ts": last_ts,
            "hedge_running": hb.get("hedge_running", False),
            "next_retry_ts": hb.get("next_retry_ts"),
            "seconds_until_retry": hb.get("seconds_until_retry"),
            "heartbeat_interval_sec": hb.get("heartbeat_interval_sec"),
        }
    return payload


def _format_ts(ts: float | None) -> str:
    if ts is None:
        return "—"
    from datetime import datetime, timezone
    try:
        return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    except Exception:
        return str(ts)


def print_report(payload: dict, source: str) -> None:
    """Print human-readable report and a paste block for AI."""
    hb = payload.get("daemon_heartbeat") or {}
    accounts = payload.get("accounts")
    status = payload.get("status") or {}

    print("=" * 60)
    print("IB 账户 / 守护状态 Console（数据来源与监控 UI 一致）")
    print("=" * 60)
    print(f"数据来源: {source}")
    diag = payload.get("_db_diag")
    if diag:
        print()
        print("--- 落库诊断 (accounts + account_positions) ---")
        print(f"  从表读取: {diag.get('accounts_from_tables', '—')}")
        print(f"  账户数:   {diag.get('accounts_len', '—')}")
    print()
    print("--- Daemon / IB 连接 ---")
    print(f"  daemon_alive:    {hb.get('daemon_alive', '—')}")
    print(f"  ib_connected:   {hb.get('ib_connected', '—')}")
    print(f"  ib_client_id:   {hb.get('ib_client_id', '—')}")
    print(f"  hedge_running:   {hb.get('hedge_running', '—')}")
    print(f"  last_ts:        {_format_ts(hb.get('last_ts'))}")
    print()
    print("--- status_current 摘要 ---")
    print(f"  daemon_state:   {status.get('daemon_state', '—')}")
    print(f"  trading_state:  {status.get('trading_state', '—')}")
    print(f"  ts:             {_format_ts(status.get('ts'))}")
    print()
    print("--- IB 账户 (GET /status.accounts，来自 accounts + account_positions) ---")
    if not accounts:
        print("  (无数据：IB 未连接或守护进程尚未写入)")
    else:
        if isinstance(accounts, list):
            for i, acc in enumerate(accounts):
                aid = acc.get("account_id") or f"账户-{i+1}"
                print(f"  [{aid}]")
                summary = acc.get("summary") or {}
                for k in ("NetLiquidation", "TotalCashValue", "BuyingPower"):
                    if k in summary:
                        print(f"    {k}: {summary[k]}")
                positions = acc.get("positions") or []
                print(f"    positions: {len(positions)} 条")
                for p in positions[:10]:
                    sym = p.get("symbol", "?")
                    sec = p.get("secType", "")
                    exp = p.get("lastTradeDateOrContractMonth") or p.get("expiry") or ""
                    strike = p.get("strike")
                    right = p.get("right", "")
                    opt_info = f" {exp} {strike} {right}".strip() if sec == "OPT" and (exp or strike is not None) else ""
                    print(f"      - {sym} {sec}{opt_info} pos={p.get('position')} avgCost={p.get('avgCost')}")
                if len(positions) > 10:
                    print(f"      ... 共 {len(positions)} 条")
        else:
            print("  (accounts 非列表格式)")
    print()
    print("=" * 60)
    print("--- 以下可复制粘贴给 AI Agent 做 Debug ---")
    print("=" * 60)
    # Compact but complete block for paste
    paste = {
        "daemon_heartbeat": {k: v for k, v in (payload.get("daemon_heartbeat") or {}).items()},
        "status_keys": list((payload.get("status") or {}).keys()),
        "accounts": payload.get("accounts"),
    }
    if payload.get("_db_diag"):
        paste["_db_diag"] = payload["_db_diag"]
    print(json.dumps(paste, ensure_ascii=False, indent=2))
    print("=" * 60)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Print IB 账户与守护状态（与 UI 监控同源），便于复制给 AI Debug。"
    )
    ap.add_argument(
        "--api",
        metavar="URL",
        default=os.environ.get("STATUS_API_URL", ""),
        help="FastAPI 根 URL，如 http://127.0.0.1:8765；空则从 config 读 port 并请求本地",
    )
    ap.add_argument(
        "--db",
        action="store_true",
        help="直连 PostgreSQL 读 status_current（与 UI 同库），不请求 API",
    )
    ap.add_argument(
        "--config",
        default=None,
        help="配置文件路径（默认 config/config.yaml 或 BIFROST_CONFIG）",
    )
    args = ap.parse_args()

    config, _ = _load_config(args.config)

    if args.db:
        payload = fetch_via_db(config)
        print_report(payload, "PostgreSQL (StatusReader, 与 FastAPI 同源)")
        return 0

    base_url = args.api or _api_url_from_config(config)
    payload = fetch_via_api(base_url)
    if payload is None:
        print("提示: 若监控服务未启动，可使用 --db 直连数据库。", file=sys.stderr)
        return 1
    print_report(payload, f"GET {base_url}/status")
    return 0


if __name__ == "__main__":
    sys.exit(main())
