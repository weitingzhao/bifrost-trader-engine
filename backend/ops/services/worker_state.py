"""Aggregate Celery inspect + broker metrics into standard worker status."""

from __future__ import annotations

import concurrent.futures
import json
import logging
import time
from typing import Any, Dict, List, Optional, Tuple

from backend.ops.models.schemas import WorkerDetail, WorkerStatus, WorkerSummary
from servers.celery_app import (
    CELERY_INSPECT_TIMEOUT_SEC,
    OPS_WORKER_PRESENCE_KEY_PREFIX,
)

logger = logging.getLogger(__name__)

# Canonical Celery queues (see scripts/run_celery.py _DEFAULT_QUEUES, servers/celery_app.py).
SUPPORTED_CELERY_QUEUES: Tuple[str, ...] = ("bars", "massive_high", "massive")


class WorkerStateService:

    def __init__(self, celery_app: Any, broker_url: str, config: Optional[Dict[str, Any]] = None) -> None:
        self._celery = celery_app
        self._broker_url = broker_url
        self._config = config or {}
        ops_cfg = (self._config.get("ops") or {}) if isinstance(self._config, dict) else {}
        self._inspect_timeout = float(
            ops_cfg.get("celery_inspect_timeout_sec", CELERY_INSPECT_TIMEOUT_SEC)
        )
        wall_cfg = float(ops_cfg.get("celery_inspect_wall_sec", 12.0))
        # list_workers uses a thread pool + fut.result(timeout=wall). _inspect_for_worker_list runs
        # sequential inspect RPCs to the broker (each round waits up to timeout for all workers).
        # Flower feels faster because it uses a long-lived UI + fewer blocking snapshot semantics.
        _list_rounds = 2.0  # stats + active_queues (no separate ping — stats implies worker replied)
        self._inspect_wall_sec = max(
            wall_cfg,
            _list_rounds * self._inspect_timeout + 5.0,
        )
        self._worker_list_mode = str(
            ops_cfg.get("worker_list_mode", "redis_presence")
        ).strip().lower()
        self._worker_list_fallback_inspect = bool(
            ops_cfg.get("worker_list_fallback_inspect", True)
        )

    # ── internal helpers ──────────────────────────────────────────────────────

    def _inspect(
        self, timeout: Optional[float] = None,
    ) -> Tuple[dict, dict, dict, dict, dict]:
        """Run full Celery inspect (5 rounds). Used by get_worker / queue_summaries."""
        if timeout is None:
            timeout = self._inspect_timeout
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

    def _inspect_for_worker_list(
        self, timeout: Optional[float] = None,
    ) -> Tuple[dict, dict, dict, dict, dict]:
        """Lighter inspect for Runtime Snapshot: stats + active_queues (2 broker rounds).

        Skips a separate ``ping()`` — workers that reply to ``stats`` are treated as reachable.
        Omits active/reserved task lists; those counts stay 0 here (see get_worker for full inspect).
        """
        if timeout is None:
            timeout = self._inspect_timeout
        empty: Tuple[dict, dict, dict, dict, dict] = ({}, {}, {}, {}, {})
        try:
            i = self._celery.control.inspect(timeout=timeout)
            stats = i.stats() or {}
            active_queues = i.active_queues() or {}
            names = set(stats.keys()) | set(active_queues.keys())
            ping = {n: {"ok": "pong"} for n in names}
            return ping, stats, {}, {}, active_queues
        except Exception as e:
            logger.warning("Celery inspect (worker list) failed: %s", e)
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

    def _list_workers_impl(self) -> List[WorkerSummary]:
        ping, stats, active, reserved, active_queues = self._inspect_for_worker_list()
        all_names = sorted(set(stats.keys()) | set(active_queues.keys()))
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

    def _list_workers_from_redis_presence(self) -> List[WorkerSummary]:
        """Fast path: SCAN ``bifrost:ops:worker_presence:*`` written by workers (no control.inspect)."""
        try:
            import redis

            r = redis.from_url(
                self._broker_url,
                decode_responses=True,
                socket_connect_timeout=2,
                socket_timeout=3,
            )
            cur = 0
            results: List[WorkerSummary] = []
            seen: set[str] = set()
            match = f"{OPS_WORKER_PRESENCE_KEY_PREFIX}*"
            while True:
                cur, batch = r.scan(cursor=cur, match=match, count=256)
                for key in batch:
                    raw = r.get(key)
                    if not raw:
                        continue
                    try:
                        data = json.loads(raw)
                    except Exception:
                        continue
                    wid = data.get("worker_id")
                    if not wid and isinstance(key, str) and key.startswith(
                        OPS_WORKER_PRESENCE_KEY_PREFIX
                    ):
                        wid = key[len(OPS_WORKER_PRESENCE_KEY_PREFIX) :]
                    if not wid or not isinstance(wid, str) or wid in seen:
                        continue
                    seen.add(wid)
                    queues_raw = data.get("queues")
                    queues = (
                        [str(x) for x in queues_raw]
                        if isinstance(queues_raw, list)
                        else []
                    )
                    results.append(
                        WorkerSummary(
                            worker_id=wid,
                            status=WorkerStatus.RUNNING_HEALTHY,
                            queues=queues,
                            concurrency=0,
                            active_tasks=0,
                            reserved_tasks=0,
                            last_heartbeat=time.time(),
                        )
                    )
                if cur == 0:
                    break
            return sorted(results, key=lambda x: x.worker_id)
        except Exception as e:
            logger.warning("list_workers_from_redis_presence failed: %s", e)
            return []

    def _list_workers_inspect_bounded(self) -> List[WorkerSummary]:
        """Celery control.inspect — bounded wall time."""
        wall = self._inspect_wall_sec
        if wall <= 0:
            return self._list_workers_impl()
        pool = concurrent.futures.ThreadPoolExecutor(max_workers=1)
        try:
            fut = pool.submit(self._list_workers_impl)
            try:
                return fut.result(timeout=wall)
            except concurrent.futures.TimeoutError:
                logger.warning(
                    "list_workers timed out after %ss (celery inspect); returning empty",
                    wall,
                )
                return []
        finally:
            pool.shutdown(wait=False)

    def list_workers(self) -> List[WorkerSummary]:
        """Worker list: Redis presence (fast) or Celery inspect, per ``ops.worker_list_mode``."""
        mode = self._worker_list_mode or "redis_presence"
        if mode == "inspect":
            return self._list_workers_inspect_bounded()
        if mode == "redis_only":
            return self._list_workers_from_redis_presence()
        # redis_presence (default): Redis keys first; optional inspect fallback for old workers.
        out = self._list_workers_from_redis_presence()
        if out or not self._worker_list_fallback_inspect:
            return out
        return self._list_workers_inspect_bounded()

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

    @staticmethod
    def _task_routing_key(task: Dict[str, Any]) -> str:
        di = task.get("delivery_info")
        if isinstance(di, dict):
            rk = di.get("routing_key")
            if rk:
                return str(rk).strip()
        name = str(task.get("name") or "")
        if "backfill_bars" in name:
            return "bars"
        return ""

    def _count_celery_tasks_for_queue(
        self,
        queue_name: str,
        active: Optional[dict] = None,
        reserved: Optional[dict] = None,
    ) -> int:
        if active is None or reserved is None:
            _p, _s, active, reserved, _aq = self._inspect()
        n = 0
        for bucket in (active or {}, reserved or {}):
            for _wid, tasks in bucket.items():
                for t in tasks or []:
                    if not isinstance(t, dict):
                        continue
                    if self._task_routing_key(t) == queue_name:
                        n += 1
        return n

    def _broker_queue_depth(self, queue_name: str) -> int:
        try:
            import redis as _redis

            r = _redis.from_url(
                self._broker_url,
                socket_connect_timeout=3,
                socket_timeout=3,
            )
            r.ping()
            return int(r.llen(queue_name))
        except Exception as e:
            logger.debug("broker_queue_depth(%s): %s", queue_name, e)
        return 0

    def _pg_status_counts(self) -> Tuple[Optional[Dict[str, int]], Optional[Dict[str, int]]]:
        """Return (bars_status_counts, massive_status_counts) or Nones if DB unavailable."""
        pg = self._config.get("postgres") or {}
        host = str(pg.get("host") or "").strip()
        if not host:
            return None, None
        try:
            import psycopg2

            port = int(pg.get("port") or 5432)
            dbname = str(pg.get("database") or "options_db")
            user = str(pg.get("user") or "bifrost")
            password = str(pg.get("password") or "")
            conn = psycopg2.connect(
                host=host,
                port=port,
                dbname=dbname,
                user=user,
                password=password,
                connect_timeout=5,
            )
            try:
                bars_counts: Dict[str, int] = {"pending": 0, "running": 0, "done": 0, "failed": 0}
                massive_counts: Dict[str, int] = {"pending": 0, "running": 0, "done": 0, "failed": 0}
                with conn.cursor() as cur:
                    cur.execute(
                        "SELECT status, COUNT(*)::bigint FROM job_bars_backfill GROUP BY status"
                    )
                    for row in cur.fetchall() or []:
                        st = str(row[0] or "").strip().lower()
                        if st in bars_counts:
                            bars_counts[st] = int(row[1])
                    cur.execute(
                        "SELECT status, COUNT(*)::bigint FROM job_massive_backfill GROUP BY status"
                    )
                    for row in cur.fetchall() or []:
                        st = str(row[0] or "").strip().lower()
                        if st in massive_counts:
                            massive_counts[st] = int(row[1])
                return bars_counts, massive_counts
            finally:
                conn.close()
        except Exception as e:
            logger.debug("queue summary PG counts failed: %s", e)
            return None, None

    def queue_summaries(self) -> Dict[str, Any]:
        """Per supported queue: broker backlog, Celery running tasks, DB job totals."""
        bars_db, massive_db = self._pg_status_counts()
        _ping, _stats, active_ins, reserved_ins, _aq = self._inspect()
        rows: List[Dict[str, Any]] = []
        for q in SUPPORTED_CELERY_QUEUES:
            pending_broker = self._broker_queue_depth(q)
            running_celery = self._count_celery_tasks_for_queue(q, active_ins, reserved_ins)
            if q == "bars":
                done_db = bars_db.get("done") if bars_db else None
                failed_db = bars_db.get("failed") if bars_db else None
            else:
                done_db = massive_db.get("done") if massive_db else None
                failed_db = massive_db.get("failed") if massive_db else None
            row: Dict[str, Any] = {
                "name": q,
                "pending_broker": pending_broker,
                "running_celery": running_celery,
                "done_db": done_db,
                "failed_db": failed_db,
            }
            if q != "bars":
                row["db_totals_shared"] = True
            rows.append(row)
        out: Dict[str, Any] = {
            "queues": rows,
            "db_connected": bars_db is not None,
        }
        if massive_db is not None:
            out["massive_db_note"] = (
                "Done and Failed for Massive queues are totals from job_massive_backfill "
                "(not split between massive and massive_high)."
            )
        return out

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
