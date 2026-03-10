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


def _has_meaningful_commission(v: Any, is_numeric: bool = True) -> bool:
    """是否有意义的 commission 相关值（非 None，数值非 0，字符串非空）。"""
    if v is None:
        return False
    if is_numeric and v == 0:
        return False
    if not is_numeric and (not v or not str(v).strip()):
        return False
    return True


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


def _parse_summary_floats(
    summary: Dict[str, Any],
) -> Tuple[Optional[float], Optional[float], Optional[float], Dict[str, Any]]:
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


def _sync_accounts_snapshot_to_tables(
    conn, accounts_list: Optional[List[Dict[str, Any]]]
) -> None:
    """Write normalized accounts_snapshot into accounts + account_positions.
    accounts: upsert by account_id. account_positions: upsert by (account_id, symbol, sec_type);
    only delete rows for an account that are no longer in the snapshot (position closed).
    """
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
            net_liq, total_cash, buying_power, summary_extra = _parse_summary_floats(
                summary
            )
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
                (
                    account_id,
                    net_liq,
                    total_cash,
                    buying_power,
                    (
                        Json(summary_extra_json)
                        if summary_extra_json is not None
                        else None
                    ),
                ),
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
                    if pos_f is not None and not math.isfinite(pos_f):
                        pos_f = None
                    avg = p.get("avgCost") or p.get("avg_cost")
                    try:
                        avg_f = float(avg) if avg is not None else None
                    except (TypeError, ValueError):
                        avg_f = None
                    if avg_f is not None and not math.isfinite(avg_f):
                        avg_f = None
                    exp = p.get("lastTradeDateOrContractMonth") or p.get("expiry") or ""
                    strike_raw = p.get("strike")
                    try:
                        strike_f = float(strike_raw) if strike_raw is not None else None
                    except (TypeError, ValueError):
                        strike_f = None
                    if strike_f is not None and not math.isfinite(strike_f):
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
                        (
                            account_id,
                            sym,
                            sec,
                            ex,
                            curr,
                            pos_f,
                            avg_f,
                            exp or None,
                            strike_f,
                            rt or None,
                            contract_key,
                        ),
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
                cur.execute(
                    "DELETE FROM account_positions WHERE account_id = %s", (account_id,)
                )


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
    """Build connection params from root postgres config, with env overrides."""
    pg = config.get("postgres", {}) or {}
    # Database: support database, Database, db, or any key that lower() in ("database", "db")
    db = pg.get("database") or pg.get("Database") or pg.get("db")
    if not db and pg:
        for k, v in pg.items():
            if (
                k
                and isinstance(v, str)
                and v.strip()
                and k.strip().lower() in ("database", "db")
            ):
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


def _ensure_tables(conn, log=None) -> None:
    """Create status_current, status_history, operations if not exist (per DATABASE.md §2).
    If log is callable, it is called with a short step name before each DDL section (for progress/debug).
    """
    def _log(msg: str) -> None:
        if callable(log):
            log(msg)
    try:
        conn.rollback()
    except Exception:
        pass
    with conn.cursor() as cur:
        _log("status_current, status_history, operations")
        cur.execute(
            """
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
        """
        )
        cur.execute(
            """
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
        """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS operations (
                id bigserial PRIMARY KEY,
                ts double precision,
                type text,
                side text,
                quantity integer,
                price double precision,
                state_reason text
            )
        """
        )
        _log("daemon_control, daemon_run_status, daemon_heartbeat")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_control (
                id bigserial PRIMARY KEY,
                command text NOT NULL,
                created_at timestamptz DEFAULT now(),
                consumed_at timestamptz
            )
        """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_run_status (
                id integer PRIMARY KEY DEFAULT 1,
                suspended boolean NOT NULL DEFAULT false,
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            """
            INSERT INTO daemon_run_status (id, suspended) VALUES (1, false)
            ON CONFLICT (id) DO NOTHING
        """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS daemon_heartbeat (
                id integer PRIMARY KEY DEFAULT 1,
                last_ts timestamptz NOT NULL DEFAULT now(),
                hedge_running boolean NOT NULL DEFAULT false
            )
        """
        )
        cur.execute(
            """
            INSERT INTO daemon_heartbeat (id, last_ts, hedge_running) VALUES (1, now(), false)
            ON CONFLICT (id) DO NOTHING
        """
        )
        _log("settings + ib_client_id columns")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS settings (
                id integer PRIMARY KEY DEFAULT 1,
                ib_host text NOT NULL DEFAULT '127.0.0.1',
                ib_port_type text NOT NULL DEFAULT 'tws_paper'
            )
        """
        )
        cur.execute(
            """
            INSERT INTO settings (id, ib_host, ib_port_type) VALUES (1, '127.0.0.1', 'tws_paper')
            ON CONFLICT (id) DO NOTHING
        """
        )
        # 兼容旧库：若存在 ib_client_id_worker 且无 ib_client_id_worker_market，则重命名列
        cur.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'ib_client_id_worker')
                   AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'ib_client_id_worker_market')
                THEN
                    ALTER TABLE settings RENAME COLUMN ib_client_id_worker TO ib_client_id_worker_market;
                END IF;
            END $$;
            """
        )
        for col, default in (
            ("ib_client_id_daemon", 1),
            ("ib_client_id_listener", 2),
            ("ib_client_id_account", 100),
            ("ib_client_id_markets", 101),
            ("ib_client_id_worker_market", 500),
        ):
            cur.execute(
                f"ALTER TABLE settings ADD COLUMN IF NOT EXISTS {col} integer DEFAULT {default}"
            )
        cur.execute(
            "ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_primary_account_id text"
        )
        cur.execute(
            "ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib2_host text"
        )
        cur.execute(
            "ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib2_port_type text DEFAULT 'tws_paper'"
        )
        for col, default in (
            ("ib2_client_id_listener", 3),
            ("ib2_client_id_account", 102),
        ):
            cur.execute(
                f"ALTER TABLE settings ADD COLUMN IF NOT EXISTS {col} integer DEFAULT {default}"
            )
        # Second IB has no market data subscription; remove column if present (see DATABASE.md §2.9)
        cur.execute("ALTER TABLE settings DROP COLUMN IF EXISTS ib2_client_id_markets")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_host_token text")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_secondary_token text")
        cur.execute("ALTER TABLE settings DROP COLUMN IF EXISTS flex_default_range_preset")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS flex_default_range_days integer DEFAULT 30")
        cur.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS flex_init_range_days integer DEFAULT 360")
        _log("accounts, account_positions, instrument_prices")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                account_id text PRIMARY KEY,
                updated_at timestamptz DEFAULT now(),
                net_liquidation double precision,
                total_cash double precision,
                buying_power double precision,
                summary_extra jsonb
            )
        """
        )
        # account_positions: (account_id, contract_key) 为主键，无 id；天然按主键 INSERT/UPDATE，仅删除已平仓行
        cur.execute(
            """
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
        """
        )
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
        cur.execute(
            """
            UPDATE account_positions SET contract_key = symbol || '|' || COALESCE(sec_type,'') || '|' || COALESCE(expiry,'') || '|' || COALESCE(strike::text,'') || '|' || COALESCE(option_right,'')
            WHERE contract_key IS NULL OR contract_key = ''
        """
        )
        cur.execute(
            """
            DROP INDEX IF EXISTS account_positions_account_symbol_sectype_key
        """
        )
        cur.execute(
            """
            CREATE UNIQUE INDEX IF NOT EXISTS account_positions_account_contract_key
            ON account_positions (account_id, contract_key)
        """
        )
        # R-M6: 每个持仓标的当前价（按 contract_key 聚合），供监控页逐行展示与计算盈亏
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS instrument_prices (
                contract_key text PRIMARY KEY,
                symbol text,
                sec_type text,
                expiry text,
                strike double precision,
                option_right text,
                last double precision,
                bid double precision,
                ask double precision,
                mid double precision,
                updated_at timestamptz DEFAULT now()
            )
        """
        )
        _log("account_executions, account_execution_commissions")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_executions (
                id bigserial PRIMARY KEY,
                account_id text,
                exec_id text,
                exec_time timestamptz,
                symbol text,
                sec_type text,
                side text,
                quantity double precision,
                price double precision,
                source text,
                raw_extra jsonb,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS account_executions_exec_id_key ON account_executions (exec_id) WHERE exec_id IS NOT NULL AND exec_id != ''"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_executions_account_time ON account_executions (account_id, exec_time DESC)"
        )
        # R-A2 §2.11.1: CommissionReport 表，与 account_executions 通过 exec_id 关联
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_execution_commissions (
                exec_id text PRIMARY KEY,
                commission double precision,
                currency text,
                realized_pnl double precision,
                yield_ double precision,
                yield_redemption_date integer,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        # §2.21: account_transactions (Flex cash transactions for Performance Phase 0)
        _log("account_transactions")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS account_transactions (
                id bigserial PRIMARY KEY,
                account_id text NOT NULL,
                ts timestamptz NOT NULL,
                amount double precision NOT NULL,
                type text NOT NULL,
                currency text,
                description text,
                flex_transaction_id text,
                flex_type text,
                flex_code text,
                asset_category text,
                asset_subcategory text,
                symbol text,
                conid bigint,
                security_id text,
                security_id_type text,
                listing_exchange text,
                report_date date,
                available_for_trading_date date,
                fx_rate_to_base double precision,
                raw_extra jsonb,
                created_at timestamptz DEFAULT now(),
                UNIQUE(account_id, ts, amount, type)
            )
        """
        )
        # Backwards-compatible schema evolution: add new columns if table already existed without them.
        for col_def in (
            "flex_transaction_id text",
            "flex_type text",
            "flex_code text",
            "asset_category text",
            "asset_subcategory text",
            "symbol text",
            "conid bigint",
            "security_id text",
            "security_id_type text",
            "listing_exchange text",
            "report_date date",
            "available_for_trading_date date",
            "fx_rate_to_base double precision",
            "raw_extra jsonb",
        ):
            col_name = col_def.split()[0]
            cur.execute(
                f"ALTER TABLE account_transactions ADD COLUMN IF NOT EXISTS {col_def}"
            )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS account_transactions_account_ts ON account_transactions (account_id, ts DESC)"
        )
        _log("stock_day table + index (may block if API/worker use stock_day)")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS stock_day (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS stock_day_symbol_time ON stock_day (symbol, bar_time DESC)"
        )
        _log("stock_min table + index")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS stock_min (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                period text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, period, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS stock_min_symbol_period_time ON stock_min (symbol, period, bar_time DESC)"
        )
        _log("option_day, option_min tables + indexes")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_day (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                expiry text NOT NULL,
                strike double precision NOT NULL,
                option_right text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, expiry, strike, option_right, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_day_symbol_expiry_strike_right_time ON option_day (symbol, expiry, strike, option_right, bar_time DESC)"
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS option_min (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                expiry text NOT NULL,
                strike double precision NOT NULL,
                option_right text NOT NULL,
                period text NOT NULL,
                bar_time timestamptz NOT NULL,
                open double precision,
                high double precision,
                low double precision,
                close double precision,
                volume double precision,
                created_at timestamptz DEFAULT now(),
                UNIQUE(symbol, expiry, strike, option_right, period, bar_time)
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS option_min_symbol_expiry_strike_right_period_time ON option_min (symbol, expiry, strike, option_right, period, bar_time DESC)"
        )
        # Release earlier DDL locks before the final watchlist/backfill DDL step.
        conn.commit()
        _log("watchlist, bars_backfill_jobs")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS watchlist (
                id bigserial PRIMARY KEY,
                contract_key text NOT NULL UNIQUE,
                symbol text,
                sec_type text,
                expiry text,
                strike double precision,
                option_right text,
                display_label text,
                source text,
                created_at timestamptz DEFAULT now()
            )
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS watchlist_contract_key ON watchlist (contract_key)"
        )
        # 阶段 3 非实时拉取 Worker：backfill 任务队列表（见 docs/DATABASE.md §2.x bars_backfill_jobs）
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS bars_backfill_jobs (
                id bigserial PRIMARY KEY,
                symbol text NOT NULL,
                period text NOT NULL DEFAULT '1 D',
                years double precision,
                days integer,
                override_days double precision,
                status text NOT NULL DEFAULT 'pending',
                result jsonb,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS bars_backfill_jobs_status_created ON bars_backfill_jobs (status, created_at)"
        )
        for col, default in (("skip_ib", "false"), ("api_interval_sec", "10")):
            cur.execute(
                f"ALTER TABLE bars_backfill_jobs ADD COLUMN IF NOT EXISTS {col} {'boolean' if col == 'skip_ib' else 'integer'} DEFAULT {default}"
            )
        cur.execute("ALTER TABLE bars_backfill_jobs ADD COLUMN IF NOT EXISTS span_hours double precision DEFAULT NULL")
        conn.commit()
        _log("position_categories, position_category_tags")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS position_categories (
                id bigserial PRIMARY KEY,
                name text NOT NULL,
                description text,
                sort_order integer,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
            """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS position_category_tags (
                account_id text NOT NULL,
                contract_key text NOT NULL,
                category_id integer NOT NULL REFERENCES position_categories(id) ON DELETE CASCADE,
                created_at timestamptz DEFAULT now(),
                PRIMARY KEY (account_id, contract_key)
            )
            """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS position_category_tags_category_id ON position_category_tags (category_id)"
        )
        conn.commit()
        _log("us_market_holidays")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS us_market_holidays (
                exchange text NOT NULL DEFAULT 'NYSE',
                holiday_date date NOT NULL,
                label text,
                created_at timestamptz DEFAULT now(),
                PRIMARY KEY (exchange, holiday_date)
            )
            """
        )
        _log("flex_accounts")
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS flex_accounts (
                id serial PRIMARY KEY,
                sort_order integer NOT NULL DEFAULT 0,
                query_label text,
                purpose text DEFAULT 'cash_transactions',
                query_host_id text NOT NULL,
                query_secondary_id text
            )
            """
        )
        # Migrate from old schema: query_id_cash_transactions -> query_id, add query_label/purpose
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'flex_accounts' AND column_name = 'query_id_cash_transactions'
                    """
                )
                if cur2.fetchone():
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_id text")
                    cur2.execute("UPDATE flex_accounts SET query_id = query_id_cash_transactions WHERE query_id IS NULL OR query_id = ''")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_label text")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS purpose text DEFAULT 'cash_transactions'")
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS query_id_cash_transactions")
            conn.commit()
        except Exception:
            conn.rollback()
        # Ensure new columns exist for tables created before migration
        for col_def in [
            ("query_id", "text"),
            ("query_label", "text"),
            ("purpose", "text DEFAULT 'cash_transactions'"),
        ]:
            try:
                cur.execute(f"ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS {col_def[0]} {col_def[1]}")
                conn.commit()
            except Exception:
                conn.rollback()
        # Migrate: token -> settings (ib_flex_host_token, ib_flex_secondary_token); account_label -> account_is_host (bool); drop token, account_label
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'flex_accounts' AND column_name = 'token'
                    """
                )
                if cur2.fetchone():
                    cur2.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_host_token text")
                    cur2.execute("ALTER TABLE settings ADD COLUMN IF NOT EXISTS ib_flex_secondary_token text")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS account_is_host boolean NOT NULL DEFAULT true")
                    # Backfill settings: first two distinct tokens by sort_order, id
                    cur2.execute(
                        """
                        UPDATE settings SET
                          ib_flex_host_token = (SELECT token FROM (
                            SELECT token, ROW_NUMBER() OVER (ORDER BY min_so, min_id) AS rn
                            FROM (SELECT token, MIN(sort_order) AS min_so, MIN(id) AS min_id FROM flex_accounts GROUP BY token) x
                          ) y WHERE rn = 1),
                          ib_flex_secondary_token = (SELECT token FROM (
                            SELECT token, ROW_NUMBER() OVER (ORDER BY min_so, min_id) AS rn
                            FROM (SELECT token, MIN(sort_order) AS min_so, MIN(id) AS min_id FROM flex_accounts GROUP BY token) x
                          ) y WHERE rn = 2)
                        WHERE id = 1
                        """
                    )
                    cur2.execute(
                        "UPDATE flex_accounts SET account_is_host = (token = (SELECT ib_flex_host_token FROM settings WHERE id = 1))"
                    )
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS token")
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS account_label")
            conn.commit()
        except Exception:
            conn.rollback()
        # Ensure account_is_host exists (for tables created before token migration)
        try:
            cur.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS account_is_host boolean NOT NULL DEFAULT true")
            conn.commit()
        except Exception:
            conn.rollback()
        # Migrate: account_is_host + query_id -> query_host_id + query_secondary_id (one row per label/purpose, both IDs)
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    SELECT column_name FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'flex_accounts' AND column_name = 'account_is_host'
                    """
                )
                if cur2.fetchone():
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_host_id text")
                    cur2.execute("ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS query_secondary_id text")
                    cur2.execute("UPDATE flex_accounts SET query_host_id = query_id WHERE account_is_host = true AND (query_host_id IS NULL OR query_host_id = '')")
                    cur2.execute("UPDATE flex_accounts SET query_secondary_id = query_id WHERE account_is_host = false AND (query_secondary_id IS NULL OR query_secondary_id = '')")
                    # Collapse to one row per purpose: keep min(sort_order), merge query_host_id and query_secondary_id
                    cur2.execute(
                        """
                        CREATE TEMP TABLE flex_accounts_merged AS
                        SELECT MIN(sort_order) AS sort_order, purpose,
                               MAX(query_label) AS query_label,
                               MAX(query_host_id) AS query_host_id,
                               MAX(query_secondary_id) AS query_secondary_id
                        FROM flex_accounts
                        GROUP BY purpose
                        """
                    )
                    cur2.execute("DELETE FROM flex_accounts")
                    cur2.execute(
                        """
                        INSERT INTO flex_accounts (sort_order, query_label, purpose, query_host_id, query_secondary_id)
                        SELECT sort_order, query_label, purpose,
                               COALESCE(NULLIF(TRIM(query_host_id), ''), ''),
                               NULLIF(TRIM(query_secondary_id), '')
                        FROM flex_accounts_merged
                        WHERE NULLIF(TRIM(query_host_id), '') IS NOT NULL
                        """
                    )
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS account_is_host")
                    cur2.execute("ALTER TABLE flex_accounts DROP COLUMN IF EXISTS query_id")
            conn.commit()
        except Exception:
            conn.rollback()
        # Ensure query_host_id / query_secondary_id exist for tables created before this migration
        for col_def in [
            ("query_host_id", "text"),
            ("query_secondary_id", "text"),
        ]:
            try:
                cur.execute(f"ALTER TABLE flex_accounts ADD COLUMN IF NOT EXISTS {col_def[0]} {col_def[1]}")
                conn.commit()
            except Exception:
                conn.rollback()
        _log("key_value_config")
        # 1) Group table first
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS key_value_group (
                id serial PRIMARY KEY,
                name text UNIQUE NOT NULL,
                description text,
                sort_order integer NOT NULL DEFAULT 0,
                created_at timestamptz DEFAULT now(),
                updated_at timestamptz DEFAULT now()
            )
            """
        )
        conn.commit()
        # Ensure at least one key_value_group exists for migration (no Flex-specific seed)
        cur.execute(
            """
            INSERT INTO key_value_group (name, description, sort_order)
            VALUES ('default', 'Default group for key-value config', 0)
            ON CONFLICT (name) DO NOTHING
            """
        )
        conn.commit()
        # Ensure sequence is at least 2 for future groups
        try:
            cur.execute("SELECT setval(pg_get_serial_sequence('key_value_group', 'id'), GREATEST(1, (SELECT COALESCE(MAX(id), 1) FROM key_value_group)))")
            conn.commit()
        except Exception:
            conn.rollback()
        # 2) key_value_config: create with group_id or migrate existing
        cur.execute(
            """
            SELECT column_name FROM information_schema.columns
            WHERE table_schema = current_schema() AND table_name = 'key_value_config' AND column_name = 'group_id'
            """
        )
        has_group_id = cur.fetchone() is not None
        cur.execute(
            "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'key_value_config'"
        )
        table_exists = cur.fetchone() is not None
        if not table_exists:
            cur.execute(
                """
                CREATE TABLE key_value_config (
                    group_id integer NOT NULL REFERENCES key_value_group(id) ON DELETE CASCADE,
                    key text NOT NULL,
                    value text NOT NULL DEFAULT '',
                    description text,
                    updated_at timestamptz DEFAULT now(),
                    PRIMARY KEY (group_id, key)
                )
                """
            )
            conn.commit()
        elif not has_group_id:
            # Existing table without group_id: add column, backfill, change PK
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS key_value_config (
                    key text PRIMARY KEY,
                    value text NOT NULL DEFAULT '',
                    description text,
                    updated_at timestamptz DEFAULT now()
                )
                """
            )
            conn.commit()
            cur.execute("ALTER TABLE key_value_config ADD COLUMN IF NOT EXISTS group_id integer")
            conn.commit()
            cur.execute(
                "UPDATE key_value_config SET group_id = (SELECT id FROM key_value_group WHERE name = 'default' LIMIT 1) WHERE group_id IS NULL"
            )
            conn.commit()
            cur.execute("ALTER TABLE key_value_config ALTER COLUMN group_id SET NOT NULL")
            conn.commit()
            cur.execute("ALTER TABLE key_value_config DROP CONSTRAINT IF EXISTS key_value_config_pkey")
            conn.commit()
            cur.execute(
                "ALTER TABLE key_value_config ADD CONSTRAINT key_value_config_group_id_fkey "
                "FOREIGN KEY (group_id) REFERENCES key_value_group(id) ON DELETE CASCADE"
            )
            conn.commit()
            cur.execute("ALTER TABLE key_value_config ADD PRIMARY KEY (group_id, key)")
            conn.commit()
        # Migrate from legacy daemon_ib_config if present (one-time, safe to skip if table missing)
        try:
            with conn.cursor() as cur2:
                cur2.execute(
                    """
                    UPDATE settings s SET ib_host = d.ib_host, ib_port_type = d.ib_port_type
                    FROM daemon_ib_config d WHERE d.id = 1 AND s.id = 1
                """
                )
            conn.commit()
        except Exception:
            conn.rollback()
        # R-A2 extended: add columns to account_executions for full IB / Flex data（含期权字段与 Flex Trades 字段）
        # 不再在 account_executions 添加 commission/realized_pnl/currency，已迁至 account_execution_commissions
        for _col, sql in [
            ("expiry", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS expiry text"),
            ("strike", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS strike double precision"),
            ("option_right", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS option_right text"),
            ("exchange", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS exchange text"),
            ("order_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS order_id bigint"),
            ("cum_qty", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS cum_qty double precision"),
            ("contract_key", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS contract_key text"),
            ("currency", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS currency text"),
            ("asset_category", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS asset_category text"),
            ("sub_category", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS sub_category text"),
            ("description", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS description text"),
            ("conid", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS conid bigint"),
            ("security_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS security_id text"),
            ("security_id_type", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS security_id_type text"),
            ("cusip", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS cusip text"),
            ("isin", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS isin text"),
            ("figi", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS figi text"),
            ("listing_exchange", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS listing_exchange text"),
            ("underlying_conid", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_conid bigint"),
            ("underlying_symbol", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_symbol text"),
            ("underlying_security_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_security_id text"),
            ("underlying_listing_exchange", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS underlying_listing_exchange text"),
            ("issuer", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS issuer text"),
            ("issuer_country_code", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS issuer_country_code text"),
            ("trade_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS trade_id text"),
            ("related_trade_id", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS related_trade_id text"),
            ("report_date", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS report_date date"),
            ("trade_date", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS trade_date date"),
            ("settle_date_target", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS settle_date_target date"),
            ("transaction_type", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS transaction_type text"),
            ("multiplier", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS multiplier double precision"),
            ("principal_adjust_factor", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS principal_adjust_factor text"),
            ("proceeds", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS proceeds double precision"),
            ("taxes", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS taxes double precision"),
            ("net_cash", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS net_cash double precision"),
            ("close_price", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS close_price double precision"),
            ("open_close_indicator", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS open_close_indicator text"),
            ("notes", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS notes text"),
            ("cost", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS cost double precision"),
            ("fifo_pnl_realized", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS fifo_pnl_realized double precision"),
            ("mtm_pnl", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS mtm_pnl double precision"),
            ("trade_money", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS trade_money double precision"),
            ("fx_rate_to_base", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS fx_rate_to_base double precision"),
            ("acct_alias", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS acct_alias text"),
            ("model", "ALTER TABLE account_executions ADD COLUMN IF NOT EXISTS model text"),
        ]:
            try:
                cur.execute(sql)
                conn.commit()
            except psycopg2.ProgrammingError as e:
                conn.rollback()
                if getattr(e, "pgcode", None) != "42701":
                    raise
        # R-A2 §2.11.1 迁移：commission/realized_pnl/currency 迁至 account_execution_commissions，从 account_executions 删除
        # 若 account_executions 仍有这三列，先拷贝数据再 DROP
        try:
            cur.execute(
                """
                INSERT INTO account_execution_commissions (exec_id, commission, currency, realized_pnl)
                SELECT exec_id, commission, currency, realized_pnl
                FROM account_executions
                WHERE exec_id IS NOT NULL AND exec_id != ''
                  AND (commission IS NOT NULL OR realized_pnl IS NOT NULL OR currency IS NOT NULL)
                ON CONFLICT (exec_id) DO UPDATE SET
                  commission = COALESCE(EXCLUDED.commission, account_execution_commissions.commission),
                  currency = COALESCE(EXCLUDED.currency, account_execution_commissions.currency),
                  realized_pnl = COALESCE(EXCLUDED.realized_pnl, account_execution_commissions.realized_pnl)
                """
            )
            conn.commit()
        except psycopg2.ProgrammingError as e:
            conn.rollback()
            if getattr(e, "pgcode", None) != "42703":
                raise
        for drop_sql in [
            "ALTER TABLE account_executions DROP COLUMN IF EXISTS commission",
            "ALTER TABLE account_executions DROP COLUMN IF EXISTS realized_pnl",
            "ALTER TABLE account_executions DROP COLUMN IF EXISTS currency",
        ]:
            try:
                cur.execute(drop_sql)
                conn.commit()
            except psycopg2.ProgrammingError as e:
                conn.rollback()
                if getattr(e, "pgcode", None) != "42703":  # 42703 = undefined_column
                    raise
        # RE-7: add columns if not exist (each ALTER in its own transaction so duplicate_column doesn't abort the rest)
        for _col, sql in [
            (
                "ib_connected",
                "ALTER TABLE daemon_heartbeat ADD COLUMN ib_connected boolean DEFAULT false",
            ),
            (
                "ib_client_id",
                "ALTER TABLE daemon_heartbeat ADD COLUMN ib_client_id integer",
            ),
            (
                "next_retry_ts",
                "ALTER TABLE daemon_heartbeat ADD COLUMN next_retry_ts timestamptz",
            ),
            (
                "seconds_until_retry",
                "ALTER TABLE daemon_heartbeat ADD COLUMN seconds_until_retry smallint",
            ),
            (
                "graceful_shutdown_at",
                "ALTER TABLE daemon_heartbeat ADD COLUMN graceful_shutdown_at timestamptz",
            ),
            (
                "heartbeat_interval_sec",
                "ALTER TABLE daemon_heartbeat ADD COLUMN heartbeat_interval_sec smallint",
            ),
            (
                "redis_quotes_connected",
                "ALTER TABLE daemon_heartbeat ADD COLUMN redis_quotes_connected boolean DEFAULT false",
            ),
            (
                "event_subscribe_ticker",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_ticker boolean DEFAULT false",
            ),
            (
                "event_subscribe_positions",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_positions boolean DEFAULT false",
            ),
            (
                "event_subscribe_fills",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_fills boolean DEFAULT false",
            ),
            (
                "event_subscribe_commission",
                "ALTER TABLE daemon_heartbeat ADD COLUMN event_subscribe_commission boolean DEFAULT false",
            ),
            (
                "listener_connected",
                "ALTER TABLE daemon_heartbeat ADD COLUMN listener_connected boolean DEFAULT false",
            ),
            (
                "listener_client_id",
                "ALTER TABLE daemon_heartbeat ADD COLUMN listener_client_id integer",
            ),
            (
                "run_status_heartbeat_interval",
                "ALTER TABLE daemon_run_status ADD COLUMN heartbeat_interval_sec smallint",
            ),
        ]:
            try:
                cur.execute(sql)
                conn.commit()
            except psycopg2.ProgrammingError as e:
                conn.rollback()  # clear aborted state so next ALTER can run
                if (
                    e.pgcode != "42701"
                ):  # 42701 = duplicate_column (column already exists)
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
                logger.info(
                    "PostgreSQL sink connected: %s@%s:%s/%s",
                    params["user"],
                    params["host"],
                    params["port"],
                    params["dbname"],
                )
                return
            except Exception as e:
                self._conn = None
                if attempt == 1 and _is_lock_timeout_error(e):
                    n = release_pg_locks_for_tables(self._config)
                    if n > 0:
                        logger.info(
                            "Released %s backend(s) holding lock on %s; retrying connect",
                            n,
                            _DAEMON_LOCK_TABLES,
                        )
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

    def write_snapshot(
        self, snapshot: Dict[str, Any], append_history: bool = False
    ) -> None:
        if not self._ensure_conn():
            return
        # status_current / status_history: only SNAPSHOT_KEYS (no account_* or accounts_snapshot; those live in accounts + account_positions)
        keys = tuple(SNAPSHOT_KEYS)
        cols = ", ".join(keys)
        placeholders = ", ".join("%s" for _ in keys)
        values = [snapshot.get(k) for k in keys]
        raw_accounts = (
            snapshot.get(ACCOUNTS_SNAPSHOT_KEY)
            if ACCOUNTS_SNAPSHOT_KEY in snapshot
            else None
        )
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

    def write_instrument_prices(self, rows):
        """R-M6: 写入每个合约的当前价（按 contract_key upsert）。rows: Iterable[Dict]。
        过滤 NaN/Null：价格字段若为 NaN、inf 或空则写入 NULL，不污染数据库。若整行无有效价格则跳过该行。"""
        if not rows:
            return
        if not self._ensure_conn():
            return
        logger.info("[R-M6] write_instrument_prices: %s rows received", len(rows))

        def _sanitize(v):
            if v is None:
                return None
            try:
                f = float(v)
                return f if math.isfinite(f) else None
            except (TypeError, ValueError):
                return None

        try:
            with self._conn.cursor() as cur:
                for r in rows:
                    contract_key = r.get("contract_key")
                    if not contract_key:
                        logger.warning(
                            "[R-M6] write_instrument_prices: missing contract_key in row: %s",
                            r,
                        )
                        continue
                    last = _sanitize(r.get("last"))
                    bid = _sanitize(r.get("bid"))
                    ask = _sanitize(r.get("ask"))
                    mid = _sanitize(r.get("mid"))
                    if last is None and bid is None and ask is None and mid is None:
                        logger.debug(
                            "[R-M6] write_instrument_prices: skip row (all price fields NaN/Null): %s",
                            contract_key,
                        )
                        continue
                    cur.execute(
                        """
                        INSERT INTO instrument_prices (
                            contract_key, symbol, sec_type, expiry, strike, option_right,
                            last, bid, ask, mid, updated_at
                        )
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                        ON CONFLICT (contract_key) DO UPDATE SET
                            symbol = EXCLUDED.symbol,
                            sec_type = EXCLUDED.sec_type,
                            expiry = EXCLUDED.expiry,
                            strike = EXCLUDED.strike,
                            option_right = EXCLUDED.option_right,
                            last = EXCLUDED.last,
                            bid = EXCLUDED.bid,
                            ask = EXCLUDED.ask,
                            mid = EXCLUDED.mid,
                            updated_at = now()
                        """,
                        (
                            contract_key,
                            r.get("symbol"),
                            r.get("sec_type"),
                            r.get("expiry"),
                            r.get("strike"),
                            r.get("option_right"),
                            last,
                            bid,
                            ask,
                            mid,
                        ),
                    )
            self._conn.commit()
            logger.info("[R-M6] write_instrument_prices: commit ok")
        except Exception as e:
            self._conn.rollback()
            logger.warning("write_instrument_prices failed: %s", e, exc_info=True)

    def write_account_executions(self, rows: Any) -> None:
        """R-A2: 写入账户执行/成交记录到 account_executions；CommissionReport 写入 account_execution_commissions。"""
        if not rows:
            return
        if not self._ensure_conn():
            return
        try:
            import json
            with self._conn.cursor() as cur:
                for r in rows:
                    exec_id = r.get("exec_id")
                    account_id = r.get("account_id")
                    exec_time = r.get("time")
                    symbol = r.get("symbol")
                    sec_type = r.get("sec_type")
                    side = r.get("side")
                    quantity = r.get("quantity")
                    price = r.get("price")
                    source = r.get("source")
                    expiry = r.get("expiry")
                    strike = r.get("strike")
                    option_right = r.get("option_right")
                    exchange = r.get("exchange")
                    order_id = r.get("order_id")
                    cum_qty = r.get("cum_qty")
                    contract_key = r.get("contract_key")
                    currency = r.get("currency")
                    asset_category = r.get("asset_category")
                    sub_category = r.get("sub_category")
                    description = r.get("description")
                    conid = r.get("conid")
                    security_id = r.get("security_id")
                    security_id_type = r.get("security_id_type")
                    cusip = r.get("cusip")
                    isin = r.get("isin")
                    figi = r.get("figi")
                    listing_exchange = r.get("listing_exchange")
                    underlying_conid = r.get("underlying_conid")
                    underlying_symbol = r.get("underlying_symbol")
                    underlying_security_id = r.get("underlying_security_id")
                    underlying_listing_exchange = r.get("underlying_listing_exchange")
                    issuer = r.get("issuer")
                    issuer_country_code = r.get("issuer_country_code")
                    trade_id = r.get("trade_id")
                    related_trade_id = r.get("related_trade_id")
                    report_date = r.get("report_date")
                    trade_date = r.get("trade_date")
                    settle_date_target = r.get("settle_date_target")
                    transaction_type = r.get("transaction_type")
                    multiplier = r.get("multiplier")
                    principal_adjust_factor = r.get("principal_adjust_factor")
                    proceeds = r.get("proceeds")
                    taxes = r.get("taxes")
                    net_cash = r.get("net_cash")
                    close_price = r.get("close_price")
                    open_close_indicator = r.get("open_close_indicator")
                    notes = r.get("notes")
                    cost = r.get("cost")
                    fifo_pnl_realized = r.get("fifo_pnl_realized")
                    mtm_pnl = r.get("mtm_pnl")
                    trade_money = r.get("trade_money")
                    fx_rate_to_base = r.get("fx_rate_to_base")
                    acct_alias = r.get("acct_alias")
                    model = r.get("model")
                    raw_extra = r.get("raw_extra")
                    if raw_extra is not None and not isinstance(raw_extra, str):
                        raw_extra = json.dumps(raw_extra) if raw_extra else None

                    # 对于期权，从 TWS 侧写入前先补齐/重建 contract_key。
                    # Flex Trades 侧仍使用 symbol|OPT|expiry|strike|right；TWS 侧（tws_event/tws_client）
                    # 则改为以 IB localSymbol 样式为前缀：
                    #   local_symbol = symbol + "  " + yymmdd + right + strike8
                    #   contract_key = local_symbol|sec_type|expiry|strike|option_right
                    sec_type_norm = (sec_type or "").strip().upper()
                    if sec_type_norm == "OPT":
                        sym_key = (symbol or "").strip()
                        exp_val = expiry
                        if isinstance(exp_val, (int, float)) and math.isfinite(exp_val):
                            exp_key = str(int(exp_val))
                        else:
                            exp_key = (exp_val or "").strip().replace("-", "")
                        strike_raw = strike
                        try:
                            strike_key = float(strike_raw) if strike_raw not in ("", None) else None
                        except (TypeError, ValueError):
                            strike_key = None
                        right_key = (option_right or "").strip().upper()
                        if len(right_key) > 1:
                            right_key = "C" if right_key.startswith("C") else "P" if right_key.startswith("P") else right_key[:1]

                        # 若来源是 TWS（tws_event / tws_client），则按 localSymbol 规则重建 contract_key
                        source_norm = (source or "").strip()
                        if (
                            source_norm in ("tws_event", "tws_client")
                            and sym_key
                            and exp_key
                            and strike_key is not None
                            and right_key
                        ):
                            # expiry 期望为 YYYYMMDD；取 yymmdd
                            exp_digits = "".join(ch for ch in exp_key if ch.isdigit())
                            yymmdd = exp_digits[2:8] if len(exp_digits) >= 8 else exp_digits[-6:]
                            try:
                                strike_int = int(round(strike_key * 1000.0))
                            except (TypeError, ValueError, OverflowError):
                                strike_int = None
                            if yymmdd and strike_int is not None:
                                strike_8 = f"{strike_int:08d}"
                                local_symbol = f"{sym_key}  {yymmdd}{right_key}{strike_8}"
                                contract_key = "|".join(
                                    [
                                        local_symbol,
                                        "OPT",
                                        exp_key,
                                        str(strike_key),
                                        right_key,
                                    ]
                                )
                        # 非 TWS 来源或上面没能成功重建时，回退到 symbol|OPT|expiry|strike|right 规范
                        if not contract_key and sym_key:
                            contract_key = "|".join(
                                [
                                    sym_key,
                                    "OPT",
                                    exp_key,
                                    str(strike_key) if strike_key is not None else "",
                                    right_key,
                                ]
                            )
                    # 若当前账户下已存在同一 contract_key 且 source=flex_trades，则认为 Flex 已覆盖，
                    # 不再写入 TWS 侧记录（无论是 tws_client 还是 tws_event），避免重复。
                    if (
                        account_id
                        and contract_key
                        and (source or "").strip() != "flex_trades"
                    ):
                        cur.execute(
                            """
                            SELECT 1
                            FROM account_executions
                            WHERE account_id = %s
                              AND contract_key = %s
                              AND source = 'flex_trades'
                            LIMIT 1
                            """,
                            (account_id, contract_key),
                        )
                        if cur.fetchone():
                            continue
                    if exec_time is not None:
                        try:
                            from datetime import datetime, timezone
                            if isinstance(exec_time, (int, float)):
                                exec_dt = datetime.fromtimestamp(exec_time, tz=timezone.utc)
                            else:
                                exec_dt = exec_time
                        except Exception:
                            exec_dt = None
                    else:
                        exec_dt = None
                    cols = (
                        "account_id, exec_id, exec_time, symbol, sec_type, side, quantity, price, source, "
                        "expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, "
                        "asset_category, sub_category, description, conid, security_id, security_id_type, "
                        "cusip, isin, figi, listing_exchange, underlying_conid, underlying_symbol, "
                        "underlying_security_id, underlying_listing_exchange, issuer, issuer_country_code, "
                        "trade_id, related_trade_id, report_date, trade_date, settle_date_target, "
                        "transaction_type, multiplier, principal_adjust_factor, proceeds, taxes, net_cash, "
                        "close_price, open_close_indicator, notes, cost, fifo_pnl_realized, mtm_pnl, "
                        "trade_money, fx_rate_to_base, acct_alias, model, raw_extra"
                    )
                    placeholders = ", ".join(["%s"] * 54)
                    vals = (
                        account_id,
                        exec_id,
                        exec_dt,
                        symbol,
                        sec_type,
                        side,
                        quantity,
                        price,
                        source,
                        expiry,
                        strike,
                        option_right,
                        exchange,
                        order_id,
                        cum_qty,
                        contract_key,
                        asset_category,
                        sub_category,
                        description,
                        conid,
                        security_id,
                        security_id_type,
                        cusip,
                        isin,
                        figi,
                        listing_exchange,
                        underlying_conid,
                        underlying_symbol,
                        underlying_security_id,
                        underlying_listing_exchange,
                        issuer,
                        issuer_country_code,
                        trade_id,
                        related_trade_id,
                        report_date,
                        trade_date,
                        settle_date_target,
                        transaction_type,
                        multiplier,
                        principal_adjust_factor,
                        proceeds,
                        taxes,
                        net_cash,
                        close_price,
                        open_close_indicator,
                        notes,
                        cost,
                        fifo_pnl_realized,
                        mtm_pnl,
                        trade_money,
                        fx_rate_to_base,
                        acct_alias,
                        model,
                        raw_extra,
                    )
                    if exec_id:
                        cur.execute(
                            f"""
                            INSERT INTO account_executions ({cols})
                            VALUES ({placeholders})
                            ON CONFLICT (exec_id) WHERE exec_id IS NOT NULL AND exec_id != '' DO NOTHING
                            """,
                            vals,
                        )
                    else:
                        cur.execute(
                            f"""
                            INSERT INTO account_executions ({cols})
                            VALUES ({placeholders})
                            """,
                            vals,
                        )
                    commission = r.get("commission")
                    realized_pnl = r.get("realized_pnl")
                    currency = r.get("currency")
                    yield_ = r.get("yield_")
                    yield_redemption_date = r.get("yield_redemption_date")

                    def _null_if_zero(v):
                        if v is None:
                            return None
                        try:
                            if float(v) == 0:
                                return None
                        except (TypeError, ValueError):
                            pass
                        return v if (v != "" or v is None) else None

                    commission_val = _null_if_zero(commission)
                    realized_pnl_val = _null_if_zero(realized_pnl)
                    yield_val = _null_if_zero(yield_)
                    yield_redemption_date_val = _null_if_zero(yield_redemption_date)
                    currency_val = currency if (currency and str(currency).strip()) else None

                    has_comm = (
                        _has_meaningful_commission(commission)
                        or _has_meaningful_commission(realized_pnl)
                        or _has_meaningful_commission(currency, is_numeric=False)
                        or _has_meaningful_commission(yield_)
                        or _has_meaningful_commission(yield_redemption_date)
                    )
                    # 仅当有至少一个「有意义」的 commission 字段时才写，避免 7 天拉取用空数据覆盖 1 天拉到的有效值
                    if exec_id and has_comm:
                        cur.execute(
                            """
                            INSERT INTO account_execution_commissions (exec_id, commission, currency, realized_pnl, yield_, yield_redemption_date)
                            VALUES (%s, %s, %s, %s, %s, %s)
                            ON CONFLICT (exec_id) DO UPDATE SET
                                commission = CASE
                                    WHEN EXCLUDED.commission IS NOT NULL AND EXCLUDED.commission != 0 THEN EXCLUDED.commission
                                    ELSE account_execution_commissions.commission
                                END,
                                currency = CASE
                                    WHEN EXCLUDED.currency IS NOT NULL AND TRIM(COALESCE(EXCLUDED.currency, '')) != '' THEN EXCLUDED.currency
                                    ELSE account_execution_commissions.currency
                                END,
                                realized_pnl = CASE
                                    WHEN EXCLUDED.realized_pnl IS NOT NULL AND EXCLUDED.realized_pnl != 0 THEN EXCLUDED.realized_pnl
                                    ELSE account_execution_commissions.realized_pnl
                                END,
                                yield_ = CASE
                                    WHEN EXCLUDED.yield_ IS NOT NULL AND EXCLUDED.yield_ != 0 THEN EXCLUDED.yield_
                                    ELSE account_execution_commissions.yield_
                                END,
                                yield_redemption_date = CASE
                                    WHEN EXCLUDED.yield_redemption_date IS NOT NULL AND EXCLUDED.yield_redemption_date != 0 THEN EXCLUDED.yield_redemption_date
                                    ELSE account_execution_commissions.yield_redemption_date
                                END
                            """,
                            (exec_id, commission_val, currency_val, realized_pnl_val, yield_val, yield_redemption_date_val),
                        )
            self._conn.commit()
            logger.info("[R-A2] write_account_executions: wrote %s rows", len(rows))
        except Exception as e:
            self._conn.rollback()
            logger.warning("write_account_executions failed: %s", e, exc_info=True)

    def update_execution_commission(
        self, exec_id: str, commission: Any, realized_pnl: Any, currency: Any,
        yield_: Any = None, yield_redemption_date: Any = None,
    ) -> None:
        """R-A2: 收到 commissionReport 事件时按 exec_id 写入 account_execution_commissions。"""
        if not exec_id:
            return
        if not self._ensure_conn():
            return
        def _nz(v):
            if v is None:
                return None
            try:
                if float(v) == 0:
                    return None
            except (TypeError, ValueError):
                pass
            return v
        commission_val = _nz(commission)
        realized_pnl_val = _nz(realized_pnl)
        yield_val = _nz(yield_)
        yield_redemption_date_val = _nz(yield_redemption_date)
        currency_val = currency if (currency and str(currency).strip()) else None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO account_execution_commissions (exec_id, commission, currency, realized_pnl, yield_, yield_redemption_date)
                    VALUES (%s, %s, %s, %s, %s, %s)
                    ON CONFLICT (exec_id) DO UPDATE SET
                        commission = CASE
                            WHEN EXCLUDED.commission IS NOT NULL AND EXCLUDED.commission != 0 THEN EXCLUDED.commission
                            ELSE account_execution_commissions.commission
                        END,
                        currency = CASE
                            WHEN EXCLUDED.currency IS NOT NULL AND TRIM(COALESCE(EXCLUDED.currency, '')) != '' THEN EXCLUDED.currency
                            ELSE account_execution_commissions.currency
                        END,
                        realized_pnl = CASE
                            WHEN EXCLUDED.realized_pnl IS NOT NULL AND EXCLUDED.realized_pnl != 0 THEN EXCLUDED.realized_pnl
                            ELSE account_execution_commissions.realized_pnl
                        END,
                        yield_ = CASE
                            WHEN EXCLUDED.yield_ IS NOT NULL AND EXCLUDED.yield_ != 0 THEN EXCLUDED.yield_
                            ELSE account_execution_commissions.yield_
                        END,
                        yield_redemption_date = CASE
                            WHEN EXCLUDED.yield_redemption_date IS NOT NULL AND EXCLUDED.yield_redemption_date != 0 THEN EXCLUDED.yield_redemption_date
                            ELSE account_execution_commissions.yield_redemption_date
                        END
                    """,
                    (exec_id, commission_val, currency_val, realized_pnl_val, yield_val, yield_redemption_date_val),
                )
            self._conn.commit()
        except Exception as e:
            self._conn.rollback()
            logger.warning("update_execution_commission failed: exec_id=%r %s", exec_id, e)

    def write_ohlc_bars(self, rows: Any) -> None:
        """R-A3 扩展：写入股票 K 线到 stock_day（1 D）或 stock_min（1 min, 5 mins, 1 hour）。按 (symbol, bar_time) 或 (symbol, period, bar_time) UPSERT。"""
        if not rows:
            return
        if not self._ensure_conn():
            return
        try:
            with self._conn.cursor() as cur:
                for r in rows:
                    symbol = (r.get("symbol") or "").strip()
                    period = (r.get("period") or "1 D").strip()
                    bar_time = r.get("bar_time")
                    open_ = r.get("open")
                    high = r.get("high")
                    low = r.get("low")
                    close = r.get("close")
                    volume = r.get("volume")
                    if bar_time is None or not symbol:
                        continue
                    if isinstance(bar_time, (int, float)):
                        bar_dt = datetime.fromtimestamp(float(bar_time), tz=timezone.utc)
                    else:
                        bar_dt = bar_time
                    if period.upper() == "1 D":
                        cur.execute(
                            """
                            INSERT INTO stock_day (symbol, bar_time, open, high, low, close, volume)
                            VALUES (%s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (symbol, bar_time)
                            DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                                          close = EXCLUDED.close, volume = EXCLUDED.volume
                            """,
                            (symbol, bar_dt, open_, high, low, close, volume),
                        )
                    else:
                        cur.execute(
                            """
                            INSERT INTO stock_min (symbol, period, bar_time, open, high, low, close, volume)
                            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                            ON CONFLICT (symbol, period, bar_time)
                            DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                                          close = EXCLUDED.close, volume = EXCLUDED.volume
                            """,
                            (symbol, period, bar_dt, open_, high, low, close, volume),
                        )
            self._conn.commit()
            logger.info("[R-A3] write_ohlc_bars: wrote %s rows to stock_day/stock_min", len(rows))
        except Exception as e:
            self._conn.rollback()
            logger.warning("write_ohlc_bars failed: %s", e, exc_info=True)

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
                    self._conn.rollback()
                    return None
                row_id, command, created_at = row
                cmd = (command or "").strip().lower()
                if cmd not in ("stop", "flatten", "retry_ib", "release_ib", "refresh_accounts", "refresh_replay", "refresh_ticker_subscriptions"):
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
                    cur.execute(
                        "UPDATE daemon_control SET consumed_at = now() WHERE id = %s",
                        (row_id,),
                    )
                    self._conn.commit()
                    logger.info(
                        "Consumed stale control command from daemon_control (id=%s): %s (age %.0fs > %s s, not executed)",
                        row_id,
                        cmd,
                        age_sec,
                        self.CONTROL_CMD_MAX_AGE_SEC,
                    )
                    return None
                cur.execute(
                    "UPDATE daemon_control SET consumed_at = now() WHERE id = %s",
                    (row_id,),
                )
            self._conn.commit()
            logger.info(
                "Consumed control command from daemon_control (id=%s): %s", row_id, cmd
            )
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
        redis_quotes_connected: bool = False,
        event_subscribe_ticker: bool = False,
        event_subscribe_positions: bool = False,
        event_subscribe_fills: bool = False,
        event_subscribe_commission: bool = False,
        listener_connected: bool = False,
        listener_client_id: Optional[int] = None,
    ) -> None:
        """Update daemon_heartbeat row (id=1). RE-6: daemon vs hedge; RE-7: ib_connected, ib_client_id, next_retry_ts.
        seconds_until_retry: relative countdown from daemon clock, avoids clock skew on UI (optional).
        heartbeat_interval_sec: interval in use by daemon, for monitor countdown.
        redis_quotes_connected: whether daemon is writing real-time quotes to Redis (R-RM*).
        event_subscribe_*: daemon IB event subscription status for System page (ticker, positions, fills, commission).
        listener_connected/listener_client_id: second daemon IB connection (TWS client_id from settings.ib_client_id_listener)."""
        if not self._ensure_conn():
            return
        for attempt in (1, 2):
            try:
                with self._conn.cursor() as cur:
                    iv = (
                        int(heartbeat_interval_sec)
                        if heartbeat_interval_sec is not None
                        else None
                    )
                    if next_retry_ts is not None:
                        cur.execute(
                            """
                            UPDATE daemon_heartbeat
                            SET last_ts = now(), hedge_running = %s, ib_connected = %s, ib_client_id = %s,
                                next_retry_ts = to_timestamp(%s) AT TIME ZONE 'UTC', seconds_until_retry = %s,
                                graceful_shutdown_at = NULL, heartbeat_interval_sec = %s, redis_quotes_connected = %s,
                                event_subscribe_ticker = %s, event_subscribe_positions = %s,
                                event_subscribe_fills = %s, event_subscribe_commission = %s,
                                listener_connected = %s, listener_client_id = %s
                            WHERE id = 1
                            """,
                            (
                                hedge_running,
                                ib_connected,
                                ib_client_id,
                                next_retry_ts,
                                seconds_until_retry,
                                iv,
                                redis_quotes_connected,
                                event_subscribe_ticker,
                                event_subscribe_positions,
                                event_subscribe_fills,
                                event_subscribe_commission,
                                listener_connected,
                                listener_client_id,
                            ),
                        )
                    else:
                        cur.execute(
                            """
                            UPDATE daemon_heartbeat
                            SET last_ts = now(), hedge_running = %s, ib_connected = %s, ib_client_id = %s,
                                next_retry_ts = NULL, seconds_until_retry = NULL, graceful_shutdown_at = NULL,
                                heartbeat_interval_sec = %s, redis_quotes_connected = %s,
                                event_subscribe_ticker = %s, event_subscribe_positions = %s,
                                event_subscribe_fills = %s, event_subscribe_commission = %s,
                                listener_connected = %s, listener_client_id = %s
                            WHERE id = 1
                            """,
                            (hedge_running, ib_connected, ib_client_id, iv, redis_quotes_connected,
                             event_subscribe_ticker, event_subscribe_positions, event_subscribe_fills, event_subscribe_commission,
                             listener_connected, listener_client_id),
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
        """Read settings (id=1): host, port_type, client_id (Trading/Listener/Account/Market data). Used by daemon at startup. See DATABASE.md §2.9 Client ID 使用场景."""
        if not self._ensure_conn():
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    "SELECT ib_host, ib_port_type, "
                    "COALESCE(ib_client_id_daemon, 1), COALESCE(ib_client_id_listener, 2), COALESCE(ib_client_id_account, 100), COALESCE(ib_client_id_markets, 101) "
                    "FROM settings WHERE id = 1"
                )
                row = cur.fetchone()
            if row is None or not row[0]:
                return None
            host = (row[0] or "").strip() or "127.0.0.1"
            port_type = (row[1] or "").strip().lower() or "tws_paper"
            port = IB_PORT_TYPE_TO_PORT.get(port_type, 7497)
            out = {
                "host": host,
                "port_type": port_type,
                "port": port,
                "client_id_daemon": int(row[2]) if row[2] is not None else 1,
                "client_id_listener": int(row[3]) if row[3] is not None else 2,
                "ib_client_id_account": int(row[4]) if row[4] is not None else 4,
                "ib_client_id_markets": int(row[5]) if row[5] is not None else 10,
            }
            try:
                with self._conn.cursor() as cur2:
                    cur2.execute(
                        "SELECT ib_primary_account_id FROM settings WHERE id = 1"
                    )
                    r2 = cur2.fetchone()
                    if r2 and r2[0] is not None and str(r2[0]).strip():
                        out["primary_account_id"] = str(r2[0]).strip()
            except Exception:
                pass
            return out
        except Exception as e:
            self._conn.rollback()
            logger.debug("get_ib_connection_config failed: %s", e)
            return None

    def get_watchlist_stk_symbols(self) -> List[str]:
        """Return distinct symbol strings from watchlist where sec_type is STK (or null/empty).
        Used by daemon to subscribe to market data for Watchlist stocks only (R-RM*)."""
        if not self._ensure_conn():
            return []
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT DISTINCT TRIM(symbol) AS sym FROM watchlist
                    WHERE symbol IS NOT NULL AND TRIM(symbol) != ''
                    AND (sec_type IS NULL OR UPPER(TRIM(sec_type)) = 'STK')
                    ORDER BY sym
                    """
                )
                rows = cur.fetchall()
            return [str(r[0]) for r in rows if r and r[0]]
        except Exception as e:
            logger.debug("get_watchlist_stk_symbols failed: %s", e)
            self._conn.rollback()
            return []

    def write_daemon_graceful_shutdown(self) -> None:
        """Set daemon_heartbeat.graceful_shutdown_at = now() and ib_client_id = NULL so next start uses client_id=1.
        Call on SIGTERM/SIGINT or after consuming stop (not on SIGKILL - cannot be caught).
        """
        if not self._ensure_conn():
            return
        for attempt in (1, 2):
            try:
                with self._conn.cursor() as cur:
                    cur.execute(
                        "UPDATE daemon_heartbeat SET graceful_shutdown_at = now(), last_ts = now(), ib_client_id = NULL WHERE id = 1"
                    )
                self._conn.commit()
                logger.info(
                    "Wrote daemon_heartbeat.graceful_shutdown_at and ib_client_id=NULL (graceful stop for monitoring)"
                )
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
                        cur.execute(
                            "SELECT suspended FROM daemon_run_status WHERE id = 1"
                        )
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
