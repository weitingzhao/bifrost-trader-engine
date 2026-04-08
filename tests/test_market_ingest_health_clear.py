"""Ops Socket Services Redis health helpers (exclusive start + stop cleanup)."""

import time
from unittest.mock import MagicMock

import pytest

import backend.ops.market_ingest_health_clear as health_clear_mod
from backend.ops.market_ingest_health_clear import (
    clear_ingest_health_after_stop,
    ingest_redis_health_looks_live,
)


@pytest.fixture()
def fake_redis(monkeypatch: pytest.MonkeyPatch):
    r = MagicMock()
    store: dict = {}

    def hgetall(k: str):
        return dict(store.get(k, {}))

    def hset(k: str, mapping=None, **kwargs):
        if mapping is None:
            mapping = kwargs
        cur = dict(store.get(k, {}))
        cur.update(mapping)
        store[k] = cur

    def hdel(k: str, *fields: str):
        cur = store.get(k, {})
        for f in fields:
            cur.pop(f, None)
        store[k] = cur

    def close():
        pass

    r.hgetall.side_effect = hgetall
    r.hset.side_effect = hset
    r.hdel.side_effect = hdel
    r.close = close

    monkeypatch.setattr(health_clear_mod, "_conn", lambda _url: r)
    return store


def test_looks_live_massive_recent_connected(fake_redis) -> None:
    store = fake_redis
    key = "bifrost:health:ws_massive_option"
    store[key] = {
        "connected": "1",
        "updated_at": str(time.time()),
        "last_msg_ts": str(time.time()),
        "reconnects": "0",
        "msg_count": "1",
    }
    assert ingest_redis_health_looks_live("redis://unused/0", key, "massive_ws") is True


def test_looks_live_massive_stale_not_live(fake_redis) -> None:
    store = fake_redis
    key = "bifrost:health:ws_massive_option"
    store[key] = {
        "connected": "1",
        "updated_at": str(time.time() - 500),
    }
    assert ingest_redis_health_looks_live("redis://unused/0", key, "massive_ws") is False


def test_clear_stop_massive(fake_redis) -> None:
    store = fake_redis
    key = "bifrost:health:ws_massive_option"
    store[key] = {"connected": "1", "updated_at": str(time.time())}
    clear_ingest_health_after_stop("redis://unused/0", key, "massive_ws")
    assert store[key].get("connected") == "0"


def test_clear_stop_ib_operator(fake_redis) -> None:
    store = fake_redis
    key = "bifrost:health:ws_ib_operator"
    store[key] = {
        "host_connected": "1",
        "host_alive": "1",
        "updated_at": str(time.time()),
    }
    clear_ingest_health_after_stop("redis://unused/0", key, "ib_operator")
    assert store[key].get("host_connected") == "0"
    assert store[key].get("host_alive") == "0"


def test_clear_stop_ib_account_agent(fake_redis) -> None:
    store = fake_redis
    key = "bifrost:health:ws_ib_account_agent"
    store[key] = {"connected": "1", "host_connected": "1", "host_alive": "1", "updated_at": str(time.time())}
    clear_ingest_health_after_stop("redis://unused/0", key, "ib_account_agent")
    assert store[key].get("host_connected") == "0"
    assert store[key].get("host_alive") == "0"
