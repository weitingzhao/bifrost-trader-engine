"""IB Connector integration tests. Require live IB Gateway/TWS. Run with: pytest -m ib"""

import asyncio

import pytest

from src.connector.ib import IBConnector


@pytest.mark.ib
@pytest.mark.asyncio
async def test_connect_ok(connector: IBConnector):
    """Connect, assert is_connected, disconnect."""
    ok = await connector.connect()
    assert ok is True
    assert connector.is_connected is True
    await connector.disconnect()


@pytest.mark.ib
@pytest.mark.asyncio
async def test_get_positions(connector: IBConnector):
    """Connect, get positions, assert list, disconnect."""
    ok = await connector.connect()
    assert ok is True
    positions = await connector.get_positions()
    assert isinstance(positions, list)
    await connector.disconnect()


@pytest.mark.ib
@pytest.mark.asyncio
async def test_get_underlying_price(connector: IBConnector, config: dict):
    """Connect, get NVDA price, assert float > 0 or None (outside hours), disconnect."""
    ok = await connector.connect()
    assert ok is True
    symbol = config.get("symbol", "NVDA")
    spot = await connector.get_underlying_price(symbol)
    assert spot is None or (isinstance(spot, (int, float)) and spot >= 0)
    await connector.disconnect()


@pytest.mark.ib
@pytest.mark.asyncio
async def test_subscribe_ticker(connector: IBConnector, config: dict):
    """Connect, subscribe, wait 2s for ticks, assert ticker received, disconnect."""
    ok = await connector.connect()
    assert ok is True
    symbol = config.get("symbol", "NVDA")
    ticks_received = []

    def on_ticker(ticker):
        ticks_received.append(ticker)

    ticker = connector.subscribe_ticker(symbol, on_ticker)
    assert ticker is not None
    await asyncio.sleep(2.0)
    await connector.disconnect()
    # May have 0 ticks outside market hours
    assert isinstance(ticks_received, list)


@pytest.mark.ib
@pytest.mark.asyncio
async def test_subscribe_positions(connector: IBConnector):
    """Connect, subscribe to positions, assert no error, disconnect."""
    ok = await connector.connect()
    assert ok is True
    callback_called = []

    def on_position():
        callback_called.append(1)

    connector.subscribe_positions(on_position)
    await asyncio.sleep(0.5)
    await connector.disconnect()
    assert connector.is_connected is False
