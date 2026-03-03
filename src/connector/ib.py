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
    ExecutionFilter,
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
        self._commission_registered = False
        self._stock_contract: Optional[Stock] = None
        self._commission_report_callback: Optional[
            Callable[[str, Optional[float], Optional[float], Optional[str], Optional[float], Optional[int]], None]
        ] = None

    def set_commission_report_callback(
        self,
        callback: Optional[
            Callable[[str, Optional[float], Optional[float], Optional[str], Optional[float], Optional[int]], None]
        ],
    ) -> None:
        """设置 commissionReport 事件回调：收到 IB commissionReport 时调用 callback(exec_id, commission, realized_pnl, currency, yield_, yield_redemption_date)。
        仅 live 成交会触发；历史 reqExecutions 不会触发事件，仍依赖 get_executions_async 返回后合并。"""
        self._commission_report_callback = callback

    def _on_commission_report(self, trade: Any, fill: Any, report: Any) -> None:
        if not self._commission_report_callback or not fill or not report:
            return
        ex = getattr(fill, "execution", None)
        exec_id = getattr(ex, "execId", None) if ex else None
        if not exec_id:
            return
        commission = getattr(report, "commission", None)
        realized_pnl = getattr(report, "realizedPNL", None)
        currency = getattr(report, "currency", None)
        yield_ = getattr(report, "yield_", None)
        yield_redemption_date = getattr(report, "yieldRedemptionDate", None)
        if yield_redemption_date is not None:
            try:
                yield_redemption_date = int(yield_redemption_date)
            except (TypeError, ValueError):
                yield_redemption_date = None
        try:
            self._commission_report_callback(exec_id, commission, realized_pnl, currency, yield_, yield_redemption_date)
        except Exception as e:
            logger.warning("commission_report_callback failed: exec_id=%r %s", exec_id, e)

    @property
    def is_connected(self) -> bool:
        return self._connected and self.ib.isConnected()

    def _stock(self, symbol: str, exchange: str = "SMART") -> Stock:
        return Stock(symbol, exchange, "USD")

    # Per-attempt timeout when retrying client IDs; avoid waiting full connect_timeout (e.g. 60s) after 326
    _CONNECT_ATTEMPT_TIMEOUT = 15.0

    async def connect(self, max_attempts: Optional[int] = None, bars_only: bool = False) -> bool:
        """Connect to TWS/Gateway.

        When max_attempts is 1 (e.g. daemon heartbeat retry): try once with current client_id and return.
        When max_attempts is None or >1: try up to max_attempts (default 10) with client_id, client_id+1, ...
        so that "client_id in use" (326) can be worked around. No delay between attempts when >1.
        When bars_only is True, do not register commissionReportEvent (used by 拉取K线 to avoid position/exec side effects).
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
                if not bars_only:
                    self.ib.commissionReportEvent += self._on_commission_report
                    self._commission_registered = True
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
        if self._commission_registered:
            try:
                self.ib.commissionReportEvent -= self._on_commission_report
            except Exception:
                pass
            self._commission_registered = False
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

    def _exec_side_to_buy_sell(self, side: Optional[str]) -> str:
        """Map IB Execution.side (BOT/SLD) to BUY/SELL. Handles variants."""
        if not side:
            return ""
        s = str(side).strip().upper()
        if s in ("BOT", "BUY", "B"):
            return "BUY"
        if s in ("SLD", "SELL", "S"):
            return "SELL"
        return side

    def _contract_key(self, contract: Any) -> str:
        """Build contract_key like account_positions: symbol|sec_type|expiry|strike|right."""
        if contract is None:
            return ""
        sym = getattr(contract, "symbol", "") or ""
        st = getattr(contract, "secType", "") or ""
        if st == "OPT":
            exp = getattr(contract, "lastTradeDateOrContractMonth", "") or ""
            strike = getattr(contract, "strike", 0) or 0
            right = getattr(contract, "right", "") or ""
            return f"{sym}|{st}|{exp}|{strike}|{right}"
        return f"{sym}|{st}||||"

    async def get_executions_async(
        self,
        account: Optional[str] = None,
        since_days: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Request from IB and return account executions/fills (R-A2). Returns full data for DB storage.
        Use reqExecutionsAsync so we get fills from IB server (including today's trades), not only from current session.
        since_days: 1=仅当天(默认), 3=最近3天, 7=最近7天；需 TWS Trade Log 已勾选对应天数。
        TWS 先发 execDetails/execDetailsEnd 再发 commissionReport，故在拿到 fills 后等待一段时间并订阅
        commissionReportEvent，确保 commission/realizedPNL 能落库。"""
        if not self.is_connected:
            await self.connect()
        try:
            from datetime import datetime, timedelta, timezone
            time_str = ""
            if since_days is not None and since_days > 0:
                # IB ExecutionFilter.Time: 使用 UTC 明确时区，避免 Warning 2174
                start = datetime.now(timezone.utc) - timedelta(days=since_days - 1)
                time_str = start.strftime("%Y%m%d %H:%M:%S") + " UTC"
            ef = ExecutionFilter(acctCode=account or "", time=time_str)

            # 收集 execId -> CommissionReport 数据（TWS 的 commissionReport 在 execDetailsEnd 之后才到达）
            commission_by_exec_id: Dict[str, Dict[str, Any]] = {}

            def on_commission_report(trade: Any, fill: Any, report: Any) -> None:
                if fill and getattr(fill, "execution", None) and report:
                    eid = getattr(fill.execution, "execId", None)
                    if eid:
                        commission_by_exec_id[eid] = {
                            "commission": getattr(report, "commission", None),
                            "realizedPNL": getattr(report, "realizedPNL", None),
                            "currency": getattr(report, "currency", None),
                            "yield_": getattr(report, "yield_", None),
                            "yieldRedemptionDate": getattr(report, "yieldRedemptionDate", None),
                        }

            self.ib.commissionReportEvent += on_commission_report
            try:
                fills = await self.ib.reqExecutionsAsync(ef)
                # TWS 在 execDetailsEnd 之后才发 commissionReport，给事件循环时间处理并合并到 fill
                await asyncio.sleep(3.0)
            finally:
                self.ib.commissionReportEvent -= on_commission_report

            out: List[Dict[str, Any]] = []
            seen_exec_ids: set = set()
            for fill in fills or []:
                if not isinstance(fill, Fill):
                    continue
                ex = getattr(fill, "execution", None)
                contract = getattr(fill, "contract", None)
                comm_report = getattr(fill, "commissionReport", None)
                fill_time = getattr(fill, "time", None) or (ex.time if ex else None)
                exec_id = ex.execId if ex else None
                if exec_id and exec_id in seen_exec_ids:
                    continue
                acct = ex.acctNumber if ex else None
                side_raw = ex.side if ex else None  # BOT / SLD
                side = self._exec_side_to_buy_sell(side_raw)
                shares = ex.shares if ex else None
                price = ex.price if ex else None
                commission = None
                realized_pnl = None
                comm_currency = None
                if comm_report is not None:
                    commission = getattr(comm_report, "commission", None)
                    realized_pnl = getattr(comm_report, "realizedPNL", None)
                    comm_currency = getattr(comm_report, "currency", None)
                # 若 Fill 上仍无 commission（历史请求时 report 可能未合并到同一对象），用事件里收集的
                if commission is None and exec_id and exec_id in commission_by_exec_id:
                    rec = commission_by_exec_id[exec_id]
                    commission = rec.get("commission")
                    realized_pnl = realized_pnl if realized_pnl is not None else rec.get("realizedPNL")
                    comm_currency = comm_currency or rec.get("currency")
                symbol = ""
                sec_type = ""
                expiry = ""
                strike = None
                option_right = ""
                exchange = ""
                currency = ""
                local_symbol = ""
                con_id = None
                if contract is not None:
                    symbol = getattr(contract, "symbol", "") or ""
                    sec_type = getattr(contract, "secType", "") or ""
                    exchange = getattr(contract, "exchange", "") or ""
                    currency = getattr(contract, "currency", "") or ""
                    local_symbol = getattr(contract, "localSymbol", "") or ""
                    con_id = getattr(contract, "conId", None)
                    if sec_type == "OPT":
                        expiry = getattr(contract, "lastTradeDateOrContractMonth", "") or ""
                        strike = getattr(contract, "strike", None)
                        option_right = getattr(contract, "right", "") or ""
                if ex and not exchange:
                    exchange = getattr(ex, "exchange", "") or ""
                ts = None
                if fill_time is not None:
                    try:
                        ts = fill_time.timestamp()
                    except Exception:
                        pass
                contract_key = self._contract_key(contract)
                raw_extra: Dict[str, Any] = {}
                if ex:
                    for attr in ("permId", "clientId", "orderId", "liquidation", "cumQty", "avgPrice", "orderRef", "evRule", "evMultiplier", "modelCode", "lastLiquidity"):
                        v = getattr(ex, attr, None)
                        if v is not None and v != "" and v != 0:
                            raw_extra[attr] = v
                if comm_report:
                    for attr in ("yield_", "yieldRedemptionDate"):
                        v = getattr(comm_report, attr, None)
                        if v is not None:
                            raw_extra[attr] = v
                yield_val = getattr(comm_report, "yield_", None) if comm_report else None
                yield_redemption = getattr(comm_report, "yieldRedemptionDate", None) if comm_report else None
                if contract and con_id is not None:
                    raw_extra["conId"] = con_id
                if local_symbol:
                    raw_extra["localSymbol"] = local_symbol
                out.append({
                    "exec_id": exec_id,
                    "time": ts,
                    "account_id": acct,
                    "symbol": symbol,
                    "sec_type": sec_type,
                    "side": side,
                    "quantity": float(shares) if shares is not None else None,
                    "price": float(price) if price is not None else None,
                    "commission": float(commission) if commission is not None else None,
                    "source": "daemon" if (ex and getattr(ex, "clientId", None) == self.client_id) else "manual",
                    "expiry": expiry or None,
                    "strike": float(strike) if strike is not None else None,
                    "option_right": option_right or None,
                    "exchange": exchange or None,
                    "currency": (comm_currency or currency or None),
                    "order_id": ex.orderId if ex else None,
                    "cum_qty": float(ex.cumQty) if ex and hasattr(ex, "cumQty") and ex.cumQty is not None else None,
                    "realized_pnl": float(realized_pnl) if realized_pnl is not None else None,
                    "contract_key": contract_key or None,
                    "raw_extra": raw_extra if raw_extra else None,
                    "yield_": float(yield_val) if yield_val is not None else None,
                    "yield_redemption_date": int(yield_redemption) if yield_redemption is not None else None,
                })
                if exec_id:
                    seen_exec_ids.add(exec_id)
            # 补全：TWS 可能在连接/同步时已下发 fills+commissionReport 到 wrapper.fills，但 reqExecutions 因时间过滤返回 0；把这些也纳入以便落库并更新 commission
            account_filter = (account or "").strip()
            for wfill in self.ib.fills():
                if not isinstance(wfill, Fill):
                    continue
                wex = getattr(wfill, "execution", None)
                if not wex:
                    continue
                weid = getattr(wex, "execId", None)
                if not weid or weid in seen_exec_ids:
                    continue
                wacct = getattr(wex, "acctNumber", None) or ""
                if account_filter and wacct != account_filter:
                    continue
                # 复用上面相同逻辑从 wfill 建一行（简化：只取关键字段，commission 从 fill.commissionReport 或 commission_by_exec_id）
                wcontract = getattr(wfill, "contract", None)
                wcomm = getattr(wfill, "commissionReport", None)
                wtime = getattr(wfill, "time", None) or (wex.time if wex else None)
                wcommission = getattr(wcomm, "commission", None) if wcomm else None
                wrealized = getattr(wcomm, "realizedPNL", None) if wcomm else None
                wcur = getattr(wcomm, "currency", None) if wcomm else None
                wyield_val = getattr(wcomm, "yield_", None) if wcomm else None
                wyield_redemption = getattr(wcomm, "yieldRedemptionDate", None) if wcomm else None
                if wcommission is None and weid in commission_by_exec_id:
                    rec = commission_by_exec_id[weid]
                    wcommission = rec.get("commission")
                    wrealized = wrealized if wrealized is not None else rec.get("realizedPNL")
                    wcur = wcur or rec.get("currency")
                    wyield_val = wyield_val if wyield_val is not None else rec.get("yield_")
                    wyield_redemption = wyield_redemption if wyield_redemption is not None else rec.get("yieldRedemptionDate")
                wsym = getattr(wcontract, "symbol", "") or "" if wcontract else ""
                wst = getattr(wcontract, "secType", "") or "" if wcontract else ""
                wexch = getattr(wcontract, "exchange", "") or "" if wcontract else ""
                wcurr = getattr(wcontract, "currency", "") or "" if wcontract else ""
                if wex and not wexch:
                    wexch = getattr(wex, "exchange", "") or ""
                wts = None
                if wtime is not None:
                    try:
                        wts = wtime.timestamp()
                    except Exception:
                        pass
                out.append({
                    "exec_id": weid,
                    "time": wts,
                    "account_id": wacct,
                    "symbol": wsym,
                    "sec_type": wst,
                    "side": self._exec_side_to_buy_sell(wex.side if wex else None),
                    "quantity": float(wex.shares) if wex and wex.shares is not None else None,
                    "price": float(wex.price) if wex and wex.price is not None else None,
                    "commission": float(wcommission) if wcommission is not None else None,
                    "source": "daemon" if (wex and getattr(wex, "clientId", None) == self.client_id) else "manual",
                    "expiry": getattr(wcontract, "lastTradeDateOrContractMonth", "") or None if wcontract else None,
                    "strike": float(getattr(wcontract, "strike", None)) if wcontract and getattr(wcontract, "strike", None) is not None else None,
                    "option_right": getattr(wcontract, "right", "") or None if wcontract else None,
                    "exchange": wexch or None,
                    "currency": (wcur or wcurr or None),
                    "order_id": wex.orderId if wex else None,
                    "cum_qty": float(wex.cumQty) if wex and getattr(wex, "cumQty", None) is not None else None,
                    "realized_pnl": float(wrealized) if wrealized is not None else None,
                    "contract_key": self._contract_key(wcontract) or None,
                    "raw_extra": None,
                    "yield_": float(wyield_val) if wyield_val is not None else None,
                    "yield_redemption_date": int(wyield_redemption) if wyield_redemption is not None else None,
                })
                seen_exec_ids.add(weid)
            # 二次补全 commission：sleep 后直接从 self.ib.fills() 建 exec_id->Fill 映射再补全（与 wrapper 解耦，避免 wrapper.fills 不可用或键不一致）
            n_second_pass = 0
            try:
                fills_by_id: Dict[str, Any] = {}
                for f in self.ib.fills():
                    ex = getattr(f, "execution", None)
                    if ex:
                        eid = getattr(ex, "execId", None)
                        if eid:
                            fills_by_id[eid] = f
                for row in out:
                    eid = row.get("exec_id")
                    if not eid or row.get("commission") is not None:
                        continue
                    wf = fills_by_id.get(eid)
                    cr = getattr(wf, "commissionReport", None) if wf else None
                    if not cr:
                        continue
                    c = getattr(cr, "commission", None)
                    rp = getattr(cr, "realizedPNL", None)
                    cu = getattr(cr, "currency", None)
                    y_ = getattr(cr, "yield_", None)
                    yr = getattr(cr, "yieldRedemptionDate", None)
                    if c is not None or rp is not None or cu is not None or y_ is not None or yr is not None:
                        row["commission"] = float(c) if c is not None else None
                        row["realized_pnl"] = float(rp) if rp is not None else None
                        row["currency"] = cu or row.get("currency") or None
                        row["yield_"] = float(y_) if y_ is not None else None
                        row["yield_redemption_date"] = int(yr) if yr is not None else None
                        n_second_pass += 1
            except Exception as _e:
                logger.warning("commission from ib.fills() second pass: %s", _e)
            if n_second_pass:
                logger.info("[R-A2] get_executions_async: second pass filled commission for %s rows", n_second_pass)
            n_with_commission = sum(1 for x in out if x.get("commission") is not None or x.get("realized_pnl") is not None)
            if n_with_commission:
                logger.info("[R-A2] get_executions_async: %s/%s fills with commission/realized_pnl", n_with_commission, len(out))
            logger.info("[R-A2] get_executions_async: got %s fills for account=%r", len(out), account)
            return out
        except Exception as e:
            logger.warning("get_executions_async: %s", e, exc_info=True)
            return []

    # R-A3: 复盘辅助行情 K 线。period 与 IB barSizeSetting 映射：'1 D' -> '1 day', '1 min' -> '1 min', '1 h' -> '1 hour'
    _BAR_SIZE_MAP = {
        "1 d": "1 day",
        "1 day": "1 day",
        "1 min": "1 min",
        "5 mins": "5 mins",
        "1 hour": "1 hour",
        "1 h": "1 hour",
    }

    async def get_historical_bars_async(
        self,
        symbol: str,
        period: str = "1 D",
        duration_str: str = "30 D",
    ) -> List[Dict[str, Any]]:
        """Request historical OHLC bars from IB (R-A3). Returns list of dicts: bar_time (Unix), open, high, low, close, volume."""
        if not self.is_connected:
            await self.connect()
        if not symbol or not symbol.strip():
            return []
        try:
            stock = self._stock(symbol.strip())
            await self.ib.qualifyContractsAsync(stock)
            bar_setting = self._BAR_SIZE_MAP.get((period or "1 D").strip().lower(), "1 day")
            # 日线用 useRTH=False 更易拿到数据；盘内分钟线可用 useRTH=True
            use_rth = bar_setting != "1 day"
            bars = await self.ib.reqHistoricalDataAsync(
                stock,
                endDateTime="",
                durationStr=duration_str or "30 D",
                barSizeSetting=bar_setting,
                whatToShow="TRADES",
                useRTH=use_rth,
                # formatDate=2 让 bar.date 直接是 datetime，方便转 Unix time
                formatDate=2,
            )
            out: List[Dict[str, Any]] = []
            for bar in bars or []:
                t = getattr(bar, "date", None)
                ts: Optional[float]
                if t is None:
                    ts = None
                elif hasattr(t, "timestamp"):
                    # datetime-like
                    ts = float(t.timestamp())
                else:
                    # 兼容字符串等情况（极端情况下 bar.date 仍可能是 str）
                    try:
                        from datetime import datetime

                        # IB formatDate=2 一般不会走到这里，但防御性处理
                        ts = datetime.fromisoformat(str(t)).timestamp()
                    except Exception:
                        ts = None
                if ts is None:
                    continue
                out.append({
                    "bar_time": ts,
                    "open": float(getattr(bar, "open", 0) or 0),
                    "high": float(getattr(bar, "high", 0) or 0),
                    "low": float(getattr(bar, "low", 0) or 0),
                    "close": float(getattr(bar, "close", 0) or 0),
                    "volume": float(getattr(bar, "volume", 0) or 0),
                })
            logger.info("[R-A3] get_historical_bars_async: %s %s → %s bars", symbol, period, len(out))
            return out
        except Exception as e:
            logger.warning("get_historical_bars_async: %s", e, exc_info=True)
            return []

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
