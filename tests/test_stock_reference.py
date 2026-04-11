"""Unit tests for ticker reference mappers (Massive/Polygon-shaped dicts)."""

from __future__ import annotations

from src.persistence.postgres.ticker_reference import (
    count_ticker_overview_coverage,
    count_ticker_related_coverage,
    count_ticker_types_rows,
    count_tickers_rows,
    list_tickers_filled_related_page,
    list_tickers_missing_overview_page,
    list_tickers_missing_related_page,
    next_cursor_from_api_response,
    normalize_ticker_ref_kind,
    overview_stub_cols_api_not_found,
    row_from_ticker_detail,
    row_from_ticker_list_item,
    symbols_missing_overview_only,
    symbols_missing_related_only,
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
    assert row["ticker"] == "AAPL"
    assert row["instrument_type"] == "CS"
    assert row["active"] is True
    assert row["primary_exchange"] == "XNAS"
    assert row["market"] == "stocks"


def test_row_from_ticker_list_item_currency_fields():
    row = row_from_ticker_list_item(
        {
            "ticker": "X",
            "name": "X",
            "currency_symbol": "USD",
            "base_currency_name": "US Dollar",
        }
    )
    assert row["currency_symbol"] == "USD"
    assert row["base_currency_name"] == "US Dollar"


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
    tcols, dcols = row_from_ticker_detail(body)
    assert tcols["ticker"] == "AAPL"
    assert dcols["address_city"] == "Cupertino"
    assert dcols["icon_url"] == "https://example.com/icon.png"
    assert dcols["market_cap"] == 3e12


def test_next_cursor_from_next_url():
    data = {"next_url": "https://api.example.com/v3/reference/tickers?cursor=abc123&limit=1000"}
    assert next_cursor_from_api_response(data) == "abc123"


def test_next_cursor_plain():
    assert next_cursor_from_api_response({"next_cursor": "xyz"}) == "xyz"


def test_normalize_ticker_ref_kind_maps_legacy_instrument_types():
    assert normalize_ticker_ref_kind("ticker_reference_instrument_types") == "ticker_reference_ticker_types"
    assert normalize_ticker_ref_kind("stock_reference_instrument_types") == "ticker_reference_ticker_types"
    assert normalize_ticker_ref_kind("ticker_reference_ticker_types") == "ticker_reference_ticker_types"


def test_overview_stub_cols_api_not_found_sets_timestamp():
    stub = overview_stub_cols_api_not_found()
    assert stub["sector"] == ""
    assert stub["industry"] == ""
    assert stub["overview_updated_at"] is not None


def test_symbols_missing_overview_only_returns_tickers_without_overview_row():
    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchall(self):
            return [("AAA",), ("ZZZ",)]

    assert symbols_missing_overview_only(_Cur()) == ["AAA", "ZZZ"]


def test_count_ticker_overview_coverage_maps_row():
    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchone(self):
            return (10000, 9200, 800)

    assert count_ticker_overview_coverage(_Cur()) == {
        "total_tickers": 10000,
        "filled": 9200,
        "missing": 800,
    }


def test_list_tickers_missing_overview_page_respects_limit():
    class _Cur:
        def execute(self, sql, params):
            self.params = params

        def fetchall(self):
            return [("A",), ("B",)]

    cur = _Cur()
    assert list_tickers_missing_overview_page(cur, 2, 10) == ["A", "B"]
    assert cur.params == (2, 10)


def test_count_ticker_related_coverage_maps_row():
    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchone(self):
            return (5000, 800, 4200)

    assert count_ticker_related_coverage(_Cur()) == {
        "total_tickers": 5000,
        "filled": 800,
        "missing": 4200,
    }


def test_list_tickers_missing_related_page_params():
    class _Cur:
        def execute(self, _sql, params):
            self.params = params

        def fetchall(self):
            return [("Z",)]

    cur = _Cur()
    assert list_tickers_missing_related_page(cur, 3, 99) == ["Z"]
    assert cur.params == (3, 99)


def test_list_tickers_filled_related_page_params():
    class _Cur:
        def execute(self, _sql, params):
            self.params = params

        def fetchall(self):
            return [("A",), ("B",)]

    cur = _Cur()
    assert list_tickers_filled_related_page(cur, 2, 0) == ["A", "B"]
    assert cur.params == (2, 0)


def test_symbols_missing_related_only_returns_tickers_without_related_rows():
    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchall(self):
            return [("AAA",), ("ZZZ",)]

    assert symbols_missing_related_only(_Cur()) == ["AAA", "ZZZ"]


def test_count_tickers_rows():
    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchone(self):
            return (42_000,)

    assert count_tickers_rows(_Cur()) == 42000


def test_count_ticker_types_rows():
    class _Cur:
        def execute(self, *_a, **_k):
            return None

        def fetchone(self):
            return (128,)

    assert count_ticker_types_rows(_Cur()) == 128
