"""Aggregate strategy instance results by structure for Win Rate page."""

from __future__ import annotations

import logging
import math
from typing import Any, Dict, List, Optional

from psycopg2.extras import RealDictCursor

from src.monitor.reader.strategy_instance import list_instances
from src.portfolio.reader.executions import get_performance_instance_summary_only

logger = logging.getLogger(__name__)

_EXEC_FINAL = "account_executions_final"
_ALLOC_TABLE = "account_execution_instance_allocation"


def _batch_underlying_cost(conn: Any, instance_ids: List[int]) -> Dict[int, float]:
    """Return per-instance SELL OPT premium (underlying cost) attributed like realized PnL.

    Matches ``weight_realized_for_strategy_instance`` in ``executions.py``:
    - If ``account_execution_instance_allocation`` rows exist for the fill, each instance
      gets ``full_premium * abs(alloc_qty) / sum(abs(alloc_qty))`` (only instances in
      ``instance_ids`` are summed in the result row for that sid).
    - Otherwise, the full premium goes to ``strategy_instance_id`` on the execution when
      that id is in ``instance_ids``.

    No double-count between direct and allocation paths.
    """
    if not instance_ids or conn is None:
        return {}
    placeholders = ", ".join(["%s"] * len(instance_ids))
    params = tuple(instance_ids) * 4
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                f"""
                WITH sell_opt_execs AS (
                    SELECT e.account_executions_id,
                           e.strategy_instance_id AS direct_sid,
                           ABS(COALESCE(e.net_cash, e.price * ABS(COALESCE(e.quantity, 0)) * 100, 0)) AS full_cost
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
                alloc_denom AS (
                    SELECT account_executions_id,
                           SUM(ABS(COALESCE(allocated_quantity, 0))) AS denom
                    FROM {_ALLOC_TABLE}
                    WHERE account_executions_id IN (SELECT account_executions_id FROM sell_opt_execs)
                    GROUP BY account_executions_id
                ),
                weighted_from_alloc AS (
                    SELECT a.strategy_instance_id AS sid,
                           SUM(
                               s.full_cost * (
                                   ABS(COALESCE(a.allocated_quantity, 0)) / NULLIF(d.denom, 0)
                               )
                           ) AS cost
                    FROM sell_opt_execs s
                    INNER JOIN {_ALLOC_TABLE} a ON a.account_executions_id = s.account_executions_id
                    INNER JOIN alloc_denom d ON d.account_executions_id = s.account_executions_id
                    WHERE a.strategy_instance_id IN ({placeholders})
                    GROUP BY a.strategy_instance_id
                ),
                weighted_direct AS (
                    SELECT s.direct_sid AS sid,
                           SUM(s.full_cost) AS cost
                    FROM sell_opt_execs s
                    WHERE s.direct_sid IS NOT NULL
                      AND s.direct_sid IN ({placeholders})
                      AND NOT EXISTS (
                          SELECT 1 FROM {_ALLOC_TABLE} y
                          WHERE y.account_executions_id = s.account_executions_id
                      )
                    GROUP BY s.direct_sid
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


def compute_win_rate_by_structure(
    conn: Any,
    since_ts: Optional[float] = None,
    until_ts: Optional[float] = None,
) -> List[Dict[str, Any]]:
    """Return per-structure win-rate metrics aggregated from all instances with executions.

    Each item in the returned list represents one strategy_structure, with these keys:
      structure_name, total_instances,
      profit_trades, loss_trades,
      total_profit, single_max_loss,
      profit_investment, loss_investment, total_investment
        (sum of underlying cost on profit instances, on loss instances, and their sum),
      profit_avg_pct, loss_avg_pct, single_max_loss_pct,
      profit_avg_usd, loss_avg_usd
    """
    if conn is None:
        return []

    instances = list_instances(conn)
    active = [i for i in instances if (i.get("executions_count") or 0) > 0]
    if not active:
        return []

    ids = [i["strategy_instance_id"] for i in active]
    cost_by_id = _batch_underlying_cost(conn, ids)

    # Per-instance metrics keyed by structure
    structure_rows: Dict[str, List[Dict[str, Any]]] = {}

    for inst in active:
        sid = inst["strategy_instance_id"]
        structure_name = (inst.get("strategy_structure_name") or "Unknown").strip() or "Unknown"

        perf = get_performance_instance_summary_only(conn, sid, since_ts=since_ts, until_ts=until_ts)
        summary = perf.get("summary") or {}
        net_pnl = float(summary.get("net_pnl") or 0)
        if not math.isfinite(net_pnl):
            net_pnl = 0.0

        underlying_cost = cost_by_id.get(sid, 0.0)

        structure_rows.setdefault(structure_name, []).append(
            {"net_pnl": net_pnl, "underlying_cost": underlying_cost}
        )

    results: List[Dict[str, Any]] = []
    for structure_name, rows in sorted(structure_rows.items()):
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

        results.append({
            "structure_name": structure_name,
            "total_instances": len(rows),
            "profit_trades": len(profit),
            "loss_trades": len(loss),
            "total_profit": round(sum(r["net_pnl"] for r in rows), 2),
            "single_max_loss": round(min((r["net_pnl"] for r in loss), default=0.0), 2),
            "profit_investment": profit_investment,
            "loss_investment": loss_investment,
            "total_investment": total_investment,
            "profit_avg_pct": round(_safe_avg(profit_pcts), 2) if _safe_avg(profit_pcts) is not None else None,
            "loss_avg_pct": round(_safe_avg(loss_pcts), 2) if _safe_avg(loss_pcts) is not None else None,
            "single_max_loss_pct": round(min(all_pcts), 2) if all_pcts else None,
            "profit_avg_usd": round(_safe_avg([r["net_pnl"] for r in profit]), 2) if profit else None,
            "loss_avg_usd": round(_safe_avg([r["net_pnl"] for r in loss]), 2) if loss else None,
        })

    return results
