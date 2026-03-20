"""Core endpoints: root and health."""

import time
from pathlib import Path
from typing import Any, Dict, Union

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, HTMLResponse

router = APIRouter(tags=["core"])


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent.parent


def _frontend_dist() -> Path:
    return _project_root() / "frontend" / "dist"


_FALLBACK_INDEX_HTML = """<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Bifrost Trader API</title></head>
<body style="font-family:system-ui;padding:1rem;">
  <p><strong>Bifrost Trader API</strong> — No production build found. Run <code>cd frontend && npm run build</code>, or use dev UI: <code>./scripts/run_frontend.sh dev</code>.</p>
  <p><a href="/docs">/docs</a> · <a href="/status">/status</a> · <a href="/operations">/operations</a></p>
</body></html>"""


@router.get("/", response_model=None)
def get_root() -> Union[FileResponse, HTMLResponse]:
    """Serve SPA from ``frontend/dist`` when present (same port as API after ``npm run build``); else stub."""
    index = _frontend_dist() / "index.html"
    if index.is_file():
        return FileResponse(index, media_type="text/html")
    return HTMLResponse(_FALLBACK_INDEX_HTML)


@router.get("/favicon.svg", response_model=None)
def get_favicon() -> FileResponse:
    p = _frontend_dist() / "favicon.svg"
    if not p.is_file():
        raise HTTPException(status_code=404, detail="favicon not found (run npm run build)")
    return FileResponse(p, media_type="image/svg+xml")


@router.get("/health")
def get_health() -> Dict[str, Any]:
    """Health check: 200 when process is alive; returns server timestamp (Unix s) for client to compute time since last check."""
    return {"status": "ok", "service": "bifrost-monitor", "ts": time.time()}
