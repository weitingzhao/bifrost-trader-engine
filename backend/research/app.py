"""Research domain FastAPI app — option discovery (IB) and max pain reports only."""

import asyncio
import logging
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.app.config import config_profile_from_resolved_path
from src.monitor.reader import StatusReader

logger = logging.getLogger(__name__)


def create_research_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    status_cfg_for_read: Optional[dict] = None,
    resolved_config_path: Optional[str] = None,
    merged_config: Optional[dict] = None,
) -> FastAPI:
    """Build the Research API app (option discovery + max pain)."""
    app = FastAPI(
        title="Bifrost Research API",
        description="Option discovery (IB-backed) and max pain reports.",
        docs_url="/docs",
        redoc_url="/redoc",
        openapi_url="/openapi.json",
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.reader = reader
    app.state.control_via_db = control_via_db
    app.state.status_cfg_for_read = status_cfg_for_read
    app.state.monitor_enabled = True
    app.state.market_ib_client = None
    app.state.bifrost_config_profile = (
        config_profile_from_resolved_path(resolved_config_path) if resolved_config_path else None
    )

    _scfg = (merged_config or {}).get("server") or {}
    try:
        app.state.bifrost_research_port = int(_scfg.get("research_port") or 8773)
    except (TypeError, ValueError):
        app.state.bifrost_research_port = 8773

    from backend.research.routers.option_discovery import router as option_discovery_router
    from backend.research.routers.max_pain import router as max_pain_router

    app.include_router(option_discovery_router)
    app.include_router(max_pain_router)

    def _health_payload() -> Dict[str, Any]:
        import time
        out: Dict[str, Any] = {"status": "ok", "service": "bifrost-research", "ts": time.time()}
        profile = getattr(app.state, "bifrost_config_profile", None)
        if profile is not None:
            out["config_profile"] = profile
        _srv = reader._config.get("server") or {}
        out["port"] = int(_srv.get("research_port") or 8773)
        if resolved_config_path:
            out["config_path"] = str(Path(resolved_config_path).resolve())
        return out

    @app.get("/health")
    def research_health() -> Dict[str, Any]:
        return _health_payload()

    @app.on_event("startup")
    async def startup_event() -> None:
        from src.app.config import get_effective_ib_config
        from src.monitor.integrations.ib_clients import MarketIbClient

        skip_ib = (reader._config.get("server") or {}).get("skip_monitor_ib", False)
        if not skip_ib:
            try:
                ib_cfg = get_effective_ib_config(reader._config)
                app.state.market_ib_client = MarketIbClient(
                    host=ib_cfg["host"],
                    port=ib_cfg["port"],
                    client_id=ib_cfg["client_id_markets"],
                    name="ResearchMarketIbClient",
                )

                async def _connect() -> None:
                    client = getattr(app.state, "market_ib_client", None)
                    if client is not None:
                        try:
                            await client.ensure_connected()
                        except Exception as e:
                            logger.warning("ResearchMarketIbClient auto-connect failed: %s", e)

                asyncio.create_task(_connect())
            except Exception as exc:
                logger.warning("Research IB client init failed: %s", exc, exc_info=True)
                app.state.market_ib_client = None

    @app.on_event("shutdown")
    async def shutdown_event() -> None:
        client = getattr(app.state, "market_ib_client", None)
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass

    return app


def run_research_server(config: dict, resolved_config_path: Optional[str] = None) -> None:
    """Start the Research API server."""
    import os
    import uvicorn

    has_postgres = bool(config.get("postgres") or os.environ.get("PGHOST"))
    status_cfg_for_read = config if has_postgres else None
    control_via_db = config if has_postgres else None

    port = config.get("server", {}).get("research_port") or 8773

    reader = StatusReader(config)
    app = create_research_app(
        reader,
        control_via_db,
        status_cfg_for_read=status_cfg_for_read,
        resolved_config_path=resolved_config_path,
        merged_config=config,
    )
    host = "0.0.0.0"
    logger.info("Research API server on %s:%s", host, port)
    uvicorn.run(app, host=host, port=int(port), log_level="info", log_config=None)
