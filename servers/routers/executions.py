"""Executions and transactions: CRUD, Flex fetch, IB fetch, performance."""

import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Body, Query, Request

from servers.flex_client import fetch_cash_transactions, fetch_trades, parse_trades_xml
from servers.ib_clients import AccountIbClient
from servers.reader import (
    write_account_executions_to_db,
    update_execution_commission,
    insert_one_execution,
    update_one_execution,
    delete_one_execution,
    upsert_account_transactions,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["executions"])


@router.get("/executions")
def get_executions(
    request: Request,
    since_ts: Optional[float] = Query(None, description="Filter executions with time >= this (Unix s)"),
    until_ts: Optional[float] = Query(None, description="Filter executions with time <= this"),
    account_id: Optional[str] = Query(None, description="Filter by account ID"),
    limit: int = Query(200, ge=0, le=10000, description="Max rows to return; 0 = no limit"),
    include_opt_pairs: bool = Query(False, description="Include C↔P pairing"),
    strategy_opportunity_id: Optional[int] = Query(None, description="Filter by strategy opportunity ID"),
    strategy_instance_id: Optional[int] = Query(None, description="Filter by strategy instance ID"),
) -> Dict[str, Any]:
    """Account-level executions/trades (R-A2). If include_opt_pairs=true: returns paired_execution_ids and opt_pairs."""
    reader = request.app.state.reader
    effective_limit: Optional[int] = limit if limit > 0 else None
    if include_opt_pairs:
        return reader.get_executions_with_opt_pairs(
            since_ts=since_ts,
            until_ts=until_ts,
            account_id=account_id,
            limit=effective_limit or 5000,
            strategy_opportunity_id=strategy_opportunity_id,
            strategy_instance_id=strategy_instance_id,
        )
    items = reader.get_executions(
        since_ts=since_ts,
        until_ts=until_ts,
        account_id=account_id,
        limit=effective_limit,
        strategy_opportunity_id=strategy_opportunity_id,
        strategy_instance_id=strategy_instance_id,
    )
    return {"executions": items}


@router.get("/executions/freshness")
def get_executions_freshness(request: Request) -> Dict[str, Any]:
    """Execution data freshness per (account_id, source). Latest exec_time and days_since_latest."""
    reader = request.app.state.reader
    items = reader.get_executions_freshness()
    return {"items": items}


@router.get("/performance")
def get_performance(
    request: Request,
    since_ts: Optional[float] = Query(None),
    until_ts: Optional[float] = Query(None),
    account_id: Optional[str] = Query(None),
    granularity: str = Query("day", description="day | week | month"),
    strategy_opportunity_id: Optional[int] = Query(None, description="Filter by strategy opportunity ID"),
    strategy_instance_id: Optional[int] = Query(None, description="Filter by strategy instance ID"),
) -> Dict[str, Any]:
    """Performance stats and calendar PnL from account_executions."""
    reader = request.app.state.reader
    return reader.get_performance_stats(
        since_ts=since_ts,
        until_ts=until_ts,
        account_id=account_id,
        granularity=granularity,
        strategy_opportunity_id=strategy_opportunity_id,
        strategy_instance_id=strategy_instance_id,
    )


@router.get("/transactions")
def get_transactions(
    request: Request,
    since_ts: Optional[float] = Query(None),
    until_ts: Optional[float] = Query(None),
    account_id: Optional[str] = Query(None),
    limit: int = Query(500),
) -> Dict[str, Any]:
    """List account_transactions (Flex cash transactions) for Transfer & Pay page."""
    reader = request.app.state.reader
    items = reader.get_transactions(since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=limit)
    return {"transactions": items}


@router.post("/transactions/fetch")
def post_transactions_fetch(request: Request, body: Dict[str, Any] = Body(default=None)) -> Dict[str, Any]:
    """Fetch cash transactions from IB Flex and upsert into account_transactions."""
    reader = request.app.state.reader
    control_via_db = request.app.state.control_via_db
    try:
        entries: List[tuple] = []
        flex_list = reader.get_flex_config(purpose="cash_transactions")
        for a in flex_list:
            tok = (a.get("token") or "").strip()
            qid = (a.get("query_id") or "").strip()
            if tok and qid:
                entries.append((tok, qid))
        if not entries:
            return {
                "ok": False,
                "error": "No Flex credentials: configure in Settings → IB Connection → Flex (token and query_id with purpose cash_transactions).",
                "count": 0,
            }
        if not control_via_db:
            return {"ok": False, "error": "Postgres config required to write account_transactions.", "count": 0}
        payload = body or {}
        from_date = (payload.get("from_date") or "").strip() or None
        to_date = (payload.get("to_date") or "").strip() or None
        if from_date is None and to_date is None:
            from_date, to_date = reader.get_flex_default_range_dates()
        all_rows: List[Dict[str, Any]] = []
        errors: List[str] = []
        for token, query_id in entries:
            try:
                rows = fetch_cash_transactions(token, query_id, from_date=from_date, to_date=to_date)
                all_rows.extend(rows)
            except ValueError as e:
                errors.append(str(e))
        if errors and not all_rows:
            return {"ok": False, "error": "; ".join(errors), "count": 0}
        if not all_rows:
            return {"ok": True, "count": 0, "message": "No cash transactions in report.", "by_account": len(entries)}
        n = upsert_account_transactions(control_via_db, all_rows)
        msg = f"Upserted {n} transaction(s) from {len(entries)} Flex account(s)."
        if errors:
            msg += " Partial errors: " + "; ".join(errors)
        return {"ok": True, "count": n, "message": msg, "by_account": len(entries)}
    except Exception as e:
        logger.exception("POST /transactions/fetch failed: %s", e)
        return {"ok": False, "error": str(e), "count": 0}


def _rows_span(rows: List[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    from datetime import date as _date

    min_d: Optional[_date] = None
    max_d: Optional[_date] = None
    for r in rows:
        d: Optional[_date] = None
        t_val = r.get("time")
        if isinstance(t_val, (int, float)):
            try:
                d = datetime.fromtimestamp(float(t_val), tz=timezone.utc).date()
            except Exception:
                d = None
        elif isinstance(t_val, datetime):
            try:
                d = t_val.date()
            except Exception:
                d = None
        if d is None:
            td = r.get("trade_date") or r.get("report_date")
            if isinstance(td, _date):
                d = td
        if d is None:
            continue
        if min_d is None or d < min_d:
            min_d = d
        if max_d is None or d > max_d:
            max_d = d
    return (min_d.isoformat() if min_d is not None else None, max_d.isoformat() if max_d is not None else None)


@router.post("/executions/fetch-flex")
def post_executions_fetch_flex(request: Request, body: Dict[str, Any] = Body(default=None)) -> Dict[str, Any]:
    """Fetch executions/trades from IB Flex (Trades report) and upsert into account_executions."""
    reader = request.app.state.reader
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。", "count": 0}
    try:
        entries: List[Dict[str, Any]] = []
        flex_list = reader.get_flex_config(purpose="trades")
        for a in flex_list:
            tok = (a.get("token") or "").strip()
            qid = (a.get("query_id") or "").strip()
            if tok and qid:
                role = (a.get("role") or "").strip() or "unknown"
                label = (a.get("query_label") or "").strip() or None
                entries.append({"token": tok, "query_id": qid, "role": role, "query_label": label})
        if not entries:
            return {
                "ok": False,
                "error": "No Flex credentials for trades: configure in Settings → IB Connection → Flex (token and query_id with purpose=trades).",
                "count": 0,
            }
        payload = body or {}
        from_date = (payload.get("from_date") or "").strip() or None
        to_date = (payload.get("to_date") or "").strip() or None
        range_mode = "manual" if from_date or to_date else "auto"
        range_days = None
        if from_date is None and to_date is None:
            stats_before = reader.get_flex_executions_stats()
            ib_cfg = reader.get_ib_config() or {}
            try:
                default_days = max(1, int(ib_cfg.get("flex_default_range_days", 30)))
            except Exception:
                default_days = 30
            try:
                init_days = max(1, int(ib_cfg.get("flex_init_range_days", 360)))
            except Exception:
                init_days = 360
            yesterday = date.today() - timedelta(days=1)
            to_date = yesterday.strftime("%Y%m%d")
            max_date = stats_before.get("max_date") if stats_before else None
            if not stats_before or (stats_before.get("count") or 0) == 0 or max_date is None:
                start = yesterday - timedelta(days=init_days)
                from_date = start.strftime("%Y%m%d")
                range_mode = "init"
                range_days = init_days
            else:
                try:
                    last_date = getattr(max_date, "date", lambda: max_date)()
                except Exception:
                    last_date = yesterday
                days_since_last = max(0, (yesterday - last_date).days)
                total_days = days_since_last + default_days
                start = yesterday - timedelta(days=total_days)
                from_date = start.strftime("%Y%m%d")
                range_mode = "incremental"
                range_days = total_days

        all_rows = []
        errors = []
        rows_per_fetch = []
        per_query = []
        for i, entry in enumerate(entries):
            token = entry["token"]
            query_id = entry["query_id"]
            role = entry.get("role") or "unknown"
            label = entry.get("query_label")
            try:
                rows = fetch_trades(token, query_id, from_date=from_date, to_date=to_date)
                used_fallback = False
                if not rows:
                    try:
                        rows_fallback = fetch_trades(token, query_id, period=5)
                        if rows_fallback:
                            rows = rows_fallback
                            used_fallback = True
                    except ValueError as e_fallback:
                        errors.append(f"Flex fallback (period=5) {i + 1}/{len(entries)} ({role} {query_id}): {e_fallback}")
                rows_per_fetch.append(len(rows))
                all_rows.extend(rows)
                span_from, span_to = _rows_span(rows)
                per_query.append(
                    {"role": role, "query_id": query_id, "label": label, "rows": len(rows), "data_from": span_from, "data_to": span_to, "used_fallback": used_fallback}
                )
            except ValueError as e:
                rows_per_fetch.append(-1)
                errors.append(f"Flex query {i + 1}/{len(entries)} ({role} {query_id}): {e}")
            except Exception:
                raise

        if errors and not all_rows:
            return {"ok": False, "error": "; ".join(errors), "count": 0, "by_account": len(entries), "by_account_counts": rows_per_fetch}

        data_from = None
        data_to = None
        if all_rows:
            min_d = None
            max_d = None
            for item in per_query:
                s_from = item.get("data_from")
                s_to = item.get("data_to")
                try:
                    if s_from:
                        d_from = datetime.strptime(s_from, "%Y-%m-%d").date()
                        if min_d is None or d_from < min_d:
                            min_d = d_from
                    if s_to:
                        d_to = datetime.strptime(s_to, "%Y-%m-%d").date()
                        if max_d is None or d_to > max_d:
                            max_d = d_to
                except Exception:
                    continue
            if min_d is not None:
                data_from = min_d.isoformat()
            if max_d is not None:
                data_to = max_d.isoformat()

        if not all_rows:
            return {
                "ok": True,
                "count": 0,
                "message": "No trades in Flex report.",
                "by_account": len(entries),
                "by_account_counts": rows_per_fetch,
                "data_from": data_from,
                "data_to": data_to,
                "raw_count": 0,
                "per_query": per_query,
            }

        raw_count = len(all_rows)
        if not write_account_executions_to_db(control_via_db, all_rows):
            return {
                "ok": False,
                "error": "Failed to write account_executions.",
                "count": 0,
                "raw_count": raw_count,
                "data_from": data_from,
                "data_to": data_to,
                "by_account": len(entries),
                "by_account_counts": rows_per_fetch,
                "per_query": per_query,
                "range_mode": range_mode,
                "range_days": range_days,
                "range_from": from_date,
                "range_to": to_date,
            }
        updated_accounts = len({(r.get("account_id") or "").strip() for r in all_rows if (r.get("account_id") or "").strip()})
        stats_after = reader.get_flex_executions_stats()
        last_date_after = stats_after.get("max_date") if stats_after else None
        last_date_after_str = None
        if last_date_after is not None:
            try:
                d = getattr(last_date_after, "date", lambda: last_date_after)()
                last_date_after_str = d.isoformat()
            except Exception:
                last_date_after_str = str(last_date_after)
        msg = f"Upserted {len(all_rows)} execution(s) from {len(entries)} Flex account config row(s); affected {updated_accounts} account(s)."
        if last_date_after_str:
            msg += f" Latest Flex execution date after update: {last_date_after_str}."
        if data_from and data_to:
            msg += f" Flex data time span: {data_from} .. {data_to}."
        if rows_per_fetch and len(rows_per_fetch) > 0 and rows_per_fetch[0] == 0 and (len(rows_per_fetch) == 1 or any(c > 0 for c in rows_per_fetch[1:])):
            msg += " Host (Query ID " + str(entries[0]["query_id"]) + ") returned 0 trades; in Settings > IB Connection > Flex ensure the purpose=trades row uses a Query that includes Activity > Trades and the date range covers your trades."
        if errors:
            msg += " Partial errors: " + "; ".join(errors)
        return {
            "ok": True,
            "count": len(all_rows),
            "raw_count": raw_count,
            "message": msg,
            "by_account": len(entries),
            "by_account_counts": rows_per_fetch,
            "per_query": per_query,
            "updated_accounts": updated_accounts,
            "range_mode": range_mode,
            "range_days": range_days,
            "range_from": from_date,
            "range_to": to_date,
            "last_flex_date_after": last_date_after_str,
            "data_from": data_from,
            "data_to": data_to,
        }
    except Exception as e:
        logger.exception("POST /executions/fetch-flex failed: %s", e)
        return {"ok": False, "error": str(e), "count": 0}


@router.post("/executions/fetch-flex-upload")
def post_executions_fetch_flex_upload(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Upload Flex Trades XML and upsert into account_executions. Body: { \"xml\": \"<FlexStatement ...>...</FlexStatement>\" }"""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。", "count": 0}
    try:
        raw_xml = (body.get("xml") or "").strip()
        if not raw_xml:
            return {"ok": False, "error": "Missing xml field in request body.", "count": 0}
        rows = parse_trades_xml(raw_xml)
        if not rows:
            return {
                "ok": False,
                "error": "No Trade rows parsed from XML. Ensure this is a Flex Trades report (Activity → Trades).",
                "count": 0,
            }
        if not write_account_executions_to_db(control_via_db, rows):
            return {"ok": False, "error": "Failed to write account_executions.", "count": 0}
        updated_accounts = len({(r.get("account_id") or "").strip() for r in rows if (r.get("account_id") or "").strip()})
        return {
            "ok": True,
            "count": len(rows),
            "updated_accounts": updated_accounts,
            "message": f"Upserted {len(rows)} execution(s) from uploaded Flex XML for {updated_accounts} account(s).",
        }
    except Exception as e:
        logger.exception("POST /executions/fetch-flex-upload failed: %s", e)
        return {"ok": False, "error": str(e), "count": 0}


@router.post("/executions")
def post_execution(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Add one execution record manually (history). body: account_id, time, symbol, sec_type, side, quantity, price; optional fields."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。", "account_executions_id": None}
    new_account_executions_id = insert_one_execution(control_via_db, body)
    if new_account_executions_id is None:
        return {"ok": False, "error": "添加执行记录失败（请检查必填项：symbol, quantity, price）。", "account_executions_id": None}
    return {"ok": True, "account_executions_id": new_account_executions_id, "message": "已添加一条执行记录。"}


@router.put("/executions/{execution_id:int}")
def put_execution(request: Request, execution_id: int, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Update one execution by account_executions_id (manual correction)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。"}
    if update_one_execution(control_via_db, execution_id, body):
        return {"ok": True, "message": "已更新执行记录。"}
    return {"ok": False, "error": "更新失败（account_executions_id 不存在或数据库错误）。"}


@router.delete("/executions/{execution_id:int}")
def delete_execution(request: Request, execution_id: int) -> Dict[str, Any]:
    """Delete one execution by account_executions_id."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。"}
    if delete_one_execution(control_via_db, execution_id):
        return {"ok": True, "message": "已删除该条执行记录。"}
    return {"ok": False, "error": "删除失败（account_executions_id 不存在或数据库错误）。"}


@router.post("/executions/fetch")
async def post_executions_fetch(
    request: Request,
    days: int = Query(1, ge=1, le=7, description="1=today, 3=last 3 days, 7=last 7 days (TWS Trade Log)"),
) -> Dict[str, Any]:
    """Fetch executions from IB via monitor AccountIbClient and write to account_executions."""
    app = request.app
    reader = app.state.reader
    control_via_db = app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "需要 postgres 配置以写入 account_executions。", "count": 0}
    if not getattr(app.state, "monitor_enabled", True):
        return {"ok": False, "error": "监控已停止，无法拉取执行记录。", "count": 0}
    client = getattr(app.state, "account_ib_client", None)
    if client is None:
        return {"ok": False, "error": "监控端 AccountIbClient 未初始化。", "count": 0}
    try:
        await client.ensure_connected()
    except Exception as e:
        return {"ok": False, "error": f"连接 IB 失败：{e}", "count": 0}
    await client.set_commission_report_callback(
        lambda eid, c, pnl, cur, y_, yrd: update_execution_commission(control_via_db, eid, c, pnl, cur, y_, yrd)
    )
    try:
        all_execs = await client.fetch_executions(days=days)
    finally:
        try:
            await client.set_commission_report_callback(None)
        except Exception:
            pass
    client_2 = getattr(app.state, "account_ib_client_2", None)
    if client_2 is not None:
        try:
            await client_2.ensure_connected()
            execs_2 = await client_2.fetch_executions(days=days)
            if execs_2:
                all_execs = (all_execs or []) + execs_2
        except Exception as e2:
            logger.warning("executions/fetch AccountIbClient2: %s", e2)
    if not all_execs:
        return {
            "ok": True,
            "message": f"IB 未返回执行记录（当前范围：最近{days}天；若选多天请确认 TWS Trade Log 已勾选对应天数）。",
            "count": 0,
        }
    if not write_account_executions_to_db(control_via_db, all_execs):
        return {"ok": False, "error": "写入 account_executions 失败。", "count": 0}
    return {"ok": True, "count": len(all_execs), "message": f"已写入 {len(all_execs)} 条执行记录。"}
