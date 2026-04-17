"""Tests for the Massive FastAPI app health and docs endpoints."""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from starlette.testclient import TestClient

from backend.massive.app import create_massive_app

_FULL_SERVER = {
    "monitor_port": 8765,
    "massive_port": 8766,
    "docs_port": 8767,
    "ops_port": 8768,
    "trading_port": 8769,
    "strategy_port": 8770,
    "portfolio_port": 8771,
    "market_port": 8772,
    "research_port": 8773,
}


def _make_client(resolved_config_path: str | None = None, reader_config: dict | None = None) -> TestClient:
    reader = MagicMock()
    base = {"server": dict(_FULL_SERVER)}
    if reader_config is not None:
        rc = {**base, **reader_config}
        if "server" in reader_config:
            rc["server"] = {**_FULL_SERVER, **reader_config["server"]}
        reader._config = rc
    else:
        reader._config = base
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

    def test_stock_reference_search_requires_postgres(self):
        client = _make_client()
        r = client.get("/research/massive/stocks/search?q=AAPL")
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is False
        assert "PostgreSQL" in str(body.get("error", ""))

    def test_ticker_types_db_requires_postgres(self):
        client = _make_client()
        r = client.get("/research/massive/reference/ticker-types")
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is False
        assert "PostgreSQL" in str(body.get("error", ""))

    def test_db_coverage_summary_requires_postgres(self):
        client = _make_client()
        r = client.get("/research/massive/db-coverage-summary")
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is False
        assert "PostgreSQL" in str(body.get("error", ""))

    def test_watchlist_db_coverage_requires_postgres(self):
        client = _make_client()
        r = client.get("/research/massive/watchlist-db-coverage")
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is False
        assert "PostgreSQL" in str(body.get("error", ""))

    @patch("psycopg2.connect")
    @patch("src.vendor.massive.reader.get_watchlist_optionable_stk_symbols", return_value=["NVDA"])
    @patch("src.persistence.postgres.connection._get_conn_params", return_value={})
    @patch("backend.massive.routers.routes._db_config", return_value={"host": "h", "database": "d"})
    def test_watchlist_db_coverage_option_contracts_json_shape(self, _mock_db, _gp, _syms, mock_connect):
        """When PostgreSQL returns aggregates, option_contracts includes coverage + age fields."""
        newest = datetime(2025, 6, 1, 12, 0, 0, tzinfo=timezone.utc)
        cur = MagicMock()
        cur.fetchall.side_effect = [
            [("NVDA", 100, newest, 90, 80, 2, 4, 12)],
            [("NVDA", newest)],
            [("NVDA", newest.date(), newest)],
            [("NVDA", newest, newest)],
        ]
        cursor_cm = MagicMock()
        cursor_cm.__enter__.return_value = cur
        cursor_cm.__exit__.return_value = None
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = cursor_cm
        mock_connect.return_value = mock_conn

        client = _make_client()
        r = client.get("/research/massive/watchlist-db-coverage")
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True
        syms = body.get("symbols") or []
        assert len(syms) == 1
        oc = syms[0]["option_contracts"]
        assert oc["has_data"] is True
        assert oc["row_count"] == 100
        assert oc["ticker_pct"] == 90.0
        assert oc["identity_pct"] == 80.0
        assert oc["mapping_mismatch_count"] == 2
        assert oc["distinct_expirations"] == 4
        assert oc["distinct_strikes"] == 12
        assert oc["newest_created_at"] is not None
        assert oc["contracts_last_at"] == oc["newest_created_at"]
        assert isinstance(oc.get("age_seconds"), int)


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
