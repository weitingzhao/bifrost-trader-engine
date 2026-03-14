"""Gate safety: load gates from DB by gate_safety_strategy_id. Shape compatible with config['gates'] for get_hedge_config."""

from typing import Any, Dict, Optional

from psycopg2.extras import RealDictCursor


def get_gates_by_id(conn: Any, gate_safety_strategy_id: int) -> Optional[Dict[str, Any]]:
    """Load gates from gate_safety_* tables and return a dict in the shape of config['gates'].
    So the caller can set config['gates'] = get_gates_by_id(conn, id) and get_hedge_config(config) will work.
    Returns None if the boundary set or any required child row is missing.
    """
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT gate_safety_strategy_id, name, version, structure_type, is_active,
                       min_dte, max_dte, atm_band_pct, blackout_days_before, blackout_days_after,
                       trading_hours_only
                FROM gate_safety_strategy WHERE gate_safety_strategy_id = %s
                """,
                (gate_safety_strategy_id,),
            )
            root = cur.fetchone()
        if root is None:
            return None

        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT holiday_date FROM gate_safety_strategy_earnings_dates WHERE gate_safety_strategy_id = %s ORDER BY holiday_date",
                (gate_safety_strategy_id,),
            )
            dates_rows = cur.fetchall()
        earnings_dates = [str(r["holiday_date"]) for r in dates_rows] if dates_rows else []

        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT epsilon_band, threshold_hedge_shares, max_delta_limit, vol_window_min, stale_ts_threshold_ms, "
                "wide_spread_pct, extreme_spread_pct, data_lag_threshold_ms FROM gate_safety_state WHERE gate_safety_strategy_id = %s",
                (gate_safety_strategy_id,),
            )
            state_row = cur.fetchone()
        if state_row is None:
            return None

        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT min_hedge_shares, cooldown_seconds, max_hedge_shares_per_order, min_price_move_pct "
                "FROM gate_safety_intent WHERE gate_safety_strategy_id = %s",
                (gate_safety_strategy_id,),
            )
            intent_row = cur.fetchone()
        if intent_row is None:
            return None

        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT max_daily_hedge_count, max_position_shares, max_daily_loss_usd, max_net_delta_shares, "
                "max_spread_pct, paper_trade FROM gate_safety_guard WHERE gate_safety_strategy_id = %s",
                (gate_safety_strategy_id,),
            )
            guard_row = cur.fetchone()
        if guard_row is None:
            return None

        strategy = {
            "structure": {
                "min_dte": int(root["min_dte"]),
                "max_dte": int(root["max_dte"]),
                "atm_band_pct": float(root["atm_band_pct"]),
            },
            "earnings": {
                "blackout_days_before": int(root["blackout_days_before"]),
                "blackout_days_after": int(root["blackout_days_after"]),
                "dates": earnings_dates,
            },
            "trading_hours_only": bool(root["trading_hours_only"]),
        }
        state = {
            "delta": {
                "epsilon_band": int(state_row["epsilon_band"]),
                "threshold_hedge_shares": int(state_row["threshold_hedge_shares"]),
                "max_delta_limit": int(state_row["max_delta_limit"]),
            },
            "market": {
                "vol_window_min": int(state_row["vol_window_min"]),
                "stale_ts_threshold_ms": int(state_row["stale_ts_threshold_ms"]),
            },
            "liquidity": {
                "wide_spread_pct": float(state_row["wide_spread_pct"]),
                "extreme_spread_pct": float(state_row["extreme_spread_pct"]),
            },
            "system": {
                "data_lag_threshold_ms": int(state_row["data_lag_threshold_ms"]),
            },
        }
        intent = {
            "hedge": {
                "min_hedge_shares": int(intent_row["min_hedge_shares"]),
                "cooldown_seconds": int(intent_row["cooldown_seconds"]),
                "max_hedge_shares_per_order": int(intent_row["max_hedge_shares_per_order"]),
                "min_price_move_pct": float(intent_row["min_price_move_pct"]),
            }
        }
        guard = {
            "risk": {
                "max_daily_hedge_count": int(guard_row["max_daily_hedge_count"]),
                "max_position_shares": int(guard_row["max_position_shares"]),
                "max_daily_loss_usd": float(guard_row["max_daily_loss_usd"]),
                "max_net_delta_shares": int(guard_row["max_net_delta_shares"]),
                "max_spread_pct": float(guard_row["max_spread_pct"]),
                "paper_trade": bool(guard_row["paper_trade"]),
            }
        }
        return {
            "strategy": strategy,
            "state": state,
            "intent": intent,
            "guard": guard,
        }
    except Exception:
        return None


def get_active_gate_safety_strategy_id(conn: Any) -> Optional[int]:
    """Return settings.active_gate_safety_strategy_id for id=1, or None if missing/not set."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT active_gate_safety_strategy_id FROM settings WHERE id = 1"
            )
            row = cur.fetchone()
        if row is None or row.get("active_gate_safety_strategy_id") is None:
            return None
        return int(row["active_gate_safety_strategy_id"])
    except Exception:
        return None


def get_active_strategy_structure_id(conn: Any) -> Optional[int]:
    """Return settings.active_strategy_structure_id for id=1, or None if missing/not set."""
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                "SELECT active_strategy_structure_id FROM settings WHERE id = 1"
            )
            row = cur.fetchone()
        if row is None or row.get("active_strategy_structure_id") is None:
            return None
        return int(row["active_strategy_structure_id"])
    except Exception:
        return None
