"""Local Control Agent protocol: allowed systemd units."""

from backend.ops.agent.protocol import validate_unit


def test_validate_unit_ib_account_agent() -> None:
    assert validate_unit("bifrost-ib-account-agent.service") is True
    assert validate_unit(" bifrost-ib-account-agent.service ") is True


def test_validate_unit_ingest_family() -> None:
    assert validate_unit("bifrost-ib-ingestor.service") is True
    assert validate_unit("bifrost-massive-ws.service") is True


def test_validate_unit_bifrost_engine() -> None:
    assert validate_unit("bifrost-engine.service") is True
    assert validate_unit(" bifrost-engine.service ") is True


def test_validate_unit_account_sync_daemon() -> None:
    assert validate_unit("bifrost-account-sync-daemon.service") is True
    assert validate_unit("bifrost-account-sync-daemon-dev.service") is True


def test_validate_unit_rejects_unknown() -> None:
    assert validate_unit("random.service") is False
    assert validate_unit("") is False
