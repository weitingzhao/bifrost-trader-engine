"""Status endpoints: run status, operations, risk summary."""

import logging
import os
import threading
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query, Request

from src.monitor.reader import get_job_bars_backfill_last_updated
from src.monitor.self_check import derive_daemon_self_check, derive_self_check

logger = logging.getLogger(__name__)

router = APIRouter(tags=["status"])

_status_cache_lock = threading.Lock()
_status_cache: Dict[str, Any] = {}
_status_cache_ts: float = 0.0
_STATUS_CACHE_TTL = 2.0

# GET /status polls often; Celery control.inspect waits the full timeout when no worker replies.
# Ops uses longer CELERY_INSPECT_TIMEOUT_SEC in celery_app (e.g. 15s) for worker snapshots.
_STATUS_CELERY_INSPECT_TIMEOUT_SEC = float(
    os.environ.get("BIFROST_STATUS_CELERY_INSPECT_TIMEOUT_SEC", "2.0")
)


@router.get("/status")
def get_status(request: Request) -> Dict[str, Any]:
    """Return current run status plus self_check, status_lamp, trading_suspended (R-M1b, R-M2, R-M3). Never returns 5xx: on read error returns 200 with blocked/red."""
    global _status_cache, _status_cache_ts
    now = time.monotonic()
    with _status_cache_lock:
        if _status_cache and (now - _status_cache_ts) < _STATUS_CACHE_TTL:
            return _status_cache
    app = request.app
    reader = app.state.reader
    control_via_db = app.state.control_via_db
    data_lag_threshold_ms = app.state.data_lag_threshold_ms
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
                "listener_2_connected": hb.get("listener_2_connected", False),
                "listener_2_client_id": hb.get("listener_2_client_id"),
                "next_retry_ts": hb.get("next_retry_ts"),
                "seconds_until_retry": hb.get("seconds_until_retry"),
                "graceful_shutdown_at": hb.get("graceful_shutdown_at"),
                "heartbeat_interval_sec": hb.get("heartbeat_interval_sec"),
                "redis_quotes_connected": hb.get("redis_quotes_connected", False),
                "event_subscribe_ticker": hb.get("event_subscribe_ticker", False),
                "event_subscribe_positions": hb.get("event_subscribe_positions", False),
                "event_subscribe_fills": hb.get("event_subscribe_fills", False),
                "event_subscribe_commission": hb.get("event_subscribe_commission", False),
                "event_subscribe_positions_ib2": hb.get("event_subscribe_positions_ib2", False),
                "event_subscribe_fills_ib2": hb.get("event_subscribe_fills_ib2", False),
                "event_subscribe_commission_ib2": hb.get("event_subscribe_commission_ib2", False),
                "last_control_message": hb.get("last_control_message"),
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
        symbols_set: set = set()
        if row and row.get("symbol"):
            symbols_set.add(str(row.get("symbol", "") or "").strip())
        for w in reader.get_watchlist():
            st = (w.get("sec_type") or "").strip().upper()
            sym = (w.get("symbol") or "").strip()
            if sym and (st == "STK" or not st):
                symbols_set.add(sym)
        # Prefer actual daemon subscription list (written each heartbeat) so UI reflects Release / restore in time
        if hb is not None and hb.get("subscribed_tickers") is not None and isinstance(hb["subscribed_tickers"], list):
            payload["subscribed_tickers"] = sorted(s for s in hb["subscribed_tickers"] if s and str(s).strip())
        else:
            payload["subscribed_tickers"] = sorted(s for s in symbols_set if s)
        payload["reference_indices"] = (control_via_db or {}).get("reference_indices") or []
        payload["accounts"] = reader.get_accounts_from_tables()
        if payload["accounts"] is None:
            payload["accounts"] = []
        payload["accounts_fetched_at"] = reader.get_accounts_fetched_at()
        payload["ib_config"] = reader.get_ib_config() or {}
        payload["flex_config"] = reader.get_flex_config()
        payload["open_orders"] = reader.get_open_orders()
        # Phase A: active strategy structure and gate safety set (management & monitoring)
        payload["active_strategy_structure_id"] = reader.get_active_strategy_structure_id()
        payload["active_gate_safety_strategy_id"] = reader.get_active_gate_safety_strategy_id()
        payload["active_strategy_allocation_id"] = reader.get_active_strategy_allocation_id()
        try:
            sid = payload.get("active_strategy_structure_id")
            row = reader.get_structure_by_id(sid) if sid is not None else None
            payload["active_strategy_structure_name"] = row.get("name") if row else None
        except Exception:
            payload["active_strategy_structure_name"] = None
        try:
            gid = payload.get("active_gate_safety_strategy_id")
            payload["active_gate_safety_strategy_name"] = (
                reader.get_gate_safety_name(gid) if gid is not None else None
            )
        except Exception:
            payload["active_gate_safety_strategy_name"] = None
        try:
            aid = payload.get("active_strategy_allocation_id")
            row = reader.get_allocation_by_id(aid) if aid is not None else None
            payload["active_strategy_allocation_name"] = row.get("name") if row else None
        except Exception:
            payload["active_strategy_allocation_name"] = None
        try:
            from src.ib_gateway.client import build_monitor_ib_status

            ib_cfg = payload.get("ib_config") or {}
            gw_status = build_monitor_ib_status(reader._config, ib_cfg if isinstance(ib_cfg, dict) else None)
            if gw_status is not None:
                payload["monitor_ib_status"] = gw_status
            else:
                payload["monitor_ib_status"] = None
        except Exception:
            payload["monitor_ib_status"] = None
        monitor_enabled = bool(getattr(app.state, "monitor_enabled", True))
        payload["monitor_enabled"] = monitor_enabled
        payload["monitor_health"] = "ok"
        monitor_block_reasons: list = []
        monitor_status_obj = payload.get("monitor_ib_status") or {}
        acc_status = monitor_status_obj.get("account") or {}
        acc2_status = monitor_status_obj.get("account2") or {}
        mkt_status = monitor_status_obj.get("market") or {}
        if not monitor_enabled:
            monitor_block_reasons.append("monitor_stopped")
        if acc_status.get("last_error") or acc2_status.get("last_error") or mkt_status.get("last_error"):
            monitor_block_reasons.append("monitor_ib_error")
        if not monitor_enabled:
            monitor_self_check = "blocked"
            monitor_lamp = "red"
        elif "monitor_ib_error" in monitor_block_reasons:
            monitor_self_check = "degraded"
            monitor_lamp = "yellow"
        else:
            monitor_self_check = "ok"
            acc_conn = bool(acc_status.get("connected"))
            acc2_conn = bool(acc2_status.get("connected"))
            mkt_conn = bool(mkt_status.get("connected"))
            # Green when all configured clients are connected (account2 only exists when second IB is configured)
            need_acc2 = "account2" in monitor_status_obj
            if need_acc2 and not (acc_conn and acc2_conn and mkt_conn):
                monitor_lamp = "yellow" if (acc_conn or acc2_conn or mkt_conn) else "red"
            elif not acc_conn and not mkt_conn:
                monitor_lamp = "yellow"
            else:
                monitor_lamp = "green"
        payload["monitor_self_check"] = monitor_self_check
        payload["monitor_lamp"] = monitor_lamp
        payload["monitor_block_reasons"] = monitor_block_reasons
        rq = getattr(app.state, "redis_quotes", None)
        payload["redis_quotes_connected"] = bool(rq and getattr(rq, "available", False))
        try:
            from src.workers.celery_app import (
                get_celery_broker_connected,
                get_worker_ib_status,
                get_celery_workers_ping,
            )

            payload["celery_broker_connected"] = get_celery_broker_connected()
            workers_ping = get_celery_workers_ping(timeout=_STATUS_CELERY_INSPECT_TIMEOUT_SEC)
            payload["celery_workers"] = workers_ping
            worker_ib = get_worker_ib_status()
            payload["celery_worker_ib_connected"] = bool(
                worker_ib and worker_ib.get("connected") and len(workers_ping) > 0
            )
            payload["celery_worker_ib_client_id"] = worker_ib.get("client_id") if worker_ib else None
        except Exception:
            payload["celery_broker_connected"] = False
            payload["celery_worker_ib_connected"] = False
            payload["celery_worker_ib_client_id"] = None
            payload["celery_workers"] = []
        payload["celery_worker_last_updated_ts"] = get_job_bars_backfill_last_updated(control_via_db) if control_via_db else None
        try:
            from src.vendor.massive.config import get_massive_settings
            from src.vendor.massive.reader import count_pending_massive_jobs
            from src.monitor.redis_url import redis_url_from_config

            _ms = get_massive_settings(reader._config)
            _pending_m = count_pending_massive_jobs(control_via_db) if control_via_db else 0
            massive_info: Dict[str, Any] = {
                "configured": bool(_ms.get("api_key")),
                "tier": _ms.get("tier"),
                "pending_jobs": _pending_m,
                "last_snapshot_age_s": None,
            }
            _rurl = redis_url_from_config(reader._config)
            if _rurl:
                import redis

                _r = redis.from_url(_rurl, decode_responses=True)
                _mh = _r.hgetall("massive:meta:status")
                if _mh:
                    massive_info["ws_connected"] = bool(_mh.get("connected") == "1")
                    _lm = _mh.get("last_msg_ts")
                    if _lm is not None:
                        try:
                            massive_info["last_msg_age_s"] = max(0.0, time.time() - float(_lm))
                        except (TypeError, ValueError):
                            massive_info["last_msg_age_s"] = None
                    else:
                        massive_info["last_msg_age_s"] = None
                    try:
                        massive_info["ws_reconnects"] = int(_mh.get("reconnects") or 0)
                    except (TypeError, ValueError):
                        massive_info["ws_reconnects"] = int(_mh.get("reconnects") or 0)
                else:
                    massive_info["ws_connected"] = False
                    massive_info["last_msg_age_s"] = None
            else:
                massive_info["ws_connected"] = None
                massive_info["last_msg_age_s"] = None
            payload["massive"] = massive_info
        except Exception:
            payload["massive"] = None
        dl = (payload.get("daemon_lamp") or "red").strip().lower()
        ml = (payload.get("monitor_lamp") or "red").strip().lower()
        sl = (payload.get("status_lamp") or "red").strip().lower()
        if dl == "red" or ml == "red" or sl == "red":
            payload["system_lamp"] = "red"
        elif dl == "yellow" or ml == "yellow" or sl == "yellow":
            payload["system_lamp"] = "yellow"
        else:
            payload["system_lamp"] = "green"
        with _status_cache_lock:
            _status_cache = payload
            _status_cache_ts = time.monotonic()
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
            "flex_config": {"host_token": None, "secondary_token": None, "rows": []},
            "open_orders": [],
            "active_strategy_structure_id": None,
            "active_gate_safety_strategy_id": None,
            "active_strategy_allocation_id": None,
            "active_strategy_structure_name": None,
            "active_gate_safety_strategy_name": None,
            "active_strategy_allocation_name": None,
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


@router.get("/open-orders")
def get_open_orders(request: Request) -> Dict[str, Any]:
    """R-A5: Return current open/unfilled orders (symbol, side, qty, limit price, status, filled/remaining)."""
    reader = request.app.state.reader
    items: List[Any] = reader.get_open_orders()
    return {"open_orders": items}


@router.get("/operations")
def get_operations(
    request: Request,
    since_ts: Optional[float] = Query(None, description="Filter operations with ts >= this"),
    until_ts: Optional[float] = Query(None, description="Filter operations with ts <= this"),
    operation_type: Optional[str] = Query(None, alias="type", description="Filter by type (hedge_intent, order_sent, fill, reject, cancel)"),
    limit: int = Query(100, ge=1, le=1000),
) -> Dict[str, Any]:
    """Return operations list with optional filters (R-M4b)."""
    reader = request.app.state.reader
    items = reader.get_operations(since_ts=since_ts, until_ts=until_ts, type_filter=operation_type, limit=limit)
    return {"operations": items}


@router.get("/risk_summary")
def get_risk_summary(request: Request) -> Dict[str, Any]:
    """Return risk/post-mortem summary for replay & risk page (R-M7): daily_hedge_count, daily_pnl, operations_count_24h, etc."""
    reader = request.app.state.reader
    return reader.get_risk_summary()
