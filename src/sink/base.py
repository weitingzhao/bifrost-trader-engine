"""StatusSink abstract interface for writing state snapshots and operation records.

See docs/DATABASE.md for table schemas and write strategy.
"""

from abc import ABC, abstractmethod
from typing import Any, Dict


# Snapshot dict keys (R-M1a). Must match docs/DATABASE.md §2.1.
SNAPSHOT_KEYS = (
    "daemon_state",
    "trading_state",
    "symbol",
    "spot",
    "bid",
    "ask",
    "net_delta",
    "stock_position",
    "option_legs_count",
    "daily_hedge_count",
    "daily_pnl",
    "data_lag_ms",
    "config_summary",
    "ts",
)

# R-A1 optional snapshot keys (account summary). Written when present.
OPTIONAL_SNAPSHOT_KEYS = (
    "account_id",
    "account_net_liquidation",
    "account_total_cash",
    "account_buying_power",
)
# R-A1 multi-account: JSON column for list of { account_id, summary, positions }
ACCOUNTS_SNAPSHOT_KEY = "accounts_snapshot"

# Operation record dict keys (R-M4a). Must match docs/DATABASE.md §2.3.
OPERATION_KEYS = ("ts", "type", "side", "quantity", "price", "state_reason")


class StatusSink(ABC):
    """Abstract sink for writing current state snapshot and operation records.

    Implementations (e.g. PostgreSQLSink) persist to backend; caller (GsTrading)
    decides when to write and whether to append to history (write_snapshot(..., append_history=True)).
    """

    @abstractmethod
    def write_snapshot(self, snapshot: Dict[str, Any], append_history: bool = False) -> None:
        """Write state snapshot. Updates current view; optionally appends to history table.

        snapshot: dict with keys from SNAPSHOT_KEYS (daemon_state, trading_state, symbol, spot, ...).
        append_history: if True, also append one row to status_history; if False, only update status_current.
        """
        ...

    @abstractmethod
    def write_operation(self, record: Dict[str, Any]) -> None:
        """Write one operation record (hedge_intent, order_sent, fill, reject, cancel).

        record: dict with keys from OPERATION_KEYS (ts, type, side, quantity, price, state_reason).
        """
        ...

    # 可选：按合约写入持仓标的当前价（R-M6，多标的按 contract_key 逐标的拉价 + 写库）
    # 默认实现为空，具体 sink（如 PostgreSQLSink）可选择性实现。
    def write_instrument_prices(self, rows: Any) -> None:  # rows: Iterable[Dict[str, Any]]
        return
