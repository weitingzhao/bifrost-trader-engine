"""Market: OHLC bars, backfill jobs, trading day and holidays.
Module-level functions re-exported from legacy until full migration in step 7."""

from servers.reader._legacy import (
    add_market_holiday,
    claim_next_pending_bars_backfill_job,
    delete_all_bars_backfill_jobs,
    delete_bars_backfill_job,
    delete_market_holiday,
    delete_stock_bars_for_symbol,
    get_bars_backfill_job,
    get_bars_backfill_jobs,
    get_bars_backfill_last_updated,
    get_is_us_trading_day,
    get_market_holidays,
    insert_bars_backfill_job,
    trim_bars_backfill_jobs,
    update_bars_backfill_job_result,
    write_ohlc_bars_to_db,
    write_stock_bars,
)

__all__ = [
    "write_ohlc_bars_to_db",
    "write_stock_bars",
    "delete_stock_bars_for_symbol",
    "insert_bars_backfill_job",
    "get_bars_backfill_jobs",
    "get_bars_backfill_job",
    "delete_bars_backfill_job",
    "delete_all_bars_backfill_jobs",
    "claim_next_pending_bars_backfill_job",
    "update_bars_backfill_job_result",
    "trim_bars_backfill_jobs",
    "get_bars_backfill_last_updated",
    "get_is_us_trading_day",
    "get_market_holidays",
    "add_market_holiday",
    "delete_market_holiday",
]
