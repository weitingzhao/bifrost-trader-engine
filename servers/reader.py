"""Read-only PostgreSQL access for status_current and operations. Phase 2."""

import json
import logging
import math
import uuid
from datetime import datetime, timezone
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

    def get_executions(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        """Return rows from account_executions (R-A2). Newest first. Converts exec_time to Unix time for API."""
        if not self._connect():
            return []
        try:
            conditions = []
            values: List[Any] = []
            if since_ts is not None:
                conditions.append("extract(epoch from exec_time) >= %s")
                values.append(since_ts)
            if until_ts is not None:
                conditions.append("extract(epoch from exec_time) <= %s")
                values.append(until_ts)
            if account_id is not None and account_id.strip():
                conditions.append("account_id = %s")
                values.append(account_id.strip())
            where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
            values.append(limit)
            # commission/realized_pnl/currency 来自 account_execution_commissions（§2.11.1）
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                try:
                    cur.execute(
                        f"""
                        SELECT e.id, e.account_id, e.exec_id, extract(epoch from e.exec_time) AS time,
                               e.symbol, e.sec_type, e.side, e.quantity, e.price,
                               c.commission, e.source,
                               e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                               c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra
                        FROM account_executions e
                        LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
                        {where}
                        ORDER BY e.exec_time DESC NULLS LAST LIMIT %s
                        """,
                        values,
                    )
                except Exception as col_err:
                    if "does not exist" in str(col_err).lower() or "42703" in str(getattr(col_err, "pgcode", "")):
                        try:
                            cur.execute(
                                f"""
                                SELECT e.id, e.account_id, e.exec_id, extract(epoch from e.exec_time) AS time,
                                       e.symbol, e.sec_type, e.side, e.quantity, e.price,
                                       c.commission, e.source,
                                       e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                                       c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra
                                FROM account_executions e
                                LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id
                                {where}
                                ORDER BY e.exec_time DESC NULLS LAST LIMIT %s
                                """,
                                values,
                            )
                        except Exception:
                            cur.execute(
                                f"""
                                        SELECT id, account_id, exec_id, extract(epoch from exec_time) AS time,
                                               symbol, sec_type, side, quantity, price,
                                               NULL::double precision AS commission, source,
                                               expiry, strike, option_right, exchange, order_id, cum_qty,
                                               NULL::double precision AS realized_pnl, contract_key,
                                               NULL::text AS currency, NULL::double precision AS yield_, NULL::integer AS yield_redemption_date, raw_extra
                                        FROM account_executions {where}
                                ORDER BY exec_time DESC NULLS LAST LIMIT %s
                                """,
                                values,
                            )
                    else:
                        raise
                rows = cur.fetchall()
            out: List[Dict[str, Any]] = []
            for r in rows:
                d = dict(r)
                if d.get("raw_extra") is not None and isinstance(d["raw_extra"], str):
                    try:
                        import json
                        d["raw_extra"] = json.loads(d["raw_extra"])
                    except Exception:
                        pass
                out.append(d)
            return out
        except Exception as e:
            logger.debug("get_executions failed: %s", e)
            self._conn = None
            return []

    def get_bars(
        self,
        symbol: Optional[str] = None,
        period: str = "1 D",
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        """Return rows from ohlc_bars (R-A3). Newest first. bar_time as Unix time for API."""
        if not self._connect():
            return []
        if not symbol or not symbol.strip():
            return []
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT symbol, period, extract(epoch from bar_time) AS time,
                           open, high, low, close, volume
                    FROM ohlc_bars
                    WHERE symbol = %s AND period = %s
                    ORDER BY bar_time DESC NULLS LAST
                    LIMIT %s
                    """,
                    (symbol.strip(), period.strip(), limit),
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        except Exception as e:
            logger.debug("get_bars failed: %s", e)
            self._conn = None
            return []

    def get_risk_summary(self) -> Dict[str, Any]:
        """Return risk/post-mortem summary for 复盘与风控 page: status_current (daily_hedge_count, daily_pnl) + operations count in last 24h + block_reasons. R-M7."""
        import time
        out: Dict[str, Any] = {
            "daily_hedge_count": None,
            "daily_pnl": None,
            "spot": None,
            "symbol": None,
            "operations_count_24h": 0,
            "block_reasons": [],
            "ts": None,
        }
        row = self.get_status_current()
        if row is not None:
            out["daily_hedge_count"] = row.get("daily_hedge_count")
            out["daily_pnl"] = row.get("daily_pnl")
            out["spot"] = row.get("spot")
            out["symbol"] = row.get("symbol")
            out["ts"] = row.get("ts")
        now = time.time()
        ops = self.get_operations(since_ts=now - 86400, limit=500)
        out["operations_count_24h"] = len(ops)
        # block_reasons 由 self_check 产出，此处无 self_check；若需要可从 status_current 扩展或由 API 层合并 GET /status 的 block_reasons
        return out

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
                        """
                        SELECT
                            ap.account_id,
                            ap.symbol,
                            ap.sec_type,
                            ap.exchange,
                            ap.currency,
                            ap.position,
                            ap.avg_cost,
                            ap.expiry,
                            ap.strike,
                            ap.option_right,
                            ap.contract_key,
                            ip.mid AS price_mid,
                            ip.last AS price_last
                        FROM account_positions ap
                        LEFT JOIN instrument_prices ip
                            ON ap.contract_key = ip.contract_key
                        WHERE ap.account_id = %s
                        ORDER BY ap.contract_key
                        """,
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

                        # 价格优先使用 instrument_prices.mid，其次使用 last；仅过滤 NaN/Inf
                        raw_mid = p.get("price_mid")
                        raw_last = p.get("price_last")
                        price_val: Optional[float] = None
                        for candidate in (raw_mid, raw_last):
                            if candidate is None:
                                continue
                            try:
                                v = float(candidate)
                            except (TypeError, ValueError):
                                continue
                            if not math.isfinite(v):
                                continue
                            price_val = v
                            break
                        if price_val is not None:
                            pos_dict["price"] = price_val

                        positions.append(pos_dict)
                out.append({"account_id": acc_id, "summary": summary, "positions": positions})
            return out
        except Exception as e:
            logger.debug("get_accounts_from_tables failed: %s", e)
            self._conn = None
            return None

    def get_accounts_fetched_at(self) -> Optional[float]:
        """Return max(updated_at) from accounts as Unix timestamp (seconds), or None if no rows/error. For UI to show when IB accounts data was last synced."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT max(updated_at) AS t FROM accounts")
                row = cur.fetchone()
            if row and row[0] is not None:
                ts = row[0]
                return ts.timestamp() if hasattr(ts, "timestamp") else float(ts)
            return None
        except Exception as e:
            logger.debug("get_accounts_fetched_at failed: %s", e)
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


def _has_meaningful_commission(v: Any, is_numeric: bool = True) -> bool:
    """是否有意义的 commission 相关值（非 None，数值非 0，字符串非空）。"""
    if v is None:
        return False
    if is_numeric and v == 0:
        return False
    if not is_numeric and (not v or not str(v).strip()):
        return False
    return True


def write_account_executions_to_db(status_config: dict, rows: List[Dict[str, Any]]) -> bool:
    """R-A2: 写入执行记录到 account_executions；CommissionReport 写入 account_execution_commissions。按 exec_id 去重。"""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    import json
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
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
                    raw_extra = r.get("raw_extra")
                    if raw_extra is not None and not isinstance(raw_extra, str):
                        raw_extra = json.dumps(raw_extra) if raw_extra else None
                    if exec_time is not None:
                        try:
                            if isinstance(exec_time, (int, float)):
                                exec_dt = datetime.fromtimestamp(float(exec_time), tz=timezone.utc)
                            else:
                                exec_dt = exec_time
                        except Exception:
                            exec_dt = None
                    else:
                        exec_dt = None
                    cols = "account_id, exec_id, exec_time, symbol, sec_type, side, quantity, price, source, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, raw_extra"
                    placeholders = "%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s"
                    vals = (account_id, exec_id, exec_dt, symbol, sec_type, side, quantity, price, source, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, raw_extra)
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
                    # 传参时把 0 当作 NULL，避免 SQL 端用 0 覆盖已有值（含类型为 str 的 "0"）
                    def _null_if_zero(v):
                        if v is None:
                            return None
                        try:
                            if float(v) == 0:
                                return None
                        except (TypeError, ValueError):
                            pass
                        return v if (v != "" and v is not None) else None
                    commission_val = _null_if_zero(commission)
                    realized_pnl_val = _null_if_zero(realized_pnl)
                    yield_val = _null_if_zero(yield_)
                    yield_redemption_date_val = _null_if_zero(yield_redemption_date)
                    currency_val = currency if (currency and str(currency).strip()) else None
                    # 仅当有至少一个「有意义」的 commission 字段时才写 commission 表，避免 7 天拉取时用空数据覆盖 1 天拉到的有效值
                    has_comm = (
                        _has_meaningful_commission(commission)
                        or _has_meaningful_commission(realized_pnl)
                        or _has_meaningful_commission(currency, is_numeric=False)
                        or _has_meaningful_commission(yield_)
                        or _has_meaningful_commission(yield_redemption_date)
                    )
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
            n_comm = sum(1 for r in rows if r.get("exec_id") and (r.get("commission") is not None or r.get("realized_pnl") is not None or r.get("currency") is not None or r.get("yield_") is not None or r.get("yield_redemption_date") is not None))
            conn.commit()
            logger.info("[R-A2] write_account_executions_to_db: wrote %s rows (%s with commission)", len(rows), n_comm)
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_account_executions_to_db failed: %s", e)
        return False


def update_execution_commission(
    status_config: dict,
    exec_id: str,
    commission: Optional[float],
    realized_pnl: Optional[float],
    currency: Optional[str],
    yield_: Optional[float] = None,
    yield_redemption_date: Optional[int] = None,
) -> bool:
    """R-A2: 收到 IB commissionReport 事件时按 exec_id 写入 account_execution_commissions。"""
    if not exec_id or not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    def _nz(v):
        if v is None: return None
        try:
            if float(v) == 0: return None
        except (TypeError, ValueError):
            pass
        return v
    commission_val = _nz(commission)
    realized_pnl_val = _nz(realized_pnl)
    yield_val = _nz(yield_)
    yield_redemption_date_val = _nz(yield_redemption_date)
    currency_val = currency if (currency and str(currency).strip()) else None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
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
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("update_execution_commission failed: exec_id=%r %s", exec_id, e)
        return False


def _exec_time_to_dt(exec_time: Any) -> Optional[datetime]:
    if exec_time is None:
        return None
    try:
        if isinstance(exec_time, (int, float)):
            return datetime.fromtimestamp(float(exec_time), tz=timezone.utc)
        if isinstance(exec_time, str) and exec_time.strip():
            return datetime.fromtimestamp(float(exec_time.strip()), tz=timezone.utc)
        return exec_time
    except (TypeError, ValueError):
        return None


def insert_one_execution(status_config: dict, body: Dict[str, Any]) -> Optional[int]:
    """R-A2 扩展：手动添加一条执行记录（历史补录）。返回新行 id，失败返回 None。
    body: account_id, time(Unix s), symbol, sec_type, side, quantity, price; 可选 source('manual'), exec_id, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key; 可选 commission, realized_pnl, currency。
    若未提供 exec_id 则生成 manual_<uuid> 以便可写 commission 表。"""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    account_id = body.get("account_id") or ""
    exec_time = body.get("time")
    symbol = (body.get("symbol") or "").strip()
    sec_type = (body.get("sec_type") or "STK").strip().upper() or "STK"
    side = (body.get("side") or "").strip().upper()
    quantity = body.get("quantity")
    price = body.get("price")
    if symbol is None or quantity is None or price is None:
        return None
    exec_id = (body.get("exec_id") or "").strip()
    if not exec_id:
        exec_id = "manual_" + uuid.uuid4().hex
    source = (body.get("source") or "manual").strip() or "manual"
    expiry = body.get("expiry")
    strike = body.get("strike")
    option_right = body.get("option_right")
    exchange = body.get("exchange")
    order_id = body.get("order_id")
    cum_qty = body.get("cum_qty")
    contract_key = body.get("contract_key")
    raw_extra = body.get("raw_extra")
    if raw_extra is not None and not isinstance(raw_extra, str):
        raw_extra = json.dumps(raw_extra) if raw_extra else None
    exec_dt = _exec_time_to_dt(exec_time)
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cols = "account_id, exec_id, exec_time, symbol, sec_type, side, quantity, price, source, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, raw_extra"
                placeholders = "%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s"
                vals = (account_id, exec_id, exec_dt, symbol, sec_type, side, quantity, price, source, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key, raw_extra)
                cur.execute(
                    f"INSERT INTO account_executions ({cols}) VALUES ({placeholders}) RETURNING id",
                    vals,
                )
                row = cur.fetchone()
                new_id = row[0] if row else None
                commission = body.get("commission")
                realized_pnl = body.get("realized_pnl")
                currency = body.get("currency")
                if commission is not None or realized_pnl is not None or (currency and str(currency).strip()):
                    cur.execute(
                        """
                        INSERT INTO account_execution_commissions (exec_id, commission, currency, realized_pnl, yield_, yield_redemption_date)
                        VALUES (%s, %s, %s, %s, NULL, NULL)
                        ON CONFLICT (exec_id) DO UPDATE SET
                            commission = COALESCE(EXCLUDED.commission, account_execution_commissions.commission),
                            currency = COALESCE(NULLIF(TRIM(COALESCE(EXCLUDED.currency, '')), ''), account_execution_commissions.currency),
                            realized_pnl = COALESCE(EXCLUDED.realized_pnl, account_execution_commissions.realized_pnl)
                        """,
                        (exec_id, commission, currency or None, realized_pnl),
                    )
            conn.commit()
            return new_id
        finally:
            conn.close()
    except Exception as e:
        logger.warning("insert_one_execution failed: %s", e)
        return None


def update_one_execution(status_config: dict, id_: int, body: Dict[str, Any]) -> bool:
    """R-A2 扩展：按 id 更新一条执行记录（手动修正）。body 可含任意子集：time, symbol, sec_type, side, quantity, price, account_id, source, expiry, strike, option_right, exchange, order_id, cum_qty, contract_key; 以及 commission, realized_pnl, currency（写 account_execution_commissions，以该行 exec_id 关联；若无 exec_id 则设为 manual_<id> 再写入）。"""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    # 可更新列（account_executions）
    exec_cols = ("exec_time", "symbol", "sec_type", "side", "quantity", "price", "account_id", "source", "expiry", "strike", "option_right", "exchange", "order_id", "cum_qty", "contract_key")
    commission_keys = ("commission", "realized_pnl", "currency")
    updates: List[str] = []
    values: List[Any] = []
    for k in exec_cols:
        if k == "exec_time":
            # 前端传 time（Unix 秒），后端列名为 exec_time
            v = body.get("exec_time") if body.get("exec_time") is not None else body.get("time")
            if v is None:
                continue
            v = _exec_time_to_dt(v)
        elif k not in body:
            continue
        else:
            v = body[k]
        if k == "raw_extra" and v is not None and not isinstance(v, str):
            v = json.dumps(v) if v else None
        updates.append(f'"{k}" = %s')
        values.append(v)
    values.append(id_)
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                if updates:
                    cur.execute(
                        "UPDATE account_executions SET " + ", ".join(updates) + " WHERE id = %s",
                        values,
                    )
                    if cur.rowcount == 0:
                        conn.rollback()
                        return False
                # commission 相关
                if any(k in body for k in commission_keys):
                    cur.execute("SELECT exec_id FROM account_executions WHERE id = %s", (id_,))
                    row = cur.fetchone()
                    exec_id = row[0] if row and row[0] and str(row[0]).strip() else None
                    if not exec_id:
                        exec_id = "manual_" + str(id_)
                        cur.execute("UPDATE account_executions SET exec_id = %s WHERE id = %s", (exec_id, id_))
                    comm = body.get("commission")
                    pnl = body.get("realized_pnl")
                    cur_ = body.get("currency")
                    cur.execute(
                        """
                        INSERT INTO account_execution_commissions (exec_id, commission, currency, realized_pnl, yield_, yield_redemption_date)
                        VALUES (%s, %s, %s, %s, NULL, NULL)
                        ON CONFLICT (exec_id) DO UPDATE SET
                            commission = CASE WHEN EXCLUDED.commission IS NOT NULL THEN EXCLUDED.commission ELSE account_execution_commissions.commission END,
                            currency = CASE WHEN EXCLUDED.currency IS NOT NULL AND TRIM(EXCLUDED.currency) != '' THEN EXCLUDED.currency ELSE account_execution_commissions.currency END,
                            realized_pnl = CASE WHEN EXCLUDED.realized_pnl IS NOT NULL THEN EXCLUDED.realized_pnl ELSE account_execution_commissions.realized_pnl END
                        """,
                        (exec_id, comm, cur_, pnl),
                    )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("update_one_execution failed: id=%s %s", id_, e)
        return False


def delete_one_execution(status_config: dict, id_: int) -> bool:
    """R-A2 扩展：按 id 删除一条执行记录。先删 account_execution_commissions 中关联的 exec_id，再删 account_executions。"""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT exec_id FROM account_executions WHERE id = %s", (id_,))
                row = cur.fetchone()
                exec_id = row[0] if row and row[0] and str(row[0]).strip() else None
                if exec_id:
                    cur.execute("DELETE FROM account_execution_commissions WHERE exec_id = %s", (exec_id,))
                cur.execute("DELETE FROM account_executions WHERE id = %s", (id_,))
                if cur.rowcount == 0:
                    conn.rollback()
                    return False
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_one_execution failed: id=%s %s", id_, e)
        return False


def write_ohlc_bars_to_db(status_config: dict, rows: List[Dict[str, Any]]) -> bool:
    """R-A3: 写入 K 线到 ohlc_bars（供 API 直接拉取后落库）。按 (symbol, period, bar_time) UPSERT。Returns True on success."""
    if not rows or not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                for r in rows:
                    symbol = r.get("symbol") or ""
                    period = r.get("period") or "1 D"
                    bar_time = r.get("bar_time")
                    if bar_time is None:
                        continue
                    if isinstance(bar_time, (int, float)):
                        bar_dt = datetime.fromtimestamp(float(bar_time), tz=timezone.utc)
                    else:
                        bar_dt = bar_time
                    open_ = r.get("open")
                    high = r.get("high")
                    low = r.get("low")
                    close = r.get("close")
                    volume = r.get("volume")
                    cur.execute(
                        """
                        INSERT INTO ohlc_bars (symbol, period, bar_time, open, high, low, close, volume)
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (symbol, period, bar_time)
                        DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
                                      close = EXCLUDED.close, volume = EXCLUDED.volume
                        """,
                        (symbol, period, bar_dt, open_, high, low, close, volume),
                    )
            conn.commit()
            logger.info("[R-A3] write_ohlc_bars_to_db: wrote %s rows", len(rows))
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_ohlc_bars_to_db failed: %s", e)
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
