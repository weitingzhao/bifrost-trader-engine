"""Phase 2: FastAPI app for GET /status, GET /operations, POST /control/*.

When ``frontend/dist`` exists (``npm run build``), GET ``/`` serves the SPA and ``/assets`` is mounted; otherwise GET ``/`` returns a small API stub. Dev hot-reload: ``./scripts/run_frontend.sh dev``.

Monitoring runs on a separate host from the trading daemon (RE-5). Start of the daemon is only on the trading machine (run_engine.py); no subprocess/start on this server.
"""

import json
import logging
import os
import threading
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import asyncio
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from src.app.config import config_profile_from_resolved_path, get_effective_ib_config
from src.portfolio.integrations.flex_client import fetch_cash_transactions, fetch_trades
from src.monitor.integrations.ib_clients import AccountIbClient, MarketIbClient
from servers.reader import (
    StatusReader,
    write_ohlc_bars_to_db,
    write_stock_bars,
    delete_stock_bars_for_symbol,
    write_account_executions_to_db,
    update_execution_commission,
    insert_one_execution,
    update_one_execution,
    delete_one_execution,
    insert_job_bars_backfill,
    get_job_bars_backfill_list,
    get_job_bars_backfill,
    delete_job_bars_backfill,
    delete_all_job_bars_backfill,
    trim_job_bars_backfill,
    get_job_bars_backfill_last_updated,
    upsert_account_transactions,
)
from src.portfolio.integrations.flex_client import parse_trades_xml
from src.monitor.self_check import derive_daemon_self_check, derive_self_check
from servers.sse_queue_utils import put_nowait_drop_oldest

try:
    from src.daemon.realtime.redis_quotes import (
        RedisQuotesClient,
        create_from_config as create_redis_quotes,
        run_subscribe_loop as redis_run_subscribe_loop,
    )
except ImportError:
    create_redis_quotes = None  # type: ignore
    RedisQuotesClient = None  # type: ignore
    redis_run_subscribe_loop = None  # type: ignore

logger = logging.getLogger(__name__)


def _utilized_services_from_config(merged_config: Optional[dict]) -> List[Dict[str, str]]:
    """Parse ``utilized.services`` from YAML into [{"service": "massive", "env": "dev"}, ...]."""
    out: List[Dict[str, str]] = []
    if not merged_config:
        return out
    raw = merged_config.get("utilized") or {}
    services = raw.get("services")
    if not isinstance(services, list):
        return out
    for x in services:
        if isinstance(x, dict):
            for k, v in x.items():
                ks = str(k).strip()
                vs = str(v).strip().strip("\"'")
                if ks and vs:
                    out.append({"service": ks, "env": vs})
        elif isinstance(x, str):
            part = x.strip()
            if ":" in part:
                left, _, right = part.partition(":")
                name = left.strip()
                env = right.strip().strip("\"'")
                if name and env:
                    out.append({"service": name, "env": env})
    return out


def create_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    data_lag_threshold_ms: Optional[float],
    redis_quotes: Optional[Any] = None,
    status_cfg_for_read: Optional[dict] = None,
    resolved_config_path: Optional[str] = None,
    merged_config: Optional[dict] = None,
) -> FastAPI:
    """Build FastAPI app: reader, control channel (stop/flatten/suspend/resume via DB). Optional redis_quotes for GET /quotes (R-RM*).
    status_cfg_for_read: when set, read paths that use DB without control channel (e.g. only PGHOST or postgres configured without sink=postgres). Job queue APIs are on Ops: GET /ops/bars/jobs.
    """
    app = FastAPI(
        title="Bifrost Trader API",
        description="Phase 2: status and control API; monitoring UI when frontend/dist is built.",
    )
    # Browser fetch from Vite / another host to this API (e.g. Settings → API Health split probes).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.redis_quotes = redis_quotes
    # SSE 实时行情：每个连接一个 asyncio.Queue；Redis 订阅线程收到消息后广播到各 queue
    app.state.sse_queues: list = []
    app.state.sse_lock = threading.Lock()
    app.state._sse_loop: Optional[asyncio.AbstractEventLoop] = None
    app.state._redis_subscriber_stop = threading.Event()
    app.state._redis_subscriber_thread: Optional[threading.Thread] = None

    # Daemon console log stream (Redis Stream): reader thread + per-connection queues
    app.state.daemon_log_queues: list = []
    app.state.daemon_log_lock = threading.Lock()
    app.state._daemon_log_thread: Optional[threading.Thread] = None
    app.state._daemon_log_loop: Optional[asyncio.AbstractEventLoop] = None

    # Server console log stream (Redis Stream): reader thread + per-connection queues
    app.state.server_log_queues: list = []
    app.state.server_log_lock = threading.Lock()
    app.state._server_log_thread: Optional[threading.Thread] = None
    app.state._server_log_loop: Optional[asyncio.AbstractEventLoop] = None

    # Massive API console log stream (run_server_massive.py → bifrost:massive_console)
    app.state.massive_log_queues: list = []
    app.state.massive_log_lock = threading.Lock()
    app.state._massive_log_thread: Optional[threading.Thread] = None
    app.state._massive_log_loop: Optional[asyncio.AbstractEventLoop] = None

    # Docs API console log stream (run_server_docs.py → bifrost:docs_console)
    app.state.docs_log_queues: list = []
    app.state.docs_log_lock = threading.Lock()
    app.state._docs_log_thread: Optional[threading.Thread] = None
    app.state._docs_log_loop: Optional[asyncio.AbstractEventLoop] = None

    # Ops API console log stream (run_server_ops.py → bifrost:ops_console)
    app.state.ops_log_queues: list = []
    app.state.ops_log_lock = threading.Lock()
    app.state._ops_log_thread: Optional[threading.Thread] = None
    app.state._ops_log_loop: Optional[asyncio.AbstractEventLoop] = None

    # Monitor-side IB state (for AccountIbClient / MarketIbClient).
    app.state.monitor_enabled = True
    app.state.account_ib_client = None
    app.state.market_ib_client = None
    app.state.account_ib_client_2 = None  # Second TWS (manual-only account, R-A4)

    # Shared deps for routers (reader, control_via_db, etc.)
    app.state.reader = reader
    app.state.control_via_db = control_via_db
    app.state.data_lag_threshold_ms = data_lag_threshold_ms
    app.state.status_cfg_for_read = status_cfg_for_read
    app.state.bifrost_config_profile = (
        config_profile_from_resolved_path(resolved_config_path)
        if resolved_config_path
        else None
    )
    _fe = (merged_config or {}).get("frontend") or {}

    def _fe_str(key: str) -> Optional[str]:
        v = _fe.get(key)
        if v is None:
            return None
        t = str(v).strip()
        return t or None

    app.state.bifrost_frontend_public_origin = _fe_str("public_origin")
    app.state.bifrost_frontend_dev_path = _fe_str("dev_path")
    app.state.bifrost_frontend_prod_path = _fe_str("prod_path")

    _scfg = (merged_config or {}).get("server") or {}
    try:
        app.state.bifrost_server_listen_port = int(_scfg.get("port") or 8765)
    except (TypeError, ValueError):
        app.state.bifrost_server_listen_port = 8765
    try:
        app.state.bifrost_massive_port = int(_scfg.get("massive_port") or 8766)
    except (TypeError, ValueError):
        app.state.bifrost_massive_port = 8766
    try:
        app.state.bifrost_docs_port = int(_scfg.get("docs_port") or 8767)
    except (TypeError, ValueError):
        app.state.bifrost_docs_port = 8767
    try:
        app.state.bifrost_ops_port = int(_scfg.get("ops_port") or 8768)
    except (TypeError, ValueError):
        app.state.bifrost_ops_port = 8768

    app.state.bifrost_utilized_services = _utilized_services_from_config(merged_config)

    from backend.monitor.routers import (
        config_router,
        core_router,
        daemon_router,
        executions_router,
        logs_router,
        market_router,
        portfolio_model_router,
        quotes_router,
        reports_router,
        research_router,
        status_router,
        strategies_router,
        watchlist_router,
    )
    from backend.monitor.routers.research_sidecars import router as research_sidecars_router

    app.include_router(core_router)
    app.include_router(quotes_router)
    app.include_router(logs_router)
    app.include_router(status_router)
    app.include_router(executions_router)
    app.include_router(market_router)
    app.include_router(watchlist_router)
    app.include_router(research_router)
    app.include_router(research_sidecars_router)
    app.include_router(reports_router)
    app.include_router(daemon_router)
    app.include_router(config_router)
    app.include_router(strategies_router)
    app.include_router(portfolio_model_router)

    _root = Path(__file__).resolve().parent.parent
    _dist_assets = _root / "frontend" / "dist" / "assets"
    if _dist_assets.is_dir():
        app.mount(
            "/assets", StaticFiles(directory=str(_dist_assets)), name="dist_assets"
        )

    @app.on_event("startup")
    async def startup_event() -> None:
        """初始化监控端 IB 客户端（账户 + 行情），使用 config.yaml 的 host/port/client_id。若启用 Redis 行情，启动 SUBSCRIBE 线程供 SSE 推送。"""
        app.state._sse_loop = asyncio.get_running_loop()
        skip_ib = (reader._config.get("server") or {}).get("skip_monitor_ib", False)
        if skip_ib:
            logger.info(
                "skip_monitor_ib=true: skipping AccountIbClient / MarketIbClient initialisation (Management mode)"
            )
            app.state.account_ib_client = None
            app.state.market_ib_client = None
            app.state.account_ib_client_2 = None
        else:
            try:
                ib_cfg = get_effective_ib_config(reader._config)
                host = ib_cfg["host"]
                port = ib_cfg["port"]

                app.state.account_ib_client = AccountIbClient(
                    host=host,
                    port=port,
                    client_id=ib_cfg["client_id_account"],
                    name="AccountIbClient",
                )
                app.state.market_ib_client = MarketIbClient(
                    host=host,
                    port=port,
                    client_id=ib_cfg["client_id_markets"],
                    name="MarketIbClient",
                )
                ib2_host = ib_cfg.get("ib2_host") or ""
                if ib2_host:
                    app.state.account_ib_client_2 = AccountIbClient(
                        host=ib2_host,
                        port=ib_cfg["ib2_port"],
                        client_id=ib_cfg["ib2_client_id_account"],
                        name="AccountIbClient2",
                    )
                    logger.info(
                        "Monitor AccountIbClient2 (second IB) initialized host=%s port=%s client_id=%s",
                        ib2_host,
                        ib_cfg["ib2_port"],
                        ib_cfg["ib2_client_id_account"],
                    )
                else:
                    app.state.account_ib_client_2 = None
                logger.info(
                    "Monitor IB clients initialized (host=%s port=%s account_id=%s market_id=%s)",
                    host,
                    port,
                    getattr(app.state.account_ib_client, "client_id", None),
                    getattr(app.state.market_ib_client, "client_id", None),
                )

                # 后台尝试建立 IB 连接，不阻塞 startup，避免 GET /status、GET /health 等不到响应导致前端显示 Fetch failed
                async def _connect_ib_in_background() -> None:
                    acc_client = getattr(app.state, "account_ib_client", None)
                    acc_client_2 = getattr(app.state, "account_ib_client_2", None)
                    mkt_client = getattr(app.state, "market_ib_client", None)
                    if acc_client is not None:
                        try:
                            await acc_client.ensure_connected()
                            logger.info("Monitor AccountIbClient connected on startup")
                        except Exception as e:
                            logger.warning(
                                "AccountIbClient auto-connect on startup failed: %s (will retry on first use)",
                                e,
                            )
                    if acc_client_2 is not None:
                        try:
                            await acc_client_2.ensure_connected()
                            logger.info(
                                "Monitor AccountIbClient2 (Secondary) connected on startup"
                            )
                        except Exception as e:
                            logger.warning(
                                "AccountIbClient2 auto-connect on startup failed: %s (will retry on Connect or first use)",
                                e,
                            )
                    if mkt_client is not None:
                        try:
                            await mkt_client.ensure_connected()
                            logger.info("Monitor MarketIbClient connected on startup")
                        except Exception as e:
                            logger.warning(
                                "MarketIbClient auto-connect on startup failed: %s (will retry on first use)",
                                e,
                            )

                asyncio.create_task(_connect_ib_in_background())
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "Failed to initialize monitor IB clients: %s", exc, exc_info=True
                )
                app.state.account_ib_client = None
                app.state.market_ib_client = None
                app.state.account_ib_client_2 = None

        # R-RM* SSE: 若 Redis 行情可用，启动 SUBSCRIBE 线程，收到 daemon:quotes 后广播到各 SSE 连接的 queue
        rq = getattr(app.state, "redis_quotes", None)
        if (
            redis_run_subscribe_loop
            and rq is not None
            and getattr(rq, "available", False)
        ):

            def _broadcast_quote(quote: Dict[str, Any]) -> None:
                loop = getattr(app.state, "_sse_loop", None)
                if loop is None:
                    return
                with app.state.sse_lock:
                    queues = list(app.state.sse_queues)
                for q in queues:
                    # put_nowait runs inside the loop callback; QueueFull must be handled there (put_nowait_drop_oldest).
                    loop.call_soon_threadsafe(put_nowait_drop_oldest, q, quote)

            app.state._redis_subscriber_stop.clear()
            app.state._redis_subscriber_thread = threading.Thread(
                target=redis_run_subscribe_loop,
                args=(rq, _broadcast_quote, app.state._redis_subscriber_stop),
                daemon=True,
                name="redis-quotes-subscriber",
            )
            app.state._redis_subscriber_thread.start()
            logger.info("Redis quotes SSE subscriber thread started")

    @app.on_event("shutdown")
    async def shutdown_event() -> None:
        """优雅断开监控端 IB 客户端，并停止 Redis 订阅线程。"""
        app.state._redis_subscriber_stop.set()
        if getattr(app.state, "_redis_subscriber_thread", None) is not None:
            app.state._redis_subscriber_thread.join(timeout=2.0)
            app.state._redis_subscriber_thread = None
        try:
            client: Optional[AccountIbClient] = getattr(
                app.state, "account_ib_client", None
            )
            if client is not None:
                await client.disconnect()
        except Exception:
            pass
        try:
            client: Optional[AccountIbClient] = getattr(
                app.state, "account_ib_client", None
            )
            if client is not None:
                await client.disconnect()
        except Exception:
            pass
        try:
            mclient: Optional[MarketIbClient] = getattr(
                app.state, "market_ib_client", None
            )
            if mclient is not None:
                await mclient.disconnect()
        except Exception:
            pass
        try:
            rq = getattr(app.state, "redis_quotes", None)
            if rq is not None and getattr(rq, "close", None):
                rq.close()
        except Exception:
            pass

    return app


def run_server(config: dict, resolved_config_path: Optional[str] = None) -> None:
    """Start the status server (host 0.0.0.0, port from config). Control channel: PostgreSQL daemon_control + daemon_run_status (RE-5). No start: daemon is started on trading host only."""
    import os
    import uvicorn

    has_postgres = bool(config.get("postgres") or os.environ.get("PGHOST"))
    use_db_control = has_postgres
    status_cfg_for_read = config if has_postgres else None

    port = config.get("server", {}).get("port") or 8765
    data_lag_ms = None
    gates = config.get("gates") or {}
    state_cfg = gates.get("state") or {}
    system_cfg = state_cfg.get("system") or {}
    if "data_lag_threshold_ms" in system_cfg:
        data_lag_ms = system_cfg["data_lag_threshold_ms"]

    reader = StatusReader(config)
    control_via_db = config if use_db_control else None
    redis_quotes = None
    if create_redis_quotes:
        redis_quotes = create_redis_quotes(config)
    app = create_app(
        reader,
        control_via_db,
        data_lag_ms,
        redis_quotes=redis_quotes,
        status_cfg_for_read=status_cfg_for_read,
        resolved_config_path=resolved_config_path,
        merged_config=config,
    )
    host = "0.0.0.0"
    logger.info(
        "Status server on %s:%s (control=daemon_control + daemon_run_status; start only on trading host)",
        host,
        port,
    )
    uvicorn.run(app, host=host, port=int(port), log_level="info", log_config=None)
