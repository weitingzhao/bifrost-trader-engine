"""Research domain FastAPI app — merges Massive + Option Discovery + Max Pain."""

import asyncio
import logging
import threading
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from src.app.config import config_profile_from_resolved_path
from src.monitor.reader import StatusReader
from src.monitor.redis_url import redis_url_from_config
from src.core.sse.queue_utils import put_nowait_drop_oldest
from backend.research.sse import run_massive_channel_subscribe_loop

logger = logging.getLogger(__name__)


def create_research_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    status_cfg_for_read: Optional[dict] = None,
    resolved_config_path: Optional[str] = None,
    merged_config: Optional[dict] = None,
) -> FastAPI:
    """Build the Research domain FastAPI app (Massive + Option Discovery + Reports)."""
    app = FastAPI(
        title="Bifrost Research API",
        description="Massive/Polygon option research, option discovery, and max pain reports.",
        docs_url="/research/massive/docs",
        redoc_url="/research/massive/redoc",
        openapi_url="/research/massive/openapi.json",
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

    # Massive SSE fan-out state
    app.state.massive_sse_queues: list = []
    app.state.massive_sse_lock = threading.Lock()
    app.state._massive_sse_subscriber_stop = threading.Event()
    app.state._massive_sse_subscriber_thread: Optional[threading.Thread] = None
    app.state._sse_loop: Optional[asyncio.AbstractEventLoop] = None

    _scfg = (merged_config or {}).get("server") or {}
    try:
        app.state.bifrost_massive_port = int(_scfg.get("massive_port") or 8766)
    except (TypeError, ValueError):
        app.state.bifrost_massive_port = 8766

    from backend.research.routers.stream import router as stream_router
    from backend.research.routers.routes import router as routes_router
    from backend.research.routers.option_discovery import router as option_discovery_router
    from backend.research.routers.max_pain import router as max_pain_router

    app.include_router(stream_router)
    app.include_router(routes_router)
    app.include_router(option_discovery_router)
    app.include_router(max_pain_router)

    def _health_payload() -> Dict[str, Any]:
        import time
        out: Dict[str, Any] = {"status": "ok", "service": "bifrost-research", "ts": time.time()}
        profile = getattr(app.state, "bifrost_config_profile", None)
        if profile is not None:
            out["config_profile"] = profile
        _srv = reader._config.get("server") or {}
        out["port"] = int(_srv.get("massive_port") or 8766)
        if resolved_config_path:
            out["config_path"] = str(Path(resolved_config_path).resolve())
        return out

    @app.get("/health")
    def research_health_root() -> Dict[str, Any]:
        return _health_payload()

    @app.get("/research/massive/health")
    def research_health_prefixed() -> Dict[str, Any]:
        return _health_payload()

    @app.on_event("startup")
    async def startup_event() -> None:
        app.state._sse_loop = asyncio.get_running_loop()

        # Optional: MarketIbClient for option discovery endpoints
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

        try:
            _massive_url = redis_url_from_config(reader._config)
            if _massive_url:
                def _broadcast_massive(evt: Dict[str, Any]) -> None:
                    loop = getattr(app.state, "_sse_loop", None)
                    if loop is None:
                        return
                    with app.state.massive_sse_lock:
                        queues = list(app.state.massive_sse_queues)
                    for q in queues:
                        loop.call_soon_threadsafe(put_nowait_drop_oldest, q, evt)

                app.state._massive_sse_subscriber_stop.clear()
                app.state._massive_sse_subscriber_thread = threading.Thread(
                    target=run_massive_channel_subscribe_loop,
                    args=(
                        _massive_url,
                        app.state._massive_sse_subscriber_stop,
                        _broadcast_massive,
                    ),
                    daemon=True,
                    name="massive-channel-sse-subscriber",
                )
                app.state._massive_sse_subscriber_thread.start()
                logger.info("Massive SSE Redis subscriber thread started")
        except Exception as exc:
            logger.warning("Massive SSE subscriber not started: %s", exc)

    @app.on_event("shutdown")
    async def shutdown_event() -> None:
        app.state._massive_sse_subscriber_stop.set()
        if getattr(app.state, "_massive_sse_subscriber_thread", None) is not None:
            app.state._massive_sse_subscriber_thread.join(timeout=2.0)
            app.state._massive_sse_subscriber_thread = None
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

    port = config.get("server", {}).get("massive_port") or 8766

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
