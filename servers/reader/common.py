"""Connection and StatusReader facade. Delegates to domain modules (status, watchlist, market, settings, accounts, executions, position_categories)."""

import logging
from datetime import date
from typing import Any, Dict, List, Optional, Tuple

import psycopg2

from src.sink.postgres_sink import _get_conn_params

from servers.reader import accounts as accounts_module
from servers.reader import executions as executions_module
from servers.reader import gate_safety as gate_safety_module
from servers.reader import market as market_module
from servers.reader import strategy as strategy_module
from servers.reader import strategy_instance as strategy_instance_module
from servers.reader import structure_type_config as structure_type_config_module
from servers.reader import position_categories as position_categories_module
from servers.reader import settings as settings_module
from servers.reader import status as status_module
from servers.reader import watchlist as watchlist_module

logger = logging.getLogger(__name__)


class StatusReader:
    """Read daemon_auto_status_current and daemon_auto_operations from PostgreSQL. Uses the same root postgres config as daemon.
    Holds connection and delegates to domain modules (status, watchlist, market, settings, accounts)."""

    def __init__(self, status_config: dict) -> None:
        self._config = status_config
        self._conn: Any = None

    def _ensure_conn(self) -> bool:
        """Compat helper mirroring PostgreSQLSink._ensure_conn()."""
        return self._connect()

    def _connect(self) -> bool:
        if self._conn is not None:
            try:
                self._conn.rollback()
                return True
            except Exception:
                self._conn = None
        try:
            params = _get_conn_params(self._config)
            self._conn = psycopg2.connect(**params)
            with self._conn.cursor() as cur:
                cur.execute("SET lock_timeout = '5s'")
            self._conn.commit()
            return True
        except Exception as e:
            logger.warning("StatusReader connect failed: %s", e)
            return False

    def close(self) -> None:
        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

    # --- Status domain (delegate to status module) ---
    def get_status_current(self) -> Optional[Dict[str, Any]]:
        if not self._connect():
            return None
        return status_module.get_status_current(self._conn)

    def get_run_status(self) -> Optional[bool]:
        if not self._connect():
            return None
        return status_module.get_run_status(self._conn)

    def get_daemon_heartbeat(self) -> Optional[Dict[str, Any]]:
        if not self._connect():
            return None
        return status_module.get_daemon_heartbeat(self._conn)

    def get_operations(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        type_filter: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return status_module.get_operations(
            self._conn, since_ts=since_ts, until_ts=until_ts, type_filter=type_filter, limit=limit
        )

    def get_open_orders(self) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return status_module.get_open_orders(self._conn)

    # --- Watchlist domain (delegate to watchlist module) ---
    def get_watchlist(self) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return watchlist_module.get_watchlist(self._conn)

    def add_watchlist(
        self,
        contract_key: str,
        symbol: Optional[str] = None,
        sec_type: Optional[str] = None,
        expiry: Optional[str] = None,
        strike: Optional[float] = None,
        option_right: Optional[str] = None,
        display_label: Optional[str] = None,
        source: str = "manual",
        category_id: Optional[int] = None,
        optionable: Optional[bool] = None,
    ) -> bool:
        if not self._connect():
            return False
        return watchlist_module.add_watchlist(
            self._conn, contract_key, symbol, sec_type, expiry, strike, option_right, display_label, source, category_id, optionable
        )

    def delete_watchlist(self, contract_key: Optional[str] = None) -> bool:
        if not self._connect():
            return False
        return watchlist_module.delete_watchlist(self._conn, contract_key=contract_key)

    # --- Market domain (delegate to market module) ---
    def get_is_us_trading_day(self, date_str: str) -> bool:
        if not self._connect():
            return True
        return market_module.get_is_us_trading_day_conn(self._conn, date_str)

    def get_market_holidays(self, exchange: str = "NYSE", year: Optional[int] = None) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return market_module.get_market_holidays_conn(self._conn, exchange=exchange, year=year)

    def get_contract_quotes(self, contract_keys: List[str]) -> List[Dict[str, Any]]:
        """Return bid/ask/last/mid from contract_quote_live for given contract_keys. Used by GET /quotes for OPT rows."""
        if not self._connect():
            return []
        return market_module.get_contract_quotes_conn(self._conn, contract_keys)

    def add_market_holiday(
        self, date_str: str, label: Optional[str] = None, exchange: str = "NYSE"
    ) -> bool:
        if not self._connect():
            return False
        return market_module.add_market_holiday_conn(self._conn, date_str, label=label, exchange=exchange)

    def delete_market_holiday(self, date_str: str, exchange: str = "NYSE") -> bool:
        if not self._connect():
            return False
        return market_module.delete_market_holiday_conn(self._conn, date_str, exchange=exchange)

    def get_bars(
        self,
        symbol: Optional[str] = None,
        period: str = "1 D",
        limit: int = 200,
    ) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return market_module.get_bars(self._conn, symbol=symbol, period=period, limit=limit)

    def get_bars_latest(self, symbol: Optional[str] = None, period: str = "1 D") -> Optional[float]:
        if not self._connect():
            return None
        return market_module.get_bars_latest(self._conn, symbol=symbol, period=period)

    def get_bar_times_in_range(
        self,
        symbol: Optional[str] = None,
        period: str = "1 D",
        start_ts: Optional[float] = None,
        end_ts: Optional[float] = None,
    ) -> List[float]:
        if not self._connect():
            return []
        return market_module.get_bar_times_in_range(
            self._conn, symbol=symbol, period=period, start_ts=start_ts, end_ts=end_ts
        )

    def get_bars_benchmark(
        self,
        symbols: Optional[List[str]] = None,
        on_or_before: Optional[date] = None,
    ) -> Dict[str, Dict[str, Any]]:
        if not self._connect():
            return {}
        return market_module.get_bars_benchmark(self._conn, symbols=symbols, on_or_before=on_or_before)

    def get_stock_day_fallback_price(self, symbol: str) -> Optional[Tuple[float, float, Optional[float]]]:
        if not self._connect():
            return None
        return market_module.get_stock_day_fallback_price(self._conn, symbol)

    def get_bars_stats(self, symbol: Optional[str] = None) -> Dict[str, Any]:
        if not self._connect():
            return {"stock_day": 0, "stock_min": {}}
        return market_module.get_bars_stats(self._conn, symbol=symbol)

    def get_bars_coverage(self, symbols: Optional[List[str]] = None) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return market_module.get_bars_coverage(self._conn, symbols=symbols)

    # --- Settings domain (delegate to settings module) ---
    def get_ib_config(self) -> Optional[Dict[str, Any]]:
        if not self._connect():
            return None
        return settings_module.get_ib_config(self._conn)

    def get_flex_config(self, purpose: Optional[str] = None) -> Any:
        if not self._connect():
            return [] if purpose is not None else {"host_token": None, "secondary_token": None, "rows": []}
        return settings_module.get_flex_config(self._conn, purpose=purpose)

    def get_flex_default_range_dates(self) -> Tuple[str, str]:
        if not self._connect():
            return ("", "")
        return settings_module.get_flex_default_range_dates(self._conn)

    def get_flex_executions_stats(self) -> Dict[str, Any]:
        if not self._connect():
            return {"count": 0, "accounts": 0, "min_date": None, "max_date": None}
        return settings_module.get_flex_executions_stats(self._conn)

    def get_flex_init_range_dates(self) -> Tuple[str, str]:
        if not self._connect():
            return ("", "")
        return settings_module.get_flex_init_range_dates(self._conn)

    # --- Gate safety (strategy & safety boundary from DB) ---
    def get_gates_by_id(self, gate_safety_strategy_id: int) -> Optional[Dict[str, Any]]:
        """Return gates dict (shape of config['gates']) for the given boundary set id. None if missing."""
        if not self._connect():
            return None
        return gate_safety_module.get_gates_by_id(self._conn, gate_safety_strategy_id)

    def get_active_gate_safety_strategy_id(self) -> Optional[int]:
        """Return settings.active_gate_safety_strategy_id for id=1, or None."""
        if not self._connect():
            return None
        return gate_safety_module.get_active_gate_safety_strategy_id(self._conn)

    def get_active_strategy_structure_id(self) -> Optional[int]:
        """Return settings.active_strategy_structure_id for id=1, or None."""
        if not self._connect():
            return None
        return gate_safety_module.get_active_strategy_structure_id(self._conn)

    def get_active_strategy_allocation_id(self) -> Optional[int]:
        """Return settings.active_strategy_allocation_id for id=1, or None."""
        if not self._connect():
            return None
        return gate_safety_module.get_active_strategy_allocation_id(self._conn)

    def get_gate_safety_name(self, gate_safety_strategy_id: int) -> Optional[str]:
        """Return name of gate_safety_strategy row, or None."""
        if not self._connect():
            return None
        return gate_safety_module.get_gate_safety_name(self._conn, gate_safety_strategy_id)

    def list_gate_safety_sets(self) -> List[Dict[str, Any]]:
        """Return list of gate_safety_strategy rows for management dropdown."""
        if not self._connect():
            return []
        return gate_safety_module.list_gate_safety_sets(self._conn)

    def get_gate_safety_full_by_id(self, gate_safety_strategy_id: int) -> Optional[Dict[str, Any]]:
        """Return full gate set for UI edit: metadata + gates + earnings_dates. None if not found."""
        if not self._connect():
            return None
        return gate_safety_module.get_gate_safety_full_by_id(self._conn, gate_safety_strategy_id)

    def get_structure_by_id(self, strategy_structure_id: int) -> Optional[Dict[str, Any]]:
        """Return one strategy_structure row as dict, or None."""
        if not self._connect():
            return None
        return strategy_module.get_structure_by_id(self._conn, strategy_structure_id)

    def list_structures(self, active_only: bool = True) -> List[Dict[str, Any]]:
        """Return list of strategy_structure rows."""
        if not self._connect():
            return []
        return strategy_module.list_structures(self._conn, active_only=active_only)

    def list_structure_types(self) -> List[Dict[str, Any]]:
        """Return structure types from config table (for Wizard Step 1)."""
        if not self._connect():
            return []
        return structure_type_config_module.list_structure_types(self._conn)

    def get_structure_type_default_legs(self, structure_type: str) -> List[Dict[str, Any]]:
        """Return default legs for a structure type from config table."""
        if not self._connect():
            return []
        return structure_type_config_module.get_default_legs(self._conn, structure_type)

    def get_structure_type_subtypes(self, structure_type: str) -> Dict[str, Any]:
        """Return subtypes with characteristics and meta_params, plus infer_rules (for Wizard Step 2)."""
        if not self._connect():
            return {"subtypes": [], "infer_rules": []}
        return structure_type_config_module.get_subtypes_with_detail(self._conn, structure_type)

    def list_opportunities(self, active_only: bool = True) -> List[Dict[str, Any]]:
        """Return list of strategy_opportunity rows (with structure_name from JOIN)."""
        if not self._connect():
            return []
        return strategy_module.list_opportunities(self._conn, active_only=active_only)

    def get_opportunity_by_id(self, strategy_opportunity_id: int) -> Optional[Dict[str, Any]]:
        """Return one strategy_opportunity row by id. None if not found."""
        if not self._connect():
            return None
        return strategy_module.get_opportunity_by_id(self._conn, strategy_opportunity_id)

    def list_allocations(self, active_only: bool = True) -> List[Dict[str, Any]]:
        """Return list of strategy_allocation rows (with gate_safety_name from JOIN)."""
        if not self._connect():
            return []
        return strategy_module.list_allocations(self._conn, active_only=active_only)

    def get_allocation_by_id(self, strategy_allocation_id: int) -> Optional[Dict[str, Any]]:
        """Return one strategy_allocation row by id. None if not found."""
        if not self._connect():
            return None
        return strategy_module.get_allocation_by_id(self._conn, strategy_allocation_id)

    def get_strategy_history(
        self,
        from_ts: Optional[float] = None,
        to_ts: Optional[float] = None,
        strategy_structure_id: Optional[int] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Return strategy_history rows with optional filters."""
        if not self._connect():
            return []
        return strategy_module.get_strategy_history(
            self._conn,
            from_ts=from_ts,
            to_ts=to_ts,
            strategy_structure_id=strategy_structure_id,
            limit=limit,
        )

    def list_strategy_instances(
        self,
        account_id: Optional[str] = None,
        strategy_opportunity_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Return strategy_instance rows, optionally filtered by account_id and/or strategy_opportunity_id."""
        if not self._connect():
            return []
        return strategy_instance_module.list_instances(
            self._conn, account_id=account_id, strategy_opportunity_id=strategy_opportunity_id
        )

    def get_strategy_instance_by_id(self, strategy_instance_id: int) -> Optional[Dict[str, Any]]:
        """Return one strategy_instance by id. None if not found."""
        if not self._connect():
            return None
        return strategy_instance_module.get_instance_by_id(self._conn, strategy_instance_id)

    def create_strategy_instance(
        self,
        strategy_opportunity_id: int,
        account_id: str,
        opened_at: Any,
        label: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> Optional[int]:
        """Insert one strategy_instance. Returns strategy_instance_id or None."""
        if not self._connect():
            return None
        return strategy_instance_module.create_instance(
            self._conn,
            strategy_opportunity_id=strategy_opportunity_id,
            account_id=account_id,
            opened_at=opened_at,
            label=label,
            notes=notes,
        )

    def update_strategy_instance(
        self,
        strategy_instance_id: int,
        label: Optional[str] = None,
        notes: Optional[str] = None,
    ) -> bool:
        """Update label/notes of a strategy instance. Returns True if updated."""
        if not self._connect():
            return False
        return strategy_instance_module.update_instance(
            self._conn, strategy_instance_id, label=label, notes=notes
        )

    # --- Risk (delegate to status module) ---
    def get_risk_summary(self) -> Dict[str, Any]:
        if not self._connect():
            return {"daily_hedge_count": None, "daily_pnl": None, "spot": None, "symbol": None, "operations_count_24h": 0, "block_reasons": [], "ts": None}
        return status_module.get_risk_summary(self._conn)

    # --- Accounts domain (delegate to accounts module) ---
    def get_accounts_from_tables(self) -> Optional[List[Dict[str, Any]]]:
        if not self._connect():
            return None
        return accounts_module.get_accounts_from_tables(self._conn)

    def get_accounts_fetched_at(self) -> Optional[float]:
        if not self._connect():
            return None
        return accounts_module.get_accounts_fetched_at(self._conn)

    # --- Executions / transactions / performance (delegate to executions module) ---
    def get_executions(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        limit: Optional[int] = 200,
        strategy_opportunity_id: Optional[int] = None,
        strategy_instance_id: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return executions_module.get_executions(
            self._conn,
            since_ts=since_ts,
            until_ts=until_ts,
            account_id=account_id,
            limit=limit,
            strategy_opportunity_id=strategy_opportunity_id,
            strategy_instance_id=strategy_instance_id,
        )

    def get_executions_freshness(self) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return executions_module.get_executions_freshness(self._conn)

    def get_executions_by_contract_keys(
        self,
        contract_keys: List[Tuple[str, str, str, str]],
        account_id: Optional[str] = None,
        limit: int = 5000,
    ) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return executions_module.get_executions_by_contract_keys(self._conn, contract_keys=contract_keys, account_id=account_id, limit=limit)

    def get_executions_with_opt_pairs(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        limit: int = 200,
        strategy_opportunity_id: Optional[int] = None,
        strategy_instance_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not self._connect():
            return {"executions": [], "opt_pairs": []}
        return executions_module.get_executions_with_opt_pairs(
            self._conn,
            since_ts=since_ts,
            until_ts=until_ts,
            account_id=account_id,
            limit=limit,
            strategy_opportunity_id=strategy_opportunity_id,
            strategy_instance_id=strategy_instance_id,
        )

    def get_executions_with_opt_pairs_single_query(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        limit: int = 5000,
    ) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return executions_module.get_executions_with_opt_pairs_single_query(self._conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=limit)

    def get_net_cash_flow(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
    ) -> float:
        if not self._connect():
            return 0.0
        return executions_module.get_net_cash_flow(self._conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id)

    def get_transactions(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        limit: int = 500,
    ) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return executions_module.get_transactions(self._conn, since_ts=since_ts, until_ts=until_ts, account_id=account_id, limit=limit)

    def get_performance_stats(
        self,
        since_ts: Optional[float] = None,
        until_ts: Optional[float] = None,
        account_id: Optional[str] = None,
        granularity: str = "day",
        strategy_opportunity_id: Optional[int] = None,
        strategy_instance_id: Optional[int] = None,
    ) -> Dict[str, Any]:
        if not self._connect():
            return {}
        return executions_module.get_performance_stats(
            self._conn,
            since_ts=since_ts,
            until_ts=until_ts,
            account_id=account_id,
            granularity=granularity,
            strategy_opportunity_id=strategy_opportunity_id,
            strategy_instance_id=strategy_instance_id,
        )

    # --- Position categories (delegate to position_categories module) ---
    def get_position_categories(self) -> List[Dict[str, Any]]:
        if not self._connect():
            return []
        return position_categories_module.get_position_categories(self._conn)

    def create_position_category(
        self,
        name: str,
        description: Optional[str] = None,
        sort_order: Optional[int] = None,
    ) -> Optional[int]:
        if not self._connect():
            return None
        return position_categories_module.create_position_category(self._conn, name=name, description=description, sort_order=sort_order)

    def update_position_category(
        self,
        category_id: int,
        name: Optional[str] = None,
        description: Optional[str] = None,
        sort_order: Optional[int] = None,
    ) -> bool:
        if not self._connect():
            return False
        return position_categories_module.update_position_category(self._conn, category_id=category_id, name=name, description=description, sort_order=sort_order)

    def delete_position_category(self, category_id: int) -> bool:
        if not self._connect():
            return False
        return position_categories_module.delete_position_category(self._conn, category_id)

    def set_position_category_tag(
        self,
        account_id: str,
        contract_key: str,
        category_id: Optional[int],
    ) -> bool:
        if not self._connect():
            return False
        return position_categories_module.set_position_category_tag(self._conn, account_id=account_id, contract_key=contract_key, category_id=category_id)

    def get_market_streams_symbol_order(self) -> Dict[str, Any]:
        if not self._connect():
            return {}
        return position_categories_module.get_market_streams_symbol_order(self._conn)

    def set_market_streams_symbol_order(self, category_name: str, symbols: List[str]) -> bool:
        if not self._connect():
            return False
        return position_categories_module.set_market_streams_symbol_order(self._conn, category_name=category_name, symbols=symbols)
