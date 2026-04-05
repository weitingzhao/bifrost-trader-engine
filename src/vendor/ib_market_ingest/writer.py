"""Redis writer for IB market ingest meta, quotes, and pub/sub notifications."""

from __future__ import annotations

import json
import time
from typing import Any, Dict, Set

from src.vendor.ib_market_ingest.redis_keys import (
    IB_MD_CHANNEL,
    IB_MD_META_SUBSCRIPTIONS,
    IB_MD_PREFIX,
    IB_MD_TTL_SEC,
    IB_META_STATUS,
)


class IbMarketRedisWriter:
    def __init__(self, rds: Any) -> None:
        self._rds = rds

    def write_quote(self, contract_key: str, data: Dict[str, Any]) -> None:
        key = IB_MD_PREFIX + contract_key
        self._rds.set(key, json.dumps(data, default=str), ex=IB_MD_TTL_SEC)
        self._rds.publish(
            IB_MD_CHANNEL,
            json.dumps({"contract_key": contract_key, "ts": data.get("ts")}, default=str),
        )

    def update_status(
        self,
        connected: bool,
        last_msg_ts: float,
        reconnects: int,
        msg_count: int,
    ) -> None:
        self._rds.hset(
            IB_META_STATUS,
            mapping={
                "connected": "1" if connected else "0",
                "last_msg_ts": str(last_msg_ts),
                "reconnects": str(reconnects),
                "msg_count": str(msg_count),
                "updated_at": str(time.time()),
            },
        )

    def set_subscriptions(self, contract_keys: Set[str]) -> None:
        pipe = self._rds.pipeline()
        pipe.delete(IB_MD_META_SUBSCRIPTIONS)
        if contract_keys:
            pipe.sadd(IB_MD_META_SUBSCRIPTIONS, *sorted(contract_keys))
        pipe.execute()
