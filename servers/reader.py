"""Read-only PostgreSQL access for status_current and operations. Phase 2."""

import json
import logging
import math
import uuid
from datetime import date, datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import psycopg2
from psycopg2.extras import RealDictCursor

from src.sink.postgres_sink import _get_conn_params, _sync_accounts_snapshot_to_tables

logger = logging.getLogger(__name__)


def _fill_contract_key_for_opt(d: Dict[str, Any]) -> None:
    """In-place: for OPT rows with missing contract_key, set contract_key from symbol|OPT|expiry|strike|option_right."""
    if (d.get("sec_type") or "").strip().upper() != "OPT":
        return
    ck = (d.get("contract_key") or "").strip()
    if ck:
        return
    sym = (d.get("symbol") or "").strip()
    exp = (d.get("expiry") or "")
    if isinstance(exp, (int, float)) and math.isfinite(exp):
        exp = str(int(exp))
    else:
        exp = (exp or "").strip().replace("-", "")
    strike = d.get("strike")
    if strike is not None and not isinstance(strike, str):
        strike = str(int(strike)) if strike is not None and math.isfinite(strike) else ""
    else:
        strike = (strike or "").strip()
    right = (d.get("option_right") or "").strip().upper()
    if len(right) > 1:
        right = "C" if right.startswith("C") else "P" if right.startswith("P") else right[:1]
    if not right and "right" in d:
        right = (d.get("right") or "").strip().upper()[:1] or ""
    d["contract_key"] = f"{sym}|OPT|{exp}|{strike}|{right}"


def _row_to_heartbeat(row: tuple) -> Dict[str, Any]:
    """Build daemon_heartbeat dict from (last_ts, hedge_running, ib_connected, ib_client_id, next_retry_ts, seconds_until_retry, graceful_shutdown_at[, heartbeat_interval_sec[, redis_quotes_connected[, event_subscribe_ticker, event_subscribe_positions, event_subscribe_fills, event_subscribe_commission[, listener_connected, listener_client_id]]])."""
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


class StatusReader:
    """Read status_current and operations from PostgreSQL. Uses the same root postgres config as daemon."""

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
            out = _row_to_heartbeat(row)
            return out
        except Exception as e:
            # Column graceful_shutdown_at or redis_quotes_connected or event_subscribe_* or listener_* may be missing in DBs not yet migrated
            err = str(e).lower()
            if "listener_connected" in err or "listener_client_id" in err:
                try:
                    with self._conn.cursor() as cur:
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
                    extra = (None, None)  # listener_connected, listener_client_id
                    return _row_to_heartbeat(row + extra)
                except Exception as e2:
                    logger.debug("get_daemon_heartbeat (fallback no listener_*) failed: %s", e2)
            if "event_subscribe" in err or "redis_quotes_connected" in err:
                try:
                    with self._conn.cursor() as cur:
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
                    # Append None for missing event_subscribe_* (or redis_quotes_connected) and listener_*
                    extra = (None,) * (15 - len(row))
                    return _row_to_heartbeat(row + extra)
                except Exception as e2:
                    logger.debug("get_daemon_heartbeat (fallback no event_subscribe/redis_quotes) failed: %s", e2)
            if "graceful_shutdown_at" in err or "column" in err:
                try:
                    with self._conn.cursor() as cur:
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
                    return _row_to_heartbeat(row)  # minimal columns
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
        limit: Optional[int] = 200,
    ) -> List[Dict[str, Any]]:
        """Return rows from account_executions (R-A2). Newest first. Converts exec_time to Unix time for API.
        When limit is None or 0, no LIMIT is applied (return all matching rows).
        用于「取当天交易记录」的第一条 Query。配对（C↔P 另一条）由 get_executions_with_opt_pairs
        通过第二条 Query（get_executions_by_contract_keys）按合约键拉取所有腿（可跨日）后再做。
        """
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
            use_limit = limit is not None and limit > 0
            if use_limit:
                values.append(limit)
            limit_clause = " LIMIT %s" if use_limit else ""
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
                        ORDER BY e.exec_time DESC NULLS LAST{limit_clause}
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
                                ORDER BY e.exec_time DESC NULLS LAST{limit_clause}
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
                                ORDER BY exec_time DESC NULLS LAST{limit_clause}
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
                if "time" in d and d["time"] is not None:
                    try:
                        d["time"] = float(d["time"])
                    except (TypeError, ValueError):
                        pass
                _fill_contract_key_for_opt(d)
                out.append(d)
            return out
        except Exception as e:
            logger.debug("get_executions failed: %s", e)
            self._conn = None
            return []

    def get_executions_by_contract_keys(
        self,
        contract_keys: List[Tuple[str, str, str, str]],
        account_id: Optional[str] = None,
        limit: int = 5000,
    ) -> List[Dict[str, Any]]:
        """Fetch all OPT executions whose (symbol, expiry, strike, account_id) is in the given list.
        Used as second query: after fetching day executions, get all legs for those contracts (any date)
        so C↔P can pair across days. contract_keys = [(symbol, expiry, strike_str, account_id), ...].
        """
        if not contract_keys:
            return []
        if not self._connect():
            return []
        keys_dedup = list(dict.fromkeys(contract_keys))
        placeholders = ",".join(["(%s,%s,%s,%s)"] * len(keys_dedup))
        values: List[Any] = []
        for (sym, exp, strike_s, acc) in keys_dedup:
            values.extend([sym, exp, strike_s, acc])
        conditions = [
            f"(e.symbol, e.expiry, COALESCE(e.strike::text,''), e.account_id) IN ({placeholders})",
            "upper(trim(COALESCE(e.sec_type,''))) = 'OPT'",
        ]
        if account_id is not None and account_id.strip():
            conditions.append("e.account_id = %s")
            values.append(account_id.strip())
        where = " AND ".join(conditions)
        values.append(limit)
        # 调试：打出第二条 Query 的 SQL 与参数，便于核对「如何执行」
        sql = f"""
                        SELECT e.id, e.account_id, e.exec_id, extract(epoch from e.exec_time) AS time,
                               e.symbol, e.sec_type, e.side, e.quantity, e.price,
                               c.commission, e.source,
                               e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                               c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra
                        FROM account_executions e
                        LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
                        WHERE {where}
                        ORDER BY e.exec_time ASC NULLS LAST
                        LIMIT %s
                        """
        logger.info(
            "get_executions_by_contract_keys: contract_keys=%s, len(values)=%s, sql=%s",
            keys_dedup,
            len(values),
            sql.strip(),
        )
        logger.info("get_executions_by_contract_keys: values=%s", values)
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                try:
                    cur.execute(sql, values)
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
                                WHERE {where}
                                ORDER BY e.exec_time ASC NULLS LAST
                                LIMIT %s
                                """,
                                values,
                            )
                        except Exception:
                            vals_no_acc = []
                            for (sym, exp, strike_s, acc) in keys_dedup:
                                vals_no_acc.extend([sym, exp, strike_s, acc])
                            if account_id and account_id.strip():
                                vals_no_acc.append(account_id.strip())
                            vals_no_acc.append(limit)
                            acc_filter = " AND account_id = %s" if (account_id and account_id.strip()) else ""
                            cur.execute(
                                f"""
                                SELECT id, account_id, exec_id, extract(epoch from exec_time) AS time,
                                       symbol, sec_type, side, quantity, price,
                                       NULL::double precision AS commission, source,
                                       expiry, strike, option_right, exchange, order_id, cum_qty,
                                       NULL::double precision AS realized_pnl, contract_key,
                                       NULL::text AS currency, NULL::double precision AS yield_, NULL::integer AS yield_redemption_date, raw_extra
                                FROM account_executions
                                WHERE (symbol, expiry, COALESCE(strike::text,''), account_id) IN ({placeholders})
                                  AND upper(trim(COALESCE(sec_type,''))) = 'OPT'{acc_filter}
                                ORDER BY exec_time ASC NULLS LAST
                                LIMIT %s
                                """,
                                vals_no_acc,
                            )
                    else:
                        raise
                rows = cur.fetchall()
            out = []
            for r in rows:
                d = dict(r)
                if d.get("raw_extra") is not None and isinstance(d["raw_extra"], str):
                    try:
                        import json
                        d["raw_extra"] = json.loads(d["raw_extra"])
                    except Exception:
                        pass
                if "time" in d and d["time"] is not None:
                    try:
                        d["time"] = float(d["time"])
                    except (TypeError, ValueError):
                        pass
                _fill_contract_key_for_opt(d)
                out.append(d)
            return out
        except Exception as e:
            logger.debug("get_executions_by_contract_keys failed: %s", e)
            self._conn = None
            return []

    def _norm_option_right(self, r: Any) -> str:
        if r is None:
            return ""
        s = (str(r)).strip().upper()
        if s in ("C", "CALL"):
            return "C"
        if s in ("P", "PUT"):
            return "P"
        return s

    def _compute_opt_pair_map_and_pairs(
        self, executions: List[Dict[str, Any]]
    ) -> Tuple[Dict[int, List[int]], List[Dict[str, Any]]]:
        """Pair BUY↔SELL (same symbol, expiry, strike, account_id; side opposite). FIFO.
        Returns (pair_map, opt_pairs): pair_map[exec_id] = list of paired execution ids; opt_pairs with leg_c_execution_id (buy leg), leg_p_execution_id (sell leg), c_side=BUY, p_side=SELL, etc."""
        opt_only = [
            e
            for e in executions
            if (e.get("sec_type") or "").strip().upper() == "OPT"
            and e.get("id") is not None
        ]
        pair_map: Dict[int, List[int]] = {}
        opt_pairs: List[Dict[str, Any]] = []

        def add_pair(aid: int, bid: int) -> None:
            if aid not in pair_map:
                pair_map[aid] = []
            if bid not in pair_map[aid]:
                pair_map[aid].append(bid)
            if bid not in pair_map:
                pair_map[bid] = []
            if aid not in pair_map[bid]:
                pair_map[bid].append(aid)

        # Group by (symbol, expiry, strike, account_id)
        groups: Dict[Tuple[str, str, str, str], List[Dict[str, Any]]] = {}
        for e in opt_only:
            side = (e.get("side") or "").strip().upper() or "BUY"
            if side not in ("BUY", "SELL"):
                continue
            key = (
                (e.get("symbol") or "").strip(),
                str(e.get("expiry") or "").strip(),
                str(e.get("strike") if e.get("strike") is not None else ""),
                (e.get("account_id") or "").strip(),
            )
            if key not in groups:
                groups[key] = []
            groups[key].append(e)

        for (sym, exp, strike_str, acc), group in groups.items():
            group_sorted = sorted(
                group,
                key=lambda x: float(x["time"]) if x.get("time") is not None else 0.0,
            )

            def make_queue(
                execs: List[Dict[str, Any]], want_side: str
            ) -> List[Tuple[float, float, float, str, int]]:
                out_q: List[Tuple[float, float, float, str, int]] = []
                for x in execs:
                    side = (x.get("side") or "").strip().upper() or "BUY"
                    if side != want_side:
                        continue
                    q = float(x.get("quantity") or 0)
                    p = float(x.get("price") or 0)
                    c = (
                        float(x.get("commission") or 0)
                        if x.get("commission") is not None
                        and math.isfinite(float(x.get("commission") or 0))
                        else 0.0
                    )
                    if not math.isfinite(q) or q <= 0 or not math.isfinite(p):
                        continue
                    eid = int(x["id"])
                    out_q.append((q, p, c, side, eid))
                return out_q

            buy_list = make_queue(group_sorted, "BUY")
            sell_list = make_queue(group_sorted, "SELL")
            i_b, i_s = 0, 0
            while i_b < len(buy_list) and i_s < len(sell_list):
                q_b, p_b, c_b, side_b, b_id = buy_list[i_b]
                q_s, p_s, c_s, side_s, s_id = sell_list[i_s]
                q_match = min(q_b, q_s)
                if q_match <= 0:
                    break
                c_b_alloc = (q_match / q_b) * c_b if q_b else 0.0
                c_s_alloc = (q_match / q_s) * c_s if q_s else 0.0
                sign_b = 1.0 if side_b == "SELL" else -1.0
                sign_s = 1.0 if side_s == "SELL" else -1.0
                leg_b = sign_b * q_match * p_b * 100.0 - c_b_alloc
                leg_s = sign_s * q_match * p_s * 100.0 - c_s_alloc
                pair_net = leg_b + leg_s
                add_pair(b_id, s_id)
                opt_pairs.append({
                    "leg_c_execution_id": b_id,
                    "leg_p_execution_id": s_id,
                    "symbol": sym,
                    "expiry": exp,
                    "strike": strike_str,
                    "account_id": acc,
                    "quantity": round(q_match, 4),
                    "c_side": "BUY",
                    "c_price": round(p_b, 4),
                    "p_side": "SELL",
                    "p_price": round(p_s, 4),
                    "commission": round(c_b_alloc + c_s_alloc, 2),
                    "net_pnl": round(pair_net, 2),
                })
                if q_match >= q_b:
                    i_b += 1
                    if q_match >= q_s:
                        i_s += 1
                    else:
                        sell_list[i_s] = (
                            q_s - q_match,
                            p_s,
                            c_s * (1 - q_match / q_s),
                            side_s,
                            s_id,
                        )
                else:
                    buy_list[i_b] = (
                        q_b - q_match,
                        p_b,
                        c_b * (1 - q_match / q_b),
                        side_b,
                        b_id,
                    )
                    i_s += 1

        return (pair_map, opt_pairs)

    def get_executions_with_opt_pairs(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        limit: int = 200,
    ) -> Dict[str, Any]:
        """Return executions for the time range and C↔P pair info.

        **取数方式（一条窗口 SQL + 一条按时间）**：
        1) 按时间取当天 executions（get_executions）→ 当天全部类型，供「当天交易记录」展示。
        2) 一条 SQL（CTE + 窗口函数）取出「当天有 OPT 的合约」的全部 OPT 腿，按 side 标 opt_pair_rn（BUY↔SELL 配对），
           范围仅限当天出现过的合约键；用该结果做内存配对得到 opt_pairs / pair_map。
        3) 给当天 executions 挂上 paired_execution_ids。

        Returns { executions: [...], opt_pairs: [...] }. executions 为当天记录，每条带 paired_execution_ids."""
        day_executions = self.get_executions(
            since_ts=since_ts,
            until_ts=until_ts,
            account_id=account_id,
            limit=limit,
        )
        if since_ts is None or until_ts is None:
            for e in day_executions:
                e["paired_execution_ids"] = []
            return {"executions": day_executions, "opt_pairs": []}
        all_legs = self.get_executions_with_opt_pairs_single_query(
            since_ts=since_ts,
            until_ts=until_ts,
            account_id=account_id,
            limit=5000,
        )
        pair_map, opt_pairs = self._compute_opt_pair_map_and_pairs(all_legs)
        for e in day_executions:
            eid = e.get("id")
            if eid is not None:
                e["paired_execution_ids"] = pair_map.get(int(eid), [])
            else:
                e["paired_execution_ids"] = []
        return {"executions": day_executions, "opt_pairs": opt_pairs}

    def get_executions_with_opt_pairs_single_query(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        limit: int = 5000,
    ) -> List[Dict[str, Any]]:
        """一条 SQL（CTE + 窗口函数）取出「当天有 OPT 的合约」的全部 OPT 腿，并标 in_selected_day、opt_pair_rn。
        配对按 side：PARTITION BY symbol, expiry, strike, account_id, side_norm（BUY/SELL），同组内 FIFO 配对 BUY↔SELL。
        范围仅限当天出现过的 (symbol, expiry, strike, account_id)，不会过大。
        返回每行含 in_selected_day (bool)、opt_pair_rn (int|null)、side_norm，以及 execution 所有字段。"""
        if since_ts is None or until_ts is None:
            return []
        if not self._connect():
            return []
        values: List[Any] = [since_ts, until_ts]
        acc_cond = ""
        if account_id and account_id.strip():
            acc_cond = " AND e.account_id = %s"
            values.append(account_id.strip())
        values2 = [since_ts, until_ts]
        if account_id and account_id.strip():
            values2.append(account_id.strip())
        values2.append(limit)
        sql = f"""
WITH day_keys AS (
  SELECT DISTINCT e.symbol, e.expiry, COALESCE(e.strike::text,'') AS strike_s, e.account_id
  FROM account_executions e
  WHERE extract(epoch from e.exec_time) >= %s AND extract(epoch from e.exec_time) <= %s
    AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    {acc_cond}
),
all_legs AS (
  SELECT e.id, e.account_id, e.exec_id, extract(epoch from e.exec_time) AS time,
         e.symbol, e.sec_type, e.side, e.quantity, e.price,
         c.commission, e.source,
         e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
         c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra,
         (extract(epoch from e.exec_time) >= %s AND extract(epoch from e.exec_time) <= %s) AS in_selected_day,
         upper(trim(COALESCE(e.side,''))) AS side_norm
  FROM account_executions e
  INNER JOIN day_keys k ON e.symbol = k.symbol AND e.expiry = k.expiry
    AND COALESCE(e.strike::text,'') = k.strike_s AND e.account_id = k.account_id
  LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
  WHERE upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    {acc_cond}
),
numbered AS (
  SELECT all_legs.*,
         ROW_NUMBER() OVER (PARTITION BY symbol, expiry, strike, account_id, side_norm ORDER BY time ASC NULLS LAST) AS opt_pair_rn
  FROM all_legs
  WHERE side_norm IN ('BUY', 'SELL')
)
SELECT * FROM numbered ORDER BY time ASC NULLS LAST LIMIT %s
"""
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                try:
                    cur.execute(sql, values + values2)
                except Exception as col_err:
                    if "does not exist" in str(col_err).lower() or "42703" in str(getattr(col_err, "pgcode", "")):
                        sql_fallback = f"""
WITH day_keys AS (
  SELECT DISTINCT e.symbol, e.expiry, COALESCE(e.strike::text,'') AS strike_s, e.account_id
  FROM account_executions e
  WHERE extract(epoch from e.exec_time) >= %s AND extract(epoch from e.exec_time) <= %s
    AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    {acc_cond}
),
all_legs AS (
  SELECT e.id, e.account_id, e.exec_id, extract(epoch from e.exec_time) AS time,
         e.symbol, e.sec_type, e.side, e.quantity, e.price,
         NULL::double precision AS commission, e.source,
         e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
         NULL::double precision AS realized_pnl, e.contract_key, NULL::text AS currency,
         NULL::double precision AS yield_, NULL::integer AS yield_redemption_date, e.raw_extra,
         (extract(epoch from e.exec_time) >= %s AND extract(epoch from e.exec_time) <= %s) AS in_selected_day,
         upper(trim(COALESCE(e.side,''))) AS side_norm
  FROM account_executions e
  INNER JOIN day_keys k ON e.symbol = k.symbol AND e.expiry = k.expiry
    AND COALESCE(e.strike::text,'') = k.strike_s AND e.account_id = k.account_id
  WHERE upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    {acc_cond}
),
numbered AS (
  SELECT all_legs.*,
         ROW_NUMBER() OVER (PARTITION BY symbol, expiry, strike, account_id, side_norm ORDER BY time ASC NULLS LAST) AS opt_pair_rn
  FROM all_legs
  WHERE side_norm IN ('BUY', 'SELL')
)
SELECT * FROM numbered ORDER BY time ASC NULLS LAST LIMIT %s
"""
                        cur.execute(sql_fallback, values + values2)
                    else:
                        raise
                rows = cur.fetchall()
            out = []
            for r in rows:
                d = dict(r)
                if d.get("raw_extra") is not None and isinstance(d.get("raw_extra"), str):
                    try:
                        import json
                        d["raw_extra"] = json.loads(d["raw_extra"])
                    except Exception:
                        pass
                if "time" in d and d["time"] is not None:
                    try:
                        d["time"] = float(d["time"])
                    except (TypeError, ValueError):
                        pass
                _fill_contract_key_for_opt(d)
                out.append(d)
            return out
        except Exception as e:
            logger.debug("get_executions_with_opt_pairs_single_query failed: %s", e)
            self._conn = None
            return []

    def _get_current_equity(self) -> Optional[float]:
        """Sum of net_liquidation across accounts (Phase 0). Used as current_equity and as start_equity approximation when no history."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor() as cur:
                cur.execute("SELECT COALESCE(SUM(net_liquidation), 0) AS total FROM accounts")
                row = cur.fetchone()
            if row and row[0] is not None:
                v = float(row[0])
                return v if math.isfinite(v) else None
            return 0.0
        except Exception as e:
            logger.debug("_get_current_equity failed: %s", e)
            self._conn = None
            return None

    def _compute_opt_realized_calendar(
        self,
        executions_sorted: List[Dict[str, Any]],
        granularity: str,
    ) -> List[Dict[str, Any]]:
        """Option Realized by period: pair BUY with SELL (same symbol, expiry, strike, account_id; side opposite).
        Per pair: each leg PnL = (side==SELL ? +1 : -1) * Q*P*100 - commission; pair_net = leg_buy + leg_sell. FIFO match.
        Uses America/Chicago for period date so calendar day matches the day-detail fetch (Chicago)."""
        from datetime import date, datetime, timezone, timedelta

        try:
            from zoneinfo import ZoneInfo
            CHICAGO = ZoneInfo("America/Chicago")
        except ImportError:
            CHICAGO = timezone.utc

        def _period_key(ts: float, gran: str) -> Tuple[float, str]:
            dt = datetime.fromtimestamp(ts, tz=CHICAGO)
            d = dt.date()
            if gran == "month":
                start = date(d.year, d.month, 1)
                label = start.strftime("%Y-%m")
                start_dt = datetime(start.year, start.month, start.day, tzinfo=CHICAGO)
                start_ts = start_dt.timestamp()
            elif gran == "week":
                start = d - timedelta(days=d.weekday())
                label = start.strftime("%Y-%m-%d")
                start_dt = datetime(start.year, start.month, start.day, tzinfo=CHICAGO)
                start_ts = start_dt.timestamp()
            else:
                start = d
                label = start.strftime("%Y-%m-%d")
                start_dt = datetime(start.year, start.month, start.day, tzinfo=CHICAGO)
                start_ts = start_dt.timestamp()
            return (start_ts, label)

        opt_only = [
            e
            for e in executions_sorted
            if (e.get("sec_type") or "").strip().upper() == "OPT"
        ]
        if not opt_only:
            return []

        # Group by (period_key, symbol, expiry, strike, account_id) — BUY and SELL in same group
        period_contract_groups: Dict[Tuple[float, str, str, str, str, str], List[Dict[str, Any]]] = {}
        for e in opt_only:
            t = e.get("time")
            if t is None:
                continue
            ts = float(t)
            start_ts, label = _period_key(ts, granularity)
            sym = (e.get("symbol") or "").strip()
            exp = str(e.get("expiry") or "").strip()
            strike_val = e.get("strike")
            strike_str = str(strike_val) if strike_val is not None else ""
            acc = (e.get("account_id") or "").strip()
            side = (e.get("side") or "").strip().upper() or "BUY"
            if side not in ("BUY", "SELL"):
                continue
            key = (start_ts, label, sym, exp, strike_str, acc)
            if key not in period_contract_groups:
                period_contract_groups[key] = []
            period_contract_groups[key].append(e)

        period_totals: Dict[Tuple[float, str], Dict[str, Any]] = {}

        for (start_ts, label, sym, exp, strike_str, acc), group in period_contract_groups.items():
            period_key = (start_ts, label)
            if period_key not in period_totals:
                period_totals[period_key] = {"period_start_ts": start_ts, "period_label": label, "sec_type": "OPT", "pnl": 0.0, "commission": 0.0, "net_pnl": 0.0, "trade_count": 0, "win_count": 0, "loss_count": 0, "pairs": []}

            group_sorted = sorted(group, key=lambda x: float(x["time"]))

            def make_queue(execs: List[Dict[str, Any]]) -> List[Tuple[float, float, float, str]]:
                out_q: List[Tuple[float, float, float, str]] = []
                for x in execs:
                    q = float(x.get("quantity") or 0)
                    p = float(x.get("price") or 0)
                    c = float(x.get("commission") or 0) if x.get("commission") is not None and math.isfinite(float(x.get("commission") or 0)) else 0.0
                    if not math.isfinite(q) or q <= 0:
                        continue
                    if not math.isfinite(p):
                        p = 0.0
                    side = (x.get("side") or "").strip().upper() or "BUY"
                    out_q.append((q, p, c, side))
                return out_q

            buy_list = make_queue([x for x in group_sorted if (x.get("side") or "").strip().upper() == "BUY"])
            sell_list = make_queue([x for x in group_sorted if (x.get("side") or "").strip().upper() == "SELL"])

            i_b, i_s = 0, 0
            while i_b < len(buy_list) and i_s < len(sell_list):
                q_b, p_b, c_b, side_b = buy_list[i_b]
                q_s, p_s, c_s, side_s = sell_list[i_s]
                q_match = min(q_b, q_s)
                if q_match <= 0:
                    break
                c_b_alloc = (q_match / q_b) * c_b if q_b else 0.0
                c_s_alloc = (q_match / q_s) * c_s if q_s else 0.0
                sign_b = 1.0 if side_b == "SELL" else -1.0
                sign_s = 1.0 if side_s == "SELL" else -1.0
                leg_b = sign_b * q_match * p_b * 100.0 - c_b_alloc
                leg_s = sign_s * q_match * p_s * 100.0 - c_s_alloc
                pair_net = leg_b + leg_s
                period_totals[period_key]["net_pnl"] += pair_net
                period_totals[period_key]["commission"] += c_b_alloc + c_s_alloc
                period_totals[period_key]["pnl"] += pair_net + c_b_alloc + c_s_alloc
                period_totals[period_key]["trade_count"] += 1
                period_totals[period_key]["pairs"].append({
                    "symbol": sym,
                    "expiry": exp,
                    "strike": strike_str,
                    "account_id": acc,
                    "right_c": "BUY",
                    "right_p": "SELL",
                    "quantity": round(q_match, 4),
                    "c_side": side_b,
                    "c_price": round(p_b, 4),
                    "p_side": side_s,
                    "p_price": round(p_s, 4),
                    "commission": round(c_b_alloc + c_s_alloc, 2),
                    "net_pnl": round(pair_net, 2),
                })
                if pair_net > 0:
                    period_totals[period_key]["win_count"] += 1
                elif pair_net < 0:
                    period_totals[period_key]["loss_count"] += 1

                if q_match >= q_b:
                    i_b += 1
                    if q_match >= q_s:
                        i_s += 1
                    else:
                        sell_list[i_s] = (q_s - q_match, p_s, c_s * (1 - q_match / q_s) if q_s else 0, side_s)
                else:
                    buy_list[i_b] = (q_b - q_match, p_b, c_b * (1 - q_match / q_b) if q_b else 0, side_b)
                    i_s += 1

        out = []
        for (start_ts, label), v in sorted(period_totals.items(), key=lambda x: x[0][0]):
            wc, lc = v.get("win_count", 0), v.get("loss_count", 0)
            v["win_rate"] = (wc / (wc + lc)) if (wc + lc) > 0 else None
            v["pnl"] = round(v["pnl"], 2)
            v["commission"] = round(v["commission"], 2)
            v["net_pnl"] = round(v["net_pnl"], 2)
            out.append(v)
        return out

    def get_performance_stats(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        granularity: str = "day",
    ) -> Dict[str, Any]:
        """Return performance summary and calendar PnL. Phase 0-8 per performance-execution-plan."""
        current_equity: Optional[float] = self._get_current_equity()
        net_cash_flow = 0.0
        start_equity: Optional[float] = current_equity
        capital_base: Optional[float] = (start_equity + 0.5 * net_cash_flow) if start_equity is not None else None
        if capital_base is not None and capital_base <= 0:
            capital_base = None

        executions = self.get_executions(since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=5000)
        executions_sorted = sorted([e for e in executions if e.get("time") is not None], key=lambda e: float(e["time"]))

        total_realized_pnl = 0.0
        total_commission = 0.0
        net_pnl = 0.0
        trade_count = 0
        wins: List[float] = []
        losses: List[float] = []
        cumulative_curve: List[Dict[str, Any]] = []
        running_net = 0.0
        for e in executions_sorted:
            rp_val = float(e["realized_pnl"]) if e.get("realized_pnl") is not None and isinstance(e.get("realized_pnl"), (int, float)) else 0.0
            comm_val = float(e["commission"]) if e.get("commission") is not None and isinstance(e.get("commission"), (int, float)) else 0.0
            if not math.isfinite(rp_val):
                rp_val = 0.0
            if not math.isfinite(comm_val):
                comm_val = 0.0
            net = rp_val - comm_val
            total_realized_pnl += rp_val
            total_commission += comm_val
            net_pnl += net
            trade_count += 1
            if rp_val > 0:
                wins.append(rp_val)
            elif rp_val < 0:
                losses.append(rp_val)
            running_net += net
            t = e.get("time")
            if t is not None:
                cumulative_curve.append({"ts": float(t), "cumulative_net_pnl": round(running_net, 2)})

        win_count = len(wins)
        loss_count = len(losses)
        sum_wins = sum(wins)
        sum_losses_abs = abs(sum(losses)) if losses else 0.0
        win_rate = (win_count / trade_count) if trade_count else None
        profit_factor = (sum_wins / sum_losses_abs) if sum_losses_abs > 0 else (None if not sum_wins else float("inf"))
        avg_win = (sum_wins / win_count) if win_count else None
        avg_loss = (sum(losses) / loss_count) if loss_count else None
        max_win = max(wins) if wins else None
        max_loss = min(losses) if losses else None
        peak, max_dd = 0.0, 0.0
        for pt in cumulative_curve:
            v = pt.get("cumulative_net_pnl") or 0.0
            peak = max(peak, v)
            max_dd = max(max_dd, peak - v)
        max_drawdown = max_dd if max_dd > 0 else None

        by_acc: Dict[str, Dict[str, Any]] = {}
        for e in executions_sorted:
            acc = e.get("account_id") or ""
            if acc not in by_acc:
                by_acc[acc] = {"total_pnl": 0.0, "commission": 0.0, "net_pnl": 0.0, "trade_count": 0}
            rp_val = float(e["realized_pnl"]) if e.get("realized_pnl") is not None else 0.0
            comm_val = float(e["commission"]) if e.get("commission") is not None else 0.0
            if not math.isfinite(rp_val):
                rp_val = 0.0
            if not math.isfinite(comm_val):
                comm_val = 0.0
            by_acc[acc]["total_pnl"] += rp_val
            by_acc[acc]["commission"] += comm_val
            by_acc[acc]["net_pnl"] += rp_val - comm_val
            by_acc[acc]["trade_count"] += 1
        realized_by_account = [{"account_id": acc, "total_pnl": round(v["total_pnl"], 2), "commission": round(v["commission"], 2), "net_pnl": round(v["net_pnl"], 2), "trade_count": v["trade_count"]} for acc, v in sorted(by_acc.items())]
        if capital_base and capital_base > 0:
            for row in realized_by_account:
                row["return_pct"] = round(100.0 * row["net_pnl"] / capital_base, 4)

        by_sec: Dict[str, Dict[str, Any]] = {}
        for e in executions_sorted:
            st = (e.get("sec_type") or "UNKNOWN").strip().upper() or "UNKNOWN"
            if st not in by_sec:
                by_sec[st] = {"total_pnl": 0.0, "commission": 0.0, "net_pnl": 0.0, "trade_count": 0}
            rp_val = float(e["realized_pnl"]) if e.get("realized_pnl") is not None else 0.0
            comm_val = float(e["commission"]) if e.get("commission") is not None else 0.0
            if not math.isfinite(rp_val):
                rp_val = 0.0
            if not math.isfinite(comm_val):
                comm_val = 0.0
            by_sec[st]["total_pnl"] += rp_val
            by_sec[st]["commission"] += comm_val
            by_sec[st]["net_pnl"] += rp_val - comm_val
            by_sec[st]["trade_count"] += 1
        realized_by_sec_type = [{"sec_type": st, "total_pnl": round(v["total_pnl"], 2), "commission": round(v["commission"], 2), "net_pnl": round(v["net_pnl"], 2), "trade_count": v["trade_count"]} for st, v in sorted(by_sec.items())]
        if capital_base and capital_base > 0:
            for row in realized_by_sec_type:
                row["return_pct"] = round(100.0 * row["net_pnl"] / capital_base, 4)

        by_acc_sec: Dict[Tuple[str, str], Dict[str, Any]] = {}
        for e in executions_sorted:
            acc, st = e.get("account_id") or "", (e.get("sec_type") or "UNKNOWN").strip().upper() or "UNKNOWN"
            key = (acc, st)
            if key not in by_acc_sec:
                by_acc_sec[key] = {"total_pnl": 0.0, "commission": 0.0, "net_pnl": 0.0, "trade_count": 0}
            rp_val = float(e["realized_pnl"]) if e.get("realized_pnl") is not None else 0.0
            comm_val = float(e["commission"]) if e.get("commission") is not None else 0.0
            if not math.isfinite(rp_val):
                rp_val = 0.0
            if not math.isfinite(comm_val):
                comm_val = 0.0
            by_acc_sec[key]["total_pnl"] += rp_val
            by_acc_sec[key]["commission"] += comm_val
            by_acc_sec[key]["net_pnl"] += rp_val - comm_val
            by_acc_sec[key]["trade_count"] += 1
        realized_by_account_and_sec_type = [{"account_id": k[0], "sec_type": k[1], "total_pnl": round(v["total_pnl"], 2), "commission": round(v["commission"], 2), "net_pnl": round(v["net_pnl"], 2), "trade_count": v["trade_count"]} for k, v in sorted(by_acc_sec.items())]
        if capital_base and capital_base > 0:
            for row in realized_by_account_and_sec_type:
                row["return_pct"] = round(100.0 * row["net_pnl"] / capital_base, 4)

        def _period_key(ts: float, gran: str) -> Tuple[float, str]:
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
            d = dt.date()
            if gran == "month":
                start = date(d.year, d.month, 1)
                label = start.strftime("%Y-%m")
                start_ts = datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp()
            elif gran == "week":
                start = d - timedelta(days=d.weekday())
                label = start.strftime("%Y-%m-%d")
                start_ts = datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp()
            else:
                start = d
                label = start.strftime("%Y-%m-%d")
                start_ts = datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp()
            return (start_ts, label)

        cal_map: Dict[Tuple[float, str], Dict[str, Any]] = {}
        for e in executions_sorted:
            t = e.get("time")
            if t is None:
                continue
            ts = float(t)
            start_ts, label = _period_key(ts, granularity)
            key = (start_ts, label)
            if key not in cal_map:
                cal_map[key] = {"period_start_ts": start_ts, "period_label": label, "pnl": 0.0, "commission": 0.0, "net_pnl": 0.0, "trade_count": 0, "win_count": 0, "loss_count": 0}
            rp_val = float(e["realized_pnl"]) if e.get("realized_pnl") is not None else 0.0
            comm_val = float(e["commission"]) if e.get("commission") is not None else 0.0
            if not math.isfinite(rp_val):
                rp_val = 0.0
            if not math.isfinite(comm_val):
                comm_val = 0.0
            cal_map[key]["pnl"] += rp_val
            cal_map[key]["commission"] += comm_val
            cal_map[key]["net_pnl"] += rp_val - comm_val
            cal_map[key]["trade_count"] += 1
            if rp_val > 0:
                cal_map[key]["win_count"] += 1
            elif rp_val < 0:
                cal_map[key]["loss_count"] += 1
        calendar = []
        for _, v in sorted(cal_map.items(), key=lambda x: x[0][0]):
            wc, lc = v.get("win_count", 0), v.get("loss_count", 0)
            v["win_rate"] = (wc / (wc + lc)) if (wc + lc) > 0 else None
            calendar.append(v)
        if capital_base and capital_base > 0:
            for row in calendar:
                row["return_pct"] = round(100.0 * row["net_pnl"] / capital_base, 4)

        # Calendar by sec_type (for Option/Stock calendar view)
        # OPT: use paired logic (same symbol/expiry/strike/right, BUY+SELL); others: sum(realized_pnl - commission)
        opt_calendar = self._compute_opt_realized_calendar(executions_sorted, granularity)
        cal_map_by_sec: Dict[Tuple[float, str, str], Dict[str, Any]] = {}
        for e in executions_sorted:
            st = (e.get("sec_type") or "UNKNOWN").strip().upper() or "UNKNOWN"
            if st == "OPT":
                continue
            t = e.get("time")
            if t is None:
                continue
            ts = float(t)
            start_ts, label = _period_key(ts, granularity)
            key = (start_ts, label, st)
            if key not in cal_map_by_sec:
                cal_map_by_sec[key] = {"period_start_ts": start_ts, "period_label": label, "sec_type": st, "pnl": 0.0, "commission": 0.0, "net_pnl": 0.0, "trade_count": 0, "win_count": 0, "loss_count": 0}
            rp_val = float(e["realized_pnl"]) if e.get("realized_pnl") is not None else 0.0
            comm_val = float(e["commission"]) if e.get("commission") is not None else 0.0
            if not math.isfinite(rp_val):
                rp_val = 0.0
            if not math.isfinite(comm_val):
                comm_val = 0.0
            cal_map_by_sec[key]["pnl"] += rp_val
            cal_map_by_sec[key]["commission"] += comm_val
            cal_map_by_sec[key]["net_pnl"] += rp_val - comm_val
            cal_map_by_sec[key]["trade_count"] += 1
            if rp_val > 0:
                cal_map_by_sec[key]["win_count"] += 1
            elif rp_val < 0:
                cal_map_by_sec[key]["loss_count"] += 1
        calendar_by_sec_type = list(opt_calendar)
        for k, v in sorted(cal_map_by_sec.items(), key=lambda x: (x[0][0], x[0][2])):
            wc, lc = v.get("win_count", 0), v.get("loss_count", 0)
            v["win_rate"] = (wc / (wc + lc)) if (wc + lc) > 0 else None
            calendar_by_sec_type.append(v)
        calendar_by_sec_type.sort(key=lambda x: (x["period_start_ts"], x["sec_type"]))
        if capital_base and capital_base > 0:
            for row in calendar_by_sec_type:
                row["return_pct"] = round(100.0 * row["net_pnl"] / capital_base, 4)

        accounts_list = self.get_accounts_from_tables() or []
        total_unrealized = 0.0
        unrel_by_acc: Dict[str, float] = {}
        unrel_by_sec: Dict[str, float] = {}
        for acc_obj in accounts_list:
            acc_id = acc_obj.get("account_id") or ""
            for pos in acc_obj.get("positions") or []:
                up = pos.get("unrealized_pnl")
                if up is not None and isinstance(up, (int, float)) and math.isfinite(up):
                    total_unrealized += up
                    unrel_by_acc[acc_id] = unrel_by_acc.get(acc_id, 0.0) + up
                    st = (pos.get("secType") or pos.get("sec_type") or "UNKNOWN").strip().upper() or "UNKNOWN"
                    unrel_by_sec[st] = unrel_by_sec.get(st, 0.0) + up
        unrealized = {"total_pnl": round(total_unrealized, 2), "return_pct": round(100.0 * total_unrealized / current_equity, 4) if current_equity and current_equity > 0 else None, "current_equity": round(current_equity, 2) if current_equity is not None else None}
        unrealized_by_account = [{"account_id": acc, "total_pnl": round(v, 2)} for acc, v in sorted(unrel_by_acc.items())]
        unrealized_by_sec_type = [{"sec_type": st, "total_pnl": round(v, 2)} for st, v in sorted(unrel_by_sec.items())]
        unrel_by_acc_sec: Dict[Tuple[str, str], float] = {}
        for acc_obj in accounts_list:
            acc_id = acc_obj.get("account_id") or ""
            for pos in acc_obj.get("positions") or []:
                up = pos.get("unrealized_pnl")
                if up is not None and isinstance(up, (int, float)) and math.isfinite(up):
                    st = (pos.get("secType") or pos.get("sec_type") or "UNKNOWN").strip().upper() or "UNKNOWN"
                    key = (acc_id, st)
                    unrel_by_acc_sec[key] = unrel_by_acc_sec.get(key, 0.0) + up
        unrealized_by_account_and_sec_type = [{"account_id": k[0], "sec_type": k[1], "total_pnl": round(v, 2)} for k, v in sorted(unrel_by_acc_sec.items())]

        total_pnl = net_pnl + total_unrealized
        return_pct = round(100.0 * total_pnl / capital_base, 4) if capital_base and capital_base > 0 else None

        return {
            "transaction": {"net_cash_flow": net_cash_flow, "start_equity": round(start_equity, 2) if start_equity is not None else None, "capital_base": round(capital_base, 2) if capital_base is not None else None},
            "summary": {
                "total_pnl": round(total_pnl, 2),
                "total_realized_pnl": round(total_realized_pnl, 2),
                "total_commission": round(total_commission, 2),
                "net_pnl": round(net_pnl, 2),
                "trade_count": trade_count,
                "win_count": win_count,
                "loss_count": loss_count,
                "win_rate": round(win_rate, 4) if win_rate is not None else None,
                "profit_factor": round(profit_factor, 4) if profit_factor is not None and math.isfinite(profit_factor) else profit_factor,
                "avg_win": round(avg_win, 2) if avg_win is not None else None,
                "avg_loss": round(avg_loss, 2) if avg_loss is not None else None,
                "max_win": round(max_win, 2) if max_win is not None else None,
                "max_loss": round(max_loss, 2) if max_loss is not None else None,
                "max_drawdown": round(max_drawdown, 2) if max_drawdown is not None else None,
                "return_pct": return_pct,
                "total_unrealized_pnl": round(total_unrealized, 2),
            },
            "realized_by_account": realized_by_account,
            "realized_by_sec_type": realized_by_sec_type,
            "realized_by_account_and_sec_type": realized_by_account_and_sec_type,
            "calendar": calendar,
            "calendar_by_sec_type": calendar_by_sec_type,
            "cumulative_curve": cumulative_curve,
            "unrealized": unrealized,
            "unrealized_by_account": unrealized_by_account,
            "unrealized_by_sec_type": unrealized_by_sec_type,
            "unrealized_by_account_and_sec_type": unrealized_by_account_and_sec_type,
        }

    def get_bars(
        self,
        symbol: Optional[str] = None,
        period: str = "1 D",
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        """Return rows from stock_day (1 D) or stock_min (1 min, 5 mins, 1 hour). Newest first. bar_time as Unix time for API."""
        if not self._connect():
            return []
        if not symbol or not symbol.strip():
            return []
        per = (period or "1 D").strip()
        table = "stock_day" if per.upper() == "1 D" else "stock_min"
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                if table == "stock_day":
                    cur.execute(
                        """
                        SELECT symbol, '1 D' AS period, extract(epoch from bar_time) AS time,
                               open, high, low, close, volume
                        FROM stock_day
                        WHERE symbol = %s
                        ORDER BY bar_time DESC NULLS LAST
                        LIMIT %s
                        """,
                        (symbol.strip(), limit),
                    )
                else:
                    cur.execute(
                        """
                        SELECT symbol, period, extract(epoch from bar_time) AS time,
                               open, high, low, close, volume
                        FROM stock_min
                        WHERE symbol = %s AND period = %s
                        ORDER BY bar_time DESC NULLS LAST
                        LIMIT %s
                        """,
                        (symbol.strip(), per, limit),
                    )
                rows = cur.fetchall()
            return [dict(r) for r in rows]
        except Exception as e:
            logger.debug("get_bars failed: %s", e)
            self._conn = None
            return []

    def get_bars_latest(
        self,
        symbol: Optional[str] = None,
        period: str = "1 D",
    ) -> Optional[float]:
        """Return Unix time of the latest bar for symbol+period (from stock_day or stock_min), or None if no data. For smart duration: request more history when latest is old."""
        if not self._connect():
            return None
        if not symbol or not symbol.strip():
            return None
        per = (period or "1 D").strip()
        table = "stock_day" if per.upper() == "1 D" else "stock_min"
        try:
            with self._conn.cursor() as cur:
                if table == "stock_day":
                    cur.execute(
                        "SELECT extract(epoch from bar_time) AS t FROM stock_day WHERE symbol = %s ORDER BY bar_time DESC LIMIT 1",
                        (symbol.strip(),),
                    )
                else:
                    cur.execute(
                        "SELECT extract(epoch from bar_time) AS t FROM stock_min WHERE symbol = %s AND period = %s ORDER BY bar_time DESC LIMIT 1",
                        (symbol.strip(), per),
                    )
                row = cur.fetchone()
            return float(row[0]) if row and row[0] is not None else None
        except Exception as e:
            logger.debug("get_bars_latest failed: %s", e)
            self._conn = None
            return None

    def get_bar_times_in_range(
        self,
        symbol: Optional[str] = None,
        period: str = "1 D",
        start_ts: Optional[float] = None,
        end_ts: Optional[float] = None,
    ) -> List[float]:
        """Return bar timestamps within [start_ts, end_ts] ordered ascending."""
        if not self._connect():
            return []
        if not symbol or not symbol.strip():
            return []
        if start_ts is None or end_ts is None:
            return []
        sym = symbol.strip()
        per = (period or "1 D").strip()
        table = "stock_day" if per.upper() == "1 D" else "stock_min"
        try:
            with self._conn.cursor() as cur:
                if table == "stock_day":
                    cur.execute(
                        """
                        SELECT extract(epoch from bar_time) AS t
                        FROM stock_day
                        WHERE symbol = %s
                          AND bar_time >= to_timestamp(%s)
                          AND bar_time <= to_timestamp(%s)
                        ORDER BY bar_time ASC
                        """,
                        (sym, float(start_ts), float(end_ts)),
                    )
                else:
                    cur.execute(
                        """
                        SELECT extract(epoch from bar_time) AS t
                        FROM stock_min
                        WHERE symbol = %s
                          AND period = %s
                          AND bar_time >= to_timestamp(%s)
                          AND bar_time <= to_timestamp(%s)
                        ORDER BY bar_time ASC
                        """,
                        (sym, per, float(start_ts), float(end_ts)),
                    )
                rows = cur.fetchall()
            return [float(row[0]) for row in rows if row and row[0] is not None]
        except Exception as e:
            logger.debug("get_bar_times_in_range failed: %s", e)
            self._conn = None
            return []

    def get_bars_benchmark(
        self,
        symbols: Optional[List[str]] = None,
        on_or_before: Optional[date] = None,
    ) -> Dict[str, Dict[str, Any]]:
        """Return latest daily bar on or before given date per symbol from stock_day.
        Keys: symbol -> { bar_time: unix_ts, close: float, prev_close: float or None }.
        prev_close is the close of the trading day immediately before the latest returned bar.
        Symbols with no row are omitted.
        """
        if not self._connect():
            return {}
        sym_list = list({(s or "").strip() for s in (symbols or []) if (s or "").strip()})
        if not sym_list:
            return {}
        ref = on_or_before if on_or_before is not None else date.today()
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    WITH ordered AS (
                        SELECT symbol, bar_time, close,
                               LEAD(close) OVER (PARTITION BY symbol ORDER BY bar_time DESC) AS prev_close
                        FROM stock_day
                        WHERE symbol = ANY(%s) AND (bar_time::date) <= %s
                    )
                    SELECT DISTINCT ON (symbol) symbol,
                           extract(epoch from bar_time) AS bar_time,
                           close,
                           prev_close
                    FROM ordered
                    ORDER BY symbol, bar_time DESC
                    """,
                    (sym_list, ref),
                )
                rows = cur.fetchall()
            return {
                (r["symbol"] or "").strip(): {
                    "bar_time": float(r["bar_time"]) if r.get("bar_time") is not None else 0,
                    "close": float(r["close"]) if r.get("close") is not None else 0,
                    "prev_close": float(r["prev_close"]) if r.get("prev_close") is not None and r["prev_close"] is not None else None,
                }
                for r in rows
                if (r.get("symbol") or "").strip()
            }
        except Exception as e:
            logger.debug("get_bars_benchmark failed: %s", e)
            self._conn = None
            return {}

    def get_bars_stats(
        self,
        symbol: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Return row counts for the given symbol in stock_day and stock_min (per period). Used by 分析 button."""
        if not self._connect():
            return {"stock_day": 0, "stock_min": {}}
        if not symbol or not symbol.strip():
            return {"stock_day": 0, "stock_min": {}}
        sym = symbol.strip()
        out: Dict[str, Any] = {"stock_day": 0, "stock_min": {}}
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    "SELECT COUNT(*) FROM stock_day WHERE symbol = %s",
                    (sym,),
                )
                row = cur.fetchone()
                out["stock_day"] = int(row[0]) if row and row[0] is not None else 0
                for per in ("1 min", "5 mins", "1 hour"):
                    cur.execute(
                        "SELECT COUNT(*) FROM stock_min WHERE symbol = %s AND period = %s",
                        (sym, per),
                    )
                    r = cur.fetchone()
                    out["stock_min"][per] = int(r[0]) if r and r[0] is not None else 0
            return out
        except Exception as e:
            logger.debug("get_bars_stats failed: %s", e)
            self._conn = None
            return {"stock_day": 0, "stock_min": {}}

    def get_bars_coverage(
        self,
        symbols: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Return per-symbol coverage (count, min_ts, max_ts) for stock_day and stock_min.
        symbols: if None or empty, returns empty list. Each symbol is stripped; duplicates removed.
        """
        if not self._connect():
            return []
        sym_list = list({s.strip() for s in (symbols or []) if s and str(s).strip()})
        if not sym_list:
            return []
        out: List[Dict[str, Any]] = []
        try:
            with self._conn.cursor() as cur:
                # stock_day: per symbol count, min_ts, max_ts
                cur.execute(
                    """
                    SELECT symbol,
                           COUNT(*) AS cnt,
                           extract(epoch from MIN(bar_time)) AS min_ts,
                           extract(epoch from MAX(bar_time)) AS max_ts
                    FROM stock_day
                    WHERE symbol = ANY(%s)
                    GROUP BY symbol
                    """,
                    (sym_list,),
                )
                day_rows = {row[0]: {"count": int(row[1]), "min_ts": float(row[2]) if row[2] is not None else None, "max_ts": float(row[3]) if row[3] is not None else None} for row in cur.fetchall()}

                # stock_min: per symbol, per period
                cur.execute(
                    """
                    SELECT symbol, period,
                           COUNT(*) AS cnt,
                           extract(epoch from MIN(bar_time)) AS min_ts,
                           extract(epoch from MAX(bar_time)) AS max_ts
                    FROM stock_min
                    WHERE symbol = ANY(%s) AND period IN ('1 min', '5 mins', '1 hour')
                    GROUP BY symbol, period
                    """,
                    (sym_list,),
                )
                min_rows: Dict[str, Dict[str, Dict[str, Any]]] = {}
                for row in cur.fetchall():
                    sym, per, cnt, min_ts, max_ts = row[0], row[1], int(row[2]), row[3], row[4]
                    if sym not in min_rows:
                        min_rows[sym] = {}
                    min_rows[sym][per] = {
                        "count": cnt,
                        "min_ts": float(min_ts) if min_ts is not None else None,
                        "max_ts": float(max_ts) if max_ts is not None else None,
                    }

                for sym in sym_list:
                    day = day_rows.get(sym, {"count": 0, "min_ts": None, "max_ts": None})
                    mins = min_rows.get(sym, {})
                    out.append({
                        "symbol": sym,
                        "stock_day": day,
                        "stock_min": {
                            "1 min": mins.get("1 min", {"count": 0, "min_ts": None, "max_ts": None}),
                            "5 mins": mins.get("5 mins", {"count": 0, "min_ts": None, "max_ts": None}),
                            "1 hour": mins.get("1 hour", {"count": 0, "min_ts": None, "max_ts": None}),
                        },
                    })
            return out
        except Exception as e:
            logger.debug("get_bars_coverage failed: %s", e)
            self._conn = None
            return []

    def get_watchlist(self) -> List[Dict[str, Any]]:
        """Return all watchlist rows (contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source, created_at)."""
        if not self._connect():
            return []
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT id, contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source,
                           extract(epoch from created_at) AS created_at
                    FROM watchlist ORDER BY created_at DESC
                    """
                )
                return [dict(r) for r in cur.fetchall()]
        except Exception as e:
            logger.debug("get_watchlist failed: %s", e)
            self._conn = None
            return []

    def add_watchlist(
        self,
        contract_key: str,
        symbol: Optional[str] = None,
        sec_type: Optional[str] = None,
        expiry: Optional[str] = None,
        strike: Optional[float] = None,
        option_right: Optional[str] = None,
        display_label: Optional[str] = None,
        source: str = "manual",
    ) -> bool:
        """Insert or replace watchlist row by contract_key. Returns True on success.
        If contract_key contains no '|', treat as stock symbol and normalize to SYMBOL|STK|||."""
        raw = (contract_key or "").strip()
        if not raw:
            return False
        if "|" not in raw:
            contract_key = f"{raw}|STK|||"
            if symbol is None:
                symbol = raw
            if sec_type is None or sec_type == "":
                sec_type = "STK"
        else:
            contract_key = raw
        if not self._connect():
            logger.warning("add_watchlist: DB connect failed")
            return False
        try:
            with self._conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO watchlist (contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (contract_key) DO UPDATE SET
                        symbol = EXCLUDED.symbol, sec_type = EXCLUDED.sec_type, expiry = EXCLUDED.expiry,
                        strike = EXCLUDED.strike, option_right = EXCLUDED.option_right,
                        display_label = EXCLUDED.display_label, source = EXCLUDED.source
                    """,
                    (contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source),
                )
            self._conn.commit()
            return True
        except Exception as e:
            logger.warning("add_watchlist failed: %s", e)
            self._conn = None
            return False

    def delete_watchlist(self, contract_key: Optional[str] = None, id_: Optional[int] = None) -> bool:
        """Delete one watchlist entry by contract_key or id. Returns True on success."""
        if not self._connect():
            return False
        try:
            with self._conn.cursor() as cur:
                if id_ is not None:
                    cur.execute("DELETE FROM watchlist WHERE id = %s", (id_,))
                elif contract_key and contract_key.strip():
                    cur.execute("DELETE FROM watchlist WHERE contract_key = %s", (contract_key.strip(),))
                else:
                    return False
            self._conn.commit()
            return True
        except Exception as e:
            logger.debug("delete_watchlist failed: %s", e)
            self._conn = None
            return False

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
                            ap.updated_at AS position_updated_at,
                            (SELECT e.exec_time
                             FROM account_executions e
                             WHERE e.account_id = ap.account_id AND e.contract_key = ap.contract_key
                             ORDER BY e.exec_time DESC NULLS LAST
                             LIMIT 1) AS position_exec_time,
                            ap.expiry,
                            ap.strike,
                            ap.option_right,
                            ap.contract_key,
                            ip.mid AS price_mid,
                            ip.last AS price_last,
                            ip.updated_at AS price_updated_at
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
                            "contract_key": p.get("contract_key"),
                        }
                        if p.get("expiry") is not None:
                            pos_dict["lastTradeDateOrContractMonth"] = p.get("expiry")
                        if p.get("strike") is not None:
                            pos_dict["strike"] = p.get("strike")
                        if p.get("option_right") is not None:
                            pos_dict["right"] = p.get("option_right")

                        # 持仓行最后更新时间 → updated_at (Unix sec)；Details TIME 优先用 account_executions 最新一条 exec_time
                        raw_pos_updated = p.get("position_updated_at")
                        if raw_pos_updated is not None:
                            try:
                                if hasattr(raw_pos_updated, "timestamp"):
                                    pos_dict["updated_at"] = raw_pos_updated.timestamp()
                                elif isinstance(raw_pos_updated, (int, float)) and math.isfinite(float(raw_pos_updated)):
                                    pos_dict["updated_at"] = float(raw_pos_updated)
                            except (TypeError, ValueError):
                                pass
                        raw_exec_time = p.get("position_exec_time")
                        if raw_exec_time is not None:
                            try:
                                if hasattr(raw_exec_time, "timestamp"):
                                    t = raw_exec_time.timestamp()
                                elif isinstance(raw_exec_time, (int, float)) and math.isfinite(float(raw_exec_time)):
                                    t = float(raw_exec_time)
                                else:
                                    t = None
                                if t is not None and math.isfinite(t):
                                    pos_dict["exec_time"] = t
                            except (TypeError, ValueError):
                                pass

                        # 价格优先使用 instrument_prices.mid，其次 last；仅过滤 NaN/Inf
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

                        # instrument_prices.updated_at → price_updated_at (Unix sec) for Since 显示（兼容列名大小写）
                        raw_updated = next(
                            (p[k] for k in p if k and k.lower() == "price_updated_at"),
                            p.get("price_updated_at"),
                        )
                        if raw_updated is not None:
                            try:
                                if hasattr(raw_updated, "timestamp"):
                                    pos_dict["price_updated_at"] = raw_updated.timestamp()
                                elif isinstance(raw_updated, (int, float)) and math.isfinite(float(raw_updated)):
                                    pos_dict["price_updated_at"] = float(raw_updated)
                                elif isinstance(raw_updated, str) and raw_updated.strip():
                                    s = raw_updated.strip()
                                    # PostgreSQL 文本格式可能为 "2026-03-04 19:44:43.373 -0600"（空格+±HHMM），fromisoformat 不认
                                    parts = s.rsplit(" ", 1)
                                    if len(parts) == 2 and len(parts[1]) == 5 and parts[1][0] in "+-" and parts[1][1:].isdigit():
                                        dt_naive = datetime.strptime(parts[0], "%Y-%m-%d %H:%M:%S.%f")
                                        sign = -1 if parts[1][0] == "-" else 1
                                        hours = sign * int(parts[1][1:3])
                                        mins = sign * int(parts[1][3:5])
                                        dt = dt_naive.replace(tzinfo=timezone(timedelta(hours=hours, minutes=mins)))
                                        pos_dict["price_updated_at"] = dt.timestamp()
                                    else:
                                        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
                                        pos_dict["price_updated_at"] = dt.timestamp()
                            except (TypeError, ValueError, OSError):
                                pass

                        # 持仓盈亏：用 instrument_prices.last（无则 mid）与 position/avg_cost 计算
                        price_for_pnl: Optional[float] = None
                        for candidate in (raw_last, raw_mid):
                            if candidate is None:
                                continue
                            try:
                                v = float(candidate)
                            except (TypeError, ValueError):
                                continue
                            if not math.isfinite(v):
                                continue
                            price_for_pnl = v
                            break
                        pos_qty = p.get("position")
                        pos_avg = p.get("avg_cost")
                        sec_type = (p.get("sec_type") or "").strip().upper()
                        if (
                            price_for_pnl is not None
                            and pos_qty is not None
                            and pos_avg is not None
                        ):
                            try:
                                q = float(pos_qty)
                                c = float(pos_avg)
                                if math.isfinite(q) and math.isfinite(c):
                                    # 期权 OPT：权利金为每股，持仓为合约数，盈亏 = (现价 - 成本) * 合约数 * 100
                                    if sec_type == "OPT":
                                        pos_dict["unrealized_pnl"] = round(
                                            (price_for_pnl - c) * q * 100, 2
                                        )
                                    else:
                                        pos_dict["unrealized_pnl"] = round(
                                            (price_for_pnl - c) * q, 2
                                        )
                            except (TypeError, ValueError):
                                pass

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
        """Return settings row id=1: ib_host, ib_port_type, ib_client_id_daemon, ib_client_id_listener, ib_client_id_account, ib_client_id_markets, ib_client_id_worker_market (for GET /status and UI). None if table missing."""
        if not self._connect():
            return None
        try:
            with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    "SELECT ib_host, ib_port_type, "
                    "COALESCE(ib_client_id_daemon, 1) AS ib_client_id_daemon, "
                    "COALESCE(ib_client_id_listener, 2) AS ib_client_id_listener, "
                    "COALESCE(ib_client_id_account, 100) AS ib_client_id_account, "
                    "COALESCE(ib_client_id_markets, 101) AS ib_client_id_markets, "
                    "COALESCE(ib_client_id_worker_market, 500) AS ib_client_id_worker_market "
                    "FROM settings WHERE id = 1"
                )
                row = cur.fetchone()
            if row is None:
                return None
            return {
                "ib_host": (row.get("ib_host") or "127.0.0.1").strip(),
                "ib_port_type": (row.get("ib_port_type") or "tws_paper").strip().lower(),
                "ib_client_id_daemon": int(row["ib_client_id_daemon"]) if row.get("ib_client_id_daemon") is not None else 1,
                "ib_client_id_listener": int(row["ib_client_id_listener"]) if row.get("ib_client_id_listener") is not None else 2,
                "ib_client_id_account": int(row["ib_client_id_account"]) if row.get("ib_client_id_account") is not None else 4,
                "ib_client_id_markets": int(row["ib_client_id_markets"]) if row.get("ib_client_id_markets") is not None else 10,
                "ib_client_id_worker_market": int(row["ib_client_id_worker_market"]) if row.get("ib_client_id_worker_market") is not None else 500,
            }
        except Exception as e:
            # 旧库可能尚无 client_id 列，仅查 host/port_type
            try:
                with self._conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("SELECT ib_host, ib_port_type FROM settings WHERE id = 1")
                    row = cur.fetchone()
                if row is None:
                    return None
                return {
                    "ib_host": (row.get("ib_host") or "127.0.0.1").strip(),
                    "ib_port_type": (row.get("ib_port_type") or "tws_paper").strip().lower(),
                    "ib_client_id_daemon": 1,
                    "ib_client_id_listener": 2,
                    "ib_client_id_account": 100,
                    "ib_client_id_markets": 101,
                    "ib_client_id_worker_market": 500,
                }
            except Exception as e2:
                logger.debug("get_ib_config failed: %s", e2)
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


def sync_accounts_snapshot_to_db(
    status_config: dict, accounts_list: Optional[List[Dict[str, Any]]]
) -> bool:
    """将监控端拉取的 accounts_snapshot 写入 accounts + account_positions 表。返回 True 表示成功。"""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    if not accounts_list:
        return True
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("SET lock_timeout = '5s'")
            _sync_accounts_snapshot_to_tables(conn, accounts_list)
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("sync_accounts_snapshot_to_db failed: %s", e)
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
    """R-A3 扩展：写入股票 K 线到 stock_day（1 D）或 stock_min（1 min, 5 mins, 1 hour）。按 (symbol, bar_time) 或 (symbol, period, bar_time) UPSERT。Returns True on success."""
    if not rows or not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                for r in rows:
                    symbol = (r.get("symbol") or "").strip()
                    period = (r.get("period") or "1 D").strip()
                    bar_time = r.get("bar_time")
                    if bar_time is None or not symbol:
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
            conn.commit()
            logger.info("[R-A3] write_ohlc_bars_to_db: wrote %s rows to stock_day/stock_min", len(rows))
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_ohlc_bars_to_db failed: %s", e)
        return False


def write_stock_bars(status_config: dict, symbol: str, period: str, bars: List[Dict[str, Any]]) -> bool:
    """批量写入单一 symbol+period 的股票 K 线到 stock_day/stock_min。

    这是对 write_ohlc_bars_to_db 的薄封装，便于 backfill 脚本按 chunk 写入并复用 UPSERT 语义。
    bars 元素形状为 {bar_time, open, high, low, close, volume}。
    """
    if not bars:
        return True
    rows: List[Dict[str, Any]] = []
    per = (period or "1 D").strip()
    sym = (symbol or "").strip()
    if not sym:
        return False
    for b in bars:
        r = dict(b)
        r["symbol"] = sym
        r["period"] = per
        rows.append(r)
    return write_ohlc_bars_to_db(status_config, rows)


def delete_stock_bars_for_symbol(
    status_config: dict,
    symbol: str,
    periods: Optional[list[str]] = None,
) -> Dict[str, Any]:
    """Delete stock_day and/or stock_min rows for the given symbol.
    periods: optional list of "1 D" | "1 min" | "5 mins" | "1 hour". If None or empty, delete all.
    Returns {"ok": True, "deleted_day": n, "deleted_min": m} or {"ok": False, "error": "..."}.
    """
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return {"ok": False, "error": "No postgres config"}
    sym = (symbol or "").strip()
    if not sym:
        return {"ok": False, "error": "Symbol required"}
    # Normalize periods: None/[] = all; otherwise filter to valid values
    valid_periods = {"1 D", "1 min", "5 mins", "1 hour"}
    if periods:
        periods = [p.strip() for p in periods if (p or "").strip() in valid_periods]
    delete_day = not periods or "1 D" in periods
    min_periods = [p for p in ("1 min", "5 mins", "1 hour") if not periods or p in periods]
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                deleted_day = 0
                deleted_min = 0
                if delete_day:
                    cur.execute("DELETE FROM stock_day WHERE symbol = %s", (sym,))
                    deleted_day = cur.rowcount
                if min_periods:
                    cur.execute(
                        "DELETE FROM stock_min WHERE symbol = %s AND period = ANY(%s)",
                        (sym, min_periods),
                    )
                    deleted_min = cur.rowcount
            conn.commit()
            logger.info("delete_stock_bars_for_symbol %s periods=%s: deleted_day=%s deleted_min=%s", sym, periods, deleted_day, deleted_min)
            return {"ok": True, "deleted_day": deleted_day, "deleted_min": deleted_min}
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_stock_bars_for_symbol failed: %s", e)
        return {"ok": False, "error": str(e)}


def insert_bars_backfill_job(
    status_config: dict,
    symbol: str,
    period: str,
    years: Optional[float] = None,
    days: Optional[int] = None,
    override_days: Optional[float] = None,
    span_hours: Optional[float] = None,
    skip_ib: bool = False,
    api_interval_sec: int = 10,
) -> Optional[int]:
    """Insert a pending bars backfill job. Returns job id (id) or None on failure."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO bars_backfill_jobs (symbol, period, years, days, override_days, span_hours, skip_ib, api_interval_sec, status, created_at, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'pending', now(), now())
                    RETURNING id
                    """,
                    (
                        (symbol or "").strip(),
                        (period or "1 D").strip(),
                        years,
                        days,
                        override_days,
                        span_hours,
                        bool(skip_ib),
                        max(0, min(300, int(api_interval_sec))),
                    ),
                )
                row = cur.fetchone()
            conn.commit()
            return int(row[0]) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.warning("insert_bars_backfill_job failed: %s", e)
        return None


def get_bars_backfill_jobs(
    status_config: dict,
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], int]:
    """Return bars_backfill_jobs (newest first) with optional status filter and pagination. Returns (rows, total_count)."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return [], 0
    try:
        # Coerce to int in case callers pass query string values
        try:
            limit = max(1, min(500, int(limit))) if limit is not None else 50
        except (TypeError, ValueError):
            limit = 50
        try:
            offset = max(0, int(offset)) if offset is not None else 0
        except (TypeError, ValueError):
            offset = 0

        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                if status and status.strip():
                    st = status.strip().lower()
                    if st not in ("pending", "running", "done", "failed"):
                        st = None
                else:
                    st = None
                where = "WHERE status = %s" if st else ""
                args_count = [st] if st else []
                cur.execute(
                    f"""
                    SELECT COUNT(*) AS count FROM bars_backfill_jobs {where}
                    """,
                    args_count,
                )
                total = int(cur.fetchone()["count"])
                args_list = (args_count + [limit, offset]) if st else [limit, offset]
                cur.execute(
                    f"""
                    SELECT id, symbol, period, years, days, override_days, span_hours, skip_ib, api_interval_sec, status, result,
                           created_at, updated_at
                    FROM bars_backfill_jobs
                    {where}
                    ORDER BY id DESC
                    LIMIT %s OFFSET %s
                    """,
                    args_list,
                )
                rows = cur.fetchall()
            return [dict(r) for r in rows] if rows else [], total
        finally:
            conn.close()
    except Exception as e:
        logger.warning("get_bars_backfill_jobs failed: %s", e)
        raise


def delete_bars_backfill_job(status_config: dict, job_id: Any) -> bool:
    """Delete one bars_backfill_job by id. Returns True if deleted (or not found)."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        try:
            jid = int(job_id)
        except (TypeError, ValueError):
            return False
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM bars_backfill_jobs WHERE id = %s", (jid,))
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_bars_backfill_job failed: %s", e)
        return False


def delete_all_bars_backfill_jobs(status_config: dict, status_filter: Optional[str] = None) -> int:
    """Delete all bars_backfill_jobs, optionally only those with given status. Returns number deleted."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return 0
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                if status_filter and status_filter.strip().lower() in ("pending", "running", "done", "failed"):
                    cur.execute("DELETE FROM bars_backfill_jobs WHERE status = %s", (status_filter.strip().lower(),))
                else:
                    cur.execute("DELETE FROM bars_backfill_jobs")
                deleted = cur.rowcount
            conn.commit()
            return deleted
        finally:
            conn.close()
    except Exception as e:
        logger.warning("delete_all_bars_backfill_jobs failed: %s", e)
        return 0


def get_bars_backfill_job(status_config: dict, job_id: Any) -> Optional[Dict[str, Any]]:
    """Return one bars_backfill_job by id, or None."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    try:
        try:
            jid = int(job_id)
        except (TypeError, ValueError):
            return None
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT id, symbol, period, years, days, override_days, span_hours, skip_ib, api_interval_sec, status, result,
                           created_at, updated_at
                    FROM bars_backfill_jobs
                    WHERE id = %s
                    """,
                    (jid,),
                )
                row = cur.fetchone()
            return dict(row) if row else None
        finally:
            conn.close()
    except Exception as e:
        logger.warning("get_bars_backfill_job failed: %s", e)
        return None


def claim_next_pending_bars_backfill_job(status_config: dict) -> Optional[Dict[str, Any]]:
    """Select one pending job with FOR UPDATE SKIP LOCKED, set status=running, return job row. Returns None if no pending job."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute(
                    """
                    SELECT id, symbol, period, years, days, override_days
                    FROM bars_backfill_jobs
                    WHERE status = 'pending'
                    ORDER BY id ASC
                    LIMIT 1
                    FOR UPDATE SKIP LOCKED
                    """
                )
                row = cur.fetchone()
                if not row:
                    return None
                jid = row["id"]
                cur.execute(
                    """
                    UPDATE bars_backfill_jobs
                    SET status = 'running', updated_at = now()
                    WHERE id = %s
                    """,
                    (jid,),
                )
            conn.commit()
            return dict(row)
        finally:
            conn.close()
    except Exception as e:
        logger.warning("claim_next_pending_bars_backfill_job failed: %s", e)
        return None


def update_bars_backfill_job_result(
    status_config: dict,
    job_id: int,
    status: str,
    result: Optional[Dict[str, Any]] = None,
) -> bool:
    """Set job status and result (done/failed). Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    try:
        import json
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    UPDATE bars_backfill_jobs
                    SET status = %s, result = %s, updated_at = now()
                    WHERE id = %s
                    """,
                    (status, json.dumps(result) if result is not None else None, job_id),
                )
            conn.commit()
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("update_bars_backfill_job_result failed: %s", e)
        return False


def trim_bars_backfill_jobs(status_config: dict, keep: int = 200) -> None:
    """Keep only the most recent keep jobs; delete older ones."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    WITH kept AS (SELECT id FROM bars_backfill_jobs ORDER BY id DESC LIMIT %s)
                    DELETE FROM bars_backfill_jobs WHERE id NOT IN (SELECT id FROM kept)
                    """,
                    (max(1, keep),),
                )
            conn.commit()
        finally:
            conn.close()
    except Exception as e:
        logger.warning("trim_bars_backfill_jobs failed: %s", e)


def get_bars_backfill_last_updated(status_config: dict) -> Optional[float]:
    """Return max(updated_at) from bars_backfill_jobs as Unix timestamp, or None if no jobs or error.
    Used for Celery worker status: recent activity if last_updated within last few minutes."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return None
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT EXTRACT(EPOCH FROM max(updated_at))::double precision FROM bars_backfill_jobs"
                )
                row = cur.fetchone()
            return float(row[0]) if row and row[0] is not None else None
        finally:
            conn.close()
    except Exception as e:
        logger.debug("get_bars_backfill_last_updated failed: %s", e)
        return None


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


def write_ib_config(
    status_config: dict,
    ib_host: str,
    ib_port_type: str,
    ib_client_id_daemon: int = 1,
    ib_client_id_listener: int = 2,
    ib_client_id_account: int = 100,
    ib_client_id_markets: int = 101,
    ib_client_id_worker_market: int = 500,
) -> bool:
    """Update settings (id=1): ib_host, ib_port_type, 以及多种用途的 client_id（守护进程/监听进程/账户信息/市场数据/Celery worker_market）。守护进程/API 下次使用时会加载。Returns True on success."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
    host = (ib_host or "").strip() or "127.0.0.1"
    port_type = (ib_port_type or "").strip().lower() or "tws_paper"
    if port_type not in _VALID_IB_PORT_TYPES:
        port_type = "tws_paper"
    cid_d = max(1, int(ib_client_id_daemon)) if ib_client_id_daemon is not None else 1
    cid_l = max(1, int(ib_client_id_listener)) if ib_client_id_listener is not None else 2
    cid_a = max(1, int(ib_client_id_account)) if ib_client_id_account is not None else 100
    cid_m = max(1, int(ib_client_id_markets)) if ib_client_id_markets is not None else 101
    cid_w = max(1, int(ib_client_id_worker_market)) if ib_client_id_worker_market is not None else 500
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                # 确保 client_id 列存在
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
                    """
                    INSERT INTO settings (id, ib_host, ib_port_type, ib_client_id_daemon, ib_client_id_listener, ib_client_id_account, ib_client_id_markets, ib_client_id_worker_market)
                    VALUES (1, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                        ib_host = EXCLUDED.ib_host,
                        ib_port_type = EXCLUDED.ib_port_type,
                        ib_client_id_daemon = EXCLUDED.ib_client_id_daemon,
                        ib_client_id_listener = EXCLUDED.ib_client_id_listener,
                        ib_client_id_account = EXCLUDED.ib_client_id_account,
                        ib_client_id_markets = EXCLUDED.ib_client_id_markets,
                        ib_client_id_worker_market = EXCLUDED.ib_client_id_worker_market
                    """,
                    (host, port_type, cid_d, cid_l, cid_a, cid_m, cid_w),
                )
            conn.commit()
            logger.info(
                "[R-A3] write_ib_config: wrote settings id=1 host=%r port_type=%r ib_client_id_daemon=%s ib_client_id_listener=%s ib_client_id_account=%s ib_client_id_markets=%s ib_client_id_worker_market=%s",
                host,
                port_type,
                cid_d,
                cid_l,
                cid_a,
                cid_m,
                cid_w,
            )
            return True
        finally:
            conn.close()
    except Exception as e:
        logger.warning("write_ib_config failed: %s", e)
        return False
