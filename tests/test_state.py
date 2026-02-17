"""Unit tests for RuntimeStore (Phase 1: quote, spread, last_hedge_price)."""

import threading
import time

import pytest

from src.core.store import RuntimeStore


class TestRuntimeStore:
    def test_set_get_underlying_price(self):
        state = RuntimeStore()
        state.set_underlying_price(500.0)
        assert state.get_underlying_price() == 500.0

    def test_set_underlying_quote_updates_mid(self):
        state = RuntimeStore()
        state.set_underlying_quote(99.0, 101.0)
        assert state.get_underlying_price() == 100.0

    def test_get_spread_pct(self):
        state = RuntimeStore()
        state.set_underlying_quote(99.0, 101.0)
        spread = state.get_spread_pct()
        assert spread is not None
        assert abs(spread - 2.0) < 0.01

    def test_get_spread_pct_no_quote_returns_none(self):
        state = RuntimeStore()
        assert state.get_spread_pct() is None

    def test_last_hedge_price(self):
        state = RuntimeStore()
        assert state.get_last_hedge_price() is None
        state.set_last_hedge_price(500.5)
        assert state.get_last_hedge_price() == 500.5

    def test_positions_and_stock_position(self):
        state = RuntimeStore()
        state.set_positions([{"a": 1}], stock_position=50)
        assert len(state.get_positions()) == 1
        assert state.get_stock_position() == 50

    def test_thread_safety(self):
        state = RuntimeStore()

        def writer():
            for i in range(100):
                state.set_underlying_quote(100.0 + i * 0.01, 100.0 + i * 0.01 + 0.1)
                state.set_positions([], i)

        def reader():
            for _ in range(100):
                _ = state.get_underlying_price()
                _ = state.get_spread_pct()
                _ = state.get_positions()
                _ = state.get_stock_position()

        t1 = threading.Thread(target=writer)
        t2 = threading.Thread(target=reader)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
