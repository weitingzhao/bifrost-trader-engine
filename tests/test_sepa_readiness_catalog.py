"""Shape checks for SEPA readiness summary data_catalog (UI + API contract)."""

from src.research.sepa.readiness_snapshot import READINESS_DATA_CATALOG


def test_readiness_data_catalog_buckets_and_entries():
    assert set(READINESS_DATA_CATALOG.keys()) == {"raw_sources", "computed_layers"}
    for bucket in ("raw_sources", "computed_layers"):
        entries = READINESS_DATA_CATALOG[bucket]
        assert isinstance(entries, list)
        assert len(entries) >= 1
        for item in entries:
            assert item.get("id")
            assert item.get("object")
            assert item.get("role")
            dps = item.get("data_points")
            assert isinstance(dps, list) and len(dps) >= 1
            assert all(isinstance(x, str) and x.strip() for x in dps)
