"""Redis health hash maintenance for Socket Services + trading_engine Ops meta (market-ingest).

- After a successful Ops **stop**, rewrite canonical health fields to a disconnected snapshot so
  Monitor GET /status updates without waiting for TTL or a graceful writer exit.
- **trading_engine**: Health / Ops meta hash ``bifrost:health:daemon_strategy_trading`` uses ``engine_ops_active`` +
  ``updated_at`` for the same exclusive-start guard as Socket rows.
- Before **start** when no ``bifrost_ops_control_env`` lease exists, detect a still-fresh connected
  hash so only one Dev/Prod stack runs a writer against the same Redis.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, Optional

from src.bifrost.redis_health_keys import (
    ENGINE_OPS_ACTIVE_REDIS_FIELD,
    redis_hash_field_truthy,
)

logger = logging.getLogger(__name__)

_REDIS_SOCKET_SEC = 3.0
# If a writer is updating health, ``updated_at`` should advance within this window.
_HEALTH_RECENT_MAX_S = 90.0


def _conn(redis_url: str) -> Any:
    import redis

    return redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=_REDIS_SOCKET_SEC,
        socket_timeout=_REDIS_SOCKET_SEC,
    )


def _parse_ts(raw: Optional[str]) -> float:
    if raw is None or str(raw).strip() == "":
        return 0.0
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


def _hgetall(r: Any, key: str) -> Dict[str, str]:
    try:
        h = r.hgetall(key.strip())
        return dict(h or {})
    except Exception as e:
        logger.debug("hgetall %s: %s", key, e)
        return {}


def ingest_redis_health_looks_live(redis_url: str, meta_key: str, service_id: str) -> bool:
    """True if Redis health hash looks like a recently updated *connected* writer (exclusive start guard)."""
    key = (meta_key or "").strip()
    if not key:
        return False
    try:
        r = _conn(redis_url)
        try:
            m = _hgetall(r, key)
        finally:
            r.close()
    except Exception as e:
        logger.debug("ingest_redis_health_looks_live: %s", e)
        return False
    if not m:
        return False
    now = time.time()
    updated = _parse_ts(m.get("updated_at"))
    if updated <= 0 or (now - updated) > _HEALTH_RECENT_MAX_S:
        return False

    sid = (service_id or "").strip()
    if sid == "massive_ws":
        return redis_hash_field_truthy(m, "connected")
    if sid in ("ib_ingestor", "ib_market"):
        return redis_hash_field_truthy(m, "connected")
    if sid == "ib_operator":
        if redis_hash_field_truthy(m, "host_connected"):
            return True
        if redis_hash_field_truthy(m, "operator_connected"):
            return True
        return redis_hash_field_truthy(m, "connected")
    if sid == "ib_account_agent":
        if redis_hash_field_truthy(m, "host_connected"):
            return True
        return redis_hash_field_truthy(m, "connected")
    if sid == "trading_engine":
        if not redis_hash_field_truthy(m, ENGINE_OPS_ACTIVE_REDIS_FIELD):
            return False
        return True
    if sid == "account_sync_daemon":
        return redis_hash_field_truthy(m, "alive")
    return False


def clear_ingest_health_after_stop(redis_url: str, meta_key: str, service_id: str) -> None:
    """HSET disconnected snapshot on the ingest health hash (does not delete the key)."""
    key = (meta_key or "").strip()
    if not key:
        return
    sid = (service_id or "").strip()
    now = time.time()
    r = _conn(redis_url)
    try:
        if sid == "massive_ws":
            r.hset(
                key,
                mapping={
                    "connected": "0",
                    "last_msg_ts": str(now),
                    "reconnects": "0",
                    "msg_count": "0",
                    "updated_at": str(now),
                },
            )
        elif sid in ("ib_ingestor", "ib_market"):
            r.hset(
                key,
                mapping={
                    "client_id": "0",
                    "connected": "0",
                    "last_msg_ts": str(now),
                    "reconnects": "0",
                    "msg_count": "0",
                    "updated_at": str(now),
                },
            )
        elif sid == "ib_operator":
            from src.ib_operator.health_redis import (
                operator_health_dict_to_redis_hash,
                prune_legacy_operator_health_hash_fields,
            )

            h = {
                "host": {
                    "connected": False,
                    "client_id": 0,
                    "last_error": "",
                    "reconnects": 0,
                },
                "secondary": None,
                "service_alive": False,
                "operator_alive": False,
                "updated_at": now,
                "last_cmd_ts": 0.0,
                "cmd_count": 0,
            }
            mapping = operator_health_dict_to_redis_hash(h)
            r.hset(key, mapping=mapping)
            prune_legacy_operator_health_hash_fields(r, key)
        elif sid == "ib_account_agent":
            r.hset(
                key,
                mapping={
                    "connected": "0",
                    "host_connected": "0",
                    "host_alive": "0",
                    "client_id": "0",
                    "host_client_id": "0",
                    "secondary_connected": "0",
                    "last_msg_ts": str(now),
                    "reconnects": "0",
                    "msg_count": "0",
                    "updated_at": str(now),
                },
            )
        elif sid == "trading_engine":
            r.hset(
                key,
                mapping={
                    ENGINE_OPS_ACTIVE_REDIS_FIELD: "0",
                    "updated_at": str(now),
                },
            )
        elif sid == "account_sync_daemon":
            r.hset(
                key,
                mapping={
                    "alive": "0",
                    "stream_lag": "0",
                    "last_sync_version": "0",
                    "updated_at": str(now),
                },
            )
        else:
            logger.debug("clear_ingest_health_after_stop: unknown service_id=%s", sid)
    finally:
        r.close()
