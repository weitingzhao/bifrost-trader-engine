"""Aggregate Celery inspect + broker metrics into standard worker status."""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.ops.models.schemas import WorkerDetail, WorkerStatus, WorkerSummary

logger = logging.getLogger(__name__)


class WorkerStateService:

    def __init__(self, celery_app: Any, broker_url: str) -> None:
        self._celery = celery_app
        self._broker_url = broker_url

    # ── internal helpers ──────────────────────────────────────────────────────

    def _inspect(
        self, timeout: float = 5.0,
    ) -> Tuple[dict, dict, dict, dict, dict]:
        """Run Celery inspect. Returns (ping, stats, active, reserved, active_queues)."""
        empty: Tuple[dict, dict, dict, dict, dict] = ({}, {}, {}, {}, {})
        try:
            i = self._celery.control.inspect(timeout=timeout)
            ping = i.ping() or {}
            stats = i.stats() or {}
            active = i.active() or {}
            reserved = i.reserved() or {}
            active_queues = i.active_queues() or {}
            return ping, stats, active, reserved, active_queues
        except Exception as e:
            logger.warning("Celery inspect failed: %s", e)
            return empty

    def _broker_connected(self) -> bool:
        try:
            import redis as _redis

            r = _redis.from_url(
                self._broker_url,
                socket_connect_timeout=3,
                socket_timeout=3,
            )
            r.ping()
            return True
        except Exception:
            return False

    @staticmethod
    def _derive_status(
        worker_name: str,
        ping: dict,
        stats: dict,
    ) -> WorkerStatus:
        if worker_name not in ping:
            return WorkerStatus.STOPPED
        if worker_name not in stats:
            return WorkerStatus.RUNNING_DEGRADED
        return WorkerStatus.RUNNING_HEALTHY

    @staticmethod
    def _queues_for(name: str, active_queues: dict) -> List[str]:
        return [
            q.get("name", "")
            for q in active_queues.get(name, [])
            if q.get("name")
        ]

    @staticmethod
    def _concurrency_from_stats(s: dict) -> int:
        pool = s.get("pool")
        if isinstance(pool, dict):
            return pool.get("max-concurrency", 0)
        return 0

    # ── public API ────────────────────────────────────────────────────────────

    def list_workers(self) -> List[WorkerSummary]:
        ping, stats, active, reserved, active_queues = self._inspect()
        all_names = sorted(set(list(ping.keys()) + list(stats.keys())))
        if not all_names:
            return []
        results: List[WorkerSummary] = []
        for name in all_names:
            s = stats.get(name, {})
            status = self._derive_status(name, ping, stats)
            last_hb = time.time() if name in ping else None
            results.append(
                WorkerSummary(
                    worker_id=name,
                    status=status,
                    queues=self._queues_for(name, active_queues),
                    concurrency=self._concurrency_from_stats(s),
                    active_tasks=len(active.get(name, [])),
                    reserved_tasks=len(reserved.get(name, [])),
                    last_heartbeat=last_hb,
                )
            )
        return results

    def get_worker(self, worker_id: str) -> Optional[WorkerDetail]:
        ping, stats, active, reserved, active_queues = self._inspect()
        if worker_id not in ping and worker_id not in stats:
            return None
        s = stats.get(worker_id, {})
        pool_info = s.get("pool") if isinstance(s.get("pool"), dict) else {}
        status = self._derive_status(worker_id, ping, stats)
        last_hb = time.time() if worker_id in ping else None
        active_list = active.get(worker_id, [])
        reserved_list = reserved.get(worker_id, [])
        return WorkerDetail(
            worker_id=worker_id,
            status=status,
            queues=self._queues_for(worker_id, active_queues),
            concurrency=self._concurrency_from_stats(s),
            active_tasks=len(active_list),
            reserved_tasks=len(reserved_list),
            last_heartbeat=last_hb,
            pool_type=pool_info.get("implementation", "unknown") if pool_info else "unknown",
            prefetch_count=s.get("prefetch_count"),
            active_task_list=active_list,
            reserved_task_list=reserved_list,
            stats=s,
        )

    def queue_control(
        self,
        worker_id: str,
        add: List[str] | None = None,
        remove: List[str] | None = None,
    ) -> Dict[str, Any]:
        """Add / remove queue consumers on a specific worker via Celery control."""
        results: Dict[str, Any] = {"worker_id": worker_id, "added": [], "removed": []}
        dest = [worker_id]
        for q in add or []:
            try:
                self._celery.control.add_consumer(q, destination=dest)
                results["added"].append(q)
            except Exception as e:
                logger.warning("add_consumer(%s, %s) failed: %s", q, worker_id, e)
                results.setdefault("errors", []).append(
                    {"queue": q, "op": "add", "error": str(e)}
                )
        for q in remove or []:
            try:
                self._celery.control.cancel_consumer(q, destination=dest)
                results["removed"].append(q)
            except Exception as e:
                logger.warning("cancel_consumer(%s, %s) failed: %s", q, worker_id, e)
                results.setdefault("errors", []).append(
                    {"queue": q, "op": "remove", "error": str(e)}
                )
        return results

    def broker_status(self) -> Dict[str, Any]:
        connected = self._broker_connected()
        url_safe = (
            self._broker_url.split("@")[-1]
            if "@" in self._broker_url
            else self._broker_url
        )
        result: Dict[str, Any] = {"connected": connected, "url_masked": url_safe}
        if not connected:
            return result
        try:
            import redis as _redis

            r = _redis.from_url(
                self._broker_url,
                socket_connect_timeout=3,
                socket_timeout=3,
            )
            mem = r.info(section="memory")
            result["used_memory_human"] = mem.get("used_memory_human", "N/A")
            clients = r.info(section="clients")
            result["connected_clients"] = clients.get("connected_clients", 0)
            queues: Dict[str, int] = {}
            for key in r.keys("celery*") or []:
                k = key if isinstance(key, str) else key.decode()
                qtype = r.type(key)
                t = qtype if isinstance(qtype, str) else qtype.decode()
                if t == "list":
                    queues[k] = r.llen(key)
            if queues:
                result["queues"] = queues
        except Exception as e:
            logger.debug("broker_status detail collection failed: %s", e)
        return result
