"""Tests for the slim Research FastAPI app (option discovery + max pain only)."""

from __future__ import annotations

from unittest.mock import MagicMock

from starlette.testclient import TestClient

from backend.research.app import create_research_app


def _make_client(
    resolved_config_path: str | None = None,
    reader_config: dict | None = None,
    merged_config: dict | None = None,
) -> TestClient:
    reader = MagicMock()
    reader._config = reader_config if reader_config is not None else {"server": {"skip_monitor_ib": True}}
    app = create_research_app(
        reader=reader,
        control_via_db=None,
        resolved_config_path=resolved_config_path,
        merged_config=merged_config or {},
    )
    return TestClient(app, raise_server_exceptions=False)


class TestResearchHealth:
    def test_root_health(self):
        client = _make_client(merged_config={"server": {"skip_monitor_ib": True}})
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["service"] == "bifrost-research"
        assert "ts" in body

    def test_health_port_from_config(self):
        client = _make_client(
            reader_config={"server": {"skip_monitor_ib": True, "research_port": 9903}},
            merged_config={"server": {"skip_monitor_ib": True}},
        )
        body = client.get("/health").json()
        assert body["port"] == 9903

    def test_config_profile_dev(self, tmp_path):
        fake = tmp_path / "config.dev.yaml"
        fake.write_text("server: {}")
        client = _make_client(resolved_config_path=str(fake), merged_config={"server": {"skip_monitor_ib": True}})
        body = client.get("/health").json()
        assert body["config_profile"] == "dev"


class TestResearchOpenApi:
    def test_openapi_json_reachable(self):
        client = _make_client(merged_config={"server": {"skip_monitor_ib": True}})
        r = client.get("/openapi.json")
        assert r.status_code == 200
        spec = r.json()
        assert "paths" in spec

    def test_no_massive_stream_route(self):
        """Massive SSE lives on backend.massive only."""
        client = _make_client(merged_config={"server": {"skip_monitor_ib": True}})
        spec = client.get("/openapi.json").json()
        paths = spec.get("paths") or {}
        assert "/research/massive/stream" not in paths

