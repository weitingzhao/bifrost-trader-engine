"""Phase A: Strategy structures and strategy_history API for management and monitoring."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from servers.reader import gate_safety_write as gate_safety_write_module
from servers.reader import strategy_allocation_write as strategy_allocation_write_module
from servers.reader import strategy_opportunity_write as strategy_opportunity_write_module
from servers.reader import strategy_structure_write as strategy_structure_write_module
from servers.reader import structure_type_config_constants as structure_type_config_constants_module
from servers.reader import template_config as template_config_module
from servers.reader import template_config_write as template_config_write_module

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


def _require_control_via_db(request: Request) -> Optional[dict]:
    """Return control_via_db config or raise 503."""
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    return control_via_db


@router.get("/dims")
def list_dims_grouped_endpoint(request: Request) -> Dict[str, Any]:
    reader = request.app.state.reader
    return {"by_type": reader.list_dims_grouped()}


@router.get("/dims/{dim_type}/items")
def list_dims_for_type_endpoint(request: Request, dim_type: str) -> Dict[str, Any]:
    reader = request.app.state.reader
    return {"items": reader.list_dims_for_type(dim_type)}


@router.post("/dims/{dim_type}")
def create_dim_endpoint(request: Request, dim_type: str, body: Dict[str, Any]) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    try:
        template_config_write_module.create_dim(config, dim_type, body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.put("/dims/by-id/{strategy_dim_id}")
def update_dim_endpoint(
    request: Request, strategy_dim_id: int, body: Dict[str, Any]
) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    try:
        ok = template_config_write_module.update_dim(config, strategy_dim_id, body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Dimension row not found")
    return {"ok": True}


@router.delete("/dims/by-id/{strategy_dim_id}")
def delete_dim_endpoint(request: Request, strategy_dim_id: int) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    try:
        template_config_write_module.delete_dim(config, strategy_dim_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.get("/templates/options/param-kind")
def template_param_kind_options() -> Dict[str, Any]:
    return {"options": structure_type_config_constants_module.get_param_kind_options_with_labels()}


@router.get("/templates/options/leg-role")
def template_leg_role_options() -> Dict[str, Any]:
    return {"options": structure_type_config_constants_module.get_leg_role_options_with_labels()}


@router.get("/templates/options/leg-direction")
def template_leg_direction_options() -> Dict[str, Any]:
    return {"options": structure_type_config_constants_module.get_leg_direction_options_with_labels()}


@router.get("/templates/options/leg-option-right")
def template_leg_option_right_options() -> Dict[str, Any]:
    return {"options": structure_type_config_constants_module.get_leg_option_right_options_with_labels()}


@router.get("/templates/options/meta-keys")
def template_meta_key_options() -> Dict[str, Any]:
    return {
        "options": structure_type_config_constants_module.get_meta_key_options_with_labels(
            "covered_call"
        )
    }


@router.get("/templates/options/meta-values")
def template_meta_value_options(
    meta_key: str = Query(..., description="meta_key"),
) -> Dict[str, Any]:
    return {
        "options": structure_type_config_constants_module.get_meta_value_options_with_labels(
            "covered_call", meta_key
        )
    }


@router.get("/templates")
def list_templates_endpoint(
    request: Request,
    active_only: bool = Query(True),
) -> Dict[str, Any]:
    reader = request.app.state.reader
    return {"items": reader.list_templates(active_only=active_only)}


@router.get("/templates/{template_id}")
def get_template_detail_endpoint(request: Request, template_id: int) -> Dict[str, Any]:
    reader = request.app.state.reader
    row = reader.get_template_detail(template_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return row


@router.post("/templates")
def create_template_endpoint(request: Request, body: Dict[str, Any]) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    try:
        tid = template_config_write_module.create_template(config, body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"strategy_template_id": tid}


@router.put("/templates/{template_id}")
def update_template_endpoint(
    request: Request, template_id: int, body: Dict[str, Any]
) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    try:
        ok = template_config_write_module.update_template(config, template_id, body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    if not ok:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"ok": True}


@router.delete("/templates/{template_id}")
def delete_template_endpoint(request: Request, template_id: int) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    try:
        template_config_write_module.delete_template(config, template_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.put("/templates/{template_id}/legs")
def replace_template_legs_endpoint(
    request: Request, template_id: int, body: Dict[str, Any]
) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    legs = body.get("legs")
    if not isinstance(legs, list):
        raise HTTPException(status_code=400, detail="legs array is required")
    try:
        template_config_write_module.replace_template_legs(config, template_id, legs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.put("/templates/{template_id}/params")
def replace_template_params_endpoint(
    request: Request, template_id: int, body: Dict[str, Any]
) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    items = body.get("items")
    if not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be an array")
    try:
        template_config_write_module.replace_template_params(config, template_id, items)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    return {"ok": True}


@router.put("/templates/{template_id}/characteristics")
def replace_template_characteristics_endpoint(
    request: Request, template_id: int, body: Dict[str, Any]
) -> Dict[str, Any]:
    config = _require_control_via_db(request)
    items = body.get("items")
    if items is not None and not isinstance(items, list):
        raise HTTPException(status_code=400, detail="items must be an array of strings")
    try:
        template_config_write_module.replace_template_characteristics(
            config, template_id, [str(x) for x in (items or [])]
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


class StrategyInstanceCreateBody(BaseModel):
    """Request body for create strategy instance (SI.2)."""

    strategy_opportunity_id: int = Field(..., description="Parent opportunity ID")
    account_id: str = Field(..., min_length=1, description="Account ID")
    opened_at: str = Field(..., description="Opened at (ISO 8601 or Unix timestamp string)")
    label: Optional[str] = Field(None, description="Optional label")
    notes: Optional[str] = Field(None, description="Optional notes")


class StrategyInstanceUpdateBody(BaseModel):
    """Request body for PATCH strategy instance; label, notes, created_at, opened_at optional."""

    label: Optional[str] = None
    notes: Optional[str] = None
    created_at: Optional[str] = None  # ISO 8601 or Unix seconds (number as string)
    opened_at: Optional[str] = None  # ISO 8601 or Unix seconds (number as string)


@router.get("/instances")
def list_strategy_instances(
    request: Request,
    account_id: Optional[str] = Query(None, description="Filter by account ID"),
    strategy_opportunity_id: Optional[int] = Query(None, description="Filter by strategy opportunity ID"),
    opened_at_from: Optional[float] = Query(None, description="Filter: opened_at >= (Unix seconds)"),
    opened_at_until: Optional[float] = Query(None, description="Filter: opened_at <= (Unix seconds)"),
) -> Dict[str, Any]:
    """Return list of strategy_instance rows (SI.2). Optional filters: account_id, strategy_opportunity_id, opened_at range."""
    reader = request.app.state.reader
    items: List[Dict[str, Any]] = reader.list_strategy_instances(
        account_id=account_id,
        strategy_opportunity_id=strategy_opportunity_id,
        opened_at_from=opened_at_from,
        opened_at_until=opened_at_until,
    )
    return {"items": items}


@router.get("/instances/{strategy_instance_id}")
def get_strategy_instance(request: Request, strategy_instance_id: int) -> Dict[str, Any]:
    """Return one strategy_instance by id. 404 if not found."""
    reader = request.app.state.reader
    row = reader.get_strategy_instance_by_id(strategy_instance_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Strategy instance not found")
    return row


@router.post("/instances")
def create_strategy_instance_endpoint(request: Request, body: StrategyInstanceCreateBody) -> Dict[str, Any]:
    """Create a new strategy instance. Body: strategy_opportunity_id, account_id, opened_at (required), label?, notes?. opened_at: ISO 8601 or Unix seconds."""
    reader = request.app.state.reader
    control_via_db = getattr(request.app.state, "control_via_db", None)
    if not control_via_db:
        raise HTTPException(status_code=503, detail="Database control not configured")
    opened_at_val: Any = body.opened_at
    try:
        if isinstance(opened_at_val, str) and opened_at_val.strip().replace(".", "").replace("-", "").replace(":", "", 1).isdigit():
            opened_at_val = float(opened_at_val.strip())
        elif isinstance(opened_at_val, str):
            from datetime import datetime
            opened_at_val = datetime.fromisoformat(opened_at_val.replace("Z", "+00:00")).timestamp()
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail="opened_at must be ISO 8601 or Unix timestamp") from exc
    sid = reader.create_strategy_instance(
        strategy_opportunity_id=body.strategy_opportunity_id,
        account_id=body.account_id.strip(),
        opened_at=opened_at_val,
        label=body.label.strip() if body.label else None,
        notes=body.notes.strip() if body.notes else None,
    )
    if sid is None:
        raise HTTPException(status_code=500, detail="Failed to create strategy instance")
    return {"strategy_instance_id": sid}


def _parse_optional_ts(value: Any, field_name: str) -> Any:
    """Parse optional timestamp from payload: ISO 8601 or Unix seconds. Returns float or None."""
    if value is None:
        return None
    try:
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            s = value.strip()
            if s.replace(".", "").replace("-", "").replace(":", "").replace("Z", "").isdigit():
                return float(s)
            from datetime import datetime, timezone
            # ISO 8601: support Z and +00:00 (Python 3.10 fromisoformat accepts +00:00)
            normalized = s.replace("Z", "+00:00")
            try:
                return datetime.fromisoformat(normalized).timestamp()
            except ValueError:
                # Fallback: date-only YYYY-MM-DD
                if len(s) >= 10 and s[4] == "-" and s[7] == "-":
                    return datetime.strptime(s[:10], "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp()
    except (ValueError, TypeError):
        pass
    raise HTTPException(status_code=400, detail=f"{field_name} must be ISO 8601 or Unix timestamp")


@router.patch("/instances/{strategy_instance_id}")
def update_strategy_instance_endpoint(
    request: Request, strategy_instance_id: int, body: StrategyInstanceUpdateBody
) -> Dict[str, Any]:
    """Update strategy instance label/notes/created_at/opened_at. Partial update supported."""
    reader = request.app.state.reader
    payload = body.model_dump(exclude_unset=True)
    if not payload:
        return {"ok": True}
    created_at_val = _parse_optional_ts(payload.get("created_at"), "created_at") if "created_at" in payload else payload.get("created_at")
    opened_at_val = _parse_optional_ts(payload.get("opened_at"), "opened_at") if "opened_at" in payload else payload.get("opened_at")
    ok = reader.update_strategy_instance(
        strategy_instance_id,
        label=payload.get("label"),
        notes=payload.get("notes"),
        created_at=created_at_val,
        opened_at=opened_at_val,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="Strategy instance not found or update failed")
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
