"""Strategy instance CRUD: list, get, create, update. Used for trade attribution (SI.2)."""

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from psycopg2.extras import RealDictCursor

logger = logging.getLogger(__name__)


def list_instances(
    conn: Any,
    account_id: Optional[str] = None,
    strategy_opportunity_id: Optional[int] = None,
    opened_at_from: Optional[float] = None,
    opened_at_until: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """List strategy instances, optionally filtered by account_id, strategy_opportunity_id, opened_at range (Unix seconds)."""
    if conn is None:
        return []
    try:
        conditions = []
        values: List[Any] = []
        if account_id is not None and str(account_id).strip():
            conditions.append("si.account_id = %s")
            values.append(str(account_id).strip())
        if strategy_opportunity_id is not None:
            conditions.append("si.strategy_opportunity_id = %s")
            values.append(strategy_opportunity_id)
        if opened_at_from is not None and opened_at_from > 0:
            conditions.append("si.opened_at >= to_timestamp(%s)")
            values.append(opened_at_from)
        if opened_at_until is not None and opened_at_until > 0:
            conditions.append("si.opened_at <= to_timestamp(%s)")
            values.append(opened_at_until)
        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""
                SELECT si.strategy_instance_id, si.strategy_opportunity_id, si.account_id,
                       si.opened_at, si.label, si.notes, si.created_at, si.updated_at,
                       so.name AS strategy_opportunity_name,
                       (SELECT COUNT(*) FROM account_executions e WHERE e.strategy_instance_id = si.strategy_instance_id) AS executions_count
                FROM strategy_instance si
                LEFT JOIN strategy_opportunity so ON si.strategy_opportunity_id = so.strategy_opportunity_id
                {where}
                ORDER BY si.opened_at DESC
                """,
                values,
            )
            rows = cur.fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            if d.get("opened_at") is not None and hasattr(d["opened_at"], "timestamp"):
                d["opened_at_epoch"] = d["opened_at"].timestamp()
            if d.get("created_at") is not None and hasattr(d["created_at"], "timestamp"):
                d["created_at_epoch"] = d["created_at"].timestamp()
            if d.get("executions_count") is not None:
                d["executions_count"] = int(d["executions_count"])
            out.append(d)
        return out
    except Exception as e:
        logger.debug("list_instances failed: %s", e)
        return []


def get_instance_by_id(conn: Any, strategy_instance_id: int) -> Optional[Dict[str, Any]]:
    """Return one strategy instance by id, or None."""
    if conn is None:
        return None
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT si.strategy_instance_id, si.strategy_opportunity_id, si.account_id,
                       si.opened_at, si.label, si.notes, si.created_at, si.updated_at,
                       so.name AS strategy_opportunity_name
                FROM strategy_instance si
                LEFT JOIN strategy_opportunity so ON si.strategy_opportunity_id = so.strategy_opportunity_id
                WHERE si.strategy_instance_id = %s
                """,
                (strategy_instance_id,),
            )
            row = cur.fetchone()
        if row is None:
            return None
        d = dict(row)
        if d.get("opened_at") is not None and hasattr(d["opened_at"], "timestamp"):
            d["opened_at_epoch"] = d["opened_at"].timestamp()
        if d.get("created_at") is not None and hasattr(d["created_at"], "timestamp"):
            d["created_at_epoch"] = d["created_at"].timestamp()
        return d
    except Exception as e:
        logger.debug("get_instance_by_id failed: %s", e)
        return None


def create_instance(
    conn: Any,
    strategy_opportunity_id: int,
    account_id: str,
    opened_at: Any,
    label: Optional[str] = None,
    notes: Optional[str] = None,
) -> Optional[int]:
    """Insert one strategy_instance. opened_at: datetime or Unix timestamp. Returns strategy_instance_id or None."""
    if conn is None:
        return None
    account_id = (account_id or "").strip()
    if not account_id:
        return None
    if isinstance(opened_at, (int, float)):
        try:
            opened_dt = datetime.fromtimestamp(float(opened_at), tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            return None
    elif hasattr(opened_at, "timestamp"):
        opened_dt = opened_at
    else:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO strategy_instance (strategy_opportunity_id, account_id, opened_at, label, notes, updated_at)
                VALUES (%s, %s, %s, %s, %s, now())
                RETURNING strategy_instance_id
                """,
                (strategy_opportunity_id, account_id, opened_dt, label or None, notes or None),
            )
            row = cur.fetchone()
        conn.commit()
        return int(row[0]) if row and row[0] is not None else None
    except Exception as e:
        logger.warning("create_instance failed: %s", e)
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        return None


def update_instance(
    conn: Any,
    strategy_instance_id: int,
    label: Optional[str] = None,
    notes: Optional[str] = None,
    created_at: Optional[Any] = None,
    opened_at: Optional[Any] = None,
) -> bool:
    """Update label, notes, created_at, and/or opened_at of a strategy instance. created_at/opened_at: datetime or Unix timestamp. Returns True if a row was updated."""
    if conn is None:
        return False
    updates = []
    values: List[Any] = []
    if label is not None:
        updates.append("label = %s")
        values.append(label.strip() if isinstance(label, str) else label)
    if notes is not None:
        updates.append("notes = %s")
        values.append(notes.strip() if isinstance(notes, str) else notes)
    if created_at is not None:
        if isinstance(created_at, (int, float)):
            try:
                created_dt = datetime.fromtimestamp(float(created_at), tz=timezone.utc)
            except (TypeError, ValueError, OSError):
                created_dt = None
            if created_dt is not None:
                updates.append("created_at = %s")
                values.append(created_dt)
        elif hasattr(created_at, "timestamp"):
            updates.append("created_at = %s")
            values.append(created_at)
    if opened_at is not None:
        opened_dt = None
        if isinstance(opened_at, (int, float)):
            try:
                opened_dt = datetime.fromtimestamp(float(opened_at), tz=timezone.utc)
            except (TypeError, ValueError, OSError):
                pass
        elif hasattr(opened_at, "timestamp"):
            opened_dt = opened_at
        if opened_dt is not None:
            updates.append("opened_at = %s")
            values.append(opened_dt)
    if not updates:
        return True
    updates.append("updated_at = now()")
    values.append(strategy_instance_id)
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE strategy_instance SET {', '.join(updates)} WHERE strategy_instance_id = %s",
                values,
            )
            if cur.rowcount == 0:
                return False
        conn.commit()
        return True
    except Exception as e:
        logger.warning("update_instance failed: %s", e)
        if conn is not None:
            try:
                conn.rollback()
            except Exception:
                pass
        return False
