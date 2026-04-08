"""GET /status IB probe derived fields."""

import time

from src.monitor.integrations.ib_probe_derived import (
    attach_ib_probe_derived,
    parse_redis_probe_triple,
)


def test_attach_ib_probe_derived_stale() -> None:
    now = time.time()
    slot: dict = {}
    attach_ib_probe_derived(
        slot,
        probe_at=now - 100.0,
        probe_interval=5.0,
        probe_ok=True,
        stale_mult=2.0,
        now=now,
    )
    assert slot["ib_probe_stale"] is True
    assert slot["next_ib_probe_in_s"] == 0.0


def test_attach_skips_when_probe_at_zero() -> None:
    slot = {"connected": True}
    attach_ib_probe_derived(
        slot,
        probe_at=0.0,
        probe_interval=5.0,
        probe_ok=False,
        stale_mult=2.0,
        now=time.time(),
    )
    assert "last_ib_probe_at" not in slot


def test_parse_redis_probe_triple() -> None:
    pa, ok, iv = parse_redis_probe_triple(
        {"ib_probe_at": "1.5", "ib_probe_ok": "1", "ib_probe_interval_sec": "5"},
        "ib_probe_at",
        "ib_probe_ok",
        "ib_probe_interval_sec",
    )
    assert pa == 1.5
    assert ok is True
    assert iv == 5.0
