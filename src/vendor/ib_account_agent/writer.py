"""Redis writer for IB Account Agent health + snapshot (JSON)."""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

from src.vendor.ib_account_agent.redis_keys import (
    IB_ACCOUNT_AGENT_META_HEALTH,
    IB_ACCOUNT_NOTIFY_CHANNEL,
    IB_ACCOUNT_SNAPSHOT_KEY,
    IB_ACCOUNT_STREAM_KEY,
    IB_ACCOUNT_STREAM_MAXLEN,
)

logger = logging.getLogger(__name__)


class IbAccountAgentRedisWriter:
    def __init__(self, r: Any) -> None:
        self._r = r
        self._version = 0

    def update_health(
        self,
        client_id: int,
        connected: bool,
        last_msg_ts: float,
        reconnects: int,
        msg_count: int,
        *,
        secondary_connected: Optional[bool] = None,
        secondary_client_id: Optional[int] = None,
        host_alive: bool = True,
        host_ib_probe_at: float = 0.0,
        host_ib_probe_ok: bool = False,
        host_ib_probe_interval_sec: float = 0.0,
        secondary_ib_probe_at: float = 0.0,
        secondary_ib_probe_ok: bool = False,
        secondary_ib_probe_interval_sec: float = 0.0,
    ) -> None:
        # `connected` / `client_id` = Host slot (backward compat with older readers).
        # `host_connected` / `host_client_id` explicit for Monitor /status (same idea as IB Operator).
        # `host_alive` = process in service (false on graceful shutdown); drives /status service_alive for lamps.
        m: Dict[str, str] = {
            "connected": "1" if connected else "0",
            "host_connected": "1" if connected else "0",
            "host_alive": "1" if host_alive else "0",
            "client_id": str(client_id),
            "host_client_id": str(client_id),
            "last_msg_ts": str(last_msg_ts),
            "reconnects": str(reconnects),
            "msg_count": str(msg_count),
            "updated_at": str(time.time()),
            "host_ib_probe_at": str(host_ib_probe_at),
            "host_ib_probe_ok": "1" if host_ib_probe_ok else "0",
            "host_ib_probe_interval_sec": str(host_ib_probe_interval_sec),
            "secondary_ib_probe_at": str(secondary_ib_probe_at),
            "secondary_ib_probe_ok": "1" if secondary_ib_probe_ok else "0",
            "secondary_ib_probe_interval_sec": str(secondary_ib_probe_interval_sec),
        }
        if secondary_connected is not None:
            m["secondary_connected"] = "1" if secondary_connected else "0"
        if secondary_client_id is not None:
            m["secondary_client_id"] = str(secondary_client_id)
        try:
            self._r.hset(IB_ACCOUNT_AGENT_META_HEALTH, mapping=m)
        except Exception as e:
            err = str(e).lower()
            # Recover if key was created with wrong type (string/stream) — HSET would fail.
            if "wrong kind" in err or "wrongtype" in err:
                try:
                    self._r.delete(IB_ACCOUNT_AGENT_META_HEALTH)
                    self._r.hset(IB_ACCOUNT_AGENT_META_HEALTH, mapping=m)
                except Exception as e2:
                    logger.warning("account agent health hset after key delete failed: %s", e2)
            else:
                logger.warning("account agent health hset failed: %s", e)

    def write_snapshot(
        self,
        payload: Dict[str, Any],
        *,
        publish_notify: bool = True,
    ) -> None:
        self._version += 1
        body = dict(payload)
        body["version"] = int(body.get("version") or self._version)
        body["updated_at"] = float(body.get("updated_at") or time.time())
        try:
            raw = json.dumps(body, separators=(",", ":"), default=str)
            self._r.set(IB_ACCOUNT_SNAPSHOT_KEY, raw)
            if publish_notify:
                self._r.publish(IB_ACCOUNT_NOTIFY_CHANNEL, str(body["version"]))
        except Exception as e:
            logger.warning("account agent snapshot set failed: %s", e)
        try:
            self._r.xadd(
                IB_ACCOUNT_STREAM_KEY,
                {
                    "version": str(body["version"]),
                    "updated_at": str(body["updated_at"]),
                    "payload": raw,
                },
                maxlen=IB_ACCOUNT_STREAM_MAXLEN,
                approximate=True,
            )
        except Exception as e:
            logger.warning("account agent stream xadd failed: %s", e)

    def set_subscriptions_meta(self, keys: List[str]) -> None:
        try:
            self._r.set(
                "ib:account:meta:subscriptions",
                json.dumps(sorted(keys), separators=(",", ":")),
            )
        except Exception as e:
            logger.debug("subscriptions meta: %s", e)
