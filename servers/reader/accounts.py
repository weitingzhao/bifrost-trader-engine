"""Accounts: snapshot, executions, transactions, position_categories.
All logic inlined from legacy; no dependency on _legacy."""

import json
import logging
import math
import uuid
from datetime import date, datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

import psycopg2
from psycopg2.extras import RealDictCursor

from src.sink.postgres_sink import _get_conn_params, _sync_accounts_snapshot_to_tables

from servers.reader import market as market_module

logger = logging.getLogger(__name__)

# Exec_time to UTC epoch for comparison with API since_ts/until_ts (Unix seconds = UTC).
_EXEC_EPOCH_E = "extract(epoch from (e.exec_time AT TIME ZONE 'America/Chicago'))"
_EXEC_EPOCH = "extract(epoch from (exec_time AT TIME ZONE 'America/Chicago'))"


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


def _has_meaningful_commission(v: Any, is_numeric: bool = True) -> bool:
    if v is None:
        return False
    if is_numeric and v == 0:
        return False
    if not is_numeric and (not v or not str(v).strip()):
        return False
    return True


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


def _norm_option_right(r: Any) -> str:
    if r is None:
        return ""
    s = (str(r)).strip().upper()
    if s in ("C", "CALL"):
        return "C"
    if s in ("P", "PUT"):
        return "P"
    return s


def _compute_opt_pair_map_and_pairs(
    executions: List[Dict[str, Any]],
) -> Tuple[Dict[int, List[int]], List[Dict[str, Any]]]:
    """Pair BUY↔SELL (same symbol, expiry, strike, account_id). FIFO. Returns (pair_map, opt_pairs)."""
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

    def _norm_strike(s: Any) -> str:
        if s is None:
            return ""
        try:
            f = float(s)
            return str(int(f)) if math.isfinite(f) and f == int(f) else str(f)
        except (TypeError, ValueError):
            return str(s).strip()

    def _norm_side(s: Any) -> str:
        if s is None:
            return "BUY"
        raw = (str(s) or "").strip().upper()
        if raw in ("BOT", "BUY", "B"):
            return "BUY"
        if raw in ("SLD", "SELL", "S"):
            return "SELL"
        return raw or "BUY"

    def _norm_expiry(s: Any) -> str:
        if s is None:
            return ""
        raw = str(s).strip().replace("-", "").replace(" ", "")
        return "".join(c for c in raw if c.isdigit()) if raw else ""

    groups: Dict[Tuple[str, str, str, str], List[Dict[str, Any]]] = {}
    for e in opt_only:
        side = _norm_side(e.get("side"))
        if side not in ("BUY", "SELL"):
            continue
        key = (
            (e.get("symbol") or "").strip(),
            _norm_expiry(e.get("expiry")),
            _norm_strike(e.get("strike")),
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
        buy_queue: List[Tuple[float, float, float, str, int]] = []
        sell_queue: List[Tuple[float, float, float, str, int]] = []

        for x in group_sorted:
            side = _norm_side(x.get("side"))
            if side not in ("BUY", "SELL"):
                continue
            q = abs(float(x.get("quantity") or 0))
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

            if side == "BUY":
                remaining = q
                while remaining > 0 and sell_queue:
                    q_s, p_s, c_s, side_s, s_id = sell_queue[0]
                    q_match = min(remaining, q_s)
                    if q_match <= 0:
                        break
                    c_b_alloc = (q_match / q) * c if q else 0.0
                    c_s_alloc = (q_match / q_s) * c_s if q_s else 0.0
                    sign_b = -1.0
                    sign_s = 1.0
                    leg_b = sign_b * q_match * p * 100.0 - c_b_alloc
                    leg_s = sign_s * q_match * p_s * 100.0 - c_s_alloc
                    pair_net = leg_b + leg_s
                    add_pair(s_id, eid)
                    opt_pairs.append({
                        "leg_c_execution_id": s_id,
                        "leg_p_execution_id": eid,
                        "symbol": sym,
                        "expiry": exp,
                        "strike": strike_str,
                        "account_id": acc,
                        "quantity": round(q_match, 4),
                        "c_side": side_s,
                        "c_price": round(p_s, 4),
                        "p_side": side,
                        "p_price": round(p, 4),
                        "commission": round(c_b_alloc + c_s_alloc, 2),
                        "net_pnl": round(pair_net, 2),
                    })
                    remaining -= q_match
                    if q_match >= q_s:
                        sell_queue.pop(0)
                    else:
                        sell_queue[0] = (
                            q_s - q_match,
                            p_s,
                            c_s * (1 - q_match / q_s),
                            side_s,
                            s_id,
                        )
                if remaining > 0:
                    buy_queue.append((remaining, p, (remaining / q) * c, side, eid))
            else:
                remaining = q
                while remaining > 0 and buy_queue:
                    q_b, p_b, c_b, side_b, b_id = buy_queue[0]
                    q_match = min(remaining, q_b)
                    if q_match <= 0:
                        break
                    c_b_alloc = (q_match / q_b) * c_b if q_b else 0.0
                    c_s_alloc = (q_match / q) * c if q else 0.0
                    sign_b = -1.0
                    sign_s = 1.0
                    leg_b = sign_b * q_match * p_b * 100.0 - c_b_alloc
                    leg_s = sign_s * q_match * p * 100.0 - c_s_alloc
                    pair_net = leg_b + leg_s
                    add_pair(b_id, eid)
                    opt_pairs.append({
                        "leg_c_execution_id": b_id,
                        "leg_p_execution_id": eid,
                        "symbol": sym,
                        "expiry": exp,
                        "strike": strike_str,
                        "account_id": acc,
                        "quantity": round(q_match, 4),
                        "c_side": side_b,
                        "c_price": round(p_b, 4),
                        "p_side": side,
                        "p_price": round(p, 4),
                        "commission": round(c_b_alloc + c_s_alloc, 2),
                        "net_pnl": round(pair_net, 2),
                    })
                    remaining -= q_match
                    if q_match >= q_b:
                        buy_queue.pop(0)
                    else:
                        buy_queue[0] = (
                            q_b - q_match,
                            p_b,
                            c_b * (1 - q_match / q_b),
                            side_b,
                            b_id,
                        )
                if remaining > 0:
                    sell_queue.append((remaining, p, (remaining / q) * c, side, eid))

    return (pair_map, opt_pairs)


def _get_current_equity(conn: Any) -> Optional[float]:
    if conn is None:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COALESCE(SUM(net_liquidation), 0) AS total FROM accounts")
            row = cur.fetchone()
        if row and row[0] is not None:
            v = float(row[0])
            return v if math.isfinite(v) else None
        return 0.0
    except Exception as e:
        logger.debug("_get_current_equity failed: %s", e)
        return None


def _compute_opt_realized_calendar(
    executions_sorted: List[Dict[str, Any]],
    granularity: str,
) -> List[Dict[str, Any]]:
    """Option Realized by period: pair BUY with SELL. Uses America/Chicago for period date."""
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


def _rows_to_executions(rows: Any, cur: Any) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for r in rows:
        d = dict(r)
        if d.get("raw_extra") is not None and isinstance(d["raw_extra"], str):
            try:
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


def get_executions(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
    account_id: Optional[str] = None,
    limit: Optional[int] = 200,
) -> List[Dict[str, Any]]:
    if conn is None:
        return []
    try:
        conditions = []
        values: List[Any] = []
        if since_ts is not None:
            conditions.append("e.trade_date >= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date")
            values.append(since_ts)
        if until_ts is not None:
            conditions.append("e.trade_date <= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date")
            values.append(until_ts)
        if account_id is not None and account_id.strip():
            conditions.append("account_id = %s")
            values.append(account_id.strip())
        where = (" WHERE " + " AND ".join(conditions)) if conditions else ""
        use_limit = limit is not None and limit > 0
        if use_limit:
            values.append(limit)
        limit_clause = " LIMIT %s" if use_limit else ""
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            try:
                cur.execute(
                    f"""
                    SELECT e.id, e.account_id, e.exec_id, {_EXEC_EPOCH_E} AS time,
                           e.symbol, e.sec_type, e.side, e.quantity, e.price,
                           c.commission, e.source,
                           e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                           c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                           e.trade_date, e.raw_extra
                    FROM account_executions e
                    LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
                    {where}
                    ORDER BY e.trade_date DESC NULLS LAST, e.exec_time DESC NULLS LAST{limit_clause}
                    """,
                    values,
                )
            except Exception as col_err:
                if "does not exist" in str(col_err).lower() or "42703" in str(getattr(col_err, "pgcode", "")):
                    try:
                        cur.execute(
                            f"""
                            SELECT e.id, e.account_id, e.exec_id, {_EXEC_EPOCH_E} AS time,
                                   e.symbol, e.sec_type, e.side, e.quantity, e.price,
                                   c.commission, e.source,
                                   e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                                   c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                                   e.trade_date, e.raw_extra
                            FROM account_executions e
                            LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id
                            {where}
                            ORDER BY e.trade_date DESC NULLS LAST, e.exec_time DESC NULLS LAST{limit_clause}
                            """,
                            values,
                        )
                    except Exception:
                        cur.execute(
                            f"""
                                    SELECT e.id, e.account_id, e.exec_id, {_EXEC_EPOCH_E} AS time,
                                           e.symbol, e.sec_type, e.side, e.quantity, e.price,
                                           NULL::double precision AS commission, e.source,
                                           e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                                           NULL::double precision AS realized_pnl, e.contract_key,
                                           NULL::text AS currency, NULL::double precision AS yield_, NULL::integer AS yield_redemption_date,
                                           e.trade_date, e.raw_extra
                                    FROM account_executions e
                                    {where}
                            ORDER BY e.trade_date DESC NULLS LAST, e.exec_time DESC NULLS LAST{limit_clause}
                            """,
                            values,
                        )
                else:
                    raise
            rows = cur.fetchall()
        return _rows_to_executions(rows, None)
    except Exception as e:
        logger.debug("get_executions failed: %s", e)
        return []


def get_executions_freshness(conn: Any) -> List[Dict[str, Any]]:
    if conn is None:
        return []
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                    account_id,
                    source,
                    extract(epoch from (max(exec_time) AT TIME ZONE 'America/Chicago')) AS latest_exec_ts,
                    extract(epoch from (now() - (max(exec_time) AT TIME ZONE 'America/Chicago'))) / 86400.0 AS days_since_latest
                FROM account_executions
                WHERE exec_time IS NOT NULL
                GROUP BY account_id, source
                ORDER BY account_id, source
                """
            )
            rows = cur.fetchall()
        out: List[Dict[str, Any]] = []
        for r in rows:
            d = dict(r)
            ts_val = d.get("latest_exec_ts")
            days_val = d.get("days_since_latest")
            try:
                d["latest_exec_ts"] = float(ts_val) if ts_val is not None else None
            except (TypeError, ValueError):
                d["latest_exec_ts"] = None
            try:
                d["days_since_latest"] = float(days_val) if days_val is not None else None
            except (TypeError, ValueError):
                d["days_since_latest"] = None
            out.append(d)
        return out
    except Exception as e:
        logger.debug("get_executions_freshness failed: %s", e)
        return []


def get_executions_by_contract_keys(
    conn: Any,
    contract_keys: List[Tuple[str, str, str, str]],
    account_id: Optional[str] = None,
    limit: int = 5000,
) -> List[Dict[str, Any]]:
    if not contract_keys or conn is None:
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
    sql = f"""
                    SELECT e.id, e.account_id, e.exec_id, {_EXEC_EPOCH_E} AS time,
                           e.symbol, e.sec_type, e.side, e.quantity, e.price,
                           c.commission, e.source,
                           e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                           c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                           e.trade_date, e.raw_extra
                    FROM account_executions e
                    LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
                    WHERE {where}
                    ORDER BY e.trade_date ASC NULLS LAST, e.exec_time ASC NULLS LAST
                    LIMIT %s
                    """
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            try:
                cur.execute(sql, values)
            except Exception as col_err:
                if "does not exist" in str(col_err).lower() or "42703" in str(getattr(col_err, "pgcode", "")):
                    try:
                        cur.execute(
                            f"""
                            SELECT e.id, e.account_id, e.exec_id, {_EXEC_EPOCH_E} AS time,
                                   e.symbol, e.sec_type, e.side, e.quantity, e.price,
                                   c.commission, e.source,
                                   e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                                   c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                                   e.trade_date, e.raw_extra
                            FROM account_executions e
                            LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id
                            WHERE {where}
                            ORDER BY e.trade_date ASC NULLS LAST, e.exec_time ASC NULLS LAST
                            LIMIT %s
                            """,
                            values,
                        )
                    except Exception:
                        vals_no_acc = list(values)
                        cur.execute(
                            f"""
                            SELECT id, account_id, exec_id, {_EXEC_EPOCH} AS time,
                                   symbol, sec_type, side, quantity, price,
                                   NULL::double precision AS commission, source,
                                   expiry, strike, option_right, exchange, order_id, cum_qty,
                                   NULL::double precision AS realized_pnl, contract_key,
                                   NULL::text AS currency, NULL::double precision AS yield_, NULL::integer AS yield_redemption_date,
                                   trade_date, raw_extra
                            FROM account_executions
                            WHERE (symbol, expiry, COALESCE(strike::text,''), account_id) IN ({placeholders})
                              AND upper(trim(COALESCE(sec_type,''))) = 'OPT'
                            ORDER BY trade_date ASC NULLS LAST, exec_time ASC NULLS LAST
                            LIMIT %s
                            """,
                            vals_no_acc,
                        )
                else:
                    raise
            rows = cur.fetchall()
        return _rows_to_executions(rows, None)
    except Exception as e:
        logger.debug("get_executions_by_contract_keys failed: %s", e)
        return []


def get_executions_with_opt_pairs(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
    account_id: Optional[str] = None,
    limit: int = 200,
) -> Dict[str, Any]:
    day_executions = get_executions(conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=limit)
    if since_ts is None or until_ts is None:
        for e in day_executions:
            e["paired_execution_ids"] = []
        return {"executions": day_executions, "opt_pairs": []}
    all_legs = get_executions_with_opt_pairs_single_query(
        conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=5000,
    )
    pair_map, opt_pairs = _compute_opt_pair_map_and_pairs(all_legs)
    try:
        from zoneinfo import ZoneInfo
        chicago = ZoneInfo("America/Chicago")
        since_date = datetime.fromtimestamp(since_ts, tz=timezone.utc).astimezone(chicago).date()
        until_date = datetime.fromtimestamp(until_ts, tz=timezone.utc).astimezone(chicago).date()
    except Exception:
        since_date = until_date = None
    id_to_trade_date: Dict[int, date] = {}
    for leg in all_legs:
        eid = leg.get("id")
        if eid is None:
            continue
        td = leg.get("trade_date")
        if td is not None:
            if isinstance(td, date):
                id_to_trade_date[int(eid)] = td
            elif isinstance(td, str) and len(td) >= 10:
                try:
                    id_to_trade_date[int(eid)] = datetime.strptime(td[:10], "%Y-%m-%d").date()
                except (TypeError, ValueError):
                    pass
        if int(eid) not in id_to_trade_date:
            t = leg.get("time")
            if t is not None:
                try:
                    from zoneinfo import ZoneInfo
                    ts = float(t)
                    dt = datetime.fromtimestamp(ts, tz=timezone.utc).astimezone(ZoneInfo("America/Chicago"))
                    id_to_trade_date[int(eid)] = dt.date()
                except Exception:
                    pass
    filtered_pairs = []
    for p in opt_pairs:
        cid = p.get("leg_c_execution_id")
        pid = p.get("leg_p_execution_id")
        dc = id_to_trade_date.get(int(cid)) if cid is not None else None
        dp = id_to_trade_date.get(int(pid)) if pid is not None else None
        if dc is None or dp is None:
            continue
        if since_date is not None and until_date is not None and (dc < since_date or dc > until_date or dp < since_date or dp > until_date):
            continue
        filtered_pairs.append(p)
    pair_map_filtered: Dict[int, List[int]] = {}
    for p in filtered_pairs:
        aid = p.get("leg_c_execution_id")
        bid = p.get("leg_p_execution_id")
        if aid is not None and bid is not None:
            if aid not in pair_map_filtered:
                pair_map_filtered[aid] = []
            if bid not in pair_map_filtered[aid]:
                pair_map_filtered[aid].append(bid)
            if bid not in pair_map_filtered:
                pair_map_filtered[bid] = []
            if aid not in pair_map_filtered[bid]:
                pair_map_filtered[bid].append(aid)
    for e in day_executions:
        eid = e.get("id")
        if eid is not None:
            e["paired_execution_ids"] = pair_map_filtered.get(int(eid), [])
        else:
            e["paired_execution_ids"] = []
    return {"executions": day_executions, "opt_pairs": filtered_pairs}


def get_executions_with_opt_pairs_single_query(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
    account_id: Optional[str] = None,
    limit: int = 5000,
) -> List[Dict[str, Any]]:
    if since_ts is None or until_ts is None or conn is None:
        return []
    values: List[Any] = [since_ts, until_ts]
    acc_cond = ""
    if account_id and account_id.strip():
        acc_cond = " AND e.account_id = %s"
        values.append(account_id.strip())
    values2: List[Any] = [since_ts, until_ts, since_ts, until_ts]
    if account_id and account_id.strip():
        values2.append(account_id.strip())
    values2.append(limit)
    sql = f"""
WITH day_keys AS (
  SELECT DISTINCT e.symbol, e.expiry, COALESCE(e.strike::text,'') AS strike_s, e.account_id
  FROM account_executions e
  WHERE e.trade_date >= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
    AND e.trade_date <= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
    AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    {acc_cond}
),
all_legs AS (
  SELECT e.id, e.account_id, e.exec_id, {_EXEC_EPOCH_E} AS time,
         e.trade_date,
         e.symbol, e.sec_type, e.side, e.quantity, e.price,
         c.commission, e.source,
         e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
         c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra,
         (e.trade_date >= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date AND e.trade_date <= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date) AS in_selected_day,
         upper(trim(COALESCE(e.side,''))) AS side_norm
  FROM account_executions e
  INNER JOIN day_keys k ON e.symbol = k.symbol AND e.expiry = k.expiry
    AND COALESCE(e.strike::text,'') = k.strike_s AND e.account_id = k.account_id
  LEFT JOIN account_execution_commissions c ON e.exec_id = c.exec_id AND e.exec_id IS NOT NULL
  WHERE upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    AND e.trade_date >= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
    AND e.trade_date <= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
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
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            try:
                cur.execute(sql, values + values2)
            except Exception as col_err:
                if "does not exist" in str(col_err).lower() or "42703" in str(getattr(col_err, "pgcode", "")):
                    sql_fallback = f"""
WITH day_keys AS (
  SELECT DISTINCT e.symbol, e.expiry, COALESCE(e.strike::text,'') AS strike_s, e.account_id
  FROM account_executions e
  WHERE e.trade_date >= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
    AND e.trade_date <= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
    AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    {acc_cond}
),
all_legs AS (
  SELECT e.id, e.account_id, e.exec_id, {_EXEC_EPOCH_E} AS time,
         e.trade_date,
         e.symbol, e.sec_type, e.side, e.quantity, e.price,
         NULL::double precision AS commission, e.source,
         e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
         NULL::double precision AS realized_pnl, e.contract_key, NULL::text AS currency,
         NULL::double precision AS yield_, NULL::integer AS yield_redemption_date, e.raw_extra,
         (e.trade_date >= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date AND e.trade_date <= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date) AS in_selected_day,
         upper(trim(COALESCE(e.side,''))) AS side_norm
  FROM account_executions e
  INNER JOIN day_keys k ON e.symbol = k.symbol AND e.expiry = k.expiry
    AND COALESCE(e.strike::text,'') = k.strike_s AND e.account_id = k.account_id
  WHERE upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
    AND e.trade_date >= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
    AND e.trade_date <= (to_timestamp(%s) AT TIME ZONE 'America/Chicago')::date
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
        return _rows_to_executions(rows, None)
    except Exception as e:
        logger.debug("get_executions_with_opt_pairs_single_query failed: %s", e)
        return []


def get_net_cash_flow(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
    account_id: Optional[str] = None,
) -> float:
    if conn is None:
        return 0.0
    try:
        with conn.cursor() as cur:
            q = "SELECT COALESCE(SUM(amount), 0) AS total FROM account_transactions WHERE 1=1"
            args: List[Any] = []
            if since_ts is not None:
                q += " AND ts >= to_timestamp(%s)"
                args.append(since_ts)
            if until_ts is not None:
                q += " AND ts <= to_timestamp(%s)"
                args.append(until_ts)
            if account_id is not None and str(account_id).strip():
                q += " AND account_id = %s"
                args.append(str(account_id).strip())
            cur.execute(q, args)
            row = cur.fetchone()
        if row and row[0] is not None:
            v = float(row[0])
            return v if math.isfinite(v) else 0.0
        return 0.0
    except Exception as e:
        logger.debug("get_net_cash_flow failed: %s", e)
        return 0.0


def get_transactions(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
    account_id: Optional[str] = None,
    limit: int = 500,
) -> List[Dict[str, Any]]:
    if conn is None:
        return []
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            q = """
                SELECT id, account_id, extract(epoch from ts) AS ts, amount, type, currency, description, created_at
                FROM account_transactions WHERE 1=1
            """
            args: List[Any] = []
            if since_ts is not None:
                q += " AND ts >= to_timestamp(%s)"
                args.append(since_ts)
            if until_ts is not None:
                q += " AND ts <= to_timestamp(%s)"
                args.append(until_ts)
            if account_id is not None and str(account_id).strip():
                q += " AND account_id = %s"
                args.append(str(account_id).strip())
            q += " ORDER BY ts DESC LIMIT %s"
            args.append(limit)
            cur.execute(q, args)
            rows = cur.fetchall()
        return [dict(r) for r in rows] if rows else []
    except Exception as e:
        logger.debug("get_transactions failed: %s", e)
        return []


def get_performance_stats(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
    account_id: Optional[str] = None,
    granularity: str = "day",
) -> Dict[str, Any]:
    current_equity: Optional[float] = _get_current_equity(conn)
    net_cash_flow = get_net_cash_flow(conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id)
    start_equity: Optional[float] = current_equity
    capital_base: Optional[float] = (start_equity + 0.5 * net_cash_flow) if start_equity is not None else None
    if capital_base is not None and capital_base <= 0:
        capital_base = None

    executions = get_executions(conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=5000)
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

    opt_calendar = _compute_opt_realized_calendar(executions_sorted, granularity)
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

    accounts_list = get_accounts_from_tables(conn) or []
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
        "transactions": get_transactions(conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=200),
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


def get_position_categories(conn: Any) -> List[Dict[str, Any]]:
    if conn is None:
        return []
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, name, description, sort_order, created_at, updated_at
                FROM position_categories
                ORDER BY COALESCE(sort_order, 999), name
                """
            )
            rows = cur.fetchall()
        return [dict(r) for r in rows] if rows else []
    except Exception as e:
        logger.debug("get_position_categories failed: %s", e)
        return []


def create_position_category(
    conn: Any,
    name: str,
    description: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> Optional[int]:
    if not name or not str(name).strip() or conn is None:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO position_categories (name, description, sort_order, updated_at)
                VALUES (%s, %s, %s, now())
                RETURNING id
                """,
                (str(name).strip(), (description or "").strip() or None, sort_order),
            )
            row = cur.fetchone()
        conn.commit()
        return int(row[0]) if row and row[0] is not None else None
    except Exception as e:
        logger.debug("create_position_category failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return None


def update_position_category(
    conn: Any,
    category_id: int,
    name: Optional[str] = None,
    description: Optional[str] = None,
    sort_order: Optional[int] = None,
) -> bool:
    if conn is None:
        return False
    try:
        updates = ["updated_at = now()"]
        vals: List[Any] = []
        if name is not None:
            updates.append("name = %s")
            vals.append(str(name).strip() if str(name).strip() else None)
        if description is not None:
            updates.append("description = %s")
            vals.append(str(description).strip() or None)
        if sort_order is not None:
            updates.append("sort_order = %s")
            vals.append(sort_order)
        if not vals:
            return True
        vals.append(category_id)
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE position_categories SET {', '.join(updates)} WHERE id = %s",
                tuple(vals),
            )
        conn.commit()
        return True
    except Exception as e:
        logger.debug("update_position_category failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def delete_position_category(conn: Any, category_id: int) -> bool:
    if conn is None:
        return False
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM position_categories WHERE id = %s", (category_id,))
        conn.commit()
        return True
    except Exception as e:
        logger.debug("delete_position_category failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def set_position_category_tag(
    conn: Any,
    account_id: str,
    contract_key: str,
    category_id: Optional[int],
) -> bool:
    if not account_id or not str(account_id).strip() or not contract_key or not str(contract_key).strip() or conn is None:
        return False
    try:
        acc = str(account_id).strip()
        ck = str(contract_key).strip()
        with conn.cursor() as cur:
            if category_id is None:
                cur.execute(
                    "DELETE FROM position_category_tags WHERE account_id = %s AND contract_key = %s",
                    (acc, ck),
                )
            else:
                cur.execute(
                    """
                    INSERT INTO position_category_tags (account_id, contract_key, category_id)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (account_id, contract_key) DO UPDATE SET category_id = EXCLUDED.category_id
                    """,
                    (acc, ck, category_id),
                )
        conn.commit()
        return True
    except Exception as e:
        logger.debug("set_position_category_tag failed: %s", e)
        try:
            conn.rollback()
        except Exception:
            pass
        return False


def get_accounts_from_tables(conn: Any) -> Optional[List[Dict[str, Any]]]:
    if conn is None:
        return None
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
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
            with conn.cursor(cursor_factory=RealDictCursor) as cur2:
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
                        ip.updated_at AS price_updated_at,
                        pct.category_id AS position_category_id,
                        pc.name AS position_category_name
                    FROM account_positions ap
                    LEFT JOIN instrument_prices ip
                        ON ap.contract_key = ip.contract_key
                    LEFT JOIN position_category_tags pct
                        ON ap.account_id = pct.account_id AND ap.contract_key = pct.contract_key
                    LEFT JOIN position_categories pc
                        ON pct.category_id = pc.id
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

                cat_id = p.get("position_category_id")
                if cat_id is not None:
                    try:
                        pos_dict["category_id"] = int(cat_id)
                    except (TypeError, ValueError):
                        pass
                cat_name = p.get("position_category_name")
                if cat_name is not None and str(cat_name).strip():
                    pos_dict["category"] = str(cat_name).strip()

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
                    if not math.isfinite(v) or v <= 0:
                        continue
                    price_val = v
                    break
                if price_val is not None:
                    pos_dict["price"] = price_val
                else:
                    sec_typ = (p.get("sec_type") or "").strip().upper()
                    if sec_typ == "STK":
                        fallback = market_module.get_stock_day_fallback_price(conn, p.get("symbol") or "")
                        if fallback is not None:
                            price_val = fallback[0]
                            pos_dict["price"] = price_val
                            pos_dict["price_updated_at"] = fallback[1]
                            if fallback[2] is not None:
                                pos_dict["daily_prev_close"] = fallback[2]

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

                price_for_pnl: Optional[float] = None
                for candidate in (raw_last, raw_mid):
                    if candidate is None:
                        continue
                    try:
                        v = float(candidate)
                    except (TypeError, ValueError):
                        continue
                    if not math.isfinite(v) or v <= 0:
                        continue
                    price_for_pnl = v
                    break
                if price_for_pnl is None and price_val is not None:
                    price_for_pnl = price_val
                pos_qty = p.get("position")
                pos_avg = p.get("avg_cost")
                sec_type = (p.get("sec_type") or "").strip().upper()
                if price_for_pnl is not None and pos_qty is not None and pos_avg is not None:
                    try:
                        q = float(pos_qty)
                        c = float(pos_avg)
                        if math.isfinite(q) and math.isfinite(c):
                            if sec_type == "OPT":
                                pos_dict["unrealized_pnl"] = round((price_for_pnl - c) * q * 100, 2)
                            else:
                                pos_dict["unrealized_pnl"] = round((price_for_pnl - c) * q, 2)
                    except (TypeError, ValueError):
                        pass

                positions.append(pos_dict)
            out.append({"account_id": acc_id, "summary": summary, "positions": positions})
        return out
    except Exception as e:
        logger.debug("get_accounts_from_tables failed: %s", e)
        return None


def get_accounts_fetched_at(conn: Any) -> Optional[float]:
    if conn is None:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT max(updated_at) AS t FROM accounts")
            row = cur.fetchone()
        if row and row[0] is not None:
            ts = row[0]
            return ts.timestamp() if hasattr(ts, "timestamp") else float(ts)
        return None
    except Exception as e:
        logger.debug("get_accounts_fetched_at failed: %s", e)
        return None


# --- Module-level (status_config) write/CRUD for routers and __init__ re-exports ---


def sync_accounts_snapshot_to_db(
    status_config: dict, accounts_list: Optional[List[Dict[str, Any]]]
) -> bool:
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
def write_account_executions_to_db(status_config: dict, rows: List[Dict[str, Any]]) -> bool:
    """R-A2: 写入执行记录到 account_executions；CommissionReport 写入 account_execution_commissions。按 exec_id 去重。"""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return False
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
                    # Flex Trades 去重：无 exec_id 时用 account_id+trade_id 合成 exec_id，使 ON CONFLICT 生效
                    if (
                        source == "flex_trades"
                        and (not exec_id or not str(exec_id).strip())
                        and account_id
                        and trade_id
                    ):
                        exec_id = f"flex_{account_id}_{trade_id}"
                    elif not exec_id or not str(exec_id).strip():
                        exec_id = None
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

                    # 对于期权，若来源为 TWS（tws_event / tws_client），在插入前按 localSymbol 规范重建 contract_key：
                    #   local_symbol = symbol + "  " + yymmdd + right + strike8
                    #   contract_key = local_symbol|sec_type|expiry|strike|option_right
                    sec_type_norm = (sec_type or "").strip().upper()
                    if sec_type_norm == "OPT":
                        source_norm = (source or "").strip()
                        if source_norm in ("tws_event", "tws_client"):
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
                            if sym_key and exp_key and strike_key is not None and right_key:
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
                            if isinstance(exec_time, (int, float)):
                                exec_dt = datetime.fromtimestamp(float(exec_time), tz=timezone.utc)
                            else:
                                exec_dt = exec_time
                        except Exception:
                            exec_dt = None
                    else:
                        exec_dt = None
                    # When source is not flex_trades, trade_date is not provided by the source; set it from exec_time.
                    if (source or "").strip() != "flex_trades" and trade_date is None and exec_dt is not None:
                        try:
                            trade_date = exec_dt.date() if hasattr(exec_dt, "date") else None
                        except Exception:
                            trade_date = None
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
                        # Flex is authoritative but lagging: when same exec_id exists with source != flex_trades, override in place (keep id).
                        is_flex = (source == "flex_trades")
                        if is_flex:
                            update_set = ", ".join(
                                f"{c.strip()} = EXCLUDED.{c.strip()}" for c in cols.split(",")
                            )
                            cur.execute(
                                f"""
                                INSERT INTO account_executions ({cols})
                                VALUES ({placeholders})
                                ON CONFLICT (exec_id) WHERE exec_id IS NOT NULL AND exec_id != ''
                                DO UPDATE SET {update_set}
                                """,
                                vals,
                            )
                        else:
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


def upsert_account_transactions(status_config: dict, rows: List[Dict[str, Any]]) -> int:
    """Insert or update account_transactions from Flex cash transaction list. Returns number of rows processed.
    Each row at minimum: account_id, ts (Unix float), amount, type, currency?, description?.
    Extended fields (when present): flex_transaction_id, flex_type, flex_code, asset_category, asset_subcategory,
    symbol, conid, security_id, security_id_type, listing_exchange, report_date, available_for_trading_date,
    fx_rate_to_base, raw_extra.
    Uses ON CONFLICT (account_id, ts, amount, type) DO UPDATE to avoid duplicates."""
    if not status_config or (status_config.get("sink") != "postgres" and not status_config.get("postgres")):
        return 0
    if not rows:
        return 0
    try:
        params = _get_conn_params(status_config)
        conn = psycopg2.connect(**params)
        try:
            with conn.cursor() as cur:
                for r in rows:
                    account_id = (r.get("account_id") or "").strip()
                    ts = r.get("ts")
                    amount = r.get("amount")
                    tx_type = (r.get("type") or "other").strip() or "other"
                    currency = (r.get("currency") or "").strip() or None
                    description = (r.get("description") or "").strip() or None
                    if not account_id:
                        continue
                    if ts is None:
                        continue
                    try:
                        ts_float = float(ts)
                    except (TypeError, ValueError):
                        continue
                    if amount is None:
                        amount = 0.0
                    try:
                        amount_float = float(amount)
                    except (TypeError, ValueError):
                        amount_float = 0.0

                    flex_transaction_id = (r.get("flex_transaction_id") or "").strip() or None
                    flex_type = (r.get("flex_type") or "").strip() or None
                    flex_code = (r.get("flex_code") or "").strip() or None
                    asset_category = (r.get("asset_category") or "").strip() or None
                    asset_subcategory = (r.get("asset_subcategory") or "").strip() or None
                    symbol = (r.get("symbol") or "").strip() or None
                    conid = r.get("conid")
                    try:
                        conid_int = int(conid) if conid is not None else None
                    except (TypeError, ValueError):
                        conid_int = None
                    security_id = (r.get("security_id") or "").strip() or None
                    security_id_type = (r.get("security_id_type") or "").strip() or None
                    listing_exchange = (r.get("listing_exchange") or "").strip() or None
                    report_date = (r.get("report_date") or "").strip() or None
                    available_for_trading_date = (r.get("available_for_trading_date") or "").strip() or None
                    fx_rate_to_base = r.get("fx_rate_to_base")
                    try:
                        fx_rate_to_base_float = float(fx_rate_to_base) if fx_rate_to_base is not None else None
                    except (TypeError, ValueError):
                        fx_rate_to_base_float = None
                    raw_extra = r.get("raw_extra")

                    cur.execute(
                        """
                        INSERT INTO account_transactions (
                            account_id, ts, amount, type, currency, description,
                            flex_transaction_id, flex_type, flex_code,
                            asset_category, asset_subcategory,
                            symbol, conid, security_id, security_id_type,
                            listing_exchange, report_date, available_for_trading_date,
                            fx_rate_to_base, raw_extra
                        )
                        VALUES (
                            %s, to_timestamp(%s), %s, %s, %s, %s,
                            %s, %s, %s,
                            %s, %s,
                            %s, %s, %s, %s,
                            %s, %s, %s,
                            %s, %s
                        )
                        ON CONFLICT (account_id, ts, amount, type) DO UPDATE SET
                            currency = COALESCE(EXCLUDED.currency, account_transactions.currency),
                            description = COALESCE(EXCLUDED.description, account_transactions.description),
                            flex_transaction_id = COALESCE(EXCLUDED.flex_transaction_id, account_transactions.flex_transaction_id),
                            flex_type = COALESCE(EXCLUDED.flex_type, account_transactions.flex_type),
                            flex_code = COALESCE(EXCLUDED.flex_code, account_transactions.flex_code),
                            asset_category = COALESCE(EXCLUDED.asset_category, account_transactions.asset_category),
                            asset_subcategory = COALESCE(EXCLUDED.asset_subcategory, account_transactions.asset_subcategory),
                            symbol = COALESCE(EXCLUDED.symbol, account_transactions.symbol),
                            conid = COALESCE(EXCLUDED.conid, account_transactions.conid),
                            security_id = COALESCE(EXCLUDED.security_id, account_transactions.security_id),
                            security_id_type = COALESCE(EXCLUDED.security_id_type, account_transactions.security_id_type),
                            listing_exchange = COALESCE(EXCLUDED.listing_exchange, account_transactions.listing_exchange),
                            report_date = COALESCE(EXCLUDED.report_date, account_transactions.report_date),
                            available_for_trading_date = COALESCE(EXCLUDED.available_for_trading_date, account_transactions.available_for_trading_date),
                            fx_rate_to_base = COALESCE(EXCLUDED.fx_rate_to_base, account_transactions.fx_rate_to_base),
                            raw_extra = COALESCE(EXCLUDED.raw_extra, account_transactions.raw_extra)
                        """,
                        (
                            account_id,
                            ts_float,
                            amount_float,
                            tx_type,
                            currency,
                            description,
                            flex_transaction_id,
                            flex_type,
                            flex_code,
                            asset_category,
                            asset_subcategory,
                            symbol,
                            conid_int,
                            security_id,
                            security_id_type,
                            listing_exchange,
                            report_date,
                            available_for_trading_date,
                            fx_rate_to_base_float,
                            json.dumps(raw_extra) if raw_extra is not None else None,
                        ),
                    )
            conn.commit()
            return len(rows)
        finally:
            conn.close()
    except Exception as e:
        logger.warning("upsert_account_transactions failed: %s", e)
        return 0


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


__all__ = [
    "sync_accounts_snapshot_to_db",
    "write_account_executions_to_db",
    "update_execution_commission",
    "insert_one_execution",
    "upsert_account_transactions",
    "update_one_execution",
    "delete_one_execution",
]
