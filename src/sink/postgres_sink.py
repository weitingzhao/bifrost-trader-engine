"""PostgreSQL implementation of StatusSink. See docs/DATABASE.md."""

import logging
import os
import time
from typing import Any, Dict, List, Optional, Tuple

import psycopg2

from src.sink.base import OPERATION_KEYS, SNAPSHOT_KEYS, StatusSink

logger = logging.getLogger(__name__)

# Table(s) to auto-release locks on when daemon hits lock timeout (e.g. after crash restart)
_DAEMON_LOCK_TABLES: Tuple[str, ...] = ("daemon_heartbeat", "daemon_run_status")


def _is_lock_timeout_error(e: Exception) -> bool:
    """True if exception is due to lock timeout (55P03 or message)."""
    if getattr(e, "pgcode", None) == "55P03":
        return True
    msg = str(e).lower()
    return "lock timeout" in msg or "canceling statement due to lock timeout" in msg


def release_pg_locks_for_tables(
    config: dict,
    tables: Tuple[str, ...] = _DAEMON_LOCK_TABLES,
) -> int:
    """Open a new connection, find backends holding or waiting for locks on the given
    table names, terminate them (pg_terminate_backend), and return the number terminated.
    Used when the daemon hits lock timeout on daemon_heartbeat or daemon_run_status after crash/restart.
    """
    params = _get_conn_params(config)
    params["connect_timeout"] = 10
    try:
        conn = psycopg2.connect(**params)
    except Exception as e:
        logger.warning("release_pg_locks_for_tables: connect failed: %s", e)
        return 0
    my_pid = conn.get_backend_pid()
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT DISTINCT l.pid
                FROM pg_locks l
                JOIN pg_class c ON l.relation = c.oid
                JOIN pg_stat_activity a ON l.pid = a.pid
                WHERE c.relname = ANY(%s)
                  AND l.pid != %s
                """,
                (list(tables), my_pid),
            )
            pids: List[int] = [r[0] for r in cur.fetchall()]
    except Exception as e:
        logger.warning("release_pg_locks_for_tables: query failed: %s", e)
        conn.close()
        return 0
    terminated = 0
    for pid in pids:
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_terminate_backend(%s)", (pid,))
                if cur.fetchone()[0]:
                    terminated += 1
                    logger.info("Terminated backend pid=%s (lock on %s)", pid, tables)
        except Exception as e:
            logger.debug("Failed to terminate pid=%s: %s", pid, e)
    conn.close()
    return terminated


def _get_conn_params(config: dict) -> dict:
    """Build connection params from status.postgres, with env overrides."""
    pg = config.get("postgres", {}) or {}
    # Database: support database, Database, db, or any key that lower() in ("database", "db")
    db = pg.get("database") or pg.get("Database") or pg.get("db")
    if not db and pg:
        for k, v in pg.items():
            if k and isinstance(v, str) and v.strip() and k.strip().lower() in ("database", "db"):
                db = v.strip()
                break
    return {
        "host": pg.get("host") or os.environ.get("PGHOST", "127.0.0.1"),
        "port": int(pg.get("port") or os.environ.get("PGPORT", "5432")),
        "dbname": db or os.environ.get("PGDATABASE", "bifrost"),
        "user": pg.get("user") or os.environ.get("PGUSER", "bifrost"),
        "password": pg.get("password") or os.environ.get("PGPASSWORD", ""),
    }


# IB port type (stored in settings.ib_port_type) → TWS/Gateway port
IB_PORT_TYPE_TO_PORT = {
    "tws_live": 7496,
    "tws_paper": 7497,
    "gateway": 4002,
}


def _ensure_tables(conn) -> None:
    """Create status_current, status_history, operations if not exist (per DATABASE.md §2)."""
    try:
        conn.rollback()
    except Exception:
        pass
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS status_current (
                id integer PRIMARY KEY DEFAULT 1,
                daemon_state text,
                trading_state text,
                symbol text,
                spot double precision,
                bid double precision,
                ask double precision,
                net_delta double precision,
                stock_position integer,
                option_legs_count integer,
                daily_hedge_count integer,
                daily_pnl double precision,
                data_lag_ms double precision,
                config_summary text,
                ts double precision
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS status_history (
                id bigserial PRIMARY KEY,
                daemon_state text,
                trading_state text,
                symbol text,
                spot double precision,
                bid double precision,
                ask double precision,
                net_delta double precision,
                stock_position integer,
                option_legs_count integer,
                daily_hedge_count integer,
                daily_pnl double precision,
                data_lag_ms double precision,
                config_summary text,
                ts double precision
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS operations (
                id bigserial PRIMARY KEY,
                ts double precision,
                type text,
                side text,
                quantity integer,
                price double precision,
                state_reason text
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS daemon_control (
                id bigserial PRIMARY KEY,
                command text NOT NULL,
                created_at timestamptz DEFAULT now(),
                consumed_at timestamptz
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS daemon_run_status (
                id integer PRIMARY KEY DEFAULT 1,
                suspended boolean NOT NULL DEFAULT false,
                updated_at timestamptz DEFAULT now()
            )
        """)
        cur.execute("""
            INSERT INTO daemon_run_status (id, suspended) VALUES (1, false)
            ON CONFLICT (id) DO NOTHING
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS daemon_heartbeat (
                id integer PRIMARY KEY DEFAULT 1,
                last_ts timestamptz NOT NULL DEFAULT now(),
                hedge_running boolean NOT NULL DEFAULT false
            )
        """)
        cur.execute("""
            INSERT INTO daemon_heartbeat (id, last_ts, hedge_running) VALUES (1, now(), false)
            ON CONFLICT (id) DO NOTHING
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS settings (
                id integer PRIMARY KEY DEFAULT 1,
                ib_host text NOT NULL DEFAULT '127.0.0.1',
                ib_port_type text NOT NULL DEFAULT 'tws_paper'
            )
        """)
        cur.execute("""
            INSERT INTO settings (id, ib_host, ib_port_type) VALUES (1, '127.0.0.1', 'tws_paper')
            ON CONFLICT (id) DO NOTHING
        """)
        conn.commit()
        # Migrate from legacy daemon_ib_config if present (one-time, safe to skip if table missing)
        try:
            with conn.cursor() as cur2:
                cur2.execute("""
                    UPDATE settings s SET ib_host = d.ib_host, ib_port_type = d.ib_port_type
                    FROM daemon_ib_config d WHERE d.id = 1 AND s.id = 1
                """)
            conn.commit()
        except Exception:
            conn.rollback()
        # RE-7: add columns if not exist (each ALTER in its own transaction so duplicate_column doesn't abort the rest)
        for _col, sql in [
            ("ib_connected", "ALTER TABLE daemon_heartbeat ADD COLUMN ib_connected boolean DEFAULT false"),
            ("ib_client_id", "ALTER TABLE daemon_heartbeat ADD COLUMN ib_client_id integer"),
            ("next_retry_ts", "ALTER TABLE daemon_heartbeat ADD COLUMN next_retry_ts timestamptz"),
            ("seconds_until_retry", "ALTER TABLE daemon_heartbeat ADD COLUMN seconds_until_retry smallint"),
            ("graceful_shutdown_at", "ALTER TABLE daemon_heartbeat ADD COLUMN graceful_shutdown_at timestamptz"),
            ("heartbeat_interval_sec", "ALTER TABLE daemon_heartbeat ADD COLUMN heartbeat_interval_sec smallint"),
            ("run_status_heartbeat_interval", "ALTER TABLE daemon_run_status ADD COLUMN heartbeat_interval_sec smallint"),
        ]:
            try:
                cur.execute(sql)
                conn.commit()
            except psycopg2.ProgrammingError as e:
                conn.rollback()  # clear aborted state so next ALTER can run
                if e.pgcode != "42701":  # 42701 = duplicate_column (column already exists)
                    raise


class PostgreSQLSink(StatusSink):
    """Writes snapshot to status_current (and optionally status_history) and operations to operations table."""

    def __init__(self, config: dict):
        self._config = config
        self._conn: Optional[Any] = None
        self._connect()

    def _connect(self) -> None:
        params = _get_conn_params(self._config)
        for attempt in (1, 2):
            try:
                self._conn = psycopg2.connect(**params)
                # Avoid blocking forever if another session holds a lock on daemon_heartbeat/status_current
                with self._conn.cursor() as cur:
                    cur.execute("SET lock_timeout = '5s'")
                self._conn.commit()
                _ensure_tables(self._conn)
                logger.info("PostgreSQL sink connected: %s@%s:%s/%s", params["user"], params["host"], params["port"], params["dbname"])
                return
            except Exception as e:
                self._conn = None
                if attempt == 1 and _is_lock_timeout_error(e):
                    n = release_pg_locks_for_tables(self._config)
                    if n > 0:
                        logger.info("Released %s backend(s) holding lock on %s; retrying connect", n, _DAEMON_LOCK_TABLES)
                        time.sleep(0.5)
                        continue
                logger.warning("PostgreSQL sink connect failed: %s", e)
                return

    def _ensure_conn(self) -> bool:
        if self._conn is None:
            self._connect()
        if self._conn is not None:
            try:
                self._conn.rollback()
                return True
            except Exception:
                self._conn = None
                self._connect()
        return self._conn is not None

    def write_snapshot(self, snapshot: Dict[str, Any], append_history: bool = False) -> None:
        if not self._ensure_conn():
            return
        cols = ", ".join(SNAPSHOT_KEYS)
        placeholders = ", ".join("%s" for _ in SNAPSHOT_KEYS)
        values = [snapshot.get(k) for k in SNAPSHOT_KEYS]
        try:
            with self._conn.cursor() as cur:
                # Upsert single row (id=1) for status_current
                updates = ", ".join(f"{k} = EXCLUDED.{k}" for k in SNAPSHOT_KEYS if k != "id")
                cur.execute(
                    f"""
                    INSERT INTO status_current (id, {cols})
                    VALUES (1, {placeholders})
                    ON CONFLICT (id) DO UPDATE SET {updates}
                    """,
                    values,
                )
                if append_history:
                    cur.execute(
                        f"INSERT INTO status_history ({cols}) VALUES ({placeholders})",
                        values,
                    )
            self._conn.commit()
        except Exception as e:
            self._conn.rollback()
            logger.warning("PostgreSQL write_snapshot failed: %s", e)

    def write_operation(self, record: Dict[str, Any]) -> None:
        if not self._ensure_conn():
            return
        cols = ", ".join(OPERATION_KEYS)
        placeholders = ", ".join("%s" for _ in OPERATION_KEYS)
        values = [record.get(k) for k in OPERATION_KEYS]
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    f"INSERT INTO operations ({cols}) VALUES ({placeholders})",
                    values,
                )
            self._conn.commit()
        except Exception as e:
            self._conn.rollback()
            logger.warning("PostgreSQL write_operation failed: %s", e)

    def poll_and_consume_control(
        self,
        consume_only: Optional[tuple] = None,
    ) -> Optional[str]:
        """Poll oldest unconsumed control command; optionally only consume certain commands (e.g. consume_only=('stop',)).
        Mark consumed and return command (stop/flatten) or None. Phase 2: DB-based control channel."""
        if not self._ensure_conn():
            logger.debug("poll_and_consume_control: no DB connection")
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    "SELECT id, command FROM daemon_control WHERE consumed_at IS NULL ORDER BY id ASC LIMIT 1"
                )
                row = cur.fetchone()
                if row is None:
                    return None
                row_id, command = row
                cmd = (command or "").strip().lower()
                if cmd not in ("stop", "flatten", "retry_ib"):
                    cmd = "stop"  # treat unknown as stop for safety
                if consume_only is not None and cmd not in consume_only:
                    return None  # do not consume this command (caller may leave flatten for same process to consume)
                cur.execute("UPDATE daemon_control SET consumed_at = now() WHERE id = %s", (row_id,))
            self._conn.commit()
            logger.info("Consumed control command from daemon_control (id=%s): %s", row_id, cmd)
            return cmd
        except Exception as e:
            self._conn.rollback()
            logger.debug("poll_and_consume_control failed: %s", e)
            return None

    def write_daemon_heartbeat(
        self,
        hedge_running: bool,
        ib_connected: bool = False,
        ib_client_id: Optional[int] = None,
        next_retry_ts: Optional[float] = None,
        seconds_until_retry: Optional[int] = None,
        heartbeat_interval_sec: Optional[float] = None,
    ) -> None:
        """Update daemon_heartbeat row (id=1). RE-6: daemon vs hedge; RE-7: ib_connected, ib_client_id, next_retry_ts.
        seconds_until_retry: relative countdown from daemon clock, avoids clock skew on UI (optional).
        heartbeat_interval_sec: interval in use by daemon, for monitor countdown."""
        if not self._ensure_conn():
            return
        for attempt in (1, 2):
            try:
                with self._conn.cursor() as cur:
                    iv = int(heartbeat_interval_sec) if heartbeat_interval_sec is not None else None
                    if next_retry_ts is not None:
                        cur.execute(
                            """
                            UPDATE daemon_heartbeat
                            SET last_ts = now(), hedge_running = %s, ib_connected = %s, ib_client_id = %s,
                                next_retry_ts = to_timestamp(%s) AT TIME ZONE 'UTC', seconds_until_retry = %s,
                                graceful_shutdown_at = NULL, heartbeat_interval_sec = %s
                            WHERE id = 1
                            """,
                            (hedge_running, ib_connected, ib_client_id, next_retry_ts, seconds_until_retry, iv),
                        )
                    else:
                        cur.execute(
                            """
                            UPDATE daemon_heartbeat
                            SET last_ts = now(), hedge_running = %s, ib_connected = %s, ib_client_id = %s,
                                next_retry_ts = NULL, seconds_until_retry = NULL, graceful_shutdown_at = NULL,
                                heartbeat_interval_sec = %s
                            WHERE id = 1
                            """,
                            (hedge_running, ib_connected, ib_client_id, iv),
                        )
                self._conn.commit()
                return
            except Exception as e:
                self._conn.rollback()
                if attempt == 1 and _is_lock_timeout_error(e):
                    n = release_pg_locks_for_tables(self._config)
                    if n > 0:
                        time.sleep(0.5)
                        continue
                logger.debug("write_daemon_heartbeat failed: %s", e)
                return

    def get_last_ib_client_id(self) -> Optional[int]:
        """Read daemon_heartbeat.ib_client_id for id=1. Used at startup to pick next client_id (last+1) when last is not null, so restart after crash can avoid 'client id in use'."""
        if not self._ensure_conn():
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT ib_client_id FROM daemon_heartbeat WHERE id = 1")
                row = cur.fetchone()
            if row is None or row[0] is None:
                return None
            return int(row[0])
        except Exception as e:
            self._conn.rollback()
            logger.debug("get_last_ib_client_id failed: %s", e)
            return None

    def get_ib_connection_config(self) -> Optional[Dict[str, Any]]:
        """Read settings (id=1): ib_host, ib_port_type. Returns dict with host, port_type, port (resolved).
        Used by daemon at startup to connect to IB; if None or table missing, daemon falls back to config file."""
        if not self._ensure_conn():
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT ib_host, ib_port_type FROM settings WHERE id = 1")
                row = cur.fetchone()
            if row is None or not row[0]:
                return None
            host = (row[0] or "").strip() or "127.0.0.1"
            port_type = (row[1] or "").strip().lower() or "tws_paper"
            port = IB_PORT_TYPE_TO_PORT.get(port_type, 7497)
            return {"host": host, "port_type": port_type, "port": port}
        except Exception as e:
            self._conn.rollback()
            logger.debug("get_ib_connection_config failed: %s", e)
            return None

    def write_daemon_graceful_shutdown(self) -> None:
        """Set daemon_heartbeat.graceful_shutdown_at = now() and ib_client_id = NULL so next start uses client_id=1.
        Call on SIGTERM/SIGINT or after consuming stop (not on SIGKILL - cannot be caught)."""
        if not self._ensure_conn():
            return
        for attempt in (1, 2):
            try:
                with self._conn.cursor() as cur:
                    cur.execute(
                        "UPDATE daemon_heartbeat SET graceful_shutdown_at = now(), last_ts = now(), ib_client_id = NULL WHERE id = 1"
                    )
                self._conn.commit()
                logger.info("Wrote daemon_heartbeat.graceful_shutdown_at and ib_client_id=NULL (graceful stop for monitoring)")
                return
            except Exception as e:
                self._conn.rollback()
                if attempt == 1 and _is_lock_timeout_error(e):
                    n = release_pg_locks_for_tables(self._config)
                    if n > 0:
                        time.sleep(0.5)
                        continue
                logger.warning("write_daemon_graceful_shutdown failed: %s", e)
                return

    def poll_run_status(self) -> tuple[bool, Optional[float]]:
        """Read daemon_run_status (id=1). Returns (suspended, heartbeat_interval_sec). suspended=True => no new hedges; interval from DB or None (use config default)."""
        if not self._ensure_conn():
            return False, None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    "SELECT suspended, heartbeat_interval_sec FROM daemon_run_status WHERE id = 1"
                )
                row = cur.fetchone()
            if row is None:
                return False, None
            suspended = bool(row[0])
            interval = float(row[1]) if row[1] is not None else None
            return suspended, interval
        except Exception as e:
            self._conn.rollback()
            # heartbeat_interval_sec column may not exist yet
            if "heartbeat_interval_sec" in str(e).lower() or "column" in str(e).lower():
                try:
                    with self._conn.cursor() as cur:
                        cur.execute("SELECT suspended FROM daemon_run_status WHERE id = 1")
                        row = cur.fetchone()
                    if row is None:
                        return False, None
                    return bool(row[0]), None
                except Exception:
                    pass
            logger.debug("poll_run_status failed: %s", e)
            return False, None

    def close(self) -> None:
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None
