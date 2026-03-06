"""Celery app for bars backfill worker. Broker and result backend use Redis from config.

Usage:
  celery -A servers.celery_app worker -l info -Q bars --pool=solo

Or: python scripts/run_celery.py [config_path]

Solo pool: single process, one IB connection (client_id). Stop-poll runs in worker_init so Stop button works.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Optional

# Ensure project root on path and cwd when worker imports this
_here = Path(__file__).resolve().parent
_project_root = _here.parent
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))
if os.getcwd() != str(_project_root):
    try:
        os.chdir(_project_root)
    except OSError:
        pass

logger = logging.getLogger(__name__)


def _redis_url_from_config() -> str:
    """Build Redis URL from config (same redis as realtime quotes; use db 1 for Celery to avoid clash)."""
    try:
        from src.app.gs_trading import read_config
        config, _ = read_config()
    except Exception as e:
        logger.warning("read_config for Celery failed: %s; using default Redis URL", e)
        return "redis://127.0.0.1:6379/1"
    r = config.get("redis") or {}
    if not r.get("enabled", True) and "enabled" in r:
        return "redis://127.0.0.1:6379/1"
    host = (r.get("host") or os.environ.get("REDIS_HOST") or "127.0.0.1").strip()
    port = int(r.get("port") or os.environ.get("REDIS_PORT") or 6379)
    db = int(r.get("db") or os.environ.get("REDIS_DB") or 1)  # 1 for Celery to avoid quotes db 0
    password = (r.get("password") or os.environ.get("REDIS_PASSWORD") or "").strip()
    if password:
        return f"redis://:{password}@{host}:{port}/{db}"
    return f"redis://{host}:{port}/{db}"


broker_url = _redis_url_from_config()
result_backend = broker_url

from celery import Celery  # noqa: E402

app = Celery(
    "bifrost.bars",
    broker=broker_url,
    backend=result_backend,
    include=["servers.bars_tasks"],
)
app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    task_default_queue="bars",
    task_routes={"servers.bars_tasks.backfill_bars": {"queue": "bars"}},
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    result_expires=86400,
)


def get_celery_broker_connected() -> bool:
    """Try to connect to Celery broker (Redis) and ping. Used by GET /status for Celery status display."""
    try:
        import redis
        r = redis.from_url(broker_url)
        r.ping()
        return True
    except Exception:
        return False


WORKER_IB_STATUS_KEY = "bifrost:worker_ib_status"
WORKER_IB_STATUS_TTL_SEC = 90
WORKER_STOP_REQUESTED_KEY = "bifrost:worker_stop_requested"
WORKER_CONNECT_REQUESTED_KEY = "bifrost:worker_connect_requested"
CELERY_LOG_STREAM_KEY = "bifrost:celery_console"
CELERY_LOG_STREAM_MAXLEN = 5000


def get_worker_ib_status() -> Optional[dict]:
    """Read Worker IB connection status from Redis (written by bars worker). Returns {connected, client_id} or None."""
    try:
        import redis
        import json
        r = redis.from_url(broker_url)
        raw = r.get(WORKER_IB_STATUS_KEY)
        if not raw:
            return None
        data = json.loads(raw)
        if isinstance(data.get("connected"), bool) and data["connected"]:
            return {"connected": True, "client_id": data.get("client_id")}
        return None
    except Exception:
        return None


def get_celery_workers_ping(timeout: float = 5.0) -> list[str]:
    """Ping Celery workers via broker; return list of worker names that responded. Used for UI 'Running workers' list."""
    try:
        i = app.control.inspect(timeout=timeout)
        result = i.ping()
        if not result or not isinstance(result, dict):
            logger.info("get_celery_workers_ping: no workers responded (result=%s)", result)
            return []
        return sorted(result.keys())
    except Exception as e:
        logger.info("get_celery_workers_ping failed: %s", e)
        return []


class _RedisStreamLogHandler(logging.Handler):
    """Logging handler that pushes each log record to a Redis Stream for UI console tail (Scheme B)."""

    def __init__(self, redis_url: str, stream_key: str, maxlen: int = 5000) -> None:
        super().__init__()
        self._redis_url = redis_url
        self._stream_key = stream_key
        self._maxlen = maxlen

    def emit(self, record: logging.LogRecord) -> None:
        try:
            import redis
            line = self.format(record)
            r = redis.from_url(self._redis_url)
            r.xadd(
                self._stream_key,
                {"line": line},
                maxlen=self._maxlen,
                approximate=True,
            )
        except Exception:
            pass


def _start_stop_polling() -> None:
    """Start a daemon thread in this worker process that polls Redis for stop request; exits process when set.
    Must run in the worker process (worker_process_init), not the main process (worker_ready), so that with
    --concurrency=1 the process that has the IB connection is the one that polls and calls disconnect + exit.
    """
    import threading
    import time

    def poll() -> None:
        try:
            import redis
            interval_sec = 2
            logger.info("Celery worker stop-poll thread started (checks Redis every %ds)", interval_sec)
            while True:
                logger.debug("Stop-poll: next check in %ds", interval_sec)
                time.sleep(interval_sec)
                try:
                    with redis.from_url(broker_url) as r:
                        if not r.get(WORKER_STOP_REQUESTED_KEY):
                            continue
                        try:
                            r.delete(WORKER_STOP_REQUESTED_KEY)
                        except Exception:
                            pass
                    # connection closed; disconnect IB and exit
                    try:
                        from servers.bars_tasks import disconnect_worker_ib_sync
                        disconnect_worker_ib_sync(timeout=5.0)
                    except Exception as e:
                        logger.warning("Worker stop: disconnect_worker_ib_sync failed: %s", e)
                    logger.info("Celery worker stop requested via API; exiting process.")
                    os._exit(0)
                except Exception as e:
                    logger.debug("Worker stop-poll Redis check: %s", e)
        except Exception as e:
            logger.warning("Worker stop-poll thread error: %s", e)

    t = threading.Thread(target=poll, daemon=True, name="celery-worker-stop-poll")
    t.start()


from celery.signals import worker_ready, worker_process_init, worker_init  # noqa: E402


def _attach_redis_stream_log_handler() -> None:
    """Attach Redis stream log handler to root logger so all Celery/worker logs go to Redis (for UI console)."""
    root = logging.getLogger()
    for h in root.handlers[:]:
        if isinstance(h, _RedisStreamLogHandler):
            return
    handler = _RedisStreamLogHandler(
        broker_url,
        CELERY_LOG_STREAM_KEY,
        maxlen=CELERY_LOG_STREAM_MAXLEN,
    )
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(name)s: %(message)s")
    )
    root.addHandler(handler)


@worker_init.connect
def _on_worker_init(sender=None, **kwargs: object) -> None:
    """Attach Redis log handler; with solo pool also start stop-poll (single process, no worker_process_init)."""
    _attach_redis_stream_log_handler()
    # Solo pool: single process, tasks run in this process. Start stop-poll here so Stop button works.
    if sender is not None and getattr(sender, "pool", None) is not None:
        pool_module = getattr(type(sender.pool), "__module__", "") or ""
        if "solo" in pool_module:
            _start_stop_polling()


@worker_process_init.connect
def _on_worker_process_init(**kwargs: object) -> None:
    _attach_redis_stream_log_handler()
    # Stop polling must run in worker process (the one with IB connection when concurrency=1), not main process.
    _start_stop_polling()


@worker_ready.connect
def _on_worker_ready(sender, **kwargs) -> None:
    pass
