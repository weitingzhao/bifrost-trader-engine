"""In-memory command store with async execution pipeline.

Phase 1: in-memory dict. Phase 2: PostgreSQL-backed.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from backend.ops.models.schemas import CommandAction, CommandRecord, CommandStatus

logger = logging.getLogger(__name__)

_MAX_INFLIGHT_PER_TARGET = 1
_COMMAND_TTL_SEC = 3600


class CommandBus:

    def __init__(self) -> None:
        self._store: Dict[str, CommandRecord] = {}
        self._lock = threading.Lock()
        self._executor: Optional[Callable] = None

    def set_executor(self, executor: Callable) -> None:
        self._executor = executor

    def _inflight_count(self, target_id: str) -> int:
        with self._lock:
            return sum(
                1
                for c in self._store.values()
                if c.target_id == target_id
                and c.status in (CommandStatus.QUEUED, CommandStatus.RUNNING)
            )

    def submit(
        self,
        action: CommandAction,
        target_type: str,
        target_id: str,
        reason: Optional[str] = None,
        idempotency_key: Optional[str] = None,
        operator: Optional[str] = None,
    ) -> CommandRecord:
        if idempotency_key:
            with self._lock:
                for c in self._store.values():
                    if c.idempotency_key == idempotency_key:
                        return c

        if self._inflight_count(target_id) >= _MAX_INFLIGHT_PER_TARGET:
            raise ValueError(
                f"Target {target_id!r} already has an in-flight command; "
                "wait for it to complete."
            )

        cmd = CommandRecord(
            command_id=str(uuid.uuid4()),
            action=action,
            target_type=target_type,
            target_id=target_id,
            reason=reason,
            idempotency_key=idempotency_key,
            operator=operator,
        )
        with self._lock:
            self._store[cmd.command_id] = cmd
        return cmd

    def get(self, command_id: str) -> Optional[CommandRecord]:
        with self._lock:
            return self._store.get(command_id)

    def list_recent(self, limit: int = 50) -> List[CommandRecord]:
        with self._lock:
            all_cmds = sorted(
                self._store.values(),
                key=lambda c: c.created_at,
                reverse=True,
            )
            return all_cmds[:limit]

    def update_status(
        self,
        command_id: str,
        status: CommandStatus,
        result: Optional[Dict[str, Any]] = None,
        error: Optional[str] = None,
    ) -> None:
        with self._lock:
            cmd = self._store.get(command_id)
            if not cmd:
                return
            cmd.status = status
            cmd.updated_at = time.time()
            if result is not None:
                cmd.result = result
            if error is not None:
                cmd.error = error

    async def execute(self, command_id: str) -> None:
        """Run the registered executor for a command."""
        cmd = self.get(command_id)
        if not cmd or not self._executor:
            return
        self.update_status(command_id, CommandStatus.RUNNING)
        try:
            result = await self._executor(cmd)
            self.update_status(command_id, CommandStatus.SUCCEEDED, result=result)
        except asyncio.TimeoutError:
            self.update_status(
                command_id, CommandStatus.TIMEOUT, error="Execution timed out"
            )
        except Exception as e:
            logger.warning("Command %s failed: %s", command_id, e, exc_info=True)
            self.update_status(command_id, CommandStatus.FAILED, error=str(e))

    def gc(self) -> int:
        """Evict finished commands older than TTL. Returns count evicted."""
        cutoff = time.time() - _COMMAND_TTL_SEC
        terminal = (CommandStatus.SUCCEEDED, CommandStatus.FAILED, CommandStatus.TIMEOUT)
        removed = 0
        with self._lock:
            stale = [
                cid
                for cid, c in self._store.items()
                if c.status in terminal and c.updated_at < cutoff
            ]
            for cid in stale:
                del self._store[cid]
                removed += 1
        return removed
