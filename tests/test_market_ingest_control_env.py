"""Redis control-env helpers for market ingest Ops plane."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from src.bifrost.redis_health_keys import ENGINE_OPS_ACTIVE_REDIS_FIELD

from backend.ops.market_ingest_control_env import (
    BIFROST_OPS_CONTROL_ENV_FIELD,
    clear_control_env,
    normalize_control_profile,
    read_control_env,
    write_control_env,
    write_trading_engine_ops_lease,
)


def test_normalize_control_profile() -> None:
    assert normalize_control_profile(None) is None
    assert normalize_control_profile("") is None
    assert normalize_control_profile("  DEV  ") == "dev"
    assert normalize_control_profile("Prod") == "prod"
    assert normalize_control_profile("staging") is None


@patch("redis.from_url")
def test_write_control_env_hset(mock_from_url: MagicMock) -> None:
    r = MagicMock()
    mock_from_url.return_value = r
    write_control_env("redis://localhost:6379/0", "my:meta", "dev")
    r.hset.assert_called_once_with("my:meta", BIFROST_OPS_CONTROL_ENV_FIELD, "dev")


@patch("redis.from_url")
def test_read_control_env_hget(mock_from_url: MagicMock) -> None:
    r = MagicMock()
    r.hget.return_value = "prod"
    mock_from_url.return_value = r
    assert read_control_env("redis://localhost:6379/0", "my:meta") == "prod"
    r.hget.assert_called_once_with("my:meta", BIFROST_OPS_CONTROL_ENV_FIELD)


@patch("redis.from_url")
def test_clear_control_env_hdel(mock_from_url: MagicMock) -> None:
    r = MagicMock()
    mock_from_url.return_value = r
    clear_control_env("redis://localhost:6379/0", "my:meta")
    r.hdel.assert_called_once_with("my:meta", BIFROST_OPS_CONTROL_ENV_FIELD)


@patch("redis.from_url")
def test_write_trading_engine_ops_lease_sets_lease_active_updated(mock_from_url: MagicMock) -> None:
    r = MagicMock()
    mock_from_url.return_value = r
    write_trading_engine_ops_lease("redis://localhost:6379/0", "bifrost:ops:trading_engine", "prod")
    r.hset.assert_called_once()
    _args, kwargs = r.hset.call_args
    mapping = kwargs["mapping"]
    assert mapping[BIFROST_OPS_CONTROL_ENV_FIELD] == "prod"
    assert mapping[ENGINE_OPS_ACTIVE_REDIS_FIELD] == "1"
    assert float(mapping["updated_at"]) > 0
