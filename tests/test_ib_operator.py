"""IB Operator protocol, executor, and Redis client (mocked)."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.ib_operator.client import IbOperatorClient, build_monitor_ib_status, read_operator_health
from src.ib_operator.config import effective_ib_operator_settings
from src.ib_operator.executor import IbOperatorExecutor
from src.ib_operator.health_redis import (
    LEGACY_OPERATOR_HEALTH_HASH_FIELDS,
    operator_health_dict_from_redis_hash,
    operator_health_dict_to_redis_hash,
    prune_legacy_operator_health_hash_fields,
)
from src.ib_operator.protocol import PROTOCOL_VERSION, parse_stream_fields
from src.ib_operator.redis_io import (
    ensure_stream_and_group,
    is_nogroup_error,
    parse_xreadgroup_reply,
)


def test_parse_stream_fields_ok() -> None:
    fields = {
        "req_id": "u1",
        "v": PROTOCOL_VERSION,
        "op": "ping",
        "payload": "{}",
        "caller": "test",
        "deadline_ms": "9999999999999",
    }
    msg, err = parse_stream_fields(fields, stream_id="1-0")
    assert err is None
    assert msg is not None
    assert msg.op == "ping"
    assert msg.req_id == "u1"


def test_parse_stream_fields_unknown_op() -> None:
    fields = {
        "req_id": "u1",
        "v": PROTOCOL_VERSION,
        "op": "nope",
        "payload": "{}",
    }
    msg, err = parse_stream_fields(fields, stream_id="1-0")
    assert msg is None
    assert err and "unknown_op" in err


@pytest.mark.asyncio
async def test_executor_ping() -> None:
    primary = MagicMock()
    primary.connected = False
    ex = IbOperatorExecutor(primary=primary, account_secondary=None)
    out = await ex.execute("ping", {})
    assert out["ok"] is True
    assert "data" in out


def test_health_dict_uses_connected_snapshot_when_present() -> None:
    """Redis health must use loop-thread snapshot, not cross-thread ``connected`` property."""
    primary = MagicMock()
    primary.connected_snapshot = MagicMock(return_value=True)
    primary.client_id = 101
    primary.last_error = None
    primary.reconnects = 0
    ex = IbOperatorExecutor(primary=primary, account_secondary=None)
    h = ex.health_dict()
    assert h["host"]["connected"] is True
    primary.connected_snapshot.assert_called_once()


@pytest.mark.asyncio
async def test_executor_fetch_bars_delegates() -> None:
    primary = MagicMock()
    primary.fetch_bars = AsyncMock(return_value=[{"open": 1.0}])
    ex = IbOperatorExecutor(primary=primary, account_secondary=None)
    out = await ex.execute(
        "fetch_bars",
        {"symbol": "AAPL", "period": "1 D", "duration": "5 D"},
    )
    assert out["ok"] is True
    assert len(out["data"]["bars"]) == 1
    primary.fetch_bars.assert_awaited_once()


@pytest.mark.asyncio
async def test_executor_place_stock_order_delegates_to_connector() -> None:
    trade = MagicMock()
    trade.order = MagicMock()
    trade.order.orderId = 42
    connector = MagicMock()
    connector.place_order = AsyncMock(return_value=trade)
    primary = MagicMock()
    primary._ensure_connected_impl = AsyncMock()
    primary.connector = connector
    ex = IbOperatorExecutor(primary=primary, account_secondary=None)
    out = await ex.execute(
        "place_stock_order",
        {"symbol": "AAPL", "side": "BUY", "quantity": 10, "order_type": "market"},
    )
    assert out["ok"] is True
    assert out["data"]["order_id"] == 42
    primary._ensure_connected_impl.assert_awaited_once()
    connector.place_order.assert_awaited_once()


def test_effective_ib_operator_settings_redis_key_defaults() -> None:
    cfg = {"redis": {"enabled": True}}
    s = effective_ib_operator_settings(cfg)
    assert s["stream"] == "ib:operator:cmd"
    assert s["result_prefix"] == "ib:operator:result:"
    assert s["health_key"] == "bifrost:health:ws_ib_operator"


def test_effective_ib_operator_normalizes_legacy_health_key() -> None:
    cfg = {
        "redis": {"enabled": True},
        "ib_operator": {"health_key": "ib:operator:meta:health"},
    }
    s = effective_ib_operator_settings(cfg)
    assert s["health_key"] == "bifrost:health:ws_ib_operator"


def test_effective_ib_operator_normalizes_prior_bifrost_health_key() -> None:
    cfg = {
        "redis": {"enabled": True},
        "ib_operator": {"health_key": "bifrost:health:ib_operator"},
    }
    s = effective_ib_operator_settings(cfg)
    assert s["health_key"] == "bifrost:health:ws_ib_operator"


def test_effective_ib_operator_ignores_custom_health_key() -> None:
    cfg = {
        "redis": {"enabled": True},
        "ib_operator": {"health_key": "ib:operator:meta:health:custom"},
    }
    s = effective_ib_operator_settings(cfg)
    assert s["health_key"] == "bifrost:health:ws_ib_operator"


def test_operator_health_hash_roundtrip_no_secondary() -> None:
    h = {
        "host": {"connected": True, "client_id": 120, "last_error": None},
        "service_alive": True,
        "secondary": None,
        "updated_at": 1_700_000_000.0,
    }
    m = operator_health_dict_to_redis_hash(h)
    assert m["host_connected"] == "1"
    assert m["host_client_id"] == "120"
    assert m["secondary_present"] == "0"
    assert m["msg_count"] == "0"
    assert m["host_reconnects"] == "0"
    assert "last_msg_ts" in m
    assert m["secondary_reconnects"] == "0"
    h2 = operator_health_dict_from_redis_hash(m)
    assert h2 is not None
    assert h2["host"]["connected"] is True
    assert h2["host"]["client_id"] == 120
    assert h2["host"]["last_error"] is None
    assert h2["secondary"] is None
    assert h2["operator"] is h2["host"]
    assert h2["account2"] is None


def test_operator_health_hash_roundtrip_with_secondary() -> None:
    h = {
        "host": {"connected": True, "client_id": 120, "last_error": "primary_err"},
        "service_alive": True,
        "secondary": {"connected": False, "client_id": 11, "last_error": None},
        "updated_at": 1.0,
    }
    m = operator_health_dict_to_redis_hash(h)
    h2 = operator_health_dict_from_redis_hash(m)
    assert h2 is not None
    assert h2["secondary"] is not None
    assert h2["secondary"]["connected"] is False
    assert h2["secondary"]["client_id"] == 11
    assert h2["secondary"]["last_error"] is None
    assert h2["host"]["last_error"] == "primary_err"


def test_operator_health_legacy_operator_account2_keys_still_encode() -> None:
    """Executor-shaped dicts before host/secondary rename still flatten correctly."""
    h = {
        "operator": {"connected": True, "client_id": 1, "last_error": None},
        "operator_alive": True,
        "account2": None,
        "updated_at": 0.0,
    }
    m = operator_health_dict_to_redis_hash(h)
    assert m["host_client_id"] == "1"
    assert m["secondary_present"] == "0"


def test_prune_legacy_operator_health_hash_fields() -> None:
    r = MagicMock()
    prune_legacy_operator_health_hash_fields(r, "k")
    r.hdel.assert_called_once_with("k", *LEGACY_OPERATOR_HEALTH_HASH_FIELDS)


def test_operator_health_from_redis_hash_empty() -> None:
    assert operator_health_dict_from_redis_hash({}) is None


def test_read_operator_health_hash_and_legacy_string() -> None:
    class FakeRedisHash:
        def type(self, _key: str) -> str:
            return "hash"

        def hgetall(self, _key: str) -> dict:
            return operator_health_dict_to_redis_hash(
                {
                    "host": {"connected": True, "client_id": 5, "last_error": None},
                    "service_alive": True,
                    "secondary": None,
                    "updated_at": 0.0,
                }
            )

        def get(self, _key: str) -> None:
            raise AssertionError("should not GET hash key")

        def close(self) -> None:
            pass

    class FakeRedisString:
        def type(self, _key: str) -> str:
            return "string"

        def hgetall(self, _key: str) -> dict:
            return {}

        def get(self, _key: str) -> str:
            return '{"operator":{"connected":false,"client_id":9,"last_error":null},"operator_alive":true,"account2":null}'

        def close(self) -> None:
            pass

    with patch("src.ib_operator.client.redis.from_url", return_value=FakeRedisHash()):
        h = read_operator_health("redis://x", "k")
    assert h is not None
    assert h["host"]["client_id"] == 5
    assert h["operator"]["client_id"] == 5

    with patch("src.ib_operator.client.redis.from_url", return_value=FakeRedisString()):
        h2 = read_operator_health("redis://x", "k")
    assert h2 is not None
    assert h2["host"]["client_id"] == 9
    assert h2["host"]["connected"] is False
    assert h2["operator"]["client_id"] == 9


def test_build_monitor_ib_status_disabled_skip() -> None:
    cfg = {"server": {"skip_monitor_ib": True}, "redis": {"enabled": True}}
    assert build_monitor_ib_status(cfg, {}) is None


def test_build_monitor_ib_status_no_redis() -> None:
    cfg = {"server": {}, "redis": {"enabled": False}}
    assert build_monitor_ib_status(cfg, {"ib_client_id_operator": 120}) is None


def test_build_monitor_ib_status_top_level_connected_matches_host() -> None:
    cfg = {"server": {}, "redis": {"enabled": True}}
    ib = {"ib_client_id_operator": 101}
    fake_health = {
        "host": {"connected": True, "client_id": 101, "last_error": None, "reconnects": 2},
        "service_alive": True,
        "secondary": None,
        "msg_count": 40,
        "last_msg_ts": 1_700_000_100.0,
    }
    with patch("src.ib_operator.client.read_operator_health", return_value=fake_health), patch(
        "src.ib_operator.client.time.time", return_value=1_700_000_200.0
    ):
        out = build_monitor_ib_status(cfg, ib)
    assert out is not None
    assert out["connected"] is True
    assert out["host"]["connected"] is True
    assert out["host"]["client_id"] == 101
    assert out["host"]["reconnects"] == 2
    assert out["msg_count"] == 40
    assert out["reconnects"] == 2
    assert out["last_msg_age_s"] == 100.0
    assert out["service_alive"] is True
    assert out["operator_alive"] is True


def test_build_monitor_ib_status_service_alive_from_health() -> None:
    cfg = {"server": {}, "redis": {"enabled": True}}
    ib = {"ib_client_id_operator": 101}
    fake_health = {
        "host": {"connected": True, "client_id": 101, "last_error": None, "reconnects": 0},
        "service_alive": False,
        "secondary": None,
        "msg_count": 1,
        "last_msg_ts": 1.0,
    }
    with patch("src.ib_operator.client.read_operator_health", return_value=fake_health), patch(
        "src.ib_operator.client.time.time", return_value=2.0
    ):
        out = build_monitor_ib_status(cfg, ib)
    assert out is not None
    assert out["connected"] is True
    assert out["service_alive"] is False
    assert out["operator_alive"] is False


def test_parse_xreadgroup_reply_empty() -> None:
    assert parse_xreadgroup_reply(None) == []
    assert parse_xreadgroup_reply([]) == []


def test_ib_operator_client_request_polls_result() -> None:
    store: dict = {}

    class FakeRedis:
        def xadd(self, stream, fields):
            store["fields"] = fields
            return "1-0"

        def get(self, key):
            if key.endswith("abc"):
                return json.dumps({"ok": True, "data": {"x": 1}})
            return None

    with patch("src.ib_operator.client.redis.from_url", return_value=FakeRedis()):
        c = IbOperatorClient(
            redis_url="redis://localhost:6379/0",
            stream="s",
            result_prefix="p:",
            default_timeout_sec=1.0,
        )
        with patch("src.ib_operator.client.new_req_id", return_value="abc"):
            out = c.request("ping", {}, caller="t")
    assert out == {"ok": True, "data": {"x": 1}}


def test_is_nogroup_error() -> None:
    from redis.exceptions import ResponseError

    assert is_nogroup_error(ResponseError("NOGROUP ..."))
    assert not is_nogroup_error(ResponseError("WRONGTYPE ..."))


def test_ensure_stream_and_group_busygroup_ignored() -> None:
    r = MagicMock()
    r.xgroup_create.side_effect = Exception("BUSYGROUP Consumer Group name already exists")
    ensure_stream_and_group(r, "stream", "grp")  # no raise


def test_write_health_sync_does_not_delete_hash() -> None:
    """Ops stores bifrost_ops_control_env on the operator health hash; health refresh must merge (no DELETE)."""
    from src.ib_operator.service import _write_health_sync

    primary = MagicMock()
    primary.connected = False
    ex = IbOperatorExecutor(primary=primary, account_secondary=None)
    r = MagicMock()
    _write_health_sync(r, ex, "bifrost:health:ws_ib_operator")
    r.delete.assert_not_called()
    r.hset.assert_called_once()
    r.hdel.assert_called_once()
    r.pipeline.assert_not_called()


def test_write_shutdown_health_sync_forces_disconnected_and_not_alive() -> None:
    """Graceful stop should push host_connected=0 and host_alive=0 before exit (Socket Services /status)."""
    from src.ib_operator.service import _write_shutdown_health_sync

    primary = MagicMock()
    primary.connected = True
    primary.client_id = 120
    primary.last_error = None
    primary.reconnects = 0
    ex = IbOperatorExecutor(primary=primary, account_secondary=None)
    r = MagicMock()
    _write_shutdown_health_sync(r, ex, "bifrost:health:ws_ib_operator")
    r.delete.assert_not_called()
    r.hset.assert_called_once()
    mapping = r.hset.call_args.kwargs["mapping"]
    assert mapping["host_connected"] == "0"
    assert mapping["host_alive"] == "0"
    assert mapping["host_client_id"] == "120"
    r.hdel.assert_called_once()


def test_operator_health_hash_writes_secondary_zeros_when_no_secondary() -> None:
    """HSET merges fields; without secondary, still write secondary_* so Redis has no stale 1s."""
    from src.ib_operator.health_redis import operator_health_dict_to_redis_hash

    m = operator_health_dict_to_redis_hash(
        {
            "host": {"connected": False, "client_id": 120, "last_error": None, "reconnects": 0},
            "service_alive": True,
            "secondary": None,
        }
    )
    assert m["secondary_present"] == "0"
    assert m["secondary_connected"] == "0"
    assert m["secondary_client_id"] == "0"
    assert m["secondary_reconnects"] == "0"
