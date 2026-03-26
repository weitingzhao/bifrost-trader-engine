"""Ops API routes: worker state, commands, audit log, broker status, console SSE."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncGenerator, Dict, Optional

from fastapi import APIRouter, Body, Query, Request
from fastapi.responses import JSONResponse
from starlette.responses import StreamingResponse

from backend.ops.models.schemas import (
    AuditEntry,
    BrokerControlRequest,
    CommandRequest,
    QueueControlRequest,
    ScaleRequest,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["ops"])


# ── helpers ───────────────────────────────────────────────────────────────────


def _worker_svc(request: Request):
    return request.app.state.worker_state_service


def _cmd_bus(request: Request):
    return request.app.state.command_bus


def _executor(request: Request):
    return request.app.state.executor


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


# ── Scale / instances (static paths — must precede {worker_id:path}) ───────────


@router.post("/ops/workers/scale")
async def scale_worker(
    request: Request, body: ScaleRequest = Body(...),
) -> Any:
    """Add or remove a systemd template-instance worker."""
    denied = _require_role(request, "operator")
    if denied:
        _audit(
            request,
            f"scale_{body.action.value}",
            f"instance:{body.instance_id}",
            "denied",
            detail=f"role={_role(request)}",
        )
        return denied

    exc = _executor(request)
    try:
        unit = exc.instance_unit(body.instance_id)
    except ValueError as e:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": str(e)},
        )

    action = "start" if body.action.value == "add" else "stop"
    try:
        exc._validate(action, unit)
        result = await exc._systemctl(action, unit)
    except PermissionError as e:
        _audit(
            request,
            f"scale_{body.action.value}",
            unit,
            "rejected",
            detail=str(e),
        )
        return JSONResponse(
            status_code=403,
            content={"ok": False, "error": str(e)},
        )
    except Exception as e:
        _audit(
            request,
            f"scale_{body.action.value}",
            unit,
            "failed",
            detail=str(e),
        )
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": str(e)},
        )

    _audit(
        request,
        f"scale_{body.action.value}",
        unit,
        "success",
        detail=f"queues={body.queues}",
    )
    return {"ok": True, "action": body.action.value, "unit": unit, "result": result}


@router.get("/ops/workers/instances")
async def list_instances(request: Request) -> Dict[str, Any]:
    """List known systemd bifrost-celery-worker@* template instances."""
    exc = _executor(request)
    try:
        instances = await exc.list_instances()
    except Exception as e:
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": f"Failed to list instances: {e}"},
        )
    return {"ok": True, "instances": instances, "count": len(instances)}


# ── Single worker detail ──────────────────────────────────────────────────────


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


# ── Queue binding ─────────────────────────────────────────────────────────────


@router.post("/ops/workers/{worker_id:path}/queues")
def worker_queue_control(
    request: Request,
    worker_id: str,
    body: QueueControlRequest = Body(...),
) -> Any:
    """Add or remove queue consumers on a specific worker."""
    denied = _require_role(request, "operator")
    if denied:
        _audit(
            request,
            "queue_control",
            worker_id,
            "denied",
            detail=f"role={_role(request)}",
        )
        return denied

    if not body.add and not body.remove:
        return JSONResponse(
            status_code=400,
            content={"ok": False, "error": "Provide at least one queue in 'add' or 'remove'."},
        )

    svc = _worker_svc(request)
    result = svc.queue_control(worker_id, add=body.add, remove=body.remove)

    has_errors = bool(result.get("errors"))
    outcome = "partial" if has_errors else "success"
    _audit(
        request,
        "queue_control",
        worker_id,
        outcome,
        detail=f"add={body.add}, remove={body.remove}",
    )
    return {"ok": not has_errors, **result}


# ── Broker ────────────────────────────────────────────────────────────────────


@router.get("/ops/broker/status")
async def broker_status_extended(request: Request) -> Dict[str, Any]:
    """Extended broker status including local-management detection."""
    svc = _worker_svc(request)
    status = svc.broker_status()
    exc = _executor(request)
    locally_managed = await exc.redis_is_local()
    status["locally_managed"] = locally_managed
    return {"ok": True, "broker": status}


@router.post("/ops/broker/control")
async def broker_control(
    request: Request, body: BrokerControlRequest = Body(...),
) -> Any:
    """Start / stop / restart the local Redis broker. Requires admin role."""
    denied = _require_role(request, "admin")
    if denied:
        _audit(
            request,
            f"broker_{body.action.value}",
            "redis",
            "denied",
            detail=f"role={_role(request)}",
        )
        return denied

    exc = _executor(request)
    if not await exc.redis_is_local():
        _audit(
            request,
            f"broker_{body.action.value}",
            "redis",
            "rejected",
            detail="Redis not locally managed via systemd",
        )
        return JSONResponse(
            status_code=400,
            content={
                "ok": False,
                "error": "Redis is not locally managed; cannot control via systemd.",
            },
        )

    try:
        result = await exc.systemctl_redis(body.action.value)
    except Exception as e:
        _audit(
            request,
            f"broker_{body.action.value}",
            "redis",
            "failed",
            detail=str(e),
        )
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": str(e)},
        )

    _audit(
        request,
        f"broker_{body.action.value}",
        "redis",
        "success",
    )
    return {"ok": True, "action": body.action.value, "result": result}


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


# ── Console log streaming (SSE) ───────────────────────────────────────


async def _journal_sse(
    unit: str, lines: int = 200, request: Request | None = None,
) -> AsyncGenerator[str, None]:
    """Stream journalctl -f output as SSE events."""
    cmd = [
        "journalctl", "-u", unit,
        "-f", "--no-pager", "-o", "short-iso",
        "-n", str(lines),
    ]
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        assert proc.stdout is not None
        while True:
            if request is not None and await request.is_disconnected():
                break
            try:
                line = await asyncio.wait_for(proc.stdout.readline(), timeout=30)
            except asyncio.TimeoutError:
                yield ": keepalive\n\n"
                continue
            if not line:
                break
            text = line.decode("utf-8", errors="replace").rstrip()
            yield f"data: {text}\n\n"
    finally:
        proc.kill()
        await proc.wait()


@router.get("/ops/console/worker/{worker_id:path}")
async def worker_console(
    request: Request,
    worker_id: str,
    lines: int = Query(200, ge=10, le=2000),
) -> StreamingResponse:
    """SSE stream of a worker's systemd journal output."""
    exc = _executor(request)
    unit = exc.worker_to_unit(worker_id)
    return StreamingResponse(
        _journal_sse(unit, lines=lines, request=request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/ops/console/broker")
async def broker_console(
    request: Request,
    lines: int = Query(200, ge=10, le=2000),
) -> StreamingResponse:
    """SSE stream of the Redis broker's systemd journal output."""
    return StreamingResponse(
        _journal_sse("redis", lines=lines, request=request),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )




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
