"""IB Operator protocol, executor, and Redis client (mocked)."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.ib_operator.client import IbOperatorClient, build_monitor_ib_status, read_operator_health
from src.ib_operator.config import effective_ib_operator_settings
from src.ib_operator.executor import IbOperatorExecutor
from src.ib_operator.health_redis import (
    operator_health_dict_from_redis_hash,
    operator_health_dict_to_redis_hash,
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
        "operator": {"connected": True, "client_id": 120, "last_error": None},
        "operator_alive": True,
        "account2": None,
        "updated_at": 1_700_000_000.0,
    }
    m = operator_health_dict_to_redis_hash(h)
    assert m["operator_connected"] == "1"
    assert m["operator_client_id"] == "120"
    assert m["account2_present"] == "0"
    h2 = operator_health_dict_from_redis_hash(m)
    assert h2 is not None
    assert h2["operator"]["connected"] is True
    assert h2["operator"]["client_id"] == 120
    assert h2["operator"]["last_error"] is None
    assert h2["account2"] is None


def test_operator_health_hash_roundtrip_with_account2() -> None:
    h = {
        "operator": {"connected": True, "client_id": 120, "last_error": "primary_err"},
        "operator_alive": True,
        "account2": {"connected": False, "client_id": 11, "last_error": None},
        "updated_at": 1.0,
    }
    m = operator_health_dict_to_redis_hash(h)
    h2 = operator_health_dict_from_redis_hash(m)
    assert h2 is not None
    assert h2["account2"] is not None
    assert h2["account2"]["connected"] is False
    assert h2["account2"]["client_id"] == 11
    assert h2["account2"]["last_error"] is None
    assert h2["operator"]["last_error"] == "primary_err"


def test_operator_health_from_redis_hash_empty() -> None:
    assert operator_health_dict_from_redis_hash({}) is None


def test_read_operator_health_hash_and_legacy_string() -> None:
    class FakeRedisHash:
        def type(self, _key: str) -> str:
            return "hash"

        def hgetall(self, _key: str) -> dict:
            return operator_health_dict_to_redis_hash(
                {
                    "operator": {"connected": True, "client_id": 5, "last_error": None},
                    "operator_alive": True,
                    "account2": None,
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
    assert h["operator"]["client_id"] == 5

    with patch("src.ib_operator.client.redis.from_url", return_value=FakeRedisString()):
        h2 = read_operator_health("redis://x", "k")
    assert h2 is not None
    assert h2["operator"]["client_id"] == 9
    assert h2["operator"]["connected"] is False


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
        "operator": {"connected": True, "client_id": 101, "last_error": None},
        "operator_alive": True,
        "account2": None,
    }
    with patch("src.ib_operator.client.read_operator_health", return_value=fake_health):
        out = build_monitor_ib_status(cfg, ib)
    assert out is not None
    assert out["connected"] is True
    assert out["host"]["connected"] is True
    assert out["host"]["client_id"] == 101


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
    pipe = MagicMock()
    r = MagicMock()
    r.pipeline.return_value = pipe
    _write_health_sync(r, ex, "bifrost:health:ws_ib_operator", 60)
    pipe.delete.assert_not_called()
    pipe.hset.assert_called_once()
    pipe.expire.assert_called_once()
    pipe.execute.assert_called_once()
