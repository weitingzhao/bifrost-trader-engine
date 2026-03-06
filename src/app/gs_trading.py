"""Gamma Scalping strategy: connector -> state -> greeks -> scalper -> guard -> order."""

import asyncio
import logging
import math
import os
import signal
import time
from pathlib import Path
from typing import Any, Optional, Tuple

import yaml

from src.config.settings import (
    get_config_for_guards,
    get_hedge_config,
    get_state_space_config,
    get_structure_config,
    get_risk_config,
)
from src.connector.ib import IBConnector
from src.core.metrics import get_metrics
from src.core.state.classifier import StateClassifier
from src.core.state.composite import CompositeState
from src.core.state.snapshot import StateSnapshot, GreeksSnapshot
from src.core.state.enums import HedgeState, TradingState
from src.core.logging_utils import (
    log_composite_state,
    log_target_position,
    log_order_status,
)
from src.core.store import Store
from src.fsm.daemon_fsm import DaemonFSM, DaemonState
from src.execution.order_manager import OrderManager
from src.fsm.events import TargetPositionEvent, TradingEvent
from src.fsm.hedge_fsm import HedgeFSM
from src.fsm.trading_fsm import TradingFSM
from src.market.market_data import MarketData
from src.positions.portfolio import get_option_legs, get_stock_shares
from src.positions.position_book import PositionBook
from src.pricing.greeks import Greeks
from src.guards.execution_guard import ExecutionGuard
from src.sink import StatusSink
from src.sink.postgres_sink import PostgreSQLSink
from src.realtime.redis_quotes import create_from_config as create_redis_quotes
from src.strategy.gamma_scalper import gamma_scalper_intent
from src.strategy.hedge_gate import apply_hedge_gates

logger = logging.getLogger(__name__)


def read_config(config_path: Optional[str] = None) -> tuple[dict, str]:
    """Load YAML config with env overrides for IB. Returns (config, resolved_path)."""
    config_path = config_path or os.environ.get("BIFROST_CONFIG", "config/config.yaml")
    if not Path(config_path).exists():
        config_path = "config/config.yaml.example"
    config_path = str(Path(config_path).resolve())
    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f) or {}
    return config, config_path


class GsTrading:
    """Single-process event-driven gamma scalping strategy."""

    def __init__(self, config: dict, config_path: Optional[str] = None):
        # 1.Init Config
        self.config = config
        self._config_path = config_path

        # 1.a PostgreSQL sink early (so we can read last ib_client_id before connecting to IB)
        postgres_cfg = config.get("postgres", {}) or {}
        self._status_sink: Optional[StatusSink] = None
        if postgres_cfg or os.environ.get("PGHOST"):
            try:
                self._status_sink = PostgreSQLSink(config)
            except Exception as e:
                logger.warning("PostgreSQL sink init failed: %s", e)

        # 1.b IB Connector: host/port from DB (settings) when present, else config; client_id from DB last+1 or settings.ib_client_id_daemon or config
        ib_cfg = config.get("ib", {})
        config_client_id = int(ib_cfg.get("client_id") or 1)
        last_ib = None
        if self._status_sink and hasattr(self._status_sink, "get_last_ib_client_id"):
            last_ib = self._status_sink.get_last_ib_client_id()
        if self._status_sink and hasattr(self._status_sink, "get_ib_connection_config"):
            db_ib = self._status_sink.get_ib_connection_config()
            if db_ib and db_ib.get("client_id_daemon") is not None:
                config_client_id = int(db_ib["client_id_daemon"])
        client_id = (last_ib + 1) if last_ib is not None else config_client_id
        if last_ib is not None:
            logger.info(
                "IB client_id from DB last_ib_client_id=%s → using %s (avoid in-use after crash)",
                last_ib,
                client_id,
            )
        host = ib_cfg.get("host", "127.0.0.1")
        port = int(ib_cfg.get("port", 4001))
        if self._status_sink and hasattr(self._status_sink, "get_ib_connection_config"):
            db_ib = self._status_sink.get_ib_connection_config()
            if db_ib:
                host = db_ib.get("host", host)
                port = int(db_ib.get("port", port))
                logger.info(
                    "IB connection from DB: host=%s port=%s (port_type=%s)",
                    host,
                    port,
                    db_ib.get("port_type", ""),
                )
        self.connector = IBConnector(
            host=host,
            port=port,
            client_id=client_id,
            connect_timeout=ib_cfg.get("connect_timeout", 60.0),
        )
        listener_client_id = 2
        if self._status_sink and hasattr(self._status_sink, "get_ib_connection_config"):
            db_ib = self._status_sink.get_ib_connection_config()
            if db_ib:
                listener_client_id = int(db_ib.get("client_id_listener", 2))
        self.listener_connector = IBConnector(
            host=host,
            port=port,
            client_id=listener_client_id,
            connect_timeout=ib_cfg.get("connect_timeout", 60.0),
        )

        # 1.b Config sections (unified _*_cfg naming)
        self._structure_cfg = get_structure_config(config)
        self._risk_cfg = get_risk_config(config)
        self._greeks_cfg = config.get("greeks", {})

        # 1.c Active symbol is inferred from live positions; no fixed config symbol.
        self.symbol = ""
        self.paper_trade = self._risk_cfg.get("paper_trade", True)
        self.order_type = config.get("order", {}).get("order_type", "market")

        # 1.d Hedge Configuration
        self._hedge_cfg = get_hedge_config(config)
        self.guard = ExecutionGuard(
            cooldown_sec=self._hedge_cfg["cooldown_sec"],
            max_daily_hedge_count=self._hedge_cfg["max_daily_hedge_count"],
            max_position_shares=self._hedge_cfg["max_position_shares"],
            max_daily_loss_usd=self._hedge_cfg["max_daily_loss_usd"],
            max_net_delta_shares=self._hedge_cfg["max_net_delta_shares"],
            max_spread_pct=self._hedge_cfg["max_spread_pct"],
            min_price_move_pct=self._hedge_cfg["min_price_move_pct"],
            earnings_dates=self._hedge_cfg["earnings_dates"],
            blackout_days_before=self._hedge_cfg["blackout_days_before"],
            blackout_days_after=self._hedge_cfg["blackout_days_after"],
            trading_hours_only=self._hedge_cfg["trading_hours_only"],
        )

        # 1.e FSMs
        self._fsm_daemon = DaemonFSM()
        self._fsm_hedge = HedgeFSM(min_hedge_shares=self._hedge_cfg["min_hedge_shares"])
        self._fsm_trading = TradingFSM(
            config=get_config_for_guards(config),
            guard=self.guard,
            on_transition=None,
        )

        # 2. Object References
        self.store = Store()
        self._hedge_lock = asyncio.Lock()
        self._last_config_mtime: Optional[float] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._position_book = PositionBook(
            self.store,
            self.symbol,
            min_dte=self._structure_cfg.get("min_dte", 21),
            max_dte=self._structure_cfg.get("max_dte", 35),
            atm_band_pct=self._structure_cfg.get("atm_band_pct", 0.03),
        )
        self._market_data = MarketData(self.store)
        self._order_manager = OrderManager()
        # _status_sink already created in 1.a (for get_last_ib_client_id and Phase 1/2)
        # Phase 2: control via PostgreSQL daemon_control table when sink is postgres (RE-5: monitoring can run on another host)
        self._order_manager.set_hedge_fsm(self._fsm_hedge)
        self._metrics = get_metrics()

        # 3. Static Defaults (RE-7: IB retry when not connected)
        daemon_cfg = config.get("daemon") or {}
        self._heartbeat_interval = float(daemon_cfg.get("heartbeat_interval", 10.0))
        self._heartbeat_interval_from_db: Optional[float] = (
            None  # overrides when set via monitoring
        )
        # IB retry timing: actually uses _effective_heartbeat_interval() (retry at next heartbeat); kept for optional future use
        self._ib_retry_interval = float(daemon_cfg.get("ib_retry_interval_sec", 30.0))
        self._config_reload_interval = 30.0
        # R-A1: 账户/持仓拉取（监控与对冲）不需每心跳拉取；每小时拉一次即可
        self._accounts_refresh_interval_sec = 3600.0
        self._last_accounts_refresh_ts = 0.0
        self._last_positions_refresh_ts = (
            0.0  # 对冲用持仓也按同一间隔，避免每心跳请求 IB positions
        )
        # R-M6: 首次有持仓时全量 IB 拉价一次；之后心跳用 Redis（Event）更新，仅 Refresh 时再全量拉价
        self._instrument_prices_initialized = False
        # R-RM*: optional Redis real-time quotes (daemon is sole writer)
        self._redis_quotes = create_redis_quotes(config)
        if getattr(self, "_redis_quotes", None) and self._redis_quotes.available:
            logger.info(
                "Redis quotes: connected (Event ticker → quote:{symbol}, channel daemon:quotes)"
            )
        else:
            logger.info(
                "Redis quotes: disabled or unavailable (config redis.enabled and Redis server required for ticker→Redis)"
            )

    @staticmethod
    def _position_symbol_parts(item: Any) -> tuple[str, str]:
        """Extract (symbol, sec_type) from one position item."""
        contract = None
        if hasattr(item, "contract"):
            contract = item.contract
        elif isinstance(item, dict):
            contract = item.get("contract")
        if contract is None:
            return "", ""
        if isinstance(contract, dict):
            symbol = str(contract.get("symbol") or "").strip().upper()
            sec_type = str(contract.get("secType") or contract.get("sec_type") or "").strip().upper()
        else:
            symbol = str(getattr(contract, "symbol", "") or "").strip().upper()
            sec_type = str(getattr(contract, "secType", "") or "").strip().upper()
        return symbol, sec_type

    def _infer_active_symbol(self, positions: list[Any]) -> str:
        """Prefer option underlying symbol, then stock symbol, from current positions."""
        first_stock = ""
        for item in positions:
            symbol, sec_type = self._position_symbol_parts(item)
            if not symbol:
                continue
            if sec_type == "OPT":
                return symbol
            if not first_stock and sec_type == "STK":
                first_stock = symbol
        return first_stock

    def _set_active_symbol(self, symbol: Optional[str]) -> None:
        """Switch the strategy symbol when live positions change."""
        next_symbol = (symbol or "").strip().upper()
        if next_symbol == self.symbol:
            return
        prev_symbol = self.symbol
        self.symbol = next_symbol
        self._position_book.set_symbol(next_symbol)
        # Clear quote cache so we never reuse the previous symbol's market data.
        self.store.set_underlying_quote(None, None)
        self.store.set_underlying_price(None)
        if next_symbol:
            logger.info(
                "Active symbol updated from positions: %s -> %s",
                prev_symbol or "(none)",
                next_symbol,
            )
        elif prev_symbol:
            logger.info("Active symbol cleared (previous=%s)", prev_symbol)

    def _reload_config(self, config: dict) -> None:
        """Apply hot-reloadable config (IB host/port require restart)."""
        self.config = config

        self._structure_cfg = get_structure_config(config)
        self._hedge_cfg = get_hedge_config(config)
        self._greeks_cfg = config.get("greeks", self._greeks_cfg)
        self._risk_cfg = get_risk_config(config)
        if "paper_trade" in self._risk_cfg:
            self.paper_trade = self._risk_cfg["paper_trade"]
        self.order_type = config.get("order", {}).get("order_type", self.order_type)
        self.guard.update_config(
            cooldown_sec=self._hedge_cfg["cooldown_sec"],
            max_daily_hedge_count=self._hedge_cfg["max_daily_hedge_count"],
            max_position_shares=self._hedge_cfg["max_position_shares"],
            max_daily_loss_usd=self._hedge_cfg["max_daily_loss_usd"],
            max_net_delta_shares=self._hedge_cfg["max_net_delta_shares"],
            max_spread_pct=self._hedge_cfg["max_spread_pct"],
            min_price_move_pct=self._hedge_cfg["min_price_move_pct"],
            earnings_dates=self._hedge_cfg["earnings_dates"],
            blackout_days_before=self._hedge_cfg["blackout_days_before"],
            blackout_days_after=self._hedge_cfg["blackout_days_after"],
            trading_hours_only=self._hedge_cfg["trading_hours_only"],
        )
        # R-RM*: try to (re)create Redis quotes client on config reload (e.g. Redis was down at daemon start)
        if getattr(self, "_redis_quotes", None) is not None:
            try:
                self._redis_quotes.close()
            except Exception:
                pass
            self._redis_quotes = None
        self._redis_quotes = create_redis_quotes(config)

    async def _reload_config_loop(self) -> None:
        """Periodically check config file mtime and reload if changed."""
        if not self._config_path or not Path(self._config_path).exists():
            return
        while self._fsm_daemon.is_running():
            await asyncio.sleep(self._config_reload_interval)
            if not self._fsm_daemon.is_running():
                return
            try:
                mtime = Path(self._config_path).stat().st_mtime
                if (
                    self._last_config_mtime is not None
                    and mtime > self._last_config_mtime
                ):
                    config, _ = read_config(self._config_path)
                    self._reload_config(config)
                    self._last_config_mtime = mtime
                    logger.info("Config reloaded from %s", self._config_path)
                elif self._last_config_mtime is None:
                    self._last_config_mtime = mtime
            except Exception as e:
                logger.debug("Config reload check failed: %s", e)

    async def _refresh_accounts_data(self) -> None:
        """R-A1: fetch all managed accounts' summary + positions from IB; store for monitoring and set primary account for trading.
        IB managedAccounts is comma-separated; we get each account's summary and filter positions by account from one reqPositions.
        """
        if not self.connector.is_connected:
            return
        try:
            account_ids = self.connector.get_managed_accounts()
            if not account_ids:
                logger.warning(
                    "[R-A1] get_managed_accounts returned 0 accounts (IB may use comma-separated string)"
                )
                return
            logger.info("[R-A1] managed accounts: %s", account_ids)
            # Request all positions once, then filter by account (avoids N reqPositionsAsync and ensures same snapshot)
            all_positions = await self.connector.get_positions(account=None)
            accounts_list: list = []
            primary_id: Optional[str] = None
            primary_summary: Optional[dict] = None
            for account_id in account_ids:
                values = await self.connector.get_account_summary(account=account_id)
                summary = {}
                for v in values:
                    if (
                        getattr(v, "tag", None)
                        and getattr(v, "value", None) is not None
                    ):
                        summary[v.tag] = v.value
                if account_id:
                    summary["account"] = account_id
                # Filter positions for this account (Position.account matches account_id)
                acct_positions = [
                    p
                    for p in all_positions
                    if getattr(p, "account", None) == account_id
                ]
                pos_dicts = [self.connector.position_to_dict(p) for p in acct_positions]
                accounts_list.append(
                    {
                        "account_id": account_id,
                        "summary": summary,
                        "positions": pos_dicts,
                    }
                )
                if primary_id is None and account_id:
                    primary_id = account_id
                    primary_summary = summary if summary else None
            self.store.set_accounts_data(accounts_list)
            self.store.set_account_summary(primary_id, primary_summary)
            logger.info(
                "[R-A1] accounts_data count=%s (primary=%s)",
                len(accounts_list),
                primary_id,
            )
            # R-A2: 拉取账户执行/成交并写入 account_executions，供复盘与 GET /executions
            if self._status_sink and hasattr(self._status_sink, "write_account_executions"):
                try:
                    if hasattr(self._status_sink, "update_execution_commission"):
                        self.connector.set_commission_report_callback(
                            lambda eid, c, pnl, cur, y_, yrd: self._status_sink.update_execution_commission(
                                eid, c, pnl, cur, y_, yrd
                            )
                        )
                    for acc_id in account_ids:
                        exec_list = await self.connector.get_executions_async(account=acc_id)
                        if exec_list:
                            self._status_sink.write_account_executions(exec_list)
                except Exception as ex:
                    logger.debug("[R-A2] get_executions_async/write_account_executions: %s", ex)
                finally:
                    try:
                        self.connector.set_commission_report_callback(None)
                    except Exception:
                        pass
        except Exception as e:
            logger.warning("_refresh_accounts_data: %s", e, exc_info=True)

    async def _refresh_executions_only(self) -> None:
        """R-A2: 仅从 IB 拉取账户执行/成交并写入 account_executions，供复盘与风控 Tab 使用。
        与 _refresh_accounts_data 解耦：复盘 Tab 的刷新只做此事，不拉账户摘要与持仓。"""
        if not self.connector.is_connected:
            return
        if not self._status_sink or not hasattr(self._status_sink, "write_account_executions"):
            return
        try:
            account_ids = self.connector.get_managed_accounts()
            if not account_ids:
                return
            if hasattr(self._status_sink, "update_execution_commission"):
                self.connector.set_commission_report_callback(
                    lambda eid, c, pnl, cur, y_, yrd: self._status_sink.update_execution_commission(
                        eid, c, pnl, cur, y_, yrd
                    )
                )
            for acc_id in account_ids:
                exec_list = await self.connector.get_executions_async(account=acc_id)
                if exec_list:
                    self._status_sink.write_account_executions(exec_list)
            logger.info("[R-A2] _refresh_executions_only: synced executions for %s accounts", len(account_ids))
        except Exception as ex:
            logger.warning("[R-A2] _refresh_executions_only: %s", ex, exc_info=True)
        finally:
            try:
                self.connector.set_commission_report_callback(None)
            except Exception:
                pass

    async def _refresh_positions(self) -> None:
        """Fetch positions from IB and update store (raw positions + stock_shares only). No option parse. R-A1: use account_id when available."""
        account = self.store.get_account_id()
        positions = await self.connector.get_positions(account=account)
        self._set_active_symbol(self._infer_active_symbol(positions))
        stock_shares = get_stock_shares(positions, self.symbol) if self.symbol else 0
        self.store.set_positions(positions, stock_shares)

    def _build_snapshot(
        self,
        cs: CompositeState,
        spot: Optional[float],
        greeks: Optional[Any],
        option_legs_count: int = 0,
    ) -> StateSnapshot:
        """Build StateSnapshot from CompositeState for TradingFSM."""
        gs = None
        if greeks is not None:
            gs = GreeksSnapshot(
                delta=getattr(greeks, "delta", 0.0),
                gamma=getattr(greeks, "gamma", 0.0),
                valid=getattr(greeks, "valid", False),
            )
        return StateSnapshot.from_composite_state(
            cs,
            spot=spot,
            greeks_snapshot=gs,
            option_legs_count=option_legs_count,
        )

    def _build_snapshot_dict(
        self,
        snapshot: StateSnapshot,
        spot: float,
        cs: CompositeState,
        data_lag_ms: Optional[float],
    ) -> dict:
        """Build dict for StatusSink (status_current / status_history). Keys per docs/DATABASE.md §2.1. R-A1: optional account_* keys when available."""
        d = {
            "daemon_state": self._fsm_daemon.current.value,
            "trading_state": self._fsm_trading.state.value,
            "symbol": self.symbol or None,
            "spot": float(spot),
            "bid": self.store.get_bid(),
            "ask": self.store.get_ask(),
            "net_delta": float(cs.net_delta),
            "stock_position": int(cs.stock_pos),
            "option_legs_count": int(getattr(snapshot, "option_legs_count", 0)),
            "daily_hedge_count": self.store.get_daily_hedge_count(),
            "daily_pnl": float(self.store.get_daily_pnl()),
            "data_lag_ms": float(data_lag_ms) if data_lag_ms is not None else None,
            "config_summary": f"paper_trade={self.paper_trade}",
            "ts": time.time(),
        }
        # R-A1 optional: account summary
        acc = self.store.get_account_summary()
        if acc:
            d["account_id"] = self.store.get_account_id()
            try:
                d["account_net_liquidation"] = (
                    float(acc.get("NetLiquidation"))
                    if acc.get("NetLiquidation")
                    else None
                )
            except (TypeError, ValueError):
                d["account_net_liquidation"] = None
            try:
                d["account_total_cash"] = (
                    float(acc.get("TotalCashValue"))
                    if acc.get("TotalCashValue")
                    else None
                )
            except (TypeError, ValueError):
                d["account_total_cash"] = None
            try:
                d["account_buying_power"] = (
                    float(acc.get("BuyingPower")) if acc.get("BuyingPower") else None
                )
            except (TypeError, ValueError):
                d["account_buying_power"] = None
        else:
            d["account_id"] = None
            d["account_net_liquidation"] = None
            d["account_total_cash"] = None
            d["account_buying_power"] = None
        # R-A1 multi-account: full list for monitoring (same level as 守护/对冲)
        accounts_data = self.store.get_accounts_data()
        d["accounts_snapshot"] = accounts_data if accounts_data else None
        if accounts_data:
            logger.debug(
                "[R-A1] _build_snapshot_dict accounts_snapshot len=%s",
                len(accounts_data),
            )
        return d

    def _build_heartbeat_minimal_dict(self) -> dict:
        """Minimal snapshot dict when spot is unavailable (e.g. outside market hours). Ensures status_current always has a row while daemon is running. R-A1: include account_* when available."""
        d = {
            "daemon_state": self._fsm_daemon.current.value,
            "trading_state": self._fsm_trading.state.value,
            "symbol": self.symbol or None,
            "spot": None,
            "bid": self.store.get_bid(),
            "ask": self.store.get_ask(),
            "net_delta": None,
            "stock_position": self.store.get_stock_position() or None,
            "option_legs_count": 0,
            "daily_hedge_count": self.store.get_daily_hedge_count(),
            "daily_pnl": (
                self.store.get_daily_pnl()
                if self.store.get_daily_pnl() is not None
                else None
            ),
            "data_lag_ms": None,
            "config_summary": f"paper_trade={self.paper_trade}",
            "ts": time.time(),
        }
        acc = self.store.get_account_summary()
        if acc:
            d["account_id"] = self.store.get_account_id()
            try:
                d["account_net_liquidation"] = (
                    float(acc.get("NetLiquidation"))
                    if acc.get("NetLiquidation")
                    else None
                )
            except (TypeError, ValueError):
                d["account_net_liquidation"] = None
            try:
                d["account_total_cash"] = (
                    float(acc.get("TotalCashValue"))
                    if acc.get("TotalCashValue")
                    else None
                )
            except (TypeError, ValueError):
                d["account_total_cash"] = None
            try:
                d["account_buying_power"] = (
                    float(acc.get("BuyingPower")) if acc.get("BuyingPower") else None
                )
            except (TypeError, ValueError):
                d["account_buying_power"] = None
        else:
            d["account_id"] = None
            d["account_net_liquidation"] = None
            d["account_total_cash"] = None
            d["account_buying_power"] = None
        accounts_data = self.store.get_accounts_data()
        d["accounts_snapshot"] = accounts_data if accounts_data else None
        return d

    async def _refresh_and_build_snapshot(
        self,
    ) -> Optional[Tuple[StateSnapshot, float, CompositeState, Optional[float]]]:
        """
        Refresh positions and spot, parse legs, greeks, classify, build snapshot.
        Returns (snapshot, spot, cs, data_lag_ms) or None if no valid spot.
        Shared by _handle_connected (bootstrap) and _eval_hedge (tick).
        Positions 与账户一样按 1 小时间隔拉取，避免每心跳请求 IB。
        """
        now_ts = time.time()
        if (
            now_ts - self._last_positions_refresh_ts
            >= self._accounts_refresh_interval_sec
        ):
            await self._refresh_positions()
            self._last_positions_refresh_ts = now_ts
        if not self.symbol:
            logger.debug("No active symbol in current positions, skip hedge evaluation")
            return None
        # 1.b. Get stock shares and spot price
        stock_shares = self.store.get_stock_position()
        spot = self.store.get_underlying_price()
        if spot is None or spot <= 0:
            spot = await self.connector.get_underlying_price(self.symbol)
            if spot is not None and spot > 0:
                self.store.set_underlying_price(spot)
        if spot is None or spot <= 0:
            return None
        # 1.c. Get option legs
        positions = self.store.get_positions()
        min_dte = self._structure_cfg.get("min_dte", 21)
        max_dte = self._structure_cfg.get("max_dte", 35)
        atm_band = self._structure_cfg.get("atm_band_pct", 0.03)
        legs = get_option_legs(
            positions,
            self.symbol,
            min_dte=min_dte,
            max_dte=max_dte,
            atm_band_pct=atm_band,
            spot=spot,
        )
        # 1.d. Get greeks
        r = self._greeks_cfg.get("risk_free_rate", 0.05)
        vol = self._greeks_cfg.get("volatility", 0.35)
        greeks = Greeks(legs, stock_shares, spot, r, vol)

        # 2.a. Build data lag
        data_lag_ms: Optional[float] = None
        if self._market_data.last_ts is not None:
            data_lag_ms = (time.time() - self._market_data.last_ts) * 1000.0

        # 2.b. Build Classify
        state_space_cfg = get_state_space_config(self.config)
        risk_halt = getattr(self.guard, "_circuit_breaker", False)
        cs = StateClassifier.classify(
            self._position_book,
            self._market_data,
            greeks,
            self._order_manager,
            last_hedge_price=self.store.get_last_hedge_price(),
            last_hedge_ts=self.store.get_last_hedge_time(),
            data_lag_ms=data_lag_ms,
            risk_halt=risk_halt,
            config=state_space_cfg,
        )
        # 2.c. Build snapshot
        snapshot = self._build_snapshot(cs, spot, greeks, option_legs_count=len(legs))

        # 3. Return snapshot, spot, cs, data_lag_ms
        return (snapshot, spot, cs, data_lag_ms)

    def _on_ticker(self, ticker: Any) -> None:
        """Called on each ticker update from IB (may be from IB thread). Delegates to _on_ticker_for_symbol."""
        self._on_ticker_for_symbol(self.symbol, ticker)

    def _on_ticker_for_symbol(self, symbol: str, ticker: Any) -> None:
        """Called on each ticker update from IB for a symbol (may be from IB thread).
        For strategy symbol: update store, write Redis, trigger hedge eval.
        For other symbols (Watchlist STK): write Redis only."""
        try:
            if symbol == self.symbol:
                self._market_data.touch_ts()
                bid = getattr(ticker, "bid", None)
                ask = getattr(ticker, "ask", None)
                if bid is not None and ask is not None:
                    try:
                        b, a = float(bid), float(ask)
                        if math.isfinite(b) and math.isfinite(a):
                            self.store.set_underlying_quote(b, a)
                    except (TypeError, ValueError):
                        pass
                else:
                    last = getattr(ticker, "last", None)
                    if last is not None:
                        try:
                            L = float(last)
                            if math.isfinite(L):
                                self.store.set_underlying_price(L)
                        except (TypeError, ValueError):
                            pass
            # R-RM*: write quote to Redis and publish (daemon sole writer; failures do not affect hedge)
            if getattr(self, "_redis_quotes", None) and self._redis_quotes.available:
                try:
                    payload = (
                        self._quote_payload()
                        if symbol == self.symbol
                        else self._quote_payload_from_ticker(symbol, ticker)
                    )
                    if payload:
                        self._redis_quotes.set_quote(symbol, payload)
                        self._redis_quotes.publish_update(symbol, {"symbol": symbol, "ts": payload.get("ts")})
                except Exception as e:
                    logger.warning("Redis quote write/publish in _on_ticker_for_symbol: %s", e)
            if symbol == self.symbol:
                self._eval_hedge_threadsafe()
        except Exception as e:
            logger.debug("ticker callback error for %s: %s", symbol, e)

    def _quote_payload_from_ticker(self, symbol: str, ticker: Any) -> Optional[dict]:
        """Build quote dict for Redis from ticker (symbol, bid, ask, last, ts). Used for non-strategy symbols.
        Returns None if price is NaN, inf, or empty — such events are discarded and not written to Redis."""
        bid = getattr(ticker, "bid", None)
        ask = getattr(ticker, "ask", None)
        last = getattr(ticker, "last", None)
        try:
            bid = float(bid) if bid is not None else None
            ask = float(ask) if ask is not None else None
            last = float(last) if last is not None else None
        except (TypeError, ValueError):
            bid = ask = last = None
        if bid is not None and not math.isfinite(bid):
            bid = None
        if ask is not None and not math.isfinite(ask):
            ask = None
        if last is not None and not math.isfinite(last):
            last = None
        if last is None and (bid is None or ask is None):
            return None
        if last is None and bid is not None and ask is not None:
            last = (float(bid) + float(ask)) / 2.0
        if last is None or not math.isfinite(last):
            return None
        return {
            "symbol": symbol,
            "bid": bid,
            "ask": ask,
            "last": last,
            "ts": time.time(),
        }

    def _quote_payload(self) -> Optional[dict]:
        """Build quote dict for Redis from store (symbol, bid, ask, last, ts). Returns None if price is NaN/inf/empty."""
        if not self.symbol:
            return None
        bid = self.store.get_bid()
        ask = self.store.get_ask()
        last = self.store.get_underlying_price()
        if last is None and bid is not None and ask is not None:
            try:
                last = (float(bid) + float(ask)) / 2.0
            except (TypeError, ValueError):
                last = None
        if last is None:
            return None
        try:
            last_f = float(last)
            if not math.isfinite(last_f):
                return None
        except (TypeError, ValueError):
            return None
        bid_f = float(bid) if bid is not None else None
        ask_f = float(ask) if ask is not None else None
        if bid_f is not None and not math.isfinite(bid_f):
            bid_f = None
        if ask_f is not None and not math.isfinite(ask_f):
            ask_f = None
        return {
            "symbol": self.symbol,
            "bid": bid_f,
            "ask": ask_f,
            "last": last_f,
            "ts": time.time(),
        }

    def _eval_hedge_threadsafe(self) -> None:
        """Threadsafe: schedule _on_tick to be run safely from any thread using call_soon_threadsafe."""
        if self._fsm_daemon.is_running() and self._loop and self._loop.is_running():
            self._loop.call_soon_threadsafe(
                lambda: asyncio.ensure_future(self._eval_hedge_sync(), loop=self._loop)
            )

    async def _eval_hedge_sync(self) -> None:
        """Run FSM-driven tick once (under lock)."""
        async with self._hedge_lock:
            await self._eval_hedge()

    async def _eval_hedge(self) -> None:
        """FSM-driven tick: refresh + snapshot -> TradingFSM (TICK) -> maybe _hedge. Skips hedge when daemon_run_status.suspended (monitoring-set)."""
        if self._poll_run_status()[0]:
            logger.debug("Trading suspended (daemon_run_status), skip hedge")
            return
        result = await self._refresh_and_build_snapshot()
        if result is None:
            logger.debug("No spot price, skip hedge")
            return
        snapshot, spot, cs, data_lag_ms = result
        log_composite_state(cs=cs)
        self._metrics.set_data_lag_ms(data_lag_ms)
        self._metrics.set_delta_abs(abs(cs.net_delta))
        self._metrics.set_spread_bucket(cs.L.value if cs.L else None)

        self._fsm_trading.apply_transition(TradingEvent.TICK, snapshot)
        if self._fsm_trading.state != TradingState.NEED_HEDGE:
            return

        stock_shares = self.store.get_stock_position()
        intent = gamma_scalper_intent(
            cs.net_delta,
            stock_shares,
            threshold_hedge_shares=self._hedge_cfg["threshold_hedge_shares"],
            max_hedge_shares_per_order=self._hedge_cfg["max_hedge_shares_per_order"],
            config=self._hedge_cfg,
        )
        if intent is None:
            logger.debug("No hedge intent (delta within threshold)")
            return
        approved = apply_hedge_gates(
            intent,
            cs,
            self.guard,
            now_ts=time.time(),
            spot=spot,
            last_hedge_price=self.store.get_last_hedge_price(),
            spread_pct=self.store.get_spread_pct(),
            min_hedge_shares=self._hedge_cfg["min_hedge_shares"],
        )
        if approved is None:
            logger.info(
                "Hedge blocked by gates (delta=%.1f would %s %s)",
                cs.net_delta,
                intent.side,
                intent.quantity,
            )
            return
        if not self._fsm_hedge.can_place_order():
            logger.warning(
                "Execution not IDLE (E=%s), skip order",
                self._order_manager.effective_e_state().value,
            )
            return
        log_target_position(target_shares=intent.target_shares, cs=cs)

        # 3.c. Status sink: hedge_intent operation (and optional history row)
        if self._status_sink:
            self._status_sink.write_operation(
                {
                    "ts": time.time(),
                    "type": "hedge_intent",
                    "side": approved.side,
                    "quantity": approved.quantity,
                    "price": spot,
                    "state_reason": cs.D.value if cs.D else None,
                }
            )
            snap_dict = self._build_snapshot_dict(snapshot, spot, cs, data_lag_ms)
            self._status_sink.write_snapshot(snap_dict, append_history=True)

        # 3.d. FSM apply transition to target emitted and start hedge
        self._fsm_trading.apply_transition(TradingEvent.TARGET_EMITTED, snapshot)
        await self._hedge(approved, cs, spot, snapshot)

    async def _hedge(
        self,
        intent: Any,
        cs: CompositeState,
        spot: float,
        snapshot: StateSnapshot,
    ) -> None:
        """Run HedgeFSM flow and place order; fire HEDGE_DONE or HEDGE_FAILED on TradingFSM."""
        now_ts = time.time()
        target_ev = TargetPositionEvent(
            target_shares=intent.target_shares,
            reason="delta_hedge",
            ts=now_ts,
            trace_id=None,
            side=intent.side,
            quantity=intent.quantity,
        )
        self._fsm_hedge.on_target(target_ev, cs.stock_pos)
        self._fsm_hedge.on_plan_decide(
            send_order=intent.quantity >= self._hedge_cfg["min_hedge_shares"]
        )
        if self._fsm_hedge.state != HedgeState.SEND:
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_DONE, snapshot)
            return

        def _write_op(op_type: str, state_reason: Optional[str] = None) -> None:
            if self._status_sink:
                self._status_sink.write_operation(
                    {
                        "ts": time.time(),
                        "type": op_type,
                        "side": intent.side,
                        "quantity": intent.quantity,
                        "price": spot,
                        "state_reason": state_reason or (cs.D.value if cs.D else None),
                    }
                )

        if self.paper_trade:
            _write_op("order_sent")
            log_order_status(
                order_status="paper_send", side=intent.side, quantity=intent.quantity
            )
            logger.info(
                "PAPER: would %s %s shares (delta=%.1f)",
                intent.side,
                intent.quantity,
                cs.net_delta,
            )
            self._fsm_hedge.on_order_placed()
            self._fsm_hedge.on_ack_ok()
            self.guard.record_hedge_sent()
            self.store.set_last_hedge_time(now_ts)
            self.store.set_last_hedge_price(spot)
            self.store.inc_daily_hedge_count()
            self._metrics.inc_hedge_count()
            self._fsm_hedge.on_full_fill()
            _write_op("fill")
            if self._status_sink:
                snap_dict = self._build_snapshot_dict(
                    snapshot, spot, cs, snapshot.data_lag_ms
                )
                self._status_sink.write_snapshot(snap_dict, append_history=True)
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_DONE, snapshot)
            return
        self._fsm_hedge.on_order_placed()
        _write_op("order_sent")
        log_order_status(
            order_status="sent", side=intent.side, quantity=intent.quantity
        )
        trade = await self.connector.place_order(
            self.symbol,
            intent.side,
            intent.quantity,
            order_type=self.order_type,
        )
        if trade is not None:
            self._fsm_hedge.on_ack_ok()
            self.guard.record_hedge_sent()
            self.store.set_last_hedge_time(now_ts)
            self.store.set_last_hedge_price(spot)
            self.store.inc_daily_hedge_count()
            self._metrics.inc_hedge_count()
            logger.info(
                "Hedge sent: %s %s %s", intent.side, intent.quantity, self.symbol
            )
            self._fsm_hedge.on_full_fill()
            _write_op("fill")
            if self._status_sink:
                snap_dict = self._build_snapshot_dict(
                    snapshot, spot, cs, snapshot.data_lag_ms
                )
                self._status_sink.write_snapshot(snap_dict, append_history=True)
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_DONE, snapshot)
        else:
            _write_op("reject", "order_failed")
            if self._status_sink:
                snap_dict = self._build_snapshot_dict(
                    snapshot, spot, cs, snapshot.data_lag_ms
                )
                self._status_sink.write_snapshot(snap_dict, append_history=True)
            logger.warning("Order failed (trade is None)")
            self._fsm_hedge.on_ack_reject()
            self._fsm_hedge.on_try_resync()
            self._fsm_hedge.on_positions_resynced()
            self._fsm_trading.apply_transition(TradingEvent.HEDGE_FAILED, snapshot)

    def _poll_control(self) -> Optional[str]:
        """Poll control command from sink (PostgreSQL daemon_control table when sink is postgres). Return stop/flatten or None."""
        if self._status_sink is None:
            return None
        if hasattr(self._status_sink, "poll_and_consume_control"):
            return self._status_sink.poll_and_consume_control()
        return None

    def _poll_run_status(self) -> tuple[bool, Optional[float]]:
        """Poll daemon_run_status from sink (suspended, heartbeat_interval_sec). interval None => use config default."""
        if self._status_sink is None:
            return False, None
        if hasattr(self._status_sink, "poll_run_status"):
            return self._status_sink.poll_run_status()
        return False, None

    def _effective_heartbeat_interval(self) -> float:
        """Heartbeat interval in seconds (from DB if set via monitoring, else config); clamped to [5, 120]."""
        raw = (
            self._heartbeat_interval_from_db
            if self._heartbeat_interval_from_db is not None
            else self._heartbeat_interval
        )
        return max(5.0, min(120.0, float(raw)))

    def _redis_quotes_connected(self) -> bool:
        """Whether daemon is connected to Redis and writing real-time quotes (for status/monitoring)."""
        return bool(
            getattr(self, "_redis_quotes", None)
            and getattr(self._redis_quotes, "available", False)
        )

    def _event_subscribe_flags(self) -> dict:
        """IB event subscription status for System page: ticker, positions, fills, commission."""
        connected = self.connector.is_connected
        running = self._fsm_daemon.is_running()
        return {
            "event_subscribe_ticker": running and connected,
            "event_subscribe_positions": running and connected,
            "event_subscribe_fills": False,  # connector supports it but daemon does not subscribe yet
            "event_subscribe_commission": connected,
        }

    def _listener_heartbeat_kwargs(self) -> dict:
        """Listener connection status for daemon_heartbeat (second IB client_id so TWS shows it)."""
        listener = getattr(self, "listener_connector", None)
        return {
            "listener_connected": bool(listener and listener.is_connected),
            "listener_client_id": getattr(listener, "client_id", None) if listener else None,
        }

    def _apply_run_status_transition(self) -> bool:
        """Sync Daemon FSM with daemon_run_status: RUNNING <-> RUNNING_SUSPENDED. Returns True if suspended (skip hedge)."""
        suspended, interval = self._poll_run_status()
        self._heartbeat_interval_from_db = interval
        cur = self._fsm_daemon.current
        if suspended and cur == DaemonState.RUNNING:
            self._fsm_daemon.transition(DaemonState.RUNNING_SUSPENDED)
            logger.info(
                "[Daemon] state=RUNNING → RUNNING_SUSPENDED (daemon_run_status.suspended=true)"
            )
        elif not suspended and cur == DaemonState.RUNNING_SUSPENDED:
            self._fsm_daemon.transition(DaemonState.RUNNING)
            logger.info(
                "[Daemon] state=RUNNING_SUSPENDED → RUNNING (daemon_run_status.suspended=false)"
            )
        return suspended

    async def _heartbeat(self) -> None:
        """Periodic heartbeat to run maybe_hedge even without tick updates; write status snapshot if sink configured. FSM RUNNING <-> RUNNING_SUSPENDED per daemon_run_status."""
        while self._fsm_daemon.is_running():
            # Phase 2: poll control from DB first (so we react quickly to stop already in table)
            cmd = self._poll_control()
            if cmd == "stop":
                logger.info("[Daemon] control (db): stop → requesting stop")
                self._fsm_daemon.request_stop()
                return
            if cmd == "flatten":
                logger.warning("[Daemon] control (db): flatten (not implemented yet)")
            if cmd == "release_ib" and self.connector.is_connected:
                now_t = time.time()
                interval = self._effective_heartbeat_interval()
                next_retry_ts = now_t + interval
                sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
                if self._status_sink and hasattr(
                    self._status_sink, "write_daemon_heartbeat"
                ):
                    self._status_sink.write_daemon_heartbeat(
                        hedge_running=True,
                        ib_connected=False,
                        ib_client_id=None,
                        next_retry_ts=next_retry_ts,
                        seconds_until_retry=sec_until,
                        redis_quotes_connected=self._redis_quotes_connected(),
                        **self._event_subscribe_flags(),
                        **self._listener_heartbeat_kwargs(),
                    )
                logger.info(
                    "[Daemon] state=%s | control release_ib → releasing IB on next heartbeat",
                    self._fsm_daemon.current.value,
                )
                self._ib_disconnected_during_run = True
                # Main run loop will see flag within 1s and transition to WAITING_IB; do not return (keeps daemon running)
            if (
                cmd == "refresh_accounts"
                and self.connector.is_connected
                and self._status_sink
            ):
                logger.info(
                    "[Daemon] control (db): refresh_accounts → fetching from IB and syncing to DB"
                )
                await self._refresh_accounts_data()
                self._last_accounts_refresh_ts = time.time()
                minimal = self._build_heartbeat_minimal_dict()
                self._status_sink.write_snapshot(minimal, append_history=False)
                await self._refresh_position_prices()
                self._instrument_prices_initialized = True
            if (
                cmd == "refresh_replay"
                and self.connector.is_connected
                and self._status_sink
            ):
                logger.info(
                    "[Daemon] control (db): refresh_replay → syncing executions from IB for 复盘"
                )
                await self._refresh_executions_only()
            if (
                cmd == "refresh_ticker_subscriptions"
                and self.connector.is_connected
            ):
                logger.info(
                    "[Daemon] control (db): refresh_ticker_subscriptions → syncing Real-time ticker with Watchlist"
                )
                await self._refresh_ticker_subscriptions()
            suspended = self._apply_run_status_transition()
            interval_sec = self._effective_heartbeat_interval()
            state_label = self._fsm_daemon.current.value
            if suspended:
                logger.info(
                    "[Daemon] state=%s | heartbeat: sleep %.0fs, skip maybe_hedge (suspended)",
                    state_label,
                    interval_sec,
                )
            else:
                logger.info(
                    "[Daemon] state=%s | heartbeat: sleep %.0fs, then maybe_hedge",
                    state_label,
                    interval_sec,
                )
            await asyncio.sleep(interval_sec)
            if not self._fsm_daemon.is_running():
                return
            cmd = self._poll_control()
            if cmd == "stop":
                logger.info("[Daemon] control (db): stop → requesting stop")
                self._fsm_daemon.request_stop()
                return
            if cmd == "flatten":
                logger.warning("[Daemon] control (db): flatten (not implemented yet)")
            if cmd == "release_ib" and self.connector.is_connected:
                now_t = time.time()
                interval = self._effective_heartbeat_interval()
                next_retry_ts = now_t + interval
                sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
                if self._status_sink and hasattr(
                    self._status_sink, "write_daemon_heartbeat"
                ):
                    self._status_sink.write_daemon_heartbeat(
                        hedge_running=True,
                        ib_connected=False,
                        ib_client_id=None,
                        next_retry_ts=next_retry_ts,
                        seconds_until_retry=sec_until,
                        redis_quotes_connected=self._redis_quotes_connected(),
                        **self._event_subscribe_flags(),
                        **self._listener_heartbeat_kwargs(),
                    )
                logger.info(
                    "[Daemon] state=%s | control release_ib → releasing IB on next heartbeat",
                    self._fsm_daemon.current.value,
                )
                self._ib_disconnected_during_run = True
                # Main run loop will see flag within 1s and transition to WAITING_IB; do not return (keeps daemon running)
            if (
                cmd == "refresh_accounts"
                and self.connector.is_connected
                and self._status_sink
            ):
                logger.info(
                    "[Daemon] control (db): refresh_accounts → fetching from IB and syncing to DB"
                )
                await self._refresh_accounts_data()
                self._last_accounts_refresh_ts = time.time()
                minimal = self._build_heartbeat_minimal_dict()
                self._status_sink.write_snapshot(minimal, append_history=False)
                await self._refresh_position_prices()
                self._instrument_prices_initialized = True
            if (
                cmd == "refresh_replay"
                and self.connector.is_connected
                and self._status_sink
            ):
                logger.info(
                    "[Daemon] control (db): refresh_replay → syncing executions from IB for 复盘"
                )
                await self._refresh_executions_only()
            if (
                cmd == "refresh_ticker_subscriptions"
                and self.connector.is_connected
            ):
                logger.info(
                    "[Daemon] control (db): refresh_ticker_subscriptions → syncing Real-time ticker with Watchlist"
                )
                await self._refresh_ticker_subscriptions()
            suspended = self._apply_run_status_transition()
            # Detect IB disconnect during RUNNING/RUNNING_SUSPENDED: write DB then transition to WAITING_IB (RE-7)
            if not self.connector.is_connected:
                now_t = time.time()
                interval = self._effective_heartbeat_interval()
                next_retry_ts = now_t + interval
                sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
                if self._status_sink and hasattr(
                    self._status_sink, "write_daemon_heartbeat"
                ):
                    self._status_sink.write_daemon_heartbeat(
                        hedge_running=True,
                        ib_connected=False,
                        ib_client_id=None,
                        next_retry_ts=next_retry_ts,
                        seconds_until_retry=sec_until,
                        redis_quotes_connected=self._redis_quotes_connected(),
                        **self._event_subscribe_flags(),
                        **self._listener_heartbeat_kwargs(),
                    )
                logger.warning(
                    "[Daemon] state=%s | IB disconnected → WAITING_IB (DB updated, will retry)",
                    self._fsm_daemon.current.value,
                )
                self._ib_disconnected_during_run = True
                return
            now_ts = time.time()
            if (
                now_ts - self._last_accounts_refresh_ts
                >= self._accounts_refresh_interval_sec
            ):
                await self._refresh_accounts_data()
                self._last_accounts_refresh_ts = now_ts
            # 每次心跳拉取当前活跃标的现价，供监控页计算盈亏与期权内在价值/虚实。
            if self.symbol:
                spot_fresh = await self.connector.get_underlying_price(self.symbol)
                if spot_fresh is not None and spot_fresh > 0:
                    self.store.set_underlying_price(spot_fresh)
            if self._status_sink:
                result = await self._refresh_and_build_snapshot()
                if result is not None:
                    snapshot, spot, cs, data_lag_ms = result
                    snap_dict = self._build_snapshot_dict(
                        snapshot, spot, cs, data_lag_ms
                    )
                    self._status_sink.write_snapshot(snap_dict, append_history=False)
                    # R-RM*: push current symbol quote to Redis on heartbeat (so monitor has at least heartbeat cadence)
                    if getattr(self, "_redis_quotes", None) and self._redis_quotes.available:
                        try:
                            payload = self._quote_payload()
                            if payload:
                                self._redis_quotes.set_quote(self.symbol, payload)
                                self._redis_quotes.publish_update(self.symbol, {"symbol": self.symbol, "ts": payload.get("ts")})
                        except Exception as e:
                            logger.warning("Redis quote write in heartbeat: %s", e)
                else:
                    logger.debug(
                        "Heartbeat: no full snapshot (spot unavailable), writing minimal status"
                    )
                    minimal = self._build_heartbeat_minimal_dict()
                    self._status_sink.write_snapshot(minimal, append_history=False)
                    if getattr(self, "_redis_quotes", None) and self._redis_quotes.available:
                        try:
                            payload = self._quote_payload()
                            if payload:
                                self._redis_quotes.set_quote(self.symbol, payload)
                                self._redis_quotes.publish_update(self.symbol, {"symbol": self.symbol, "ts": payload.get("ts")})
                        except Exception as e:
                            logger.warning("Redis quote write in heartbeat (minimal): %s", e)
                # R-M6：优先用 Redis（Event）更新 instrument_prices；无 Redis 时回退为 IB 全量拉价。全量拉价仅在首次有持仓或 Accounts Refresh 时执行。
                if not getattr(self, "_instrument_prices_initialized", False):
                    try:
                        await self._refresh_position_prices()
                        self._instrument_prices_initialized = True
                    except Exception as e:
                        logger.debug("R-M6 initial refresh_position_prices: %s", e)
                try:
                    if getattr(self, "_redis_quotes", None) and self._redis_quotes.available:
                        self._sync_instrument_prices_from_redis()
                    else:
                        await self._refresh_position_prices()
                except Exception as e:
                    logger.debug("R-M6 instrument_prices sync failed: %s", e)
                if hasattr(self._status_sink, "write_daemon_heartbeat"):
                    self._status_sink.write_daemon_heartbeat(
                        hedge_running=True,
                        ib_connected=self.connector.is_connected,
                        ib_client_id=getattr(self.connector, "client_id", None),
                        heartbeat_interval_sec=self._effective_heartbeat_interval(),
                        redis_quotes_connected=self._redis_quotes_connected(),
                        **self._event_subscribe_flags(),
                        **self._listener_heartbeat_kwargs(),
                    )
            # 每次心跳同步 Real-time ticker 订阅：与 Watchlist STK + 策略标的 一致，多退少补
            await self._refresh_ticker_subscriptions()
            if not suspended:
                logger.info(
                    "[Daemon] state=RUNNING | heartbeat: tick, running maybe_hedge"
                )
                await self._eval_hedge_sync()

    async def _refresh_ticker_subscriptions(self) -> None:
        """每次心跳同步 Real-time ticker：应与 Watchlist STK + 当前活跃标的 一致；多退少补，无需重启守护进程。"""
        if not self.connector.is_connected:
            return
        desired: set = set()
        if self.symbol:
            desired.add(self.symbol.strip())
        if self._status_sink and hasattr(self._status_sink, "get_watchlist_stk_symbols"):
            for s in getattr(self._status_sink, "get_watchlist_stk_symbols")() or []:
                if s and str(s).strip():
                    desired.add(str(s).strip())
        current = set(self.connector.get_subscribed_ticker_symbols())
        to_remove = current - desired
        to_add = desired - current
        for sym in sorted(to_remove):
            self.connector.unsubscribe_ticker(sym)
            if getattr(self, "_redis_quotes", None) and self._redis_quotes.available:
                self._redis_quotes.delete_quote(sym)
            logger.info("[Daemon] Real-time ticker unsubscribed: %s", sym)
        if to_add:
            added = await self.connector.subscribe_tickers(
                sorted(to_add), self._on_ticker_for_symbol
            )
            if added:
                logger.info(
                    "[Daemon] Real-time ticker subscribed: %s",
                    sorted(added.keys()),
                )

    def _get_position_stk_instruments(self) -> dict:
        """从 accounts_data 聚合持仓中的 STK 标的，返回 contract_key -> meta（symbol, sec_type, expiry, strike, option_right, exchange, currency）。"""
        instruments: dict = {}
        accounts = self.store.get_accounts_data()
        if not accounts:
            return instruments
        for acc in accounts:
            positions = acc.get("positions") or []
            if not isinstance(positions, list):
                continue
            for p in positions:
                if not isinstance(p, dict):
                    continue
                sym = (p.get("symbol") or "").strip()
                if not sym:
                    continue
                sec = (p.get("secType") or p.get("sec_type") or "").strip()
                sec_u = sec.upper()
                if sec_u != "STK":
                    continue
                ex = (p.get("exchange") or "").strip() or "SMART"
                curr = (p.get("currency") or "").strip() or "USD"
                contract_key = f"{sym}|{sec_u}|||"
                if contract_key in instruments:
                    continue
                instruments[contract_key] = {
                    "symbol": sym,
                    "sec_type": sec_u,
                    "expiry": None,
                    "strike": None,
                    "option_right": None,
                    "exchange": ex,
                    "currency": curr,
                }
        return instruments

    async def _refresh_position_prices(self) -> None:
        """R-M6：根据当前 accounts_data 按 contract_key 聚合标的，逐标的向 IB 拉价并写入 instrument_prices。
        用于：守护进程启动后首次有持仓时执行一次；监控端点击 Accounts Refresh 时执行。
        """
        if not self._status_sink or not hasattr(
            self._status_sink, "write_instrument_prices"
        ):
            return
        if not self.connector.is_connected:
            return
        instruments = self._get_position_stk_instruments()
        if not instruments:
            return
        rows = []
        for ck, meta in instruments.items():
            price = await self.connector.get_instrument_price(
                symbol=meta["symbol"],
                sec_type=meta["sec_type"],
                expiry=meta["expiry"],
                strike=meta["strike"],
                right=meta["option_right"],
                exchange=meta["exchange"],
                currency=meta["currency"],
            )
            if not price:
                logger.debug(
                    "[R-M6] get_instrument_price returned no data for %s (%s)",
                    ck,
                    meta["symbol"],
                )
                continue
            rows.append(
                {
                    "contract_key": ck,
                    "symbol": meta["symbol"],
                    "sec_type": meta["sec_type"],
                    "expiry": meta["expiry"],
                    "strike": meta["strike"],
                    "option_right": meta["option_right"],
                    "last": price.get("last"),
                    "bid": price.get("bid"),
                    "ask": price.get("ask"),
                    "mid": price.get("mid"),
                }
            )
        logger.info(
            "[R-M6] refresh_position_prices: %s stock instruments, %s rows to write",
            len(instruments),
            len(rows),
        )
        if rows:
            self._status_sink.write_instrument_prices(rows)

    def _sync_instrument_prices_from_redis(self) -> None:
        """R-M6：用 Redis 中 Event 已写入的行情更新 instrument_prices，仅更新有 Redis 数据的持仓标的。"""
        if not self._status_sink or not hasattr(
            self._status_sink, "write_instrument_prices"
        ):
            return
        if not getattr(self, "_redis_quotes", None) or not self._redis_quotes.available:
            return
        instruments = self._get_position_stk_instruments()
        if not instruments:
            return
        symbols = [m["symbol"] for m in instruments.values()]
        quotes = self._redis_quotes.get_quotes(symbols)
        if not quotes:
            return
        symbol_to_ck = {m["symbol"]: ck for ck, m in instruments.items()}
        rows = []
        for q in quotes:
            sym = q.get("symbol")
            ck = symbol_to_ck.get(sym) if sym else None
            if not ck:
                continue
            meta = instruments[ck]
            bid = q.get("bid")
            ask = q.get("ask")
            last = q.get("last")
            try:
                bid_f = float(bid) if bid is not None else None
                ask_f = float(ask) if ask is not None else None
                last_f = float(last) if last is not None else None
            except (TypeError, ValueError):
                continue
            if bid_f is not None and not math.isfinite(bid_f):
                bid_f = None
            if ask_f is not None and not math.isfinite(ask_f):
                ask_f = None
            if last_f is not None and not math.isfinite(last_f):
                last_f = None
            if last_f is None and (bid_f is None or ask_f is None):
                continue
            mid = (
                (bid_f + ask_f) / 2.0
                if bid_f is not None and ask_f is not None
                else last_f
            )
            if mid is None:
                mid = last_f
            if mid is not None and not math.isfinite(mid):
                continue
            rows.append(
                {
                    "contract_key": ck,
                    "symbol": meta["symbol"],
                    "sec_type": meta["sec_type"],
                    "expiry": meta["expiry"],
                    "strike": meta["strike"],
                    "option_right": meta["option_right"],
                    "last": last_f,
                    "bid": bid_f,
                    "ask": ask_f,
                    "mid": mid,
                }
            )
        if rows:
            self._status_sink.write_instrument_prices(rows)
            logger.debug(
                "[R-M6] sync_instrument_prices_from_redis: %s rows from Redis",
                len(rows),
            )

    # --- State handlers: each runs its logic and returns the next state ---

    async def _handle_idle(self) -> DaemonState:
        """IDLE: ready to start. Transition to CONNECTING."""
        logger.info("[Daemon] state=IDLE → CONNECTING (connecting to IB)")
        return DaemonState.CONNECTING

    async def _handle_connecting(self) -> DaemonState:
        """CONNECTING: try IB with client_id, client_id+1, ... (up to 10 attempts) on 326; if all fail → WAITING_IB (RE-7)."""
        logger.info(
            "[Daemon] state=CONNECTING | connecting to IB (clientId=%s; will try +1, +2, ... if already in use)",
            getattr(self.connector, "client_id", None),
        )
        ok = await self.connector.connect(max_attempts=10)
        if not ok:
            logger.warning(
                "[Daemon] state=CONNECTING | IB connect failed after 10 attempts → WAITING_IB (daemon stays up, will retry)"
            )
            return DaemonState.WAITING_IB
        logger.info("[Daemon] state=CONNECTING → CONNECTED (IB connected)")
        return DaemonState.CONNECTED

    async def _handle_waiting_ib(self) -> DaemonState:
        """WAITING_IB (RE-7): daemon running, IB not connected. Write heartbeat with next_retry_ts + seconds_until_retry; poll stop/retry_ib; auto-retry at next heartbeat."""
        now_t = time.time()
        interval = self._effective_heartbeat_interval()
        next_retry_ts = now_t + interval
        sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
        if self._status_sink and hasattr(self._status_sink, "write_daemon_heartbeat"):
            self._status_sink.write_daemon_heartbeat(
                hedge_running=False,
                ib_connected=False,
                ib_client_id=None,
                next_retry_ts=next_retry_ts,
                seconds_until_retry=sec_until,
                heartbeat_interval_sec=self._effective_heartbeat_interval(),
                redis_quotes_connected=self._redis_quotes_connected(),
                **self._event_subscribe_flags(),
                **self._listener_heartbeat_kwargs(),
            )
        logger.info(
            "[Daemon] state=WAITING_IB | IB not connected; next retry in %ss (heartbeat interval=%.0fs)",
            sec_until,
            interval,
        )
        while True:
            cmd = self._poll_control()
            if cmd == "stop":
                logger.info("[Daemon] state=WAITING_IB | control stop → STOPPING")
                return DaemonState.STOPPING
            if cmd == "retry_ib" or time.time() >= next_retry_ts:
                logger.info(
                    "[Daemon] state=WAITING_IB | %s → connecting to IB (clientId=%s; will try +1, +2, ... if in use)",
                    "retry_ib" if cmd == "retry_ib" else "retry timer",
                    getattr(self.connector, "client_id", None),
                )
                ok = await self.connector.connect(max_attempts=10)
                if ok:
                    # 立即写心跳，避免进入 CONNECTED/RUNNING 前 last_ts 过期导致监控端误判为异常（CONNECTED 阶段 _refresh_and_build_snapshot 可能较慢）
                    if self._status_sink and hasattr(
                        self._status_sink, "write_daemon_heartbeat"
                    ):
                        self._status_sink.write_daemon_heartbeat(
                            hedge_running=False,
                            ib_connected=True,
                            ib_client_id=getattr(self.connector, "client_id", None),
                            heartbeat_interval_sec=self._effective_heartbeat_interval(),
                            redis_quotes_connected=self._redis_quotes_connected(),
                            **self._event_subscribe_flags(),
                            **self._listener_heartbeat_kwargs(),
                        )
                    logger.info("[Daemon] state=WAITING_IB → CONNECTED (IB connected)")
                    return DaemonState.CONNECTED
                now_t = time.time()
                interval = self._effective_heartbeat_interval()
                next_retry_ts = now_t + interval
                sec_until = max(0, min(interval + 5, int(round(next_retry_ts - now_t))))
                if self._status_sink and hasattr(
                    self._status_sink, "write_daemon_heartbeat"
                ):
                    self._status_sink.write_daemon_heartbeat(
                        hedge_running=False,
                        ib_connected=False,
                        ib_client_id=None,
                        next_retry_ts=next_retry_ts,
                        seconds_until_retry=sec_until,
                        heartbeat_interval_sec=self._effective_heartbeat_interval(),
                        redis_quotes_connected=self._redis_quotes_connected(),
                        **self._event_subscribe_flags(),
                        **self._listener_heartbeat_kwargs(),
                    )
                logger.debug(
                    "[Daemon] state=WAITING_IB | connect failed; next retry in %ss",
                    sec_until,
                )
            await asyncio.sleep(1.0)

    async def _handle_connected(self) -> DaemonState:
        """CONNECTED: fetch positions + spot, bootstrap TradingFSM (START/SYNCED). Transition to RUNNING."""
        # 进入 CONNECTED 时再写一次心跳，防止 _refresh_and_build_snapshot 耗时过长导致 last_ts 超 35s 被监控判为异常
        if self._status_sink and hasattr(self._status_sink, "write_daemon_heartbeat"):
            self._status_sink.write_daemon_heartbeat(
                hedge_running=False,
                ib_connected=self.connector.is_connected,
                ib_client_id=getattr(self.connector, "client_id", None),
                heartbeat_interval_sec=self._effective_heartbeat_interval(),
                redis_quotes_connected=self._redis_quotes_connected(),
                **self._event_subscribe_flags(),
                **self._listener_heartbeat_kwargs(),
            )
        logger.info(
            "[Daemon] state=CONNECTED | fetching account summary and positions, building snapshot..."
        )
        await self._refresh_accounts_data()
        self._last_accounts_refresh_ts = time.time()
        result = await self._refresh_and_build_snapshot()
        if result is not None:
            snapshot, spot, cs, data_lag_ms = result
            self._fsm_trading.apply_transition(TradingEvent.START, snapshot)
            self._fsm_trading.apply_transition(TradingEvent.SYNCED, snapshot)
            # Write snapshot (incl. R-A1 account_*) to DB immediately so monitor shows account after reconnection
            if self._status_sink:
                snap_dict = self._build_snapshot_dict(snapshot, spot, cs, data_lag_ms)
                self._status_sink.write_snapshot(snap_dict, append_history=False)
        else:
            # No full snapshot (e.g. no spot); still write minimal + account so monitor sees IB account
            if self._status_sink:
                self._status_sink.write_snapshot(
                    self._build_heartbeat_minimal_dict(), append_history=False
                )
        logger.info("[Daemon] state=CONNECTED → RUNNING (bootstrap done)")
        return DaemonState.RUNNING

    async def _handle_running(self) -> DaemonState:
        """RUNNING: subscribe to Watchlist STK + active symbol, start background tasks, loop until stop requested. May transition to RUNNING_SUSPENDED if daemon_run_status.suspended."""
        logger.info("[Daemon] state=RUNNING | subscribing to tickers (Watchlist STK + active symbol) and positions...")
        # Symbols to subscribe: Watchlist STK + current active symbol inferred from positions
        symbols_to_subscribe: list = []
        if self._status_sink and hasattr(self._status_sink, "get_watchlist_stk_symbols"):
            symbols_to_subscribe = getattr(self._status_sink, "get_watchlist_stk_symbols")() or []
        logger.info("[Daemon] Watchlist STK symbols from DB: %s", symbols_to_subscribe)
        symbols_set = set(s.strip() for s in symbols_to_subscribe if s and str(s).strip())
        if self.symbol:
            symbols_set.add(self.symbol)
        symbols_set = {s for s in symbols_set if s and str(s).strip()}
        symbols_list = sorted(symbols_set)
        if symbols_list:
            await self.connector.subscribe_tickers(symbols_list, self._on_ticker_for_symbol)
            logger.info("[Daemon] subscribed to %s symbol(s): %s", len(symbols_list), symbols_list)
        else:
            logger.info("[Daemon] no watchlist or active symbol available; skip ticker subscribe")
        self.connector.subscribe_positions(self._eval_hedge_threadsafe)
        # Connect listener with ib_client_id_listener so TWS shows the client ID
        listener_just_connected = False
        try:
            ok = await self.listener_connector.connect(max_attempts=3)
            if ok:
                listener_just_connected = True
                logger.info("[Daemon] Listener IB connected (client_id=%s)", self.listener_connector.client_id)
            else:
                logger.warning("[Daemon] Listener IB connect failed (TWS may not show listener client_id)")
        except Exception as e:
            logger.warning("[Daemon] Listener IB connect error: %s", e)
        # Sync FSM with daemon_run_status so first snapshot reflects RUNNING_SUSPENDED if already set
        self._apply_run_status_transition()
        if self._status_sink:
            self._status_sink.write_snapshot(
                self._build_heartbeat_minimal_dict(), append_history=False
            )
            if hasattr(self._status_sink, "write_daemon_heartbeat"):
                # Use explicit listener_connected=True when we just connected: is_connected can lag (ib.isConnected()) so _listener_heartbeat_kwargs() may still be False right after connect()
                listener_kw = {"listener_connected": True, "listener_client_id": self.listener_connector.client_id} if listener_just_connected else self._listener_heartbeat_kwargs()
                self._status_sink.write_daemon_heartbeat(
                    hedge_running=True,
                    ib_connected=self.connector.is_connected,
                    ib_client_id=getattr(self.connector, "client_id", None),
                    heartbeat_interval_sec=self._effective_heartbeat_interval(),
                    redis_quotes_connected=self._redis_quotes_connected(),
                    **self._event_subscribe_flags(),
                    **listener_kw,
                )
        self._heartbeat_task = asyncio.create_task(self._heartbeat())
        self._config_reload_task = asyncio.create_task(self._reload_config_loop())
        control_available = self._status_sink is not None and hasattr(
            self._status_sink, "poll_and_consume_control"
        )
        logger.info(
            "[Daemon] state=%s | Daemon running (symbol=%s, paper_trade=%s, config=%s); control via daemon_control=%s",
            self._fsm_daemon.current.value,
            self.symbol,
            self.paper_trade,
            self._config_path or "default",
            "enabled" if control_available else "disabled (no postgres sink)",
        )
        self._ib_disconnected_during_run = False
        try:
            while self._fsm_daemon.is_running():
                await asyncio.sleep(1.0)
                if getattr(self, "_ib_disconnected_during_run", False):
                    self._ib_disconnected_during_run = False
                    if self.connector.is_connected:
                        try:
                            await self.connector.disconnect()
                        except Exception as e:
                            logger.warning("[Daemon] release_ib: disconnect failed (continuing to WAITING_IB): %s", e)
                    listener = getattr(self, "listener_connector", None)
                    if listener and listener.is_connected:
                        try:
                            await listener.disconnect()
                        except Exception as e:
                            logger.warning("[Daemon] release_ib: listener disconnect failed: %s", e)
                    return DaemonState.WAITING_IB
        except asyncio.CancelledError:
            pass
        return DaemonState.STOPPING

    async def _handle_stopping(self) -> DaemonState:
        """STOPPING: cancel tasks, disconnect. Transition to STOPPED."""
        logger.info("[Daemon] state=STOPPING | cancelling tasks, disconnecting IB...")
        heartbeat_task = getattr(self, "_heartbeat_task", None)
        config_reload_task = getattr(self, "_config_reload_task", None)
        if heartbeat_task is not None:
            heartbeat_task.cancel()
            try:
                await heartbeat_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug("Heartbeat task raised before cancel: %s", e)
        if config_reload_task is not None:
            config_reload_task.cancel()
            try:
                await config_reload_task
            except asyncio.CancelledError:
                pass
            except Exception as e:
                logger.debug("Config reload task raised before cancel: %s", e)
        if getattr(self._status_sink, "close", None):
            try:
                self._status_sink.close()
            except Exception as e:
                logger.debug("Status sink close: %s", e)
        if getattr(self, "_redis_quotes", None):
            try:
                symbols = (
                    self.connector.get_subscribed_ticker_symbols()
                    if getattr(self.connector, "get_subscribed_ticker_symbols", None)
                    else []
                )
                for sym in symbols:
                    if sym and str(sym).strip():
                        self._redis_quotes.delete_quote(sym.strip())
                if symbols:
                    logger.info(
                        "[Daemon] STOPPING: cleared Redis ticker keys for %s symbol(s): %s",
                        len(symbols),
                        symbols,
                    )
                self._redis_quotes.close()
            except Exception as e:
                logger.debug("Redis quotes close: %s", e)
        await self.connector.disconnect()
        listener = getattr(self, "listener_connector", None)
        if listener:
            try:
                await listener.disconnect()
            except Exception as e:
                logger.debug("Listener disconnect on stop: %s", e)
        logger.info("[Daemon] state=STOPPING → STOPPED (exit)")
        return DaemonState.STOPPED

    def _get_state_handlers(self) -> dict:
        """Map state -> async handler that returns next state."""
        return {
            DaemonState.IDLE: self._handle_idle,
            DaemonState.CONNECTING: self._handle_connecting,
            DaemonState.WAITING_IB: self._handle_waiting_ib,
            DaemonState.CONNECTED: self._handle_connected,
            DaemonState.RUNNING: self._handle_running,
            DaemonState.STOPPING: self._handle_stopping,
        }

    async def run(self) -> None:
        """State-driven loop: run handler for current state, transition to returned state."""
        self._loop = asyncio.get_running_loop()
        handlers = self._get_state_handlers()
        logger.info(
            "[Daemon] started (state loop: IDLE → CONNECTING → CONNECTED → RUNNING → STOPPING → STOPPED)"
        )
        try:
            while self._fsm_daemon.current != DaemonState.STOPPED:
                current = self._fsm_daemon.current
                handler = handlers.get(current)
                if handler is None:
                    logger.warning(
                        "[Daemon] state=%s | no handler; stopping", current.value
                    )
                    break
                try:
                    next_state = await handler()
                    if not self._fsm_daemon.transition(next_state):
                        logger.error(
                            "[Daemon] invalid transition %s → %s; stopping",
                            current.value,
                            next_state.value,
                        )
                        if self._fsm_daemon.can_transition_to(DaemonState.STOPPING):
                            self._fsm_daemon.transition(DaemonState.STOPPING)
                        break
                except Exception as e:
                    logger.exception(
                        "[Daemon] state=%s handler raised: %s", current.value, e
                    )
                    if self._fsm_daemon.can_transition_to(DaemonState.STOPPING):
                        self._fsm_daemon.transition(DaemonState.STOPPING)
                    else:
                        self._fsm_daemon.transition(DaemonState.STOPPED)
        finally:
            if self._fsm_daemon.current != DaemonState.STOPPED:
                if self._fsm_daemon.current != DaemonState.STOPPING:
                    self._fsm_daemon.transition(DaemonState.STOPPING)
                try:
                    await self._handle_stopping()
                except Exception as e:
                    logger.exception("Cleanup (_handle_stopping) failed: %s", e)
                self._fsm_daemon.transition(DaemonState.STOPPED)

    def stop(self) -> None:
        self._fsm_daemon.request_stop()


async def _run_daemon_main(config_path: Optional[str] = None) -> None:
    """Load config, register signals, run GsTrading. SIGTERM/SIGINT call app.stop() on main loop."""
    config, resolved_path = read_config(config_path)
    app = GsTrading(config, config_path=resolved_path)
    loop = asyncio.get_running_loop()

    def _on_stop_signal(*_args: Any) -> None:
        logger.info(
            "[Daemon] received SIGTERM/SIGINT → requesting stop (RUNNING → STOPPING)"
        )
        loop.call_soon_threadsafe(app.stop)

    try:
        loop.add_signal_handler(signal.SIGTERM, _on_stop_signal)
    except (NotImplementedError, OSError):
        pass  # add_signal_handler not supported on Windows
    try:
        loop.add_signal_handler(signal.SIGINT, _on_stop_signal)
    except (NotImplementedError, OSError):
        pass
    try:
        await app.run()
    finally:
        # So monitoring can show "Stopped at ..." (SIGTERM/SIGINT or consumed stop); no-op on SIGKILL
        if getattr(app, "_status_sink", None) and hasattr(
            app._status_sink, "write_daemon_graceful_shutdown"
        ):
            app._status_sink.write_daemon_graceful_shutdown()


def run_daemon(config_path: Optional[str] = None) -> None:
    """Entry: run the gamma scalping daemon (SIGTERM/SIGINT stop)."""
    asyncio.run(_run_daemon_main(config_path))
