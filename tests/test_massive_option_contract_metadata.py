"""Tests for Massive option contract reference metadata helpers."""

from src.vendor.massive.client import (
    _parse_shares_per_contract,
    normalize_primary_exchange,
)


def test_normalize_primary_exchange_string() -> None:
    assert normalize_primary_exchange("  BATO  ") == "BATO"
    assert normalize_primary_exchange("") is None
    assert normalize_primary_exchange(None) is None


def test_normalize_primary_exchange_dict_polygon_style() -> None:
    assert normalize_primary_exchange({"String": "BATO", "Valid": True}) == "BATO"
    assert normalize_primary_exchange({"string": "XNAS"}) == "XNAS"


def test_parse_shares_per_contract() -> None:
    assert _parse_shares_per_contract(100) == 100
    assert _parse_shares_per_contract("100") == 100
    assert _parse_shares_per_contract(0) is None
    assert _parse_shares_per_contract(None) is None
