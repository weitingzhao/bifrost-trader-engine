"""Call IB Operator from API processes via Redis (sync + async helper)."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, Dict, Optional

import redis

from src.ib_operator.config import effective_ib_operator_settings
from src.ib_operator.health_redis import operator_health_dict_from_redis_hash
from src.ib_operator.protocol import PROTOCOL_VERSION, new_req_id, result_key

logger = logging.getLogger(__name__)


class IbOperatorClient:
    """Publish commands to the operator stream and poll for result keys."""

    def __init__(
        self,
        *,
        redis_url: str,
        stream: str,
        result_prefix: str,
        default_timeout_sec: float = 120.0,
    ) -> None:
        self._redis_url = redis_url
        self._stream = stream
        self._result_prefix = result_prefix
        self._default_timeout_sec = float(default_timeout_sec)
        self._r: Optional[redis.Redis] = None

    @classmethod
    def from_merged_config(cls, config: Dict[str, Any]) -> Optional["IbOperatorClient"]:
        """Return client if operator + Redis are enabled; else None."""
        if (config.get("server") or {}).get("skip_monitor_ib", False):
            return None
        s = effective_ib_operator_settings(config)
        if not s["enabled"] or not s["redis_url"]:
            return None
        return cls(
            redis_url=s["redis_url"],
            stream=s["stream"],
            result_prefix=s["result_prefix"],
            default_timeout_sec=s["request_timeout_sec"],
        )

    def _conn(self) -> redis.Redis:
        if self._r is None:
            self._r = redis.from_url(self._redis_url, decode_responses=True)
        return self._r

    def close(self) -> None:
        if self._r is not None:
            try:
                self._r.close()
            except Exception:
                pass
            self._r = None

    def request(
        self,
        op: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        timeout_sec: Optional[float] = None,
        caller: str = "fastapi",
    ) -> Dict[str, Any]:
        """Blocking request. Returns envelope ``{ok, error?, data?}``."""
        payload = payload or {}
        timeout = float(timeout_sec if timeout_sec is not None else self._default_timeout_sec)
        if timeout <= 0:
            return {"ok": False, "error": "invalid_timeout"}

        r = self._conn()
        req_id = new_req_id()
        deadline_ms = int(time.time() * 1000 + timeout * 1000)
        fields = {
            "req_id": req_id,
            "v": PROTOCOL_VERSION,
            "op": op,
            "payload": json.dumps(payload, separators=(",", ":"), default=str),
            "caller": caller,
            "deadline_ms": str(deadline_ms),
        }
        try:
            r.xadd(self._stream, fields)
        except Exception as e:
            logger.warning("ib_operator xadd failed: %s", e)
            return {"ok": False, "error": f"redis_xadd:{e}"}

        rk = result_key(self._result_prefix, req_id)
        poll_interval = 0.05
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                raw = r.get(rk)
            except Exception as e:
                return {"ok": False, "error": f"redis_get:{e}"}
            if raw:
                try:
                    return json.loads(raw)
                except json.JSONDecodeError:
                    return {"ok": False, "error": "invalid_result_json"}
            time.sleep(poll_interval)

        return {"ok": False, "error": "timeout_waiting_for_operator"}

    async def request_async(
        self,
        op: str,
        payload: Optional[Dict[str, Any]] = None,
        *,
        timeout_sec: Optional[float] = None,
        caller: str = "fastapi",
    ) -> Dict[str, Any]:
        return await asyncio.to_thread(
            self.request,
            op,
            payload,
            timeout_sec=timeout_sec,
            caller=caller,
        )


def read_operator_health(redis_url: str, health_key: str) -> Optional[Dict[str, Any]]:
    """Read operator health: Redis Hash (ingest-style string fields) or legacy JSON string value."""
    from src.bifrost.redis_health_keys import (
        BIFROST_HEALTH_IB_OPERATOR,
        LEGACY_IB_OPERATOR_META_HEALTH,
    )

    def _read_at_key(r: Any, key: str) -> Optional[Dict[str, Any]]:
        kt = r.type(key)
        if kt == "none":
            return None
        if kt == "hash":
            raw_map = r.hgetall(key)
            return operator_health_dict_from_redis_hash(raw_map or {})
        if kt == "string":
            raw = r.get(key)
            if not raw:
                return None
            loaded = json.loads(raw)
            return loaded if isinstance(loaded, dict) else None
        return None

    try:
        r = redis.from_url(redis_url, decode_responses=True)
        try:
            out = _read_at_key(r, health_key)
            if out is None and health_key == BIFROST_HEALTH_IB_OPERATOR:
                out = _read_at_key(r, LEGACY_IB_OPERATOR_META_HEALTH)
            return out
        finally:
            r.close()
    except Exception:
        return None


def build_monitor_ib_status(
    config: Dict[str, Any],
    ib_cfg: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Build IB Operator Redis health dict for GET /status ``socket.ib_operator`` (host + optional secondary)."""
    if (config.get("server") or {}).get("skip_monitor_ib", False):
        return None
    s = effective_ib_operator_settings(config)
    if not s["enabled"] or not s["redis_url"]:
        return None
    ib = ib_cfg or {}
    health = read_operator_health(s["redis_url"], s["health_key"])
    unreachable = "IB Operator unreachable (is run_ib_operator.py running?)"

    def _slot(
        key: str,
        cid_key: str,
        *,
        fallback_err: Optional[str],
    ) -> Dict[str, Any]:
        cid = ib.get(cid_key)
        try:
            cid_i = int(cid) if cid is not None else 0
        except (TypeError, ValueError):
            cid_i = 0
        if health and isinstance(health.get(key), dict):
            h = health[key]
            return {
                "connected": bool(h.get("connected")),
                "client_id": int(h.get("client_id") or cid_i),
                "last_error": h.get("last_error"),
            }
        return {
            "connected": False,
            "client_id": cid_i,
            "last_error": unreachable if not health else fallback_err,
        }

    out: Dict[str, Any] = {
        "host": _slot("operator", "ib_client_id_operator", fallback_err=None),
    }
    ib2_host = ib.get("ib2_host") or ""
    ib2_host = ib2_host.strip() if isinstance(ib2_host, str) else ""
    try:
        cid2 = int(ib.get("ib2_client_id_operator") or 102)
    except (TypeError, ValueError):
        cid2 = 102
    if ib2_host or cid2 != 102:
        if health and health.get("account2") is not None and isinstance(health.get("account2"), dict):
            a2 = health["account2"]
            out["secondary"] = {
                "connected": bool(a2.get("connected")),
                "client_id": int(a2.get("client_id") or cid2),
                "last_error": a2.get("last_error"),
            }
        else:
            out["secondary"] = {
                "connected": False,
                "client_id": cid2,
                "last_error": unreachable
                if not health
                else ("Set Second IB host in Settings to enable" if not ib2_host else None),
            }
    return out
