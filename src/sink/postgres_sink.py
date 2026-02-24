"""PostgreSQL implementation of StatusSink. See docs/DATABASE.md."""

import math
import logging
import os
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

import psycopg2
from psycopg2.extras import Json

from src.sink.base import (
    ACCOUNTS_SNAPSHOT_KEY,
    OPERATION_KEYS,
    SNAPSHOT_KEYS,
    StatusSink,
)

logger = logging.getLogger(__name__)


def _json_safe(obj: Any) -> Any:
    """Return a JSON-serializable copy (nan/inf -> None) so psycopg2 Json() and jsonb never fail."""
    if obj is None:
        return None
    if isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        if math.isfinite(obj):
            return obj
        return None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_json_safe(v) for v in obj]
    return str(obj)


def _parse_summary_floats(summary: Dict[str, Any]) -> Tuple[Optional[float], Optional[float], Optional[float], Dict[str, Any]]:
    """Extract net_liquidation, total_cash, buying_power from IB summary; return (nl, tc, bp, summary_extra)."""
    if not summary or not isinstance(summary, dict):
        return None, None, None, {}
    extra = dict(summary)
    nl = tc = bp = None
    for key, val in list(extra.items()):
        if val is None or val == "":
            continue
        try:
            f = float(val) if not isinstance(val, (int, float)) else float(val)
            if not math.isfinite(f):
                continue
            if key == "NetLiquidation":
                nl = f
                del extra[key]
            elif key == "TotalCashValue":
                tc = f
                del extra[key]
            elif key == "BuyingPower":
                bp = f
                del extra[key]
        except (TypeError, ValueError):
            pass
    return nl, tc, bp, extra


def _sync_accounts_snapshot_to_tables(conn, accounts_list: Optional[List[Dict[str, Any]]]) -> None:
    """Write normalized accounts_snapshot into accounts + account_positions.
    accounts: upsert by account_id. account_positions: upsert by (account_id, symbol, sec_type);
    only delete rows for an account that are no longer in the snapshot (position closed)."""
    if not accounts_list or not isinstance(accounts_list, list):
        return
    with conn.cursor() as cur:
        for acc in accounts_list:
            if not isinstance(acc, dict):
                continue
            account_id = acc.get("account_id") or acc.get("account")
            if not account_id:
                continue
            account_id = str(account_id).strip()
            summary = acc.get("summary") or {}
            if not isinstance(summary, dict):
                summary = {}
            net_liq, total_cash, buying_power, summary_extra = _parse_summary_floats(summary)
            summary_extra_json = _json_safe(summary_extra) if summary_extra else None
            # accounts: upsert by account_id (no delete)
            cur.execute(
                """
                INSERT INTO accounts (account_id, updated_at, net_liquidation, total_cash, buying_power, summary_extra)
                VALUES (%s, now(), %s, %s, %s, %s)
                ON CONFLICT (account_id) DO UPDATE SET
                    updated_at = now(),
                    net_liquidation = EXCLUDED.net_liquidation,
                    total_cash = EXCLUDED.total_cash,
                    buying_power = EXCLUDED.buying_power,
                    summary_extra = EXCLUDED.summary_extra
                """,
                (account_id, net_liq, total_cash, buying_power, Json(summary_extra_json) if summary_extra_json is not None else None),
            )
            # account_positions: upsert by (account_id, contract_key); contract_key distinguishes OPT by expiry/strike/right
            positions = acc.get("positions") or []
            seen_keys: List[str] = []
            if isinstance(positions, list):
                for p in positions:
                    if not isinstance(p, dict):
                        continue
                    sym = p.get("symbol") or ""
                    sec = p.get("secType") or p.get("sec_type") or ""
                    ex = p.get("exchange") or ""
                    curr = p.get("currency") or ""
                    pos_val = p.get("position")
                    try:
                        pos_f = float(pos_val) if pos_val is not None else None
                    except (TypeError, ValueError):
                        pos_f = None
                    avg = p.get("avgCost") or p.get("avg_cost")
                    try:
                        avg_f = float(avg) if avg is not None else None
                    except (TypeError, ValueError):
                        avg_f = None
                    exp = p.get("lastTradeDateOrContractMonth") or p.get("expiry") or ""
                    strike_raw = p.get("strike")
                    try:
                        strike_f = float(strike_raw) if strike_raw is not None else None
                    except (TypeError, ValueError):
                        strike_f = None
                    rt = p.get("right") or ""
                    if sec == "OPT":
                        contract_key = f"{sym}|{sec}|{exp}|{strike_f}|{rt}"
                    else:
                        contract_key = f"{sym}|{sec}|||"
                    cur.execute(
                        """
                        INSERT INTO account_positions (account_id, symbol, sec_type, exchange, currency, position, avg_cost, expiry, strike, option_right, contract_key, updated_at)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                        ON CONFLICT (account_id, contract_key) DO UPDATE SET
                            exchange = EXCLUDED.exchange,
                            currency = EXCLUDED.currency,
                            position = EXCLUDED.position,
                            avg_cost = EXCLUDED.avg_cost,
                            expiry = EXCLUDED.expiry,
                            strike = EXCLUDED.strike,
                            option_right = EXCLUDED.option_right,
                            updated_at = now()
                        """,
                        (account_id, sym, sec, ex, curr, pos_f, avg_f, exp or None, strike_f, rt or None, contract_key),
                    )
                    seen_keys.append(contract_key)
            # Remove positions for this account that are no longer in snapshot (closed)
            if seen_keys:
                cur.execute(
                    """
                    DELETE FROM account_positions
                    WHERE account_id = %s AND (contract_key IS NULL OR contract_key != ALL(%s::text[]))
                    """,
                    (account_id, seen_keys),
                )
            else:
                cur.execute("DELETE FROM account_positions WHERE account_id = %s", (account_id,))


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
        # R-A1 normalized account tables (replacing raw jsonb for future account operations)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                account_id text PRIMARY KEY,
                updated_at timestamptz DEFAULT now(),
                net_liquidation double precision,
                total_cash double precision,
                buying_power double precision,
                summary_extra jsonb
            )
        """)
        # account_positions: (account_id, contract_key) 为主键，无 id；天然按主键 INSERT/UPDATE，仅删除已平仓行
        cur.execute("""
            CREATE TABLE IF NOT EXISTS account_positions (
                account_id text NOT NULL,
                contract_key text NOT NULL,
                symbol text,
                sec_type text,
                exchange text,
                currency text,
                position double precision,
                avg_cost double precision,
                expiry text,
                strike double precision,
                option_right text,
                updated_at timestamptz DEFAULT now(),
                PRIMARY KEY (account_id, contract_key)
            )
        """)
        for col_def in (
            "expiry text",
            "strike double precision",
            "option_right text",
            "contract_key text",
        ):
            name, typ = col_def.split(None, 1)
            cur.execute(
                f"ALTER TABLE account_positions ADD COLUMN IF NOT EXISTS {name} {typ}"
            )
        cur.execute("""
            UPDATE account_positions SET contract_key = symbol || '|' || COALESCE(sec_type,'') || '|' || COALESCE(expiry,'') || '|' || COALESCE(strike::text,'') || '|' || COALESCE(option_right,'')
            WHERE contract_key IS NULL OR contract_key = ''
        """)
        cur.execute("""
            DROP INDEX IF EXISTS account_positions_account_symbol_sectype_key
        """)
        cur.execute("""
            CREATE UNIQUE INDEX IF NOT EXISTS account_positions_account_contract_key
            ON account_positions (account_id, contract_key)
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
        # status_current / status_history: only SNAPSHOT_KEYS (no account_* or accounts_snapshot; those live in accounts + account_positions)
        keys = tuple(SNAPSHOT_KEYS)
        cols = ", ".join(keys)
        placeholders = ", ".join("%s" for _ in keys)
        values = [snapshot.get(k) for k in keys]
        raw_accounts = snapshot.get(ACCOUNTS_SNAPSHOT_KEY) if ACCOUNTS_SNAPSHOT_KEY in snapshot else None
        try:
            with self._conn.cursor() as cur:
                # Upsert single row (id=1) for status_current
                updates = ", ".join(f"{k} = EXCLUDED.{k}" for k in keys if k != "id")
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
            # R-A1: sync multi-account snapshot into normalized tables (accounts + account_positions)
            if isinstance(raw_accounts, list) and raw_accounts:
                _sync_accounts_snapshot_to_tables(self._conn, raw_accounts)
            self._conn.commit()
        except Exception as e:
            self._conn.rollback()
            logger.warning("PostgreSQL write_snapshot failed: %s", e, exc_info=True)

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

    # Control commands older than this are ignored (consumed but not executed), to avoid executing
    # a stop from a previous run when the daemon restarts and immediately polls (e.g. after IB timeout → WAITING_IB).
    CONTROL_CMD_MAX_AGE_SEC = 60

    def poll_and_consume_control(
        self,
        consume_only: Optional[tuple] = None,
    ) -> Optional[str]:
        """Poll oldest unconsumed control command; optionally only consume certain commands (e.g. consume_only=('stop',)).
        Mark consumed and return command (stop/flatten/retry_ib) or None. Phase 2: DB-based control channel.
        Commands older than CONTROL_CMD_MAX_AGE_SEC are still consumed (so they are cleared) but not returned,
        so the daemon does not execute a stale stop from a previous run."""
        if not self._ensure_conn():
            logger.debug("poll_and_consume_control: no DB connection")
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    "SELECT id, command, created_at FROM daemon_control WHERE consumed_at IS NULL ORDER BY id ASC LIMIT 1"
                )
                row = cur.fetchone()
                if row is None:
                    return None
                row_id, command, created_at = row
                cmd = (command or "").strip().lower()
                if cmd not in ("stop", "flatten", "retry_ib"):
                    cmd = "stop"  # treat unknown as stop for safety
                if consume_only is not None and cmd not in consume_only:
                    return None  # do not consume this command (caller may leave flatten for same process to consume)
                # Ignore stale commands (e.g. stop from previous run): still consume so queue is cleared, but don't execute
                now_utc = datetime.now(timezone.utc)
                if created_at is None:
                    age_sec = float("inf")  # treat NULL as stale
                else:
                    created_utc = created_at
                    if created_utc.tzinfo is None:
                        created_utc = created_utc.replace(tzinfo=timezone.utc)
                    age_sec = (now_utc - created_utc).total_seconds()
                if age_sec > self.CONTROL_CMD_MAX_AGE_SEC:
                    cur.execute("UPDATE daemon_control SET consumed_at = now() WHERE id = %s", (row_id,))
                    self._conn.commit()
                    logger.info(
                        "Consumed stale control command from daemon_control (id=%s): %s (age %.0fs > %s s, not executed)",
                        row_id,
                        cmd,
                        age_sec,
                        self.CONTROL_CMD_MAX_AGE_SEC,
                    )
                    return None
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
