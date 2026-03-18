"""Config: IB, Flex, position-categories."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from servers.reader import (
    write_flex_config,
    write_ib_config,
)
from servers.reader.settings import write_active_strategy_and_gates

logger = logging.getLogger(__name__)

router = APIRouter(tags=["config"])


class IbConfigBody(BaseModel):
    """POST /config/ib body. Client IDs: Daemon (Trading, Listener), Monitor (Account, Market data), Celery (Market Data). Second IB: Listener + Account only. Stream accounts: for Live page categorization."""
    ib_host: Optional[str] = None
    ib_port_type: Optional[str] = None
    ib_client_id_daemon: Optional[int] = None
    ib_client_id_listener: Optional[int] = None
    ib_client_id_account: Optional[int] = None
    ib_client_id_markets: Optional[int] = None
    ib_client_id_worker_market: Optional[int] = None
    ib_host_account_id: Optional[str] = None
    ib2_host: Optional[str] = None
    ib2_port_type: Optional[str] = None
    ib2_client_id_listener: Optional[int] = None
    ib2_client_id_account: Optional[int] = None
    stream_host_account_id: Optional[str] = None
    stream_secondary_account_id: Optional[str] = None

    class Config:
        extra = "ignore"


class FlexAccountItem(BaseModel):
    """One Flex row: query_host_id (Host IB), query_secondary_id (Second IB, optional)."""
    query_host_id: str
    query_secondary_id: Optional[str] = None
    query_label: Optional[str] = None
    purpose: Optional[str] = "cash_transactions"

    class Config:
        extra = "ignore"


class FlexConfigBody(BaseModel):
    """POST /config/flex body: host_token, secondary_token, accounts, flex_default_range_days, flex_init_range_days."""
    host_token: Optional[str] = None
    secondary_token: Optional[str] = None
    accounts: List[FlexAccountItem] = []
    flex_default_range_days: Optional[int] = None
    flex_init_range_days: Optional[int] = None

    class Config:
        extra = "ignore"


class ActiveStrategyBody(BaseModel):
    """POST /config/active-strategy body: active_strategy_structure_id, active_gate_safety_strategy_id, active_strategy_allocation_id (null to clear)."""
    active_strategy_structure_id: Optional[int] = None
    active_gate_safety_strategy_id: Optional[int] = None
    active_strategy_allocation_id: Optional[int] = None

    class Config:
        extra = "ignore"


@router.post("/config/ib")
def post_config_ib(request: Request, body: IbConfigBody = Body(...)) -> JSONResponse:
    """Update settings: ib_host, ib_port_type, IB client IDs. Daemon loads on next start."""
    control_via_db = request.app.state.control_via_db
    reader = request.app.state.reader
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    current = reader.get_ib_config() or {
        "ib_host": "127.0.0.1",
        "ib_port_type": "tws_paper",
        "ib_client_id_daemon": 1,
        "ib_client_id_listener": 2,
        "ib_client_id_account": 100,
        "ib_client_id_markets": 101,
        "ib_client_id_worker_market": 500,
        "ib_host_account_id": None,
        "ib2_host": None,
        "ib2_port_type": None,
        "ib2_client_id_listener": 3,
        "ib2_client_id_account": 102,
        "stream_host_account_id": None,
        "stream_secondary_account_id": None,
    }
    host = (str(body.ib_host or current.get("ib_host", "127.0.0.1"))).strip() or "127.0.0.1"
    port_type = (str(body.ib_port_type or current.get("ib_port_type", "tws_paper"))).strip().lower() or "tws_paper"
    if port_type not in ("tws_live", "tws_paper", "gateway"):
        port_type = "tws_paper"
    cid_d = body.ib_client_id_daemon if body.ib_client_id_daemon is not None else current.get("ib_client_id_daemon", 1)
    cid_l = body.ib_client_id_listener if body.ib_client_id_listener is not None else current.get("ib_client_id_listener", 2)
    cid_a = body.ib_client_id_account if body.ib_client_id_account is not None else current.get("ib_client_id_account", 100)
    cid_m = body.ib_client_id_markets if body.ib_client_id_markets is not None else current.get("ib_client_id_markets", 101)
    cid_w = body.ib_client_id_worker_market if body.ib_client_id_worker_market is not None else current.get("ib_client_id_worker_market", 500)
    cid_d, cid_l, cid_a, cid_m, cid_w = int(cid_d), int(cid_l), int(cid_a), int(cid_m), int(cid_w)
    host_id = body.ib_host_account_id if body.ib_host_account_id is not None else current.get("ib_host_account_id")
    if host_id is not None:
        host_id = (str(host_id)).strip() or None
    ib2_h = body.ib2_host if body.ib2_host is not None else current.get("ib2_host")
    if ib2_h is not None:
        ib2_h = (str(ib2_h)).strip() or None
    ib2_pt = body.ib2_port_type if body.ib2_port_type is not None else current.get("ib2_port_type")
    if ib2_pt is not None:
        ib2_pt = (str(ib2_pt)).strip().lower() or None
    cid2_l = body.ib2_client_id_listener if body.ib2_client_id_listener is not None else current.get("ib2_client_id_listener", 3)
    cid2_a = body.ib2_client_id_account if body.ib2_client_id_account is not None else current.get("ib2_client_id_account", 102)
    cid2_l = int(cid2_l) if cid2_l is not None else 3
    cid2_a = int(cid2_a) if cid2_a is not None else 102
    stream_host_id = body.stream_host_account_id if body.stream_host_account_id is not None else current.get("stream_host_account_id")
    stream_secondary_id = body.stream_secondary_account_id if body.stream_secondary_account_id is not None else current.get("stream_secondary_account_id")
    if stream_host_id is not None:
        stream_host_id = (str(stream_host_id)).strip() or None
    if stream_secondary_id is not None:
        stream_secondary_id = (str(stream_secondary_id)).strip() or None
    logger.info(
        "[config/ib] writing settings: host=%r port_type=%r ... ib2_host=%r ib2_port_type=%r",
        host, port_type, ib2_h, ib2_pt,
    )
    if write_ib_config(control_via_db, host, port_type, cid_d, cid_l, cid_a, cid_m, cid_w, host_id, ib2_h, ib2_pt, cid2_l, cid2_a, stream_host_id, stream_secondary_id):
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "ib_host": host,
                "ib_port_type": port_type,
                "ib_client_id_daemon": cid_d,
                "ib_client_id_listener": cid_l,
                "ib_client_id_account": cid_a,
                "ib_client_id_markets": cid_m,
                "ib_client_id_worker_market": cid_w,
                "ib_host_account_id": host_id,
                "ib2_host": ib2_h,
                "ib2_port_type": ib2_pt,
                "ib2_client_id_listener": cid2_l,
                "ib2_client_id_account": cid2_a,
                "stream_host_account_id": stream_host_id,
                "stream_secondary_account_id": stream_secondary_id,
            },
        )
    return JSONResponse(status_code=500, content={"error": "failed to write settings"})


@router.post("/config/flex")
def post_config_flex(request: Request, body: FlexConfigBody = Body(...)) -> JSONResponse:
    """Update settings (ib_flex_host_token, ib_flex_secondary_token) and settings_ib_flex rows."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    accounts = []
    for a in body.accounts or []:
        qh = (a.query_host_id or "").strip()
        if not qh:
            continue
        accounts.append({
            "query_host_id": qh,
            "query_secondary_id": (a.query_secondary_id or "").strip() or None,
            "query_label": (a.query_label or "").strip() or None,
            "purpose": (a.purpose or "cash_transactions").strip() or "cash_transactions",
        })
    if write_flex_config(control_via_db, body.host_token, body.secondary_token, accounts, body.flex_default_range_days, body.flex_init_range_days):
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "host_token": body.host_token,
                "secondary_token": body.secondary_token,
                "accounts": accounts,
                "flex_default_range_days": body.flex_default_range_days,
                "flex_init_range_days": body.flex_init_range_days,
            },
        )
    return JSONResponse(status_code=500, content={"error": "failed to write flex config"})


@router.post("/config/active-strategy")
def post_config_active_strategy(request: Request, body: ActiveStrategyBody = Body(...)) -> JSONResponse:
    """Update settings: active_strategy_structure_id, active_gate_safety_strategy_id, active_strategy_allocation_id (null to clear). Daemon uses these on next start when loading gates from DB."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    if write_active_strategy_and_gates(
        control_via_db,
        active_strategy_structure_id=body.active_strategy_structure_id,
        active_gate_safety_strategy_id=body.active_gate_safety_strategy_id,
        active_strategy_allocation_id=body.active_strategy_allocation_id,
    ):
        return JSONResponse(
            status_code=200,
            content={
                "ok": True,
                "active_strategy_structure_id": body.active_strategy_structure_id,
                "active_gate_safety_strategy_id": body.active_gate_safety_strategy_id,
                "active_strategy_allocation_id": body.active_strategy_allocation_id,
            },
        )
    return JSONResponse(status_code=500, content={"error": "failed to write active strategy and gates"})


# --- position-categories ---

@router.get("/position-categories")
def get_position_categories(request: Request) -> Dict[str, Any]:
    """Return all position_categories rows (for dropdown and manage UI)."""
    reader = request.app.state.reader
    items = reader.get_position_categories()
    return {"ok": True, "items": items}


@router.post("/position-categories")
def post_position_category(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Create one position category. body: name (required), description, sort_order."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required.", "id": None}
    reader = request.app.state.reader
    b = body or {}
    name = (b.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name is required.", "id": None}
    gid = reader.create_position_category(
        name=name,
        description=b.get("description"),
        sort_order=b.get("sort_order"),
    )
    if gid is not None:
        return {"ok": True, "id": gid, "name": name}
    return {"ok": False, "error": "Failed to create category.", "id": None}


@router.patch("/position-categories/{category_id:int}")
def patch_position_category(request: Request, category_id: int, body: Dict[str, Any] = Body(default=None)) -> Dict[str, Any]:
    """Update one position category by id. body: name, description, sort_order (optional)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required."}
    reader = request.app.state.reader
    b = body or {}
    if reader.update_position_category(
        category_id,
        name=b.get("name"),
        description=b.get("description"),
        sort_order=b.get("sort_order"),
    ):
        return {"ok": True, "id": category_id}
    return {"ok": False, "error": "Failed to update category."}


@router.delete("/position-categories/{category_id:int}")
def delete_position_category(request: Request, category_id: int) -> Dict[str, Any]:
    """Delete one position category by id (tags removed by CASCADE)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required."}
    reader = request.app.state.reader
    if reader.delete_position_category(category_id):
        return {"ok": True, "id": category_id}
    return {"ok": False, "error": "Failed to delete category."}


@router.patch("/executions/strategy-attribution")
def patch_execution_strategy_attribution(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Batch update strategy attribution on executions (replaces old PUT /positions/strategy).
    body: account_id (required), contract_key OR execution_ids[], strategy_opportunity_id, strategy_instance_id."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required."}
    reader = request.app.state.reader
    b = body or {}
    account_id = (b.get("account_id") or "").strip()
    if not account_id:
        return {"ok": False, "error": "account_id is required."}
    contract_key = (b.get("contract_key") or "").strip() or None
    execution_ids = b.get("execution_ids")
    if isinstance(execution_ids, list):
        execution_ids = [int(x) for x in execution_ids if x is not None]
    else:
        execution_ids = None
    if not contract_key and not execution_ids:
        return {"ok": False, "error": "contract_key or execution_ids is required."}
    so_id = b.get("strategy_opportunity_id")
    si_id = b.get("strategy_instance_id")
    if so_id is not None:
        try:
            so_id = int(so_id)
        except (TypeError, ValueError):
            so_id = None
    if si_id is not None:
        try:
            si_id = int(si_id)
        except (TypeError, ValueError):
            si_id = None
    count = reader.batch_update_execution_strategy(account_id, contract_key, execution_ids, so_id, si_id)
    if count > 0:
        return {"ok": True, "updated": count}
    return {"ok": False, "error": "No matching executions found or update failed.", "updated": 0}


@router.put("/position-categories/tag")
def put_position_category_tag(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Tag a position with a category (STK). Pass category_id null to clear tag. body: account_id, contract_key, category_id."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required."}
    reader = request.app.state.reader
    b = body or {}
    account_id = (b.get("account_id") or "").strip()
    contract_key = (b.get("contract_key") or "").strip()
    category_id = b.get("category_id")
    if not account_id:
        return {"ok": False, "error": "account_id is required."}
    if not contract_key:
        return {"ok": False, "error": "contract_key is required."}
    if category_id is not None:
        try:
            category_id = int(category_id)
        except (TypeError, ValueError):
            category_id = None
    if reader.set_position_category_tag(account_id, contract_key, category_id):
        return {"ok": True}
    return {"ok": False, "error": "Failed to set tag."}


@router.get("/position-categories/symbol-order")
def get_market_streams_symbol_order(request: Request) -> Dict[str, Any]:
    """Return category_name -> ordered list of symbols (Market Streams custom symbol order)."""
    reader = request.app.state.reader
    order = reader.get_market_streams_symbol_order()
    return {"ok": True, "order": order}


@router.put("/position-categories/symbol-order")
def put_market_streams_symbol_order(request: Request, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Save symbol order for one category. body: category_name (required), symbols (array of symbol strings)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required."}
    reader = request.app.state.reader
    b = body or {}
    category_name = (b.get("category_name") or "").strip()
    symbols = b.get("symbols")
    if not category_name:
        return {"ok": False, "error": "category_name is required."}
    if not isinstance(symbols, list):
        return {"ok": False, "error": "symbols must be an array."}
    if reader.set_market_streams_symbol_order(category_name, symbols):
        return {"ok": True}
    return {"ok": False, "error": "Failed to save symbol order."}
