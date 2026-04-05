"""IB YAML: required ib.host / ib.secondary shape."""

import pytest

from src.app.config import get_effective_ib_config


def test_host_secondary_blocks():
    cfg = {
        "ib": {
            "connect_timeout": 60.0,
            "host": {
                "ip": "192.168.10.30",
                "port_type": "tws_live",
                "client_id": {
                    "daemon": 110,
                    "listener": 101,
                    "account": 120,
                    "markets": 130,
                    "worker_market": 140,
                    "ib_market_ingest": 150,
                },
            },
            "secondary": {
                "ip": "192.168.10.32",
                "port_type": "tws_live",
                "client_id": {
                    "listener": 11,
                    "account": 120,
                },
            },
        }
    }
    eff = get_effective_ib_config(cfg)
    assert eff["host"] == "192.168.10.30"
    assert eff["port_type"] == "tws_live"
    assert eff["client_id_daemon"] == 110
    assert eff["client_id_listener"] == 101
    assert eff["client_id_account"] == 120
    assert eff["client_id_markets"] == 130
    assert eff["client_id_worker_market"] == 140
    assert eff["client_id_ib_market_ingest"] == 150
    assert eff["ib_client_id_ib_market_ingest"] == 150
    assert eff["port_market_data"] == eff["port"]
    assert eff["ib_port_market_data"] == eff["ib_port"]
    assert eff["ib2_host"] == "192.168.10.32"
    assert eff["ib2_client_id_listener"] == 11
    assert eff["ib2_client_id_account"] == 120


def test_omit_secondary():
    cfg = {
        "ib": {
            "host": {
                "ip": "10.0.0.1",
                "port_type": "tws_paper",
                "client_id": {
                    "daemon": 1,
                    "listener": 2,
                    "account": 100,
                    "markets": 101,
                    "worker_market": 500,
                },
            },
        }
    }
    eff = get_effective_ib_config(cfg)
    assert eff["ib2_host"] is None
    assert eff["client_id_ib_market_ingest"] == 150


def test_missing_ib_raises():
    with pytest.raises(ValueError, match="config\\['ib'\\] is required"):
        get_effective_ib_config({})


def test_missing_host_raises():
    with pytest.raises(ValueError, match="config\\['ib'\\]\\['host'\\] is required"):
        get_effective_ib_config({"ib": {"connect_timeout": 30}})
