"""Phase 2: FastAPI app for GET /status, GET /operations, POST /control/*. API only; frontend is separate (frontend/).

Monitoring runs on a separate host from the trading daemon (RE-5). Start of the daemon is only on the trading machine (run_engine.py); no subprocess/start on this server."""

import json
import logging
import os
import threading
import time
from datetime import date, datetime, timedelta
from typing import Any, Dict, Optional, Tuple

import asyncio
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse

from servers.flex_client import fetch_cash_transactions, fetch_trades
from servers.ib_clients import AccountIbClient, MarketIbClient
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
from servers.flex_client import parse_trades_xml
from servers.self_check import derive_daemon_self_check, derive_self_check

try:
    from src.realtime.redis_quotes import (
        RedisQuotesClient,
        create_from_config as create_redis_quotes,
        run_subscribe_loop as redis_run_subscribe_loop,
    )
except ImportError:
    create_redis_quotes = None  # type: ignore
    RedisQuotesClient = None  # type: ignore
    redis_run_subscribe_loop = None  # type: ignore

logger = logging.getLogger(__name__)


def create_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    data_lag_threshold_ms: Optional[float],
    redis_quotes: Optional[Any] = None,
    status_cfg_for_read: Optional[dict] = None,
) -> FastAPI:
    """Build FastAPI app: reader, control channel (stop/flatten/suspend/resume via DB). Optional redis_quotes for GET /quotes (R-RM*).
    status_cfg_for_read: when set, GET /bars/jobs (and GET /bars/jobs/{id}) use this for DB read even if control_via_db is None (e.g. only PGHOST or postgres configured without sink=postgres)."""
    app = FastAPI(title="Bifrost Trader API", description="Phase 2: status and control API (frontend is separate)")
    app.state.redis_quotes = redis_quotes
    # SSE 实时行情：每个连接一个 asyncio.Queue；Redis 订阅线程收到消息后广播到各 queue
    app.state.sse_queues: list = []
    app.state.sse_lock = threading.Lock()
    app.state._sse_loop: Optional[asyncio.AbstractEventLoop] = None
    app.state._redis_subscriber_stop = threading.Event()
    app.state._redis_subscriber_thread: Optional[threading.Thread] = None

    # Celery console log stream (Redis Stream): reader thread + per-connection queues
    app.state.celery_log_queues: list = []
    app.state.celery_log_lock = threading.Lock()
    app.state._celery_log_thread: Optional[threading.Thread] = None
    app.state._celery_log_loop: Optional[asyncio.AbstractEventLoop] = None

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

    @app.on_event("startup")
    async def startup_event() -> None:
        """初始化监控端 IB 客户端（账户 + 行情），使用 settings 中的 host/port/client_id。若启用 Redis 行情，启动 SUBSCRIBE 线程供 SSE 推送。"""
        app.state._sse_loop = asyncio.get_running_loop()
        try:
            ib_cfg = reader.get_ib_config() or {
                "ib_host": "127.0.0.1",
                "ib_port_type": "tws_paper",
                "ib_client_id_daemon": 1,
                "ib_client_id_listener": 2,
                "ib_client_id_account": 100,
                "ib_client_id_markets": 101,
                "ib_client_id_worker_market": 500,
                "ib2_host": None,
                "ib2_port_type": None,
                "ib2_client_id_listener": 3,
                "ib2_client_id_account": 102,
            }
            host = (ib_cfg.get("ib_host") or "127.0.0.1").strip()
            port_type = (ib_cfg.get("ib_port_type") or "tws_paper").strip().lower()
            port_map = {"tws_live": 7496, "tws_paper": 7497, "gateway": 4002}
            port = port_map.get(port_type, 7497)

            app.state.account_ib_client = AccountIbClient(
                host=host,
                port=port,
                client_id=int(ib_cfg.get("ib_client_id_account", 100)),
                name="AccountIbClient",
            )
            app.state.market_ib_client = MarketIbClient(
                host=host,
                port=port,
                client_id=int(ib_cfg.get("ib_client_id_markets", 101)),
                name="MarketIbClient",
            )
            # Second IB (manual-only account): different host = different TWS machine
            ib2_host = (ib_cfg.get("ib2_host") or "").strip()
            if ib2_host:
                port_type_2 = (ib_cfg.get("ib2_port_type") or "tws_paper").strip().lower()
                port_2 = port_map.get(port_type_2, 7497)
                app.state.account_ib_client_2 = AccountIbClient(
                    host=ib2_host,
                    port=port_2,
                    client_id=int(ib_cfg.get("ib2_client_id_account", 102)),
                    name="AccountIbClient2",
                )
                logger.info(
                    "Monitor AccountIbClient2 (second IB) initialized host=%s port=%s client_id=%s",
                    ib2_host,
                    port_2,
                    ib_cfg.get("ib2_client_id_account", 102),
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
                        logger.info("Monitor AccountIbClient2 (Secondary) connected on startup")
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
            logger.warning("Failed to initialize monitor IB clients: %s", exc, exc_info=True)
            app.state.account_ib_client = None
            app.state.market_ib_client = None

        # R-RM* SSE: 若 Redis 行情可用，启动 SUBSCRIBE 线程，收到 daemon:quotes 后广播到各 SSE 连接的 queue
        rq = getattr(app.state, "redis_quotes", None)
        if redis_run_subscribe_loop and rq is not None and getattr(rq, "available", False):

            def _broadcast_quote(quote: Dict[str, Any]) -> None:
                loop = getattr(app.state, "_sse_loop", None)
                if loop is None:
                    return
                with app.state.sse_lock:
                    queues = list(app.state.sse_queues)
                for q in queues:
                    try:
                        loop.call_soon_threadsafe(q.put_nowait, quote)
                    except Exception:
                        pass

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
            client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
            if client is not None:
                await client.disconnect()
        except Exception:
            pass
        try:
            client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
            if client is not None:
                await client.disconnect()
        except Exception:
            pass
        try:
            mclient: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
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

    from servers.routers import core_router, quotes_router, logs_router, status_router, executions_router, market_router, watchlist_router, research_router, daemon_router, config_router

    app.include_router(core_router)
    app.include_router(quotes_router)
    app.include_router(logs_router)
    app.include_router(status_router)
    app.include_router(executions_router)
    app.include_router(market_router)
    app.include_router(watchlist_router)
    app.include_router(research_router)
    app.include_router(daemon_router)
    app.include_router(config_router)

    return app


def run_server(config: dict) -> None:
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
    app = create_app(reader, control_via_db, data_lag_ms, redis_quotes=redis_quotes, status_cfg_for_read=status_cfg_for_read)
    host = "0.0.0.0"
    logger.info("Status server on %s:%s (control=daemon_control + daemon_run_status; start only on trading host)", host, port)
    uvicorn.run(app, host=host, port=int(port), log_level="info", log_config=None)
