"""Integration tests: GsTrading with TradingFSM-driven flow and mock connector."""

from unittest.mock import AsyncMock, MagicMock

import pytest

from src.app.gs_trading import GsTrading
from src.core.state.enums import TradingState


@pytest.fixture
def minimal_config():
    return {
        "ib": {"host": "127.0.0.1", "port": 4001},
        "symbol": "NVDA",
        "greeks": {"risk_free_rate": 0.05, "volatility": 0.35},
        "gates": {
            "structure": {"min_dte": 21, "max_dte": 35, "atm_band_pct": 0.03},
            "hedge": {
                "cooldown_sec": 60,
                "max_daily_hedge_count": 20,
                "max_position_shares": 1000,
                "max_daily_loss_usd": 5000,
                "max_net_delta_shares": 500,
                "max_spread_pct": 0.5,
                "min_price_move_pct": 0.2,
                "threshold_hedge_shares": 25,
                "max_hedge_shares_per_order": 100,
                "min_hedge_shares": 10,
                "earnings_dates": [],
                "blackout_days_before": 0,
                "blackout_days_after": 0,
                "trading_hours_only": False,
            },
            "risk": {"paper_trade": True},
        },
        "order": {"order_type": "market"},
    }


@pytest.mark.asyncio
async def test_handle_connected_bootstraps_trading_fsm(minimal_config):
    """After _handle_connected, TradingFSM has left BOOT (START/SYNCED applied)."""
    app = GsTrading(minimal_config)
    app.connector = AsyncMock()
    app.connector.is_connected = True
    app.connector.get_positions = AsyncMock(return_value=[])
    app.connector.get_underlying_price = AsyncMock(return_value=100.0)
    app.connector.get_managed_accounts = MagicMock(return_value=[])
    app.connector.get_account_summary = AsyncMock(return_value=[])

    from src.fsm.daemon_fsm import DaemonState

    next_state = await app._handle_connected()
    assert next_state == DaemonState.RUNNING
    assert app._fsm_trading.state != TradingState.BOOT
    assert app._fsm_trading.state in (TradingState.IDLE, TradingState.SAFE, TradingState.SYNC)


@pytest.mark.asyncio
async def test_eval_hedge_runs_without_error(minimal_config):
    """_eval_hedge runs without exception and applies TICK to TradingFSM."""
    app = GsTrading(minimal_config)
    app.connector = AsyncMock()
    app.connector.is_connected = True
    app.connector.get_positions = AsyncMock(return_value=[])
    app.connector.get_underlying_price = AsyncMock(return_value=100.0)
    app.connector.get_managed_accounts = MagicMock(return_value=[])
    app.connector.get_account_summary = AsyncMock(return_value=[])
    app.store.set_underlying_price(100.0)
    app.store.set_positions([], 0)

    await app._handle_connected()
    await app._eval_hedge()
    assert app._fsm_trading.state in (
        TradingState.IDLE,
        TradingState.SAFE,
        TradingState.SYNC,
        TradingState.ARMED,
        TradingState.MONITOR,
        TradingState.NO_TRADE,
        TradingState.PAUSE_COST,
        TradingState.PAUSE_LIQ,
    )
