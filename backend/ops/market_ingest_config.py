"""YAML-driven registry for Ops-managed systemd services (Socket ingest + optional Engine).

**trading_engine** uses ``redis_meta_key`` ``bifrost:health:daemon_strategy_trading`` by default (Dev/Prod
Ops lease + ``engine_ops_active``, same exclusivity rules as Socket rows in
:mod:`backend.ops.routers.market_ingest`). **account_sync_daemon** uses
``bifrost:health:daemon_account_sync`` by default for the same Ops lease fields on that hash.
YAML may omit ``redis_meta_key`` for either id and the default meta key is applied.
"""

from __future__ import annotations

from typing import Dict, List

from src.bifrost.redis_health_keys import (
    BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON,
    BIFROST_HEALTH_DAEMON_TRADING_ENGINE,
    LEGACY_BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON,
    LEGACY_BIFROST_HEALTH_DAEMON_TRADING_ENGINE,
    BIFROST_HEALTH_IB_ACCOUNT_AGENT,
    BIFROST_HEALTH_IB_INGESTOR,
    BIFROST_HEALTH_IB_OPERATOR,
    BIFROST_HEALTH_MASSIVE_WS,
    LEGACY_BIFROST_IB_ACCOUNT_AGENT,
    LEGACY_BIFROST_IB_INGESTOR,
    LEGACY_BIFROST_IB_OPERATOR,
    LEGACY_BIFROST_MASSIVE_WS,
    LEGACY_BIFROST_OPS_TRADING_ENGINE_META,
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
    {
        "id": "trading_engine",
        "label": "Strategy Trading Daemon",
        "systemd_unit": "bifrost-engine.service",
        "redis_meta_key": BIFROST_HEALTH_DAEMON_TRADING_ENGINE,
    },
    {
        "id": "account_sync_daemon",
        "label": "Account Sync Daemon",
        "systemd_unit": "bifrost-account-sync-daemon.service",
        "redis_meta_key": BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON,
    },
]


def market_ingest_services_from_config(config: dict) -> List[Dict[str, str]]:
    """Return service rows; each has id, label, systemd_unit, redis_meta_key (may be empty)."""
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
        elif sid == "trading_engine" and meta == LEGACY_BIFROST_OPS_TRADING_ENGINE_META:
            meta = BIFROST_HEALTH_DAEMON_TRADING_ENGINE
        elif sid == "trading_engine" and meta == LEGACY_BIFROST_HEALTH_DAEMON_TRADING_ENGINE:
            meta = BIFROST_HEALTH_DAEMON_TRADING_ENGINE
        elif sid == "account_sync_daemon" and meta == LEGACY_BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON:
            meta = BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON
        if sid == "trading_engine" and not meta:
            meta = BIFROST_HEALTH_DAEMON_TRADING_ENGINE
        if sid == "account_sync_daemon" and not meta:
            meta = BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON
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
