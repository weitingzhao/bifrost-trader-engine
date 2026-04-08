"""Canonical Redis keys for Socket ingest health under ``bifrost:health:*``.

Service **ids** in Ops YAML stay ``massive_ws`` / ``ib_ingestor`` / ``ib_operator``; Redis **health**
hashes use the ``ws_*`` suffix names below.

Readers fall back to prior bifrost key names and (Massive only) ``massive:meta:status`` when the
canonical hash is empty.
"""

from __future__ import annotations

from typing import Any, Dict

# Canonical health hashes (Socket Services / GET /status ``socket`` + Ops ``redis_meta_key``).
BIFROST_HEALTH_MASSIVE_WS = "bifrost:health:ws_massive_option"
BIFROST_HEALTH_IB_INGESTOR = "bifrost:health:ws_ib_ingestor"
BIFROST_HEALTH_IB_OPERATOR = "bifrost:health:ws_ib_operator"
BIFROST_HEALTH_IB_ACCOUNT_AGENT = "bifrost:health:ws_ib_account_agent"

# Ops Dev/Prod lease for trading_engine (same Redis as Socket); not written by ingest writers.
BIFROST_OPS_TRADING_ENGINE_META = "bifrost:ops:trading_engine"
ENGINE_OPS_ACTIVE_REDIS_FIELD = "engine_ops_active"

# Previous bifrost names (read / YAML normalization fallback).
LEGACY_BIFROST_MASSIVE_WS = "bifrost:health:massive_ws"
LEGACY_BIFROST_IB_INGESTOR = "bifrost:health:ib_ingestor"
LEGACY_BIFROST_IB_OPERATOR = "bifrost:health:ib_operator"
LEGACY_BIFROST_IB_ACCOUNT_AGENT = "bifrost:health:ib_account_agent"

# Older Massive key (read fallback).
LEGACY_MASSIVE_META_STATUS = "massive:meta:status"

# Deprecated IB operator key — YAML normalization only.
LEGACY_IB_OPERATOR_META_HEALTH = "ib:operator:meta:health"


def redis_hash_field_truthy(h: Dict[str, Any], field: str = "connected") -> bool:
    """Coerce a Redis hash field to bool (writers use ``\"1\"`` / ``\"0\"``; tolerate int/bool/whitespace)."""
    if not h:
        return False
    v = h.get(field)
    if v is None:
        return False
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    s = str(v).strip().lower()
    return s in ("1", "true", "yes", "on")


def hgetall_massive_ws_status(r: Any) -> Dict[str, str]:
    """Massive WS / options ingest health hash (same field names as before)."""
    for key in (
        BIFROST_HEALTH_MASSIVE_WS,
        LEGACY_BIFROST_MASSIVE_WS,
        LEGACY_MASSIVE_META_STATUS,
    ):
        h = r.hgetall(key)
        if h:
            return dict(h)
    return {}


def hgetall_ib_ingestor_health(r: Any) -> Dict[str, str]:
    """IB market ingestor health hash."""
    h = r.hgetall(BIFROST_HEALTH_IB_INGESTOR)
    if not h:
        h = r.hgetall(LEGACY_BIFROST_IB_INGESTOR)
    return dict(h or {})


def hgetall_ib_account_agent_health(r: Any) -> Dict[str, str]:
    """IB Account Agent health hash (account-domain events → Redis only)."""
    h = r.hgetall(BIFROST_HEALTH_IB_ACCOUNT_AGENT)
    if not h:
        h = r.hgetall(LEGACY_BIFROST_IB_ACCOUNT_AGENT)
    return dict(h or {})
