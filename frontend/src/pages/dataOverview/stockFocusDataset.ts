/**
 * Watchlist Stocks matrix — fundamental (FDN) datasets only; no staging/report layers yet.
 * Table names align with PostgreSQL (ticker_types was formerly ticker_instrument_types).
 */

export type StocksFocusTableId =
  | 'stock_day'
  | 'stock_min'
  | 'tickers'
  | 'ticker_overview'
  | 'ticker_types'

export type StocksFocusDataset = 'all' | 'fundamental' | StocksFocusTableId

const FUNDAMENTAL_TABLES: StocksFocusTableId[] = [
  'stock_day',
  'stock_min',
  'tickers',
  'ticker_overview',
  'ticker_types',
]

export const STOCKS_FOCUS_TABLE_IDS: StocksFocusTableId[] = [...FUNDAMENTAL_TABLES]

export function showStocksFocusTable(focus: StocksFocusDataset, table: StocksFocusTableId): boolean {
  if (focus === 'all') return true
  if (focus === 'fundamental') return FUNDAMENTAL_TABLES.includes(table)
  return focus === table
}
