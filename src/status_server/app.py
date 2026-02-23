"""Phase 2: FastAPI app for GET /status, GET /operations, POST /control/stop/flatten/suspend/resume, GET / (Web UI).

Monitoring runs on a separate host from the trading daemon (RE-5). Start of the daemon is only on the trading machine (run_engine.py); no subprocess/start on this server."""

import logging
import time
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, HTMLResponse

from src.status_server.reader import StatusReader, write_control_command, write_run_status
from src.status_server.self_check import derive_daemon_self_check, derive_self_check

logger = logging.getLogger(__name__)

_UI_HTML: Optional[str] = None


def _load_ui_html() -> str:
    global _UI_HTML
    if _UI_HTML is not None:
        return _UI_HTML
    p = Path(__file__).resolve().parent / "templates" / "index.html"
    if p.exists():
        _UI_HTML = p.read_text(encoding="utf-8")
    else:
        _UI_HTML = "<!DOCTYPE html><html><body><p>UI template not found.</p><a href='/status'>/status</a></body></html>"
    return _UI_HTML


def create_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    data_lag_threshold_ms: Optional[float],
) -> FastAPI:
    """Build FastAPI app: reader, control channel (stop/flatten/suspend/resume via DB), Web UI (R-M5). No start: daemon is started on trading host only."""
    app = FastAPI(title="Bifrost Status Server", description="Phase 2: status and control API")

    @app.get("/", response_class=HTMLResponse)
    def get_ui() -> str:
        """Serve monitoring Web UI (R-M5): lamp, status, operations, stop/flatten/suspend/resume buttons."""
        return _load_ui_html()

    @app.get("/status")
    def get_status() -> Dict[str, Any]:
        """Return current run status plus self_check, status_lamp, trading_suspended (R-M1b, R-M2, R-M3). Self-check reflects suspended state (degraded + trading_suspended in block_reasons)."""
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
        return payload

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
        """Insert 'retry_ib' into daemon_control; stable daemon will attempt IB connect on next poll (RE-7)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "retry_ib"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "retry_ib written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

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
