"""Log endpoints: daemon, server, and Celery console logs (fetch, clear, trim, stream)."""

import asyncio
import json
import logging
import threading
import time
from typing import Any, Dict

from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import JSONResponse, StreamingResponse

from backend.monitor.routers.deps import (
    DAEMON_LOG_STREAM_KEY,
    DOCS_LOG_STREAM_KEY,
    IB_OPERATOR_LOG_STREAM_KEY,
    IB_INGESTOR_LOG_STREAM_KEY,
    MASSIVE_LOG_STREAM_KEY,
    MASSIVE_WS_LOG_STREAM_KEY,
    OPS_LOG_STREAM_KEY,
    SERVER_LOG_STREAM_KEY,
    daemon_log_redis_url,
)
from src.core.sse.queue_utils import put_nowait_drop_oldest

logger = logging.getLogger(__name__)

router = APIRouter(tags=["logs"])


def _daemon_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream bifrost:daemon_console, push each line to all SSE queues."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
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
                        with app_ref.state.daemon_log_lock:
                            queues = list(app_ref.state.daemon_log_queues)
                        loop = getattr(app_ref.state, "_daemon_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("daemon_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("daemon_log_reader_loop exited: %s", e)


def _server_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream bifrost:server_console, push each line to all SSE queues."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
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
                        with app_ref.state.server_log_lock:
                            queues = list(app_ref.state.server_log_queues)
                        loop = getattr(app_ref.state, "_server_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("server_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("server_log_reader_loop exited: %s", e)


def _massive_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream bifrost:massive_console, push each line to all SSE queues."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        last_id = "$"
        while True:
            try:
                result = r.xread(block=5000, streams={MASSIVE_LOG_STREAM_KEY: last_id}, count=100)
                if not result:
                    continue
                for _stream_name, entries in result:
                    for eid, fields in entries:
                        last_id = eid
                        line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                        with app_ref.state.massive_log_lock:
                            queues = list(app_ref.state.massive_log_queues)
                        loop = getattr(app_ref.state, "_massive_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("massive_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("massive_log_reader_loop exited: %s", e)


def _massive_ws_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream bifrost:massive_ws_console (run_massive_ws.py)."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        last_id = "$"
        while True:
            try:
                result = r.xread(block=5000, streams={MASSIVE_WS_LOG_STREAM_KEY: last_id}, count=100)
                if not result:
                    continue
                for _stream_name, entries in result:
                    for eid, fields in entries:
                        last_id = eid
                        line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                        with app_ref.state.massive_ws_log_lock:
                            queues = list(app_ref.state.massive_ws_log_queues)
                        loop = getattr(app_ref.state, "_massive_ws_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("massive_ws_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("massive_ws_log_reader_loop exited: %s", e)


def _ib_operator_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream ib:operator:console (run_ib_operator.py)."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        last_id = "$"
        while True:
            try:
                result = r.xread(block=5000, streams={IB_OPERATOR_LOG_STREAM_KEY: last_id}, count=100)
                if not result:
                    continue
                for _stream_name, entries in result:
                    for eid, fields in entries:
                        last_id = eid
                        line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                        with app_ref.state.ib_operator_log_lock:
                            queues = list(app_ref.state.ib_operator_log_queues)
                        loop = getattr(app_ref.state, "_ib_operator_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("ib_operator_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("ib_operator_log_reader_loop exited: %s", e)


def _ib_ingestor_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream bifrost:ib_ingestor_console (run_ib_ingestor.py)."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        last_id = "$"
        while True:
            try:
                result = r.xread(block=5000, streams={IB_INGESTOR_LOG_STREAM_KEY: last_id}, count=100)
                if not result:
                    continue
                for _stream_name, entries in result:
                    for eid, fields in entries:
                        last_id = eid
                        line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                        with app_ref.state.ib_ingestor_log_lock:
                            queues = list(app_ref.state.ib_ingestor_log_queues)
                        loop = getattr(app_ref.state, "_ib_ingestor_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("ib_ingestor_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("ib_ingestor_log_reader_loop exited: %s", e)


def _docs_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream bifrost:docs_console, push each line to all SSE queues."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        last_id = "$"
        while True:
            try:
                result = r.xread(block=5000, streams={DOCS_LOG_STREAM_KEY: last_id}, count=100)
                if not result:
                    continue
                for _stream_name, entries in result:
                    for eid, fields in entries:
                        last_id = eid
                        line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                        with app_ref.state.docs_log_lock:
                            queues = list(app_ref.state.docs_log_queues)
                        loop = getattr(app_ref.state, "_docs_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("docs_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("docs_log_reader_loop exited: %s", e)


def _ops_log_reader_loop(app_ref) -> None:
    """Background thread: XREAD Redis stream bifrost:ops_console, push each line to all SSE queues."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        last_id = "$"
        while True:
            try:
                result = r.xread(block=5000, streams={OPS_LOG_STREAM_KEY: last_id}, count=100)
                if not result:
                    continue
                for _stream_name, entries in result:
                    for eid, fields in entries:
                        last_id = eid
                        line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
                        with app_ref.state.ops_log_lock:
                            queues = list(app_ref.state.ops_log_queues)
                        loop = getattr(app_ref.state, "_ops_log_loop", None)
                        for q in queues:
                            if loop and not loop.is_closed():
                                loop.call_soon_threadsafe(put_nowait_drop_oldest, q, line)
            except redis.ConnectionError:
                time.sleep(2)
            except Exception as e:
                logger.debug("ops_log_reader_loop: %s", e)
    except Exception as e:
        logger.warning("ops_log_reader_loop exited: %s", e)


# --- Daemon logs ---

@router.get("/api/daemon/logs")
def get_daemon_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from daemon console Redis stream (for initial display in System → Daemon Console)."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(DAEMON_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_daemon_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/daemon/logs")
def clear_daemon_logs(request: Request) -> Dict[str, Any]:
    """Delete the daemon console Redis stream so next fetch is empty. UI Clear button uses this."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(DAEMON_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_daemon_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/daemon/logs/trim")
def trim_daemon_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Trim daemon console Redis stream to at most max_lines (keep newest)."""
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(DAEMON_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_daemon_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/daemon/logs/stream")
async def get_daemon_logs_stream(request: Request):
    """SSE: stream new daemon console lines in real time (Redis XREAD)."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("daemon_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.daemon_log_lock:
        app.state.daemon_log_queues.append(queue)
        if app.state._daemon_log_loop is None:
            app.state._daemon_log_loop = asyncio.get_running_loop()
        if app.state._daemon_log_thread is None or not app.state._daemon_log_thread.is_alive():
            app.state._daemon_log_thread = threading.Thread(
                target=_daemon_log_reader_loop,
                args=(app,),
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


# --- Server logs ---

@router.get("/api/server/logs")
def get_server_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from server console Redis stream (for initial display in System → Server Console)."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(SERVER_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_server_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/server/logs")
def clear_server_logs(request: Request) -> Dict[str, Any]:
    """Delete the server console Redis stream so next fetch is empty. UI Clear button uses this."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(SERVER_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_server_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/server/logs/trim")
def trim_server_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Trim server console Redis stream to at most max_lines (keep newest)."""
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(SERVER_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_server_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/server/logs/stream")
async def get_server_logs_stream(request: Request):
    """SSE: stream new server console lines in real time (Redis XREAD)."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("server_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.server_log_lock:
        app.state.server_log_queues.append(queue)
        if app.state._server_log_loop is None:
            app.state._server_log_loop = asyncio.get_running_loop()
        if app.state._server_log_thread is None or not app.state._server_log_thread.is_alive():
            app.state._server_log_thread = threading.Thread(
                target=_server_log_reader_loop,
                args=(app,),
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


# --- Massive API server logs (run_server_massive.py → Redis stream bifrost:massive_console) ---


@router.get("/api/massive/logs")
def get_massive_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from Massive API console Redis stream."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(MASSIVE_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_massive_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/massive/logs")
def clear_massive_logs(request: Request) -> Dict[str, Any]:
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(MASSIVE_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_massive_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/massive/logs/trim")
def trim_massive_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(MASSIVE_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_massive_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/massive/logs/stream")
async def get_massive_logs_stream(request: Request):
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("massive_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.massive_log_lock:
        app.state.massive_log_queues.append(queue)
        if app.state._massive_log_loop is None:
            app.state._massive_log_loop = asyncio.get_running_loop()
        if app.state._massive_log_thread is None or not app.state._massive_log_thread.is_alive():
            app.state._massive_log_thread = threading.Thread(
                target=_massive_log_reader_loop,
                args=(app,),
                name="massive-log-reader",
                daemon=True,
            )
            app.state._massive_log_thread.start()

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
            with app.state.massive_log_lock:
                if queue in app.state.massive_log_queues:
                    app.state.massive_log_queues.remove(queue)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- Massive WS ingest logs (scripts/run_massive_ws.py → bifrost:massive_ws_console) ---


@router.get("/api/massive-ws/logs")
def get_massive_ws_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from Massive WS ingest Redis stream."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(MASSIVE_WS_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_massive_ws_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/massive-ws/logs")
def clear_massive_ws_logs(request: Request) -> Dict[str, Any]:
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(MASSIVE_WS_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_massive_ws_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/massive-ws/logs/trim")
def trim_massive_ws_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(MASSIVE_WS_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_massive_ws_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/massive-ws/logs/stream")
async def get_massive_ws_logs_stream(request: Request):
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("massive_ws_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.massive_ws_log_lock:
        app.state.massive_ws_log_queues.append(queue)
        if app.state._massive_ws_log_loop is None:
            app.state._massive_ws_log_loop = asyncio.get_running_loop()
        if app.state._massive_ws_log_thread is None or not app.state._massive_ws_log_thread.is_alive():
            app.state._massive_ws_log_thread = threading.Thread(
                target=_massive_ws_log_reader_loop,
                args=(app,),
                name="massive-ws-log-reader",
                daemon=True,
            )
            app.state._massive_ws_log_thread.start()

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
            with app.state.massive_ws_log_lock:
                if queue in app.state.massive_ws_log_queues:
                    app.state.massive_ws_log_queues.remove(queue)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- IB Operator logs (scripts/run_ib_operator.py → ib:operator:console) ---


@router.get("/api/ib-operator/logs")
def get_ib_operator_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from IB Operator Redis stream."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(IB_OPERATOR_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_ib_operator_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/ib-operator/logs")
def clear_ib_operator_logs(request: Request) -> Dict[str, Any]:
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(IB_OPERATOR_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_ib_operator_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/ib-operator/logs/trim")
def trim_ib_operator_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(IB_OPERATOR_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_ib_operator_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/ib-operator/logs/stream")
async def get_ib_operator_logs_stream(request: Request):
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("ib_operator_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.ib_operator_log_lock:
        app.state.ib_operator_log_queues.append(queue)
        if app.state._ib_operator_log_loop is None:
            app.state._ib_operator_log_loop = asyncio.get_running_loop()
        if app.state._ib_operator_log_thread is None or not app.state._ib_operator_log_thread.is_alive():
            app.state._ib_operator_log_thread = threading.Thread(
                target=_ib_operator_log_reader_loop,
                args=(app,),
                name="ib-operator-log-reader",
                daemon=True,
            )
            app.state._ib_operator_log_thread.start()

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
            with app.state.ib_operator_log_lock:
                if queue in app.state.ib_operator_log_queues:
                    app.state.ib_operator_log_queues.remove(queue)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- IB ingestor logs (scripts/run_ib_ingestor.py → bifrost:ib_ingestor_console) ---


@router.get("/api/ib-ingestor/logs")
def get_ib_ingestor_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from IB ingestor Redis stream."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(IB_INGESTOR_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_ib_ingestor_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/ib-ingestor/logs")
def clear_ib_ingestor_logs(request: Request) -> Dict[str, Any]:
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(IB_INGESTOR_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_ib_ingestor_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/ib-ingestor/logs/trim")
def trim_ib_ingestor_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(IB_INGESTOR_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_ib_ingestor_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/ib-ingestor/logs/stream")
async def get_ib_ingestor_logs_stream(request: Request):
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("ib_ingestor_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.ib_ingestor_log_lock:
        app.state.ib_ingestor_log_queues.append(queue)
        if app.state._ib_ingestor_log_loop is None:
            app.state._ib_ingestor_log_loop = asyncio.get_running_loop()
        if app.state._ib_ingestor_log_thread is None or not app.state._ib_ingestor_log_thread.is_alive():
            app.state._ib_ingestor_log_thread = threading.Thread(
                target=_ib_ingestor_log_reader_loop,
                args=(app,),
                name="ib-ingestor-log-reader",
                daemon=True,
            )
            app.state._ib_ingestor_log_thread.start()

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
            with app.state.ib_ingestor_log_lock:
                if queue in app.state.ib_ingestor_log_queues:
                    app.state.ib_ingestor_log_queues.remove(queue)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- Docs API server logs (run_server_docs.py → Redis stream bifrost:docs_console) ---


@router.get("/api/docs/logs")
def get_docs_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from Docs API console Redis stream."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(DOCS_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_docs_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/docs/logs")
def clear_docs_logs(request: Request) -> Dict[str, Any]:
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(DOCS_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_docs_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/docs/logs/trim")
def trim_docs_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(DOCS_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_docs_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/docs/logs/stream")
async def get_docs_logs_stream(request: Request):
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("docs_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.docs_log_lock:
        app.state.docs_log_queues.append(queue)
        if app.state._docs_log_loop is None:
            app.state._docs_log_loop = asyncio.get_running_loop()
        if app.state._docs_log_thread is None or not app.state._docs_log_thread.is_alive():
            app.state._docs_log_thread = threading.Thread(
                target=_docs_log_reader_loop,
                args=(app,),
                name="docs-log-reader",
                daemon=True,
            )
            app.state._docs_log_thread.start()

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
            with app.state.docs_log_lock:
                if queue in app.state.docs_log_queues:
                    app.state.docs_log_queues.remove(queue)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# --- Celery logs ---


# --- Ops API server logs (run_server_ops.py -> Redis stream bifrost:ops_console) ---


@router.get("/api/ops/logs")
def get_ops_logs(
    request: Request,
    tail: int = Query(1000, ge=1, le=5000, description="Number of latest lines (oldest-first in response)"),
) -> Dict[str, Any]:
    """Return last N lines from Ops API console Redis stream."""
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        raw = r.xrevrange(OPS_LOG_STREAM_KEY, count=tail)
        lines = []
        for _eid, fields in reversed(raw):
            line = (fields.get(b"line") or fields.get("line") or b"").decode("utf-8", errors="replace")
            lines.append(line)
        return {"lines": lines}
    except Exception as e:
        logger.warning("get_ops_logs failed: %s", e)
        return {"lines": [], "error": str(e)}


@router.delete("/api/ops/logs")
def clear_ops_logs(request: Request) -> Dict[str, Any]:
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.delete(OPS_LOG_STREAM_KEY)
        return {"ok": True}
    except Exception as e:
        logger.warning("clear_ops_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.post("/api/ops/logs/trim")
def trim_ops_logs(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    try:
        max_lines = body.get("max_lines")
        if max_lines is None:
            return {"ok": False, "error": "max_lines required"}
        max_lines = int(max_lines)
        if max_lines < 1 or max_lines > 10000:
            return {"ok": False, "error": "max_lines must be between 1 and 10000"}
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.xtrim(OPS_LOG_STREAM_KEY, maxlen=max_lines, approximate=True)
        return {"ok": True}
    except Exception as e:
        logger.warning("trim_ops_logs failed: %s", e)
        return {"ok": False, "error": str(e)}


@router.get("/api/ops/logs/stream")
async def get_ops_logs_stream(request: Request):
    try:
        import redis
        r = redis.from_url(daemon_log_redis_url())
        r.ping()
    except Exception as e:
        logger.warning("ops_logs_stream check failed: %s", e)
        return JSONResponse(status_code=503, content={"detail": str(e)})

    app = request.app
    queue: asyncio.Queue = asyncio.Queue(maxsize=512)
    with app.state.ops_log_lock:
        app.state.ops_log_queues.append(queue)
        if app.state._ops_log_loop is None:
            app.state._ops_log_loop = asyncio.get_running_loop()
        if app.state._ops_log_thread is None or not app.state._ops_log_thread.is_alive():
            app.state._ops_log_thread = threading.Thread(
                target=_ops_log_reader_loop,
                args=(app,),
                name="ops-log-reader",
                daemon=True,
            )
            app.state._ops_log_thread.start()

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
            with app.state.ops_log_lock:
                if queue in app.state.ops_log_queues:
                    app.state.ops_log_queues.remove(queue)

    return StreamingResponse(
        event_gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )

