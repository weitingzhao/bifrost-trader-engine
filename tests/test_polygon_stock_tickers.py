"""Polygon/Massive aggs ticker aliases for reference indices."""

from __future__ import annotations

from src.massive.polygon_stock_tickers import polygon_ticker_for_massive_aggs


def test_polygon_ticker_maps_reference_indices() -> None:
    assert polygon_ticker_for_massive_aggs("^GSPC") == "I:SPX"
    assert polygon_ticker_for_massive_aggs("^DJI") == "I:DJI"
    assert polygon_ticker_for_massive_aggs("^IXIC") == "I:COMP"


def test_polygon_ticker_passes_through_equities() -> None:
    assert polygon_ticker_for_massive_aggs("NVDA") == "NVDA"
    assert polygon_ticker_for_massive_aggs("aapl") == "AAPL"


def test_polygon_ticker_config_overrides_alias() -> None:
    ref = [{"symbol": "^GSPC", "polygon_ticker": "I:SPX"}]
    assert polygon_ticker_for_massive_aggs("^GSPC", ref) == "I:SPX"
    ref2 = [{"symbol": "^GSPC", "polygon_ticker": "I:CUSTOM"}]
    assert polygon_ticker_for_massive_aggs("^GSPC", ref2) == "I:CUSTOM"
