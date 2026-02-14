"""Gamma scalper: hedge decision when |portfolio_delta| > threshold (MVP: 25 shares)."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class HedgeOrder:
    """Proposed hedge: side and quantity in shares."""
    side: str   # 'BUY' or 'SELL'
    quantity: int


def gamma_scalper_hedge(
    portfolio_delta: float,
    delta_threshold_shares: float = 25.0,
    max_hedge_shares_per_order: int = 500,
) -> Optional[HedgeOrder]:
    """
    Decide whether to hedge (long-gamma: target delta 0).
    Returns HedgeOrder(side, quantity) or None if |delta| <= threshold.
    """
    if portfolio_delta > delta_threshold_shares:
        qty = min(int(round(portfolio_delta)), max_hedge_shares_per_order)
        if qty <= 0:
            return None
        return HedgeOrder(side="SELL", quantity=qty)
    if portfolio_delta < -delta_threshold_shares:
        qty = min(int(round(-portfolio_delta)), max_hedge_shares_per_order)
        if qty <= 0:
            return None
        return HedgeOrder(side="BUY", quantity=qty)
    return None
