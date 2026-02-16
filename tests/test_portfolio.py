"""Unit tests for portfolio parsing and delta calculation."""

from datetime import datetime, timedelta, timezone

import pytest

from src.positions.portfolio import OptionLeg, parse_positions, portfolio_delta


def _make_mock_position(symbol: str, sec_type: str, expiry: str, strike: float, right: str, position: int, multiplier: int = 100):
    """Create mock IB-style position (dict)."""
    return {
        "contract": {
            "symbol": symbol,
            "secType": sec_type,
            "lastTradeDateOrContractMonth": expiry,
            "strike": strike,
            "right": right,
            "multiplier": str(multiplier),
        },
        "position": position,
    }


def _future_yyyymmdd(days_ahead: int) -> str:
    """Return YYYYMMDD for a date days ahead."""
    d = datetime.now(timezone.utc) + timedelta(days=days_ahead)
    return d.strftime("%Y%m%d")


class TestParsePositions:
    def test_empty_positions(self):
        legs, stock = parse_positions([], "NVDA")
        assert legs == []
        assert stock == 0

    def test_stock_only(self):
        positions = [
            {"contract": {"symbol": "NVDA", "secType": "STK"}, "position": 50},
        ]
        legs, stock = parse_positions(positions, "NVDA", min_dte=0, max_dte=999)
        assert legs == []
        assert stock == 50

    def test_option_in_dte_range(self):
        expiry = _future_yyyymmdd(28)
        positions = [
            _make_mock_position("NVDA", "OPT", expiry, 500.0, "C", 1),
        ]
        spot = 500.0
        legs, stock = parse_positions(positions, "NVDA", min_dte=21, max_dte=35, spot=spot)
        assert len(legs) == 1
        assert legs[0].symbol == "NVDA"
        assert legs[0].strike == 500.0
        assert legs[0].right == "C"
        assert legs[0].quantity == 1
        assert stock == 0

    def test_option_outside_dte_skipped(self):
        expiry = _future_yyyymmdd(10)
        positions = [
            _make_mock_position("NVDA", "OPT", expiry, 500.0, "C", 1),
        ]
        legs, _ = parse_positions(positions, "NVDA", min_dte=21, max_dte=35)
        assert len(legs) == 0

    def test_option_not_near_atm_skipped(self):
        expiry = _future_yyyymmdd(28)
        positions = [
            _make_mock_position("NVDA", "OPT", expiry, 400.0, "C", 1),
        ]
        spot = 500.0
        legs, _ = parse_positions(positions, "NVDA", min_dte=21, max_dte=35, atm_band_pct=0.03, spot=spot)
        assert len(legs) == 0


class TestPortfolioDelta:
    def test_stock_only(self):
        delta = portfolio_delta([], 100, 500.0, 0.05, 0.35)
        assert delta == 100.0

    def test_option_legs(self):
        expiry = _future_yyyymmdd(28)
        legs = [
            OptionLeg("NVDA", expiry, 500.0, "C", 1),
            OptionLeg("NVDA", expiry, 500.0, "P", -1),
        ]
        spot = 500.0
        r, vol = 0.05, 0.35
        delta = portfolio_delta(legs, 0, spot, r, vol)
        assert isinstance(delta, float)
        assert -1000 < delta < 1000
