"""Lightweight tests for MassiveClient aggregate methods (mock _get)."""

from __future__ import annotations

from unittest.mock import patch

from src.vendor.massive.client import MassiveClient


def _client() -> MassiveClient:
    return MassiveClient(api_key="test-key")


class TestFetchOptionOpenClose:
    def test_success(self):
        fake_response = {
            "status": "OK",
            "symbol": "O:TSLA210903C00700000",
            "from": "2023-01-09",
            "open": 25,
            "high": 26.35,
            "low": 25,
            "close": 26.35,
            "volume": 2,
            "preMarket": 25,
            "afterHours": 26.35,
        }
        with patch.object(MassiveClient, "_get", return_value=(200, fake_response)):
            result = _client().fetch_option_open_close("O:TSLA210903C00700000", "2023-01-09")
        assert result.get("close") == 26.35
        assert result.get("open") == 25
        assert "error" not in result

    def test_missing_ticker(self):
        result = _client().fetch_option_open_close("", "2023-01-09")
        assert "error" in result

    def test_missing_date(self):
        result = _client().fetch_option_open_close("O:SPY251219C00600000", "")
        assert "error" in result

    def test_http_error(self):
        with patch.object(MassiveClient, "_get", return_value=(404, {"error": "Not Found"})):
            result = _client().fetch_option_open_close("O:SPY251219C00600000", "2023-01-09")
        assert "error" in result


class TestFetchOptionPreviousDay:
    def test_success(self):
        fake_response = {
            "adjusted": True,
            "results": [
                {"T": "O:TSLA210903C00700000", "o": 115.55, "h": 117.59, "l": 114.13, "c": 115.97, "v": 131704427, "vw": 116.3058, "n": 2, "t": 1605042000000}
            ],
            "resultsCount": 1,
            "status": "OK",
        }
        with patch.object(MassiveClient, "_get", return_value=(200, fake_response)):
            result = _client().fetch_option_previous_day("O:TSLA210903C00700000")
        assert result.get("resultsCount") == 1
        assert result["results"][0]["c"] == 115.97
        assert "error" not in result

    def test_missing_ticker(self):
        result = _client().fetch_option_previous_day("")
        assert "error" in result

    def test_http_error(self):
        with patch.object(MassiveClient, "_get", return_value=(500, {"error": "Internal"})):
            result = _client().fetch_option_previous_day("O:SPY251219C00600000")
        assert "error" in result


class TestFetchStockGroupedDaily:
    def test_requests_grouped_path(self):
        paths: list[str] = []

        def capture_get(self, path, params=None):
            paths.append(path)
            return (200, {"status": "OK", "queryCount": 0, "results": []})

        with patch.object(MassiveClient, "_get", capture_get):
            out = _client().fetch_stock_grouped_daily("2024-06-03")
        assert not out.get("error")
        assert paths and "/v2/aggs/grouped/locale/us/market/stocks/2024-06-03" in paths[0]

    def test_missing_date(self):
        out = _client().fetch_stock_grouped_daily("")
        assert out.get("error")


class TestFetchStockAggs:
    def test_delegates_to_same_range_path_as_options(self):
        paths: list[str] = []

        def capture_get(self, path, params=None):
            paths.append(path)
            return (200, {"status": "OK", "results": []})

        with patch.object(MassiveClient, "_get", capture_get):
            out = _client().fetch_stock_aggs("AAPL", 1, "minute", 1_000, 2_000)
        assert not out.get("error")
        assert paths[0].startswith("/v2/aggs/ticker/AAPL/range/1/minute/1000/2000")

    def test_stock_ticker_sends_adjusted_true(self):
        captured: list[dict | None] = []

        def capture_get(self, path, params=None):
            captured.append(params)
            return (200, {"status": "OK", "results": []})

        with patch.object(MassiveClient, "_get", capture_get):
            _client().fetch_stock_aggs("AAPL", 1, "minute", 1_000, 2_000)
        assert (captured[0] or {}).get("adjusted") == "true"

    def test_index_ticker_omits_adjusted(self):
        captured: list[dict | None] = []

        def capture_get(self, path, params=None):
            captured.append(params)
            return (200, {"status": "OK", "results": [{"t": 1, "o": 1, "h": 1, "l": 1, "c": 1, "v": 0}]})

        with patch.object(MassiveClient, "_get", capture_get):
            out = _client().fetch_stock_aggs("I:SPX", 1, "day", 1_000, 2_000)
        assert not out.get("error")
        assert "adjusted" not in (captured[0] or {})

    def test_http_200_with_status_error_surfaces_error(self):
        with patch.object(
            MassiveClient,
            "_get",
            return_value=(
                200,
                {"status": "ERROR", "error": "bad range"},
            ),
        ):
            out = _client().fetch_stock_aggs("I:DJI", 1, "day", 1_000, 2_000)
        assert out.get("error")
