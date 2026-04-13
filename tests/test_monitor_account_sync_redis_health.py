"""Regression: Account Sync GET /status must not show green on PG alone when Redis health is dead."""

import time

from backend.monitor.routers.status import (
    _ACCOUNT_SYNC_REDIS_HEALTH_MAX_AGE_SEC,
    _account_sync_redis_reports_alive,
)


class _FakeRedis:
    def __init__(self, mapping: dict) -> None:
        self._mapping = mapping

    def hgetall(self, _key: str) -> dict:
        return dict(self._mapping)


def test_account_sync_redis_reports_alive_fresh_hash() -> None:
    now = time.time()
    r = _FakeRedis({"alive": "1", "updated_at": str(now)})
    assert _account_sync_redis_reports_alive(r, now_ts=now) is True


def test_account_sync_redis_reports_alive_stale_updated_at() -> None:
    now = time.time()
    r = _FakeRedis(
        {"alive": "1", "updated_at": str(now - _ACCOUNT_SYNC_REDIS_HEALTH_MAX_AGE_SEC - 1.0)}
    )
    assert _account_sync_redis_reports_alive(r, now_ts=now) is False


def test_account_sync_redis_reports_alive_not_alive() -> None:
    now = time.time()
    r = _FakeRedis({"alive": "0", "updated_at": str(now)})
    assert _account_sync_redis_reports_alive(r, now_ts=now) is False


def test_account_sync_redis_reports_alive_empty() -> None:
    r = _FakeRedis({})
    assert _account_sync_redis_reports_alive(r, now_ts=time.time()) is False


def test_account_sync_redis_reports_alive_hgetall_raises() -> None:
    class Bad:
        def hgetall(self, _k: str) -> dict:
            raise OSError("redis down")

    assert _account_sync_redis_reports_alive(Bad(), now_ts=time.time()) is False
