import type { ChecklistRow, CapabilityGroup } from './massiveFeedChecklistRows'
export type { ChecklistRow, CapabilityGroup }
export { CAPABILITY_GROUP_LABELS, CAPABILITY_GROUP_ORDER } from './massiveFeedChecklistRows'

const rows: ChecklistRow[] = [
  // ── REST API (6 Sections, matching coverage CSV order) ──
  {
    id: 'stock-reference',
    service: 'Reference Data',
    group: 'rest',
    description:
      'Stock ticker universe, company details, ticker types, news, and financial statements via Massive REST reference endpoints.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose:
      'Browse and look up stock tickers, company metadata, news, and fundamentals from Massive. Foundation for screening and research.',
    helpVerification:
      'Not yet implemented. Target endpoints: GET /v3/reference/tickers, GET /v3/reference/tickers/{ticker}, '
      + 'GET /v3/reference/tickers/types, GET /v2/reference/news, GET /vX/reference/financials.',
  },
  {
    id: 'stock-aggregates',
    service: 'Aggregate Bars (OHLC)',
    group: 'rest',
    description:
      'Four REST aggregate endpoints for stocks: Custom Bars (OHLCV over custom range), Grouped Daily (all tickers for a date), '
      + 'Daily Open/Close, and Previous Close.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose:
      'Backfill stock OHLCV bars from Massive as a complement to IB historical data. Grouped Daily enables universe-wide screening.',
    helpVerification:
      'Not yet implemented. Target endpoints: GET /v2/aggs/ticker/{ticker}/range/…, '
      + 'GET /v2/aggs/grouped/locale/us/market/stocks/{date}, GET /v1/open-close/{ticker}/{date}, '
      + 'GET /v2/aggs/ticker/{ticker}/prev.',
  },
  {
    id: 'stock-snapshots',
    service: 'Snapshots',
    group: 'rest',
    description:
      'Real-time snapshots: All Tickers (universe-wide), Single Ticker, and Gainers/Losers. '
      + '15-minute delay on Starter tier.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose:
      'Quick current-state lookups for stocks. All Tickers snapshot enables screener inputs; Gainers/Losers for market movers.',
    helpVerification:
      'Not yet implemented. Target endpoints: GET /v2/snapshot/locale/us/markets/stocks/tickers, '
      + 'GET /v2/snapshot/locale/us/markets/stocks/tickers/{ticker}, '
      + 'GET /v2/snapshot/locale/us/markets/stocks/{direction}.',
  },
  {
    id: 'stock-trades-quotes',
    service: 'Trades & Quotes',
    group: 'rest',
    description:
      'Four REST endpoints: Historical Trades, Last Trade, Historical Quotes (NBBO), and Last Quote (NBBO).',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose:
      'Query tick-level trade and quote data for stocks. Useful for spread analysis, trade tape replay, and real-time lookups.',
    helpVerification:
      'Not yet implemented. Target endpoints: GET /v3/trades/{ticker}, GET /v2/last/trade/{ticker}, '
      + 'GET /v3/quotes/{ticker}, GET /v2/last/nbbo/{ticker}.',
  },
  {
    id: 'stock-technical-indicators',
    service: 'Technical Indicators',
    group: 'rest',
    description:
      'Shared cross-asset technical indicators from Massive REST: SMA, EMA, RSI, MACD. '
      + 'Already implemented for options; works with stock tickers natively.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Settings → Feed → Massive Option → Technical Indicators: enter a stock ticker (e.g. AAPL) instead of an options ticker.',
    purpose:
      'Compute and display technical indicators for stock tickers via Massive API. Same implementation as Massive Option.',
    helpVerification:
      'Use the existing Technical Indicators UI in Massive Option. Enter a plain stock ticker (AAPL, NVDA) '
      + 'instead of an options ticker. The SMA/EMA/RSI/MACD endpoints accept both formats.',
  },
  {
    id: 'stock-market-ops',
    service: 'Market Operations',
    group: 'rest',
    description:
      'Shared reference data: trade/quote condition codes, exchanges, market holidays, and market status. '
      + 'Already implemented in Massive Option.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Settings → Feed → Massive Option → Market Ops: same endpoints serve stocks and options data.',
    purpose:
      'Lookup cross-asset reference data from Massive. These endpoints are shared across all asset types.',
    helpVerification:
      'Use the existing Market Ops UI in Massive Option. Condition codes support asset_class filter; '
      + 'exchanges cover all asset classes; holidays and status are market-wide.',
  },
  // ── Project (derived workflows) ──
  {
    id: 'stock-corporate-actions',
    service: 'Corporate Actions',
    group: 'project',
    description:
      'Dividends and stock splits synced via Massive REST to massive_corporate_action table. '
      + 'Already implemented and shared with Massive Option.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Settings → Feed → Massive Option → Corporate actions: enqueue sync for a ticker, then Load from DB.',
    purpose: 'Sync stock dividends and splits from Massive reference APIs into PostgreSQL.',
    helpVerification:
      'POST /research/massive/sync with kind corporate_action and payload { "symbol": "AAPL" }. '
      + 'Then GET /research/massive/corporate-actions?symbol=AAPL&limit=50. '
      + 'UI: Massive Option → Corporate actions → Enqueue sync, then Load from DB.',
  },
  // ── WebSocket ──
  {
    id: 'stock-ws-aggregates-s',
    service: 'Aggregates (Per Second)',
    group: 'ws',
    description: 'WebSocket per-second aggregate bars for stocks channel A.{ticker}.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose: 'Stream second-by-second OHLCV bars for a stock ticker in real time.',
    helpVerification:
      'Not yet implemented. Target: wss://socket.polygon.io/stocks, subscribe to A.{ticker}.',
  },
  {
    id: 'stock-ws-aggregates-m',
    service: 'Aggregates (Per Minute)',
    group: 'ws',
    description: 'WebSocket per-minute aggregate bars for stocks channel AM.{ticker}.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose: 'Stream minute-by-minute OHLCV bars for a stock ticker in real time.',
    helpVerification:
      'Not yet implemented. Target: wss://socket.polygon.io/stocks, subscribe to AM.{ticker}.',
  },
  {
    id: 'stock-ws-trades',
    service: 'Trades',
    group: 'ws',
    description: 'WebSocket tick-level trades for stocks channel T.{ticker}.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose: 'Stream tick-by-tick trade prints for a stock ticker.',
    helpVerification:
      'Not yet implemented. Target: wss://socket.polygon.io/stocks, subscribe to T.{ticker}.',
  },
  {
    id: 'stock-ws-quotes',
    service: 'Quotes',
    group: 'ws',
    description: 'WebSocket real-time NBBO quotes for stocks channel Q.{ticker}.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — not yet implemented.',
    purpose: 'Stream top-of-book bid/ask updates for a stock ticker.',
    helpVerification:
      'Not yet implemented. Target: wss://socket.polygon.io/stocks, subscribe to Q.{ticker}.',
  },
  // ── Flat Files ──
  {
    id: 'stock-flat-file-day-aggs',
    service: 'Day aggregates',
    group: 'flat',
    description: 'Daily OHLCV across all US stocks as downloadable S3 flat file.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of daily stock aggregates from S3.',
    helpVerification: 'Not yet available. See Massive documentation for S3 flat file access.',
  },
  {
    id: 'stock-flat-file-minute-aggs',
    service: 'Minute aggregates',
    group: 'flat',
    description: 'Minute-level OHLCV across all US stocks as downloadable S3 flat file.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of minute-level stock aggregates from S3.',
    helpVerification: 'Not yet available. See Massive documentation for S3 flat file access.',
  },
  {
    id: 'stock-flat-file-trades',
    service: 'Trades',
    group: 'flat',
    description: 'Tick-level stock trades with nanosecond timestamps as downloadable S3 flat file. Requires Developer tier.',
    tierMin: 'developer',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of tick-level stock trades from S3.',
    helpVerification: 'Not yet available. Requires Developer tier. See Massive documentation for S3 flat file access.',
  },
  {
    id: 'stock-flat-file-quotes',
    service: 'Quotes',
    group: 'flat',
    description: 'Top-of-book stock quotes with nanosecond timestamps as downloadable S3 flat file.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of top-of-book stock quotes from S3.',
    helpVerification: 'Not yet available. See Massive documentation for S3 flat file access.',
  },
]

export default rows
