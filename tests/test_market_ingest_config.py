"""Market ingest registry from YAML."""

from src.bifrost.redis_health_keys import (
    BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON,
    BIFROST_HEALTH_DAEMON_TRADING_ENGINE,
)

from backend.ops.market_ingest_config import (
    market_ingest_service_by_id,
    market_ingest_services_from_config,
)


def test_default_services():
    rows = market_ingest_services_from_config({})
    assert len(rows) == 6
    assert rows[0]["id"] == "massive_ws"
    assert rows[0]["systemd_unit"] == "bifrost-massive-ws.service"
    assert rows[0]["redis_meta_key"] == "bifrost:health:ws_massive_option"
    assert rows[1]["id"] == "ib_operator"
    assert rows[1]["systemd_unit"] == "bifrost-ib-operator.service"
    assert rows[1]["redis_meta_key"] == "bifrost:health:ws_ib_operator"
    assert rows[2]["id"] == "ib_ingestor"
    assert rows[2]["redis_meta_key"] == "bifrost:health:ws_ib_ingestor"
    assert rows[3]["id"] == "ib_account_agent"
    assert rows[3]["systemd_unit"] == "bifrost-ib-account-agent.service"
    assert rows[3]["redis_meta_key"] == "bifrost:health:ws_ib_account_agent"
    assert rows[4]["id"] == "trading_engine"
    assert rows[4]["label"] == "Strategy Trading Daemon"
    assert rows[4]["systemd_unit"] == "bifrost-engine.service"
    assert rows[4]["redis_meta_key"] == BIFROST_HEALTH_DAEMON_TRADING_ENGINE
    assert rows[5]["id"] == "account_sync_daemon"
    assert rows[5]["redis_meta_key"] == BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON


def test_custom_services_override():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "custom",
                    "label": "Custom",
                    "systemd_unit": "my-ingest.service",
                    "redis_meta_key": "custom:meta",
                }
            ]
        }
    }
    rows = market_ingest_services_from_config(cfg)
    assert len(rows) == 1
    assert rows[0]["id"] == "custom"
    assert rows[0]["systemd_unit"] == "my-ingest.service"


def test_service_by_id():
    row = market_ingest_service_by_id({}, "massive_ws")
    assert row is not None
    assert row["id"] == "massive_ws"
    eng = market_ingest_service_by_id({}, "trading_engine")
    assert eng is not None
    assert eng["systemd_unit"] == "bifrost-engine.service"
    assert eng["redis_meta_key"] == BIFROST_HEALTH_DAEMON_TRADING_ENGINE


def test_engine_row_allows_omitted_redis_meta_key():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "trading_engine",
                    "label": "Engine",
                    "systemd_unit": "bifrost-engine.service",
                },
            ],
        },
    }
    rows = market_ingest_services_from_config(cfg)
    assert len(rows) == 5
    assert rows[0]["id"] == "massive_ws"
    assert rows[4]["id"] == "trading_engine"
    assert rows[4]["redis_meta_key"] == BIFROST_HEALTH_DAEMON_TRADING_ENGINE


def test_account_sync_row_allows_omitted_redis_meta_key():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "account_sync_daemon",
                    "label": "Account Sync Daemon",
                    "systemd_unit": "bifrost-account-sync-daemon.service",
                },
            ],
        },
    }
    rows = market_ingest_services_from_config(cfg)
    assert len(rows) == 5
    assert rows[0]["id"] == "massive_ws"
    assert rows[4]["id"] == "account_sync_daemon"
    assert rows[4]["redis_meta_key"] == BIFROST_HEALTH_ACCOUNT_SYNC_DAEMON


def test_trading_engine_legacy_ops_redis_meta_key_normalizes():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "trading_engine",
                    "label": "Engine",
                    "systemd_unit": "bifrost-engine.service",
                    "redis_meta_key": "bifrost:ops:trading_engine",
                },
            ],
        },
    }
    rows = market_ingest_services_from_config(cfg)
    assert len(rows) == 5
    assert rows[4]["id"] == "trading_engine"
    assert rows[4]["redis_meta_key"] == BIFROST_HEALTH_DAEMON_TRADING_ENGINE


def test_yaml_legacy_redis_meta_keys_normalize_to_bifrost_health():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "ib_ingestor",
                    "label": "IB",
                    "systemd_unit": "bifrost-ib-ingestor.service",
                    "redis_meta_key": "ib:ingester:meta:health",
                },
                {
                    "id": "ib_operator",
                    "label": "Op",
                    "systemd_unit": "bifrost-ib-operator.service",
                    "redis_meta_key": "ib:operator:meta:health",
                },
            ]
        }
    }
    rows = market_ingest_services_from_config(cfg)
    assert len(rows) == 2
    assert rows[0]["redis_meta_key"] == "bifrost:health:ws_ib_ingestor"
    assert rows[1]["redis_meta_key"] == "bifrost:health:ws_ib_operator"


def test_prior_bifrost_redis_meta_keys_normalize_to_ws_names():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "massive_ws",
                    "label": "M",
                    "systemd_unit": "bifrost-massive-ws.service",
                    "redis_meta_key": "bifrost:health:massive_ws",
                },
                {
                    "id": "ib_ingestor",
                    "label": "I",
                    "systemd_unit": "bifrost-ib-ingestor.service",
                    "redis_meta_key": "bifrost:health:ib_ingestor",
                },
                {
                    "id": "ib_operator",
                    "label": "O",
                    "systemd_unit": "bifrost-ib-operator.service",
                    "redis_meta_key": "bifrost:health:ib_operator",
                },
            ]
        }
    }
    rows = market_ingest_services_from_config(cfg)
    assert rows[0]["redis_meta_key"] == "bifrost:health:ws_massive_option"
    assert rows[1]["redis_meta_key"] == "bifrost:health:ws_ib_ingestor"
    assert rows[2]["redis_meta_key"] == "bifrost:health:ws_ib_operator"


def test_legacy_ib_market_yaml_row_normalizes():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "ib_market",
                    "label": "Legacy",
                    "systemd_unit": "bifrost-ib-ingestor",
                    "redis_meta_key": "bifrost:health:ib_ingestor",
                }
            ]
        }
    }
    rows = market_ingest_services_from_config(cfg)
    assert len(rows) == 1
    assert rows[0]["id"] == "ib_ingestor"
    assert rows[0]["systemd_unit"] == "bifrost-ib-ingestor.service"
    assert rows[0]["redis_meta_key"] == "bifrost:health:ws_ib_ingestor"
    assert market_ingest_service_by_id(cfg, "ib_market") is not None
    assert market_ingest_service_by_id(cfg, "ib_market")["id"] == "ib_ingestor"
