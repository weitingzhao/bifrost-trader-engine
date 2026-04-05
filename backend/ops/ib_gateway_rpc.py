"""Ops: send ``disconnect_all`` to IB Gateway via Redis Stream before systemd restart (reset)."""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Dict, Optional, Tuple

import redis

from src.ib_gateway.config import effective_ib_gateway_settings
from src.ib_gateway.protocol import PROTOCOL_VERSION, result_key


def ib_gateway_disconnect_all_sync(
    config: dict,
    *,
    wait_sec: float = 35.0,
    poll_interval_sec: float = 0.15,
) -> Tuple[bool, Optional[str], Optional[Dict[str, Any]]]:
    """XADD ``disconnect_all`` to the gateway cmd stream and wait for the result key.

    Returns ``(ok, error_message, parsed_result)``.
    """
    settings = effective_ib_gateway_settings(config)
    if not settings["enabled"]:
        return False, "ib_gateway_disabled", None
    rurl = settings.get("redis_url")
    if not rurl:
        return False, "no_redis_url", None
    stream = settings["stream"]
    prefix = settings["result_prefix"]
    req_id = str(uuid.uuid4())
    fields = {
        "req_id": req_id,
        "v": PROTOCOL_VERSION,
        "op": "disconnect_all",
        "payload": "{}",
        "caller": "ops-market-ingest-reset",
    }
    r = redis.from_url(rurl, decode_responses=True)
    try:
        r.xadd(stream, fields)
    except (redis.RedisError, OSError) as e:
        return False, f"xadd_failed:{e}", None
    rk = result_key(prefix, req_id)
    deadline = time.monotonic() + wait_sec
    while time.monotonic() < deadline:
        raw = r.get(rk)
        if raw:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                return False, "invalid_result_json", None
            if not isinstance(data, dict):
                return False, "invalid_result_shape", None
            if not data.get("ok"):
                return False, str(data.get("error") or "disconnect_failed"), data
            return True, None, data
        time.sleep(poll_interval_sec)
    return False, "timeout_waiting_result", None
