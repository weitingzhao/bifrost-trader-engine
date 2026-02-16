"""Gamma scalper: target-position-based hedge (target delta 0)."""

from dataclasses import dataclass
from typing import Optional


@dataclass
class HedgeOrder:
    """Proposed hedge: side and quantity in shares."""

    side: str  # 'BUY' or 'SELL'
    quantity: int


def compute_target_and_need(
    portfolio_delta: float,
    stock_shares: int,
) -> tuple[float, float]:
    """
    Target-position framing: target delta 0.
    target_shares = -opt_delta_shares (opt_delta = port_delta - stock_shares)
    need = target_shares - stock_shares = -port_delta

    Returns (target_shares, need).
    """
    opt_delta_shares = portfolio_delta - stock_shares
    target_shares = -opt_delta_shares
    need = target_shares - stock_shares
    return target_shares, need


def gamma_scalper_hedge(
    portfolio_delta: float,
    stock_shares: int,
    delta_threshold_shares: float = 25.0,
    max_hedge_shares_per_order: int = 500,
) -> Optional[HedgeOrder]:
    """
    Target-position-based hedge: need = target_shares - pos_shares.
    Only hedge when |need| >= threshold.
    Returns HedgeOrder(side, quantity) or None.
    """
    _, need = compute_target_and_need(portfolio_delta, stock_shares)
    if need > delta_threshold_shares:
        qty = min(int(round(need)), max_hedge_shares_per_order)
        if qty <= 0:
            return None
        return HedgeOrder(side="BUY", quantity=qty)
    if need < -delta_threshold_shares:
        qty = min(int(round(-need)), max_hedge_shares_per_order)
        if qty <= 0:
            return None
        return HedgeOrder(side="SELL", quantity=qty)
    return None
