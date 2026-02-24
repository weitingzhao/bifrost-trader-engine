"""Read-only PostgreSQL access for status_current and operations. Phase 2."""

import logging
from typing import Any, Dict, List, Optional

import psycopg2
from psycopg2.extras import RealDictCursor

from src.sink.postgres_sink import _get_conn_params

logger = logging.getLogger(__name__)


def _row_to_heartbeat(row: tuple) -> Dict[str, Any]:
    """Build daemon_heartbeat dict from (last_ts, hedge_running, ib_connected, ib_client_id, next_retry_ts, seconds_until_retry, graceful_shutdown_at[, heartbeat_interval_sec])."""
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
    return out


class StatusReader:
    """Read status_current and operations from PostgreSQL. Uses same config as daemon (status.postgres)."""

    def __init__(self, status_config: dict) -> None:
        self._config = status_config
        self._conn: Any = None

    def _connect(self) -> bool:
        if self._conn is not None:
            try:
                self._conn.rollback()
                return True
            except Exception:
                self._conn = None
        try:
            params = _get_conn_params(self._config)
            self._conn = psycopg2.connect(**params)
            with self._conn.cursor() as cur:
                cur.execute("SET lock_timeout = '5s'")
            self._conn.commit()
            return True
        except Exception as e:
            logger.warning("StatusReader connect failed: %s", e)
            return False

    def get_status_current(self) -> Optional[Dict[str, Any]]:
        """Return the single row from status_current as a dict, or None if empty/unavailable."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT * FROM status_current WHERE id = 1")
                row = cur.fetchone()
            if row is None:
                return None
            # RealDictCursor gives dict with column names; normalize keys to match SNAPSHOT_KEYS
            return dict(row)
        except Exception as e:
            logger.warning("get_status_current failed: %s", e)
            self._conn = None
            return None

    def get_run_status(self) -> Optional[bool]:
        """Return daemon_run_status.suspended for row id=1 (True=suspended, False=running). None if table missing or unavailable."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT suspended FROM daemon_run_status WHERE id = 1")
                row = cur.fetchone()
            if row is None:
                return None
            return bool(row[0])
        except Exception as e:
            logger.debug("get_run_status failed: %s", e)
            self._conn = None
            return None

    def get_daemon_heartbeat(self) -> Optional[Dict[str, Any]]:
        """Return daemon_heartbeat row id=1: last_ts, hedge_running, ib_connected, ib_client_id, next_retry_ts (RE-6/RE-7). None if table missing."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT extract(epoch from last_ts) AS last_ts, hedge_running,
                           ib_connected, ib_client_id,
                           extract(epoch from next_retry_ts) AS next_retry_ts,
                           seconds_until_retry,
                           extract(epoch from graceful_shutdown_at) AS graceful_shutdown_at,
                           heartbeat_interval_sec
                    FROM daemon_heartbeat WHERE id = 1
                    """
                )
                row = cur.fetchone()
            if row is None:
                return None
            out = _row_to_heartbeat(row)
            return out
        except Exception as e:
            # Column graceful_shutdown_at may be missing in DBs not yet migrated
            err = str(e).lower()
            if "graceful_shutdown_at" in err or "column" in err:
                try:
                    with self._conn.cursor() as cur:
                        cur.execute(
                            """
                            SELECT extract(epoch from last_ts), hedge_running,
                                   ib_connected, ib_client_id,
                                   extract(epoch from next_retry_ts), seconds_until_retry
                            FROM daemon_heartbeat WHERE id = 1
                            """
                        )
                        row = cur.fetchone()
                    if row is None:
                        return None
                    return _row_to_heartbeat(row + (None, None))  # graceful_shutdown_at, heartbeat_interval_sec = None
                except Exception as e2:
                    logger.debug("get_daemon_heartbeat (fallback) failed: %s", e2)
                    self._conn = None
            logger.debug("get_daemon_heartbeat failed: %s", e)
            self._conn = None
            return None

    def get_operations(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        type_filter: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Return rows from operations, optionally filtered by time and type. Newest first."""
        if not self._connect():
            return []
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
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    f"SELECT * FROM operations{where} ORDER BY ts DESC LIMIT %s",
                    values,
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        except Exception as e:
            logger.warning("get_operations failed: %s", e)
            return []

    def get_accounts_from_tables(self) -> Optional[List[Dict[str, Any]]]:
        """Build R-A1 accounts list from normalized accounts + account_positions (same shape as [{ account_id, summary, positions }]).
        Returns None on error or missing tables; caller typically uses [] in that case."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT account_id, updated_at, net_liquidation, total_cash, buying_power, summary_extra FROM accounts ORDER BY account_id"
                )
                acc_rows = cur.fetchall()
            if not acc_rows:
                return []
            out: List[Dict[str, Any]] = []
            for row in acc_rows:
                acc_id = row.get("account_id") or ""
                summary: Dict[str, Any] = {}
                if row.get("net_liquidation") is not None:
                    summary["NetLiquidation"] = str(row["net_liquidation"])
                if row.get("total_cash") is not None:
                    summary["TotalCashValue"] = str(row["total_cash"])
                if row.get("buying_power") is not None:
                    summary["BuyingPower"] = str(row["buying_power"])
                if acc_id:
                    summary["account"] = acc_id
                extra = row.get("summary_extra")
                if isinstance(extra, dict):
                    for k, v in extra.items():
                        summary[k] = v if isinstance(v, str) else str(v)
                with self._conn.cursor(cursor_factory=RealDictCursor) as cur2:
                    cur2.execute(
                        "SELECT account_id, symbol, sec_type, exchange, currency, position, avg_cost, expiry, strike, option_right FROM account_positions WHERE account_id = %s ORDER BY contract_key",
                        (acc_id,),
                    )
                    pos_rows = cur2.fetchall()
                positions = []
                for p in pos_rows:
                    pos_dict: Dict[str, Any] = {
                        "account": p.get("account_id"),
                        "symbol": p.get("symbol") or "",
                        "secType": p.get("sec_type") or "",
                        "exchange": p.get("exchange") or "",
                        "currency": p.get("currency") or "",
                        "position": p.get("position"),
                        "avgCost": p.get("avg_cost"),
                    }
                    if p.get("expiry") is not None:
                        pos_dict["lastTradeDateOrContractMonth"] = p.get("expiry")
                    if p.get("strike") is not None:
                        pos_dict["strike"] = p.get("strike")
                    if p.get("option_right") is not None:
                        pos_dict["right"] = p.get("option_right")
                    positions.append(pos_dict)
                out.append({"account_id": acc_id, "summary": summary, "positions": positions})
            return out
        except Exception as e:
            logger.debug("get_accounts_from_tables failed: %s", e)
            self._conn = None
            return None

    def get_ib_config(self) -> Optional[Dict[str, Any]]:
        """Return settings row id=1: ib_host, ib_port_type (for GET /status and UI). None if table missing."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT ib_host, ib_port_type FROM settings WHERE id = 1")
                row = cur.fetchone()
            if row is None:
                return None
            return {"ib_host": (row.get("ib_host") or "127.0.0.1").strip(), "ib_port_type": (row.get("ib_port_type") or "tws_paper").strip().lower()}
        except Exception as e:
            logger.debug("get_ib_config failed: %s", e)
            self._conn = None
            return None

    def close(self) -> None:
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None


def write_control_command(status_config: dict, command: str) -> bool:
    """Insert a control command (stop/flatten) into daemon_control table. Returns True on success. Phase 2: DB-based control (RE-5)."""
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
    """Update daemon_run_status row id=1 (suspended=true/false). Daemon polls this to pause/resume hedging. Returns True on success."""
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
    """Update daemon_run_status.heartbeat_interval_sec for row id=1. Daemon polls and uses this (clamped 5–120). Returns True on success."""
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


_VALID_IB_PORT_TYPES = frozenset(("tws_live", "tws_paper", "gateway"))


def write_ib_config(status_config: dict, ib_host: str, ib_port_type: str) -> bool:
    """Update settings (id=1): ib_host and ib_port_type (tws_live|tws_paper|gateway). Daemon loads this on next start. Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    host = (ib_host or "").strip() or "127.0.0.1"
    port_type = (ib_port_type or "").strip().lower() or "tws_paper"
    if port_type not in _VALID_IB_PORT_TYPES:
        port_type = "tws_paper"
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO settings (id, ib_host, ib_port_type) VALUES (1, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET ib_host = EXCLUDED.ib_host, ib_port_type = EXCLUDED.ib_port_type
                    """,
                    (host, port_type),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_ib_config failed: %s", e)
        return False
