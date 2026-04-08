"""Redis writer for IB ingestor meta, quotes, and pub/sub notifications."""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Set

from src.vendor.ib_ingestor.redis_keys import (
    IB_INGESTER_CHANNEL,
    IB_INGESTER_META_HEALTH,
    IB_INGESTER_META_SUBSCRIPTIONS,
    IB_INGESTER_TICK_PREFIX,
    IB_INGESTER_TICK_TTL_SEC,
)


class IbIngestorRedisWriter:
    def __init__(self, rds: Any) -> None:
        self._rds = rds

    def write_quote(self, contract_key: str, data: Dict[str, Any]) -> None:
        key = IB_INGESTER_TICK_PREFIX + contract_key
        self._rds.set(key, json.dumps(data, default=str), ex=IB_INGESTER_TICK_TTL_SEC)
        self._rds.publish(
            IB_INGESTER_CHANNEL,
            json.dumps({"contract_key": contract_key, "ts": data.get("ts")}, default=str),
        )

    def update_health(
        self,
        client_id: int,
        connected: bool,
        last_msg_ts: float,
        reconnects: int,
        msg_count: int,
        *,
        ib_probe_at: float = 0.0,
        ib_probe_ok: bool = False,
        ib_probe_interval_sec: float = 0.0,
    ) -> None:
        m: Dict[str, str] = {
            "client_id": str(client_id),
            "connected": "1" if connected else "0",
            "last_msg_ts": str(last_msg_ts),
            "reconnects": str(reconnects),
            "msg_count": str(msg_count),
            "updated_at": str(time.time()),
            "ib_probe_at": str(ib_probe_at),
            "ib_probe_ok": "1" if ib_probe_ok else "0",
            "ib_probe_interval_sec": str(ib_probe_interval_sec),
        }
        self._rds.hset(IB_INGESTER_META_HEALTH, mapping=m)

    def set_subscriptions(self, contract_keys: Set[str]) -> None:
        pipe = self._rds.pipeline()
        pipe.delete(IB_INGESTER_META_SUBSCRIPTIONS)
        if contract_keys:
            pipe.sadd(IB_INGESTER_META_SUBSCRIPTIONS, *sorted(contract_keys))
        pipe.execute()
