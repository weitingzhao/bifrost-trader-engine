"""Dispatch gateway ops to AccountIbClient / MarketIbClient."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from src.monitor.integrations.ib_clients import AccountIbClient, MarketIbClient

logger = logging.getLogger(__name__)


class IbGatewayExecutor:
    """Holds long-lived IB clients; async methods run on each client internal loop."""

    def __init__(
        self,
        *,
        account: AccountIbClient,
        market: MarketIbClient,
        account_secondary: Optional[AccountIbClient],
    ) -> None:
        self._account = account
        self._market = market
        self._account_secondary = account_secondary

    def _account_for_slot(self, payload: Dict[str, Any]) -> AccountIbClient:
        slot = (payload.get("account_slot") or "primary").strip().lower()
        if slot == "secondary" and self._account_secondary is not None:
            return self._account_secondary
        return self._account

    async def execute(self, op: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        if op == "ping":
            return {"ok": True, "data": self.health_dict()}
        if op == "disconnect_all":
            await self.disconnect_all()
            return {"ok": True, "data": self.health_dict()}
        if op == "reconnect_all":
            await self.connect_all()
            return {"ok": True, "data": self.health_dict()}
        if op == "fetch_executions":
            days = int(payload.get("days") or 7)
            acc = self._account_for_slot(payload)
            rows = await acc.fetch_executions(days=days)
            return {"ok": True, "data": {"executions": rows}}
        if op == "fetch_accounts_snapshot":
            acc = self._account_for_slot(payload)
            rows = await acc.fetch_accounts_snapshot()
            return {"ok": True, "data": {"accounts": rows}}
        if op == "fetch_bars":
            symbol = str(payload.get("symbol") or "").strip()
            period = str(payload.get("period") or "1 day").strip()
            duration = str(payload.get("duration") or "1 D").strip()
            if not symbol:
                return {"ok": False, "error": "missing_symbol"}
            bars = await self._market.fetch_bars(symbol, period, duration)
            return {"ok": True, "data": {"bars": bars}}
        if op == "fetch_option_expirations":
            symbol = str(payload.get("symbol") or "").strip()
            if not symbol:
                return {"ok": False, "error": "missing_symbol"}
            out = await self._market.fetch_option_expirations(symbol)
            return {"ok": True, "data": out}
        if op == "fetch_option_snapshot":
            symbol = str(payload.get("symbol") or "").strip()
            expiration = str(payload.get("expiration") or "").strip()
            strikes = payload.get("strikes") or []
            if not isinstance(strikes, list):
                strikes = []
            strikes_f: List[float] = []
            for s in strikes:
                try:
                    strikes_f.append(float(s))
                except (TypeError, ValueError):
                    pass
            max_contracts = int(payload.get("max_contracts") or 20)
            pacing_sec = float(payload.get("pacing_sec") or 0.35)
            if not symbol or not expiration:
                return {"ok": False, "error": "missing_symbol_or_expiration"}
            rows, underlying_price = await self._market.fetch_option_snapshot(
                symbol,
                expiration,
                strikes_f,
                max_contracts=max_contracts,
                pacing_sec=pacing_sec,
            )
            return {
                "ok": True,
                "data": {"rows": rows, "underlying_price": underlying_price},
            }
        return {"ok": False, "error": f"unhandled_op:{op}"}

    def health_dict(self) -> Dict[str, Any]:
        def _one(c: Any) -> Dict[str, Any]:
            return {
                "connected": bool(getattr(c, "connected", False)),
                "client_id": int(getattr(c, "client_id", 0)),
                "last_error": getattr(c, "last_error", None),
            }

        out: Dict[str, Any] = {
            "account": _one(self._account),
            "market": _one(self._market),
            "gateway_alive": True,
        }
        if self._account_secondary is not None:
            out["account2"] = _one(self._account_secondary)
        else:
            out["account2"] = None
        return out

    async def connect_all(self) -> None:
        await self._account.ensure_connected()
        await self._market.ensure_connected()
        if self._account_secondary is not None:
            await self._account_secondary.ensure_connected()

    async def disconnect_all(self) -> None:
        try:
            await self._account.disconnect()
        except Exception as e:
            logger.debug("disconnect account: %s", e)
        try:
            await self._market.disconnect()
        except Exception as e:
            logger.debug("disconnect market: %s", e)
        if self._account_secondary is not None:
            try:
                await self._account_secondary.disconnect()
            except Exception as e:
                logger.debug("disconnect account2: %s", e)
