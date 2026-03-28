"""Trading domain FastAPI app — executions, performance, transactions."""

import logging
import threading
from typing import Any, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.app.config import config_profile_from_resolved_path
from src.monitor.reader import StatusReader

logger = logging.getLogger(__name__)


def create_trading_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    status_cfg_for_read: Optional[dict] = None,
    resolved_config_path: Optional[str] = None,
    merged_config: Optional[dict] = None,
) -> FastAPI:
    """Build the Trading domain FastAPI app (executions, performance, transactions)."""
    app = FastAPI(
        title="Bifrost Trading API",
        description="Executions, performance, and transaction endpoints.",
        docs_url="/trading/docs",
        redoc_url="/trading/redoc",
        openapi_url="/trading/openapi.json",
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
    app.state.ib_gateway_client = None
    app.state.bifrost_config_profile = (
        config_profile_from_resolved_path(resolved_config_path) if resolved_config_path else None
    )

    _scfg = (merged_config or {}).get("server") or {}
    try:
        app.state.bifrost_trading_port = int(_scfg.get("trading_port") or 8769)
    except (TypeError, ValueError):
        app.state.bifrost_trading_port = 8769

    from backend.trading.routers import executions_router
    app.include_router(executions_router)

    @app.get("/health")
    def trading_health() -> Any:
        import time
        out: Any = {"status": "ok", "service": "bifrost-trading", "ts": time.time()}
        profile = getattr(app.state, "bifrost_config_profile", None)
        if profile is not None:
            out["config_profile"] = profile
        out["port"] = app.state.bifrost_trading_port
        return out

    @app.on_event("startup")
    async def startup_event() -> None:
        from src.ib_gateway.client import IbGatewayClient

        cfg = merged_config or reader._config
        app.state.ib_gateway_client = IbGatewayClient.from_merged_config(cfg)

    @app.on_event("shutdown")
    async def shutdown_event() -> None:
        gw = getattr(app.state, "ib_gateway_client", None)
        if gw is not None:
            try:
                gw.close()
            except Exception:
                pass

    return app


def run_trading_server(config: dict, resolved_config_path: Optional[str] = None) -> None:
    """Start the Trading API server."""
    import os
    import uvicorn

    has_postgres = bool(config.get("postgres") or os.environ.get("PGHOST"))
    status_cfg_for_read = config if has_postgres else None
    control_via_db = config if has_postgres else None

    port = config.get("server", {}).get("trading_port") or 8769

    reader = StatusReader(config)
    app = create_trading_app(
        reader,
        control_via_db,
        status_cfg_for_read=status_cfg_for_read,
        resolved_config_path=resolved_config_path,
        merged_config=config,
    )
    host = "0.0.0.0"
    logger.info("Trading API server on %s:%s", host, port)
    uvicorn.run(app, host=host, port=int(port), log_level="info", log_config=None)
