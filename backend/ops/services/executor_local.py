"""Restricted local executor — whitelisted systemd units + Redis-based Celery stop.

Phase 1: single-host. Phase 2: remote agent protocol (host_id routing).
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import re
from typing import Any, Dict, List, Set

from backend.ops.models.schemas import CommandRecord

logger = logging.getLogger(__name__)

_SYSTEMD_TIMEOUT_SEC = 30
_STOP_SETTLE_SEC = 5
_ALLOWED_ACTIONS = frozenset({"start", "stop", "restart"})
_WORKER_UNIT_BASE = "bifrost-celery-worker"
_INSTANCE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]+$")


class RestrictedExecutor:
    """Execute whitelisted systemd unit actions.

    Stop mechanism for Celery workers uses the existing Redis key pattern
    (``bifrost:worker_stop_requested``).  Start/restart use systemd.
    """

    def __init__(
        self,
        allowed_units: list[str],
        broker_url: str,
        use_redis_stop: bool = True,
    ) -> None:
        self._allowed: Set[str] = set(allowed_units)
        self._broker_url = broker_url
        self._use_redis_stop = use_redis_stop

    # ── unit helpers ──────────────────────────────────────────────────────────

    @staticmethod
    def worker_to_unit(worker_id: str) -> str:
        """Convert Celery worker name (e.g. ``celery@worker1``) to systemd unit."""
        name = worker_id.split("@", 1)[-1] if "@" in worker_id else worker_id
        return f"{_WORKER_UNIT_BASE}@{name}.service"

    @staticmethod
    def instance_unit(instance_id: str) -> str:
        """Build template-instance unit for a numeric/named instance."""
        if not _INSTANCE_ID_RE.match(instance_id):
            raise ValueError(f"Invalid instance_id: {instance_id!r}")
        return f"{_WORKER_UNIT_BASE}@{instance_id}.service"

    def _validate(self, action: str, unit: str) -> None:
        if action not in _ALLOWED_ACTIONS:
            raise PermissionError(
                f"Action {action!r} not allowed; permitted: {sorted(_ALLOWED_ACTIONS)}"
            )
        if not self._allowed:
            return
        for allowed in self._allowed:
            if unit == allowed or unit == f"{allowed}.service":
                return
            if fnmatch.fnmatch(unit, f"{allowed}@*.service"):
                return
        raise PermissionError(
            f"Unit {unit!r} not in whitelist; permitted: {sorted(self._allowed)}"
        )

    async def _redis_stop_celery(self) -> Dict[str, Any]:
        """Stop Celery worker via existing Redis key pattern."""
        try:
            import redis

            from servers.celery_app import (
                WORKER_IB_STATUS_KEY,
                WORKER_IB_STATUS_TTL_SEC,
                WORKER_STOP_REQUESTED_KEY,
            )

            r = redis.from_url(
                self._broker_url,
                socket_connect_timeout=5,
                socket_timeout=5,
            )
            r.set(WORKER_STOP_REQUESTED_KEY, "1")
            r.setex(
                WORKER_IB_STATUS_KEY,
                WORKER_IB_STATUS_TTL_SEC,
                json.dumps({"connected": False, "client_id": 0}),
            )
            return {
                "method": "redis",
                "message": "Stop signal sent via Redis; worker will exit within seconds.",
            }
        except Exception as e:
            raise RuntimeError(f"Redis-based Celery stop failed: {e}") from e

    async def _systemctl(
        self, action: str, unit: str, timeout: int = _SYSTEMD_TIMEOUT_SEC,
    ) -> Dict[str, Any]:
        # Preflight 1: verify sudo is non-interactive for this process user.
        pre_sudo = await asyncio.create_subprocess_exec(
            "sudo", "-n", "true",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, pre_sudo_err = await pre_sudo.communicate()
        if pre_sudo.returncode != 0:
            raise RuntimeError(
                "Ops executor requires non-interactive sudo (NOPASSWD). "
                "Current host returned: "
                f"{(pre_sudo_err or b'').decode().strip() or 'sudo -n failed'}"
            )

        cmd = ["sudo", "systemctl", action, unit]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=timeout,
            )
        except asyncio.TimeoutError as exc:
            proc.kill()
            raise asyncio.TimeoutError(
                f"systemctl {action} {unit} timed out after {timeout}s"
            ) from exc
        if proc.returncode != 0:
            err_msg = (stderr or b"").decode().strip()
            raise RuntimeError(
                f"systemctl {action} {unit} failed (rc={proc.returncode}): {err_msg}"
            )
        return {
            "method": "systemd",
            "action": action,
            "unit": unit,
            "returncode": proc.returncode,
            "stdout": (stdout or b"").decode().strip(),
        }

    async def list_instances(self) -> List[Dict[str, str]]:
        """List active systemd template instances for bifrost-celery-worker@*."""
        cmd = [
            "systemctl", "list-units",
            f"{_WORKER_UNIT_BASE}@*",
            "--no-legend", "--no-pager", "--plain",
        ]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        lines = (stdout or b"").decode().strip().splitlines()
        instances: List[Dict[str, str]] = []
        for line in lines:
            parts = line.split(None, 4)
            if len(parts) >= 4:
                instances.append({
                    "unit": parts[0],
                    "load": parts[1],
                    "active": parts[2],
                    "sub": parts[3],
                    "description": parts[4] if len(parts) > 4 else "",
                })
        return instances

    async def redis_is_local(self) -> bool:
        """Check if Redis is managed locally via systemd."""
        try:
            proc = await asyncio.create_subprocess_exec(
                "systemctl", "is-active", "redis",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=5)
            state = (stdout or b"").decode().strip()
            return state in ("active", "inactive", "failed")
        except Exception:
            return False

    async def systemctl_redis(self, action: str) -> Dict[str, Any]:
        """Start / stop / restart local Redis via systemd."""
        if action not in _ALLOWED_ACTIONS:
            raise PermissionError(f"Action {action!r} not allowed for Redis")
        return await self._systemctl(action, "redis")

    async def __call__(self, cmd: CommandRecord) -> Dict[str, Any]:
        action = cmd.action.value
        unit = cmd.target_id
        self._validate(action, unit)

        if action == "stop" and self._use_redis_stop:
            return await self._redis_stop_celery()

        if action == "restart" and self._use_redis_stop:
            stop_result = await self._redis_stop_celery()
            await asyncio.sleep(_STOP_SETTLE_SEC)
            start_result = await self._systemctl("start", unit)
            return {"stop": stop_result, "start": start_result}

        return await self._systemctl(action, unit)
