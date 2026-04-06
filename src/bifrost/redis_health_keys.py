"""Canonical Redis keys for Socket ingest health under ``bifrost:health:*``.

Writers (run_massive_ws, IB ingestor, IB Operator) use the BIFROST_HEALTH_* keys.
Readers fall back to legacy keys when the canonical hash is empty (rollout / mixed stacks).
"""

from __future__ import annotations

from typing import Any, Dict

# Canonical: Socket Services ingest health (GET /status ``socket`` + Ops ``redis_meta_key``).
BIFROST_HEALTH_MASSIVE_WS = "bifrost:health:massive_ws"
BIFROST_HEALTH_IB_INGESTOR = "bifrost:health:ib_ingestor"
BIFROST_HEALTH_IB_OPERATOR = "bifrost:health:ib_operator"

# Legacy keys (read fallback only; do not write new data here).
LEGACY_MASSIVE_META_STATUS = "massive:meta:status"
LEGACY_IB_INGESTER_META_HEALTH = "ib:ingester:meta:health"
LEGACY_IB_OPERATOR_META_HEALTH = "ib:operator:meta:health"


def hgetall_massive_ws_status(r: Any) -> Dict[str, str]:
    """Massive WS ingest health hash (same field names as before)."""
    h = r.hgetall(BIFROST_HEALTH_MASSIVE_WS)
    if not h:
        h = r.hgetall(LEGACY_MASSIVE_META_STATUS)
    return dict(h or {})


def hgetall_ib_ingestor_health(r: Any) -> Dict[str, str]:
    """IB market ingestor health hash."""
    h = r.hgetall(BIFROST_HEALTH_IB_INGESTOR)
    if not h:
        h = r.hgetall(LEGACY_IB_INGESTER_META_HEALTH)
    return dict(h or {})
