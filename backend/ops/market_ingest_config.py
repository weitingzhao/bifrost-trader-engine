"""YAML-driven registry for market data ingest services (systemd + Redis meta keys)."""

from __future__ import annotations

from typing import Dict, List

from src.bifrost.redis_health_keys import (
    BIFROST_HEALTH_IB_ACCOUNT_AGENT,
    BIFROST_HEALTH_IB_INGESTOR,
    BIFROST_HEALTH_IB_OPERATOR,
    BIFROST_HEALTH_MASSIVE_WS,
    LEGACY_BIFROST_IB_ACCOUNT_AGENT,
    LEGACY_BIFROST_IB_INGESTOR,
    LEGACY_BIFROST_IB_OPERATOR,
    LEGACY_BIFROST_MASSIVE_WS,
)

_LEGACY_IB_INGESTER_META_HEALTH = "ib:ingester:meta:health"
_LEGACY_IB_OPERATOR_META_HEALTH = "ib:operator:meta:health"

DEFAULT_MARKET_INGEST_SERVICES: List[Dict[str, str]] = [
    {
        "id": "massive_ws",
        "label": "Massive Options WS ingest",
        "systemd_unit": "bifrost-massive-ws.service",
        "redis_meta_key": BIFROST_HEALTH_MASSIVE_WS,
    },
    {
        "id": "ib_operator",
        "label": "IB Operator (cmd RPC)",
        "systemd_unit": "bifrost-ib-operator.service",
        "redis_meta_key": BIFROST_HEALTH_IB_OPERATOR,
    },
    {
        "id": "ib_ingestor",
        "label": "IB ingestor",
        "systemd_unit": "bifrost-ib-ingestor.service",
        "redis_meta_key": BIFROST_HEALTH_IB_INGESTOR,
    },
    {
        "id": "ib_account_agent",
        "label": "IB Account Agent",
        "systemd_unit": "bifrost-ib-account-agent.service",
        "redis_meta_key": BIFROST_HEALTH_IB_ACCOUNT_AGENT,
    },
]


def market_ingest_services_from_config(config: dict) -> List[Dict[str, str]]:
    """Return service rows; each has id, label, systemd_unit, redis_meta_key."""
    ops = config.get("ops") or {}
    raw = ops.get("market_ingest_services")
    if not isinstance(raw, list) or not raw:
        return list(DEFAULT_MARKET_INGEST_SERVICES)
    out: List[Dict[str, str]] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        sid = str(row.get("id") or "").strip()
        label = str(row.get("label") or sid).strip()
        unit = str(row.get("systemd_unit") or "").strip()
        meta = str(row.get("redis_meta_key") or "").strip()
        if not sid or not unit:
            continue
        if sid == "ib_market":
            sid = "ib_ingestor"
        norm_unit = unit if unit.endswith(".service") else f"{unit}.service"
        if norm_unit == "bifrost-ib-market-ingest.service":
            norm_unit = "bifrost-ib-ingestor.service"
        if sid == "massive_ws" and meta == LEGACY_BIFROST_MASSIVE_WS:
            meta = BIFROST_HEALTH_MASSIVE_WS
        elif sid == "ib_ingestor" and meta in (
            _LEGACY_IB_INGESTER_META_HEALTH,
            LEGACY_BIFROST_IB_INGESTOR,
        ):
            meta = BIFROST_HEALTH_IB_INGESTOR
        elif sid == "ib_operator" and meta in (
            _LEGACY_IB_OPERATOR_META_HEALTH,
            LEGACY_BIFROST_IB_OPERATOR,
        ):
            meta = BIFROST_HEALTH_IB_OPERATOR
        elif sid == "ib_account_agent" and meta == LEGACY_BIFROST_IB_ACCOUNT_AGENT:
            meta = BIFROST_HEALTH_IB_ACCOUNT_AGENT
        out.append({
            "id": sid,
            "label": label or sid,
            "systemd_unit": norm_unit,
            "redis_meta_key": meta,
        })
    return out if out else list(DEFAULT_MARKET_INGEST_SERVICES)


def market_ingest_service_by_id(config: dict, service_id: str) -> Dict[str, str] | None:
    sid = (service_id or "").strip()
    if sid == "ib_market":
        sid = "ib_ingestor"
    for row in market_ingest_services_from_config(config):
        if row["id"] == sid:
            return row
    return None
