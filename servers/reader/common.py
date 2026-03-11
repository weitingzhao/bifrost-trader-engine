"""Connection and StatusReader facade. Delegates to domain modules or legacy reader."""

import logging
from typing import Any, Dict, List, Optional, Tuple

import psycopg2

from src.sink.postgres_sink import _get_conn_params

from servers.reader import status as status_module

logger = logging.getLogger(__name__)

# Default return when _connect() fails (legacy uses None, [], {}, 0.0 for different methods).
_DEFAULT_ON_CONNECT_FAIL: Dict[str, Any] = {
    "get_operations": [],
    "get_executions": [],
    "get_executions_freshness": [],
    "get_executions_by_contract_keys": [],
    "get_executions_with_opt_pairs": {"executions": [], "opt_pairs": []},
    "get_executions_with_opt_pairs_single_query": [],
    "get_transactions": [],
    "get_market_holidays": [],
    "get_bars": [],
    "get_bars_stats": [],
    "get_bars_coverage": [],
    "get_watchlist": [],
    "get_position_categories": [],
    "get_key_value_groups": [],
    "get_key_values_by_group": [],
    "get_all_key_values": [],
    "get_net_cash_flow": 0.0,
    "get_performance_stats": {},
    "get_risk_summary": {},
    "get_flex_config": [],  # when purpose is not None
}


class StatusReader:
    """Read status_current and operations from PostgreSQL. Uses the same root postgres config as daemon.
    Facade: holds connection and delegates to legacy reader (then to domain modules after migration)."""

    def __init__(self, status_config: dict) -> None:
        self._config = status_config
        self._conn: Any = None
        self._legacy: Any = None

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

    def _get_legacy(self) -> Any:
        if self._legacy is None:
            from servers.reader._legacy import StatusReader as LegacyStatusReader
            self._legacy = LegacyStatusReader(self._config)
        return self._legacy

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(f"StatusReader has no attribute {name!r}")
        # Already implemented above (status domain)
        if name in ("get_status_current", "get_run_status", "get_daemon_heartbeat", "get_operations"):
            raise AttributeError(f"StatusReader has no attribute {name!r}")
        default = _DEFAULT_ON_CONNECT_FAIL.get(name, None)
        legacy = self._get_legacy()
        method = getattr(legacy, name)

        def wrapper(*args: Any, **kwargs: Any) -> Any:
            if not self._connect():
                return default
            legacy._conn = self._conn
            return method(*args, **kwargs)

        return wrapper
