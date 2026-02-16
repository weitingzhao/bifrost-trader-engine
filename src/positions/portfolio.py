"""Parse positions and compute portfolio delta (share equivalent)."""

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, List, Optional, Tuple

from src.pricing.black_scholes import delta as bs_delta, gamma as bs_gamma

logger = logging.getLogger(__name__)


@dataclass
class OptionLeg:
    """Single option position leg."""

    symbol: str
    expiry: str  # YYYYMMDD
    strike: float
    right: str  # 'C' or 'P'
    quantity: int  # signed: positive = long
    multiplier: int = 100

    @property
    def option_type(self) -> str:
        return "call" if self.right.upper() in ("C", "CALL") else "put"


def _dte(expiry_str: str) -> int:
    """Days to expiration from YYYYMMDD string."""
    try:
        exp = datetime.strptime(expiry_str, "%Y%m%d").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        return max(0, (exp - now).days)
    except ValueError:
        return -1


def _years_to_expiry(expiry_str: str) -> float:
    d = _dte(expiry_str)
    if d < 0:
        return 0.0
    return d / 365.0


def _is_near_atm(strike: float, spot: float, atm_band_pct: float) -> bool:
    if spot <= 0:
        return False
    return abs(strike - spot) / spot <= atm_band_pct


def parse_positions(
    positions: List[Any],
    symbol: str,
    min_dte: int = 21,
    max_dte: int = 35,
    atm_band_pct: float = 0.03,
    spot: Optional[float] = None,
) -> Tuple[List[OptionLeg], int]:
    """
    Parse raw positions (IB-style: items with .contract and .position or .position).
    Returns (option_legs for symbol in 21-35 DTE near ATM, stock_shares).
    """
    option_legs: List[OptionLeg] = []
    stock_shares = 0

    for item in positions:
        if hasattr(item, "contract") and hasattr(item, "position"):
            contract, pos = item.contract, item.position
        elif isinstance(item, dict):
            contract, pos = item.get("contract"), item.get("position", 0)
        else:
            continue
        if contract is None:
            continue

        sym = getattr(contract, "symbol", None) or (
            contract.get("symbol") if isinstance(contract, dict) else None
        )
        if not sym:
            continue

        sec_type = getattr(contract, "secType", None) or (
            contract.get("secType", "STK") if isinstance(contract, dict) else "STK"
        )

        if sec_type == "STK" and sym == symbol:
            stock_shares = int(pos)
            continue

        if sec_type != "OPT":
            continue
        if sym != symbol:
            continue

        expiry = getattr(contract, "lastTradeDateOrContractMonth", None) or (
            contract.get("lastTradeDateOrContractMonth")
            if isinstance(contract, dict)
            else ""
        )
        strike_val = getattr(contract, "strike", None) or (
            contract.get("strike") if isinstance(contract, dict) else None
        )
        right = getattr(contract, "right", None) or (
            contract.get("right", "C") if isinstance(contract, dict) else "C"
        )
        mult = getattr(contract, "multiplier", None) or (
            contract.get("multiplier", 100) if isinstance(contract, dict) else 100
        )
        if isinstance(mult, str):
            mult = int(mult) if mult.isdigit() else 100

        if not expiry or strike_val is None:
            continue

        dte = _dte(expiry)
        if dte < 0:
            continue
        if dte < min_dte or dte > max_dte:
            logger.debug(
                "Skip option %s %s %s: DTE %s outside %s-%s",
                sym,
                expiry,
                strike_val,
                dte,
                min_dte,
                max_dte,
            )
            continue
        if spot is not None and not _is_near_atm(float(strike_val), spot, atm_band_pct):
            logger.debug(
                "Skip option %s %s %s: not near ATM vs spot %s",
                sym,
                expiry,
                strike_val,
                spot,
            )
            continue

        option_legs.append(
            OptionLeg(
                symbol=sym,
                expiry=expiry,
                strike=float(strike_val),
                right=str(right).upper()[:1],
                quantity=int(pos),
                multiplier=int(mult),
            )
        )

    return option_legs, stock_shares


def portfolio_delta(
    option_legs: List[OptionLeg],
    stock_shares: int,
    spot: float,
    risk_free_rate: float,
    volatility: float,
) -> float:
    """
    Portfolio delta in share equivalent.
    Each option contributes quantity * multiplier * bs_delta; stock contributes stock_shares.
    """
    total = float(stock_shares)
    for leg in option_legs:
        t = _years_to_expiry(leg.expiry)
        d = bs_delta(spot, leg.strike, t, risk_free_rate, volatility, leg.option_type)
        total += leg.quantity * leg.multiplier * d
    return total


def portfolio_gamma(
    option_legs: List[OptionLeg],
    spot: float,
    risk_free_rate: float,
    volatility: float,
) -> float:
    """
    Portfolio gamma (per-share equivalent).
    Sum of leg.quantity * leg.multiplier * bs_gamma for each option leg.
    Stock contributes 0 gamma.
    """
    total = 0.0
    for leg in option_legs:
        t = _years_to_expiry(leg.expiry)
        g = bs_gamma(spot, leg.strike, t, risk_free_rate, volatility, leg.option_type)
        total += leg.quantity * leg.multiplier * g
    return total
