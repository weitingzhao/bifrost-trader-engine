"""Phase 2: FastAPI app for GET /status, GET /operations, POST /control/*. API only; frontend is separate (frontend/).

Monitoring runs on a separate host from the trading daemon (RE-5). Start of the daemon is only on the trading machine (run_engine.py); no subprocess/start on this server."""

import json
import logging
import os
import threading
import time
from datetime import date, datetime
from typing import Any, Dict, List, Optional

import asyncio
from fastapi import Body, FastAPI, Query
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from servers.ib_clients import AccountIbClient, MarketIbClient
from servers.ib_clients import AccountIbClient, MarketIbClient
from servers.reader import (
    StatusReader,
    write_control_command,
    write_run_status,
    write_heartbeat_interval,
    write_ib_config,
    write_ohlc_bars_to_db,
    write_stock_bars,
    delete_stock_bars_for_symbol,
    write_account_executions_to_db,
    update_execution_commission,
    insert_one_execution,
    update_one_execution,
    delete_one_execution,
    sync_accounts_snapshot_to_db,
    insert_bars_backfill_job,
    get_bars_backfill_jobs,
    get_bars_backfill_job,
    delete_bars_backfill_job,
    delete_all_bars_backfill_jobs,
    trim_bars_backfill_jobs,
    get_bars_backfill_last_updated,
)
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

DAEMON_LOG_STREAM_KEY = "bifrost:daemon_console"
SERVER_LOG_STREAM_KEY = "bifrost:server_console"


def _daemon_log_redis_url() -> str:
    """Build Redis URL for daemon console stream from config/env. Falls back to local Redis."""
    try:
        from src.app.gs_trading import read_config

        config, _ = read_config()
        r = config.get("redis") or {}
    except Exception as e:
        logger.warning("read_config for daemon console failed: %s; using default Redis URL", e)
        r = {}
    host = (r.get("host") or os.environ.get("REDIS_HOST") or "127.0.0.1").strip()
    port = int(r.get("port") or os.environ.get("REDIS_PORT") or 6379)
    db = int(r.get("db") or os.environ.get("REDIS_DB") or 0)
    password = (r.get("password") or os.environ.get("REDIS_PASSWORD") or "").strip()
    if password:
        return f"redis://:{password}@{host}:{port}/{db}"
    return f"redis://{host}:{port}/{db}"


class IbConfigBody(BaseModel):
    """POST /config/ib 请求体，保证 client_id 被正确解析并写入 DB。"""
    ib_host: Optional[str] = None
    ib_port_type: Optional[str] = None
    ib_client_id_daemon: Optional[int] = None
    ib_client_id_listener: Optional[int] = None
    ib_client_id_account: Optional[int] = None
    ib_client_id_markets: Optional[int] = None
    ib_client_id_worker_market: Optional[int] = None

    class Config:
        extra = "ignore"  # 忽略多余字段，避免解析错误


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

    @app.get("/", response_class=HTMLResponse)
    def get_root() -> str:
        """API only: link to docs and main endpoints. Use project frontend (e.g. npm run dev) for the monitoring UI."""
        return """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>Bifrost Trader API</title></head>
<body style="font-family:system-ui;padding:1rem;">
  <p><strong>Bifrost Trader API</strong> — 本端口仅提供 API，监控页面请使用项目内 frontend（如 <code>cd frontend && npm run dev</code>）。</p>
  <p><a href="/docs">/docs</a> · <a href="/status">/status</a> · <a href="/operations">/operations</a></p>
</body></html>"""

    @app.get("/health")
    def get_health() -> Dict[str, Any]:
        """健康检查：进程存活即可返回 200；返回访问时刻的服务器时间戳（Unix 秒），供前端计算距上次检查时长。"""
        return {"status": "ok", "service": "bifrost-monitor", "ts": time.time()}

    @app.get("/quotes")
    def get_quotes(
        symbols: Optional[str] = Query(None, description="Comma-separated symbols; if omitted, use focus list (positions + watchlist)"),
    ) -> Dict[str, Any]:
        """R-RM*: 从 Redis 读取当前行情缓存（守护进程写入）。无 Redis 或未启用时返回空列表。"""
        rq = getattr(app.state, "redis_quotes", None)
        if rq is None or not getattr(rq, "available", False):
            return {"quotes": [], "message": "实时行情未开启或 Redis 不可用"}
        symbol_list: list[str] = []
        if symbols and symbols.strip():
            symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
        else:
            # Focus list: account positions symbols + watchlist symbols
            accounts = reader.get_accounts_from_tables() or []
            for acc in accounts:
                for pos in (acc.get("positions") or []):
                    sym = (pos.get("symbol") or "").strip()
                    if sym and sym not in symbol_list:
                        symbol_list.append(sym)
            for w in reader.get_watchlist():
                sym = (w.get("symbol") or "").strip()
                if sym and sym not in symbol_list:
                    symbol_list.append(sym)
        if not symbol_list:
            return {"quotes": [], "message": "无关注标的"}
        try:
            quotes = rq.get_quotes(symbol_list)
            return {"quotes": quotes}
        except Exception as e:
            logger.warning("GET /quotes failed: %s", e)
            return {"quotes": [], "message": f"读取行情失败: {e}"}

    @app.get("/quotes/stream")
    async def get_quotes_stream():
        """R-RM* SSE: 订阅 Redis daemon:quotes，守护进程每次更新行情会推送一条 data 事件。无 Redis 时立即返回 503。"""
        rq = getattr(app.state, "redis_quotes", None)
        if rq is None or not getattr(rq, "available", False):
            return JSONResponse(
                status_code=503,
                content={"detail": "实时行情未开启或 Redis 不可用"},
            )
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)

        with app.state.sse_lock:
            app.state.sse_queues.append(queue)

        async def event_gen():
            try:
                while True:
                    try:
                        data = await asyncio.wait_for(queue.get(), timeout=25.0)
                        yield f"data: {json.dumps(data)}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                with app.state.sse_lock:
                    if queue in app.state.sse_queues:
                        app.state.sse_queues.remove(queue)

        return StreamingResponse(
            event_gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    def _celery_log_reader_loop() -> None:
        """Background thread: XREAD Redis stream bifrost:celery_console, push each line to all SSE queues (for Celery console UI)."""
        try:
            import redis
            from servers.celery_app import broker_url, CELERY_LOG_STREAM_KEY
            r = redis.from_url(broker_url)
            last_id = "$"
            while True:
                try:
                    result = r.xread(block=5000, streams={CELERY_LOG_STREAM_KEY: last_id}, count=100)
                    if not result:
                        continue
                    for stream_name, entries in result:
                        for eid, fields in entries:
                            last_id = eid
                            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                            with app.state.celery_log_lock:
                                queues = list(app.state.celery_log_queues)
                            loop = getattr(app.state, "_celery_log_loop", None)
                            for q in queues:
                                if loop and not loop.is_closed():
                                    loop.call_soon_threadsafe(q.put_nowait, line)
                except redis.ConnectionError:
                    time.sleep(2)
                except Exception as e:
                    logger.debug("celery_log_reader_loop: %s", e)
        except Exception as e:
            logger.warning("celery_log_reader_loop exited: %s", e)

    def _daemon_log_reader_loop() -> None:
        """Background thread: XREAD Redis stream bifrost:daemon_console, push each line to all SSE queues (for Daemon console UI)."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            last_id = "$"
            while True:
                try:
                    result = r.xread(block=5000, streams={DAEMON_LOG_STREAM_KEY: last_id}, count=100)
                    if not result:
                        continue
                    for _stream_name, entries in result:
                        for eid, fields in entries:
                            last_id = eid
                            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                            with app.state.daemon_log_lock:
                                queues = list(app.state.daemon_log_queues)
                            loop = getattr(app.state, "_daemon_log_loop", None)
                            for q in queues:
                                if loop and not loop.is_closed():
                                    loop.call_soon_threadsafe(q.put_nowait, line)
                except redis.ConnectionError:
                    time.sleep(2)
                except Exception as e:
                    logger.debug("daemon_log_reader_loop: %s", e)
        except Exception as e:
            logger.warning("daemon_log_reader_loop exited: %s", e)

    def _server_log_reader_loop() -> None:
        """Background thread: XREAD Redis stream bifrost:server_console, push each line to all SSE queues (for Server console UI)."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            last_id = "$"
            while True:
                try:
                    result = r.xread(block=5000, streams={SERVER_LOG_STREAM_KEY: last_id}, count=100)
                    if not result:
                        continue
                    for _stream_name, entries in result:
                        for eid, fields in entries:
                            last_id = eid
                            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                            with app.state.server_log_lock:
                                queues = list(app.state.server_log_queues)
                            loop = getattr(app.state, "_server_log_loop", None)
                            for q in queues:
                                if loop and not loop.is_closed():
                                    loop.call_soon_threadsafe(q.put_nowait, line)
                except redis.ConnectionError:
                    time.sleep(2)
                except Exception as e:
                    logger.debug("server_log_reader_loop: %s", e)
        except Exception as e:
            logger.warning("server_log_reader_loop exited: %s", e)

    @app.get("/api/daemon/logs")
    def get_daemon_logs(
        tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
    ) -> Dict[str, Any]:
        """Return last N lines from daemon console Redis stream (for initial display in System → Daemon Console)."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            raw = r.xrevrange(DAEMON_LOG_STREAM_KEY, count=tail)
            lines = []
            for _eid, fields in reversed(raw):
                line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                lines.append(line)
            return {"lines": lines}
        except Exception as e:
            logger.warning("get_daemon_logs failed: %s", e)
            return {"lines": [], "error": str(e)}

    @app.get("/api/server/logs")
    def get_server_logs(
        tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
    ) -> Dict[str, Any]:
        """Return last N lines from server console Redis stream (for initial display in System → Server Console)."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            raw = r.xrevrange(SERVER_LOG_STREAM_KEY, count=tail)
            lines = []
            for _eid, fields in reversed(raw):
                line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                lines.append(line)
            return {"lines": lines}
        except Exception as e:
            logger.warning("get_server_logs failed: %s", e)
            return {"lines": [], "error": str(e)}

    @app.delete("/api/daemon/logs")
    def clear_daemon_logs() -> Dict[str, Any]:
        """Delete the daemon console Redis stream so next fetch is empty. UI Clear button uses this."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            r.delete(DAEMON_LOG_STREAM_KEY)
            return {"ok": True}
        except Exception as e:
            logger.warning("clear_daemon_logs failed: %s", e)
            return {"ok": False, "error": str(e)}

    @app.delete("/api/server/logs")
    def clear_server_logs() -> Dict[str, Any]:
        """Delete the server console Redis stream so next fetch is empty. UI Clear button uses this."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            r.delete(SERVER_LOG_STREAM_KEY)
            return {"ok": True}
        except Exception as e:
            logger.warning("clear_server_logs failed: %s", e)
            return {"ok": False, "error": str(e)}

    @app.post("/api/daemon/logs/trim")
    def trim_daemon_logs(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """Trim daemon console Redis stream to at most max_lines (keep newest). UI uses this when max lines limit is set or changed."""
        try:
            max_lines = body.get("max_lines")
            if max_lines is None:
                return {"ok": False, "error": "max_lines required"}
            max_lines = int(max_lines)
            if max_lines < 1 or max_lines > 10000:
                return {"ok": False, "error": "max_lines must be between 1 and 10000"}
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            r.xtrim(DAEMON_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
            return {"ok": True}
        except Exception as e:
            logger.warning("trim_daemon_logs failed: %s", e)
            return {"ok": False, "error": str(e)}

    @app.post("/api/server/logs/trim")
    def trim_server_logs(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """Trim server console Redis stream to at most max_lines (keep newest). UI uses this when max lines limit is set or changed."""
        try:
            max_lines = body.get("max_lines")
            if max_lines is None:
                return {"ok": False, "error": "max_lines required"}
            max_lines = int(max_lines)
            if max_lines < 1 or max_lines > 10000:
                return {"ok": False, "error": "max_lines must be between 1 and 10000"}
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            r.xtrim(SERVER_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
            return {"ok": True}
        except Exception as e:
            logger.warning("trim_server_logs failed: %s", e)
            return {"ok": False, "error": str(e)}

    @app.get("/api/daemon/logs/stream")
    async def get_daemon_logs_stream():
        """SSE: stream new daemon console lines in real time (Redis XREAD). Connect after GET /api/daemon/logs for history."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            r.ping()
        except Exception as e:
            logger.warning("daemon_logs_stream check failed: %s", e)
            return JSONResponse(status_code=503, content={"detail": str(e)})

        queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        with app.state.daemon_log_lock:
            app.state.daemon_log_queues.append(queue)
            if app.state._daemon_log_loop is None:
                app.state._daemon_log_loop = asyncio.get_running_loop()
            if app.state._daemon_log_thread is None or not app.state._daemon_log_thread.is_alive():
                app.state._daemon_log_thread = threading.Thread(
                    target=_daemon_log_reader_loop,
                    name="daemon-log-reader",
                    daemon=True,
                )
                app.state._daemon_log_thread.start()

        async def event_gen():
            try:
                while True:
                    try:
                        line = await asyncio.wait_for(queue.get(), timeout=25.0)
                        yield f"data: {json.dumps({'line': line})}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                with app.state.daemon_log_lock:
                    if queue in app.state.daemon_log_queues:
                        app.state.daemon_log_queues.remove(queue)

        return StreamingResponse(
            event_gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/server/logs/stream")
    async def get_server_logs_stream():
        """SSE: stream new server console lines in real time (Redis XREAD). Connect after GET /api/server/logs for history."""
        try:
            import redis

            r = redis.from_url(_daemon_log_redis_url())
            r.ping()
        except Exception as e:
            logger.warning("server_logs_stream check failed: %s", e)
            return JSONResponse(status_code=503, content={"detail": str(e)})

        queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        with app.state.server_log_lock:
            app.state.server_log_queues.append(queue)
            if app.state._server_log_loop is None:
                app.state._server_log_loop = asyncio.get_running_loop()
            if app.state._server_log_thread is None or not app.state._server_log_thread.is_alive():
                app.state._server_log_thread = threading.Thread(
                    target=_server_log_reader_loop,
                    name="server-log-reader",
                    daemon=True,
                )
                app.state._server_log_thread.start()

        async def event_gen():
            try:
                while True:
                    try:
                        line = await asyncio.wait_for(queue.get(), timeout=25.0)
                        yield f"data: {json.dumps({'line': line})}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                with app.state.server_log_lock:
                    if queue in app.state.server_log_queues:
                        app.state.server_log_queues.remove(queue)

        return StreamingResponse(
            event_gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/api/celery/logs")
    def get_celery_logs(
        tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
    ) -> Dict[str, Any]:
        """Return last N lines from Celery console Redis stream (for initial display in System → Celery Console)."""
        try:
            import redis
            from servers.celery_app import broker_url, CELERY_LOG_STREAM_KEY
            r = redis.from_url(broker_url)
            # XREVRANGE + - COUNT tail → newest first; reverse to oldest first for display
            raw = r.xrevrange(CELERY_LOG_STREAM_KEY, count=tail)
            lines = []
            for _eid, fields in reversed(raw):
                line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                lines.append(line)
            return {"lines": lines}
        except Exception as e:
            logger.warning("get_celery_logs failed: %s", e)
            return {"lines": [], "error": str(e)}

    @app.delete("/api/celery/logs")
    def clear_celery_logs() -> Dict[str, Any]:
        """Delete the Celery console Redis stream so next fetch is empty. UI Clear button uses this."""
        try:
            import redis
            from servers.celery_app import broker_url, CELERY_LOG_STREAM_KEY
            r = redis.from_url(broker_url)
            r.delete(CELERY_LOG_STREAM_KEY)
            return {"ok": True}
        except Exception as e:
            logger.warning("clear_celery_logs failed: %s", e)
            return {"ok": False, "error": str(e)}

    @app.post("/api/celery/logs/trim")
    def trim_celery_logs(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """Trim Celery console Redis stream to at most max_lines (keep newest). UI uses this when max lines limit is set or changed."""
        try:
            max_lines = body.get("max_lines")
            if max_lines is None:
                return {"ok": False, "error": "max_lines required"}
            max_lines = int(max_lines)
            if max_lines < 1 or max_lines > 10000:
                return {"ok": False, "error": "max_lines must be between 1 and 10000"}
            import redis
            from servers.celery_app import broker_url, CELERY_LOG_STREAM_KEY
            r = redis.from_url(broker_url)
            r.xtrim(CELERY_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
            return {"ok": True}
        except Exception as e:
            logger.warning("trim_celery_logs failed: %s", e)
            return {"ok": False, "error": str(e)}

    @app.get("/api/celery/logs/stream")
    async def get_celery_logs_stream():
        """SSE: stream new Celery console lines in real time (Redis XREAD). Connect after GET /api/celery/logs for history."""
        try:
            from servers.celery_app import get_celery_broker_connected
            if not get_celery_broker_connected():
                return JSONResponse(
                    status_code=503,
                    content={"detail": "Celery broker (Redis) not available"},
                )
        except Exception as e:
            logger.warning("celery_logs_stream check failed: %s", e)
            return JSONResponse(status_code=503, content={"detail": str(e)})

        queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        with app.state.celery_log_lock:
            app.state.celery_log_queues.append(queue)
            if app.state._celery_log_loop is None:
                app.state._celery_log_loop = asyncio.get_running_loop()
            if app.state._celery_log_thread is None or not app.state._celery_log_thread.is_alive():
                app.state._celery_log_thread = threading.Thread(
                    target=_celery_log_reader_loop,
                    name="celery-log-reader",
                    daemon=True,
                )
                app.state._celery_log_thread.start()

        async def event_gen():
            try:
                while True:
                    try:
                        line = await asyncio.wait_for(queue.get(), timeout=25.0)
                        yield f"data: {json.dumps({'line': line})}\n\n"
                    except asyncio.TimeoutError:
                        yield ": keepalive\n\n"
            except asyncio.CancelledError:
                pass
            finally:
                with app.state.celery_log_lock:
                    if queue in app.state.celery_log_queues:
                        app.state.celery_log_queues.remove(queue)

        return StreamingResponse(
            event_gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-store",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    @app.get("/status")
    def get_status() -> Dict[str, Any]:
        """Return current run status plus self_check, status_lamp, trading_suspended (R-M1b, R-M2, R-M3). Self-check reflects suspended state (degraded + trading_suspended in block_reasons). Never returns 5xx: on read error returns 200 with blocked/red so UI shows reason instead of '获取失败'."""
        try:
            row = reader.get_status_current()
            run_suspended = reader.get_run_status()
            sc = derive_self_check(row, data_lag_threshold_ms, trading_suspended=run_suspended)
            payload: Dict[str, Any] = {
                "self_check": sc["self_check"],
                "block_reasons": sc["block_reasons"],
                "status_lamp": sc["status_lamp"],
                "trading_suspended": run_suspended if run_suspended is not None else False,
            }
            hb = reader.get_daemon_heartbeat()
            if hb is not None:
                now = time.time()
                last_ts = hb.get("last_ts")
                payload["daemon_heartbeat"] = {
                    "last_ts": last_ts,
                    "hedge_running": hb.get("hedge_running", False),
                    "daemon_alive": (last_ts is not None and (now - last_ts) < 35),
                    "ib_connected": hb.get("ib_connected", False),
                    "ib_client_id": hb.get("ib_client_id"),
                    "listener_connected": hb.get("listener_connected", False),
                    "listener_client_id": hb.get("listener_client_id"),
                    "next_retry_ts": hb.get("next_retry_ts"),
                    "seconds_until_retry": hb.get("seconds_until_retry"),
                    "graceful_shutdown_at": hb.get("graceful_shutdown_at"),
                    "heartbeat_interval_sec": hb.get("heartbeat_interval_sec"),
                    "redis_quotes_connected": hb.get("redis_quotes_connected", False),
                    "event_subscribe_ticker": hb.get("event_subscribe_ticker", False),
                    "event_subscribe_positions": hb.get("event_subscribe_positions", False),
                    "event_subscribe_fills": hb.get("event_subscribe_fills", False),
                    "event_subscribe_commission": hb.get("event_subscribe_commission", False),
                }
                dsc = derive_daemon_self_check(payload["daemon_heartbeat"])
                payload["daemon_self_check"] = dsc["daemon_self_check"]
                payload["daemon_lamp"] = dsc["daemon_lamp"]
                payload["daemon_block_reasons"] = dsc["daemon_block_reasons"]
            else:
                payload["daemon_heartbeat"] = None
                dsc = derive_daemon_self_check(None)
                payload["daemon_self_check"] = dsc["daemon_self_check"]
                payload["daemon_lamp"] = dsc["daemon_lamp"]
                payload["daemon_block_reasons"] = dsc["daemon_block_reasons"]
            if row is not None:
                payload["status"] = row
            else:
                payload["status"] = None
            # Subscribed tickers: Watchlist STK + active position symbol (same set daemon subscribes to when RUNNING)
            symbols_set: set = set()
            if row and row.get("symbol"):
                symbols_set.add(str(row.get("symbol", "") or "").strip())
            for w in reader.get_watchlist():
                st = (w.get("sec_type") or "").strip().upper()
                sym = (w.get("symbol") or "").strip()
                if sym and (st == "STK" or not st):
                    symbols_set.add(sym)
            payload["subscribed_tickers"] = sorted(s for s in symbols_set if s)
            # R-A1: 始终从 DB (accounts + account_positions) 读账户并返回
            payload["accounts"] = reader.get_accounts_from_tables()
            if payload["accounts"] is None:
                payload["accounts"] = []
            payload["accounts_fetched_at"] = reader.get_accounts_fetched_at()
            ib_cfg = reader.get_ib_config()
            payload["ib_config"] = ib_cfg if ib_cfg else {
                "ib_host": "127.0.0.1",
                "ib_port_type": "tws_paper",
                "ib_client_id_daemon": 1,
                "ib_client_id_listener": 2,
                "ib_client_id_account": 100,
                "ib_client_id_markets": 101,
                "ib_client_id_worker_market": 500,
            }
            # Monitor-side IB client status for UI.
            try:
                monitor_ib_status: Dict[str, Any] = {}
                acc_client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
                mkt_client: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
                if acc_client is not None:
                    monitor_ib_status["account"] = {
                        "connected": bool(acc_client.connected),
                        "client_id": acc_client.client_id,
                        "last_error": acc_client.last_error,
                    }
                if mkt_client is not None:
                    monitor_ib_status["market"] = {
                        "connected": bool(mkt_client.connected),
                        "client_id": mkt_client.client_id,
                        "last_error": mkt_client.last_error,
                    }
                payload["monitor_ib_status"] = monitor_ib_status or None
            except Exception:  # pragma: no cover - defensive
                payload["monitor_ib_status"] = None
            monitor_enabled = bool(getattr(app.state, "monitor_enabled", True))
            payload["monitor_enabled"] = monitor_enabled
            # 能返回 /status 即表示监控进程存活，与 GET /health 等价
            payload["monitor_health"] = "ok"
            # Derive monitor self-check & lamp (与守护类似，但更轻量）。
            monitor_block_reasons: list[str] = []
            monitor_status_obj = payload.get("monitor_ib_status") or {}
            acc_status = monitor_status_obj.get("account") or {}
            mkt_status = monitor_status_obj.get("market") or {}
            if not monitor_enabled:
                monitor_block_reasons.append("monitor_stopped")
            if acc_status.get("last_error") or mkt_status.get("last_error"):
                monitor_block_reasons.append("monitor_ib_error")
            # 监控健康度：正常/降级/异常
            if not monitor_enabled:
                monitor_self_check = "blocked"
                monitor_lamp = "red"
            elif "monitor_ib_error" in monitor_block_reasons:
                monitor_self_check = "degraded"
                monitor_lamp = "yellow"
            else:
                monitor_self_check = "ok"
                # 若账户 IB 未连上或两侧都未连上，则灯保持黄灯提示关注。
                acc_conn = bool(acc_status.get("connected"))
                mkt_conn = bool(mkt_status.get("connected"))
                if not acc_conn and not mkt_conn:
                    monitor_lamp = "yellow"
                else:
                    monitor_lamp = "green"
            payload["monitor_self_check"] = monitor_self_check
            payload["monitor_lamp"] = monitor_lamp
            payload["monitor_block_reasons"] = monitor_block_reasons
            # Redis 行情：监控端是否能读 Redis（R-RM*）
            rq = getattr(app.state, "redis_quotes", None)
            payload["redis_quotes_connected"] = bool(rq and getattr(rq, "available", False))
            # Celery (bars worker): broker reachable + last job activity + Worker IB status (like Monitor/Daemon)
            try:
                from servers.celery_app import get_celery_broker_connected, get_worker_ib_status, get_celery_workers_ping
                payload["celery_broker_connected"] = get_celery_broker_connected()
                # Short timeout so /status returns quickly when worker is stopped (avoids blocking and UI appearing frozen)
                workers_ping = get_celery_workers_ping(timeout=1.0)
                payload["celery_workers"] = workers_ping
                worker_ib = get_worker_ib_status()
                # 仅当 ping 到有 worker 且 Worker 自报 IB 已连时才算“已连接”；Stop 后进程退出，ping 无响应，UI 即显示已停止（类似 Monitor 的 health 轮询）
                payload["celery_worker_ib_connected"] = bool(
                    worker_ib and worker_ib.get("connected") and len(workers_ping) > 0
                )
                payload["celery_worker_ib_client_id"] = worker_ib.get("client_id") if worker_ib else None
            except Exception:
                payload["celery_broker_connected"] = False
                payload["celery_worker_ib_connected"] = False
                payload["celery_worker_ib_client_id"] = None
                payload["celery_workers"] = []
            payload["celery_worker_last_updated_ts"] = get_bars_backfill_last_updated(control_via_db) if control_via_db else None
            # 系统状态灯：三者都绿才绿，有一个非绿则取最差（红 > 黄 > 绿）
            dl = (payload.get("daemon_lamp") or "red").strip().lower()
            ml = (payload.get("monitor_lamp") or "red").strip().lower()
            sl = (payload.get("status_lamp") or "red").strip().lower()
            if dl == "red" or ml == "red" or sl == "red":
                payload["system_lamp"] = "red"
            elif dl == "yellow" or ml == "yellow" or sl == "yellow":
                payload["system_lamp"] = "yellow"
            else:
                payload["system_lamp"] = "green"
            return payload
        except Exception as e:
            logger.warning("get_status failed: %s", e)
            return {
                "self_check": "blocked",
                "block_reasons": ["status_read_error"],
                "status_lamp": "red",
                "trading_suspended": False,
                "daemon_heartbeat": None,
                "daemon_self_check": "blocked",
                "daemon_lamp": "red",
                "daemon_block_reasons": ["status_read_error"],
                "status": None,
                "accounts": None,
                "accounts_fetched_at": None,
                "ib_config": {
                    "ib_host": "127.0.0.1",
                    "ib_port_type": "tws_paper",
                    "ib_client_id_daemon": 1,
                    "ib_client_id_listener": 2,
                    "ib_client_id_account": 100,
                    "ib_client_id_markets": 101,
                    "ib_client_id_worker_market": 500,
                },
                "monitor_ib_status": None,
                "monitor_enabled": False,
                "monitor_health": "ok",
                "monitor_self_check": "blocked",
                "monitor_lamp": "red",
                "monitor_block_reasons": ["status_read_error"],
                "redis_quotes_connected": False,
                "celery_broker_connected": False,
                "celery_worker_ib_connected": False,
                "celery_worker_ib_client_id": None,
                "celery_workers": [],
                "celery_worker_last_updated_ts": None,
                "system_lamp": "red",
            }

    @app.get("/operations")
    def get_operations(
        since_ts: Optional[float] = Query(None, description="Filter operations with ts >= this"),
        until_ts: Optional[float] = Query(None, description="Filter operations with ts <= this"),
        operation_type: Optional[str] = Query(None, alias="type", description="Filter by type (hedge_intent, order_sent, fill, reject, cancel)"),
        limit: int = Query(100, ge=1, le=1000),
    ) -> Dict[str, Any]:
        """Return operations list with optional filters (R-M4b)."""
        items = reader.get_operations(since_ts=since_ts, until_ts=until_ts, type_filter=operation_type, limit=limit)
        return {"operations": items}

    @app.get("/risk_summary")
    def get_risk_summary() -> Dict[str, Any]:
        """Return risk/post-mortem summary for 复盘与风控 page (R-M7): daily_hedge_count, daily_pnl, operations_count_24h, etc."""
        return reader.get_risk_summary()

    @app.get("/executions")
    def get_executions(
        since_ts: Optional[float] = Query(None, description="Filter executions with time >= this (Unix s)"),
        until_ts: Optional[float] = Query(None, description="Filter executions with time <= this"),
        account_id: Optional[str] = Query(None, description="Filter by account ID"),
        limit: int = Query(200, ge=0, le=10000, description="Max rows to return; 0 = no limit"),
        include_opt_pairs: bool = Query(False, description="Include C↔P pairing: each execution gets paired_execution_ids, response includes opt_pairs"),
    ) -> Dict[str, Any]:
        """Account-level executions/trades (R-A2). Reads from account_executions table (daemon syncs from IB). Each item includes id for edit.
        If include_opt_pairs=true: backend finds pairs (same symbol, expiry, strike, account_id; option_right C↔P), returns executions with paired_execution_ids and opt_pairs list."""
        effective_limit: Optional[int] = limit if limit > 0 else None
        if include_opt_pairs:
            return reader.get_executions_with_opt_pairs(
                since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=effective_limit or 5000
            )
        items = reader.get_executions(since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=effective_limit)
        return {"executions": items}

    @app.get("/performance")
    def get_performance(
        since_ts: Optional[float] = Query(None, description="Filter trades with time >= this (Unix s)"),
        until_ts: Optional[float] = Query(None, description="Filter trades with time <= this"),
        account_id: Optional[str] = Query(None, description="Filter by account ID"),
        granularity: str = Query("day", description="Calendar bucket: day | week | month"),
    ) -> Dict[str, Any]:
        """Performance stats and calendar PnL from account_executions (PERFORMANCE_PAGE_DESIGN)."""
        return reader.get_performance_stats(
            since_ts=since_ts,
            until_ts=until_ts,
            account_id=account_id,
            granularity=granularity,
        )

    @app.post("/executions")
    def post_execution(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """R-A2 扩展：手动添加一条执行记录（历史补录）。body: account_id, time(Unix s), symbol, sec_type, side, quantity, price；可选 source, exec_id, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, commission, realized_pnl, currency。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。", "id": None}
        new_id = insert_one_execution(control_via_db, body)
        if new_id is None:
            return {"ok": False, "error": "添加执行记录失败（请检查必填项：symbol, quantity, price）。", "id": None}
        return {"ok": True, "id": new_id, "message": "已添加一条执行记录。"}

    @app.put("/executions/{execution_id:int}")
    def put_execution(execution_id: int, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """R-A2 扩展：按 id 更新一条执行记录（手动修正）。body 可含任意子集：time, symbol, sec_type, side, quantity, price, account_id, source, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, commission, realized_pnl, currency。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。"}
        if update_one_execution(control_via_db, execution_id, body):
            return {"ok": True, "message": "已更新执行记录。"}
        return {"ok": False, "error": "更新失败（id 不存在或数据库错误）。"}

    @app.delete("/executions/{execution_id:int}")
    def delete_execution(execution_id: int) -> Dict[str, Any]:
        """R-A2 扩展：按 id 删除一条执行记录（逐笔操作）。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。"}
        if delete_one_execution(control_via_db, execution_id):
            return {"ok": True, "message": "已删除该条执行记录。"}
        return {"ok": False, "error": "删除失败（id 不存在或数据库错误）。"}

    @app.get("/bars")
    def get_bars(
        symbol: Optional[str] = Query(None, description="Symbol, e.g. NVDA"),
        period: Optional[str] = Query("1 D", description="Bar period (e.g. 1 min, 1 D)"),
        limit: int = Query(100, ge=1, le=500),
    ) -> Dict[str, Any]:
        """K-line/OHLC bars for replay (R-A3). Reads from stock_day (1 D) or stock_min (1 min, 5 mins, 1 hour); requires symbol."""
        sym = (symbol or "").strip()
        if not sym:
            return {"bars": [], "message": "请提供 symbol 参数。"}
        per = (period or "1 D").strip()
        items = reader.get_bars(symbol=sym, period=per, limit=limit)
        # API 返回 time, open, high, low, close, volume 与前端 Bar 一致
        bars = [
            {
                "time": float(r["time"]) if r.get("time") is not None else 0,
                "open": float(r["open"]) if r.get("open") is not None else 0,
                "high": float(r["high"]) if r.get("high") is not None else 0,
                "low": float(r["low"]) if r.get("low") is not None else 0,
                "close": float(r["close"]) if r.get("close") is not None else 0,
                "volume": float(r["volume"]) if r.get("volume") is not None else 0,
            }
            for r in items
        ]
        return {"bars": bars}

    @app.get("/bars/latest")
    def get_bars_latest(
        symbol: Optional[str] = Query(None, description="Symbol"),
        period: Optional[str] = Query("1 D", description="Bar period"),
    ) -> Dict[str, Any]:
        """Return latest bar time (Unix) for symbol+period; for smart duration (first load full, then request from latest)."""
        sym = (symbol or "").strip()
        if not sym:
            return {"latest": None, "message": "请提供 symbol 参数。"}
        per = (period or "1 D").strip()
        t = reader.get_bars_latest(symbol=sym, period=per)
        return {"latest": t}

    @app.get("/bars/benchmark")
    def get_bars_benchmark(
        symbols: Optional[str] = Query(None, description="Comma-separated symbols"),
        date_str: Optional[str] = Query(None, alias="date", description="YYYY-MM-DD; default today"),
    ) -> Dict[str, Any]:
        """Return latest daily bar on or before date per symbol (for Daily % / Daily $).
        Keys: symbol -> { bar_time, close, prev_close?, is_today, is_stale }.
        When is_today=True, frontend should compare instrument_prices.last vs prev_close.
        When is_today=False, frontend should compare instrument_prices.last vs close."""
        if not symbols or not str(symbols).strip():
            return {"benchmarks": {}}
        sym_list = [s.strip() for s in str(symbols).split(",") if s and s.strip()]
        ref = date.today()
        if date_str and str(date_str).strip():
            try:
                ref = datetime.strptime(str(date_str).strip()[:10], "%Y-%m-%d").date()
            except ValueError:
                pass
        result = reader.get_bars_benchmark(symbols=sym_list, on_or_before=ref)
        # Add is_stale: (ref - bar_date) > 1 day
        out = {}
        for sym, ent in result.items():
            bar_time = ent.get("bar_time") or 0
            try:
                bar_date = datetime.fromtimestamp(bar_time).date()
            except (TypeError, ValueError, OSError):
                bar_date = ref
            is_today = (ref - bar_date).days == 0
            is_stale = (ref - bar_date).days > 1
            out[sym] = {**ent, "is_today": is_today, "is_stale": is_stale}
        return {"benchmarks": out}

    @app.get("/bars/stats")
    def get_bars_stats(
        symbol: Optional[str] = Query(None, description="Symbol, e.g. NVDA"),
    ) -> Dict[str, Any]:
        """返回指定标的在 stock_day / stock_min 中的行数，供市场数据页「分析」按钮使用。"""
        sym = (symbol or "").strip()
        if not sym:
            return {"stock_day": 0, "stock_min": {}, "message": "请提供 symbol 参数。"}
        stats = reader.get_bars_stats(symbol=sym)
        return stats

    def _get_watchlist_stock_symbols() -> List[str]:
        """Return unique stock symbols from Watchlist in insertion order."""
        watchlist = reader.get_watchlist()
        sym_list: List[str] = []
        for w in watchlist:
            sec = (w.get("sec_type") or "STK").strip().upper()
            if sec == "OPT":
                continue
            sym = (w.get("symbol") or "").strip()
            if not sym and w.get("contract_key"):
                parts = (w["contract_key"] or "").split("|")
                sym = (parts[0] or "").strip() if parts else ""
            if sym:
                sym_list.append(sym.upper())
        return list(dict.fromkeys(sym_list))

    @app.get("/bars/coverage")
    def get_bars_coverage(
        symbols: Optional[str] = Query(None, description="Comma-separated symbols; if omitted, use Watchlist stocks"),
    ) -> Dict[str, Any]:
        """Return coverage (count, min/max ts) plus target range from config and status: ok | gap_end | missing (only end gap is checked)."""
        if symbols is not None and str(symbols).strip():
            sym_list = [s.strip() for s in str(symbols).split(",") if s and s.strip()]
        else:
            sym_list = _get_watchlist_stock_symbols()
        coverage = reader.get_bars_coverage(symbols=sym_list)

        try:
            from src.app.gs_trading import read_config
            config, _ = read_config()
        except Exception:
            config = {}
        hb = (config.get("history_backfill") or {}).get("stock") or {}
        daily_years = float(hb.get("daily_years", 10.0))
        min_weeks = float(hb.get("min_weeks", 1.0))
        five_min_months = float(hb.get("5min_months", 1.0))
        one_hour_months = float(hb.get("1hour_months", 3.0))
        policy = {"daily_years": daily_years, "min_weeks": min_weeks, "5min_months": five_min_months, "1hour_months": one_hour_months}

        now_ts = time.time()
        one_day = 86400.0
        target_end_ts = now_ts
        target_daily_start = now_ts - (365 * daily_years * one_day)
        target_min_start = now_ts - (7 * min_weeks * one_day)
        target_5min_start = now_ts - (30 * five_min_months * one_day)
        target_1hour_start = now_ts - (30 * one_hour_months * one_day)

        enriched = []
        for item in coverage:
            day = item.get("stock_day") or {}
            day_ts_s = day.get("min_ts")
            day_ts_e = day.get("max_ts")
            day_cnt = day.get("count") or 0
            day_status = _coverage_status(day_ts_s, day_ts_e, day_cnt, target_daily_start, target_end_ts)
            stock_day_enriched = {
                **day,
                "target_start_ts": target_daily_start,
                "target_end_ts": target_end_ts,
                "status": day_status,
            }
            mins = item.get("stock_min") or {}
            min_1 = mins.get("1 min") or {}
            min_5 = mins.get("5 mins") or {}
            min_1h = mins.get("1 hour") or {}
            stock_min_enriched = {
                "1 min": {
                    **min_1,
                    "target_start_ts": target_min_start,
                    "target_end_ts": target_end_ts,
                    "status": _coverage_status(
                        min_1.get("min_ts"), min_1.get("max_ts"), min_1.get("count") or 0,
                        target_min_start, target_end_ts,
                    ),
                },
                "5 mins": {
                    **min_5,
                    "target_start_ts": target_5min_start,
                    "target_end_ts": target_end_ts,
                    "status": _coverage_status(
                        min_5.get("min_ts"), min_5.get("max_ts"), min_5.get("count") or 0,
                        target_5min_start, target_end_ts,
                    ),
                },
                "1 hour": {
                    **min_1h,
                    "target_start_ts": target_1hour_start,
                    "target_end_ts": target_end_ts,
                    "status": _coverage_status(
                        min_1h.get("min_ts"), min_1h.get("max_ts"), min_1h.get("count") or 0,
                        target_1hour_start, target_end_ts,
                    ),
                },
            }
            enriched.append({
                "symbol": item.get("symbol"),
                "stock_day": stock_day_enriched,
                "stock_min": stock_min_enriched,
            })
        return {"coverage": enriched, "policy": policy}

    class DeleteBarsBody(BaseModel):
        periods: Optional[List[str]] = None  # e.g. ["1 D", "1 min"]; omit or empty = delete all

    @app.delete("/bars/symbol")
    def delete_bars_for_symbol(
        symbol: Optional[str] = Query(..., description="Symbol to delete bars for"),
        body: Optional[DeleteBarsBody] = Body(None, description="Optional: periods to delete (1 D, 1 min, 5 mins, 1 hour). Omit to delete all."),
    ) -> Dict[str, Any]:
        """Delete stock_day and/or stock_min rows for the given symbol. body.periods: optional list; omit or empty to delete all."""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以删除 K 线数据。"}
        sym = (symbol or "").strip().upper()
        if not sym:
            return {"ok": False, "error": "请提供 symbol 参数。"}
        period_list = None
        if body and body.periods and len(body.periods) > 0:
            period_list = [p.strip() for p in body.periods if (p or "").strip()]
        result = delete_stock_bars_for_symbol(control_via_db, sym, periods=period_list)
        if result.get("ok"):
            return {
                "ok": True,
                "deleted_day": result.get("deleted_day", 0),
                "deleted_min": result.get("deleted_min", 0),
                "message": f"已删除 {sym} 的选定周期记录，可重新 Pull。",
            }
        return {"ok": False, "error": result.get("error", "删除失败")}

    @app.get("/watchlist")
    def get_watchlist() -> Dict[str, Any]:
        """R-A3 扩展：返回 Watchlist 列表（自选/待操作标的）。"""
        items = reader.get_watchlist()
        return {"items": items}

    class WatchlistBody(BaseModel):
        contract_key: str
        symbol: Optional[str] = None
        sec_type: Optional[str] = None
        expiry: Optional[str] = None
        strike: Optional[float] = None
        option_right: Optional[str] = None
        display_label: Optional[str] = None
        source: Optional[str] = None

    @app.post("/watchlist")
    def post_watchlist(body: WatchlistBody = Body(...)) -> Dict[str, Any]:
        """R-A3 扩展：添加或更新 Watchlist 项（按 contract_key 唯一）。"""
        if not control_via_db:
            logger.info("POST /watchlist rejected: 需要 postgres 配置以写入 watchlist")
            return {"ok": False, "error": "需要 postgres 配置以写入 watchlist。"}
        ok = reader.add_watchlist(
            contract_key=body.contract_key,
            symbol=body.symbol,
            sec_type=body.sec_type,
            expiry=body.expiry,
            strike=body.strike,
            option_right=body.option_right,
            display_label=body.display_label,
            source=body.source or "manual",
        )
        if ok:
            return {"ok": True, "message": "已添加或更新 Watchlist 项。"}
        logger.warning("POST /watchlist 写入失败")
        return {"ok": False, "error": "写入 watchlist 失败。"}

    @app.delete("/watchlist")
    def delete_watchlist(
        contract_key: Optional[str] = Query(None, description="Delete by contract_key"),
        id: Optional[int] = Query(None, description="Delete by id"),
    ) -> Dict[str, Any]:
        """R-A3 扩展：删除一条 Watchlist 项（传 contract_key 或 id 之一）。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以修改 watchlist。"}
        if contract_key is None and id is None:
            return {"ok": False, "error": "请提供 contract_key 或 id 参数。"}
        if reader.delete_watchlist(contract_key=contract_key, id_=id):
            return {"ok": True, "message": "已删除。"}
        return {"ok": False, "error": "删除失败（未找到或数据库错误）。"}

    # Position categories (STK tagging for tracking by category: dividend, short-term, etc.)
    @app.get("/position-categories")
    def get_position_categories() -> Dict[str, Any]:
        """Return all position categories for dropdown and manage UI."""
        items = reader.get_position_categories()
        return {"items": items}

    class PositionCategoryCreateBody(BaseModel):
        name: str
        description: Optional[str] = None
        sort_order: Optional[int] = None

    @app.post("/position-categories")
    def post_position_category(body: PositionCategoryCreateBody = Body(...)) -> Dict[str, Any]:
        """Create a position category."""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 position_categories。"}
        cid = reader.create_position_category(
            name=body.name,
            description=body.description,
            sort_order=body.sort_order,
        )
        if cid is not None:
            return {"ok": True, "id": cid, "message": "Category created."}
        return {"ok": False, "error": "Failed to create category."}

    class PositionCategoryUpdateBody(BaseModel):
        name: Optional[str] = None
        description: Optional[str] = None
        sort_order: Optional[int] = None

    @app.patch("/position-categories/{category_id:int}")
    def patch_position_category(category_id: int, body: PositionCategoryUpdateBody = Body(...)) -> Dict[str, Any]:
        """Update a position category."""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以修改 position_categories。"}
        if reader.update_position_category(
            category_id=category_id,
            name=body.name,
            description=body.description,
            sort_order=body.sort_order,
        ):
            return {"ok": True, "message": "Category updated."}
        return {"ok": False, "error": "Update failed."}

    @app.delete("/position-categories/{category_id:int}")
    def delete_position_category_route(category_id: int) -> Dict[str, Any]:
        """Delete a position category (tags referencing it are removed)."""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以修改 position_categories。"}
        if reader.delete_position_category(category_id):
            return {"ok": True, "message": "Category deleted."}
        return {"ok": False, "error": "Delete failed."}

    class PositionCategoryTagBody(BaseModel):
        account_id: str
        contract_key: str
        category_id: Optional[int] = None  # null to clear tag

    @app.put("/position-categories/tag")
    def put_position_category_tag(body: PositionCategoryTagBody = Body(...)) -> Dict[str, Any]:
        """Set or clear category tag for a position (STK). category_id null => clear tag."""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以修改 position_category_tags。"}
        if reader.set_position_category_tag(
            account_id=body.account_id,
            contract_key=body.contract_key,
            category_id=body.category_id,
        ):
            return {"ok": True, "message": "Tag updated."}
        return {"ok": False, "error": "Failed to update tag."}

    # R-A3: 复盘 K 线由 API 直接连 IB 拉取并写库，不经过 daemon（历史数据一次性拉取更合适）
    # R-A2: 执行记录同样支持 API 直接连 IB 拉取并写库，无需 daemon
    _IB_PORT_MAP = {"tws_live": 7496, "tws_paper": 7497, "gateway": 4002}

    @app.post("/executions/fetch")
    async def post_executions_fetch(
        days: int = Query(1, ge=1, le=7, description="拉取范围：1=当天, 3=最近3天, 7=最近7天（需 TWS Trade Log 勾选对应天数）"),
    ) -> Dict[str, Any]:
        """R-A2: 通过监控端 AccountIbClient 拉取执行/成交记录并写入 account_executions。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。", "count": 0}
        if not getattr(app.state, "monitor_enabled", True):
            return {"ok": False, "error": "监控已停止，无法拉取执行记录。", "count": 0}
        client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
        if client is None:
            return {"ok": False, "error": "监控端 AccountIbClient 未初始化。", "count": 0}
        try:
            await client.ensure_connected()
        except Exception as e:
            return {"ok": False, "error": f"连接 IB 失败：{e}", "count": 0}

        # 收到 commissionReport 事件时直接按 exec_id 更新 DB（仅 live 成交会触发；历史仍靠 get_executions_async 合并）
        await client.set_commission_report_callback(
            lambda eid, c, pnl, cur, y_, yrd: update_execution_commission(
                control_via_db, eid, c, pnl, cur, y_, yrd
            )
        )
        try:
            all_execs = await client.fetch_executions(days=days)
        finally:
            try:
                await client.set_commission_report_callback(None)
            except Exception:
                pass
        if not all_execs:
            return {
                "ok": True,
                "message": f"IB 未返回执行记录（当前范围：最近{days}天；若选多天请确认 TWS Trade Log 已勾选对应天数）。",
                "count": 0,
            }
        if not write_account_executions_to_db(control_via_db, all_execs):
            return {"ok": False, "error": "写入 account_executions 失败。", "count": 0}
        return {"ok": True, "count": len(all_execs), "message": f"已写入 {len(all_execs)} 条执行记录。"}

    @app.post("/bars/fetch")
    async def post_bars_fetch(
        symbol: Optional[str] = Query(..., description="Symbol, e.g. NVDA"),
        period: Optional[str] = Query("1 D", description="Bar period (e.g. 1 D, 1 min)"),
        duration: Optional[str] = Query("30 D", description="IB durationStr (e.g. 30 D, 5 D)；smart_duration 为 true 时可能被覆盖"),
        smart_duration: bool = Query(False, description="为 true 时根据最新一根 K 线距今天数计算 duration"),
    ) -> Dict[str, Any]:
        """R-A3: 通过监控端 MarketIbClient 拉取 K 线并写入 stock_day/stock_min，返回拉取的 bars。"""
        sym = (symbol or "").strip()
        if not sym:
            return {"ok": False, "error": "请提供 symbol 参数。", "bars": [], "count": 0}
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 K 线表。", "bars": [], "count": 0}
        if not getattr(app.state, "monitor_enabled", True):
            return {"ok": False, "error": "监控已停止，无法拉取 K 线。", "bars": [], "count": 0}
        client: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
        if client is None:
            return {"ok": False, "error": "监控端 MarketIbClient 未初始化。", "bars": [], "count": 0}
        per = (period or "1 D").strip()
        dur = (duration or "30 D").strip()
        # IB step size: 1 min bar 仅支持 duration 1 D（见 docs/IB_MARKET_DATA_BOUNDARIES.md）
        if per.lower() in ("1 min", "1min"):
            dur = "1 D"
        if smart_duration:
            latest_ts = reader.get_bars_latest(symbol=sym, period=per)
            if latest_ts is not None:
                from datetime import datetime, timezone
                now = datetime.now(tz=timezone.utc).timestamp()
                gap_sec = max(0, now - latest_ts)
                if per.upper() == "1 D":
                    gap_days = min(max(1, int(gap_sec / 86400) + 1), 720)
                    dur = f"{gap_days} D"
                elif per.lower() in ("1 min", "1min"):
                    dur = "1 D"  # IB: 1 min bar 仅支持 1 D duration
                else:
                    gap_days = min(max(1, int(gap_sec / 86400) + 1), 7)
                    dur = f"{gap_days} D"

        try:
            await client.ensure_connected()
        except Exception as e:
            return {"ok": False, "error": f"连接 IB 失败：{e}", "bars": [], "count": 0}

        raw = await client.fetch_bars(sym, per, dur)
        if not raw:
            return {"ok": True, "message": "IB 未返回 K 线数据。", "bars": [], "count": 0}
        rows = [dict(b, symbol=sym, period=per) for b in raw]
        if not write_ohlc_bars_to_db(control_via_db, rows):
            return {"ok": False, "error": "写入 K 线表失败。", "bars": [], "count": 0}
        bars = [
            {
                "time": float(b.get("bar_time") or 0),
                "open": float(b.get("open") or 0),
                "high": float(b.get("high") or 0),
                "low": float(b.get("low") or 0),
                "close": float(b.get("close") or 0),
                "volume": float(b.get("volume") or 0),
            }
            for b in raw
        ]
        return {"ok": True, "count": len(bars), "bars": bars}

    _TOLERANCE_END_SEC = 2 * 86400

    def _coverage_status(
        min_ts: Optional[float],
        max_ts: Optional[float],
        count: int,
        target_start_ts: float,
        target_end_ts: float,
    ) -> str:
        """Return ok | gap_end | missing. Only end gap is checked (no start check)."""
        if count == 0:
            return "missing"
        gap_end = max_ts is None or max_ts < target_end_ts - _TOLERANCE_END_SEC
        if gap_end:
            return "gap_end"
        return "ok"

    def _job_row_to_api(j: Dict[str, Any]) -> Dict[str, Any]:
        """Map DB row (id, created_at, updated_at, ...) to API shape (job_id, created_ts, updated_ts, ...)."""
        created_ts = j.get("created_at")
        if hasattr(created_ts, "timestamp"):
            created_ts = created_ts.timestamp()
        updated_ts = j.get("updated_at")
        if hasattr(updated_ts, "timestamp"):
            updated_ts = updated_ts.timestamp()
        return {
            "job_id": str(j.get("id", "")),
            "type": "backfill",
            "symbol": j.get("symbol"),
            "period": j.get("period"),
            "years": j.get("years"),
            "days": j.get("days"),
            "override_days": j.get("override_days"),
            "status": j.get("status"),
            "result": j.get("result"),
            "created_ts": created_ts,
            "updated_ts": updated_ts,
        }

    def _enqueue_bars_backfill_job(
        symbol: str,
        period: str,
        *,
        years: Optional[float] = None,
        days: Optional[int] = None,
        override_days: Optional[float] = None,
        span_hours: Optional[float] = None,
        is_test: bool = False,
        api_interval_sec: int = 10,
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """Insert one bars backfill job and enqueue the matching Celery task."""
        jid = insert_bars_backfill_job(
            control_via_db,
            symbol,
            period,
            years,
            days,
            override_days,
            span_hours=span_hours,
            skip_ib=is_test,
            api_interval_sec=api_interval_sec,
        )
        if jid is None:
            return False, None, "入队失败。"
        logger.info(
            "bars/backfill enqueue job_id=%s symbol=%s period=%s years=%s days=%s override_days=%s span_hours=%s",
            jid, symbol, period, years, days, override_days, span_hours,
        )
        try:
            from servers.bars_tasks import backfill_bars

            backfill_bars.apply_async(
                args=[symbol, period],
                kwargs={"years": years, "days": days, "override_days": override_days, "span_hours": span_hours},
                task_id=str(jid),
            )
        except Exception as e:
            logger.exception("Celery enqueue failed: %s", e)
            from servers.reader import update_bars_backfill_job_result

            update_bars_backfill_job_result(control_via_db, jid, "failed", {"ok": False, "error": str(e)})
            return False, None, f"Celery 入队失败: {e}"
        return True, str(jid), None

    _WATCHLIST_EOD_PERIODS = ["1 D", "1 hour", "5 mins", "1 min"]

    @app.post("/bars/watchlist/eod-refresh/preview")
    async def post_watchlist_eod_refresh_preview(
        override_days: float = Query(1.0, ge=0, le=7, description="Re-fetch this many days before latest bar to preview overwrite/fill scope."),
        api_interval_sec: int = Query(10, ge=0, le=300, description="Seconds to wait between each IB API request (chunk). Echoed in preview."),
    ) -> Dict[str, Any]:
        """Preview EOD refresh without enqueuing jobs."""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以读取 K 线表与 Watchlist。"}

        from servers.bars_backfill import build_backfill_preview

        symbols = _get_watchlist_stock_symbols()
        periods = _WATCHLIST_EOD_PERIODS
        items: List[Dict[str, Any]] = []
        failures: List[Dict[str, str]] = []
        total_override_records = 0
        total_request_chunks = 0
        for sym in symbols:
            for per in periods:
                item = build_backfill_preview(
                    reader,
                    sym,
                    per,
                    override_days=override_days,
                )
                if item.get("ok") is False:
                    failures.append({"symbol": sym, "period": per, "error": item.get("error", "Preview failed")})
                    continue
                item["api_interval_sec"] = api_interval_sec
                items.append(item)
                total_override_records += int(((item.get("override_records") or {}).get("count")) or 0)
                total_request_chunks += len(item.get("ib_request_plan") or [])

        return {
            "ok": True,
            "preview_only": True,
            "ready_to_enqueue": bool(getattr(app.state, "monitor_enabled", True)),
            "symbols_count": len(symbols),
            "queued_jobs_if_confirmed": len(symbols) * len(periods),
            "override_days": override_days,
            "api_interval_sec": api_interval_sec,
            "periods": periods,
            "symbols": symbols,
            "items": items,
            "total_override_records": total_override_records,
            "total_request_chunks": total_request_chunks,
            "failed_count": len(failures),
            "failures": failures,
            "message": (
                f"Dry run ready: {len(items)} preview item(s), "
                f"{total_override_records} existing record(s) may be overwritten, "
                f"{total_request_chunks} IB request chunk(s)."
            ),
        }

    @app.post("/bars/backfill")
    async def post_bars_backfill(
        symbol: Optional[str] = Query(..., description="Symbol, e.g. NVDA"),
        period: Optional[str] = Query("1 D", description="Bar period: 1 D | 1 min | 5 mins | 1 hour"),
        years: Optional[float] = Query(None, description="Span in years (only when symbol has no data)"),
        days: Optional[int] = Query(None, description="Span in days (only when symbol has no data)"),
        override_days: Optional[float] = Query(None, description="When symbol has data: re-fetch this many days before latest bar and overwrite for final values; 0 = strict incremental"),
        span_hours: Optional[float] = Query(None, description="Span in hours (only when symbol has no data; overrides years/days for sub-day range, e.g. 1 for 1 hour)"),
        queue: bool = Query(True, description="Must be true; backfill runs only via Celery Worker (IB rate limits)."),
        is_test: bool = Query(False, description="If true, skip IB fetch (test mode; only log planned requests). Default off."),
        api_interval_sec: int = Query(10, ge=0, le=300, description="Seconds to wait between each IB API request (chunk). Default 10."),
    ) -> Dict[str, Any]:
        """Backfill: enqueue job to Celery Worker only. Synchronous (queue=false) path removed to avoid IB rate limits from API process."""
        sym = (symbol or "").strip().upper()
        if not sym:
            return {"ok": False, "error": "请提供 symbol 参数。", "count": 0}
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 K 线表。", "count": 0}
        if not getattr(app.state, "monitor_enabled", True):
            return {"ok": False, "error": "监控已停止，无法补全 K 线。", "count": 0}
        per = (period or "1 D").strip()

        if not queue:
            return {
                "ok": False,
                "error": "Backfill 仅支持 queue=true，由 Celery Worker 在后台拉取（IB 速率限制）。",
                "count": 0,
            }
        ok, job_id, error = _enqueue_bars_backfill_job(
            sym,
            per,
            years=years,
            days=days,
            override_days=override_days,
            span_hours=span_hours,
            is_test=is_test,
            api_interval_sec=api_interval_sec,
        )
        if not ok or not job_id:
            return {"ok": False, "error": error or "入队失败。", "count": 0}
        trim_bars_backfill_jobs(control_via_db, keep=200)
        return {"ok": True, "job_id": job_id, "message": "Queued (Celery). Poll GET /bars/jobs/{job_id} for status."}

    @app.post("/bars/watchlist/eod-refresh")
    async def post_watchlist_eod_refresh(
        override_days: float = Query(1.0, ge=0, le=7, description="Re-fetch this many days before latest bar to overwrite the last bars with final close data."),
        is_test: bool = Query(False, description="If true, skip IB fetch (test mode; only log planned requests). Default off."),
        api_interval_sec: int = Query(10, ge=0, le=300, description="Seconds to wait between each IB API request (chunk). Default 10."),
    ) -> Dict[str, Any]:
        """Queue end-of-day refresh for every Watchlist stock and all coverage periods."""
        if not control_via_db:
            return {"ok": False, "error": "需要 postgres 配置以写入 K 线表。", "queued_count": 0}
        if not getattr(app.state, "monitor_enabled", True):
            return {"ok": False, "error": "监控已停止，无法补全 K 线。", "queued_count": 0}

        symbols = _get_watchlist_stock_symbols()
        periods = _WATCHLIST_EOD_PERIODS
        if not symbols:
            return {
                "ok": True,
                "queued_count": 0,
                "failed_count": 0,
                "symbols_count": 0,
                "symbols": [],
                "periods": periods,
                "override_days": override_days,
                "message": "Watchlist 中没有股票 symbol，无需执行收盘刷新。",
            }

        queued_jobs: List[Dict[str, str]] = []
        failures: List[Dict[str, str]] = []
        for sym in symbols:
            for per in periods:
                ok, job_id, error = _enqueue_bars_backfill_job(
                    sym,
                    per,
                    override_days=override_days,
                    is_test=is_test,
                    api_interval_sec=api_interval_sec,
                )
                if ok and job_id:
                    queued_jobs.append({"job_id": job_id, "symbol": sym, "period": per})
                else:
                    failures.append({"symbol": sym, "period": per, "error": error or "入队失败。"})

        trim_bars_backfill_jobs(control_via_db, keep=200)
        queued_count = len(queued_jobs)
        failed_count = len(failures)
        if queued_count == 0:
            return {
                "ok": False,
                "error": "收盘刷新任务入队失败。",
                "queued_count": 0,
                "failed_count": failed_count,
                "symbols_count": len(symbols),
                "symbols": symbols,
                "periods": periods,
                "override_days": override_days,
                "failures": failures,
            }

        message = (
            f"Queued {queued_count} EOD refresh job(s) for {len(symbols)} watchlist symbol(s). "
            f"override_days={override_days:g}."
        )
        if failed_count > 0:
            message += f" Failed: {failed_count}."
        return {
            "ok": True,
            "message": message,
            "queued_count": queued_count,
            "failed_count": failed_count,
            "symbols_count": len(symbols),
            "symbols": symbols,
            "periods": periods,
            "override_days": override_days,
            "queued_jobs": queued_jobs,
            "failures": failures,
        }

    @app.get("/bars/jobs")
    def get_bars_jobs(
        limit: int = Query(20, ge=0, le=500, description="Page size; 0 = return up to 500 (no pagination)"),
        offset: int = Query(0, ge=0, description="Offset for pagination"),
        status: Optional[str] = Query(None, description="Filter by status: pending, running, done, failed"),
    ) -> Dict[str, Any]:
        """List backfill jobs with pagination and optional status filter. Uses control_via_db or status_cfg_for_read so that jobs are returned whenever Postgres is configured (config or PGHOST)."""
        db_config = control_via_db or status_cfg_for_read
        if not db_config:
            logger.info("GET /bars/jobs: no Postgres config (control_via_db and status_cfg_for_read both None), returning empty list")
            return {"jobs": [], "total": 0, "error": "No Postgres config. Set postgres in config or PGHOST."}
        # When limit=0 (e.g. old client or "get all"), return up to 500
        effective_limit = limit if limit and limit > 0 else 500
        try:
            rows, total = get_bars_backfill_jobs(db_config, limit=effective_limit, offset=offset, status=status)
        except Exception as e:
            logger.warning("GET /bars/jobs: get_bars_backfill_jobs failed: %s", e)
            return {"jobs": [], "total": 0, "error": str(e)}
        list_jobs = [_job_row_to_api(r) for r in rows]
        logger.info("GET /bars/jobs: returning %d jobs, total=%d (limit=%s, offset=%s)", len(list_jobs), total, effective_limit, offset)
        return {"jobs": list_jobs, "total": total}

    @app.get("/bars/jobs/{job_id}")
    def get_bars_job(job_id: str) -> Dict[str, Any]:
        """Get one backfill job status and result. Uses control_via_db or status_cfg_for_read."""
        db_config = control_via_db or status_cfg_for_read
        if not db_config:
            return {"ok": False, "error": "No DB"}
        job = get_bars_backfill_job(db_config, job_id)
        if job is None:
            return {"ok": False, "error": "Job not found"}
        return {"ok": True, "job": _job_row_to_api(job)}

    @app.delete("/bars/jobs/{job_id}")
    def delete_bars_job(job_id: str) -> Dict[str, Any]:
        """Delete one backfill job by id (from DB only; Celery task may already be running)."""
        if not control_via_db:
            return {"ok": False, "error": "No DB"}
        if delete_bars_backfill_job(control_via_db, job_id):
            return {"ok": True}
        return {"ok": False, "error": "Delete failed"}

    @app.delete("/bars/jobs")
    def delete_all_bars_jobs(
        status: Optional[str] = Query(None, description="If set, only delete jobs with this status (pending, running, done, failed)"),
    ) -> Dict[str, Any]:
        """Delete all backfill jobs, or only those matching status filter."""
        if not control_via_db:
            return {"ok": False, "error": "No DB", "deleted": 0}
        deleted = delete_all_bars_backfill_jobs(control_via_db, status_filter=status)
        return {"ok": True, "deleted": deleted}

    def _exit_after_send() -> None:
        time.sleep(1.5)  # give time for response to be sent and flushed
        logger.info("Monitor stop: exiting process.")
        os._exit(0)

    @app.post("/control/monitor_stop")
    async def post_monitor_stop() -> JSONResponse:
        """Stop monitor-side IB activity AND terminate the monitor process itself.

        语义：与“停止守护”对应——先关闭监控端 IB 长连接，然后 Kill 掉监控服务进程，
        释放掉当前进程占用的所有资源（包括 IB client_id）。重启需重新运行 run_server.py。
        """
        app.state.monitor_enabled = False
        # Best-effort disconnect; ignore errors.
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
        # Schedule process exit in a background thread so response is sent first; delay so client gets 200.
        threading.Thread(target=_exit_after_send, daemon=True).start()
        return JSONResponse(status_code=200, content={"ok": True, "monitor_enabled": False})

    @app.post("/control/monitor_release_ib")
    async def post_monitor_release_ib() -> JSONResponse:
        """Release Monitor IB connections only (Account + Market client_id). Monitor process keeps running; use Connect to reconnect."""
        try:
            acc_client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
            if acc_client is not None:
                await acc_client.disconnect()
        except Exception as e:
            logger.warning("monitor_release_ib account disconnect: %s", e)
        try:
            mkt_client: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
            if mkt_client is not None:
                await mkt_client.disconnect()
        except Exception as e:
            logger.warning("monitor_release_ib market disconnect: %s", e)
        return JSONResponse(status_code=200, content={"ok": True, "message": "Monitor IB connections released."})

    @app.post("/control/celery_stop")
    def post_celery_stop() -> JSONResponse:
        """Set Redis key so Celery worker exits (same semantics as Monitor/Daemon Stop).

        Worker polls every 2s; process will terminate shortly after. Restart with: python scripts/run_celery.py
        Immediately mark Worker IB status as disconnected so UI reflects stop on next GET /status poll.
        """
        try:
            import json
            import redis
            from servers.celery_app import broker_url, WORKER_STOP_REQUESTED_KEY, WORKER_IB_STATUS_KEY, WORKER_IB_STATUS_TTL_SEC
            r = redis.from_url(broker_url)
            r.set(WORKER_STOP_REQUESTED_KEY, "1")
            # 立即把 Worker IB 状态写成“已断开”，这样下一次 GET /status 轮询时 UI 就能显示已停止（类似 Monitor 的 health 轮询）
            r.setex(
                WORKER_IB_STATUS_KEY,
                WORKER_IB_STATUS_TTL_SEC,
                json.dumps({"connected": False, "client_id": 0}),
            )
            return JSONResponse(status_code=200, content={"ok": True, "message": "Celery worker stop requested; process will exit within a few seconds."})
        except Exception as e:
            logger.warning("celery_stop failed: %s", e)
            return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})

    @app.post("/control/monitor_connect")
    async def post_monitor_connect() -> JSONResponse:
        """显式建立监控端 IB 连接（账户 + 行情），便于“随时可服务”。

        - 不写库、不拉数据，只做 ensure_connected。
        - 成功后，/status 里的 monitor_ib_status.*.connected 会变为 true。
        """
        if not getattr(app.state, "monitor_enabled", True):
            return JSONResponse(status_code=400, content={"ok": False, "error": "监控已停止，无法连接 IB。"})

        acc_client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
        mkt_client: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)

        if acc_client is None and mkt_client is None:
            return JSONResponse(
                status_code=500,
                content={"ok": False, "error": "监控端 IB 客户端未初始化（请检查服务启动日志或 DB 中的 IB 设置）。"},
            )

        acc_ok: Optional[bool] = None
        acc_err: Optional[str] = None
        mkt_ok: Optional[bool] = None
        mkt_err: Optional[str] = None

        if acc_client is not None:
            try:
                await acc_client.ensure_connected()
                acc_ok = True
            except Exception as e:  # pragma: no cover - defensive
                acc_ok = False
                acc_err = str(e)

        if mkt_client is not None:
            try:
                await mkt_client.ensure_connected()
                mkt_ok = True
            except Exception as e:  # pragma: no cover - defensive
                mkt_ok = False
                mkt_err = str(e)

        ok = (acc_ok is not False) and (mkt_ok is not False)
        status_code = 200 if ok else 500
        return JSONResponse(
            status_code=status_code,
            content={
                "ok": ok,
                "account": {"requested": acc_client is not None, "success": acc_ok, "error": acc_err},
                "market": {"requested": mkt_client is not None, "success": mkt_ok, "error": mkt_err},
            },
        )

    @app.post("/control/stop")
    def post_control_stop() -> JSONResponse:
        """Insert 'stop' into daemon_control; daemon will request_stop() on next heartbeat (R-C1b)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_control_command(control_via_db, "stop"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "stop written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/flatten")
    def post_control_flatten() -> JSONResponse:
        """Insert 'flatten' into daemon_control. R-C3 not implemented in daemon yet; daemon logs and continues."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_control_command(control_via_db, "flatten"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "flatten written to daemon_control (daemon may not implement yet)"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/suspend")
    def post_control_suspend() -> JSONResponse:
        """Set daemon_run_status.suspended=true; daemon will pause hedging until resume (R-C2-style)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_run_status(control_via_db, suspended=True):
            return JSONResponse(status_code=200, content={"ok": True, "message": "trading suspended (daemon will not hedge until resume)"})
        return JSONResponse(status_code=500, content={"error": "failed to set run status"})

    @app.post("/control/resume")
    def post_control_resume() -> JSONResponse:
        """Set daemon_run_status.suspended=false; daemon will resume hedging."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_run_status(control_via_db, suspended=False):
            return JSONResponse(status_code=200, content={"ok": True, "message": "trading resumed"})
        return JSONResponse(status_code=500, content={"error": "failed to set run status"})

    @app.post("/control/retry_ib")
    def post_control_retry_ib() -> JSONResponse:
        """Insert 'retry_ib' into daemon_control; daemon will attempt IB connect on next poll (RE-7)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_control_command(control_via_db, "retry_ib"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "retry_ib written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/release_ib")
    def post_control_release_ib() -> JSONResponse:
        """Insert 'release_ib' into daemon_control; daemon will release IB connection on next heartbeat (disconnect → WAITING_IB)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_control_command(control_via_db, "release_ib"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "release_ib written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/refresh_accounts")
    async def post_control_refresh_accounts() -> JSONResponse:
        """仅通过监控端维护的 AccountIbClient 长连接从 IB 拉取账户/持仓并写库，不写 daemon_control。"""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        acc_client = getattr(app.state, "account_ib_client", None)
        if acc_client is None:
            return JSONResponse(
                status_code=503,
                content={"error": "监控端 Account Client 未初始化，请检查服务启动与 IB 配置（设置页）。"},
            )
        try:
            accounts_list = await acc_client.fetch_accounts_snapshot()
            if not accounts_list:
                return JSONResponse(
                    status_code=200,
                    content={"ok": True, "message": "未获取到账户数据（IB 可能未返回 managed accounts）"},
                )
            if not sync_accounts_snapshot_to_db(control_via_db, accounts_list):
                return JSONResponse(
                    status_code=500,
                    content={"error": "账户数据写库失败，请稍后重试"},
                )
            return JSONResponse(
                status_code=200,
                content={
                    "ok": True,
                    "message": "账户/持仓已通过监控端 Account Client 从 IB 拉取并写入数据库",
                },
            )
        except Exception as e:
            logger.warning("refresh_accounts via AccountIbClient failed: %s", e, exc_info=True)
            return JSONResponse(
                status_code=500,
                content={"ok": False, "error": f"监控端拉取失败: {e}"},
            )

    @app.post("/control/refresh_replay")
    def post_control_refresh_replay() -> JSONResponse:
        """Insert 'refresh_replay' into daemon_control; daemon will sync executions from IB to account_executions on next poll (R-A2, 复盘与风控 Tab 专用刷新)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_control_command(control_via_db, "refresh_replay"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "refresh_replay written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/refresh_ticker_subscriptions")
    def post_control_refresh_ticker_subscriptions() -> JSONResponse:
        """Insert 'refresh_ticker_subscriptions' into daemon_control; daemon will sync Real-time ticker with Watchlist on next poll (多退少补，清除残留)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        if write_control_command(control_via_db, "refresh_ticker_subscriptions"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "refresh_ticker_subscriptions written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/set_heartbeat_interval")
    def post_set_heartbeat_interval(body: Dict[str, Any] = Body(...)) -> JSONResponse:
        """Set daemon_run_status.heartbeat_interval_sec (5–120). Daemon polls and uses this on next heartbeat."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        sec = body.get("heartbeat_interval_sec")
        if sec is None:
            return JSONResponse(status_code=400, content={"error": "heartbeat_interval_sec required (5–120)"})
        try:
            sec = int(sec)
        except (TypeError, ValueError):
            return JSONResponse(status_code=400, content={"error": "heartbeat_interval_sec must be an integer"})
        if write_heartbeat_interval(control_via_db, sec):
            return JSONResponse(status_code=200, content={"ok": True, "heartbeat_interval_sec": max(5, min(120, sec))})
        return JSONResponse(status_code=500, content={"error": "failed to set heartbeat interval"})

    @app.post("/config/ib")
    def post_config_ib(body: IbConfigBody = Body(...)) -> JSONResponse:
        """Update settings: ib_host, ib_port_type, 以及多种 IB client_id（守护进程/监听进程/账户信息/市场数据）。守护进程下次启动时加载。"""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
        current = reader.get_ib_config() or {
            "ib_host": "127.0.0.1",
            "ib_port_type": "tws_paper",
            "ib_client_id_daemon": 1,
            "ib_client_id_listener": 2,
            "ib_client_id_account": 100,
            "ib_client_id_markets": 101,
            "ib_client_id_worker_market": 500,
        }
        host = (str(body.ib_host or current.get("ib_host", "127.0.0.1"))).strip() or "127.0.0.1"
        port_type = (str(body.ib_port_type or current.get("ib_port_type", "tws_paper"))).strip().lower() or "tws_paper"
        if port_type not in ("tws_live", "tws_paper", "gateway"):
            port_type = "tws_paper"
        cid_d = body.ib_client_id_daemon if body.ib_client_id_daemon is not None else current.get("ib_client_id_daemon", 1)
        cid_l = body.ib_client_id_listener if body.ib_client_id_listener is not None else current.get("ib_client_id_listener", 2)
        cid_a = body.ib_client_id_account if body.ib_client_id_account is not None else current.get("ib_client_id_account", 100)
        cid_m = body.ib_client_id_markets if body.ib_client_id_markets is not None else current.get("ib_client_id_markets", 101)
        cid_w = body.ib_client_id_worker_market if body.ib_client_id_worker_market is not None else current.get("ib_client_id_worker_market", 500)
        cid_d, cid_l, cid_a, cid_m, cid_w = int(cid_d), int(cid_l), int(cid_a), int(cid_m), int(cid_w)
        logger.info(
            "[config/ib] writing settings: host=%r port_type=%r ib_client_id_daemon=%s ib_client_id_listener=%s ib_client_id_account=%s ib_client_id_markets=%s ib_client_id_worker_market=%s",
            host,
            port_type,
            cid_d,
            cid_l,
            cid_a,
            cid_m,
            cid_w,
        )
        if write_ib_config(control_via_db, host, port_type, cid_d, cid_l, cid_a, cid_m, cid_w):
            return JSONResponse(
                status_code=200,
                content={
                    "ok": True,
                    "ib_host": host,
                    "ib_port_type": port_type,
                    "ib_client_id_daemon": cid_d,
                    "ib_client_id_listener": cid_l,
                    "ib_client_id_account": cid_a,
                    "ib_client_id_markets": cid_m,
                    "ib_client_id_worker_market": cid_w,
                },
            )
        return JSONResponse(status_code=500, content={"error": "failed to write settings"})

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
