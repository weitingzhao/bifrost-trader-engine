"""IB connector: connect, positions, ticker, place_order; optional subscriptions."""

import asyncio
import logging
from typing import Any, Callable, Dict, List, Optional

from ib_insync import (
    IB,
    Stock,
    MarketOrder,
    LimitOrder,
    Order,
    Trade,
    Fill,
    Position,
    Ticker,
    AccountValue,
    Option,
)

logger = logging.getLogger(__name__)


class IBConnector:
    """Minimal IB connector for gamma scalping daemon."""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 4001,
        client_id: int = 1,
        connect_timeout: float = 60.0,
    ):
        self.host = host
        self.port = port
        self.client_id = client_id
        self.connect_timeout = connect_timeout
        self.ib = IB()
        self._connected = False
        self._stock_contract: Optional[Stock] = None

    @property
    def is_connected(self) -> bool:
        return self._connected and self.ib.isConnected()

    def _stock(self, symbol: str, exchange: str = "SMART") -> Stock:
        return Stock(symbol, exchange, "USD")

    # Per-attempt timeout when retrying client IDs; avoid waiting full connect_timeout (e.g. 60s) after 326
    _CONNECT_ATTEMPT_TIMEOUT = 15.0

    async def connect(self, max_attempts: Optional[int] = None) -> bool:
        """Connect to TWS/Gateway.

        When max_attempts is 1 (e.g. daemon heartbeat retry): try once with current client_id and return.
        When max_attempts is None or >1: try up to max_attempts (default 10) with client_id, client_id+1, ...
        so that "client_id in use" (326) can be worked around. No delay between attempts when >1.
        """
        if self.is_connected:
            return True
        base_id = self.client_id
        limit = max_attempts if max_attempts is not None else 10
        last_exc = None
        attempt_timeout = min(self.connect_timeout, self._CONNECT_ATTEMPT_TIMEOUT)
        wait_secs = int(attempt_timeout) + 5
        for attempt in range(limit):
            try_id = base_id + attempt
            logger.info(
                "IB connect attempt %s/%s (clientId=%s): may take up to %s–%ss%s",
                attempt + 1,
                limit,
                try_id,
                int(attempt_timeout),
                wait_secs,
                (
                    " (single attempt per heartbeat)"
                    if limit == 1
                    else "; if client_id in use will retry with next ID"
                ),
            )
            try:
                logger.debug(
                    "Connecting to IB %s:%s clientId=%s timeout=%.0fs",
                    self.host,
                    self.port,
                    try_id,
                    attempt_timeout,
                )
                await asyncio.wait_for(
                    self.ib.connectAsync(
                        self.host,
                        self.port,
                        clientId=try_id,
                        timeout=attempt_timeout,
                    ),
                    timeout=attempt_timeout + 5.0,
                )
                self.client_id = try_id
                self._connected = True
                if try_id != base_id:
                    logger.info(
                        "Connected to IB %s:%s clientId=%s (base %s was in use)",
                        self.host,
                        self.port,
                        try_id,
                        base_id,
                    )
                else:
                    logger.info(
                        "Connected to IB %s:%s clientId=%s",
                        self.host,
                        self.port,
                        self.client_id,
                    )
                return True
            except Exception as e:
                last_exc = e
                if self.ib.isConnected():
                    try:
                        self.ib.disconnect()
                    except Exception:
                        pass
                if attempt < limit - 1:
                    logger.warning(
                        "IB clientId=%s failed (%s), retrying with clientId=%s (next attempt may take up to %ss)",
                        try_id,
                        e,
                        try_id + 1,
                        wait_secs,
                    )
                else:
                    if limit == 1:
                        logger.debug(
                            "IB connect attempt failed (will retry on next heartbeat): %s",
                            last_exc,
                        )
                    else:
                        logger.error(
                            "IB connect failed after %s attempts: %s", limit, last_exc
                        )
                    self._connected = False
                    return False
        self._connected = False
        if last_exc:
            logger.error("IB connect failed after %s attempts: %s", limit, last_exc)
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

    def get_managed_accounts(self) -> List[str]:
        """Return list of managed account IDs (e.g. ['U17113214', 'DU456']). Empty when not connected. R-A1.
        IB API returns comma-separated string; we normalize to list of non-empty IDs."""
        if not self.is_connected:
            return []
        try:
            raw = self.ib.managedAccounts()
            logger.info(
                "[R-A1] get_managed_accounts raw=%r (type=%s)", raw, type(raw).__name__
            )
            if not raw:
                return []
            # TWS API returns comma-separated string (e.g. "U17113214,DU123"); some wrappers return list
            if isinstance(raw, str):
                parts = raw.split(",")
            else:
                parts = [str(s) for s in raw]
            out = [s.strip() for s in parts if s.strip()]
            logger.info("[R-A1] get_managed_accounts parsed=%s", out)
            return out
        except Exception as e:
            logger.warning("get_managed_accounts: %s", e, exc_info=True)
            return []

    async def get_account_summary(
        self, account: Optional[str] = None
    ) -> List[AccountValue]:
        """Request and return account summary (NetLiquidation, TotalCashValue, BuyingPower, etc.). R-A1.
        If account is None, returns values for all accounts (ib_insync convention).
        """
        if not self.is_connected:
            return []
        try:
            # accountSummaryAsync calls reqAccountSummaryAsync on first run, then returns cached values
            values = await self.ib.accountSummaryAsync(account or "")
            return list(values) if values else []
        except Exception as e:
            logger.warning("get_account_summary: %s", e)
            return []

    @staticmethod
    def position_to_dict(pos: Position) -> Dict[str, Any]:
        """Convert IB Position to a JSON-serializable dict for monitoring (R-A1 multi-account).
        For OPT: includes lastTradeDateOrContractMonth (expiry), strike, right (C/P) so options are distinguishable.
        """
        c = pos.contract
        sec_type = getattr(c, "secType", "") or ""
        out: Dict[str, Any] = {
            "account": pos.account,
            "symbol": getattr(c, "symbol", "") or "",
            "secType": sec_type,
            "exchange": getattr(c, "exchange", "") or "",
            "currency": getattr(c, "currency", "") or "",
            "position": float(pos.position),
            "avgCost": float(pos.avgCost) if pos.avgCost is not None else None,
        }
        if sec_type == "OPT":
            # IB Option contract: lastTradeDateOrContractMonth (YYYYMM or YYYYMMDD), strike, right ('C'/'P' or 'CALL'/'PUT')
            out["lastTradeDateOrContractMonth"] = (
                getattr(c, "lastTradeDateOrContractMonth", None) or ""
            )
            out["strike"] = getattr(c, "strike", None)
            out["right"] = getattr(c, "right", None) or ""
            out["multiplier"] = getattr(c, "multiplier", None)
        return out

    async def get_positions(self, account: Optional[str] = None) -> List[Position]:
        """Return list of IB Position objects. If account is None, returns all positions (all accounts)."""
        if not self.is_connected:
            await self.connect()
        # Use async API to avoid "event loop is already running" when called from asyncio.
        await self.ib.reqPositionsAsync()
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
            await self.ib.qualifyContractsAsync(stock)
            # reqTickers() uses run_until_complete internally; use reqMktData + wait for update.
            ticker = self.ib.reqMktData(stock, "", False, False)
            await asyncio.sleep(0.5)
            mid = (
                (ticker.bid + ticker.ask) / 2.0
                if (ticker.bid and ticker.ask)
                else (ticker.last if ticker.last else None)
            )
            return float(mid) if mid is not None else None
        except Exception as e:
            logger.error("get_underlying_price %s: %s", symbol, e)
        return None

    async def get_instrument_price(
        self,
        symbol: str,
        sec_type: str,
        expiry: Optional[str] = None,
        strike: Optional[float] = None,
        right: Optional[str] = None,
        exchange: str = "SMART",
        currency: str = "USD",
    ) -> Optional[Dict[str, Optional[float]]]:
        """Get price for a generic instrument (stock/option). Returns dict with bid/ask/last/mid or None.

        用于阶段 3 R-M6：按 account_positions 逐标的拉价。
        """
        if not self.is_connected:
            await self.connect()
        sec = (sec_type or "").upper()
        if not symbol:
            return None
        contract = None
        try:
            if sec == "OPT":
                exp = (expiry or "").strip()
                if not exp or strike is None or right is None:
                    return None
                rt = str(right).upper()
                contract = Option(symbol, exp, float(strike), rt, exchange, currency)
            else:
                contract = self._stock(symbol, exchange)
            await self.ib.qualifyContractsAsync(contract)
            ticker = self.ib.reqMktData(contract, "", False, False)
            # 给行情一点时间刷新，多等几次，避免总是拿到全 0 而导致不写库
            bid = ask = last = mid = None
            for _ in range(3):
                await asyncio.sleep(0.5)
                tbid = getattr(ticker, "bid", None)
                task = getattr(ticker, "ask", None)
                tlast = getattr(ticker, "last", None)
                # IB 有时用 0 或 -1 表示“暂无有效报价”，这里统一过滤掉非正数
                try:
                    if tbid is not None:
                        fb = float(tbid)
                        if fb > 0:
                            bid = fb
                    if task is not None:
                        fa = float(task)
                        if fa > 0:
                            ask = fa
                    if tlast is not None:
                        fl = float(tlast)
                        if fl > 0:
                            last = fl
                except (TypeError, ValueError):
                    pass
                if bid is not None and ask is not None:
                    mid = (bid + ask) / 2.0
                elif last is not None:
                    mid = last
                if (
                    bid is not None
                    or ask is not None
                    or last is not None
                    or mid is not None
                ):
                    break
            if bid is None and ask is None and last is None and mid is None:
                return None
            return {"bid": bid, "ask": ask, "last": last, "mid": mid}
        except Exception as e:
            logger.error("get_instrument_price %s %s: %s", sec_type, symbol, e)
            return None

    async def subscribe_ticker(
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
            await self.ib.qualifyContractsAsync(stock)
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
        self.ib.execDetailsEvent += lambda trade, fill: on_fill(trade)

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
            await self.ib.qualifyContractsAsync(stock)
            if order_type == "market":
                order = MarketOrder(side.upper(), quantity)
            else:
                price = limit_price or 0.0
                order = LimitOrder(side.upper(), quantity, price)
                order.action = side.upper()
            # placeOrder() blocks with run_until_complete; run in executor to avoid nesting event loop.
            loop = asyncio.get_running_loop()
            trade = await loop.run_in_executor(
                None, lambda: self.ib.placeOrder(stock, order)
            )
            logger.info(
                "Order placed: %s %s %s @ %s", side, quantity, symbol, order_type
            )
            return trade
        except (
            ConnectionError,
            BrokenPipeError,
            ValueError,
            TimeoutError,
            asyncio.TimeoutError,
        ) as e:
            logger.error("place_order failed: %s", e)
            return None
