"""Market data stub: wraps RuntimeStore for bid, ask, spread, last_ts."""

import time
from typing import Optional

from src.engine.store import RuntimeStore


class MarketData:
    """Exposes bid, ask, spread_pct, last_ts from state. last_ts set on tick."""

    def __init__(self, state: RuntimeStore, last_ts: Optional[float] = None):
        self._state = state
        self._last_ts: Optional[float] = last_ts

    def set_last_ts(self, ts: Optional[float]) -> None:
        self._last_ts = ts

    def touch_ts(self) -> None:
        """Set last_ts to now (call on each tick)."""
        self._last_ts = time.time()

    @property
    def bid(self) -> Optional[float]:
        return self._state.get_bid()

    @property
    def ask(self) -> Optional[float]:
        return self._state.get_ask()

    @property
    def spread_pct(self) -> Optional[float]:
        return self._state.get_spread_pct()

    @property
    def last_ts(self) -> Optional[float]:
        return self._last_ts

    @property
    def mid(self) -> Optional[float]:
        return self._state.get_underlying_price()
