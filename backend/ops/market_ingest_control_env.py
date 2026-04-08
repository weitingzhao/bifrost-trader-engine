"""Redis field on ingest meta hashes: which Ops stack (dev|prod) owns control.

Written after successful Ops start; cleared after successful Ops stop. Uses Redis DB 0
(same as ``scripts/run_massive_ws.py`` meta keys), not the Celery broker DB.

For ``ib_operator``, ``redis_meta_key`` is the same hash as ``run_ib_operator.py`` health
(``bifrost:health:ws_ib_operator``). Writes use ``HSET`` on one field only and must not replace
the whole key; the operator process must not use a TTL that deletes that key (otherwise only
this field may remain after expiry + a subsequent Ops write).
"""

from __future__ import annotations

import logging
import socket
import time
from typing import Optional

from src.bifrost.redis_health_keys import ENGINE_OPS_ACTIVE_REDIS_FIELD

logger = logging.getLogger(__name__)

BIFROST_OPS_CONTROL_ENV_FIELD = "bifrost_ops_control_env"
# Set on successful Ops start (same hash as bifrost_ops_control_env); cleared on stop.
BIFROST_OPS_CONTROL_HOST_FIELD = "bifrost_ops_control_host"

_REDIS_SOCKET_SEC = 3.0


def normalize_control_profile(raw: Optional[str]) -> Optional[str]:
    if raw is None:
        return None
    s = str(raw).strip().lower()
    if s in ("dev", "prod"):
        return s
    return None


def meta_redis_url_from_ops_config(config: dict) -> Optional[str]:
    from src.core.redis_url import redis_url_from_config

    return redis_url_from_config(config or {})


def control_hostname() -> str:
    """Short host id for Redis lease (which machine last ran Ops start for this service)."""
    try:
        return (socket.gethostname() or "unknown").strip() or "unknown"
    except Exception:
        return "unknown"


def read_control_host(redis_url: str, meta_key: str) -> Optional[str]:
    """Hostname written at last Ops start; ``None`` if missing."""
    if not meta_key.strip():
        return None
    try:
        import redis

        r = redis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=_REDIS_SOCKET_SEC,
            socket_timeout=_REDIS_SOCKET_SEC,
        )
        raw = r.hget(meta_key.strip(), BIFROST_OPS_CONTROL_HOST_FIELD)
        s = (raw or "").strip()
        return s or None
    except Exception as e:
        logger.debug("read_control_host %s: %s", meta_key, e)
        return None


def read_control_env(redis_url: str, meta_key: str) -> Optional[str]:
    """Return ``dev``/``prod`` from hash field, or ``None`` if missing/unreadable."""
    if not meta_key.strip():
        return None
    try:
        import redis

        r = redis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=_REDIS_SOCKET_SEC,
            socket_timeout=_REDIS_SOCKET_SEC,
        )
        raw = r.hget(meta_key.strip(), BIFROST_OPS_CONTROL_ENV_FIELD)
        return normalize_control_profile(raw)
    except Exception as e:
        logger.debug("read_control_env %s: %s", meta_key, e)
        return None


def write_control_env(redis_url: str, meta_key: str, profile: str) -> None:
    norm = normalize_control_profile(profile)
    if not norm:
        raise ValueError(f"invalid control profile: {profile!r}")
    if not meta_key.strip():
        raise ValueError("empty redis_meta_key")
    import redis

    r = redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=_REDIS_SOCKET_SEC,
        socket_timeout=_REDIS_SOCKET_SEC,
    )
    host = control_hostname()
    r.hset(
        meta_key.strip(),
        mapping={
            BIFROST_OPS_CONTROL_ENV_FIELD: norm,
            BIFROST_OPS_CONTROL_HOST_FIELD: host,
        },
    )


def write_trading_engine_ops_lease(redis_url: str, meta_key: str, profile: str) -> None:
    """Lease + ``engine_ops_active`` + ``updated_at`` for Dev/Prod exclusivity (trading_engine only)."""
    norm = normalize_control_profile(profile)
    if not norm:
        raise ValueError(f"invalid control profile: {profile!r}")
    if not meta_key.strip():
        raise ValueError("empty redis_meta_key")
    import redis

    r = redis.from_url(
        redis_url,
        decode_responses=True,
        socket_connect_timeout=_REDIS_SOCKET_SEC,
        socket_timeout=_REDIS_SOCKET_SEC,
    )
    host = control_hostname()
    r.hset(
        meta_key.strip(),
        mapping={
            BIFROST_OPS_CONTROL_ENV_FIELD: norm,
            BIFROST_OPS_CONTROL_HOST_FIELD: host,
            ENGINE_OPS_ACTIVE_REDIS_FIELD: "1",
            "updated_at": str(time.time()),
        },
    )


def clear_control_env(redis_url: str, meta_key: str) -> None:
    if not meta_key.strip():
        return
    try:
        import redis

        r = redis.from_url(
            redis_url,
            decode_responses=True,
            socket_connect_timeout=_REDIS_SOCKET_SEC,
            socket_timeout=_REDIS_SOCKET_SEC,
        )
        r.hdel(
            meta_key.strip(),
            BIFROST_OPS_CONTROL_ENV_FIELD,
            BIFROST_OPS_CONTROL_HOST_FIELD,
        )
    except Exception as e:
        logger.warning("clear_control_env %s: %s", meta_key, e)
        raise
