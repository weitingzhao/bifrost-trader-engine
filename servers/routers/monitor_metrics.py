"""Internal diagnostics: SSE queue depth metrics for monitoring UI."""

import time
from typing import Any, Dict, List

from fastapi import APIRouter, Request

router = APIRouter(tags=["monitor-metrics"])

QUOTES_MAXSIZE = 256
LOG_MAXSIZE = 512


def _snapshot_queues(lock, queues: list) -> Dict[str, Any]:
    with lock:
        qs = list(queues)
    depths: List[int] = [q.qsize() for q in qs]
    maxsize = QUOTES_MAXSIZE if not qs else (qs[0].maxsize or 0)
    return {
        "connection_count": len(depths),
        "maxsize": maxsize,
        "depths": depths,
        "total_queued": sum(depths),
        "max_depth": max(depths) if depths else 0,
    }


@router.get("/api/monitor/sse-queue-metrics")
def get_sse_queue_metrics(request: Request) -> Dict[str, Any]:
    """Return per-category SSE queue depth for all active connections (quotes, daemon/server/celery logs)."""
    app = request.app
    return {
        "ts": time.time(),
        "quotes": _snapshot_queues(app.state.sse_lock, app.state.sse_queues),
        "daemon_logs": _snapshot_queues(app.state.daemon_log_lock, app.state.daemon_log_queues),
        "server_logs": _snapshot_queues(app.state.server_log_lock, app.state.server_log_queues),
        "celery_logs": _snapshot_queues(app.state.celery_log_lock, app.state.celery_log_queues),
        "massive_logs": _snapshot_queues(app.state.massive_log_lock, app.state.massive_log_queues),
        "docs_logs": _snapshot_queues(app.state.docs_log_lock, app.state.docs_log_queues),
    }
