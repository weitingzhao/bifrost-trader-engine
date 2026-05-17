"""Core endpoints: root and health."""

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

logger = logging.getLogger(__name__)

MONITOR_SHUTDOWN_EXIT_DELAY_SEC = 2.5

router = APIRouter(tags=["core"])


def _project_root() -> Path:
    # backend/monitor/routers/core.py -> repo root (not backend/)
    return Path(__file__).resolve().parent.parent.parent.parent


_API_STUB_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Bifrost Trader API</title></head>
<body style="font-family:system-ui;padding:1rem;">
  <p><strong>Bifrost Trader API</strong> — Monitor API is running. Frontend is served by the Next.js server (bifrost-frontend.service).</p>
  <p><a href="/docs">/docs</a> · <a href="/status">/status</a> (JSON) · <a href="/operations">/operations</a></p>
</body></html>"""


@router.get("/", response_model=None)
def get_root() -> HTMLResponse:
    """API stub — production frontend is served by Next.js (bifrost-frontend.service via nginx)."""
    return HTMLResponse(_API_STUB_HTML)


@router.get("/health")
def get_health(request: Request) -> Dict[str, Any]:
    """Health check: 200 when process is alive; returns server timestamp (Unix s) for client to compute time since last check."""
    out: Dict[str, Any] = {"status": "ok", "service": "bifrost-monitor", "ts": time.time()}
    profile = getattr(request.app.state, "bifrost_config_profile", None)
    if profile is not None:
        out["config_profile"] = profile
    fe_pub = getattr(request.app.state, "bifrost_frontend_public_origin", None)
    if fe_pub:
        out["frontend_public_origin"] = fe_pub
    fe_dev = getattr(request.app.state, "bifrost_frontend_dev_path", None)
    if fe_dev:
        out["frontend_dev_path"] = fe_dev
    fe_prod = getattr(request.app.state, "bifrost_frontend_prod_path", None)
    if fe_prod:
        out["frontend_prod_path"] = fe_prod
    out["monitor_port"] = int(request.app.state.bifrost_server_listen_port)
    out["massive_port"] = int(request.app.state.bifrost_massive_port)
    out["docs_port"] = int(request.app.state.bifrost_docs_port)
    out["ops_port"] = int(request.app.state.bifrost_ops_port)
    out["trading_port"] = int(request.app.state.bifrost_trading_port)
    out["strategy_port"] = int(request.app.state.bifrost_strategy_port)
    out["portfolio_port"] = int(request.app.state.bifrost_portfolio_port)
    out["market_port"] = int(request.app.state.bifrost_market_port)
    out["research_port"] = int(request.app.state.bifrost_research_port)
    out["utilized_services"] = list(getattr(request.app.state, "bifrost_utilized_services", []) or [])
    return out


@router.get("/api/server/auth/capabilities")
def server_auth_capabilities(request: Request) -> Dict[str, Any]:
    """Same shape as GET /ops/auth/capabilities (shared ops.auth tokens)."""
    cfg = getattr(request.app.state, "bifrost_merged_config", None) or {}
    from backend.ops.auth import AuthConfig, OpsAuth

    return OpsAuth(AuthConfig.from_config(cfg)).capabilities(request)


@router.post("/api/server/shutdown")
def post_server_shutdown(request: Request) -> Any:
    """Terminate the Monitor API process (``run_server.py`` / uvicorn). Requires operator role."""
    from backend.ops.auth import AuthConfig, OpsAuth
    from backend.ops.models.schemas import AuditEntry

    cfg = getattr(request.app.state, "bifrost_merged_config", None) or {}
    ops_auth = OpsAuth(AuthConfig.from_config(cfg))
    ident, denied = ops_auth.require_role(request, "operator")
    audit_store = getattr(request.app.state, "audit_store", None)
    if denied:
        if audit_store is not None:
            audit_store.append(
                AuditEntry(
                    operator=ident.name,
                    source_ip=request.client.host if request.client else None,
                    action="monitor_shutdown",
                    target="process",
                    outcome="denied",
                    detail=f"role={ident.role}",
                ),
            )
        return denied
    if audit_store is not None:
        audit_store.append(
            AuditEntry(
                operator=ident.name,
                source_ip=request.client.host if request.client else None,
                action="monitor_shutdown",
                target="process",
                outcome="scheduled",
                detail="process exit",
            ),
        )

    def _exit_after_send() -> None:
        time.sleep(MONITOR_SHUTDOWN_EXIT_DELAY_SEC)
        logger.info("Monitor API shutdown: exiting process.")
        os._exit(0)

    threading.Thread(target=_exit_after_send, daemon=True).start()
    return {"ok": True}
