"""Accounts/positions/executions refresh from IB. Used by GsTrading."""

import logging
from typing import Any, List

from src.portfolio.positions.portfolio import get_stock_shares

logger = logging.getLogger(__name__)


def _connector_for_read(app: Any) -> Any:
    """Prefer Listener for read-only account/position/market data so logic does not depend on Trading Client.
    Returns listener_connector if connected, else app.connector (or None if neither connected)."""
    if getattr(app, "_use_ib_edge", False):
        return None
    listener = getattr(app, "listener_connector", None)
    if listener and getattr(listener, "is_connected", False):
        return listener
    return getattr(app, "connector", None)


async def _fetch_secondary_accounts_list(connector: Any) -> List[dict]:
    """Fetch account list from a secondary connector (listener_connector_2). Returns list of {account_id, summary, positions}."""
    if not connector or not getattr(connector, "is_connected", False):
        return []
    try:
        account_ids = connector.get_managed_accounts()
        if not account_ids:
            return []
        all_positions = await connector.get_positions(account=None)
        out: List[dict] = []
        for account_id in account_ids:
            values = await connector.get_account_summary(account=account_id)
            summary = {}
            for v in values:
                if getattr(v, "tag", None) and getattr(v, "value", None) is not None:
                    summary[v.tag] = v.value
            if account_id:
                summary["account"] = account_id
            acct_positions = [p for p in all_positions if getattr(p, "account", None) == account_id]
            pos_dicts = [connector.position_to_dict(p) for p in acct_positions]
            out.append({"account_id": account_id, "summary": summary, "positions": pos_dicts})
        return out
    except Exception as e:
        logger.warning("[R-A1] _fetch_secondary_accounts_list: %s", e, exc_info=True)
        return []


async def refresh_accounts_data(app: Any) -> None:
    """R-A1: fetch all managed accounts' summary + positions from IB; store for monitoring and set host account for trading.
    Uses Listener for read when connected so logic does not depend on Trading Client; falls back to Trading connector.
    IB managedAccounts is comma-separated; we get each account's summary and filter positions by account from one reqPositions.
    """
    if getattr(app, "_use_ib_edge", False):
        from src.daemon.ib_edge import refresh_accounts_from_redis_edge

        await refresh_accounts_from_redis_edge(app)
        return
    conn = _connector_for_read(app)
    if not conn or not getattr(conn, "is_connected", False):
        return
    try:
        account_ids = conn.get_managed_accounts()
        if not account_ids:
            logger.warning(
                "[R-A1] get_managed_accounts returned 0 accounts (IB may use comma-separated string)"
            )
            return
        logger.info("[R-A1] managed accounts: %s", account_ids)
        # Request all positions once, then filter by account (avoids N reqPositionsAsync and ensures same snapshot)
        all_positions = await conn.get_positions(account=None)
        accounts_list: list = []
        host_id = None
        host_summary = None
        # R-A4: use configured host_account_id if it is in the managed list; otherwise first account
        if app._host_account_id and app._host_account_id in account_ids:
            host_id = app._host_account_id
        for account_id in account_ids:
            values = await conn.get_account_summary(account=account_id)
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
            pos_dicts = [conn.position_to_dict(p) for p in acct_positions]
            accounts_list.append(
                {
                    "account_id": account_id,
                    "summary": summary,
                    "positions": pos_dicts,
                }
            )
            if host_id is None and account_id:
                host_id = account_id
                host_summary = summary if summary else None
            elif host_id == account_id:
                host_summary = summary if summary else None
        # Secondary IB: merge listener_connector_2 accounts so account/account_positions include both
        listener_2 = getattr(app, "listener_connector_2", None)
        if listener_2 is not None:
            secondary_list = await _fetch_secondary_accounts_list(listener_2)
            if secondary_list:
                secondary_ids = {a["account_id"] for a in secondary_list}
                merged = [a for a in accounts_list if a.get("account_id") not in secondary_ids] + secondary_list
                accounts_list = merged
                logger.info("[R-A1] merged Secondary accounts: %s", [a["account_id"] for a in secondary_list])
        app.store.set_accounts_data(accounts_list)
        app.store.set_account_summary(host_id, host_summary)
        logger.info(
            "[R-A1] accounts_data count=%s (host=%s)",
            len(accounts_list),
            host_id,
        )
        # R-A2: 拉取账户执行/成交并写入 account_executions，供复盘与 GET /executions (use same read connector)
        if app._status_sink and hasattr(app._status_sink, "write_account_executions"):
            try:
                if hasattr(app._status_sink, "update_execution_commission"):
                    conn.set_commission_report_callback(
                        lambda eid, c, pnl, cur, y_, yrd, sink=app._status_sink: sink.update_execution_commission(
                            eid, c, pnl, cur, y_, yrd
                        )
                    )
                for acc_id in account_ids:
                    exec_list = await conn.get_executions_async(account=acc_id)
                    if exec_list:
                        app._status_sink.write_account_executions(exec_list)
            except Exception as ex:
                logger.debug("[R-A2] get_executions_async/write_account_executions: %s", ex)
            finally:
                try:
                    conn.set_commission_report_callback(None)
                except Exception:
                    pass
    except Exception as e:
        logger.warning("_refresh_accounts_data: %s", e, exc_info=True)


async def refresh_secondary_accounts_and_sync(app: Any) -> None:
    """Fetch Secondary (listener_connector_2) accounts, merge into store, and sync only Secondary to account/account_positions.
    Called from Secondary position callback so DB stays in sync without full snapshot write."""
    listener_2 = getattr(app, "listener_connector_2", None)
    if not listener_2 or not getattr(listener_2, "is_connected", False):
        return
    if not app._status_sink or not hasattr(app._status_sink, "sync_accounts_only"):
        return
    try:
        secondary_list = await _fetch_secondary_accounts_list(listener_2)
        if not secondary_list:
            return
        current = list(app.store.get_accounts_data() or [])
        secondary_ids = {a["account_id"] for a in secondary_list}
        merged = [a for a in current if a.get("account_id") not in secondary_ids] + secondary_list
        app.store.set_accounts_data(merged)
        app._status_sink.sync_accounts_only(secondary_list)
    except Exception as e:
        logger.warning("[R-A1] refresh_secondary_accounts_and_sync: %s", e, exc_info=True)


async def refresh_executions_only(app: Any) -> None:
    """R-A2: 仅从 IB 拉取账户执行/成交并写入 account_executions，供复盘与风控 Tab 使用。
    与 _refresh_accounts_data 解耦：复盘 Tab 的刷新只做此事，不拉账户摘要与持仓。Uses Listener for read when connected."""
    if getattr(app, "_use_ib_edge", False):
        from src.daemon.ib_edge import refresh_accounts_from_redis_edge

        await refresh_accounts_from_redis_edge(app)
        return
    conn = _connector_for_read(app)
    if not conn or not getattr(conn, "is_connected", False):
        return
    if not app._status_sink or not hasattr(app._status_sink, "write_account_executions"):
        return
    try:
        account_ids = conn.get_managed_accounts()
        if not account_ids:
            return
        if hasattr(app._status_sink, "update_execution_commission"):
            conn.set_commission_report_callback(
                lambda eid, c, pnl, cur, y_, yrd, sink=app._status_sink: sink.update_execution_commission(
                    eid, c, pnl, cur, y_, yrd
                )
            )
        for acc_id in account_ids:
            exec_list = await conn.get_executions_async(account=acc_id)
            if exec_list:
                app._status_sink.write_account_executions(exec_list)
        total_accounts = len(account_ids)
        # Secondary IB: same for listener_connector_2
        listener_2 = getattr(app, "listener_connector_2", None)
        if listener_2 is not None and getattr(listener_2, "is_connected", False):
            if hasattr(app._status_sink, "update_execution_commission"):
                listener_2.set_commission_report_callback(
                    lambda eid, c, pnl, cur, y_, yrd, sink=app._status_sink: sink.update_execution_commission(
                        eid, c, pnl, cur, y_, yrd
                    )
                )
            try:
                acc_ids_2 = listener_2.get_managed_accounts()
                for acc_id in acc_ids_2 or []:
                    exec_list = await listener_2.get_executions_async(account=acc_id)
                    if exec_list:
                        app._status_sink.write_account_executions(exec_list)
                total_accounts += len(acc_ids_2 or [])
            finally:
                try:
                    listener_2.set_commission_report_callback(None)
                except Exception:
                    pass
        logger.info("[R-A2] _refresh_executions_only: synced executions for %s accounts", total_accounts)
    except Exception as ex:
        logger.warning("[R-A2] _refresh_executions_only: %s", ex, exc_info=True)
    finally:
        try:
            if conn:
                conn.set_commission_report_callback(None)
        except Exception:
            pass


async def refresh_positions(app: Any) -> None:
    """Fetch positions from IB and update store (raw positions + stock_shares only). No option parse. R-A1: use account_id when available. Uses Listener for read when connected."""
    if getattr(app, "_use_ib_edge", False):
        from src.daemon.ib_edge import refresh_accounts_from_redis_edge

        await refresh_accounts_from_redis_edge(app)
        return
    conn = _connector_for_read(app)
    if not conn or not getattr(conn, "is_connected", False):
        return
    account = app.store.get_account_id()
    positions = await conn.get_positions(account=account)
    app._set_active_symbol(app._infer_active_symbol(positions))
    stock_shares = get_stock_shares(positions, app.symbol) if app.symbol else 0
    app.store.set_positions(positions, stock_shares)
