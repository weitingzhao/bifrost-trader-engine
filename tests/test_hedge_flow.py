"""Integration tests for Phase 1 hedge flow (strategy + guard + state, no IB)."""

import time

import pytest

from src.engine.store import RuntimeStore
from src.guards.execution_guard import ExecutionGuard
from src.strategy.gamma_scalper import gamma_scalper_hedge


class TestHedgeFlowIntegration:
    """Test hedge decision flow: delta -> target -> guard gates -> allowed/blocked."""

    def test_full_hedge_flow_allowed(self):
        state = RuntimeStore()
        state.set_underlying_quote(100.0, 100.1)
        state.set_positions([], stock_position=0)
        state.set_last_hedge_price(99.0)

        guard = ExecutionGuard(cooldown_sec=1, trading_hours_only=False)
        guard.set_last_hedge_time(time.time() - 10)

        port_delta = 50.0
        stock_shares = 0
        hedge = gamma_scalper_hedge(port_delta, stock_shares, delta_threshold_shares=25)
        assert hedge is not None
        assert hedge.side == "SELL"
        assert hedge.quantity == 50

        allowed, reason = guard.allow_hedge(
            time.time(),
            stock_shares,
            hedge.side,
            hedge.quantity,
            portfolio_delta=port_delta,
            spot=100.05,
            last_hedge_price=state.get_last_hedge_price(),
            spread_pct=state.get_spread_pct(),
        )
        assert allowed is True
        assert reason == "ok"

    def test_min_price_move_blocks_hedge(self):
        state = RuntimeStore()
        state.set_underlying_quote(100.0, 100.1)
        state.set_last_hedge_price(100.05)

        guard = ExecutionGuard(
            min_price_move_pct=0.5,
            cooldown_sec=1,
            trading_hours_only=False,
        )
        guard.set_last_hedge_time(time.time() - 100)

        hedge = gamma_scalper_hedge(50.0, 0, delta_threshold_shares=25)
        assert hedge is not None

        allowed, reason = guard.allow_hedge(
            time.time(),
            0,
            hedge.side,
            hedge.quantity,
            spot=100.1,
            last_hedge_price=100.05,
        )
        assert allowed is False
        assert reason == "min_price_move"

    def test_spread_blocks_hedge(self):
        state = RuntimeStore()
        state.set_underlying_quote(100.0, 101.5)

        guard = ExecutionGuard(
            max_spread_pct=0.5,
            cooldown_sec=1,
            trading_hours_only=False,
        )
        guard.set_last_hedge_time(time.time() - 100)

        hedge = gamma_scalper_hedge(50.0, 0, delta_threshold_shares=25)
        assert hedge is not None

        allowed, reason = guard.allow_hedge(
            time.time(),
            0,
            hedge.side,
            hedge.quantity,
            spread_pct=state.get_spread_pct(),
        )
        assert allowed is False
        assert reason == "spread_too_wide"

    def test_target_position_framing(self):
        port_delta = 30.0
        stock_shares = 10
        hedge = gamma_scalper_hedge(port_delta, stock_shares, delta_threshold_shares=25)
        assert hedge is not None
        assert hedge.side == "SELL"
        assert hedge.quantity == 30
