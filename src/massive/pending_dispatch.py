"""Cap in-flight Massive Celery tasks per broker queue so DB ``pending`` rows are not all ``apply_async`` at once.

After batch retry or when a worker finishes a job, :func:`dispatch_pending_massive_topup` issues new broker
messages until ``ops.celery.massive_pending_dispatch_inflight_cap`` rows for that queue slice are either
``running`` or ``pending`` with a non-empty ``celery_task_id`` (message handed to the broker).
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_DEFAULT_INFLIGHT_CAP = 12


def massive_pending_dispatch_inflight_cap(status_cfg: Dict[str, Any]) -> int:
    ops = status_cfg.get("ops") or {}
    celery_ops = ops.get("celery") or {}
    raw = celery_ops.get("massive_pending_dispatch_inflight_cap", _DEFAULT_INFLIGHT_CAP)
    try:
        return max(1, min(int(raw), 256))
    except (TypeError, ValueError):
        return _DEFAULT_INFLIGHT_CAP


def _count_inflight_for_queue_slice(
    status_cfg: Dict[str, Any],
    qcond: str,
    qparams: List[Any],
) -> int:
    try:
        from src.persistence.postgres.connection import _get_conn_params
    except Exception:
        return 0
    try:
        params = _get_conn_params(status_cfg)
    except Exception:
        return 0
    sql = f"""
        SELECT COUNT(*)::bigint
        FROM job_massive_backfill
        WHERE (status = 'running'
               OR (status = 'pending' AND coalesce(trim(celery_task_id), '') <> ''))
          AND ({qcond})
    """
    import psycopg2

    try:
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(sql, tuple(qparams))
                row = cur.fetchone()
            return int(row[0]) if row and row[0] is not None else 0
        finally:
            conn.close()
    except Exception as e:
        logger.warning("count in-flight massive jobs: %s", e)
        return 0


def _claim_next_pending_job_id(
    status_cfg: Dict[str, Any],
    qcond: str,
    qparams: List[Any],
) -> Optional[int]:
    from src.persistence.postgres.connection import _get_conn_params
    import psycopg2

    try:
        params = _get_conn_params(status_cfg)
    except Exception:
        return None
    sql = f"""
        WITH c AS (
            SELECT job_massive_backfill_id
            FROM job_massive_backfill
            WHERE status = 'pending'
              AND (celery_task_id IS NULL OR trim(celery_task_id) = '')
              AND ({qcond})
            ORDER BY job_massive_backfill_id ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED
        )
        SELECT job_massive_backfill_id FROM c
    """
    try:
        conn = psycopg2.connect(**params)
        try:
            conn.autocommit = False
            with conn.cursor() as cur:
                cur.execute(sql, tuple(qparams))
                row = cur.fetchone()
            conn.commit()
            return int(row[0]) if row and row[0] is not None else None
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            conn.close()
    except Exception as e:
        logger.warning("claim next pending massive job: %s", e)
        return None


def _dispatch_one_queue(status_cfg: Dict[str, Any], celery_queue: str) -> int:
    from src.vendor.massive.reader import (
        _massive_celery_queue_condition,
        get_job_massive_backfill,
    )

    cq = (celery_queue or "").strip()
    if not cq:
        return 0
    qcond, qparams = _massive_celery_queue_condition(cq)
    if not qcond:
        return 0
    cap = massive_pending_dispatch_inflight_cap(status_cfg)
    did = 0
    while True:
        inflight = _count_inflight_for_queue_slice(status_cfg, qcond, qparams)
        if inflight >= cap:
            break
        jid = _claim_next_pending_job_id(status_cfg, qcond, qparams)
        if jid is None:
            break
        row = get_job_massive_backfill(status_cfg, jid)
        if not row:
            continue
        if str(row.get("status") or "").strip().lower() != "pending":
            continue
        # Lazy import avoids circular import at Celery worker startup.
        from src.massive.tasks import reenqueue_massive_job_from_row

        ok, err = reenqueue_massive_job_from_row(status_cfg, dict(row))
        if ok:
            did += 1
        else:
            logger.info("dispatch_pending: stop after enqueue failure job_id=%s err=%s", jid, err)
            break
    return did


def dispatch_pending_massive_topup(
    status_cfg: Dict[str, Any],
    celery_queue: Optional[str] = None,
) -> int:
    """Top up broker messages for pending rows, per queue slice (or all Massive queues if ``celery_queue`` is falsy)."""
    if not status_cfg or (status_cfg.get("sink") != "postgres" and not status_cfg.get("postgres")):
        return 0
    cq = (celery_queue or "").strip()
    if cq:
        return _dispatch_one_queue(status_cfg, cq)
    total = 0
    for q in ("options_massive_high", "options_massive", "stocks_massive_high", "stocks_massive"):
        total += _dispatch_one_queue(status_cfg, q)
    return total
