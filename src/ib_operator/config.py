"""Merge ``ib_operator:`` from YAML with defaults (legacy ``ib_gateway`` fallback)."""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from src.bifrost.redis_health_keys import BIFROST_HEALTH_IB_OPERATOR
from src.core.redis_url import format_redis_url, redis_url_from_config, effective_redis_dict

logger = logging.getLogger(__name__)


def effective_ib_operator_settings(config: Dict[str, Any]) -> Dict[str, Any]:
    """Return resolved IB Operator settings (stream, group, TTLs, keys).

    ``enabled`` defaults to True when Redis URL is available and ``ib_operator.enabled``
    is not explicitly False.

    If ``ib_operator`` is absent but ``ib_gateway`` is present, reads ``ib_gateway`` and logs a
    deprecation warning.
    """
    raw = config.get("ib_operator")
    if raw is None and config.get("ib_gateway") is not None:
        logger.warning(
            "YAML key ib_gateway is deprecated; rename to ib_operator (same sub-keys supported)."
        )
        raw = config.get("ib_gateway")
    raw = raw if isinstance(raw, dict) else {}
    rurl = redis_url_from_config(config)
    explicit_enabled = raw.get("enabled")
    if explicit_enabled is False:
        enabled = False
    elif explicit_enabled is True:
        enabled = True
    else:
        enabled = rurl is not None

    return {
        "enabled": bool(enabled),
        "redis_url": rurl,
        "stream": (raw.get("stream") or "ib:operator:cmd").strip() or "ib:operator:cmd",
        "consumer_group": (raw.get("consumer_group") or "ib-operator").strip() or "ib-operator",
        "result_prefix": (raw.get("result_prefix") or "ib:operator:result:").strip()
        or "ib:operator:result:",
        "health_key": (raw.get("health_key") or BIFROST_HEALTH_IB_OPERATOR).strip()
        or BIFROST_HEALTH_IB_OPERATOR,
        "result_ttl_sec": int(raw.get("result_ttl_sec") or 300),
        "request_timeout_sec": float(raw.get("request_timeout_sec") or 120),
        "health_refresh_sec": float(raw.get("health_refresh_sec") or 15),
        "max_result_bytes": int(raw.get("max_result_bytes") or (512 * 1024)),
        "block_ms": int(raw.get("block_ms") or 5000),
    }


def redis_client_kwargs_from_config(config: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Sync redis.from_url kwargs when redis is enabled; else None."""
    if not redis_url_from_config(config):
        return None
    eff = effective_redis_dict(config, default_db=0)
    return {"url": format_redis_url(eff), "decode_responses": True}
