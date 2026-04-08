"""IB connection backoff and probe policy helpers."""

from src.ib.connection_policy import (
    get_ib_connection_policy,
    merge_ib_policy_into_effective_ib,
    operator_effective_health_refresh_sec,
    reconnect_delay_s,
)


def test_reconnect_delay_s_caps() -> None:
    assert reconnect_delay_s(1, base=2.0, max_s=60.0, max_exp=6) == 2.0
    assert reconnect_delay_s(7, base=2.0, max_s=60.0, max_exp=6) == 60.0


def test_get_ib_connection_policy_defaults() -> None:
    p = get_ib_connection_policy({})
    assert p["reconnect_base_sec"] == 2.0
    assert p["ib_probe_interval_sec"] == 5.0


def test_merge_ib_policy_into_effective_ib() -> None:
    out = {"host": "x"}
    merge_ib_policy_into_effective_ib(out, {})
    assert "ib_probe_interval_sec" in out


def test_operator_effective_health_refresh_sec() -> None:
    assert operator_effective_health_refresh_sec({"health_refresh_sec": 3}, 5.0) == 5.0
    assert operator_effective_health_refresh_sec({"health_refresh_sec": 10}, 5.0) == 10.0
