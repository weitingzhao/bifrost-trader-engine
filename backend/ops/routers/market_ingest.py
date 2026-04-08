"""Market data ingest: systemd status + start/stop/restart/reset (whitelisted units)."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from backend.ops.ib_operator_rpc import ib_operator_disconnect_all_sync
from backend.ops.market_ingest_config import market_ingest_service_by_id, market_ingest_services_from_config
from backend.ops.market_ingest_control_env import (
    clear_control_env,
    meta_redis_url_from_ops_config,
    normalize_control_profile,
    read_control_env,
    read_control_host,
    write_control_env,
    write_trading_engine_ops_lease,
)
from backend.ops.market_ingest_health_clear import (
    clear_ingest_health_after_stop,
    ingest_redis_health_looks_live,
)
from backend.ops.models.schemas import MarketIngestAction, MarketIngestControlRequest
from backend.ops.routers.workers import _audit, _require_role

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ops-market-ingest"])


def _executor(request: Request):
    return request.app.state.executor


def _config(request: Request) -> dict:
    return getattr(request.app.state, "bifrost_config", {}) or {}


def _ops_control_profile(request: Request) -> Optional[str]:
    raw = getattr(request.app.state, "bifrost_config_profile", None)
    return normalize_control_profile(raw if isinstance(raw, str) else None)


def _effective_ops_control_profile(request: Request) -> Optional[str]:
    """dev|prod for Redis lease + 409 guard: filename profile, then ``ops.control_profile`` YAML, then env."""
    p = _ops_control_profile(request)
    if p:
        return p
    cfg = _config(request)
    ops_cfg = cfg.get("ops") if isinstance(cfg.get("ops"), dict) else {}
    raw = ops_cfg.get("control_profile")
    if isinstance(raw, str):
        n = normalize_control_profile(raw)
        if n:
            return n
    return normalize_control_profile(os.environ.get("BIFROST_OPS_CONTROL_PROFILE"))


@router.get("/ops/market-ingest/services")
async def market_ingest_services(request: Request) -> Dict[str, Any]:
    """List configured ingest services with current systemd ``is-active`` state."""
    cfg = _config(request)
    rows = market_ingest_services_from_config(cfg)
    exc = _executor(request)
    rurl = meta_redis_url_from_ops_config(cfg)
    out: List[Dict[str, Any]] = []
    for row in rows:
        unit = row["systemd_unit"]
        try:
            active = await exc.systemctl_is_active(unit)
        except Exception as e:
            active = "unknown"
            logger.debug("systemctl_is_active %s: %s", unit, e)
        meta_key = (row.get("redis_meta_key") or "").strip()
        redis_control_env: Optional[str] = None
        redis_control_host: Optional[str] = None
        if rurl and meta_key:
            redis_control_env = await asyncio.to_thread(read_control_env, rurl, meta_key)
            redis_control_host = await asyncio.to_thread(read_control_host, rurl, meta_key)
        out.append({
            **row,
            "process_active": active,
            "redis_control_env": redis_control_env,
            "redis_control_host": redis_control_host,
        })
    return {"ok": True, "services": out}


@router.post("/ops/market-ingest/control")
async def market_ingest_control(
    request: Request,
    body: MarketIngestControlRequest = Body(...),
) -> Any:
    from backend.ops.routers.workers import _role

    denied = _require_role(request, "operator")
    if denied:
        _audit(
            request,
            f"market_ingest_{body.action.value}",
            body.service_id,
            "denied",
            detail=f"role={_role(request)}",
        )
        return denied
    cfg = _config(request)
    svc = market_ingest_service_by_id(cfg, body.service_id)
    if not svc:
        _audit(
            request,
            f"market_ingest_{body.action.value}",
            body.service_id,
            "rejected",
            detail="unknown service_id",
        )
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": f"Unknown service_id: {body.service_id!r}"},
        )
    unit = svc["systemd_unit"]
    exc = _executor(request)
    sid = svc["id"]
    action = body.action
    meta_key = (svc.get("redis_meta_key") or "").strip()
    rurl = meta_redis_url_from_ops_config(cfg)
    ops_profile = _effective_ops_control_profile(request)
    claimed: Optional[str] = None
    if rurl and meta_key:
        claimed = await asyncio.to_thread(read_control_env, rurl, meta_key)
    if rurl and meta_key and ops_profile:
        if claimed and claimed != ops_profile:
            msg = (
                f"Ingest control is held by the {claimed.upper()} stack (Redis). "
                "Stop the service from that Ops host first."
            )
            _audit(
                request,
                f"market_ingest_{body.action.value}",
                f"{body.service_id}:{unit}",
                "rejected",
                detail=f"redis_control_env={claimed} ops_profile={ops_profile}",
            )
            return JSONResponse(
                status_code=409,
                content={"ok": False, "error": msg},
            )

    # Exclusive writer: no lease but Redis health still shows a fresh connected snapshot (other stack).
    if (
        action
        in (
            MarketIngestAction.START,
            MarketIngestAction.RESTART,
            MarketIngestAction.RESET,
        )
        and rurl
        and meta_key
        and ops_profile
        and claimed is None
    ):
        looks_live = await asyncio.to_thread(
            ingest_redis_health_looks_live,
            rurl,
            meta_key,
            sid,
        )
        if looks_live:
            msg = (
                "Redis health still shows an active Socket Services writer (no control lease). "
                "Only one of Dev or Prod may run this service against this Redis. "
                "Stop the other stack's process or wait for health to go stale, then retry."
            )
            _audit(
                request,
                f"market_ingest_{body.action.value}",
                f"{body.service_id}:{unit}",
                "rejected",
                detail="redis_health_looks_live without bifrost_ops_control_env",
            )
            return JSONResponse(
                status_code=409,
                content={"ok": False, "error": msg},
            )

    try:
        if action == MarketIngestAction.RESET:
            extra: Dict[str, Any] = {}
            if sid == "ib_operator":
                ok_rpc, rpc_err, rpc_data = await asyncio.to_thread(
                    ib_operator_disconnect_all_sync,
                    cfg,
                )
                extra["disconnect_all_rpc"] = {
                    "ok": ok_rpc,
                    "error": rpc_err,
                    "result": rpc_data,
                }
                if not ok_rpc:
                    logger.warning(
                        "ib_operator reset: disconnect_all RPC failed (%s); continuing with restart",
                        rpc_err,
                    )
            # massive_ws / ib_ingestor / ib_operator: ordered release + restart via systemd.
            result = await exc._systemctl("restart", unit)  # noqa: SLF001
            if extra:
                result = {**result, **extra} if isinstance(result, dict) else {"result": result, **extra}
        else:
            result = await exc._systemctl(action.value, unit)  # noqa: SLF001
    except Exception as e:
        _audit(
            request,
            f"market_ingest_{body.action.value}",
            f"{body.service_id}:{unit}",
            "failed",
            detail=str(e),
        )
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": str(e)},
        )

    if rurl and meta_key:
        try:
            if action == MarketIngestAction.STOP:
                if ops_profile:
                    await asyncio.to_thread(clear_control_env, rurl, meta_key)
                await asyncio.to_thread(
                    clear_ingest_health_after_stop,
                    rurl,
                    meta_key,
                    sid,
                )
            elif (
                ops_profile
                and action
                in (
                    MarketIngestAction.START,
                    MarketIngestAction.RESTART,
                    MarketIngestAction.RESET,
                )
            ):
                if sid == "trading_engine":
                    await asyncio.to_thread(write_trading_engine_ops_lease, rurl, meta_key, ops_profile)
                else:
                    await asyncio.to_thread(write_control_env, rurl, meta_key, ops_profile)
        except Exception as e:
            logger.warning(
                "market_ingest redis post-action failed: %s %s %s",
                body.service_id,
                action.value,
                e,
            )
            _audit(
                request,
                f"market_ingest_{body.action.value}",
                f"{body.service_id}:{unit}",
                "failed",
                detail=f"redis_control_env_or_health: {e}",
            )
            return JSONResponse(
                status_code=500,
                content={
                    "ok": False,
                    "error": (
                        "systemd action succeeded but updating Redis (lease or health) failed: "
                        f"{e}"
                    ),
                },
            )

    _audit(
        request,
        f"market_ingest_{body.action.value}",
        f"{body.service_id}:{unit}",
        "success",
    )
    return {"ok": True, "service_id": body.service_id, "action": body.action.value, "result": result}
