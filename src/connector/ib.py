"""IB connector: connect, positions, ticker, place_order; optional subscriptions."""

import asyncio
import logging
from typing import Any, Callable, List, Optional

from ib_insync import IB, Stock, MarketOrder, LimitOrder, Order, Trade, Fill, Position, Ticker

logger = logging.getLogger(__name__)


class IBConnector:
    """Minimal IB connector for gamma scalping daemon."""

    def __init__(self, host: str = "127.0.0.1", port: int = 4001, client_id: int = 1):
        self.host = host
        self.port = port
        self.client_id = client_id
        self.ib = IB()
        self._connected = False
        self._stock_contract: Optional[Stock] = None

    @property
    def is_connected(self) -> bool:
        return self._connected and self.ib.isConnected()

    def _stock(self, symbol: str, exchange: str = "SMART") -> Stock:
        return Stock(symbol, exchange, "USD")

    async def connect(self) -> bool:
        """Connect to TWS/Gateway."""
        if self.is_connected:
            return True
        try:
            await self.ib.connectAsync(self.host, self.port, clientId=self.client_id)
            self._connected = True
            logger.info("Connected to IB %s:%s clientId=%s", self.host, self.port, self.client_id)
            return True
        except Exception as e:
            logger.error("IB connect failed: %s", e)
            self._connected = False
            return False

    async def disconnect(self) -> None:
        """Disconnect from IB."""
        if not self._connected:
            return
        try:
            self.ib.disconnect()
        except Exception as e:
            logger.error("IB disconnect error: %s", e)
        self._connected = False
        logger.info("Disconnected from IB")

    async def get_positions(self, account: Optional[str] = None) -> List[Position]:
        """Return list of IB Position objects. If account is None, use first account."""
        if not self.is_connected:
            await self.connect()
        self.ib.reqPositions()
        await asyncio.sleep(0.2)
        positions = self.ib.positions(account)
        return list(positions)

    def get_positions_sync(self) -> List[Position]:
        """Synchronous positions (for use inside ib callbacks)."""
        return list(self.ib.positions())

    async def get_underlying_price(self, symbol: str) -> Optional[float]:
        """Get mid price for underlying stock."""
        if not self.is_connected:
            await self.connect()
        stock = self._stock(symbol)
        try:
            self.ib.qualifyContracts(stock)
            tickers = self.ib.reqTickers(stock)
            await asyncio.sleep(0.5)
            if tickers:
                t = tickers[0]
                mid = (t.bid + t.ask) / 2.0 if (t.bid and t.ask) else (t.last if t.last else None)
                return float(mid) if mid is not None else None
        except Exception as e:
            logger.error("get_underlying_price %s: %s", symbol, e)
        return None

    def subscribe_ticker(
        self,
        symbol: str,
        on_update: Callable[[Ticker], None],
    ) -> Optional[Ticker]:
        """Subscribe to live ticker; on_update called on each tick. Returns the Ticker."""
        if not self.is_connected:
            logger.warning("subscribe_ticker: not connected")
            return None
        stock = self._stock(symbol)
        try:
            self.ib.qualifyContracts(stock)
            ticker = self.ib.reqMktData(stock, "", False, False)
            ticker.updateEvent += lambda t: on_update(t)
            self._stock_contract = stock
            return ticker
        except Exception as e:
            logger.error("subscribe_ticker %s: %s", symbol, e)
            return None

    def subscribe_positions(self, on_update: Callable[[], None]) -> None:
        """Subscribe to position updates; on_update() called when positions change."""
        if not self.is_connected:
            return
        self.ib.positionEvent += lambda _: on_update()

    def subscribe_fills(self, on_fill: Callable[[Trade], None]) -> None:
        """Subscribe to fill/trade updates."""
        if not self.is_connected:
            return
        self.ib.execDetailsEvent += lambda _: None
        self.ib.tradeEvent += lambda t: on_fill(t)

    async def place_order(
        self,
        symbol: str,
        side: str,
        quantity: int,
        order_type: str = "market",
        limit_price: Optional[float] = None,
    ) -> Optional[Trade]:
        """Place stock order. Returns Trade or None."""
        if not self.is_connected:
            await self.connect()
        if quantity <= 0:
            logger.warning("place_order: quantity <= 0")
            return None
        stock = self._stock(symbol)
        try:
            self.ib.qualifyContracts(stock)
            if order_type == "market":
                order = MarketOrder(side.upper(), quantity)
            else:
                price = limit_price or 0.0
                order = LimitOrder(price, quantity)
                order.action = side.upper()
            trade = self.ib.placeOrder(stock, order)
            logger.info("Order placed: %s %s %s @ %s", side, quantity, symbol, order_type)
            return trade
        except Exception as e:
            logger.error("place_order failed: %s", e)
            return None
