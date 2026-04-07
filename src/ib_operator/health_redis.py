"""IB Operator health in Redis as a Hash (same field style as bifrost:health:ws_ib_ingestor: string fields, HSET)."""

from __future__ import annotations

import time
from typing import Any, Dict, Optional


def _truthy_field(v: Optional[str]) -> bool:
    if v is None:
        return False
    return v.strip() in ("1", "true", "True", "yes", "Yes")


def _err_from_field(v: Optional[str]) -> Optional[str]:
    if v is None or v == "":
        return None
    return v


def operator_health_dict_to_redis_hash(h: Dict[str, Any]) -> Dict[str, str]:
    """Flatten ``executor.health_dict()`` (+ ``updated_at``) to Redis hash string fields."""
    op = h.get("operator") if isinstance(h.get("operator"), dict) else {}
    mapping: Dict[str, str] = {
        "operator_connected": "1" if op.get("connected") else "0",
        "operator_client_id": str(int(op.get("client_id") or 0)),
        "operator_last_error": "" if op.get("last_error") is None else str(op.get("last_error")),
        "operator_alive": "1" if h.get("operator_alive") else "0",
        "updated_at": str(h.get("updated_at", time.time())),
    }
    acc2 = h.get("account2")
    if acc2 is not None and isinstance(acc2, dict):
        mapping["account2_present"] = "1"
        mapping["account2_connected"] = "1" if acc2.get("connected") else "0"
        mapping["account2_client_id"] = str(int(acc2.get("client_id") or 0))
        mapping["account2_last_error"] = (
            "" if acc2.get("last_error") is None else str(acc2.get("last_error"))
        )
    else:
        mapping["account2_present"] = "0"
    return mapping


def operator_health_dict_from_redis_hash(m: Dict[str, str]) -> Optional[Dict[str, Any]]:
    """Rebuild nested health dict for ``build_monitor_ib_status``; return None if ``m`` is empty."""
    if not m:
        return None
    out: Dict[str, Any] = {
        "operator": {
            "connected": _truthy_field(m.get("operator_connected")),
            "client_id": int(m.get("operator_client_id") or 0),
            "last_error": _err_from_field(m.get("operator_last_error")),
        },
        "operator_alive": _truthy_field(m.get("operator_alive", "1")),
    }
    if m.get("account2_present") == "1":
        out["account2"] = {
            "connected": _truthy_field(m.get("account2_connected")),
            "client_id": int(m.get("account2_client_id") or 0),
            "last_error": _err_from_field(m.get("account2_last_error")),
        }
    else:
        out["account2"] = None
    return out
