"""Accounts: snapshot read/write and execution/transaction write.
Execution/transaction read and position_categories live in executions and position_categories modules. All logic inlined from legacy; no dependency on _legacy."""

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
from servers.reader.accounts_helpers import (
    _exec_time_to_dt,
    _fill_contract_key_for_opt,
    _has_meaningful_commission,
    _norm_option_right,
)

logger = logging.getLogger(__name__)


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
                         WHERE e.account_id = ap.account_id
                           AND (
                             e.contract_key = ap.contract_key
                             OR (
                               upper(trim(COALESCE(ap.sec_type,''))) = 'OPT'
                               AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
                               AND substring(e.contract_key from position('|' in e.contract_key) + 1) = substring(ap.contract_key from position('|' in ap.contract_key) + 1)
                             )
                           )
                         ORDER BY e.exec_time DESC NULLS LAST
                         LIMIT 1) AS position_exec_time,
                        (SELECT e.trade_date
                         FROM account_executions e
                         WHERE e.account_id = ap.account_id
                           AND (
                             e.contract_key = ap.contract_key
                             OR (
                               upper(trim(COALESCE(ap.sec_type,''))) = 'OPT'
                               AND upper(trim(COALESCE(e.sec_type,''))) = 'OPT'
                               AND substring(e.contract_key from position('|' in e.contract_key) + 1) = substring(ap.contract_key from position('|' in ap.contract_key) + 1)
                             )
                           )
                         ORDER BY e.exec_time DESC NULLS LAST
                         LIMIT 1) AS position_trade_date,
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
                raw_trade_date = p.get("position_trade_date")
                if raw_trade_date is not None:
                    try:
                        if hasattr(raw_trade_date, "isoformat"):
                            pos_dict["trade_date"] = raw_trade_date.isoformat()
                        elif isinstance(raw_trade_date, str) and raw_trade_date.strip():
                            pos_dict["trade_date"] = raw_trade_date.strip()[:10]
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
