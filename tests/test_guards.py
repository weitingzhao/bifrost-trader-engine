"""Unit tests for pure guard functions: data_stale, greeks_bad, in_no_trade_band, cost_ok, liquidity_ok."""

import math
from types import SimpleNamespace

import pytest

from src.core.state.enums import (
    DeltaDeviationState,
    ExecutionState,
    LiquidityState,
    OptionPositionState,
    SystemHealthState,
)
from src.core.guards.trading_guard import (
    broker_down,
    broker_up,
    cost_ok,
    data_ok,
    data_stale,
    delta_band_ready,
    exec_fault,
    greeks_bad,
    greeks_ok,
    have_option_position,
    in_no_trade_band,
    liquidity_ok,
    no_option_position,
    out_of_band,
    retry_allowed,
)
from src.core.state.snapshot import StateSnapshot, GreeksSnapshot, default_snapshot




def _make_snap(
    event_lag_ms=None,
    spread_pct=0.05,
    spot=100.0,
    L=LiquidityState.NORMAL,
    E=ExecutionState.IDLE,
    greeks_valid=True,
    net_delta=0.0,
    last_hedge_price=None,
    O=OptionPositionState.LONG_GAMMA,
) -> StateSnapshot:
    from src.core.state.enums import MarketRegimeState
    g = GreeksSnapshot(delta=net_delta, gamma=0.02, valid=greeks_valid) if greeks_valid else None
    return StateSnapshot(
        O=O,
        D=DeltaDeviationState.IN_BAND if abs(net_delta) <= 10 else DeltaDeviationState.HEDGE_NEEDED,
        M=MarketRegimeState.NORMAL,
        L=L,
        E=E,
        S=SystemHealthState.OK,
        net_delta=net_delta,
        option_delta=net_delta,
        stock_pos=0,
        spot=spot,
        spread_pct=spread_pct,
        event_lag_ms=event_lag_ms,
        greeks=g,
        last_hedge_price=last_hedge_price,
        last_hedge_ts=None,
        ts=1000.0,
    )


class TestDataStale:
    def test_data_ok_when_lag_under_threshold(self):
        snap = _make_snap(event_lag_ms=500, spot=100.0)
        assert data_ok(snap, {"state_space": {"system": {"data_lag_threshold_ms": 1000}}}) is True
        assert data_stale(snap, {"state_space": {"system": {"data_lag_threshold_ms": 1000}}}) is False

    def test_data_stale_when_lag_over_threshold(self):
        snap = _make_snap(event_lag_ms=2000, spot=100.0)
        assert data_ok(snap, {"state_space": {"system": {"data_lag_threshold_ms": 1000}}}) is False
        assert data_stale(snap, {"state_space": {"system": {"data_lag_threshold_ms": 1000}}}) is True

    def test_data_stale_when_no_quote(self):
        snap = _make_snap(L=LiquidityState.NO_QUOTE, spot=None)
        assert data_ok(snap) is False
        assert data_stale(snap) is True

    def test_data_ok_when_no_config_uses_default_threshold(self):
        snap = _make_snap(event_lag_ms=500)
        assert data_ok(snap) is True
        snap2 = _make_snap(event_lag_ms=2000)
        assert data_ok(snap2) is False


class TestGreeksBad:
    def test_greeks_bad_when_invalid(self):
        snap = _make_snap(greeks_valid=False)
        assert greeks_bad(snap) is True
        assert greeks_ok(snap) is False

    def test_greeks_ok_when_valid_finite(self):
        snap = _make_snap(greeks_valid=True, net_delta=10.0)
        assert greeks_bad(snap) is False
        assert greeks_ok(snap) is True

    def test_greeks_bad_when_nan(self):
        g = GreeksSnapshot(delta=float("nan"), gamma=0.02, valid=True)
        snap = _make_snap(greeks_valid=True)
        # Replace greeks with NaN delta (snapshot is frozen so rebuild)
        snap = StateSnapshot(
            O=snap.O, D=snap.D, M=snap.M, L=snap.L, E=snap.E, S=snap.S,
            net_delta=snap.net_delta, option_delta=snap.option_delta, stock_pos=snap.stock_pos,
            spot=snap.spot, spread_pct=snap.spread_pct, event_lag_ms=snap.event_lag_ms,
            greeks=g, option_legs_count=snap.option_legs_count,
            last_hedge_ts=snap.last_hedge_ts, last_hedge_price=snap.last_hedge_price,
            cost_params=snap.cost_params, risk_limits=snap.risk_limits, ts=snap.ts,
        )
        assert not g.is_finite()
        assert greeks_bad(snap) is True


class TestInNoTradeBand:
    def test_in_band_when_delta_within_epsilon(self):
        snap = _make_snap(net_delta=5.0)
        cfg = {"state_space": {"delta": {"epsilon_band": 10.0}}}
        assert in_no_trade_band(snap, cfg) is True
        assert out_of_band(snap, cfg) is False

    def test_out_of_band_when_delta_above_epsilon(self):
        snap = _make_snap(net_delta=25.0)
        cfg = {"state_space": {"delta": {"epsilon_band": 10.0}}}
        assert in_no_trade_band(snap, cfg) is False
        assert out_of_band(snap, cfg) is True

    def test_boundary_epsilon(self):
        snap = _make_snap(net_delta=10.0)
        cfg = {"state_space": {"delta": {"epsilon_band": 10.0}}}
        assert in_no_trade_band(snap, cfg) is True


class TestCostOk:
    def test_cost_ok_when_no_last_hedge(self):
        snap = _make_snap(spot=100.0, last_hedge_price=None)
        assert cost_ok(snap) is True

    def test_cost_ok_when_spread_extreme_fails(self):
        snap = _make_snap(spread_pct=0.6)
        assert cost_ok(snap, {"state_space": {"liquidity": {"extreme_spread_pct": 0.5}}}) is False

    def test_cost_ok_when_price_moved_enough(self):
        snap = _make_snap(spot=101.0, last_hedge_price=100.0)
        assert cost_ok(snap, {"state_space": {"hedge": {"min_price_move_pct": 0.2}}}) is True

    def test_cost_ok_when_price_not_moved_enough(self):
        snap = _make_snap(spot=100.1, last_hedge_price=100.0)
        assert cost_ok(snap, {"state_space": {"hedge": {"min_price_move_pct": 1.0}}}) is False


class TestLiquidityOk:
    def test_liquidity_ok_when_normal_spread(self):
        snap = _make_snap(L=LiquidityState.NORMAL, spread_pct=0.05)
        assert liquidity_ok(snap) is True

    def test_liquidity_not_ok_when_no_quote(self):
        snap = _make_snap(L=LiquidityState.NO_QUOTE)
        assert liquidity_ok(snap) is False

    def test_liquidity_not_ok_when_extreme_wide(self):
        snap = _make_snap(L=LiquidityState.EXTREME_WIDE)
        assert liquidity_ok(snap) is False

    def test_liquidity_ok_respects_max_spread_pct(self):
        snap = _make_snap(spread_pct=0.10)
        assert liquidity_ok(snap, {"risk": {"max_spread_pct": 0.05}}) is False
        assert liquidity_ok(snap, {"risk": {"max_spread_pct": 0.15}}) is True


class TestBrokerAndExec:
    def test_broker_down_when_disconnected(self):
        snap = _make_snap(E=ExecutionState.DISCONNECTED)
        assert broker_down(snap) is True
        assert broker_up(snap) is False

    def test_broker_down_when_broker_error(self):
        snap = _make_snap(E=ExecutionState.BROKER_ERROR)
        assert broker_down(snap) is True
        assert exec_fault(snap) is True

    def test_broker_up_when_idle(self):
        snap = _make_snap(E=ExecutionState.IDLE)
        assert broker_up(snap) is True
        assert exec_fault(snap) is False


class TestOptionPosition:
    def test_have_option_position_long_gamma(self):
        snap = _make_snap(O=OptionPositionState.LONG_GAMMA)
        assert have_option_position(snap) is True
        assert no_option_position(snap) is False

    def test_no_option_position(self):
        snap = _make_snap(O=OptionPositionState.NONE)
        assert no_option_position(snap) is True
        assert have_option_position(snap) is False


class TestDeltaBandReady:
    def test_delta_band_ready_when_greeks_valid(self):
        snap = _make_snap(greeks_valid=True)
        assert delta_band_ready(snap) is True

    def test_delta_band_not_ready_when_greeks_invalid(self):
        snap = _make_snap(greeks_valid=False)
        assert delta_band_ready(snap) is False


class TestRetryAllowed:
    def test_retry_allowed_when_under_limit(self):
        snap = _make_snap()
        guard = SimpleNamespace(max_daily_hedge_count=50, _daily_hedge_count=10)
        assert retry_allowed(snap, guard) is True

    def test_retry_not_allowed_when_at_limit(self):
        snap = _make_snap()
        guard = SimpleNamespace(max_daily_hedge_count=50, _daily_hedge_count=50)
        assert retry_allowed(snap, guard) is False
