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

# Previous bifrost names (read / YAML normalization fallback).
LEGACY_BIFROST_MASSIVE_WS = "bifrost:health:massive_ws"
LEGACY_BIFROST_IB_INGESTOR = "bifrost:health:ib_ingestor"
LEGACY_BIFROST_IB_OPERATOR = "bifrost:health:ib_operator"

# Older Massive key (read fallback).
LEGACY_MASSIVE_META_STATUS = "massive:meta:status"

# Deprecated IB operator key — YAML normalization only.
LEGACY_IB_OPERATOR_META_HEALTH = "ib:operator:meta:health"


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
