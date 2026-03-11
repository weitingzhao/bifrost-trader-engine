"""Status, operations, daemon_heartbeat, daemon_run_status, control commands."""

import logging
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2.extras import RealDictCursor

from src.sink.postgres_sink import _get_conn_params

logger = logging.getLogger(__name__)


def _row_to_heartbeat(row: tuple) -> Dict[str, Any]:
    """Build daemon_heartbeat dict from (last_ts, hedge_running, ib_connected, ...)."""
    out = {
        "last_ts": float(row[0]) if row[0] is not None else None,
        "hedge_running": bool(row[1]),
        "ib_connected": bool(row[2]) if row[2] is not None else False,
        "ib_client_id": int(row[3]) if row[3] is not None else None,
        "next_retry_ts": float(row[4]) if row[4] is not None else None,
        "seconds_until_retry": int(row[5]) if row[5] is not None else None,
        "graceful_shutdown_at": float(row[6]) if len(row) > 6 and row[6] is not None else None,
    }
    out["heartbeat_interval_sec"] = int(row[7]) if len(row) > 7 and row[7] is not None else None
    out["redis_quotes_connected"] = bool(row[8]) if len(row) > 8 and row[8] is not None else False
    out["event_subscribe_ticker"] = bool(row[9]) if len(row) > 9 and row[9] is not None else False
    out["event_subscribe_positions"] = bool(row[10]) if len(row) > 10 and row[10] is not None else False
    out["event_subscribe_fills"] = bool(row[11]) if len(row) > 11 and row[11] is not None else False
    out["event_subscribe_commission"] = bool(row[12]) if len(row) > 12 and row[12] is not None else False
    out["listener_connected"] = bool(row[13]) if len(row) > 13 and row[13] is not None else False
    out["listener_client_id"] = int(row[14]) if len(row) > 14 and row[14] is not None else None
    return out


def get_status_current(conn: Any) -> Optional[Dict[str, Any]]:
    """Return the single row from status_current as a dict, or None if empty/unavailable."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT * FROM status_current WHERE id = 1")
            row = cur.fetchone()
        if row is None:
            return None
        return dict(row)
    except Exception as e:
        logger.warning("get_status_current failed: %s", e)
        return None


def get_run_status(conn: Any) -> Optional[bool]:
    """Return daemon_run_status.suspended for row id=1. None if table missing or unavailable."""
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT suspended FROM daemon_run_status WHERE id = 1")
            row = cur.fetchone()
        if row is None:
            return None
        return bool(row[0])
    except Exception as e:
        logger.debug("get_run_status failed: %s", e)
        return None


def get_daemon_heartbeat(conn: Any) -> Optional[Dict[str, Any]]:
    """Return daemon_heartbeat row id=1. None if table missing."""
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT extract(epoch from last_ts) AS last_ts, hedge_running,
                       ib_connected, ib_client_id,
                       extract(epoch from next_retry_ts) AS next_retry_ts,
                       seconds_until_retry,
                       extract(epoch from graceful_shutdown_at) AS graceful_shutdown_at,
                       heartbeat_interval_sec,
                       redis_quotes_connected,
                       event_subscribe_ticker, event_subscribe_positions,
                       event_subscribe_fills, event_subscribe_commission,
                       listener_connected, listener_client_id
                FROM daemon_heartbeat WHERE id = 1
                """
            )
            row = cur.fetchone()
        if row is None:
            return None
        return _row_to_heartbeat(row)
    except Exception as e:
        err = str(e).lower()
        if "listener_connected" in err or "listener_client_id" in err:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT extract(epoch from last_ts) AS last_ts, hedge_running,
                               ib_connected, ib_client_id,
                               extract(epoch from next_retry_ts) AS next_retry_ts,
                               seconds_until_retry,
                               extract(epoch from graceful_shutdown_at) AS graceful_shutdown_at,
                               heartbeat_interval_sec,
                               redis_quotes_connected,
                               event_subscribe_ticker, event_subscribe_positions,
                               event_subscribe_fills, event_subscribe_commission
                        FROM daemon_heartbeat WHERE id = 1
                        """
                    )
                    row = cur.fetchone()
                if row is None:
                    return None
                return _row_to_heartbeat(row + (None, None))
            except Exception as e2:
                logger.debug("get_daemon_heartbeat (fallback no listener_*) failed: %s", e2)
        if "event_subscribe" in err or "redis_quotes_connected" in err:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT extract(epoch from last_ts) AS last_ts, hedge_running,
                               ib_connected, ib_client_id,
                               extract(epoch from next_retry_ts) AS next_retry_ts,
                               seconds_until_retry,
                               extract(epoch from graceful_shutdown_at) AS graceful_shutdown_at,
                               heartbeat_interval_sec,
                               redis_quotes_connected
                        FROM daemon_heartbeat WHERE id = 1
                        """
                    )
                    row = cur.fetchone()
                if row is None:
                    return None
                extra = (None,) * (15 - len(row))
                return _row_to_heartbeat(row + extra)
            except Exception as e2:
                logger.debug("get_daemon_heartbeat (fallback no event_subscribe/redis_quotes) failed: %s", e2)
        if "graceful_shutdown_at" in err or "column" in err:
            try:
                with conn.cursor() as cur:
                    cur.execute(
                        """
                        SELECT extract(epoch from last_ts), hedge_running,
                               ib_connected, ib_client_id,
                               extract(epoch from next_retry_ts), seconds_until_retry,
                               NULL, NULL, NULL, NULL, NULL, NULL, NULL
                        FROM daemon_heartbeat WHERE id = 1
                        """
                    )
                    row = cur.fetchone()
                if row is None:
                    return None
                return _row_to_heartbeat(row)
            except Exception as e2:
                logger.debug("get_daemon_heartbeat (fallback) failed: %s", e2)
        logger.debug("get_daemon_heartbeat failed: %s", e)
        return None


def get_operations(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
    type_filter: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    """Return rows from operations, optionally filtered by time and type. Newest first."""
    try:
        conditions = []
        values: List[Any] = []
        if since_ts is not None:
            conditions.append("ts >= %s")
            values.append(since_ts)
        if until_ts is not None:
            conditions.append("ts <= %s")
            values.append(until_ts)
        if type_filter is not None:
            conditions.append("type = %s")
            values.append(type_filter)
        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        values.append(limit)
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"SELECT * FROM operations{where} ORDER BY ts DESC LIMIT %s",
                values,
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        logger.warning("get_operations failed: %s", e)
        return []


def write_control_command(status_config: dict, command: str) -> bool:
    """Insert a control command (stop/flatten) into daemon_control table. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("INSERT INTO daemon_control (command) VALUES (%s)", (command.strip().lower(),))
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_control_command failed: %s", e)
        return False


def write_run_status(status_config: dict, suspended: bool) -> bool:
    """Update daemon_run_status row id=1 (suspended=true/false). Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO daemon_run_status (id, suspended, updated_at)
                    VALUES (1, %s, now())
                    ON CONFLICT (id) DO UPDATE SET suspended = %s, updated_at = now()
                    """,
                    (suspended, suspended),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_run_status failed: %s", e)
        return False


def write_heartbeat_interval(status_config: dict, heartbeat_interval_sec: int) -> bool:
    """Update daemon_run_status.heartbeat_interval_sec for row id=1 (clamped 5-120). Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    sec = max(5, min(120, heartbeat_interval_sec))
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE daemon_run_status SET heartbeat_interval_sec = %s, updated_at = now() WHERE id = 1",
                    (sec,),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_heartbeat_interval failed: %s", e)
        return False
