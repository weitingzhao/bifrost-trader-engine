"""Restricted local executor — whitelisted systemd units + Redis-based Celery stop.

Phase 1: single-host. Phase 2: remote agent protocol (host_id routing).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Set

from backend.ops.models.schemas import CommandRecord

logger = logging.getLogger(__name__)

_SYSTEMD_TIMEOUT_SEC = 30
_STOP_SETTLE_SEC = 5
_ALLOWED_ACTIONS = frozenset({"start", "stop", "restart"})


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

    def _validate(self, action: str, unit: str) -> None:
        if action not in _ALLOWED_ACTIONS:
            raise PermissionError(
                f"Action {action!r} not allowed; permitted: {sorted(_ALLOWED_ACTIONS)}"
            )
        if self._allowed and unit not in self._allowed:
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
