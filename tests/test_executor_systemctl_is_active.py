"""RestrictedExecutor.systemctl_is_active whitelist."""

import pytest

from backend.ops.services.executor_local import RestrictedExecutor


@pytest.mark.asyncio
async def test_systemctl_is_active_rejects_unknown_unit():
    ex = RestrictedExecutor(
        allowed_units=["bifrost-massive-ws"],
        broker_url="redis://127.0.0.1:6379/1",
        use_redis_stop=False,
    )
    with pytest.raises(PermissionError):
        await ex.systemctl_is_active("other.service")
