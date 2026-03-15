"""Phase A: Strategy structures and strategy_history API for management and monitoring."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from servers.reader import gate_safety_write as gate_safety_write_module
from servers.reader import strategy_allocation_write as strategy_allocation_write_module
from servers.reader import strategy_opportunity_write as strategy_opportunity_write_module
from servers.reader import strategy_structure_write as strategy_structure_write_module

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/strategies", tags=["strategies"])


class EntryConditionBody(BaseModel):
    """One entry condition row for opportunity create/update."""

    condition_type: str = Field(..., description="e.g. iv_min, iv_max, dte_min, dte_max, earnings_blackout_days, min_volume")
    value_text: Optional[str] = None
    value_numeric: Optional[float] = None


class OpportunityBody(BaseModel):
    """Request body for create strategy opportunity (scope_type + symbols + entry_conditions, no jsonb)."""

    name: str = Field(..., min_length=1)
    strategy_structure_id: int
    default_gate_safety_strategy_id: Optional[int] = None
    scope_type: Optional[str] = Field(None, description="e.g. watchlist_stk, explicit_symbols")
    symbols: Optional[List[str]] = Field(default_factory=list, description="Symbol list when scope_type is explicit_symbols")
    entry_conditions: Optional[List[EntryConditionBody]] = Field(default_factory=list)
    is_active: bool = True


class OpportunityUpdateBody(BaseModel):
    """Request body for update strategy opportunity; all fields optional for partial update."""

    name: Optional[str] = Field(None, min_length=1)
    strategy_structure_id: Optional[int] = None
    default_gate_safety_strategy_id: Optional[int] = None
    scope_type: Optional[str] = None
    symbols: Optional[List[str]] = None
    entry_conditions: Optional[List[EntryConditionBody]] = None
    is_active: Optional[bool] = None


class AllocationBody(BaseModel):
    """Request body for create strategy allocation."""

    name: str = Field(..., min_length=1)
    strategy_opportunity_ids: List[int] = Field(..., description="List of strategy_opportunity_id")
    gate_safety_strategy_id: Optional[int] = None
    allocation_limits: Optional[Dict[str, Any]] = Field(None, description="e.g. max_positions, max_bp_pct")
    is_active: bool = True


class AllocationUpdateBody(BaseModel):
    """Request body for update strategy allocation; all fields optional for partial update."""

    name: Optional[str] = Field(None, min_length=1)
    strategy_opportunity_ids: Optional[List[int]] = None
    gate_safety_strategy_id: Optional[int] = None
    allocation_limits: Optional[Dict[str, Any]] = None
    is_active: Optional[bool] = None


@router.get("/structures")
def list_structures(
    request: Request,
    active_only: bool = Query(True, description="If true, return only active structures"),
) -> Dict[str, Any]:
    """Return list of strategy_structure rows for management dropdown."""
    reader = request.app.state.reader
    items: List[Dict[str, Any]] = reader.list_structures(active_only=active_only)
    return {"items": items}


@router.get("/structures/{structure_id}")
def get_structure(request: Request, structure_id: int) -> Dict[str, Any]:
    """Return one strategy_structure row by id. 404 if not found."""
    reader = request.app.state.reader
    row = reader.get_structure_by_id(structure_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Structure not found")
    return row


@router.post("/structures")
def create_structure_endpoint(request: Request, body: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new strategy structure. Body: name, structure_type, legs (array), optional constraints, version, is_active, metadata."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    try:
        sid = strategy_structure_write_module.create_structure(control_via_db, body)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if sid is None:
        raise HTTPException(status_code=500, detail="Failed to create structure")
    return {"strategy_structure_id": sid}


@router.put("/structures/{structure_id}")
def update_structure_endpoint(request: Request, structure_id: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Update an existing strategy structure. Body same as POST."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    try:
        ok = strategy_structure_write_module.update_structure(control_via_db, structure_id, body)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Structure not found or update failed")
    return {"ok": True}


@router.get("/opportunities")
def list_opportunities(
    request: Request,
    active_only: bool = Query(True, description="If true, return only active opportunities"),
) -> Dict[str, Any]:
    """Return list of strategy_opportunity rows for management."""
    reader = request.app.state.reader
    items: List[Dict[str, Any]] = reader.list_opportunities(active_only=active_only)
    return {"items": items}


@router.get("/opportunities/{opportunity_id}")
def get_opportunity(request: Request, opportunity_id: int) -> Dict[str, Any]:
    """Return one strategy_opportunity row by id. 404 if not found."""
    reader = request.app.state.reader
    row = reader.get_opportunity_by_id(opportunity_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Opportunity not found")
    return row


@router.post("/opportunities")
def create_opportunity_endpoint(request: Request, body: OpportunityBody) -> Dict[str, Any]:
    """Create a new strategy opportunity. Body: name (required), strategy_structure_id (required), optional default_gate_safety_strategy_id, scope_type (e.g. watchlist_stk | explicit_symbols), symbols (array of strings), entry_conditions (array of { condition_type, value_text?, value_numeric? }), is_active."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    payload = body.model_dump()
    payload["entry_conditions"] = [c.model_dump() for c in (body.entry_conditions or [])]
    try:
        oid = strategy_opportunity_write_module.create_opportunity(control_via_db, payload)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if oid is None:
        raise HTTPException(status_code=500, detail="Failed to create opportunity")
    return {"strategy_opportunity_id": oid}


@router.put("/opportunities/{opportunity_id}")
def update_opportunity_endpoint(request: Request, opportunity_id: int, body: OpportunityUpdateBody) -> Dict[str, Any]:
    """Update an existing strategy opportunity. Body same as POST: name, strategy_structure_id, optional default_gate_safety_strategy_id, scope_type, symbols, entry_conditions, is_active (partial update supported)."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    payload = body.model_dump(exclude_unset=True)
    if "entry_conditions" in payload:
        payload["entry_conditions"] = [c.model_dump() for c in (body.entry_conditions or [])]
    try:
        ok = strategy_opportunity_write_module.update_opportunity(control_via_db, opportunity_id, payload)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Opportunity not found or update failed")
    return {"ok": True}


@router.get("/allocations")
def list_allocations(
    request: Request,
    active_only: bool = Query(True, description="If true, return only active allocations"),
) -> Dict[str, Any]:
    """Return list of strategy_allocation rows for management."""
    reader = request.app.state.reader
    items: List[Dict[str, Any]] = reader.list_allocations(active_only=active_only)
    return {"items": items}


@router.get("/allocations/{allocation_id}")
def get_allocation(request: Request, allocation_id: int) -> Dict[str, Any]:
    """Return one strategy_allocation row by id. 404 if not found."""
    reader = request.app.state.reader
    row = reader.get_allocation_by_id(allocation_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Allocation not found")
    return row


@router.post("/allocations")
def create_allocation_endpoint(request: Request, body: AllocationBody) -> Dict[str, Any]:
    """Create a new strategy allocation. Body: name, strategy_opportunity_ids, optional gate_safety_strategy_id, allocation_limits, is_active."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    payload = body.model_dump()
    try:
        aid = strategy_allocation_write_module.create_allocation(control_via_db, payload)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if aid is None:
        raise HTTPException(status_code=500, detail="Failed to create allocation")
    return {"strategy_allocation_id": aid}


@router.put("/allocations/{allocation_id}")
def update_allocation_endpoint(request: Request, allocation_id: int, body: AllocationUpdateBody) -> Dict[str, Any]:
    """Update an existing strategy allocation. Partial update supported."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    payload = body.model_dump(exclude_unset=True)
    try:
        ok = strategy_allocation_write_module.update_allocation(control_via_db, allocation_id, payload)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Allocation not found or update failed")
    return {"ok": True}


@router.get("/history")
def get_strategy_history(
    request: Request,
    from_ts: Optional[float] = Query(None, description="Filter history with ts >= this (Unix)"),
    to_ts: Optional[float] = Query(None, description="Filter history with ts <= this (Unix)"),
    strategy_structure_id: Optional[int] = Query(None, description="Filter by structure id"),
    limit: int = Query(100, ge=1, le=500, description="Max rows to return"),
) -> Dict[str, Any]:
    """Return strategy_history rows for monitoring and strategy usage."""
    reader = request.app.state.reader
    items = reader.get_strategy_history(
        from_ts=from_ts,
        to_ts=to_ts,
        strategy_structure_id=strategy_structure_id,
        limit=limit,
    )
    return {"items": items}


@router.get("/gate-safety")
def list_gate_safety(request: Request) -> Dict[str, Any]:
    """Return list of gate_safety_strategy rows for management dropdown."""
    reader = request.app.state.reader
    items = reader.list_gate_safety_sets()
    return {"items": items}


@router.get("/gate-safety/{gate_safety_id}")
def get_gate_safety_by_id(request: Request, gate_safety_id: int) -> Dict[str, Any]:
    """Return full gate set for UI edit: metadata + gates + earnings_dates. 404 if not found."""
    reader = request.app.state.reader
    full = reader.get_gate_safety_full_by_id(gate_safety_id)
    if full is None:
        raise HTTPException(status_code=404, detail="Gate safety set not found")
    return full


@router.post("/gate-safety")
def create_gate_safety_endpoint(request: Request, body: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new gate safety set. Body: name, optional version/structure_type/is_active, gates, optional earnings_dates."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        gid = gate_safety_write_module.create_gate_safety(control_via_db, body)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}") from e
    if gid is None:
        raise HTTPException(status_code=500, detail="Failed to create gate safety set")
    return {"gate_safety_strategy_id": gid}


@router.put("/gate-safety/{gate_safety_id}")
def update_gate_safety_endpoint(request: Request, gate_safety_id: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Update an existing gate safety set. Body same as POST."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    name = (body.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    try:
        ok = gate_safety_write_module.update_gate_safety(control_via_db, gate_safety_id, body)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid payload: {e}") from e
    if not ok:
        raise HTTPException(status_code=404, detail="Gate safety set not found or update failed")
    return {"ok": True}
