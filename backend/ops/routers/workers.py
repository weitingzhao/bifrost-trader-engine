"""Ops API routes: worker state, commands, audit log, broker status."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, Optional

from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import JSONResponse

from backend.ops.models.schemas import AuditEntry, CommandRequest

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ops"])


# ── helpers ───────────────────────────────────────────────────────────────────


def _worker_svc(request: Request):
    return request.app.state.worker_state_service


def _cmd_bus(request: Request):
    return request.app.state.command_bus


def _audit_log(request: Request) -> list:
    return getattr(request.app.state, "audit_log", [])


def _operator(request: Request) -> str:
    """Phase 1: header-based identity."""
    return request.headers.get("X-Operator", "anonymous")


def _role(request: Request) -> str:
    """Phase 1: header-based role.  viewer | operator | admin."""
    return request.headers.get("X-Role", "viewer")


def _audit(
    request: Request,
    action: str,
    target: str,
    outcome: str,
    command_id: Optional[str] = None,
    detail: Optional[str] = None,
) -> None:
    entry = AuditEntry(
        operator=_operator(request),
        source_ip=request.client.host if request.client else None,
        action=action,
        target=target,
        command_id=command_id,
        outcome=outcome,
        detail=detail,
    )
    _audit_log(request).append(entry)
    logger.info(
        "AUDIT: %s %s -> %s by %s from %s",
        action,
        target,
        outcome,
        entry.operator,
        entry.source_ip,
    )


def _require_role(request: Request, minimum: str) -> Optional[JSONResponse]:
    """Return a 403 JSONResponse if the caller lacks the required role, else None."""
    hierarchy = {"viewer": 0, "operator": 1, "admin": 2}
    role = _role(request)
    if hierarchy.get(role, -1) < hierarchy.get(minimum, 99):
        return JSONResponse(
            status_code=403,
            content={
                "ok": False,
                "error": f"Insufficient permissions; {minimum} role required (current: {role}).",
            },
        )
    return None


# ── Worker status ─────────────────────────────────────────────────────────────


@router.get("/ops/workers")
def list_workers(request: Request) -> Dict[str, Any]:
    """All workers with aggregated status + broker overview."""
    svc = _worker_svc(request)
    workers = svc.list_workers()
    broker = svc.broker_status()
    return {
        "ok": True,
        "workers": [w.model_dump() for w in workers],
        "broker": broker,
        "count": len(workers),
    }


@router.get("/ops/workers/{worker_id:path}")
def get_worker(request: Request, worker_id: str) -> Any:
    """Single worker detail (queues, concurrency, active/reserved tasks, stats)."""
    svc = _worker_svc(request)
    detail = svc.get_worker(worker_id)
    if detail is None:
        return JSONResponse(
            status_code=404,
            content={
                "ok": False,
                "error": f"Worker {worker_id!r} not found or not responding.",
            },
        )
    return {"ok": True, "worker": detail.model_dump()}


# ── Commands (start / stop / restart) ─────────────────────────────────────────


@router.post("/ops/commands")
async def submit_command(
    request: Request, body: CommandRequest = Body(...),
) -> Any:
    """Submit an async control command.  Requires operator or admin role."""
    denied = _require_role(request, "operator")
    if denied:
        _audit(
            request,
            body.action.value,
            body.target_id,
            "denied",
            detail=f"role={_role(request)}",
        )
        return denied

    bus = _cmd_bus(request)
    try:
        cmd = bus.submit(
            action=body.action,
            target_type=body.target_type,
            target_id=body.target_id,
            reason=body.reason,
            idempotency_key=body.idempotency_key,
            operator=_operator(request),
        )
    except ValueError as e:
        return JSONResponse(
            status_code=409, content={"ok": False, "error": str(e)},
        )

    _audit(
        request,
        cmd.action.value,
        cmd.target_id,
        "submitted",
        command_id=cmd.command_id,
        detail=cmd.reason,
    )

    asyncio.create_task(bus.execute(cmd.command_id))

    return JSONResponse(
        status_code=202,
        content={"ok": True, "command": cmd.model_dump()},
    )


@router.get("/ops/commands/{command_id}")
def get_command(request: Request, command_id: str) -> Any:
    """Poll command execution status."""
    bus = _cmd_bus(request)
    cmd = bus.get(command_id)
    if cmd is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": "Command not found."},
        )
    return {"ok": True, "command": cmd.model_dump()}


@router.get("/ops/commands")
def list_commands(
    request: Request,
    limit: int = Query(50, ge=1, le=200),
) -> Dict[str, Any]:
    """Recent commands (newest first)."""
    bus = _cmd_bus(request)
    cmds = bus.list_recent(limit=limit)
    return {
        "ok": True,
        "commands": [c.model_dump() for c in cmds],
        "count": len(cmds),
    }


# ── Audit log ─────────────────────────────────────────────────────────────────


@router.get("/ops/audit")
def list_audit(
    request: Request,
    limit: int = Query(100, ge=1, le=500),
) -> Dict[str, Any]:
    """Recent audit entries (newest first).  Requires admin role."""
    denied = _require_role(request, "admin")
    if denied:
        return denied
    log = _audit_log(request)
    entries = sorted(log, key=lambda e: e.timestamp, reverse=True)[:limit]
    return {
        "ok": True,
        "entries": [e.model_dump() for e in entries],
        "count": len(entries),
    }
