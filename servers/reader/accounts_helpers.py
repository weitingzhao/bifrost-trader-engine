"""Shared helpers for accounts and executions (contract_key, option pairing, time, rows)."""

import json
import logging
import math
from datetime import date, datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Tuple

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
    # Prefer account_executions_id (current schema); fallback to id for legacy.
    def _exec_id(e: Dict[str, Any]) -> Optional[Any]:
        return e.get("account_executions_id") if e.get("account_executions_id") is not None else e.get("id")

    opt_only = [
        e
        for e in executions
        if (e.get("sec_type") or "").strip().upper() == "OPT"
        and _exec_id(e) is not None
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
            eid_val = _exec_id(x)
            eid = int(eid_val) if eid_val is not None else None
            if eid is None:
                continue

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
            cur.execute("SELECT COALESCE(SUM(net_liquidation), 0) AS total FROM account")
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
        if "created_at" in d and d["created_at"] is not None:
            try:
                d["created_at"] = float(d["created_at"])
            except (TypeError, ValueError):
                pass
        _fill_contract_key_for_opt(d)
        out.append(d)
    return out
