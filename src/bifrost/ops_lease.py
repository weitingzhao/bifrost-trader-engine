"""Self-healing Ops control lease for Socket Services health heartbeats.

Each service calls ``maintain_service_ops_lease`` on every service-heartbeat tick.
If the lease key ``bifrost:ops:lease:<service_id>`` is missing (e.g. after a Redis
restart or key eviction), it is re-written automatically without waiting for an Ops
operator to click Start again.
"""

from __future__ import annotations

import logging
import os
import socket
from typing import Any, Optional

logger = logging.getLogger(__name__)

_BIFROST_OPS_CONTROL_ENV_FIELD = "bifrost_ops_control_env"
_BIFROST_OPS_CONTROL_HOST_FIELD = "bifrost_ops_control_host"


def ops_profile_from_config(config: dict) -> Optional[str]:
    """Return ``'dev'`` or ``'prod'`` for this service process.

    Priority:
    1. ``ops.control_profile`` key in the loaded YAML config.
    2. ``BIFROST_OPS_CONTROL_PROFILE`` environment variable.
    3. ``BIFROST_ENV`` environment variable (the variable that selects which
       config file is loaded, so it is strongly correlated with the profile).
    """
    ops = config.get("ops") if isinstance(config.get("ops"), dict) else {}
    raw = ops.get("control_profile") if isinstance(ops, dict) else None
    if isinstance(raw, str):
        s = raw.strip().lower()
        if s in ("dev", "prod"):
            return s
    for env_key in ("BIFROST_OPS_CONTROL_PROFILE", "BIFROST_ENV"):
        val = os.environ.get(env_key, "").strip().lower()
        if val in ("dev", "prod"):
            return val
    return None


def maintain_service_ops_lease(r: Any, service_id: str, profile: Optional[str]) -> None:
    """Write ``bifrost:ops:lease:<service_id>`` if ``bifrost_ops_control_env`` is absent.

    Called on each 30-second service-heartbeat tick so the HOST column in the
    Socket Services page self-heals after a Redis restart or key eviction.
    No-op when ``profile`` is ``None`` (ops profile not configured for this env).
    """
    if not profile:
        return
    from src.bifrost.redis_health_keys import ops_lease_key_for_service
    key = ops_lease_key_for_service(service_id)
    try:
        existing = r.hget(key, _BIFROST_OPS_CONTROL_ENV_FIELD)
        if not existing:
            hostname = (socket.gethostname() or "unknown").strip() or "unknown"
            r.hset(key, mapping={
                _BIFROST_OPS_CONTROL_ENV_FIELD: profile,
                _BIFROST_OPS_CONTROL_HOST_FIELD: hostname,
            })
            logger.info(
                "ops_lease: restored bifrost:ops:lease:%s → %s @ %s",
                service_id, profile, hostname,
            )
    except Exception as e:
        logger.debug("maintain_service_ops_lease %s: %s", service_id, e)
