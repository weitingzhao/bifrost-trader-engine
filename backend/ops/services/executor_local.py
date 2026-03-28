"""Restricted local executor — whitelisted systemd units + Redis-based Celery stop.

Phase 1: single-host. Phase 2: remote agent protocol (host_id routing).
"""

from __future__ import annotations

import asyncio
import fnmatch
import json
import logging
import os
import re
import signal
import sys
from pathlib import Path
from typing import Any, Dict, List, Set

logger = logging.getLogger(__name__)

_SYSTEMD_TIMEOUT_SEC = 30
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
        """Map Celery nodename to ``bifrost-celery-worker@<instance>.service``.

        ``run_celery.py`` sets ``-n worker{instance}@{hostname}`` (e.g. ``workerib-1@myhost``).
        The part after ``@`` is the **host**, not the systemd instance id — use the nodename
        prefix ``worker`` + instance. Legacy names like ``celery@worker1`` keep the old rule
        (second segment = logical id).
        """
        if "@" not in worker_id:
            return f"{_WORKER_UNIT_BASE}@{worker_id}.service"
        nodename, tail = worker_id.split("@", 1)
        if nodename.startswith("worker") and len(nodename) > len("worker"):
            instance_id = nodename[len("worker") :]
            return f"{_WORKER_UNIT_BASE}@{instance_id}.service"
        return f"{_WORKER_UNIT_BASE}@{tail}.service"

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

            from src.workers.celery_app import (
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


class SubprocessLocalExecutor:
    """Local executor without systemd: start/stop workers via ``scripts/run_celery.py``.

    Use on macOS or any host where ``systemctl`` is unavailable. Same API as
    :class:`RestrictedExecutor` for the Ops router (scale, list_instances).

    Redis broker control still goes through :class:`RestrictedExecutor` (systemd),
    so ``systemctl_redis`` requires Linux + sudo like before.

    Worker start spawns a detached child process; worker stop matches
    ``pgrep`` + ``SIGTERM`` (same idea as ``run_celery.py`` duplicate kill).
    """

    worker_to_unit = staticmethod(RestrictedExecutor.worker_to_unit)
    instance_unit = staticmethod(RestrictedExecutor.instance_unit)

    def __init__(
        self,
        allowed_units: list[str],
        broker_url: str,
        use_redis_stop: bool,
        project_root: Path | str,
        python_executable: str | None = None,
    ) -> None:
        self._project_root = Path(project_root).resolve()
        self._python = python_executable or sys.executable
        self._systemd = RestrictedExecutor(
            allowed_units=allowed_units,
            broker_url=broker_url,
            use_redis_stop=use_redis_stop,
        )

    def _validate(self, action: str, unit: str) -> None:
        self._systemd._validate(action, unit)  # noqa: SLF001

    async def _redis_stop_celery(self) -> Dict[str, Any]:
        return await self._systemd._redis_stop_celery()  # noqa: SLF001

    @staticmethod
    def _instance_from_worker_unit(unit: str) -> str:
        prefix = f"{_WORKER_UNIT_BASE}@"
        if not unit.startswith(prefix) or not unit.endswith(".service"):
            raise ValueError(
                f"Not a {_WORKER_UNIT_BASE}@ template unit: {unit!r}"
            )
        return unit[len(prefix) : -len(".service")]

    async def _start_worker_unit(self, unit: str) -> Dict[str, Any]:
        instance_id = self._instance_from_worker_unit(unit)
        script = self._project_root / "scripts" / "run_celery.py"
        if not script.is_file():
            raise RuntimeError(f"run_celery.py not found at {script}")
        cmd = [self._python, str(script), "--instance", instance_id]
        env = os.environ.copy()
        log_dir = self._project_root / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_dir / f"celery-{instance_id}.log"
        log_fp = open(log_file, "ab", buffering=0)
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                cwd=str(self._project_root),
                stdout=log_fp,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
                env=env,
            )
        finally:
            log_fp.close()
        try:
            await asyncio.wait_for(proc.wait(), timeout=2.5)
            tail = ""
            if log_file.is_file():
                try:
                    with open(log_file, "rb") as lf:
                        lf.seek(0, os.SEEK_END)
                        sz = lf.tell()
                        lf.seek(max(0, sz - 4000))
                        tail = lf.read().decode("utf-8", errors="replace")
                except OSError:
                    tail = ""
            raise RuntimeError(
                f"Worker exited immediately (rc={proc.returncode}). "
                f"Log: {log_file}. Tail: {tail.strip() or '(empty)'}"
            )
        except asyncio.TimeoutError:
            pass
        return {
            "method": "subprocess",
            "action": "start",
            "unit": unit,
            "pid": proc.pid,
            "message": "Worker process started in background (run_celery.py).",
        }

    async def _stop_worker_unit(self, unit: str) -> Dict[str, Any]:
        instance_id = self._instance_from_worker_unit(unit)
        safe = instance_id.replace("\\", "\\\\").replace(".", "\\.")
        pattern = f"python.*run_celery\\.py.*--instance {safe}"
        pg = await asyncio.create_subprocess_exec(
            "pgrep", "-f", pattern,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(pg.communicate(), timeout=15)
        if pg.returncode != 0:
            return {
                "method": "subprocess",
                "action": "stop",
                "unit": unit,
                "message": "No matching worker process (already stopped).",
            }
        pids = [x.strip() for x in stdout.decode().strip().splitlines() if x.strip().isdigit()]
        killed: List[str] = []
        for pid_str in pids:
            try:
                os.kill(int(pid_str), signal.SIGTERM)
                killed.append(pid_str)
            except (ProcessLookupError, ValueError):
                pass
        return {
            "method": "subprocess",
            "action": "stop",
            "unit": unit,
            "pids": killed,
            "message": f"SIGTERM sent to {killed}" if killed else "No PIDs killed",
        }

    async def _systemctl(
        self, action: str, unit: str, timeout: int = _SYSTEMD_TIMEOUT_SEC,
    ) -> Dict[str, Any]:
        if unit == "redis":
            return await self._systemd._systemctl(action, unit, timeout=timeout)  # noqa: SLF001
        if action == "start":
            return await self._start_worker_unit(unit)
        if action == "stop":
            return await self._stop_worker_unit(unit)
        if action == "restart":
            await self._stop_worker_unit(unit)
            return await self._start_worker_unit(unit)
        raise PermissionError(f"Action {action!r} not supported for subprocess worker control")

    async def list_instances(self) -> List[Dict[str, str]]:
        proc = await asyncio.create_subprocess_exec(
            "pgrep", "-fl", "run_celery.py",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=10)
        if proc.returncode not in (0, 1):
            return []
        text = (stdout or b"").decode(errors="replace").strip()
        if not text:
            return []
        inst_re = re.compile(r"--instance\s+(\S+)")
        instances: List[Dict[str, str]] = []
        for line in text.splitlines():
            m = inst_re.search(line)
            if not m:
                continue
            instance_id = m.group(1)
            unit = f"{_WORKER_UNIT_BASE}@{instance_id}.service"
            parts = line.split(None, 1)
            pid = parts[0] if parts else "?"
            instances.append({
                "unit": unit,
                "load": "loaded",
                "active": "active",
                "sub": "running",
                "description": f"subprocess pid={pid}",
            })
        return instances

    async def redis_is_local(self) -> bool:
        return await self._systemd.redis_is_local()

    async def systemctl_redis(self, action: str) -> Dict[str, Any]:
        return await self._systemd.systemctl_redis(action)
