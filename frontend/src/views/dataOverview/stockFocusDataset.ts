/**
 * Watchlist Stocks matrix — watchlist-scoped bars (stock_day, stock_min) only.
 * Reference utilities (tickers, ticker_overview, ticker_types) are full-universe tables
 * and are surfaced outside the watchlist matrix on Data Overview → Detail.
 */

/** Columns in the per-watchlist-symbol matrix (OHLC bars). */
export type WatchlistStocksTableId = 'stock_day' | 'stock_min'

/** PostgreSQL reference tables covering the full instruments universe (not watchlist-specific). */
export type StocksUtilitiesTableId = 'tickers' | 'ticker_overview' | 'ticker_types'

export type StocksFocusTableId = WatchlistStocksTableId

export type StocksFocusDataset = 'all' | 'fundamental' | WatchlistStocksTableId

const WATCHLIST_BAR_TABLES: WatchlistStocksTableId[] = ['stock_day', 'stock_min']

/** IDs that participate in unified watchlist focus chips (Detail). */
export const STOCKS_WATCHLIST_FOCUS_TABLE_IDS: WatchlistStocksTableId[] = [...WATCHLIST_BAR_TABLES]

export const STOCKS_UTILITIES_TABLE_IDS: StocksUtilitiesTableId[] = [
  'tickers',
  'ticker_overview',
  'ticker_types',
]

export function showStocksFocusTable(focus: StocksFocusDataset, table: StocksFocusTableId): boolean {
  if (focus === 'all') return true
  if (focus === 'fundamental') return WATCHLIST_BAR_TABLES.includes(table)
  return focus === table
}
