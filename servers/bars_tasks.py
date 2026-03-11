"""Celery tasks for bars backfill. Task updates bars_backfill_jobs row when done.

Worker process hosts a single long-lived IB connection (MarketIbClient) in a dedicated asyncio
loop thread; tasks reuse it to avoid reconnecting every time (which triggers duplicate data pulls).
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from pathlib import Path
from typing import Any, Dict, Optional
from src.connector.ib import IBConnectionDroppedError

# Project root for config
_here = Path(__file__).resolve().parent
_project_root = _here.parent  # servers/ -> project root
if str(_project_root) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(_project_root))

from servers.celery_app import app  # noqa: E402
from servers.celery_app import WORKER_IB_STATUS_KEY, WORKER_IB_STATUS_TTL_SEC  # noqa: E402
from servers.celery_app import WORKER_STOP_REQUESTED_KEY  # noqa: E402

logger = logging.getLogger(__name__)


def _is_bars_skip_ib(status_cfg: Optional[Dict[str, Any]] = None) -> bool:
    """True = 仅跳过“拉取数据”的调用（fetch_bars_range 等），连接 IB 逻辑照常。可配 status.bars_skip_ib 或 环境变量 BIFROST_BARS_SKIP_IB=1。"""
    if os.environ.get("BIFROST_BARS_SKIP_IB", "").strip() in ("1", "true", "yes"):
        return True
    if status_cfg is not None:
        return bool(status_cfg.get("bars_skip_ib"))
    try:
        from src.app.config import read_config
        config, _ = read_config()
        return bool((config.get("status") or {}).get("bars_skip_ib"))
    except Exception:
        return False


def _connect_ib_at_startup() -> None:
    """Called from worker_process_init: ensure loop is running and schedule IB connect in background (persistent connection).
    Actual connect runs shortly after in the loop; we avoid blocking process init for more than ~2s.
    """
    logger.info("Worker process init: starting IB loop and scheduling connect (connect will run in background).")
    try:
        _ensure_worker_loop()
    except Exception as e:
        logger.warning("Worker startup: ensure_worker_loop failed: %s", e)
        return
    loop = _worker_loop
    if not loop or not loop.is_running():
        logger.warning("Worker startup: loop not running after ensure_worker_loop.")
        return

    async def _connect() -> None:
        try:
            from src.app.config import read_config
            from servers.reader import StatusReader
            config, _ = read_config()
            reader = StatusReader(config)
            ib_cfg = reader.get_ib_config() or {}
            await _get_or_create_worker_ib_client(ib_cfg)
        except Exception as e:
            logger.warning("Worker startup IB connect failed: %s (poll loop will retry every 30s)", e)

    try:
        asyncio.run_coroutine_threadsafe(_connect(), loop)
        logger.info("Worker startup: IB connect and poll loop scheduled.")
    except Exception as e:
        logger.warning("Worker startup: schedule connect failed: %s", e)
        return

    try:
        asyncio.run_coroutine_threadsafe(_worker_connect_poll_loop(), loop)
    except Exception as e:
        logger.warning("Worker startup: schedule connect poll failed: %s", e)


async def _worker_connect_poll_loop() -> None:
    """When not connected and no STOP requested, retry establishing IB every 30s.
    First iteration waits 3s so TWS/DB have time to be ready after process init.
    """
    global _worker_ib_client
    import time
    last_auto_retry = 0.0
    first_run = True
    while True:
        # First time: shorter delay so we try connect soon after startup (3s)
        delay = 3 if first_run else 5
        logger.debug("Connect poll: next check in %ds", delay)
        await asyncio.sleep(delay)
        first_run = False
        try:
            import redis
            from servers.celery_app import broker_url
            r = redis.from_url(broker_url)
            if r.get(WORKER_STOP_REQUESTED_KEY):
                if _worker_ib_client is not None:
                    try:
                        await _worker_ib_client.disconnect()
                    except Exception:
                        pass
                    _worker_ib_client = None
                _write_worker_ib_status(False, 0)
                return
            connected = _worker_ib_client is not None and getattr(_worker_ib_client, "connected", False)
            # Auto-retry: if still not connected, try every 30s (e.g. startup failed because TWS was not ready)
            if not connected and (not _worker_ib_client or not getattr(_worker_ib_client, "connected", False)):
                now = time.time()
                if now - last_auto_retry >= 30:
                    last_auto_retry = now
                    try:
                        from src.app.config import read_config
                        from servers.reader import StatusReader
                        config, _ = read_config()
                        reader = StatusReader(config)
                        ib_cfg = reader.get_ib_config() or {}
                        await _get_or_create_worker_ib_client(ib_cfg)
                    except Exception as e:
                        logger.debug("Worker auto-retry IB connect: %s", e)
        except Exception as e:
            logger.debug("Worker connect poll: %s", e)


# --- Worker process singleton: one asyncio loop in a daemon thread, one MarketIbClient in that loop ---
_worker_loop: Optional[asyncio.AbstractEventLoop] = None
_worker_loop_ready = threading.Event()
_loop_lock = threading.Lock()
_worker_ib_client: Any = None  # MarketIbClient, only used from loop thread
_worker_ib_heartbeat_task: Any = None  # asyncio.Task for periodic status write
_worker_last_bars_job_finished_ts: Optional[float] = None
_worker_last_bars_job_interval_sec: float = 0.0


async def _wait_for_bars_job_cooldown(
    job_id: int,
    symbol: str,
    period: str,
    api_interval_sec: Optional[int],
) -> None:
    """Throttle gaps between consecutive bars jobs in the worker process.

    `api_interval_sec` already spaces IB requests *within* one job. We also apply
    a cooldown *between* jobs so a fast-finishing task does not let the next task
    hit IB immediately and trip pacing limits.
    """
    global _worker_last_bars_job_finished_ts, _worker_last_bars_job_interval_sec

    current_gap_sec = float(api_interval_sec) if api_interval_sec is not None and api_interval_sec > 0 else 0.0
    required_gap_sec = max(current_gap_sec, _worker_last_bars_job_interval_sec)
    if required_gap_sec <= 0 or _worker_last_bars_job_finished_ts is None:
        return

    elapsed_sec = max(0.0, __import__("time").time() - _worker_last_bars_job_finished_ts)
    wait_sec = max(0.0, required_gap_sec - elapsed_sec)
    if wait_sec <= 0:
        return

    logger.info(
        "Bars task job_id=%s symbol=%s period=%s waiting %.2fs before start "
        "(between-job cooldown, required_gap=%.2fs, elapsed=%.2fs)",
        job_id,
        symbol,
        period,
        wait_sec,
        required_gap_sec,
        elapsed_sec,
    )
    await asyncio.sleep(wait_sec)


def _write_worker_ib_status(connected: bool, client_id: int) -> None:
    """Write Worker IB status to Redis for API/UI (same semantics as Monitor/Daemon IB)."""
    try:
        import redis
        from servers.celery_app import broker_url
        r = redis.from_url(broker_url)
        r.setex(
            WORKER_IB_STATUS_KEY,
            WORKER_IB_STATUS_TTL_SEC,
            json.dumps({"connected": connected, "client_id": client_id}),
        )
    except Exception as e:
        logger.debug("_write_worker_ib_status failed: %s", e)


def _ensure_worker_loop() -> None:
    """Start the dedicated asyncio loop in a daemon thread if not already running."""
    global _worker_loop
    if _worker_loop is not None and _worker_loop.is_running():
        return
    with _loop_lock:
        if _worker_loop is not None and _worker_loop.is_running():
            return
        _worker_loop_ready.clear()

        def _run_loop() -> None:
            global _worker_loop
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            _worker_loop = loop
            _worker_loop_ready.set()
            try:
                loop.run_forever()
            finally:
                loop.close()

        t = threading.Thread(target=_run_loop, daemon=True, name="celery-bars-ib-loop")
        t.start()
    if not _worker_loop_ready.wait(timeout=2.0):
        raise RuntimeError("Worker IB loop failed to start within 2s")


async def _get_or_create_worker_ib_client(ib_cfg: Dict[str, Any]) -> Any:
    """Create or return the process-wide MarketIbClient. Must run inside worker loop."""
    global _worker_ib_client
    from servers.ib_clients import MarketIbClient
    host = (ib_cfg.get("ib_host") or "127.0.0.1").strip()
    port_type = (ib_cfg.get("ib_port_type") or "tws_paper").strip().lower()
    port_map = {"tws_live": 7496, "tws_paper": 7497, "gateway": 4002}
    port = port_map.get(port_type, 7497)
    desired_client_id = int(ib_cfg.get("ib_client_id_worker_market", 500))
    if _worker_ib_client is not None:
        same_endpoint = (
            getattr(_worker_ib_client, "host", None) == host
            and getattr(_worker_ib_client, "port", None) == port
            and int(getattr(_worker_ib_client, "client_id", desired_client_id)) == desired_client_id
        )
        if same_endpoint and getattr(_worker_ib_client, "connected", False):
            return _worker_ib_client
        reason = "stale disconnected worker client"
        if not same_endpoint:
            reason = (
                f"worker IB settings changed "
                f"(host={host} port={port} client_id={desired_client_id})"
            )
        await _reset_worker_ib_client(reason)
    _worker_ib_client = MarketIbClient(host=host, port=port, client_id=desired_client_id, name="CeleryBarsWorker")
    await _worker_ib_client.ensure_connected()
    actual_client_id = int(getattr(_worker_ib_client, "client_id", desired_client_id))
    _write_worker_ib_status(True, actual_client_id)
    _start_worker_ib_heartbeat(actual_client_id)
    logger.info("Celery worker IB client connected (host=%s port=%s client_id=%s), will reuse for subsequent jobs", host, port, actual_client_id)
    return _worker_ib_client


async def _reset_worker_ib_client(reason: str) -> None:
    """Drop the shared Worker IB client so the next use will reconnect from fresh settings."""
    global _worker_ib_client
    if _worker_ib_client is None:
        _write_worker_ib_status(False, 0)
        return
    logger.warning("Resetting Celery worker IB client: %s", reason)
    try:
        await _worker_ib_client.disconnect()
    except Exception as e:
        logger.debug("_reset_worker_ib_client disconnect: %s", e)
    finally:
        _worker_ib_client = None
        _write_worker_ib_status(False, 0)


def _start_worker_ib_heartbeat(client_id: int) -> None:
    """Start background task that refreshes Worker IB status in Redis every 30s (so UI stays green when idle)."""
    global _worker_ib_heartbeat_task
    if _worker_ib_heartbeat_task is not None and not _worker_ib_heartbeat_task.done():
        return

    async def _heartbeat() -> None:
        global _worker_ib_client
        while True:
            await asyncio.sleep(30)
            try:
                import redis
                from servers.celery_app import broker_url
                r = redis.from_url(broker_url)
                if r.get(WORKER_STOP_REQUESTED_KEY):
                    if _worker_ib_client is not None:
                        try:
                            await _worker_ib_client.disconnect()
                        except Exception:
                            pass
                        _worker_ib_client = None
                    _write_worker_ib_status(False, 0)
                    return
            except Exception:
                pass
            if _worker_ib_client is not None and getattr(_worker_ib_client, "connected", False):
                cid = getattr(_worker_ib_client, "client_id", client_id)
                _write_worker_ib_status(True, cid)

    loop = _worker_loop
    if loop is not None and loop.is_running():
        _worker_ib_heartbeat_task = loop.create_task(_heartbeat())


def disconnect_worker_ib_sync(timeout: float = 5.0) -> None:
    """Synchronous disconnect of Worker IB client (for use before process exit, e.g. from stop-poll thread).
    Schedules disconnect on the worker loop and waits up to `timeout` seconds. Safe to call from any thread.
    """
    global _worker_loop, _worker_ib_client
    if _worker_loop is None or not _worker_loop.is_running():
        return
    if _worker_ib_client is None:
        return

    async def _do_disconnect() -> None:
        global _worker_ib_client
        if _worker_ib_client is not None:
            try:
                await _worker_ib_client.disconnect()
            except Exception as e:
                logger.debug("disconnect_worker_ib_sync: %s", e)
            _worker_ib_client = None
        _write_worker_ib_status(False, 0)

    try:
        future = asyncio.run_coroutine_threadsafe(_do_disconnect(), _worker_loop)
        future.result(timeout=timeout)
    except Exception as e:
        logger.debug("disconnect_worker_ib_sync wait: %s", e)


def _worker_process_init_connect_ib() -> None:
    """Signal handler: connect to IB when worker process is ready (persistent connection like Monitor/Daemon)."""
    _connect_ib_at_startup()


from celery.signals import worker_process_init  # noqa: E402
worker_process_init.connect(lambda *a, **k: _worker_process_init_connect_ib())


async def _run_backfill_in_loop(
    status_cfg: Dict[str, Any],
    job_id: int,
    symbol: str,
    period: str,
    years: Optional[float],
    days: Optional[int],
    override_days: Optional[float],
    span_hours: Optional[float] = None,
) -> Dict[str, Any]:
    """Run one backfill inside the worker loop using the shared IB client. All DB/reader use happens in this loop thread.
    Uses years/days/override_days/span_hours from the job row (DB) when present, so configured range is applied.
    """
    global _worker_last_bars_job_finished_ts, _worker_last_bars_job_interval_sec
    from servers.reader import StatusReader, get_bars_backfill_job, update_bars_backfill_job_result
    from servers.bars_backfill import run_one_backfill

    update_bars_backfill_job_result(status_cfg, job_id, "running", None)
    job_row = get_bars_backfill_job(status_cfg, job_id) or {}
    # Prefer job row span params (what API stored when enqueueing) so Custom/Max/Min range is respected
    if job_row.get("years") is not None:
        years = float(job_row["years"])
    if job_row.get("days") is not None:
        days = int(job_row["days"])
    if job_row.get("override_days") is not None:
        override_days = float(job_row["override_days"])
    if job_row.get("span_hours") is not None:
        span_hours = float(job_row["span_hours"])
    skip_fetch = bool(job_row.get("skip_ib")) or _is_bars_skip_ib(status_cfg)
    api_interval_sec = job_row.get("api_interval_sec")
    if api_interval_sec is not None:
        api_interval_sec = max(0, min(300, int(api_interval_sec)))

    last_disconnect_error: Optional[Exception] = None
    for attempt in range(1, 3):
        reader = StatusReader(status_cfg)
        ib_cfg = reader.get_ib_config() or {}
        try:
            await _wait_for_bars_job_cooldown(job_id, symbol, period, api_interval_sec)
            client = await _get_or_create_worker_ib_client(ib_cfg)
            result = await run_one_backfill(
                reader,
                client,
                status_cfg,
                symbol=symbol,
                period=period,
                years=years,
                days=days,
                override_days=override_days,
                span_hours=span_hours,
                skip_fetch=skip_fetch,
                api_interval_sec=api_interval_sec,
            )
            status = "done" if result.get("ok") else "failed"
            update_bars_backfill_job_result(status_cfg, job_id, status, result)
            _worker_last_bars_job_finished_ts = __import__("time").time()
            _worker_last_bars_job_interval_sec = float(api_interval_sec) if api_interval_sec is not None and api_interval_sec > 0 else 0.0
            return result
        except IBConnectionDroppedError as e:
            last_disconnect_error = e
            logger.warning(
                "Bars task job_id=%s IB connection dropped on attempt %s/2: %s",
                job_id,
                attempt,
                e,
            )
            await _reset_worker_ib_client(f"connection dropped during backfill job_id={job_id}")
            if attempt < 2:
                continue
            break

    result = {
        "ok": False,
        "error": f"Worker IB connection dropped during backfill and reconnect retry failed: {last_disconnect_error}",
    }
    update_bars_backfill_job_result(status_cfg, job_id, "failed", result)
    _worker_last_bars_job_finished_ts = __import__("time").time()
    _worker_last_bars_job_interval_sec = float(api_interval_sec) if api_interval_sec is not None and api_interval_sec > 0 else 0.0
    return result


@app.task(bind=True, name="servers.bars_tasks.backfill_bars")
def backfill_bars(
    self,
    symbol: str,
    period: str,
    years: float | None = None,
    days: int | None = None,
    override_days: float | None = None,
    span_hours: float | None = None,
):
    """Run one bars backfill. task_id must be set to bars_backfill_jobs.id when enqueued.
    Uses the worker process's shared IB connection; updates bars_backfill_jobs row when done.
    """
    job_id_str = self.request.id
    try:
        job_id = int(job_id_str)
    except (TypeError, ValueError):
        logger.error("backfill_bars: invalid job_id task_id=%s", job_id_str)
        return {"ok": False, "error": "invalid job_id"}

    try:
        from src.app.config import read_config
        from servers.reader import update_bars_backfill_job_result
    except ImportError as e:
        logger.exception("backfill_bars: import failed: %s", e)
        _update_result(job_id, "failed", {"ok": False, "error": str(e)})
        return {"ok": False, "error": str(e)}

    args = [a for a in __import__("sys").argv[1:] if not a.startswith("--")]
    config_path = args[0] if args else None
    if config_path and not os.path.isabs(config_path):
        config_path = os.path.join(_project_root, config_path)
    elif config_path is None:
        config_path = os.path.join(_project_root, "config", "config.yaml")
    if not os.path.isfile(config_path):
        _update_result(job_id, "failed", {"ok": False, "error": f"Config not found: {config_path}"}, config_path=config_path)
        return {"ok": False, "error": "Config not found"}

    config, _ = read_config(config_path)
    if not config.get("postgres") and not os.environ.get("PGHOST"):
        _update_result(job_id, "failed", {"ok": False, "error": "postgres required"}, status_cfg=config)
        return {"ok": False, "error": "postgres required"}

    control_via_db = config
    sym = (symbol or "").strip().upper()
    per = (period or "1 D").strip()

    _ensure_worker_loop()
    loop = _worker_loop
    if loop is None or not loop.is_running():
        _update_result(job_id, "failed", {"ok": False, "error": "Worker IB loop not running"}, status_cfg=config)
        return {"ok": False, "error": "Worker IB loop not running"}

    logger.info("Bars task job_id=%s symbol=%s period=%s running (shared IB client)", job_id, sym, per)
    try:
        future = asyncio.run_coroutine_threadsafe(
            _run_backfill_in_loop(
                control_via_db,
                job_id,
                sym,
                per,
                years,
                days,
                override_days,
                span_hours,
            ),
            loop,
        )
        result = future.result(timeout=600)
    except TimeoutError:
        logger.exception("Bars task job_id=%s timed out after 600s", job_id)
        result = {"ok": False, "error": "Job timed out after 600s"}
        update_bars_backfill_job_result(control_via_db, job_id, "failed", result)
    except Exception as e:
        logger.exception("Bars task job_id=%s failed: %s", job_id, e)
        result = {"ok": False, "error": str(e)}
        update_bars_backfill_job_result(control_via_db, job_id, "failed", result)

    status = "done" if result.get("ok") else "failed"
    logger.info("Bars task job_id=%s status=%s", job_id, status)
    return result


def _update_result(
    job_id: int,
    status: str,
    result: dict,
    *,
    status_cfg: Optional[Dict[str, Any]] = None,
    config_path: Optional[str] = None,
) -> None:
    """Update bars_backfill_jobs row when status_cfg or config is available."""
    try:
        from src.app.config import read_config
        from servers.reader import update_bars_backfill_job_result
        if status_cfg:
            cfg = status_cfg
        elif config_path:
            config, _ = read_config(config_path)
            cfg = config.get("status") or {}
        else:
            config, _ = read_config()
            cfg = config.get("status") or {}
        if cfg:
            update_bars_backfill_job_result(cfg, job_id, status, result)
    except Exception as e:
        logger.warning("_update_result failed: %s", e)
