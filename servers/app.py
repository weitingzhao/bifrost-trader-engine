"""Phase 2: FastAPI app for GET /status, GET /operations, POST /control/*. API only; frontend is separate (frontend/).

Monitoring runs on a separate host from the trading daemon (RE-5). Start of the daemon is only on the trading machine (run_engine.py); no subprocess/start on this server."""

import logging
import time
from typing import Any, Dict, Optional

from fastapi import Body, FastAPI, Query
from fastapi.responses import JSONResponse, HTMLResponse

from servers.reader import StatusReader, write_control_command, write_run_status, write_heartbeat_interval, write_ib_config
from servers.self_check import derive_daemon_self_check, derive_self_check

logger = logging.getLogger(__name__)


def create_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    data_lag_threshold_ms: Optional[float],
) -> FastAPI:
    """Build FastAPI app: reader, control channel (stop/flatten/suspend/resume via DB). API only; no built-in Web UI. No start: daemon is started on trading host only."""
    app = FastAPI(title="Bifrost Trader API", description="Phase 2: status and control API (frontend is separate)")

    @app.get("/", response_class=HTMLResponse)
    def get_root() -> str:
        """API only: link to docs and main endpoints. Use project frontend (e.g. npm run dev) for the monitoring UI."""
        return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>Bifrost Trader API</title></head>
<body style="font-family:system-ui;padding:1rem;">
  <p><strong>Bifrost Trader API</strong> — 本端口仅提供 API，监控页面请使用项目内 frontend（如 <code>cd frontend && npm run dev</code>）。</p>
  <p><a href="/docs">/docs</a> · <a href="/status">/status</a> · <a href="/operations">/operations</a></p>
</body></html>"""

    @app.get("/status")
    def get_status() -> Dict[str, Any]:
        """Return current run status plus self_check, status_lamp, trading_suspended (R-M1b, R-M2, R-M3). Self-check reflects suspended state (degraded + trading_suspended in block_reasons). Never returns 5xx: on read error returns 200 with blocked/red so UI shows reason instead of '获取失败'."""
        try:
            row = reader.get_status_current()
            run_suspended = reader.get_run_status()
            sc = derive_self_check(row, data_lag_threshold_ms, trading_suspended=run_suspended)
            payload: Dict[str, Any] = {
                "self_check": sc["self_check"],
                "block_reasons": sc["block_reasons"],
                "status_lamp": sc["status_lamp"],
                "trading_suspended": run_suspended if run_suspended is not None else False,
            }
            hb = reader.get_daemon_heartbeat()
            if hb is not None:
                now = time.time()
                last_ts = hb.get("last_ts")
                payload["daemon_heartbeat"] = {
                    "last_ts": last_ts,
                    "hedge_running": hb.get("hedge_running", False),
                    "daemon_alive": (last_ts is not None and (now - last_ts) < 35),
                    "ib_connected": hb.get("ib_connected", False),
                    "ib_client_id": hb.get("ib_client_id"),
                    "next_retry_ts": hb.get("next_retry_ts"),
                    "seconds_until_retry": hb.get("seconds_until_retry"),
                    "graceful_shutdown_at": hb.get("graceful_shutdown_at"),
                    "heartbeat_interval_sec": hb.get("heartbeat_interval_sec"),
                }
                dsc = derive_daemon_self_check(payload["daemon_heartbeat"])
                payload["daemon_self_check"] = dsc["daemon_self_check"]
                payload["daemon_lamp"] = dsc["daemon_lamp"]
                payload["daemon_block_reasons"] = dsc["daemon_block_reasons"]
            else:
                payload["daemon_heartbeat"] = None
                dsc = derive_daemon_self_check(None)
                payload["daemon_self_check"] = dsc["daemon_self_check"]
                payload["daemon_lamp"] = dsc["daemon_lamp"]
                payload["daemon_block_reasons"] = dsc["daemon_block_reasons"]
            if row is not None:
                payload["status"] = row
            else:
                payload["status"] = None
            # R-A1: 始终从 DB (accounts + account_positions) 读账户并返回，便于自动交易页 IB 账户区展示
            payload["accounts"] = reader.get_accounts_from_tables()
            if payload["accounts"] is None:
                payload["accounts"] = []
            payload["accounts_fetched_at"] = reader.get_accounts_fetched_at()
            ib_cfg = reader.get_ib_config()
            payload["ib_config"] = ib_cfg if ib_cfg else {"ib_host": "127.0.0.1", "ib_port_type": "tws_paper"}
            return payload
        except Exception as e:
            logger.warning("get_status failed: %s", e)
            return {
                "self_check": "blocked",
                "block_reasons": ["status_read_error"],
                "status_lamp": "red",
                "trading_suspended": False,
                "daemon_heartbeat": None,
                "daemon_self_check": "blocked",
                "daemon_lamp": "red",
                "daemon_block_reasons": ["status_read_error"],
                "status": None,
                "accounts": None,
                "accounts_fetched_at": None,
                "ib_config": {"ib_host": "127.0.0.1", "ib_port_type": "tws_paper"},
            }

    @app.get("/operations")
    def get_operations(
        since_ts: Optional[float] = Query(None, description="Filter operations with ts >= this"),
        until_ts: Optional[float] = Query(None, description="Filter operations with ts <= this"),
        operation_type: Optional[str] = Query(None, alias="type", description="Filter by type (hedge_intent, order_sent, fill, reject, cancel)"),
        limit: int = Query(100, ge=1, le=1000),
    ) -> Dict[str, Any]:
        """Return operations list with optional filters (R-M4b)."""
        items = reader.get_operations(since_ts=since_ts, until_ts=until_ts, type_filter=operation_type, limit=limit)
        return {"operations": items}

    @app.post("/control/stop")
    def post_control_stop() -> JSONResponse:
        """Insert 'stop' into daemon_control; daemon will request_stop() on next heartbeat (R-C1b)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "stop"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "stop written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/flatten")
    def post_control_flatten() -> JSONResponse:
        """Insert 'flatten' into daemon_control. R-C3 not implemented in daemon yet; daemon logs and continues."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "flatten"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "flatten written to daemon_control (daemon may not implement yet)"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/suspend")
    def post_control_suspend() -> JSONResponse:
        """Set daemon_run_status.suspended=true; daemon will pause hedging until resume (R-C2-style)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_run_status(control_via_db, suspended=True):
            return JSONResponse(status_code=200, content={"ok": True, "message": "trading suspended (daemon will not hedge until resume)"})
        return JSONResponse(status_code=500, content={"error": "failed to set run status"})

    @app.post("/control/resume")
    def post_control_resume() -> JSONResponse:
        """Set daemon_run_status.suspended=false; daemon will resume hedging."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_run_status(control_via_db, suspended=False):
            return JSONResponse(status_code=200, content={"ok": True, "message": "trading resumed"})
        return JSONResponse(status_code=500, content={"error": "failed to set run status"})

    @app.post("/control/retry_ib")
    def post_control_retry_ib() -> JSONResponse:
        """Insert 'retry_ib' into daemon_control; daemon will attempt IB connect on next poll (RE-7)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "retry_ib"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "retry_ib written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/refresh_accounts")
    def post_control_refresh_accounts() -> JSONResponse:
        """Insert 'refresh_accounts' into daemon_control; daemon will fetch accounts/positions from IB and sync to DB on next poll."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "refresh_accounts"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "refresh_accounts written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/set_heartbeat_interval")
    def post_set_heartbeat_interval(body: Dict[str, Any] = Body(...)) -> JSONResponse:
        """Set daemon_run_status.heartbeat_interval_sec (5–120). Daemon polls and uses this on next heartbeat."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        sec = body.get("heartbeat_interval_sec")
        if sec is None:
            return JSONResponse(status_code=400, content={"error": "heartbeat_interval_sec required (5–120)"})
        try:
            sec = int(sec)
        except (TypeError, ValueError):
            return JSONResponse(status_code=400, content={"error": "heartbeat_interval_sec must be an integer"})
        if write_heartbeat_interval(control_via_db, sec):
            return JSONResponse(status_code=200, content={"ok": True, "heartbeat_interval_sec": max(5, min(120, sec))})
        return JSONResponse(status_code=500, content={"error": "failed to set heartbeat interval"})

    @app.post("/config/ib")
    def post_config_ib(body: Dict[str, Any] = Body(...)) -> JSONResponse:
        """Update settings: ib_host and ib_port_type (tws_live|tws_paper|gateway). Daemon loads this on next start."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        current = reader.get_ib_config() or {"ib_host": "127.0.0.1", "ib_port_type": "tws_paper"}
        ib_host = body.get("ib_host")
        ib_port_type = body.get("ib_port_type")
        host = (str(ib_host).strip() if ib_host is not None else current.get("ib_host", "127.0.0.1")).strip() or "127.0.0.1"
        port_type = (str(ib_port_type).strip().lower() if ib_port_type is not None else current.get("ib_port_type", "tws_paper")) or "tws_paper"
        if port_type not in ("tws_live", "tws_paper", "gateway"):
            port_type = "tws_paper"
        if write_ib_config(control_via_db, host, port_type):
            return JSONResponse(status_code=200, content={"ok": True, "ib_host": host, "ib_port_type": port_type})
        return JSONResponse(status_code=500, content={"error": "failed to write ib config"})

    return app


def run_server(config: dict) -> None:
    """Start the status server (host 0.0.0.0, port from config). Control channel: PostgreSQL daemon_control + daemon_run_status (RE-5). No start: daemon is started on trading host only."""
    import os
    import uvicorn

    status_cfg = config.get("status") or {}
    use_db_control = status_cfg.get("sink") == "postgres" and (status_cfg.get("postgres") or os.environ.get("PGHOST"))

    port = config.get("status_server", {}).get("port") or config.get("server", {}).get("port") or 8765
    data_lag_ms = None
    gates = config.get("gates") or {}
    state_cfg = gates.get("state") or {}
    system_cfg = state_cfg.get("system") or {}
    if "data_lag_threshold_ms" in system_cfg:
        data_lag_ms = system_cfg["data_lag_threshold_ms"]

    reader = StatusReader(status_cfg)
    control_via_db = status_cfg if use_db_control else None
    app = create_app(reader, control_via_db, data_lag_ms)
    host = "0.0.0.0"
    logger.info("Status server on %s:%s (control=daemon_control + daemon_run_status; start only on trading host)", host, port)
    uvicorn.run(app, host=host, port=int(port), log_level="info")
