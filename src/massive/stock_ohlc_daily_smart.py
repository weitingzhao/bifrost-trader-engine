"""UTC ms range for feed_stocks_aggregate daily_smart (gap-fill vs full empty-DB backfill).

When the DB has no Massive daily bars, we request a calendar window of
``full_backfill_years`` (from server config: Starter default 5y, Developer default 20y).
Polygon/Massive still only return aggregates allowed by the API key's plan; that
vendor cap is independent of this window.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")

# Defaults documented with get_massive_settings() — not used directly when config supplies years.
DAILY_FULL_BACKFILL_YEARS_STARTER = 5.0
DAILY_FULL_BACKFILL_YEARS_DEVELOPER = 20.0

DAILY_GAP_OVERLAP_TRADING_DAYS = 2


def days_for_calendar_years(years: float) -> int:
    """Approximate calendar span used for empty-DB daily backfill (365 days per year)."""
    y = max(1.0, min(50.0, float(years)))
    return int(y * 365)


def ny_calendar_today() -> date:
    return datetime.now(NY).date()


def date_to_utc_epoch_ms_day_start(d: date) -> int:
    dt = datetime(d.year, d.month, d.day, tzinfo=NY)
    return int(dt.timestamp() * 1000)


def date_to_utc_epoch_ms_day_end_inclusive(d: date) -> int:
    nxt = d + timedelta(days=1)
    dt = datetime(nxt.year, nxt.month, nxt.day, tzinfo=NY)
    return int(dt.timestamp() * 1000) - 1


def ms_to_ny_date(ms: int) -> date:
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc).astimezone(NY).date()


def subtract_n_trading_days_before_calendar_day(
    status_cfg: dict,
    anchor_calendar_day: date,
    n: int,
) -> date:
    """
    Walk backward from (anchor_calendar_day - 1 day), counting n US trading days;
    return the date of the n-th trading day landed on (inclusive earliest fetch day).
    """
    from src.monitor.reader.market import get_is_us_trading_day

    cur = anchor_calendar_day - timedelta(days=1)
    moved = 0
    for _ in range(800):
        if moved >= n:
            break
        if get_is_us_trading_day(status_cfg, cur.isoformat()):
            moved += 1
            if moved == n:
                return cur
        cur -= timedelta(days=1)
    return cur


def full_backfill_start_date(end_d: date, *, full_backfill_years: float) -> date:
    return end_d - timedelta(days=days_for_calendar_years(full_backfill_years))


def compute_daily_smart_range(
    status_cfg: dict,
    max_bar_date: Optional[date],
    end_cap_ms: Optional[int],
    full_backfill_years: float,
) -> Tuple[int, int, str, Dict[str, Any]]:
    """
    Returns (start_ms, end_ms, policy, meta).

    policy: full_20y | gapfill_overlap  (full_20y kept for UI compat — means empty-DB full window)
    meta includes resolved_start_date, resolved_end_date (ISO), daily_sync_policy, full_backfill_years.
    """
    if end_cap_ms is not None and end_cap_ms > 0:
        end_d = ms_to_ny_date(int(end_cap_ms))
    else:
        end_d = ny_calendar_today()

    y = max(1.0, min(50.0, float(full_backfill_years)))

    if max_bar_date is None:
        start_d = full_backfill_start_date(end_d, full_backfill_years=y)
        policy = "full_20y"
    else:
        gap_next_calendar = max_bar_date + timedelta(days=1)
        start_d = subtract_n_trading_days_before_calendar_day(
            status_cfg,
            gap_next_calendar,
            DAILY_GAP_OVERLAP_TRADING_DAYS,
        )
        policy = "gapfill_overlap"

    meta: Dict[str, Any] = {
        "resolved_start_date": start_d.isoformat(),
        "resolved_end_date": end_d.isoformat(),
        "daily_sync_policy": policy,
        "max_bar_date": max_bar_date.isoformat() if max_bar_date else None,
        "full_backfill_years": y,
    }
    start_ms = date_to_utc_epoch_ms_day_start(start_d)
    end_ms = date_to_utc_epoch_ms_day_end_inclusive(end_d)
    return start_ms, end_ms, policy, meta


__all__ = [
    "DAILY_FULL_BACKFILL_YEARS_DEVELOPER",
    "DAILY_FULL_BACKFILL_YEARS_STARTER",
    "DAILY_GAP_OVERLAP_TRADING_DAYS",
    "compute_daily_smart_range",
    "days_for_calendar_years",
    "full_backfill_start_date",
    "ms_to_ny_date",
    "ny_calendar_today",
    "subtract_n_trading_days_before_calendar_day",
]
