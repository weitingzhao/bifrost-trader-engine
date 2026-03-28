"""Executions and transactions: CRUD, Flex fetch, IB fetch, performance."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, HTTPException, Query, Request

from src.portfolio.services.executions_fetch_flex import (
    fetch_flex_trades_and_upsert_executions,
    upsert_executions_from_uploaded_flex_xml,
)
from src.portfolio.services.transactions_fetch import fetch_cash_transactions_from_flex
from src.monitor.reader import (
    write_account_executions_to_db,
    update_execution_commission,
    insert_one_execution,
    update_one_execution,
    delete_one_execution,
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
    source_scope: Optional[str] = Query(
        None,
        description="Optional: all (default, full account_executions) | performance_book (account_executions_final) | on_the_fly (account_executions_fly: TWS not covered by final, no BAG) | tws_raw (executions_raw_tws only, synthetic negative account_executions_id)",
    ),
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
            source_scope=source_scope,
        )
    items = reader.get_executions(
        since_ts=since_ts,
        until_ts=until_ts,
        account_id=account_id,
        limit=effective_limit,
        strategy_opportunity_id=strategy_opportunity_id,
        strategy_instance_id=strategy_instance_id,
        source_scope=source_scope,
    )
    return {"executions": items}


@router.get("/executions/position-attribution")
def get_position_attribution(
    request: Request,
    account_id: Optional[str] = Query(None, description="Filter by account ID"),
    sec_type: Optional[str] = Query(None, description="Filter by sec_type (e.g. OPT, STK)"),
) -> Dict[str, Any]:
    """Position × Instance attribution (net-estimated). Returns one row per (position, instance)."""
    reader = request.app.state.reader
    items = reader.get_position_instance_attribution(
        account_id=account_id,
        sec_type_filter=sec_type,
    )
    return {"attributions": items}


@router.get("/executions/link-candidates")
def get_executions_link_candidates(
    request: Request,
    account_id: str = Query(..., description="IB account id"),
    contract_key: Optional[str] = Query(None, description="Exact contract_key match (preferred)"),
    symbol: Optional[str] = Query(None),
    expiry: Optional[str] = Query(None, description="Option expiry (any format; used if contract_key yields no rows)"),
    strike: Optional[float] = Query(None),
    option_right: Optional[str] = Query(None, description="C or P"),
    limit: int = Query(200, ge=1, le=500),
) -> Dict[str, Any]:
    """Existing account_executions rows to link strategy attribution (no insert)."""
    reader = request.app.state.reader
    if not (contract_key and contract_key.strip()) and (
        not (symbol and symbol.strip()) or strike is None or expiry is None or str(expiry).strip() == ""
    ):
        return {
            "executions": [],
            "error": "Provide contract_key, or symbol+expiry+strike for fallback matching.",
        }
    items = reader.get_executions_for_strategy_link(
        account_id=account_id.strip(),
        contract_key=(contract_key or "").strip() or None,
        symbol=(symbol or "").strip() or None,
        expiry=expiry,
        strike=strike,
        option_right=(option_right or "").strip() or None,
        limit=limit,
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
    source_scope: str = Query(
        "performance_book",
        description="performance_book (default, account_executions_final) | on_the_fly (account_executions_fly)",
    ),
    summary_only: bool = Query(
        False,
        description="With strategy_instance_id only: return summary via one SQL aggregate (fast)",
    ),
) -> Dict[str, Any]:
    """Performance stats and calendar PnL. Default source_scope=performance_book reads account_executions_final (flex+journal only)."""
    reader = request.app.state.reader
    if summary_only:
        if strategy_instance_id is None:
            raise HTTPException(status_code=400, detail="summary_only requires strategy_instance_id")
        if (account_id is not None and str(account_id).strip()) or strategy_opportunity_id is not None:
            raise HTTPException(
                status_code=400,
                detail="summary_only allows only strategy_instance_id (no account_id / opportunity filter)",
            )
        out = reader.get_performance_instance_summary(
            strategy_instance_id=strategy_instance_id,
            since_ts=since_ts,
            until_ts=until_ts,
        )
        return out
    out = reader.get_performance_stats(
        since_ts=since_ts,
        until_ts=until_ts,
        account_id=account_id,
        granularity=granularity,
        strategy_opportunity_id=strategy_opportunity_id,
        strategy_instance_id=strategy_instance_id,
        source_scope=source_scope,
    )
    return out


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
    return fetch_cash_transactions_from_flex(reader, control_via_db, body)


@router.post("/executions/fetch-flex")
def post_executions_fetch_flex(request: Request, body: Dict[str, Any] = Body(default=None)) -> Dict[str, Any]:
    """Fetch executions/trades from IB Flex (Trades report) and upsert into account_executions."""
    reader = request.app.state.reader
    control_via_db = request.app.state.control_via_db
    return fetch_flex_trades_and_upsert_executions(reader, control_via_db, body)


@router.post("/executions/fetch-flex-upload")
def post_executions_fetch_flex_upload(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Upload Flex Trades XML and upsert into account_executions. Body: { \"xml\": \"<FlexStatement ...>...</FlexStatement>\" }"""
    control_via_db = request.app.state.control_via_db
    raw_xml = (body.get("xml") or "").strip()
    return upsert_executions_from_uploaded_flex_xml(control_via_db, raw_xml)


@router.post("/executions")
def post_execution(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Add one execution record manually (history). body: account_id, time, symbol, sec_type, side, quantity, price; optional fields."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "PostgreSQL is required to write account_executions.", "account_executions_id": None}
    new_account_executions_id = insert_one_execution(control_via_db, body)
    if new_account_executions_id is None:
        return {"ok": False, "error": "Failed to add execution (required fields: symbol, quantity, price).", "account_executions_id": None}
    return {"ok": True, "account_executions_id": new_account_executions_id, "message": "Execution record added."}


def _parse_account_executions_path_id(execution_id: str) -> int:
    """Path segment for account_executions_id (flex >0, TWS <0, journal <= -1e9). Starlette's :int only matches [0-9]+, so negative ids must be parsed here."""
    try:
        return int(str(execution_id).strip())
    except (TypeError, ValueError) as e:
        raise HTTPException(status_code=422, detail="Invalid execution id") from e


@router.put("/executions/{execution_id}")
def put_execution(request: Request, execution_id: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Update one execution by account_executions_id (manual correction). Negative ids = TWS raw rows."""
    eid = _parse_account_executions_path_id(execution_id)
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "PostgreSQL is required to write account_executions."}
    if update_one_execution(control_via_db, eid, body):
        return {"ok": True, "message": "Execution record updated."}
    return {"ok": False, "error": "Update failed (account_executions_id missing or database error)."}


@router.delete("/executions/{execution_id}")
def delete_execution(request: Request, execution_id: str) -> Dict[str, Any]:
    """Delete one execution by account_executions_id. Negative ids = TWS raw rows."""
    eid = _parse_account_executions_path_id(execution_id)
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "PostgreSQL is required to write account_executions."}
    if delete_one_execution(control_via_db, eid):
        return {"ok": True, "message": "Execution record deleted."}
    return {"ok": False, "error": "Delete failed (account_executions_id missing or database error)."}


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
        return {"ok": False, "error": "PostgreSQL is required to write account_executions.", "count": 0}
    if not getattr(app.state, "monitor_enabled", True):
        return {"ok": False, "error": "Monitor stopped; cannot fetch executions.", "count": 0}
    client = getattr(app.state, "account_ib_client", None)
    if client is None:
        return {"ok": False, "error": "AccountIbClient is not initialized.", "count": 0}
    try:
        await client.ensure_connected()
    except Exception as e:
        return {"ok": False, "error": f"Failed to connect to IB: {e}", "count": 0}
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
            "message": f"IB returned no executions (range: last {days} day(s); for a multi-day range ensure TWS Trade Log includes those days).",
            "count": 0,
        }
    if not write_account_executions_to_db(control_via_db, all_execs):
        return {"ok": False, "error": "Failed to write account_executions.", "count": 0}
    return {"ok": True, "count": len(all_execs), "message": f"Wrote {len(all_execs)} execution record(s)."}
