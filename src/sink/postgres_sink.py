"""PostgreSQL implementation of StatusSink. See docs/DATABASE.md."""

import logging
import os
from typing import Any, Dict, Optional

import psycopg2

from src.sink.base import OPERATION_KEYS, SNAPSHOT_KEYS, StatusSink

logger = logging.getLogger(__name__)


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


def _ensure_tables(conn) -> None:
    """Create status_current, status_history, operations if not exist (per DATABASE.md §2)."""
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
        conn.commit()


class PostgreSQLSink(StatusSink):
    """Writes snapshot to status_current (and optionally status_history) and operations to operations table."""

    def __init__(self, config: dict):
        self._config = config
        self._conn: Optional[Any] = None
        self._connect()

    def _connect(self) -> None:
        params = _get_conn_params(self._config)
        try:
            self._conn = psycopg2.connect(**params)
            _ensure_tables(self._conn)
            logger.info("PostgreSQL sink connected: %s@%s:%s/%s", params["user"], params["host"], params["port"], params["dbname"])
        except Exception as e:
            logger.warning("PostgreSQL sink connect failed: %s", e)
            self._conn = None

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

    def close(self) -> None:
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None
