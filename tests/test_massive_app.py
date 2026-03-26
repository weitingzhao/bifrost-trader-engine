"""Tests for the Massive FastAPI app health and docs endpoints."""

from __future__ import annotations

from unittest.mock import MagicMock

from starlette.testclient import TestClient

from backend.massive.app import create_massive_app


def _make_client(resolved_config_path: str | None = None, reader_config: dict | None = None) -> TestClient:
    reader = MagicMock()
    reader._config = reader_config if reader_config is not None else {}
    app = create_massive_app(
        reader=reader,
        control_via_db=None,
        resolved_config_path=resolved_config_path,
    )
    return TestClient(app, raise_server_exceptions=False)


class TestMassiveHealth:
    def test_root_health(self):
        client = _make_client()
        r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["service"] == "bifrost-massive"
        assert "ts" in body

    def test_prefixed_health(self):
        client = _make_client(reader_config={"server": {"massive_port": 9901}})
        r = client.get("/research/massive/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["service"] == "bifrost-massive"
        assert body["port"] == 9901

    def test_config_profile_dev(self, tmp_path):
        fake = tmp_path / "config.dev.yaml"
        fake.write_text("server: {}")
        client = _make_client(resolved_config_path=str(fake))
        body = client.get("/research/massive/health").json()
        assert body["config_profile"] == "dev"
        assert "config_path" in body

    def test_config_profile_prod(self, tmp_path):
        fake = tmp_path / "config.prod.yaml"
        fake.write_text("server: {}")
        client = _make_client(resolved_config_path=str(fake))
        body = client.get("/research/massive/health").json()
        assert body["config_profile"] == "prod"

    def test_config_profile_absent(self):
        client = _make_client()
        body = client.get("/research/massive/health").json()
        assert "config_profile" not in body
        assert body.get("port") == 8766


class TestMassiveDocs:
    def test_openapi_json_reachable(self):
        client = _make_client()
        r = client.get("/research/massive/openapi.json")
        assert r.status_code == 200
        spec = r.json()
        assert "paths" in spec

    def test_swagger_ui_reachable(self):
        client = _make_client()
        r = client.get("/research/massive/docs")
        assert r.status_code == 200
        assert "swagger" in r.text.lower() or "text/html" in r.headers.get("content-type", "")

    def test_redoc_reachable(self):
        client = _make_client()
        r = client.get("/research/massive/redoc")
        assert r.status_code == 200
