"""In-memory state store: positions, spot, last_hedge_time, daily_hedge_count, daily_pnl."""

import logging
import threading
from typing import Any, List, Optional

logger = logging.getLogger(__name__)


class TradingState:
    """Thread-safe state updated by connector callbacks and daemon."""

    def __init__(self):
        self._lock = threading.Lock()
        self._positions: List[Any] = []
        self._underlying_price: Optional[float] = None
        self._last_hedge_time: Optional[float] = None
        self._daily_hedge_count = 0
        self._daily_hedge_date: Optional[str] = None  # YYYY-MM-DD
        self._daily_pnl_usd = 0.0
        self._stock_position = 0  # net shares of underlying

    def set_positions(self, positions: List[Any], stock_position: int = 0) -> None:
        with self._lock:
            self._positions = list(positions)
            self._stock_position = stock_position

    def get_positions(self) -> List[Any]:
        with self._lock:
            return list(self._positions)

    def get_stock_position(self) -> int:
        with self._lock:
            return self._stock_position

    def set_underlying_price(self, price: Optional[float]) -> None:
        with self._lock:
            self._underlying_price = price

    def get_underlying_price(self) -> Optional[float]:
        with self._lock:
            return self._underlying_price

    def set_last_hedge_time(self, t: Optional[float]) -> None:
        with self._lock:
            self._last_hedge_time = t

    def get_last_hedge_time(self) -> Optional[float]:
        with self._lock:
            return self._last_hedge_time

    def set_daily_hedge_count(self, n: int, as_of_date: Optional[str] = None) -> None:
        with self._lock:
            self._daily_hedge_count = n
            self._daily_hedge_date = as_of_date

    def get_daily_hedge_count(self) -> int:
        with self._lock:
            return self._daily_hedge_count

    def inc_daily_hedge_count(self) -> int:
        """Increment and return new count. Caller should reset on new day if needed."""
        with self._lock:
            self._daily_hedge_count += 1
            return self._daily_hedge_count

    def set_daily_pnl(self, pnl: float) -> None:
        with self._lock:
            self._daily_pnl_usd = pnl

    def get_daily_pnl(self) -> float:
        with self._lock:
            return self._daily_pnl_usd

    def add_fill_pnl(self, pnl_delta: float) -> None:
        with self._lock:
            self._daily_pnl_usd += pnl_delta
