"""Merged OpenAPI documentation server — aggregates Main + Massive specs at runtime."""

from __future__ import annotations

import logging
import os
import time
from typing import Any, Dict, Optional

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse

from backend.docs.merge_openapi import fetch_openapi, merge_openapi_specs

logger = logging.getLogger(__name__)


def create_docs_app(
    main_openapi_url: str,
    massive_openapi_url: str,
) -> FastAPI:
    """Build a docs-only FastAPI that serves merged OpenAPI from two upstream services."""

    app = FastAPI(
        title="Bifrost API (merged)",
        description="Aggregated documentation for all Bifrost API services.",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    _state: Dict[str, Any] = {
        "main_url": main_openapi_url,
        "massive_url": massive_openapi_url,
    }

    @app.get("/health")
    def health() -> Dict[str, Any]:
        return {
            "status": "ok",
            "service": "bifrost-docs",
            "ts": time.time(),
            "main_url": _state["main_url"],
            "massive_url": _state["massive_url"],
        }

    @app.get("/openapi.json", include_in_schema=False)
    def merged_openapi() -> JSONResponse:
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

    @app.get("/docs", include_in_schema=False)
    def swagger_ui() -> Any:
        return get_swagger_ui_html(
            openapi_url="/openapi.json",
            title="Bifrost API (merged) — Swagger UI",
        )

    @app.get("/redoc", include_in_schema=False)
    def redoc() -> Any:
        return get_redoc_html(
            openapi_url="/openapi.json",
            title="Bifrost API (merged) — ReDoc",
        )

    return app


def run_docs_server(
    config: dict,
    *,
    main_openapi_url: Optional[str] = None,
    massive_openapi_url: Optional[str] = None,
) -> None:
    """Start the merged-docs server."""
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

    app = create_docs_app(main_openapi_url, massive_openapi_url)
    host = "0.0.0.0"
    logger.info("Docs server on %s:%s  (main=%s, massive=%s)", host, docs_port, main_openapi_url, massive_openapi_url)
    uvicorn.run(app, host=host, port=docs_port, log_level="info", log_config=None)
