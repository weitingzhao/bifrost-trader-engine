"""Unit tests for stock reference mappers (Massive/Polygon-shaped dicts)."""

from __future__ import annotations

from src.persistence.postgres.stock_reference import (
    next_cursor_from_api_response,
    row_from_ticker_detail,
    row_from_ticker_list_item,
)


def test_row_from_ticker_list_item_maps_type_and_exchange():
    row = row_from_ticker_list_item(
        {
            "ticker": "AAPL",
            "name": "Apple Inc.",
            "type": "CS",
            "active": True,
            "primary_exchange": "XNAS",
            "market": "stocks",
            "locale": "us",
            "cik": "0000320193",
        }
    )
    assert row["symbol"] == "AAPL"
    assert row["instrument_type"] == "CS"
    assert row["active"] is True
    assert row["primary_exchange"] == "XNAS"
    assert row["exchange"] == "XNAS"
    assert row["sector"] == ""


def test_row_from_ticker_list_item_sector_from_api():
    row = row_from_ticker_list_item({"ticker": "X", "name": "X Corp", "sector": "Technology"})
    assert row["sector"] == "Technology"


def test_row_from_ticker_detail_branding_and_address():
    body = {
        "results": {
            "ticker": "AAPL",
            "name": "Apple Inc.",
            "market_cap": 3e12,
            "total_employees": 100000,
            "list_date": "1980-12-12",
            "address": {
                "address1": "One Apple Park Way",
                "city": "Cupertino",
                "state": "CA",
                "postal_code": "95014",
            },
            "branding": {
                "icon_url": "https://example.com/icon.png",
                "logo_url": "https://example.com/logo.svg",
            },
            "phone_number": "+1-555-0100",
        }
    }
    out = row_from_ticker_detail(body)
    assert out["symbol"] == "AAPL"
    assert out["address_city"] == "Cupertino"
    assert out["icon_url"] == "https://example.com/icon.png"
    assert out["market_cap"] == 3e12


def test_next_cursor_from_next_url():
    data = {"next_url": "https://api.example.com/v3/reference/tickers?cursor=abc123&limit=1000"}
    assert next_cursor_from_api_response(data) == "abc123"


def test_next_cursor_plain():
    assert next_cursor_from_api_response({"next_cursor": "xyz"}) == "xyz"
