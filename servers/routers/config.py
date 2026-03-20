"""Config: IB, Flex, position-categories."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict

from servers.reader import (
    write_flex_config,
    write_ib_config,
)
from servers.reader.settings import write_active_strategy_and_gates

logger = logging.getLogger(__name__)

router = APIRouter(tags=["config"])


class IbConfigBody(BaseModel):
    """POST /config/ib body: account/stream IDs only. IB host, port, client IDs live in config.yaml."""

    model_config = ConfigDict(extra="ignore")

    ib_host_account_id: Optional[str] = None
    stream_host_account_id: Optional[str] = None
    stream_secondary_account_id: Optional[str] = None


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


def _optional_account_field(
    body: IbConfigBody,
    field: str,
    current: Dict[str, Any],
) -> Optional[str]:
    fs = getattr(body, "model_fields_set", None) or getattr(body, "__fields_set__", None) or set()
    if field not in fs:
        v = current.get(field)
        if v is None:
            return None
        s = str(v).strip()
        return s or None
    v = getattr(body, field, None)
    if v is None:
        return None
    s = str(v).strip()
    return s or None


@router.post("/config/ib")
def post_config_ib(request: Request, body: IbConfigBody = Body(...)) -> JSONResponse:
    """Persist ib_host_account_id and stream account IDs. IB host/port/client IDs come from config.yaml only."""
    control_via_db = request.app.state.control_via_db
    reader = request.app.state.reader
    if not control_via_db:
        return JSONResponse(status_code=503, content={"error": "control via DB not available (postgres required)"})
    current = reader.get_ib_config() or {}

    host_id = _optional_account_field(body, "ib_host_account_id", current)
    stream_host_id = _optional_account_field(body, "stream_host_account_id", current)
    stream_secondary_id = _optional_account_field(body, "stream_secondary_account_id", current)

    logger.info("[config/ib] writing settings: host_account_id=%r stream_host=%r stream_secondary=%r", host_id, stream_host_id, stream_secondary_id)
    if write_ib_config(control_via_db, host_id, stream_host_id, stream_secondary_id):
        merged = reader.get_ib_config() or {}
        out: Dict[str, Any] = {"ok": True}
        out.update(merged)
        return JSONResponse(status_code=200, content=out)
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
