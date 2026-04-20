"""Tests for :class:`backend.ops.worker_profiles.WorkerProfileRegistry`."""

from __future__ import annotations

from backend.ops.worker_profiles import WorkerProfileRegistry


def test_list_profiles_order_follows_canonical_queue_order() -> None:
    cfg = {
        "ops": {
            "celery": {
                "canonical_queue_order": [
                    "stocks_ib",
                    "options_massive",
                    "stocks_massive",
                    "options_massive_high",
                    "stocks_massive_high",
                ],
                "broker_queue_display_names": {
                    "stocks_ib": "Stocks IB",
                    "options_massive": "Options Massive",
                    "options_massive_high": "Massive Options (H)",
                    "stocks_massive": "Stocks Massive",
                    "stocks_massive_high": "Stocks Massive (H)",
                },
            },
            "worker_profiles": {
                "stocks_ib": {"queues": ["stocks_ib"]},
                "options_massive": {"queues": ["options_massive"]},
                "options_massive_high": {"queues": ["options_massive_high"]},
                "stocks_massive": {"queues": ["stocks_massive"]},
                "stocks_massive_high": {"queues": ["stocks_massive_high"]},
            },
        }
    }
    reg = WorkerProfileRegistry.from_config(cfg)
    listed = reg.list_profiles()
    keys = [p["key"] for p in listed]
    assert keys == [
        "stocks_ib",
        "options_massive",
        "stocks_massive",
        "options_massive_high",
        "stocks_massive_high",
    ]
    for row in listed:
        assert row.get("max_worker_instances") == 1


def test_max_worker_instances_per_profile_and_default() -> None:
    cfg = {
        "ops": {
            "celery": {
                "canonical_queue_order": ["stocks_ib", "options_massive"],
                "broker_queue_display_names": {
                    "stocks_ib": "Stocks IB",
                    "options_massive": "Options Massive",
                },
                "default_max_worker_instances": 2,
            },
            "worker_profiles": {
                "stocks_ib": {"queues": ["stocks_ib"], "max_worker_instances": 1},
                "options_massive": {"queues": ["options_massive"]},
            },
        }
    }
    reg = WorkerProfileRegistry.from_config(cfg)
    by_key = {p["key"]: p for p in reg.list_profiles()}
    assert by_key["stocks_ib"]["max_worker_instances"] == 1
    assert by_key["options_massive"]["max_worker_instances"] == 2
