"""Phase A: Strategy structures and strategy_history API for management and monitoring."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from servers.reader import gate_safety_write as gate_safety_write_module
from servers.reader import strategy_allocation_write as strategy_allocation_write_module
from servers.reader import strategy_opportunity_write as strategy_opportunity_write_module
from servers.reader import strategy_structure_write as strategy_structure_write_module
from servers.reader import structure_type_config as structure_type_config_module
from servers.reader import structure_type_config_constants as structure_type_config_constants_module
from servers.reader import structure_type_config_write as structure_type_config_write_module

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


@router.get("/structure-types")
def list_structure_types_endpoint(request: Request) -> Dict[str, Any]:
    """Return structure types from config table for Wizard Step 1 (display_label, sort_order, has_subtypes)."""
    reader = request.app.state.reader
    items: List[Dict[str, Any]] = reader.list_structure_types()
    return {"items": items}


@router.get("/structure-types/param-kind-options")
def get_param_kind_options_endpoint() -> Dict[str, Any]:
    """Return allowed param_kind values with display labels for Type Config UI. options: [{ value, label }]."""
    options = structure_type_config_constants_module.get_param_kind_options_with_labels()
    return {"options": options}


@router.get("/structure-types/leg-role-options")
def get_leg_role_options_endpoint() -> Dict[str, Any]:
    """Return allowed leg role values with display labels for Type Config Default legs. options: [{ value, label }]."""
    options = structure_type_config_constants_module.get_leg_role_options_with_labels()
    return {"options": options}


@router.get("/structure-types/leg-direction-options")
def get_leg_direction_options_endpoint() -> Dict[str, Any]:
    """Return allowed leg direction values with display labels for Type Config Default legs. options: [{ value, label }]."""
    options = structure_type_config_constants_module.get_leg_direction_options_with_labels()
    return {"options": options}


@router.get("/structure-types/leg-option-right-options")
def get_leg_option_right_options_endpoint() -> Dict[str, Any]:
    """Return allowed leg option_right values (empty = stock) with display labels. options: [{ value, label }]."""
    options = structure_type_config_constants_module.get_leg_option_right_options_with_labels()
    return {"options": options}


@router.get("/structure-types/{structure_type}/default-legs")
def get_structure_type_default_legs(request: Request, structure_type: str) -> Dict[str, Any]:
    """Return default legs for the given structure type from config table (strategy_structure_type_leg)."""
    reader = request.app.state.reader
    legs = reader.get_structure_type_default_legs(structure_type)
    return {"legs": legs}


@router.get("/structure-types/{structure_type}/subtypes")
def get_structure_type_subtypes(request: Request, structure_type: str) -> Dict[str, Any]:
    """Return subtypes with characteristics and meta_params, plus infer_rules for Wizard Step 2 / Edit."""
    reader = request.app.state.reader
    data = reader.get_structure_type_subtypes(structure_type)
    return data


@router.get("/structure-types/{structure_type}/meta-key-options")
def get_meta_key_options_endpoint(structure_type: str) -> Dict[str, Any]:
    """Return allowed meta_key values with display labels for the structure type. options: [{ value, label }]."""
    options = structure_type_config_constants_module.get_meta_key_options_with_labels(structure_type)
    return {"options": options}


@router.get("/structure-types/{structure_type}/meta-value-options")
def get_meta_value_options_endpoint(
    structure_type: str, meta_key: str = Query(..., description="meta_key to get allowed values for")
) -> Dict[str, Any]:
    """Return allowed meta_value_text with display labels for (structure_type, meta_key). options: [{ value, label }]."""
    options = structure_type_config_constants_module.get_meta_value_options_with_labels(
        structure_type, meta_key
    )
    return {"options": options}


@router.get("/structure-types/{structure_type}/subtypes/{subtype}/default-legs")
def get_structure_subtype_default_legs(
    request: Request, structure_type: str, subtype: str
) -> Dict[str, Any]:
    """Return default legs for the given (structure_type, subtype).

    If subtype has its own legs (strategy_structure_subtype_leg), use those; otherwise fall back to type-level legs.
    """
    reader = request.app.state.reader
    conn = getattr(reader, "_conn", None)
    if conn is None:
        # Fall back to reader-level helper if available; otherwise return type-level legs only.
        legs = reader.get_structure_type_default_legs(structure_type)
        return {"legs": legs}
    legs = structure_type_config_module.get_default_legs_for_subtype(conn, structure_type, subtype)
    return {"legs": legs}


@router.put("/structure-types/{structure_type}/subtypes/{subtype}/default-legs")
def replace_structure_subtype_legs_endpoint(
    request: Request, structure_type: str, subtype: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Replace default legs for the subtype. Body: legs (list of role, direction, option_right, quantity_default?, sort_order?). Empty list = inherit type-level legs."""
    config = _require_control_via_db(request)
    legs = body.get("legs")
    if not isinstance(legs, list):
        raise HTTPException(status_code=400, detail="legs array is required")
    try:
        structure_type_config_write_module.replace_structure_subtype_legs(
            config, structure_type, subtype, legs
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


def _require_control_via_db(request: Request) -> Optional[dict]:
    """Return control_via_db config or raise 503."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    return control_via_db


@router.post("/structure-types")
def create_structure_type_endpoint(request: Request, body: Dict[str, Any]) -> Dict[str, Any]:
    """Create a new structure type. Body: structure_type, display_label, sort_order, has_subtypes, type_explanation."""
    config = _require_control_via_db(request)
    try:
        structure_type_config_write_module.create_structure_type(config, body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"structure_type": (body.get("structure_type") or "").strip()}


@router.put("/structure-types/{structure_type}")
def update_structure_type_endpoint(
    request: Request, structure_type: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Update structure type. Body: display_label?, sort_order?, has_subtypes?, type_explanation?."""
    config = _require_control_via_db(request)
    try:
        ok = structure_type_config_write_module.update_structure_type(
            config, structure_type, body
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Structure type not found")
    return {"ok": True}


@router.delete("/structure-types/{structure_type}")
def delete_structure_type_endpoint(request: Request, structure_type: str) -> Dict[str, Any]:
    """Delete structure type. Fails if referenced by strategy_structure or gate_safety_strategy."""
    config = _require_control_via_db(request)
    try:
        ok = structure_type_config_write_module.delete_structure_type(config, structure_type)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Structure type not found")
    return {"ok": True}


@router.put("/structure-types/{structure_type}/default-legs")
def replace_structure_type_legs_endpoint(
    request: Request, structure_type: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Replace default legs for the structure type. Body: legs (list of role, direction, option_right, quantity_default?, sort_order?)."""
    config = _require_control_via_db(request)
    legs = body.get("legs")
    if not isinstance(legs, list):
        raise HTTPException(status_code=400, detail="legs array is required")
    try:
        structure_type_config_write_module.replace_structure_type_legs(
            config, structure_type, legs
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.post("/structure-types/{structure_type}/subtypes")
def create_subtype_endpoint(
    request: Request, structure_type: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Create a new subtype. Body: subtype, display_label?, example?, typical_use?, subtype_explanation?, nature?, sort_order?."""
    config = _require_control_via_db(request)
    try:
        structure_type_config_write_module.create_subtype(config, structure_type, body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"subtype": (body.get("subtype") or "").strip()}


@router.put("/structure-types/{structure_type}/subtypes/{subtype}")
def update_subtype_endpoint(
    request: Request, structure_type: str, subtype: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Update subtype. Body: display_label?, example?, typical_use?, subtype_explanation?, nature?, sort_order?."""
    config = _require_control_via_db(request)
    try:
        ok = structure_type_config_write_module.update_subtype(
            config, structure_type, subtype, body
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Subtype not found")
    return {"ok": True}


@router.delete("/structure-types/{structure_type}/subtypes/{subtype}")
def delete_subtype_endpoint(
    request: Request, structure_type: str, subtype: str
) -> Dict[str, Any]:
    """Delete subtype and its characteristics, meta_params, and infer rules."""
    config = _require_control_via_db(request)
    try:
        ok = structure_type_config_write_module.delete_subtype(
            config, structure_type, subtype
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Subtype not found")
    return {"ok": True}


@router.put("/structure-types/{structure_type}/subtypes/{subtype}/characteristics")
def replace_subtype_characteristics_endpoint(
    request: Request, structure_type: str, subtype: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Replace characteristics for the subtype. Body: items (list of strings)."""
    config = _require_control_via_db(request)
    items = body.get("items")
    if items is not None and not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be an array")
    try:
        structure_type_config_write_module.replace_subtype_characteristics(
            config, structure_type, subtype, items or []
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.put("/structure-types/{structure_type}/subtypes/{subtype}/meta-params")
def replace_subtype_meta_params_endpoint(
    request: Request, structure_type: str, subtype: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Replace meta params for the subtype. Body: items (list of { meta_key, display_label?, default_value_text?, param_kind?, sort_order? })."""
    config = _require_control_via_db(request)
    items = body.get("items")
    if items is not None and not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be an array")
    try:
        structure_type_config_write_module.replace_subtype_meta_params(
            config, structure_type, subtype, items or []
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.put("/structure-types/{structure_type}/infer-rules")
def replace_infer_rules_endpoint(
    request: Request, structure_type: str, body: Dict[str, Any]
) -> Dict[str, Any]:
    """Replace infer rules for the structure type. Body: items (list of { meta_key, meta_value_text, subtype })."""
    config = _require_control_via_db(request)
    items = body.get("items")
    if items is not None and not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be an array")
    try:
        structure_type_config_write_module.replace_subtype_infer_rules(
            config, structure_type, items or []
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


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
    """Create a new strategy structure.

    Body: name, structure_type, legs (array), optional constraints, version, is_active, metadata.
    Per leg: quantity = ratio per leg (structural); strike and expiration are optional presets
    (null/blank = resolve when structure is applied, e.g. ATM or DTE).
    """
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    _legs = body.get("legs")
    if isinstance(_legs, list) and body.get("structure_type"):
        body = {**body, "legs": strategy_structure_write_module._normalize_legs((body.get("structure_type") or "").strip(), _legs)}
    try:
        sid = strategy_structure_write_module.create_structure(control_via_db, body)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if sid is None:
        raise HTTPException(status_code=500, detail="Failed to create structure")
    return {"strategy_structure_id": sid}


@router.put("/structures/{structure_id}")
def update_structure_endpoint(request: Request, structure_id: int, body: Dict[str, Any]) -> Dict[str, Any]:
    """Update an existing strategy structure. Body same as POST (legs: quantity=ratio, strike/expiration=optional preset)."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    # Normalize legs in request body so legacy role/direction/option_right pass validation (e.g. role "stock" -> "underlying" for covered_call leg 0).
    _legs = body.get("legs")
    if isinstance(_legs, list) and body.get("structure_type"):
        body = {**body, "legs": strategy_structure_write_module._normalize_legs((body.get("structure_type") or "").strip(), _legs)}
    try:
        ok = strategy_structure_write_module.update_structure(control_via_db, structure_id, body)
    except (ValueError, TypeError) as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Structure not found or update failed")
    return {"ok": True}


@router.delete("/structures/{structure_id}")
def delete_structure_endpoint(request: Request, structure_id: int) -> Dict[str, Any]:
    """Soft-delete a strategy structure (set is_active = false). Clears settings.active_strategy_structure_id if it pointed to this structure."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    try:
        ok = strategy_structure_write_module.deactivate_structure(control_via_db, structure_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Structure not found")
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
