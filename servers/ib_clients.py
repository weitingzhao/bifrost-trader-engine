"""Monitor-side IB clients for account- and market-related operations.

AccountIbClient / MarketIbClient are thin managers around IBConnector that:
- keep a long-lived connection per client_id (per process)
- expose high-level async methods for the status server
- track basic health info for UI (connected, last_error, timestamps)
"""

from __future__ import annotations

import asyncio
import logging
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
        self._lock = asyncio.Lock()
        self.last_error: Optional[str] = None
        self.last_connected_at: Optional[float] = None
        self.last_disconnected_at: Optional[float] = None

    @property
    def connector(self) -> Optional[IBConnector]:
        return self._connector

    @property
    def connected(self) -> bool:
        c = self._connector
        return bool(c and c.is_connected)

    async def ensure_connected(self) -> None:
        """Ensure there is an active IB connection.

        Lazily creates IBConnector and connects. Subsequent calls are no-ops when already connected.
        """
        if self.connected:
            return
        async with self._lock:
            if self.connected:
                return
            logger.info(
                "[monitor_ib] connecting %s to %s:%s clientId=%s",
                self.name,
                self.host,
                self.port,
                self.client_id,
            )
            self._connector = IBConnector(host=self.host, port=self.port, client_id=self.client_id)
            ok = await self._connector.connect(max_attempts=3)
            if not ok:
                self.last_error = "connect_failed"
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
            self.last_error = None
            self.last_connected_at = time.time()
            logger.info(
                "[monitor_ib] %s connected host=%s port=%s clientId=%s",
                self.name,
                self.host,
                self.port,
                self.client_id,
            )

    async def disconnect(self) -> None:
        """Disconnect from IB (if connected)."""
        async with self._lock:
            if not self._connector:
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


class AccountIbClient(BaseMonitorIbClient):
    """Monitor-side account client: executions/trades and (optionally) account snapshots."""

    async def fetch_executions(self, days: int) -> List[Dict[str, Any]]:
        """Fetch executions for all managed accounts over the last `days` days."""
        await self.ensure_connected()
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
        """R-A1: 从 IB 拉取多账户摘要与持仓，返回与 postgres_sink 一致的 accounts_snapshot 列表形状。
        供监控端「刷新」按钮通过长连接 Account Client 立即拉取并写库。
        """
        await self.ensure_connected()
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
        """Fetch historical bars from IB for given symbol/period/duration."""
        await self.ensure_connected()
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
        """按时间范围分段拉取历史 K 线（供补全历史使用），复用当前 Market 连接的 client_id。"""
        await self.ensure_connected()
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

