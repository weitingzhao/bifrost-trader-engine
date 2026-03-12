"""Gamma Scalping strategy: connector -> state -> greeks -> scalper -> guard -> order."""

import asyncio
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional, Tuple

from src.config.settings import (
    get_config_for_guards,
    get_hedge_config,
    get_structure_config,
    get_risk_config,
)
from src.connector.ib import IBConnector
from src.core.metrics import get_metrics
from src.core.state.composite import CompositeState
from src.core.state.snapshot import StateSnapshot
from src.core.store import Store
from src.fsm.daemon_fsm import DaemonFSM, DaemonState
from src.execution.order_manager import OrderManager
from src.fsm.hedge_fsm import HedgeFSM
from src.fsm.trading_fsm import TradingFSM
from src.market.market_data import MarketData
from src.positions.position_book import PositionBook
from src.guards.execution_guard import ExecutionGuard
from src.sink import StatusSink
from src.sink.postgres_sink import PostgreSQLSink
from src.realtime.redis_quotes import create_from_config as create_redis_quotes
from src.app.config import read_config
from src.app import accounts as _accounts
from src.app import snapshot as _snapshot
from src.app import symbol_position as _symbol_position
from src.app import control_heartbeat as _control_heartbeat
from src.app import hedge_flow as _hedge_flow
from src.app import daemon_handlers as _daemon_handlers
from src.app import instrument_prices as _instrument_prices
from src.app import ticker_redis as _ticker_redis

logger = logging.getLogger(__name__)


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

        # 1.b IB Connector: host/port/client_id 仅来自 PostgreSQL settings（系统默认使用数据库）.
        ib_cfg = config.get("ib", {})
        db_ib = None
        if self._status_sink and hasattr(self._status_sink, "get_ib_connection_config"):
            db_ib = self._status_sink.get_ib_connection_config()
        if not db_ib:
            raise RuntimeError(
                "IB connection config must be set in PostgreSQL settings (public.settings). "
                "Use Settings page or ensure settings row exists with ib_host, ib_port_type, ib_client_id_*."
            )
        host = db_ib.get("host", "127.0.0.1")
        port = int(db_ib.get("port", 7497))
        last_ib = None
        if hasattr(self._status_sink, "get_last_ib_client_id"):
            last_ib = self._status_sink.get_last_ib_client_id()
        client_id_daemon = int(db_ib.get("client_id_daemon", 1))
        client_id = (last_ib + 1) if last_ib is not None else client_id_daemon
        if last_ib is not None:
            logger.info(
                "IB client_id from DB last_ib_client_id=%s → using %s (avoid in-use after crash)",
                last_ib,
                client_id,
            )
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
        listener_client_id = int(db_ib.get("client_id_listener", 2))
        self.listener_connector = IBConnector(
            host=host,
            port=port,
            client_id=listener_client_id,
            connect_timeout=ib_cfg.get("connect_timeout", 60.0),
        )
        # Secondary IB (Second TWS): Listener on Secondary host with its own client_id
        ib2_host = (db_ib.get("ib2_host") or "").strip() if isinstance(db_ib.get("ib2_host"), str) else ""
        if ib2_host:
            ib2_port = int(db_ib.get("ib2_port", 7497))
            ib2_client_id_listener = int(db_ib.get("ib2_client_id_listener", 3))
            self.listener_connector_2 = IBConnector(
                host=ib2_host,
                port=ib2_port,
                client_id=ib2_client_id_listener,
                connect_timeout=ib_cfg.get("connect_timeout", 60.0),
            )
            logger.info(
                "IB Listener (Secondary): host=%s port=%s client_id=%s",
                ib2_host,
                ib2_port,
                ib2_client_id_listener,
            )
        else:
            self.listener_connector_2 = None

        # Host account for hedging/market data when multiple IB accounts exist (R-A4). From DB only.
        self._host_account_id: Optional[str] = None
        if db_ib and db_ib.get("host_account_id"):
            self._host_account_id = str(db_ib["host_account_id"]).strip()
            logger.info("[R-A4] host_account_id=%s (for hedging and market data)", self._host_account_id)

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
        return _symbol_position.position_symbol_parts(item)

    def _infer_active_symbol(self, positions: list[Any]) -> str:
        """Prefer option underlying symbol, then stock symbol, from current positions."""
        return _symbol_position.infer_active_symbol(self, positions)

    def _set_active_symbol(self, symbol: Optional[str]) -> None:
        """Switch the strategy symbol when live positions change."""
        _symbol_position.set_active_symbol(self, symbol)

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
        """R-A1: fetch all managed accounts' summary + positions from IB; store for monitoring and set primary account for trading."""
        await _accounts.refresh_accounts_data(self)

    async def _refresh_executions_only(self) -> None:
        """R-A2: 仅从 IB 拉取账户执行/成交并写入 account_executions，供复盘与风控 Tab 使用。"""
        await _accounts.refresh_executions_only(self)

    async def _refresh_positions(self) -> None:
        """Fetch positions from IB and update store (raw positions + stock_shares only)."""
        await _accounts.refresh_positions(self)

    def _build_snapshot(
        self,
        cs: CompositeState,
        spot: Optional[float],
        greeks: Optional[Any],
        option_legs_count: int = 0,
    ) -> StateSnapshot:
        """Build StateSnapshot from CompositeState for TradingFSM."""
        return _snapshot.build_snapshot(self, cs, spot, greeks, option_legs_count)

    def _build_snapshot_dict(
        self,
        snapshot: StateSnapshot,
        spot: float,
        cs: CompositeState,
        data_lag_ms: Optional[float],
    ) -> dict:
        """Build dict for StatusSink (status_current / status_history)."""
        return _snapshot.build_snapshot_dict(self, snapshot, spot, cs, data_lag_ms)

    def _build_heartbeat_minimal_dict(self) -> dict:
        """Minimal snapshot dict when spot is unavailable."""
        return _snapshot.build_heartbeat_minimal_dict(self)

    async def _refresh_and_build_snapshot(
        self,
    ) -> Optional[Tuple[StateSnapshot, float, CompositeState, Optional[float]]]:
        """Refresh positions and spot, parse legs, greeks, classify, build snapshot."""
        return await _snapshot.refresh_and_build_snapshot(self)

    def _on_ticker(self, ticker: Any) -> None:
        """Called on each ticker update from IB (may be from IB thread)."""
        _ticker_redis.on_ticker(self, ticker)

    def _on_ticker_for_symbol(self, symbol: str, ticker: Any) -> None:
        """Called on each ticker update from IB for a symbol (may be from IB thread)."""
        _ticker_redis.on_ticker_for_symbol(self, symbol, ticker)

    def _quote_payload_from_ticker(self, symbol: str, ticker: Any) -> Optional[dict]:
        """Build quote dict for Redis from ticker. Used for non-strategy symbols."""
        return _ticker_redis.quote_payload_from_ticker(symbol, ticker)

    def _quote_payload(self) -> Optional[dict]:
        """Build quote dict for Redis from store."""
        return _ticker_redis.quote_payload(self)

    def _eval_hedge_threadsafe(self) -> None:
        """Threadsafe: schedule _on_tick to be run safely from any thread."""
        _ticker_redis.eval_hedge_threadsafe(self)

    async def _eval_hedge_sync(self) -> None:
        """Run FSM-driven tick once (under lock)."""
        await _ticker_redis.eval_hedge_sync(self)

    async def _eval_hedge(self) -> None:
        """FSM-driven tick: refresh + snapshot -> TradingFSM (TICK) -> maybe _hedge."""
        await _hedge_flow.eval_hedge(self)

    async def _hedge(
        self,
        intent: Any,
        cs: CompositeState,
        spot: float,
        snapshot: StateSnapshot,
    ) -> None:
        """Run HedgeFSM flow and place order; fire HEDGE_DONE or HEDGE_FAILED on TradingFSM."""
        await _hedge_flow.hedge(self, intent, cs, spot, snapshot)

    def _poll_control(self) -> Optional[str]:
        """Poll control command from sink."""
        return _control_heartbeat.poll_control(self)

    def _poll_run_status(self) -> tuple[bool, Optional[float]]:
        """Poll daemon_run_status from sink."""
        return _control_heartbeat.poll_run_status(self)

    def _effective_heartbeat_interval(self) -> float:
        """Heartbeat interval in seconds (from DB if set via monitoring, else config)."""
        return _control_heartbeat.effective_heartbeat_interval(self)

    def _redis_quotes_connected(self) -> bool:
        """Whether daemon is connected to Redis and writing real-time quotes."""
        return _control_heartbeat.redis_quotes_connected(self)

    def _event_subscribe_flags(self) -> dict:
        """IB event subscription status for System page."""
        return _control_heartbeat.event_subscribe_flags(self)

    def _listener_heartbeat_kwargs(self) -> dict:
        """Listener connection status for daemon_heartbeat."""
        return _control_heartbeat.listener_heartbeat_kwargs(self)

    def _apply_run_status_transition(self) -> bool:
        """Sync Daemon FSM with daemon_run_status: RUNNING <-> RUNNING_SUSPENDED."""
        return _control_heartbeat.apply_run_status_transition(self)

    async def _heartbeat(self) -> None:
        """Periodic heartbeat to run maybe_hedge and write status snapshot."""
        await _control_heartbeat.heartbeat(self)

    async def _refresh_ticker_subscriptions(self) -> None:
        """Sync Real-time ticker subscriptions with Watchlist STK + active symbol."""
        await _instrument_prices.refresh_ticker_subscriptions(self)

    def _get_position_stk_instruments(self) -> dict:
        """From accounts_data aggregate STK instruments; return contract_key -> meta."""
        return _instrument_prices.get_position_stk_instruments(self)

    async def _refresh_position_prices(self) -> None:
        """R-M6: fetch prices from IB and write instrument_prices."""
        await _instrument_prices.refresh_position_prices(self)

    def _sync_instrument_prices_from_redis(self) -> None:
        """R-M6: update instrument_prices from Redis quotes."""
        _instrument_prices.sync_instrument_prices_from_redis(self)

    # --- State handlers: each runs its logic and returns the next state ---

    async def _handle_idle(self) -> DaemonState:
        """IDLE: ready to start. Transition to CONNECTING."""
        return await _daemon_handlers.handle_idle(self)

    async def _handle_connecting(self) -> DaemonState:
        """CONNECTING: try IB connect; if fail → WAITING_IB (RE-7)."""
        return await _daemon_handlers.handle_connecting(self)

    async def _handle_waiting_ib(self) -> DaemonState:
        """WAITING_IB (RE-7): daemon running, IB not connected; poll stop/retry_ib; auto-retry."""
        return await _daemon_handlers.handle_waiting_ib(self)

    async def _handle_connected(self) -> DaemonState:
        """CONNECTED: fetch positions + spot, bootstrap TradingFSM. Transition to RUNNING."""
        return await _daemon_handlers.handle_connected(self)

    async def _handle_running(self) -> DaemonState:
        """RUNNING: subscribe tickers, start heartbeat; loop until stop or WAITING_IB."""
        return await _daemon_handlers.handle_running(self)

    async def _handle_stopping(self) -> DaemonState:
        """STOPPING: cancel tasks, disconnect. Transition to STOPPED."""
        return await _daemon_handlers.handle_stopping(self)

    def _get_state_handlers(self) -> dict:
        """Map state -> async handler that returns next state."""
        return _daemon_handlers.get_state_handlers(self)

    async def run(self) -> None:
        """State-driven loop: run handler for current state, transition to returned state."""
        await _daemon_handlers.run(self)

    def stop(self) -> None:
        _daemon_handlers.stop(self)
