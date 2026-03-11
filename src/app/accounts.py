"""Accounts/positions/executions refresh from IB. Used by GsTrading."""

import logging
from typing import Any

from src.positions.portfolio import get_stock_shares

logger = logging.getLogger(__name__)


async def refresh_accounts_data(app: Any) -> None:
    """R-A1: fetch all managed accounts' summary + positions from IB; store for monitoring and set primary account for trading.
    IB managedAccounts is comma-separated; we get each account's summary and filter positions by account from one reqPositions.
    """
    if not app.connector.is_connected:
        return
    try:
        account_ids = app.connector.get_managed_accounts()
        if not account_ids:
            logger.warning(
                "[R-A1] get_managed_accounts returned 0 accounts (IB may use comma-separated string)"
            )
            return
        logger.info("[R-A1] managed accounts: %s", account_ids)
        # Request all positions once, then filter by account (avoids N reqPositionsAsync and ensures same snapshot)
        all_positions = await app.connector.get_positions(account=None)
        accounts_list: list = []
        primary_id = None
        primary_summary = None
        # R-A4: use configured primary_account_id if it is in the managed list; otherwise first account
        if app._primary_account_id and app._primary_account_id in account_ids:
            primary_id = app._primary_account_id
        for account_id in account_ids:
            values = await app.connector.get_account_summary(account=account_id)
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
            pos_dicts = [app.connector.position_to_dict(p) for p in acct_positions]
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
            elif primary_id == account_id:
                primary_summary = summary if summary else None
        app.store.set_accounts_data(accounts_list)
        app.store.set_account_summary(primary_id, primary_summary)
        logger.info(
            "[R-A1] accounts_data count=%s (primary=%s)",
            len(accounts_list),
            primary_id,
        )
        # R-A2: 拉取账户执行/成交并写入 account_executions，供复盘与 GET /executions
        if app._status_sink and hasattr(app._status_sink, "write_account_executions"):
            try:
                if hasattr(app._status_sink, "update_execution_commission"):
                    app.connector.set_commission_report_callback(
                        lambda eid, c, pnl, cur, y_, yrd, sink=app._status_sink: sink.update_execution_commission(
                            eid, c, pnl, cur, y_, yrd
                        )
                    )
                for acc_id in account_ids:
                    exec_list = await app.connector.get_executions_async(account=acc_id)
                    if exec_list:
                        app._status_sink.write_account_executions(exec_list)
            except Exception as ex:
                logger.debug("[R-A2] get_executions_async/write_account_executions: %s", ex)
            finally:
                try:
                    app.connector.set_commission_report_callback(None)
                except Exception:
                    pass
    except Exception as e:
        logger.warning("_refresh_accounts_data: %s", e, exc_info=True)


async def refresh_executions_only(app: Any) -> None:
    """R-A2: 仅从 IB 拉取账户执行/成交并写入 account_executions，供复盘与风控 Tab 使用。
    与 _refresh_accounts_data 解耦：复盘 Tab 的刷新只做此事，不拉账户摘要与持仓。"""
    if not app.connector.is_connected:
        return
    if not app._status_sink or not hasattr(app._status_sink, "write_account_executions"):
        return
    try:
        account_ids = app.connector.get_managed_accounts()
        if not account_ids:
            return
        if hasattr(app._status_sink, "update_execution_commission"):
            app.connector.set_commission_report_callback(
                lambda eid, c, pnl, cur, y_, yrd, sink=app._status_sink: sink.update_execution_commission(
                    eid, c, pnl, cur, y_, yrd
                )
            )
        for acc_id in account_ids:
            exec_list = await app.connector.get_executions_async(account=acc_id)
            if exec_list:
                app._status_sink.write_account_executions(exec_list)
        logger.info("[R-A2] _refresh_executions_only: synced executions for %s accounts", len(account_ids))
    except Exception as ex:
        logger.warning("[R-A2] _refresh_executions_only: %s", ex, exc_info=True)
    finally:
        try:
            app.connector.set_commission_report_callback(None)
        except Exception:
            pass


async def refresh_positions(app: Any) -> None:
    """Fetch positions from IB and update store (raw positions + stock_shares only). No option parse. R-A1: use account_id when available."""
    account = app.store.get_account_id()
    positions = await app.connector.get_positions(account=account)
    app._set_active_symbol(app._infer_active_symbol(positions))
    stock_shares = get_stock_shares(positions, app.symbol) if app.symbol else 0
    app.store.set_positions(positions, stock_shares)
