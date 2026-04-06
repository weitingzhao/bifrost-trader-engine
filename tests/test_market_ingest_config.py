"""Market ingest registry from YAML."""

from backend.ops.market_ingest_config import (
    market_ingest_service_by_id,
    market_ingest_services_from_config,
)


def test_default_services():
    rows = market_ingest_services_from_config({})
    assert len(rows) == 3
    assert rows[0]["id"] == "massive_ws"
    assert rows[0]["systemd_unit"] == "bifrost-massive-ws.service"
    assert rows[0]["redis_meta_key"] == "bifrost:health:massive_ws"
    assert rows[1]["id"] == "ib_operator"
    assert rows[1]["systemd_unit"] == "bifrost-ib-operator.service"
    assert rows[1]["redis_meta_key"] == "bifrost:health:ib_operator"
    assert rows[2]["id"] == "ib_ingestor"
    assert rows[2]["redis_meta_key"] == "bifrost:health:ib_ingestor"


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


def test_legacy_ib_market_yaml_row_normalizes():
    cfg = {
        "ops": {
            "market_ingest_services": [
                {
                    "id": "ib_market",
                    "label": "Legacy",
                    "systemd_unit": "bifrost-ib-market-ingest",
                    "redis_meta_key": "ib:ingester:meta:health",
                }
            ]
        }
    }
    rows = market_ingest_services_from_config(cfg)
    assert len(rows) == 1
    assert rows[0]["id"] == "ib_ingestor"
    assert rows[0]["systemd_unit"] == "bifrost-ib-ingestor.service"
    assert market_ingest_service_by_id(cfg, "ib_market") is not None
    assert market_ingest_service_by_id(cfg, "ib_market")["id"] == "ib_ingestor"
