"""Config: IB, Flex, key-value groups/key-value, position-categories."""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from servers.reader import (
    create_key_value_group,
    delete_key_value,
    delete_key_value_group,
    set_key_value,
    update_key_value_group,
    write_flex_config,
    write_ib_config,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["config"])


class IbConfigBody(BaseModel):
    """POST /config/ib body. Client IDs: Daemon (Trading, Listener), Monitor (Account, Market data), Celery (Market Data). Second IB: Listener + Account only."""
    ib_host: Optional[str] = None
    ib_port_type: Optional[str] = None
    ib_client_id_daemon: Optional[int] = None
    ib_client_id_listener: Optional[int] = None
    ib_client_id_account: Optional[int] = None
    ib_client_id_markets: Optional[int] = None
    ib_client_id_worker_market: Optional[int] = None
    ib_primary_account_id: Optional[str] = None
    ib2_host: Optional[str] = None
    ib2_port_type: Optional[str] = None
    ib2_client_id_listener: Optional[int] = None
    ib2_client_id_account: Optional[int] = None

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
        "ib_primary_account_id": None,
        "ib2_host": None,
        "ib2_port_type": None,
        "ib2_client_id_listener": 3,
        "ib2_client_id_account": 102,
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
    primary_id = body.ib_primary_account_id if body.ib_primary_account_id is not None else current.get("ib_primary_account_id")
    if primary_id is not None:
        primary_id = (str(primary_id)).strip() or None
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
    logger.info(
        "[config/ib] writing settings: host=%r port_type=%r ... ib2_host=%r ib2_port_type=%r",
        host, port_type, ib2_h, ib2_pt,
    )
    if write_ib_config(control_via_db, host, port_type, cid_d, cid_l, cid_a, cid_m, cid_w, primary_id, ib2_h, ib2_pt, cid2_l, cid2_a):
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
                "ib_primary_account_id": primary_id,
                "ib2_host": ib2_h,
                "ib2_port_type": ib2_pt,
                "ib2_client_id_listener": cid2_l,
                "ib2_client_id_account": cid2_a,
            },
        )
    return JSONResponse(status_code=500, content={"error": "failed to write settings"})


@router.post("/config/flex")
def post_config_flex(request: Request, body: FlexConfigBody = Body(...)) -> JSONResponse:
    """Update settings (ib_flex_host_token, ib_flex_secondary_token) and flex_accounts rows."""
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


@router.get("/config/key-value/groups")
def get_config_key_value_groups(request: Request) -> Dict[str, Any]:
    """List all key-value groups (for Settings Key-Value Config)."""
    reader = request.app.state.reader
    groups = reader.get_key_value_groups()
    return {"ok": True, "items": groups}


@router.post("/config/key-value/groups")
def post_config_key_value_group(request: Request, body: Dict[str, Any] = Body(default=None)) -> Dict[str, Any]:
    """Create one key-value group. body: name (required), description, sort_order."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required.", "id": None}
    b = body or {}
    name = (b.get("name") or "").strip()
    if not name:
        return {"ok": False, "error": "name is required.", "id": None}
    gid = create_key_value_group(control_via_db, name, b.get("description"), b.get("sort_order", 0))
    if gid is not None:
        return {"ok": True, "id": gid, "name": name}
    return {"ok": False, "error": "Failed to create group (name may already exist).", "id": None}


@router.patch("/config/key-value/groups/{group_name:path}")
def patch_config_key_value_group(request: Request, group_name: str, body: Dict[str, Any] = Body(default=None)) -> Dict[str, Any]:
    """Update one key-value group. Match by group_name only (not id). body: name, description, sort_order (optional)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required."}
    b = body or {}
    if update_key_value_group(
        control_via_db,
        group_name.strip(),
        b.get("name"),
        b.get("description"),
        b.get("sort_order"),
    ):
        return {"ok": True, "group_name": group_name.strip()}
    return {"ok": False, "error": "Failed to update group."}


@router.delete("/config/key-value/groups/{group_name:path}")
def delete_config_key_value_group(request: Request, group_name: str) -> Dict[str, Any]:
    """Delete one group and all its key-values (CASCADE). Match by group_name only (not id)."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required."}
    name = group_name.strip()
    if delete_key_value_group(control_via_db, name):
        return {"ok": True, "group_name": name}
    return {"ok": False, "error": "Failed to delete group."}


@router.get("/config/key-value")
def get_config_key_value(
    request: Request,
    key: Optional[str] = None,
    group_name: Optional[str] = None,
) -> Dict[str, Any]:
    """List key-value rows: by key (single), or by group_name. When both given, match by group name only."""
    reader = request.app.state.reader
    if key and (group_name or "").strip():
        val = reader.get_key_value_in_group(key.strip(), group_name.strip())
        return {"ok": True, "items": [{"key": key.strip(), "value": val or ""}]}
    if key:
        val = reader.get_key_value(key.strip())
        return {"ok": True, "items": [{"key": key.strip(), "value": val or ""}] if key.strip() else [], "key": key.strip()}
    if (group_name or "").strip():
        items = reader.get_key_values_by_group(group_name.strip())
        return {"ok": True, "items": items}
    items = reader.get_all_key_values()
    return {"ok": True, "items": items}


@router.post("/config/key-value")
def post_config_key_value(request: Request, body: Dict[str, Any] = Body(default=None)) -> Dict[str, Any]:
    """Upsert one key-value row. body: group_name (required), key (required), value, description. Default group_name=flex_range_options."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required to write key_value_config."}
    b = body or {}
    k = (b.get("key") or "").strip()
    if not k:
        return {"ok": False, "error": "key is required."}
    gname = (b.get("group_name") or "").strip() or "flex_range_options"
    v = b.get("value")
    v = (v.strip() if isinstance(v, str) else str(v)) if v is not None else ""
    desc = (b.get("description") or "").strip() or None
    if set_key_value(control_via_db, k, v, desc, group_name=gname):
        return {"ok": True, "key": k, "value": v, "group_name": gname}
    return {"ok": False, "error": "Failed to write key_value_config."}


@router.delete("/config/key-value")
def delete_config_key_value(
    request: Request,
    key: Optional[str] = None,
    group_name: Optional[str] = None,
    body: Optional[Dict[str, Any]] = Body(default=None),
) -> Dict[str, Any]:
    """Delete one key-value row. key + group_name required (match by name only). Default group_name=flex_range_options."""
    control_via_db = request.app.state.control_via_db
    if not control_via_db:
        return {"ok": False, "error": "Postgres required to delete from key_value_config."}
    bod = body or {}
    k = (key or "").strip() or (bod.get("key") or "").strip()
    k = (k.strip() if isinstance(k, str) else str(k)).strip() if k else ""
    gname = (group_name or "").strip() or (bod.get("group_name") or "").strip() or "flex_range_options"
    if not k:
        return {"ok": False, "error": "key is required."}
    if delete_key_value(control_via_db, k, group_name=gname):
        return {"ok": True, "key": k}
    return {"ok": False, "error": "Failed to delete key."}


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
