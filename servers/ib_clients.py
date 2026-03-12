"""Monitor-side IB clients for account- and market-related operations.

AccountIbClient / MarketIbClient are thin managers around IBConnector that:
- keep a long-lived connection per client_id (per process)
- expose high-level async methods for the status server
- track basic health info for UI (connected, last_error, timestamps)
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from typing import Any, Dict, List, Optional, Tuple

from src.connector.ib import IBConnector, IBConnectionDroppedError

logger = logging.getLogger(__name__)


class BaseMonitorIbClient:
    """Base class for monitor-side IB clients.

    One instance per (host, port, client_id) in the status server process.
    """

    def __init__(self, host: str, port: int, client_id: int, *, name: str) -> None:
        self.host = (host or "127.0.0.1").strip() or "127.0.0.1"
        self.port = int(port)
        self.client_id = int(client_id)
        self.name = name
        self._connector: Optional[IBConnector] = None
        self._lock: Optional[asyncio.Lock] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loop_ready = threading.Event()
        self._loop_guard = threading.Lock()
        self._loop_thread: Optional[threading.Thread] = None
        self._connected_state = False
        self.last_error: Optional[str] = None
        self.last_connected_at: Optional[float] = None
        self.last_disconnected_at: Optional[float] = None
        self._ensure_loop()

    @property
    def connector(self) -> Optional[IBConnector]:
        return self._connector

    @property
    def connected(self) -> bool:
        return self._connected_state

    def _ensure_loop(self) -> None:
        if self._loop is not None and self._loop.is_running():
            return
        with self._loop_guard:
            if self._loop is not None and self._loop.is_running():
                return
            self._loop_ready.clear()

            def _run_loop() -> None:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self._loop = loop
                self._lock = asyncio.Lock()
                self._loop_ready.set()
                try:
                    loop.run_forever()
                finally:
                    loop.close()

            self._loop_thread = threading.Thread(
                target=_run_loop,
                daemon=True,
                name=f"monitor-ib-{self.name}",
            )
            self._loop_thread.start()
        if not self._loop_ready.wait(timeout=2.0):
            raise RuntimeError(f"{self.name} IB loop failed to start within 2s")

    async def _run_on_client_loop(self, coro: Any) -> Any:
        self._ensure_loop()
        loop = self._loop
        if loop is None:
            raise RuntimeError(f"{self.name} loop not available")
        try:
            current_loop = asyncio.get_running_loop()
        except RuntimeError:  # pragma: no cover - defensive
            current_loop = None
        if current_loop is loop:
            return await coro
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return await asyncio.wrap_future(future)

    async def ensure_connected(self) -> None:
        """Ensure there is an active IB connection.

        Lazily creates IBConnector and connects. Subsequent calls are no-ops when already connected.
        """
        await self._run_on_client_loop(self._ensure_connected_impl())

    async def _ensure_connected_impl(self) -> None:
        if self.connected:
            return
        assert self._lock is not None
        async with self._lock:
            if self.connected:
                return
            logger.info(
                "[monitor_ib] connecting %s to %s:%s clientId=%s (will try +1, +2, ... if in use)",
                self.name,
                self.host,
                self.port,
                self.client_id,
            )
            self._connector = IBConnector(host=self.host, port=self.port, client_id=self.client_id)
            ok = await self._connector.connect(max_attempts=10)
            if not ok:
                self.last_error = "connect_failed"
                self._connected_state = False
                logger.error(
                    "[monitor_ib] %s connect_failed host=%s port=%s clientId=%s",
                    self.name,
                    self.host,
                    self.port,
                    self.client_id,
                )
                # Drop connector on failure so next call can retry cleanly.
                self._connector = None
                raise RuntimeError(f"{self.name} failed to connect to IB (see logs for details)")
            self.client_id = int(getattr(self._connector, "client_id", self.client_id))
            self.last_error = None
            self.last_connected_at = time.time()
            self._connected_state = True
            logger.info(
                "[monitor_ib] %s connected host=%s port=%s clientId=%s",
                self.name,
                self.host,
                self.port,
                self.client_id,
            )

    async def disconnect(self) -> None:
        """Disconnect from IB (if connected)."""
        await self._run_on_client_loop(self._disconnect_impl())

    async def _disconnect_impl(self) -> None:
        assert self._lock is not None
        async with self._lock:
            if not self._connector:
                self._connected_state = False
                return
            try:
                logger.info(
                    "[monitor_ib] disconnecting %s clientId=%s", self.name, self.client_id
                )
                await self._connector.disconnect()
                self.last_disconnected_at = time.time()
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning(
                    "[monitor_ib] %s disconnect error: %s", self.name, exc, exc_info=True
                )
            finally:
                self._connector = None
                self._connected_state = False

    async def set_commission_report_callback(self, callback: Any) -> None:
        await self._run_on_client_loop(self._set_commission_report_callback_impl(callback))

    async def _set_commission_report_callback_impl(self, callback: Any) -> None:
        if callback is not None:
            await self._ensure_connected_impl()
        if self._connector is not None:
            self._connector.set_commission_report_callback(callback)


class AccountIbClient(BaseMonitorIbClient):
    """Monitor-side account client: executions/trades and (optionally) account snapshots."""

    async def fetch_executions(self, days: int) -> List[Dict[str, Any]]:
        return await self._run_on_client_loop(self._fetch_executions_impl(days))

    async def _fetch_executions_impl(self, days: int) -> List[Dict[str, Any]]:
        """Fetch executions for all managed accounts over the last `days` days."""
        await self._ensure_connected_impl()
        assert self.connector is not None  # for type checkers
        try:
            account_ids = self.connector.get_managed_accounts()
            if not account_ids:
                account_ids = [""]
            all_execs: List[Dict[str, Any]] = []
            for acc in account_ids:
                exec_list = await self.connector.get_executions_async(
                    account=acc or None,
                    since_days=days,
                )
                if exec_list:
                    all_execs.extend(exec_list)
            logger.info(
                "[monitor_ib] AccountIbClient.fetch_executions: %s executions over %s days",
                len(all_execs),
                days,
            )
            self.last_error = None
            return all_execs
        except Exception as e:
            self.last_error = str(e)
            logger.warning(
                "[monitor_ib] AccountIbClient.fetch_executions failed: %s", e, exc_info=True
            )
            return []

    async def fetch_accounts_snapshot(self) -> List[Dict[str, Any]]:
        return await self._run_on_client_loop(self._fetch_accounts_snapshot_impl())

    async def _fetch_accounts_snapshot_impl(self) -> List[Dict[str, Any]]:
        """R-A1: 从 IB 拉取多账户摘要与持仓，返回与 postgres_sink 一致的 accounts_snapshot 列表形状。
        供监控端「刷新」按钮通过长连接 Account Client 立即拉取并写库。
        """
        await self._ensure_connected_impl()
        assert self.connector is not None
        try:
            account_ids = self.connector.get_managed_accounts()
            if not account_ids:
                logger.warning(
                    "[monitor_ib] AccountIbClient.fetch_accounts_snapshot: get_managed_accounts returned 0"
                )
                return []
            all_positions = await self.connector.get_positions(account=None)
            accounts_list: List[Dict[str, Any]] = []
            for account_id in account_ids:
                values = await self.connector.get_account_summary(account=account_id)
                summary: Dict[str, Any] = {}
                for v in values:
                    if getattr(v, "tag", None) and getattr(v, "value", None) is not None:
                        summary[v.tag] = v.value
                if account_id:
                    summary["account"] = account_id
                acct_positions = [
                    p for p in all_positions if getattr(p, "account", None) == account_id
                ]
                pos_dicts = [
                    self.connector.position_to_dict(p) for p in acct_positions
                ]
                accounts_list.append({
                    "account_id": account_id,
                    "summary": summary,
                    "positions": pos_dicts,
                })
            self.last_error = None
            logger.info(
                "[monitor_ib] AccountIbClient.fetch_accounts_snapshot: %s accounts",
                len(accounts_list),
            )
            return accounts_list
        except Exception as e:
            self.last_error = str(e)
            logger.warning(
                "[monitor_ib] AccountIbClient.fetch_accounts_snapshot failed: %s",
                e,
                exc_info=True,
            )
            return []


class MarketIbClient(BaseMonitorIbClient):
    """Monitor-side market client: historical bars and other market data."""

    # Simple in-memory time window cache to avoid frequent duplicate IB requests.
    def __init__(self, host: str, port: int, client_id: int, *, name: str, window_seconds: int = 120) -> None:
        super().__init__(host, port, client_id, name=name)
        self._window_seconds = int(window_seconds)
        self._last_fetch_meta: Dict[Tuple[str, str, str], float] = {}

    def mark_fetched(self, symbol: str, period: str, duration: str) -> None:
        key = (symbol.strip(), period.strip(), duration.strip())
        self._last_fetch_meta[key] = time.time()

    def recently_fetched(self, symbol: str, period: str, duration: str) -> bool:
        key = (symbol.strip(), period.strip(), duration.strip())
        ts = self._last_fetch_meta.get(key)
        if ts is None:
            return False
        return (time.time() - ts) < self._window_seconds

    async def fetch_bars(self, symbol: str, period: str, duration: str) -> List[Dict[str, Any]]:
        return await self._run_on_client_loop(self._fetch_bars_impl(symbol, period, duration))

    async def _fetch_bars_impl(self, symbol: str, period: str, duration: str) -> List[Dict[str, Any]]:
        """Fetch historical bars from IB for given symbol/period/duration."""
        await self._ensure_connected_impl()
        assert self.connector is not None  # for type checkers
        try:
            raw = await self.connector.get_historical_bars_async(
                symbol, period=period, duration_str=duration
            )
            self.mark_fetched(symbol, period, duration)
            self.last_error = None
            return raw
        except Exception as e:
            self.last_error = str(e)
            logger.warning(
                "[monitor_ib] MarketIbClient.fetch_bars failed: %s", e, exc_info=True
            )
            return []

    async def fetch_bars_range(
        self,
        symbol: str,
        period: str,
        *,
        start_ts: Optional[float] = None,
        end_ts: Optional[float] = None,
        interval_sec: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        return await self._run_on_client_loop(
            self._fetch_bars_range_impl(
                symbol,
                period,
                start_ts=start_ts,
                end_ts=end_ts,
                interval_sec=interval_sec,
            )
        )

    async def _fetch_bars_range_impl(
        self,
        symbol: str,
        period: str,
        *,
        start_ts: Optional[float] = None,
        end_ts: Optional[float] = None,
        interval_sec: Optional[float] = None,
    ) -> List[Dict[str, Any]]:
        """按时间范围分段拉取历史 K 线（供补全历史使用），复用当前 Market 连接的 client_id。"""
        await self._ensure_connected_impl()
        assert self.connector is not None
        try:
            raw = await self.connector.get_historical_bars_range(
                symbol=symbol,
                period=period,
                start_ts=start_ts,
                end_ts=end_ts,
                interval_sec=interval_sec,
            )
            self.last_error = None
            return raw
        except IBConnectionDroppedError as e:
            self.last_error = str(e)
            logger.warning(
                "[monitor_ib] MarketIbClient.fetch_bars_range connection dropped: %s",
                e,
                exc_info=True,
            )
            try:
                await self.disconnect()
            except Exception:
                pass
            raise
        except Exception as e:
            self.last_error = str(e)
            logger.warning(
                "[monitor_ib] MarketIbClient.fetch_bars_range failed: %s", e, exc_info=True
            )
            raise

