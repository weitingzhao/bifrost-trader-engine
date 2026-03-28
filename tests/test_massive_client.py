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
