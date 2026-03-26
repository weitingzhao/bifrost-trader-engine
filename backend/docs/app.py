"""Bifrost Docs API — merged OpenAPI (Main + Massive), same URL layout as Massive API."""

from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from backend.docs.merge_openapi import fetch_openapi, merge_openapi_specs
from src.app.config import config_profile_from_resolved_path

logger = logging.getLogger(__name__)

# Same pattern as backend.massive.routers.routes (POST /research/massive/shutdown).
DOCS_STOP_EXIT_DELAY_SEC = 2.5

# Same pattern as backend.massive.app (Massive API).
DOCS_PATH_PREFIX = "/research/docs"


def create_docs_app(
    main_openapi_url: str,
    massive_openapi_url: str,
    *,
    config: Optional[dict] = None,
    resolved_config_path: Optional[str] = None,
) -> FastAPI:
    """Build the docs-only FastAPI: merged OpenAPI + Swagger/ReDoc.

    Canonical paths (mirror ``/research/massive/*``)::

        /research/docs/openapi.json
        /research/docs/docs
        /research/docs/redoc
        /research/docs/health

    Root ``/openapi.json``, ``/docs``, ``/redoc`` remain for nginx
    ``/bifrost-api-docs/`` → ``127.0.0.1:8767/`` (stripped prefix). Set
    ``BIFROST_DOCS_ROOT_PATH=/bifrost-api-docs`` so Swagger loads the correct
    ``openapi.json`` URL in the browser.
    """

    app = FastAPI(
        title="Bifrost Docs API",
        description="Aggregated OpenAPI documentation for Main + Massive services.",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    _state: Dict[str, Any] = {
        "main_url": main_openapi_url,
        "massive_url": massive_openapi_url,
    }

    _legacy_browser_prefix = os.environ.get("BIFROST_DOCS_ROOT_PATH", "").strip().rstrip("/")

    def _health_payload() -> Dict[str, Any]:
        out: Dict[str, Any] = {
            "status": "ok",
            "service": "bifrost-docs",
            "ts": time.time(),
            "main_url": _state["main_url"],
            "massive_url": _state["massive_url"],
        }
        srv = (config or {}).get("server") or {}
        out["port"] = int(srv.get("docs_port") or 8767)
        profile = config_profile_from_resolved_path(resolved_config_path) if resolved_config_path else None
        if profile is not None:
            out["config_profile"] = profile
        if resolved_config_path:
            out["config_path"] = str(Path(resolved_config_path).resolve())
        return out

    @app.get("/health")
    def docs_health_root() -> Dict[str, Any]:
        return _health_payload()

    @app.get(f"{DOCS_PATH_PREFIX}/health")
    def docs_health_prefixed() -> Dict[str, Any]:
        return _health_payload()

    @app.post(f"{DOCS_PATH_PREFIX}/shutdown")
    def post_docs_shutdown() -> Dict[str, Any]:
        """Terminate the Docs API process (same pattern as Massive API shutdown)."""

        def _exit_after_send() -> None:
            time.sleep(DOCS_STOP_EXIT_DELAY_SEC)
            logger.info("Docs API shutdown: exiting process.")
            os._exit(0)

        threading.Thread(target=_exit_after_send, daemon=True).start()
        return {"ok": True}

    def _merged_openapi_response() -> JSONResponse:
        try:
            main_spec = fetch_openapi(_state["main_url"])
        except Exception as exc:
            logger.warning("Failed to fetch main OpenAPI from %s: %s", _state["main_url"], exc)
            return JSONResponse(
                status_code=502,
                content={"detail": f"Cannot reach main API: {exc}"},
            )
        try:
            massive_spec = fetch_openapi(_state["massive_url"])
        except Exception as exc:
            logger.warning("Failed to fetch Massive OpenAPI from %s: %s", _state["massive_url"], exc)
            return JSONResponse(
                status_code=502,
                content={"detail": f"Cannot reach Massive API: {exc}"},
            )
        merged = merge_openapi_specs(main_spec, massive_spec, secondary_prefix="Massive")
        return JSONResponse(content=merged)

    from fastapi.openapi.docs import get_swagger_ui_html, get_redoc_html

    def _swagger(openapi_url: str) -> Any:
        return get_swagger_ui_html(
            openapi_url=openapi_url,
            title="Bifrost API (merged) — Swagger UI",
        )

    def _redoc(openapi_url: str) -> Any:
        return get_redoc_html(
            openapi_url=openapi_url,
            title="Bifrost API (merged) — ReDoc",
        )

    # --- Canonical /research/docs/* (same layout as Massive API) ---
    @app.get(f"{DOCS_PATH_PREFIX}/openapi.json", include_in_schema=False)
    def merged_openapi_prefixed() -> JSONResponse:
        return _merged_openapi_response()

    @app.get(f"{DOCS_PATH_PREFIX}/docs", include_in_schema=False)
    def swagger_ui_prefixed() -> Any:
        return _swagger(f"{DOCS_PATH_PREFIX}/openapi.json")

    @app.get(f"{DOCS_PATH_PREFIX}/redoc", include_in_schema=False)
    def redoc_prefixed() -> Any:
        return _redoc(f"{DOCS_PATH_PREFIX}/openapi.json")

    # --- Legacy: upstream root when nginx strips /bifrost-api-docs/ ---
    _root_openapi_browser = f"{_legacy_browser_prefix}/openapi.json" if _legacy_browser_prefix else "/openapi.json"

    @app.get("/openapi.json", include_in_schema=False)
    def merged_openapi_root() -> JSONResponse:
        return _merged_openapi_response()

    @app.get("/docs", include_in_schema=False)
    def swagger_ui_root() -> Any:
        return _swagger(_root_openapi_browser)

    @app.get("/redoc", include_in_schema=False)
    def redoc_root() -> Any:
        return _redoc(_root_openapi_browser)

    return app


def run_docs_server(
    config: dict,
    resolved_config_path: Optional[str] = None,
    *,
    main_openapi_url: Optional[str] = None,
    massive_openapi_url: Optional[str] = None,
) -> None:
    """Start the Docs API server (merged OpenAPI)."""
    import uvicorn

    server_cfg = config.get("server") or {}
    main_port = int(server_cfg.get("port") or 8765)
    massive_port = int(server_cfg.get("massive_port") or 8766)
    docs_port = int(server_cfg.get("docs_port") or 8767)

    if main_openapi_url is None:
        main_openapi_url = os.environ.get(
            "BIFROST_DOCS_MAIN_OPENAPI",
            f"http://127.0.0.1:{main_port}/openapi.json",
        )
    if massive_openapi_url is None:
        massive_openapi_url = os.environ.get(
            "BIFROST_DOCS_MASSIVE_OPENAPI",
            f"http://127.0.0.1:{massive_port}/research/massive/openapi.json",
        )

    app = create_docs_app(
        main_openapi_url,
        massive_openapi_url,
        config=config,
        resolved_config_path=resolved_config_path,
    )
    host = "0.0.0.0"
    logger.info(
        "Docs API server on %s:%s  (main=%s, massive=%s)",
        host,
        docs_port,
        main_openapi_url,
        massive_openapi_url,
    )
    uvicorn.run(app, host=host, port=docs_port, log_level="info", log_config=None)
