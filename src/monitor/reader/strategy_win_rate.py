"""Aggregate strategy instance results by structure for Win Rate page."""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional, TypedDict

from psycopg2.extras import RealDictCursor

from src.monitor.reader.strategy_instance import list_instances
from src.portfolio.reader.executions import get_performance_instance_summary_only

logger = logging.getLogger(__name__)

_EXEC_FINAL = "account_executions_final"
_ALLOC_TABLE = "account_execution_instance_allocation"


class WinRatePayload(TypedDict, total=False):
    structures: List[Dict[str, Any]]
    totals_all: Optional[Dict[str, Any]]


def _batch_underlying_cost(conn: Any, instance_ids: List[int]) -> Dict[int, float]:
    """Return per-instance SELL OPT underlying cost (same definition as Instance Detail UI).

    Uses **strike × |quantity| × 100** per row (``underlyingCostSellOptUsd`` /
    ``instanceDetailPnlMetrics.ts``), not ``net_cash`` / premium.

    - If ``account_execution_instance_allocation`` exists for the fill: for each instance
      row, ``strike × abs(allocated_quantity) × 100`` (matches sliced execution ``quantity``).
    - Otherwise: ``strike × abs(execution.quantity) × 100`` for ``strategy_instance_id``.

    ``strike`` prefers ``executions.strike``; if null/zero, parses segment 4 of
    ``contract_key`` (``symbol|sec|expiry|strike|right``), same as the frontend fallback.
    """
    if not instance_ids or conn is None:
        return {}
    placeholders = ", ".join(["%s"] * len(instance_ids))
    params = tuple(instance_ids) * 4
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""
                WITH opt_sell AS (
                    SELECT e.account_executions_id,
                           e.strategy_instance_id AS direct_sid,
                           CASE
                             WHEN e.strike IS NOT NULL AND e.strike > 0 THEN e.strike::double precision
                             WHEN NULLIF(trim(split_part(COALESCE(e.contract_key, ''), '|', 4)), '') IS NOT NULL
                               THEN NULLIF(trim(split_part(COALESCE(e.contract_key, ''), '|', 4)), '')::double precision
                             ELSE NULL::double precision
                           END AS eff_strike,
                           ABS(COALESCE(e.quantity, 0)) AS abs_parent_qty
                    FROM {_EXEC_FINAL} e
                    WHERE upper(trim(COALESCE(e.side, ''))) IN ('SELL', 'SLD', 'S')
                      AND upper(trim(COALESCE(e.sec_type, ''))) = 'OPT'
                      AND (
                          e.strategy_instance_id IN ({placeholders})
                          OR EXISTS (
                              SELECT 1 FROM {_ALLOC_TABLE} a0
                              WHERE a0.account_executions_id = e.account_executions_id
                                AND a0.strategy_instance_id IN ({placeholders})
                          )
                      )
                ),
                opt_sell_ok AS (
                    SELECT * FROM opt_sell
                    WHERE eff_strike IS NOT NULL AND eff_strike > 0
                ),
                weighted_from_alloc AS (
                    SELECT a.strategy_instance_id AS sid,
                           SUM(
                               ABS(COALESCE(a.allocated_quantity, 0))
                               * 100.0
                               * o.eff_strike
                           ) AS cost
                    FROM opt_sell_ok o
                    INNER JOIN {_ALLOC_TABLE} a ON a.account_executions_id = o.account_executions_id
                    WHERE a.strategy_instance_id IN ({placeholders})
                    GROUP BY a.strategy_instance_id
                ),
                weighted_direct AS (
                    SELECT o.direct_sid AS sid,
                           SUM(o.abs_parent_qty * 100.0 * o.eff_strike) AS cost
                    FROM opt_sell_ok o
                    WHERE o.direct_sid IS NOT NULL
                      AND o.direct_sid IN ({placeholders})
                      AND NOT EXISTS (
                          SELECT 1 FROM {_ALLOC_TABLE} y
                          WHERE y.account_executions_id = o.account_executions_id
                      )
                    GROUP BY o.direct_sid
                ),
                combined AS (
                    SELECT sid, cost FROM weighted_from_alloc
                    UNION ALL
                    SELECT sid, cost FROM weighted_direct
                )
                SELECT sid, SUM(cost) AS underlying_cost
                FROM combined
                GROUP BY sid
                """,
                params,
            )
            rows = cur.fetchall()
        return {int(r["sid"]): float(r["underlying_cost"] or 0) for r in rows}
    except Exception as exc:
        logger.debug("_batch_underlying_cost failed: %s", exc)
        return {}


def _safe_avg(values: List[float]) -> Optional[float]:
    finite = [v for v in values if v is not None and math.isfinite(v)]
    return sum(finite) / len(finite) if finite else None


def _aggregate_win_rate_metrics(structure_name: str, rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """One structure row or the global 'All structures' row from per-instance rows."""
    profit = [r for r in rows if r["net_pnl"] > 0]
    loss = [r for r in rows if r["net_pnl"] <= 0]

    profit_investment_raw = sum(r["underlying_cost"] for r in profit)
    loss_investment_raw = sum(r["underlying_cost"] for r in loss)
    profit_investment = round(profit_investment_raw, 2)
    loss_investment = round(loss_investment_raw, 2)
    total_investment = round(profit_investment + loss_investment, 2)

    def _pct(r: Dict[str, Any]) -> Optional[float]:
        uc = r["underlying_cost"]
        return r["net_pnl"] / uc * 100 if uc > 0 else None

    profit_pcts = [p for r in profit if (p := _pct(r)) is not None]
    loss_pcts = [p for r in loss if (p := _pct(r)) is not None]
    all_pcts = [p for r in rows if (p := _pct(r)) is not None]

    # Sum of per-instance worst losing trade (performance summary max_loss); None if none.
    trade_loss_vals: List[float] = []
    for r in rows:
        raw = r.get("instance_trade_max_loss")
        if raw is None:
            continue
        try:
            v = float(raw)
        except (TypeError, ValueError):
            continue
        if math.isfinite(v):
            trade_loss_vals.append(v)
    total_loss = round(sum(trade_loss_vals), 2) if trade_loss_vals else None

    return {
        "structure_name": structure_name,
        "total_instances": len(rows),
        "profit_trades": len(profit),
        "loss_trades": len(loss),
        "total_profit": round(sum(r["net_pnl"] for r in rows), 2),
        "total_loss": total_loss,
        "profit_investment": profit_investment,
        "loss_investment": loss_investment,
        "total_investment": total_investment,
        "profit_avg_pct": round(_safe_avg(profit_pcts), 2) if _safe_avg(profit_pcts) is not None else None,
        "loss_avg_pct": round(_safe_avg(loss_pcts), 2) if _safe_avg(loss_pcts) is not None else None,
        "single_max_loss_pct": round(min(all_pcts), 2) if all_pcts else None,
        "profit_avg_usd": round(_safe_avg([r["net_pnl"] for r in profit]), 2) if profit else None,
        "loss_avg_usd": round(_safe_avg([r["net_pnl"] for r in loss]), 2) if loss else None,
    }


def compute_win_rate_by_structure(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
) -> WinRatePayload:
    """Return per-structure rows plus ``totals_all`` (same metrics over every instance).

    Keys:
      structures: list of per-structure dicts (see ``_aggregate_win_rate_metrics``).
      totals_all: aggregate across all instances (for All structures UI), or None if no data.
    """
    empty: WinRatePayload = {"structures": [], "totals_all": None}
    if conn is None:
        return empty

    instances = list_instances(conn)
    active = [i for i in instances if (i.get("executions_count") or 0) > 0]
    if not active:
        return empty

    ids = [i["strategy_instance_id"] for i in active]
    cost_by_id = _batch_underlying_cost(conn, ids)

    structure_rows: Dict[str, List[Dict[str, Any]]] = {}
    all_flat: List[Dict[str, Any]] = []

    for inst in active:
        sid = inst["strategy_instance_id"]
        structure_name = (inst.get("strategy_structure_name") or "Unknown").strip() or "Unknown"

        perf = get_performance_instance_summary_only(conn, sid, since_ts=since_ts, until_ts=until_ts)
        summary = perf.get("summary") or {}
        net_pnl = float(summary.get("net_pnl") or 0)
        if not math.isfinite(net_pnl):
            net_pnl = 0.0

        raw_ml = summary.get("max_loss")
        instance_trade_max_loss: Optional[float] = None
        if raw_ml is not None:
            try:
                fml = float(raw_ml)
                instance_trade_max_loss = fml if math.isfinite(fml) else None
            except (TypeError, ValueError):
                instance_trade_max_loss = None

        underlying_cost = cost_by_id.get(sid, 0.0)
        row = {
            "net_pnl": net_pnl,
            "underlying_cost": underlying_cost,
            "instance_trade_max_loss": instance_trade_max_loss,
        }
        structure_rows.setdefault(structure_name, []).append(row)
        all_flat.append(row)

    results: List[Dict[str, Any]] = []
    for structure_name, rows in sorted(structure_rows.items()):
        results.append(_aggregate_win_rate_metrics(structure_name, rows))

    totals_all = _aggregate_win_rate_metrics("All structures", all_flat)

    return {"structures": results, "totals_all": totals_all}
