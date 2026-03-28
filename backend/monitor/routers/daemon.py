"""Daemon control: POST /control/* (stop, flatten, suspend, resume, retry_ib, release_ib, refresh_*, set_heartbeat_interval, monitor_stop, monitor_release_ib, celery_stop, monitor_connect)."""

import asyncio
import json
import logging
import os
import threading
import time
from typing import Any, Dict, Optional

MONITOR_STOP_DISCONNECT_TIMEOUT = 2.5  # seconds; avoid hang if IB disconnect blocks
MONITOR_STOP_EXIT_DELAY = 3.0  # seconds; give client time to receive 200 before process exits

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from src.monitor.integrations.ib_clients import AccountIbClient, MarketIbClient
from servers.reader import (
    sync_accounts_snapshot_to_db,
    write_control_command,
    write_heartbeat_interval,
    write_run_status,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["daemon"])


def _exit_after_send() -> None:
    time.sleep(MONITOR_STOP_EXIT_DELAY)  # give client time to receive response before exit
    logger.info("Monitor stop: exiting process.")
    os._exit(0)


@router.post("/control/monitor_stop")
async def post_monitor_stop(request: Request) -> JSONResponse:
    """Stop monitor-side IB activity AND terminate the monitor process itself.
    Disconnects are wrapped in a short timeout so a stuck IB API cannot block the response;
    disconnects run concurrently so total wait is one timeout, not three; exit is delayed
    so the client can receive 200 before the process exits."""
    app = request.app
    app.state.monitor_enabled = False

    async def _disconnect_with_timeout(client: Any, name: str) -> None:
        try:
            await asyncio.wait_for(client.disconnect(), timeout=MONITOR_STOP_DISCONNECT_TIMEOUT)
        except asyncio.TimeoutError:
            logger.warning("monitor_stop: %s disconnect timed out after %.1fs; process will exit anyway.", name, MONITOR_STOP_DISCONNECT_TIMEOUT)
        except Exception as e:
            logger.debug("monitor_stop: %s disconnect error (ignored): %s", name, e)

    tasks: list = []
    client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
    if client is not None:
        tasks.append(_disconnect_with_timeout(client, "account_ib_client"))
    mclient: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
    if mclient is not None:
        tasks.append(_disconnect_with_timeout(mclient, "market_ib_client"))
    acc2 = getattr(app.state, "account_ib_client_2", None)
    if acc2 is not None:
        tasks.append(_disconnect_with_timeout(acc2, "account_ib_client_2"))
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)

    threading.Thread(target=_exit_after_send, daemon=True).start()
    return JSONResponse(status_code=200, content={"ok": True, "monitor_enabled": False})


@router.post("/control/monitor_release_ib")
async def post_monitor_release_ib(request: Request) -> JSONResponse:
    """Release Monitor IB connections only (Account + Market + Account2 client_id). Monitor process keeps running."""
    app = request.app
    try:
        acc_client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
        if acc_client is not None:
            await acc_client.disconnect()
    except Exception as e:
        logger.warning("monitor_release_ib account disconnect: %s", e)
    try:
        acc_client_2 = getattr(app.state, "account_ib_client_2", None)
        if acc_client_2 is not None:
            await acc_client_2.disconnect()
    except Exception as e:
        logger.warning("monitor_release_ib account2 disconnect: %s", e)
    try:
        mkt_client: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
        if mkt_client is not None:
            await mkt_client.disconnect()
    except Exception as e:
        logger.warning("monitor_release_ib market disconnect: %s", e)
    return JSONResponse(status_code=200, content={"ok": True, "message": "Monitor IB connections released."})


CELERY_STOP_REDIS_TIMEOUT = 5  # seconds; avoid hang if Redis is unreachable

@router.post("/control/celery_stop")
def post_celery_stop() -> JSONResponse:
    """Set Redis key so Celery worker exits. Worker polls every 2s; process will terminate shortly after.
    Uses a short Redis timeout so the request does not hang if the broker is unreachable."""
    try:
        import redis
        from servers.celery_app import (
            WORKER_IB_STATUS_KEY,
            WORKER_IB_STATUS_TTL_SEC,
            WORKER_STOP_REQUESTED_KEY,
            broker_url,
        )
        r = redis.from_url(
            broker_url,
            socket_connect_timeout=CELERY_STOP_REDIS_TIMEOUT,
            socket_timeout=CELERY_STOP_REDIS_TIMEOUT,
        )
        r.set(WORKER_STOP_REQUESTED_KEY, "1")
        r.setex(
            WORKER_IB_STATUS_KEY,
            WORKER_IB_STATUS_TTL_SEC,
            json.dumps({"connected": False, "client_id": 0}),
        )
        return JSONResponse(
            status_code=200,
            content={"ok": True, "message": "Celery worker stop requested; process will exit within a few seconds."},
        )
    except Exception as e:
        logger.warning("celery_stop failed: %s", e)
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@router.post("/control/monitor_connect")
async def post_monitor_connect(request: Request) -> JSONResponse:
    """Establish monitor IB connections (account + account2 + market). On success, /status monitor_ib_status.*.connected becomes true."""
    app = request.app
    if not getattr(app.state, "monitor_enabled", True):
        return JSONResponse(status_code=400, content={"ok": False, "error": "Monitor stopped; cannot connect IB."})
    acc_client: Optional[AccountIbClient] = getattr(app.state, "account_ib_client", None)
    acc_client_2: Optional[AccountIbClient] = getattr(app.state, "account_ib_client_2", None)
    mkt_client: Optional[MarketIbClient] = getattr(app.state, "market_ib_client", None)
    if acc_client is None and acc_client_2 is None and mkt_client is None:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "Monitor IB clients not initialized (check startup logs or DB IB settings)."},
        )
    acc_ok: Optional[bool] = None
    acc_err: Optional[str] = None
    acc2_ok: Optional[bool] = None
    acc2_err: Optional[str] = None
    mkt_ok: Optional[bool] = None
    mkt_err: Optional[str] = None
    if acc_client is not None:
        try:
            await acc_client.ensure_connected()
            acc_ok = True
        except Exception as e:
            acc_ok = False
            acc_err = str(e)
    if acc_client_2 is not None:
        try:
            await acc_client_2.ensure_connected()
            acc2_ok = True
        except Exception as e:
            acc2_ok = False
            acc2_err = str(e)
    if mkt_client is not None:
        try:
            await mkt_client.ensure_connected()
            mkt_ok = True
        except Exception as e:
            mkt_ok = False
            mkt_err = str(e)
    ok = (acc_ok is not False) and (acc2_ok is not False) and (mkt_ok is not False)
    status_code = 200 if ok else 500
    return JSONResponse(
        status_code=status_code,
        content={
            "ok": ok,
            "account": {"requested": acc_client is not None, "success": acc_ok, "error": acc_err},
            "account2": {"requested": acc_client_2 is not None, "success": acc2_ok, "error": acc2_err},
            "market": {"requested": mkt_client is not None, "success": mkt_ok, "error": mkt_err},
        },
    )


@router.post("/control/stop")
def post_control_stop(request: Request) -> JSONResponse:
    """Insert 'stop' into daemon_control; daemon will request_stop() on next heartbeat (R-C1b)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "stop"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "stop written to daemon_control"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/flatten")
def post_control_flatten(request: Request) -> JSONResponse:
    """Insert 'flatten' into daemon_control. R-C3 not implemented in daemon yet; daemon logs and continues."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "flatten"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "flatten written to daemon_control (daemon may not implement yet)"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/suspend")
def post_control_suspend(request: Request) -> JSONResponse:
    """Set daemon_run_status.suspended=true; daemon will pause hedging until resume (R-C2-style)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_run_status(control_via_db, suspended=True):
        return JSONResponse(status_code=200, content={"ok": True, "message": "trading suspended (daemon will not hedge until resume)"})
    return JSONResponse(status_code=500, content={"error": "failed to set run status"})


@router.post("/control/resume")
def post_control_resume(request: Request) -> JSONResponse:
    """Set daemon_run_status.suspended=false; daemon will resume hedging. Also write retry_ib so daemon in WAITING_IB reconnects Trading Client."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if not write_run_status(control_via_db, suspended=False):
        return JSONResponse(status_code=500, content={"error": "failed to set run status"})
    write_control_command(control_via_db, "retry_ib")
    return JSONResponse(status_code=200, content={"ok": True, "message": "trading resumed; retry_ib written for daemon to reconnect IB Trading Client"})


@router.post("/control/retry_ib")
def post_control_retry_ib(request: Request) -> JSONResponse:
    """Insert 'retry_ib' into daemon_control; daemon will attempt IB connect on next poll (RE-7)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "retry_ib"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "retry_ib written to daemon_control"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/release_ib")
def post_control_release_ib(request: Request) -> JSONResponse:
    """Insert 'release_ib' into daemon_control; daemon will release IB connection on next heartbeat (disconnect → WAITING_IB)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "release_ib"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "release_ib written to daemon_control"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/refresh_accounts")
async def post_control_refresh_accounts(request: Request) -> JSONResponse:
    """Fetch accounts/positions from IB via monitor AccountIbClient(s) and write to DB."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    acc_client = getattr(request.app.state, "account_ib_client", None)
    if acc_client is None:
        return JSONResponse(
            status_code=503,
            content={"error": "Monitor Account Client not initialized; check service startup and IB config (Settings)."},
        )
    try:
        accounts_list = await acc_client.fetch_accounts_snapshot()
        acc_client_2 = getattr(request.app.state, "account_ib_client_2", None)
        if acc_client_2 is not None:
            try:
                accounts_list_2 = await acc_client_2.fetch_accounts_snapshot()
                if accounts_list_2:
                    accounts_list = (accounts_list or []) + accounts_list_2
            except Exception as e2:
                logger.warning("refresh_accounts AccountIbClient2 failed: %s", e2)
        if not accounts_list:
            return JSONResponse(
                status_code=200,
                content={"ok": True, "message": "No account data received (IB may not have returned managed accounts)."},
            )
        if not sync_accounts_snapshot_to_db(control_via_db, accounts_list):
            return JSONResponse(status_code=500, content={"error": "Failed to write account data to DB; try again later."})
        return JSONResponse(
            status_code=200,
            content={"ok": True, "message": "Accounts/positions fetched from IB via monitor and written to DB."},
        )
    except Exception as e:
        logger.warning("refresh_accounts via AccountIbClient failed: %s", e, exc_info=True)
        return JSONResponse(status_code=500, content={"ok": False, "error": str(e)})


@router.post("/control/refresh_replay")
def post_control_refresh_replay(request: Request) -> JSONResponse:
    """Insert 'refresh_replay' into daemon_control; daemon will sync executions from IB to account_executions on next poll."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "refresh_replay"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "refresh_replay written to daemon_control"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/refresh_ticker_subscriptions")
def post_control_refresh_ticker_subscriptions(request: Request) -> JSONResponse:
    """Insert 'refresh_ticker_subscriptions' into daemon_control; daemon will Release then Init on next poll."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "refresh_ticker_subscriptions"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "refresh_ticker_subscriptions written to daemon_control"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/release_ticker_subscriptions")
def post_control_release_ticker_subscriptions(request: Request) -> JSONResponse:
    """Insert 'release_ticker_subscriptions' into daemon_control; daemon will unsubscribe all tickers on next poll."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "release_ticker_subscriptions"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "release_ticker_subscriptions written to daemon_control"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/init_ticker_subscriptions")
def post_control_init_ticker_subscriptions(request: Request) -> JSONResponse:
    """Insert 'init_ticker_subscriptions' into daemon_control; daemon will subscribe to watchlist+positions if none subscribed, else set last_control_message."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_control_command(control_via_db, "init_ticker_subscriptions"):
        return JSONResponse(status_code=200, content={"ok": True, "message": "init_ticker_subscriptions written to daemon_control"})
    return JSONResponse(status_code=500, content={"error": "failed to write control command"})


@router.post("/control/set_heartbeat_interval")
def post_set_heartbeat_interval(request: Request, body: Dict[str, Any] = Body(...)) -> JSONResponse:
    """Set daemon_run_status.heartbeat_interval_sec (5–120). Daemon polls and uses this on next heartbeat."""
    control_via_db = request.app.state.control_via_db
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
