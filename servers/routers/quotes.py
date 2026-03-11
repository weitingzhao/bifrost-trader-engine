"""Quotes endpoints: Redis cache and SSE stream."""

import asyncio
import json
from typing import Any, Dict, Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

import logging

logger = logging.getLogger(__name__)

router = APIRouter(tags=["quotes"])


@router.get("/quotes")
def get_quotes(
    request: Request,
    symbols: Optional[str] = Query(None, description="Comma-separated symbols; if omitted, use focus list (positions + watchlist)"),
) -> Dict[str, Any]:
    """R-RM*: Read current quotes cache from Redis (daemon writes). Returns empty list when Redis disabled or unavailable."""
    app = request.app
    reader = app.state.reader
    rq = getattr(app.state, "redis_quotes", None)
    if rq is None or not getattr(rq, "available", False):
        return {"quotes": [], "message": "实时行情未开启或 Redis 不可用"}
    symbol_list: list = []
    if symbols and symbols.strip():
        symbol_list = [s.strip() for s in symbols.split(",") if s.strip()]
    else:
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


@router.get("/quotes/stream")
async def get_quotes_stream(request: Request):
    """R-RM* SSE: Subscribe to Redis daemon:quotes; daemon pushes a data event on each quote update. Returns 503 when Redis unavailable."""
    app = request.app
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
