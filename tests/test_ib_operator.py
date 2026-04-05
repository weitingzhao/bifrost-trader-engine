"""IB Operator protocol, executor, and Redis client (mocked)."""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from src.ib_operator.client import IbOperatorClient, build_monitor_ib_status
from src.ib_operator.executor import IbOperatorExecutor
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


def test_build_monitor_ib_status_disabled_skip() -> None:
    cfg = {"server": {"skip_monitor_ib": True}, "redis": {"enabled": True}}
    assert build_monitor_ib_status(cfg, {}) is None


def test_build_monitor_ib_status_no_redis() -> None:
    cfg = {"server": {}, "redis": {"enabled": False}}
    assert build_monitor_ib_status(cfg, {"ib_client_id_operator": 120}) is None


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
