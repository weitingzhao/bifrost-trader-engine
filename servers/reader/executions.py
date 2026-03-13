"""Executions and transactions read + performance stats. Uses accounts_helpers; get_performance_stats needs get_accounts_from_tables from accounts."""

import logging
import math
from datetime import date, datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

from psycopg2.extras import RealDictCursor

from servers.reader.accounts_helpers import (
    _compute_opt_pair_map_and_pairs,
    _compute_opt_realized_calendar,
    _get_current_equity,
    _rows_to_executions,
)

logger = logging.getLogger(__name__)

# Exec_time as UTC epoch (Unix seconds) for API and frontend display; timestamptz stores UTC.
_EXEC_EPOCH_E = "extract(epoch from e.exec_time)"
_EXEC_EPOCH = "extract(epoch from exec_time)"
_CREATED_AT_E = "extract(epoch from e.created_at) AS created_at"
_CREATED_AT = "extract(epoch from created_at) AS created_at"

# Normalize quantity so Sell = negative across sources. tws_client already stores Sell as negative;
# other sources (e.g. flex) store positive for Sell → negate in query for consistent display/aggregation.
_QTY_NORM_E = (
    "CASE WHEN lower(trim(COALESCE(e.source, ''))) = 'tws_client' THEN e.quantity "
    "WHEN upper(trim(COALESCE(e.side, ''))) IN ('SELL', 'SLD', 'S') THEN -e.quantity "
    "ELSE e.quantity END AS quantity"
)
_QTY_NORM = (
    "CASE WHEN lower(trim(COALESCE(source, ''))) = 'tws_client' THEN quantity "
    "WHEN upper(trim(COALESCE(side, ''))) IN ('SELL', 'SLD', 'S') THEN -quantity "
    "ELSE quantity END AS quantity"
)

# Normalize commission so "cost" convention is consistent. tws_client stores commission as cost (positive);
# other sources (e.g. flex) may use opposite sign → negate in query when not tws_client.
_COMM_NORM_E = (
    "CASE WHEN lower(trim(COALESCE(e.source, ''))) = 'tws_client' THEN c.commission "
    "WHEN c.commission IS NOT NULL THEN -c.commission ELSE NULL END AS commission"
)


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
                           e.symbol, e.sec_type, e.side, {_QTY_NORM_E}, e.price,
                           {_COMM_NORM_E}, e.source,
                           e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                           c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                           e.trade_date, e.raw_extra, {_CREATED_AT_E}
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
                                   e.symbol, e.sec_type, e.side, {_QTY_NORM_E}, e.price,
                                   {_COMM_NORM_E}, e.source,
                                   e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                                   c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                                   e.trade_date, e.raw_extra, {_CREATED_AT_E}
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
                                           e.symbol, e.sec_type, e.side, {_QTY_NORM_E}, e.price,
                                           NULL::double precision AS commission, e.source,
                                           e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                                           NULL::double precision AS realized_pnl, e.contract_key,
                                           NULL::text AS currency, NULL::double precision AS yield_, NULL::integer AS yield_redemption_date,
                                           e.trade_date, e.raw_extra, {_CREATED_AT_E}
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
                    extract(epoch from max(exec_time)) AS latest_exec_ts,
                    extract(epoch from (now() - max(exec_time))) / 86400.0 AS days_since_latest
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
                           e.symbol, e.sec_type, e.side, {_QTY_NORM_E}, e.price,
                           {_COMM_NORM_E}, e.source,
                           e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                           c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                           e.trade_date, e.raw_extra, {_CREATED_AT_E}
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
                                   e.symbol, e.sec_type, e.side, {_QTY_NORM_E}, e.price,
                                   {_COMM_NORM_E}, e.source,
                                   e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
                                   c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date,
                                   e.trade_date, e.raw_extra, {_CREATED_AT_E}
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
                                   symbol, sec_type, side, {_QTY_NORM}, price,
                                   NULL::double precision AS commission, source,
                                   expiry, strike, option_right, exchange, order_id, cum_qty,
                                   NULL::double precision AS realized_pnl, contract_key,
                                   NULL::text AS currency, NULL::double precision AS yield_, NULL::integer AS yield_redemption_date,
                                   trade_date, raw_extra, {_CREATED_AT}
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
         e.symbol, e.sec_type, e.side, {_QTY_NORM_E}, e.price,
         {_COMM_NORM_E}, e.source,
         e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
         c.realized_pnl, e.contract_key, c.currency, c.yield_, c.yield_redemption_date, e.raw_extra,
         {_CREATED_AT_E},
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
         e.symbol, e.sec_type, e.side, {_QTY_NORM_E}, e.price,
         NULL::double precision AS commission, e.source,
         e.expiry, e.strike, e.option_right, e.exchange, e.order_id, e.cum_qty,
         NULL::double precision AS realized_pnl, e.contract_key, NULL::text AS currency,
         NULL::double precision AS yield_, NULL::integer AS yield_redemption_date, e.raw_extra,
         {_CREATED_AT_E},
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
    from servers.reader.accounts import get_accounts_from_tables

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
