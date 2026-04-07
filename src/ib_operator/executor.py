"""Dispatch IB Operator ops to OperatorIbClient / secondary AccountIbClient.

Long-lived market data subscriptions are owned by IB Ingestor (and account-domain
streaming by IB Account Agent). This executor handles on-demand RPC only, including
``place_stock_order`` — no ``reqMktData`` subscription loops here.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from src.ib_operator.health_redis import jsonish_connected
from src.monitor.integrations.ib_clients import AccountIbClient, OperatorIbClient

logger = logging.getLogger(__name__)


class IbOperatorExecutor:
    """Holds long-lived IB clients; async methods run on each client internal loop."""

    def __init__(
        self,
        *,
        primary: OperatorIbClient,
        account_secondary: Optional[AccountIbClient],
    ) -> None:
        self._primary = primary
        self._account_secondary = account_secondary
        self._cmd_count = 0
        self._last_cmd_ts = 0.0

    def note_cmd_processed(self) -> None:
        """Increment after each handled operator stream message (Redis cmd RPC)."""
        self._cmd_count += 1
        self._last_cmd_ts = time.time()

    def _account_for_slot(self, payload: Dict[str, Any]) -> AccountIbClient | OperatorIbClient:
        slot = (payload.get("account_slot") or "primary").strip().lower()
        if slot == "secondary" and self._account_secondary is not None:
            return self._account_secondary
        return self._primary

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
        if op == "place_stock_order":
            # Engine (Daemon) hedge path when use_ib_edge: no subscription on Operator — active placeOrder only.
            symbol = str(payload.get("symbol") or "").strip()
            side = str(payload.get("side") or "").strip()
            qty = int(payload.get("quantity") or 0)
            order_type = str(payload.get("order_type") or "market").strip().lower()
            limit_price = payload.get("limit_price")
            if not symbol or qty <= 0:
                return {"ok": False, "error": "missing_symbol_or_quantity"}
            acc = self._primary
            await acc._ensure_connected_impl()
            co = acc.connector
            if co is None:
                return {"ok": False, "error": "no_connector"}
            trade = await co.place_order(
                symbol,
                side,
                qty,
                order_type=order_type,
                limit_price=limit_price,
            )
            if trade is None:
                return {"ok": False, "error": "place_order_returned_none"}
            order = getattr(trade, "order", None)
            oid = getattr(order, "orderId", None) if order is not None else None
            return {"ok": True, "data": {"order_id": oid}}
        if op == "fetch_bars":
            symbol = str(payload.get("symbol") or "").strip()
            period = str(payload.get("period") or "1 day").strip()
            duration = str(payload.get("duration") or "1 D").strip()
            if not symbol:
                return {"ok": False, "error": "missing_symbol"}
            bars = await self._primary.fetch_bars(symbol, period, duration)
            return {"ok": True, "data": {"bars": bars}}
        if op == "fetch_option_expirations":
            symbol = str(payload.get("symbol") or "").strip()
            if not symbol:
                return {"ok": False, "error": "missing_symbol"}
            out = await self._primary.fetch_option_expirations(symbol)
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
            rows, underlying_price = await self._primary.fetch_option_snapshot(
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
        def _connected_for_health(c: Any) -> bool:
            snap = getattr(c, "connected_snapshot", None)
            if callable(snap):
                return jsonish_connected(snap())
            return jsonish_connected(getattr(c, "connected", False))

        def _one(c: Any) -> Dict[str, Any]:
            return {
                "connected": _connected_for_health(c),
                "client_id": int(getattr(c, "client_id", 0)),
                "last_error": getattr(c, "last_error", None),
                "reconnects": int(getattr(c, "reconnects", 0)),
            }

        out: Dict[str, Any] = {
            "host": _one(self._primary),
            "service_alive": True,
            "cmd_count": self._cmd_count,
            "last_cmd_ts": self._last_cmd_ts,
        }
        if self._account_secondary is not None:
            out["secondary"] = _one(self._account_secondary)
        else:
            out["secondary"] = None
        return out

    async def connect_all(self) -> None:
        await self._primary.ensure_connected()
        if self._account_secondary is not None:
            await self._account_secondary.ensure_connected()

    async def disconnect_all(self) -> None:
        try:
            await self._primary.disconnect()
        except Exception as e:
            logger.debug("disconnect primary: %s", e)
        if self._account_secondary is not None:
            try:
                await self._account_secondary.disconnect()
            except Exception as e:
                logger.debug("disconnect secondary: %s", e)
