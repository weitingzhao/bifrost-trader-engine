"""Unit tests for Redis-backed system message center helpers."""

from __future__ import annotations

import json
from unittest.mock import patch

from src.bifrost.message_center import (
    IbConnectionStatusTracker,
    MESSAGE_CENTER_INDEX_KEY,
    build_ib_connection_event,
    fetch_materialized_messages,
    materialize_stream_event,
)


class FakePipeline:
    def __init__(self, redis: "FakeRedis") -> None:
        self._redis = redis
        self._ops = []

    def set(self, key: str, value: str, ex: int | None = None) -> "FakePipeline":
        self._ops.append(("set", key, value, ex))
        return self

    def delete(self, key: str) -> "FakePipeline":
        self._ops.append(("delete", key))
        return self

    def zadd(self, key: str, mapping: dict[str, float]) -> "FakePipeline":
        self._ops.append(("zadd", key, mapping))
        return self

    def zrem(self, key: str, *members: str) -> "FakePipeline":
        self._ops.append(("zrem", key, members))
        return self

    def get(self, key: str) -> "FakePipeline":
        self._ops.append(("get", key))
        return self

    def execute(self):
        out = []
        for op in self._ops:
            kind = op[0]
            if kind == "set":
                _, key, value, ex = op
                out.append(self._redis.set(key, value, ex=ex))
            elif kind == "delete":
                _, key = op
                out.append(self._redis.delete(key))
            elif kind == "zadd":
                _, key, mapping = op
                out.append(self._redis.zadd(key, mapping))
            elif kind == "zrem":
                _, key, members = op
                out.append(self._redis.zrem(key, *members))
            elif kind == "get":
                _, key = op
                out.append(self._redis.get(key))
        self._ops.clear()
        return out


class FakeRedis:
    def __init__(self) -> None:
        self.kv: dict[str, str] = {}
        self.zsets: dict[str, dict[str, float]] = {}
        self.expiry: dict[str, int | None] = {}
        self.stream: list[tuple[str, dict[str, str]]] = []

    def xadd(self, key: str, fields: dict[str, str], maxlen=None, approximate=None) -> str:
        entry_id = f"{len(self.stream) + 1}-0"
        self.stream.append((entry_id, {"_stream_key": key, **fields}))
        return entry_id

    def get(self, key: str):
        return self.kv.get(key)

    def set(self, key: str, value: str, ex: int | None = None):
        self.kv[key] = value
        self.expiry[key] = ex
        return True

    def delete(self, key: str):
        self.kv.pop(key, None)
        self.expiry.pop(key, None)
        return 1

    def zadd(self, key: str, mapping: dict[str, float]):
        bucket = self.zsets.setdefault(key, {})
        bucket.update(mapping)
        return 1

    def zrem(self, key: str, *members: str):
        bucket = self.zsets.setdefault(key, {})
        for member in members:
            bucket.pop(member, None)
        return 1

    def zrevrange(self, key: str, start: int, end: int):
        bucket = self.zsets.get(key, {})
        ordered = sorted(bucket.items(), key=lambda item: item[1], reverse=True)
        stop = None if end < 0 else end + 1
        return [member for member, _score in ordered[start:stop]]

    def pipeline(self) -> FakePipeline:
        return FakePipeline(self)


def test_status_tracker_skips_initial_disconnected_but_publishes_first_connected() -> None:
    redis = FakeRedis()
    tracker = IbConnectionStatusTracker(redis, service="ib_ingestor")

    assert tracker.update(slot="host", status="disconnected", client_id=150) is None
    assert redis.stream == []

    tracker.update(slot="host", status="connected", client_id=150, occurred_at=100.0)
    assert len(redis.stream) == 1
    _entry_id, payload = redis.stream[0]
    assert payload["status_from"] == "disconnected"
    assert payload["status_to"] == "connected"
    assert payload["service"] == "ib_ingestor"
    assert payload["slot"] == "host"


def test_materialize_stream_event_dedupes_previous_message_and_sets_ttl() -> None:
    redis = FakeRedis()
    first = build_ib_connection_event(
        service="ib_operator",
        slot="host",
        client_id=120,
        account=None,
        status_from="connected",
        status_to="disconnected",
        occurred_at=100.0,
    )
    second = build_ib_connection_event(
        service="ib_operator",
        slot="host",
        client_id=120,
        account=None,
        status_from="disconnected",
        status_to="disconnected",
        occurred_at=110.0,
    )
    second = second.__class__(**{**second.__dict__, "dedupe_key": first.dedupe_key})

    with patch("src.bifrost.message_center.time.time", return_value=120.0):
        materialize_stream_event(redis, first)
        materialize_stream_event(redis, second)

    assert first.message_id not in redis.zsets[MESSAGE_CENTER_INDEX_KEY]
    assert second.message_id in redis.zsets[MESSAGE_CENTER_INDEX_KEY]
    assert redis.kv.get(f"bifrost:msg:center:item:{first.message_id}") is None
    assert redis.expiry[f"bifrost:msg:center:item:{second.message_id}"] == 3590


def test_fetch_materialized_messages_prunes_missing_items() -> None:
    redis = FakeRedis()
    redis.zadd(MESSAGE_CENTER_INDEX_KEY, {"missing": 200.0, "present": 100.0})
    redis.set(
        "bifrost:msg:center:item:present",
        json.dumps(
            {
                "message_id": "present",
                "title": "Connected",
                "message": "Service connected",
                "topic": "ib.connection",
                "level": "success",
                "occurred_at": 100.0,
            }
        ),
        ex=3600,
    )

    messages = fetch_materialized_messages(redis, limit=5)

    assert [message["message_id"] for message in messages] == ["present"]
    assert "missing" not in redis.zsets[MESSAGE_CENTER_INDEX_KEY]
