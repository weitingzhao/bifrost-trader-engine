"""Redis control-env helpers for market ingest Ops plane."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

from backend.ops.market_ingest_control_env import (
    BIFROST_OPS_CONTROL_ENV_FIELD,
    clear_control_env,
    normalize_control_profile,
    read_control_env,
    write_control_env,
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
