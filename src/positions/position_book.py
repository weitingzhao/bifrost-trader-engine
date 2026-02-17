"""Position book: wraps RuntimeStore + parse_positions for state space."""

from typing import Any, List

from src.core.store import RuntimeStore
from src.positions.portfolio import OptionLeg, parse_positions


class PositionBook:
    """Exposes option_legs and stock_shares from current state."""

    def __init__(
        self,
        state: RuntimeStore,
        symbol: str,
        min_dte: int = 21,
        max_dte: int = 35,
        atm_band_pct: float = 0.03,
    ):
        self._state = state
        self._symbol = symbol
        self._min_dte = min_dte
        self._max_dte = max_dte
        self._atm_band_pct = atm_band_pct

    @property
    def option_legs(self) -> List[OptionLeg]:
        positions = self._state.get_positions()
        spot = self._state.get_underlying_price()
        legs, _ = parse_positions(
            positions,
            self._symbol,
            min_dte=self._min_dte,
            max_dte=self._max_dte,
            atm_band_pct=self._atm_band_pct,
            spot=spot,
        )
        return legs

    @property
    def stock_shares(self) -> int:
        return self._state.get_stock_position()
