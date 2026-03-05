"""Phase 2: FastAPI app for GET /status, GET /operations, POST /control/*. API only; frontend is separate (frontend/).

Monitoring runs on a separate host from the trading daemon (RE-5). Start of the daemon is only on the trading machine (run_engine.py); no subprocess/start on this server."""

import json
import logging
import os
import signal
import threading
import time
from typing import Any, Dict, Optional

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
    write_account_executions_to_db,
    update_execution_commission,
    insert_one_execution,
    update_one_execution,
    delete_one_execution,
    sync_accounts_snapshot_to_db,
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


class IbConfigBody(BaseModel):
    """POST /config/ib 请求体，保证 client_id 被正确解析并写入 DB。"""
    ib_host: Optional[str] = None
    ib_port_type: Optional[str] = None
    ib_client_id_daemon: Optional[int] = None
    ib_client_id_listener: Optional[int] = None
    ib_client_id_account: Optional[int] = None
    ib_client_id_markets: Optional[int] = None

    class Config:
        extra = "ignore"  # 忽略多余字段，避免解析错误


def create_app(
    reader: StatusReader,
    control_via_db: Optional[dict],
    data_lag_threshold_ms: Optional[float],
    redis_quotes: Optional[Any] = None,
) -> FastAPI:
    """Build FastAPI app: reader, control channel (stop/flatten/suspend/resume via DB). Optional redis_quotes for GET /quotes (R-RM*)."""
    app = FastAPI(title="Bifrost Trader API", description="Phase 2: status and control API (frontend is separate)")
    app.state.redis_quotes = redis_quotes
    # SSE 实时行情：每个连接一个 asyncio.Queue；Redis 订阅线程收到消息后广播到各 queue
    app.state.sse_queues: list = []
    app.state.sse_lock = threading.Lock()
    app.state._sse_loop: Optional[asyncio.AbstractEventLoop] = None
    app.state._redis_subscriber_stop = threading.Event()
    app.state._redis_subscriber_thread: Optional[threading.Thread] = None

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
        symbols: Optional[str] = Query(None, description="Comma-separated symbols; if omitted, use focus list (status symbol + positions + wishlist)"),
    ) -> Dict[str, Any]:
        """R-RM*: 从 Redis 读取当前行情缓存（守护进程写入）。无 Redis 或未启用时返回空列表。"""
        rq = getattr(app.state, "redis_quotes", None)
        if rq is None or not getattr(rq, "available", False):
            return {"quotes": [], "message": "实时行情未开启或 Redis 不可用"}
        symbol_list: list[str] = []
        if symbols and symbols.strip():
            symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
        else:
            # Focus list: status symbol + account positions symbols + wishlist symbols
            row = reader.get_status_current()
            if row and row.get("symbol"):
                symbol_list.append(str(row["symbol"]).strip())
            accounts = reader.get_accounts_from_tables() or []
            for acc in accounts:
                for pos in (acc.get("positions") or []):
                    sym = (pos.get("symbol") or "").strip()
                    if sym and sym not in symbol_list:
                        symbol_list.append(sym)
            for w in reader.get_wishlist():
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
            # Subscribed tickers: Wishlist STK + strategy symbol (same set daemon subscribes to when RUNNING)
            symbols_set: set = set()
            if row and row.get("symbol"):
                symbols_set.add(str(row.get("symbol", "") or "").strip())
            for w in reader.get_wishlist():
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
                },
                "monitor_ib_status": None,
                "monitor_enabled": False,
                "monitor_health": "ok",
                "monitor_self_check": "blocked",
                "monitor_lamp": "red",
                "monitor_block_reasons": ["status_read_error"],
                "redis_quotes_connected": False,
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
        limit: int = Query(200, ge=1, le=1000),
    ) -> Dict[str, Any]:
        """Account-level executions/trades (R-A2). Reads from account_executions table (daemon syncs from IB). Each item includes id for edit."""
        items = reader.get_executions(since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=limit)
        return {"executions": items}

    @app.post("/executions")
    def post_execution(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """R-A2 扩展：手动添加一条执行记录（历史补录）。body: account_id, time(Unix s), symbol, sec_type, side, quantity, price；可选 source, exec_id, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, commission, realized_pnl, currency。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 status.postgres 配置以写入 account_executions。", "id": None}
        new_id = insert_one_execution(control_via_db, body)
        if new_id is None:
            return {"ok": False, "error": "添加执行记录失败（请检查必填项：symbol, quantity, price）。", "id": None}
        return {"ok": True, "id": new_id, "message": "已添加一条执行记录。"}

    @app.put("/executions/{execution_id:int}")
    def put_execution(execution_id: int, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """R-A2 扩展：按 id 更新一条执行记录（手动修正）。body 可含任意子集：time, symbol, sec_type, side, quantity, price, account_id, source, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, commission, realized_pnl, currency。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 status.postgres 配置以写入 account_executions。"}
        if update_one_execution(control_via_db, execution_id, body):
            return {"ok": True, "message": "已更新执行记录。"}
        return {"ok": False, "error": "更新失败（id 不存在或数据库错误）。"}

    @app.delete("/executions/{execution_id:int}")
    def delete_execution(execution_id: int) -> Dict[str, Any]:
        """R-A2 扩展：按 id 删除一条执行记录（逐笔操作）。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 status.postgres 配置以写入 account_executions。"}
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

    @app.get("/wishlist")
    def get_wishlist() -> Dict[str, Any]:
        """R-A3 扩展：返回 Wishlist 列表（自选/待操作标的）。"""
        items = reader.get_wishlist()
        return {"items": items}

    class WishlistBody(BaseModel):
        contract_key: str
        symbol: Optional[str] = None
        sec_type: Optional[str] = None
        expiry: Optional[str] = None
        strike: Optional[float] = None
        option_right: Optional[str] = None
        display_label: Optional[str] = None
        source: Optional[str] = None

    @app.post("/wishlist")
    def post_wishlist(body: WishlistBody = Body(...)) -> Dict[str, Any]:
        """R-A3 扩展：添加或更新 Wishlist 项（按 contract_key 唯一）。"""
        if not control_via_db:
            logger.info("POST /wishlist rejected: 需要 status.postgres 配置以写入 wishlist")
            return {"ok": False, "error": "需要 status.postgres 配置以写入 wishlist。"}
        ok = reader.add_wishlist(
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
            return {"ok": True, "message": "已添加或更新 Wishlist 项。"}
        logger.warning("POST /wishlist 写入失败")
        return {"ok": False, "error": "写入 wishlist 失败。"}

    @app.delete("/wishlist")
    def delete_wishlist(
        contract_key: Optional[str] = Query(None, description="Delete by contract_key"),
        id: Optional[int] = Query(None, description="Delete by id"),
    ) -> Dict[str, Any]:
        """R-A3 扩展：删除一条 Wishlist 项（传 contract_key 或 id 之一）。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 status.postgres 配置以修改 wishlist。"}
        if contract_key is None and id is None:
            return {"ok": False, "error": "请提供 contract_key 或 id 参数。"}
        if reader.delete_wishlist(contract_key=contract_key, id_=id):
            return {"ok": True, "message": "已删除。"}
        return {"ok": False, "error": "删除失败（未找到或数据库错误）。"}

    # R-A3: 复盘 K 线由 API 直接连 IB 拉取并写库，不经过 daemon（历史数据一次性拉取更合适）
    # R-A2: 执行记录同样支持 API 直接连 IB 拉取并写库，无需 daemon
    _IB_PORT_MAP = {"tws_live": 7496, "tws_paper": 7497, "gateway": 4002}

    @app.post("/executions/fetch")
    async def post_executions_fetch(
        days: int = Query(1, ge=1, le=7, description="拉取范围：1=当天, 3=最近3天, 7=最近7天（需 TWS Trade Log 勾选对应天数）"),
    ) -> Dict[str, Any]:
        """R-A2: 通过监控端 AccountIbClient 拉取执行/成交记录并写入 account_executions。"""
        if not control_via_db:
            return {"ok": False, "error": "需要 status.postgres 配置以写入 account_executions。", "count": 0}
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
        from src.connector.ib import IBConnector as _IBConnectorAlias
        if not isinstance(client.connector, _IBConnectorAlias):
            return {"ok": False, "error": "AccountIbClient connector 未就绪。", "count": 0}
        client.connector.set_commission_report_callback(
            lambda eid, c, pnl, cur, y_, yrd: update_execution_commission(
                control_via_db, eid, c, pnl, cur, y_, yrd
            )
        )
        try:
            all_execs = await client.fetch_executions(days=days)
        finally:
            try:
                client.connector.set_commission_report_callback(None)
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
            return {"ok": False, "error": "需要 status.postgres 配置以写入 K 线表。", "bars": [], "count": 0}
        if not getattr(app.state, "monitor_enabled", True):
            return {"ok": False, "error": "监控已停止，无法拉取 K 线。", "bars": [], "count": 0}
        client: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
        if client is None:
            return {"ok": False, "error": "监控端 MarketIbClient 未初始化。", "bars": [], "count": 0}
        per = (period or "1 D").strip()
        dur = (duration or "30 D").strip()
        if smart_duration:
            latest_ts = reader.get_bars_latest(symbol=sym, period=per)
            if latest_ts is not None:
                from datetime import datetime, timezone
                now = datetime.now(tz=timezone.utc).timestamp()
                gap_sec = max(0, now - latest_ts)
                if per.upper() == "1 D":
                    gap_days = min(max(1, int(gap_sec / 86400) + 1), 720)
                    dur = f"{gap_days} D"
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

    async def _shutdown_monitor_process() -> None:
        """异步触发监控服务自身退出（类似停止守护），用于 /monitor/stop 调用后释放进程占用。"""
        # 给响应一点时间发回前端，再发 SIGTERM。
        await asyncio.sleep(0.5)
        try:
            os.kill(os.getpid(), signal.SIGTERM)
        except Exception:
            # 兜底：若发送信号失败，直接退出进程。
            raise SystemExit(0)

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
        # 异步触发整个监控服务进程退出（SIGTERM），尽量在响应发回前稍作等待。
        asyncio.create_task(_shutdown_monitor_process())
        return JSONResponse(status_code=200, content={"ok": True, "monitor_enabled": False})

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
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "stop"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "stop written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/flatten")
    def post_control_flatten() -> JSONResponse:
        """Insert 'flatten' into daemon_control. R-C3 not implemented in daemon yet; daemon logs and continues."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "flatten"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "flatten written to daemon_control (daemon may not implement yet)"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/suspend")
    def post_control_suspend() -> JSONResponse:
        """Set daemon_run_status.suspended=true; daemon will pause hedging until resume (R-C2-style)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_run_status(control_via_db, suspended=True):
            return JSONResponse(status_code=200, content={"ok": True, "message": "trading suspended (daemon will not hedge until resume)"})
        return JSONResponse(status_code=500, content={"error": "failed to set run status"})

    @app.post("/control/resume")
    def post_control_resume() -> JSONResponse:
        """Set daemon_run_status.suspended=false; daemon will resume hedging."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_run_status(control_via_db, suspended=False):
            return JSONResponse(status_code=200, content={"ok": True, "message": "trading resumed"})
        return JSONResponse(status_code=500, content={"error": "failed to set run status"})

    @app.post("/control/retry_ib")
    def post_control_retry_ib() -> JSONResponse:
        """Insert 'retry_ib' into daemon_control; daemon will attempt IB connect on next poll (RE-7)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "retry_ib"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "retry_ib written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/refresh_accounts")
    async def post_control_refresh_accounts() -> JSONResponse:
        """仅通过监控端维护的 AccountIbClient 长连接从 IB 拉取账户/持仓并写库，不写 daemon_control。"""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
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
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "refresh_replay"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "refresh_replay written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/refresh_ticker_subscriptions")
    def post_control_refresh_ticker_subscriptions() -> JSONResponse:
        """Insert 'refresh_ticker_subscriptions' into daemon_control; daemon will sync Real-time ticker with Wishlist on next poll (多退少补，清除残留)."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        if write_control_command(control_via_db, "refresh_ticker_subscriptions"):
            return JSONResponse(status_code=200, content={"ok": True, "message": "refresh_ticker_subscriptions written to daemon_control"})
        return JSONResponse(status_code=500, content={"error": "failed to write control command"})

    @app.post("/control/set_heartbeat_interval")
    def post_set_heartbeat_interval(body: Dict[str, Any] = Body(...)) -> JSONResponse:
        """Set daemon_run_status.heartbeat_interval_sec (5–120). Daemon polls and uses this on next heartbeat."""
        if not control_via_db:
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
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
            return JSONResponse(status_code=503, content={"error": "control via DB not available (status.postgres required)"})
        current = reader.get_ib_config() or {
            "ib_host": "127.0.0.1",
            "ib_port_type": "tws_paper",
            "ib_client_id_daemon": 1,
            "ib_client_id_listener": 2,
            "ib_client_id_account": 100,
            "ib_client_id_markets": 101,
        }
        host = (str(body.ib_host or current.get("ib_host", "127.0.0.1"))).strip() or "127.0.0.1"
        port_type = (str(body.ib_port_type or current.get("ib_port_type", "tws_paper"))).strip().lower() or "tws_paper"
        if port_type not in ("tws_live", "tws_paper", "gateway"):
            port_type = "tws_paper"
        cid_d = body.ib_client_id_daemon if body.ib_client_id_daemon is not None else current.get("ib_client_id_daemon", 1)
        cid_l = body.ib_client_id_listener if body.ib_client_id_listener is not None else current.get("ib_client_id_listener", 2)
        cid_a = body.ib_client_id_account if body.ib_client_id_account is not None else current.get("ib_client_id_account", 100)
        cid_m = body.ib_client_id_markets if body.ib_client_id_markets is not None else current.get("ib_client_id_markets", 101)
        cid_d, cid_l, cid_a, cid_m = int(cid_d), int(cid_l), int(cid_a), int(cid_m)
        logger.info(
            "[config/ib] writing settings: host=%r port_type=%r ib_client_id_daemon=%s ib_client_id_listener=%s ib_client_id_account=%s ib_client_id_markets=%s",
            host,
            port_type,
            cid_d,
            cid_l,
            cid_a,
            cid_m,
        )
        if write_ib_config(control_via_db, host, port_type, cid_d, cid_l, cid_a, cid_m):
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
                },
            )
        return JSONResponse(status_code=500, content={"error": "failed to write settings"})

    return app


def run_server(config: dict) -> None:
    """Start the status server (host 0.0.0.0, port from config). Control channel: PostgreSQL daemon_control + daemon_run_status (RE-5). No start: daemon is started on trading host only."""
    import os
    import uvicorn

    status_cfg = config.get("status") or {}
    use_db_control = status_cfg.get("sink") == "postgres" and (status_cfg.get("postgres") or os.environ.get("PGHOST"))

    port = config.get("status_server", {}).get("port") or config.get("server", {}).get("port") or 8765
    data_lag_ms = None
    gates = config.get("gates") or {}
    state_cfg = gates.get("state") or {}
    system_cfg = state_cfg.get("system") or {}
    if "data_lag_threshold_ms" in system_cfg:
        data_lag_ms = system_cfg["data_lag_threshold_ms"]

    reader = StatusReader(status_cfg)
    control_via_db = status_cfg if use_db_control else None
    redis_quotes = None
    if create_redis_quotes:
        redis_quotes = create_redis_quotes(config)
    app = create_app(reader, control_via_db, data_lag_ms, redis_quotes=redis_quotes)
    host = "0.0.0.0"
    logger.info("Status server on %s:%s (control=daemon_control + daemon_run_status; start only on trading host)", host, port)
    uvicorn.run(app, host=host, port=int(port), log_level="info")
