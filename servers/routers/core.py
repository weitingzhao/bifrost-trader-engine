"""Core endpoints: root and health."""

import time
from typing import Any, Dict

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter(tags=["core"])


@router.get("/", response_class=HTMLResponse)
def get_root() -> str:
    """API only: link to docs and main endpoints. Use project frontend (e.g. npm run dev) for the monitoring UI."""
    return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>Bifrost Trader API</title></head>
<body style="font-family:system-ui;padding:1rem;">
  <p><strong>Bifrost Trader API</strong> — 本端口仅提供 API，监控页面请使用项目内 frontend（如 <code>cd frontend && npm run dev</code>）。</p>
  <p><a href="/docs">/docs</a> · <a href="/status">/status</a> · <a href="/operations">/operations</a></p>
</body></html>"""


@router.get("/health")
def get_health() -> Dict[str, Any]:
    """Health check: 200 when process is alive; returns server timestamp (Unix s) for client to compute time since last check."""
    return {"status": "ok", "service": "bifrost-monitor", "ts": time.time()}
