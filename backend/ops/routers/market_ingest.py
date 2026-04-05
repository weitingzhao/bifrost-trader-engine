"""Market data ingest: systemd status + start/stop/restart/reset (whitelisted units)."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from backend.ops.ib_operator_rpc import ib_operator_disconnect_all_sync
from backend.ops.market_ingest_config import market_ingest_service_by_id, market_ingest_services_from_config
from backend.ops.models.schemas import MarketIngestAction, MarketIngestControlRequest
from backend.ops.routers.workers import _audit, _require_role

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ops-market-ingest"])


def _executor(request: Request):
    return request.app.state.executor


def _config(request: Request) -> dict:
    return getattr(request.app.state, "bifrost_config", {}) or {}


@router.get("/ops/market-ingest/services")
async def market_ingest_services(request: Request) -> Dict[str, Any]:
    """List configured ingest services with current systemd ``is-active`` state."""
    cfg = _config(request)
    rows = market_ingest_services_from_config(cfg)
    exc = _executor(request)
    out: List[Dict[str, Any]] = []
    for row in rows:
        unit = row["systemd_unit"]
        try:
            active = await exc.systemctl_is_active(unit)
        except Exception as e:
            active = "unknown"
            logger.debug("systemctl_is_active %s: %s", unit, e)
        out.append({**row, "process_active": active})
    return {"ok": True, "services": out}


@router.post("/ops/market-ingest/control")
async def market_ingest_control(
    request: Request,
    body: MarketIngestControlRequest = Body(...),
) -> Any:
    from backend.ops.routers.workers import _role

    denied = _require_role(request, "admin")
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
            # massive_ws / ib_market / ib_operator: ordered release + restart via systemd.
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
    _audit(
        request,
        f"market_ingest_{body.action.value}",
        f"{body.service_id}:{unit}",
        "success",
    )
    return {"ok": True, "service_id": body.service_id, "action": body.action.value, "result": result}
