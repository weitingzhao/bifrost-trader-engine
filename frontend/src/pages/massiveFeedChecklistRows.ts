export type CapabilityGroup = 'rest' | 'project' | 'ws' | 'flat'

export const CAPABILITY_GROUP_LABELS: Record<CapabilityGroup, string> = {
  rest: 'REST API',
  project: 'Project',
  ws: 'WebSocket',
  flat: 'Flat Files',
}

export const CAPABILITY_GROUP_ORDER: CapabilityGroup[] = ['rest', 'ws', 'flat', 'project']

export interface ChecklistRow {
  id: string
  service: string
  group: CapabilityGroup
  description: string
  tierMin: 'starter' | 'developer' | 'business'
  requiresTrades?: boolean
  projectStatus: 'implemented' | 'partial' | 'not-implemented'
  verification: string
  /** Short purpose for help panel (English UI). */
  purpose: string
  /** Step-by-step verification detail for help panel. */
  helpVerification: string
  /** Optional note for CLI-only or browser-limited tests. */
  testHint?: string
}

const rows: ChecklistRow[] = [
  // ── REST API (6 Sections, matching coverage CSV order) ──
  {
    id: 'contracts',
    service: 'Contracts',
    group: 'rest',
    description:
      'Option contract reference listing, single-contract detail lookup, DB coverage verification, and contract-to-snapshot linking via Massive REST.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Contracts section: Contracts List (fetch filtered list via Celery), Contract Detail (single ticker metadata), DB Verify (option_contracts coverage & mapping), Snapshot Link (contract → snapshot end-to-end).',
    purpose:
      'Discover, inspect, and verify option contract reference data from Massive. Coverage and mapping metrics quantify local data quality against the API source of truth.',
    helpVerification:
      '1) Contracts List tab: enqueue a contracts job for an underlying, optionally filter by expiration/type/limit. '
      + '2) Contract Detail tab: enter a Polygon options ticker to retrieve full metadata (expiry, strike, right, exercise_style, shares_per_contract). '
      + '3) DB Verify tab: Check Coverage queries GET /research/massive/contracts-coverage for mapping stats. '
      + '4) Snapshot Link tab: trigger a contract-level snapshot for end-to-end verification.',
  },
  {
    id: 'aggregates',
    service: 'Aggregate Bars (OHLC)',
    group: 'rest',
    description:
      'Three REST aggregate endpoints: Custom Bars (OHLCV over custom range), Daily Ticker Summary (open/close for a date), and Previous Day Bar (last trading day OHLC).',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'REST: Enqueue aggregates with mode custom_bars | open_close | prev → check Job queue result.',
    purpose:
      'Custom Bars backfills per-contract bars for charting and backtesting. Daily Summary provides single-day open/close + pre/after-hours. Previous Day gives a quick baseline without calendar math.',
    helpVerification:
      'Custom Bars: Enqueue aggregates (mode custom_bars or omit mode) with options_ticker, symbol, expiry, strike, right, start_ms, end_ms. Open/Close: mode open_close with options_ticker + date (YYYY-MM-DD). Previous Day: mode prev with options_ticker.',
  },
  {
    id: 'snapshot',
    service: 'Snapshots',
    group: 'rest',
    description: 'Full option chain quotes persisted to option_snapshots',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'Enqueue snapshot → GET /research/option-snapshots or Verify section below',
    purpose: 'Pull a delayed full chain from Massive REST and persist bid/ask/last and greeks when returned.',
    helpVerification:
      'Enqueue a snapshot job for an underlying, wait until done, then GET /research/option-snapshots?symbol=&expiration=&source=massive or use Verify below.',
  },
  {
    id: 'trades-quotes',
    service: 'Trade & Quotes',
    group: 'rest',
    description:
      'Three REST endpoints: Last Trade, Historical Quotes, Historical Trades. '
      + 'Last trade and historical quotes are available on Starter tier; historical trades require Developer tier and trades_enabled.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Trades & Quotes section: Last Trade / Historical Quotes / Historical Trades (REST tabs). Trades-specific tab shows tier gate when trades_enabled is off.',
    purpose:
      'Query and verify option trade and quote data from Massive REST. Last Trade gives the most recent fill; Historical Quotes retrieves BBO history; Historical Trades provides tick-level fills.',
    helpVerification:
      '1) Last Trade tab: enter an options ticker, click Fetch. Returns the most recent trade price/size/exchange/timestamp. '
      + '2) Historical Quotes tab: enter an options ticker + optional timestamp range, click Fetch. Returns BBO quote history. '
      + '3) Historical Trades tab: enter an options ticker + optional timestamp range, click Fetch. Requires Developer tier.',
  },
  {
    id: 'technical-indicators',
    service: 'Technical Indicators',
    group: 'rest',
    description:
      'Read-only cross-asset technical indicators from Massive REST: SMA, EMA, RSI, MACD. Supports both option tickers (O: prefix) and stock/index tickers with customizable window, timespan, and series type.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Technical Indicators section: SMA / EMA / RSI / MACD tabs. Each tab: enter ticker + parameters, click Fetch, view data table.',
    purpose:
      'Compute and display technical indicators for option and equity tickers via Massive API. Enables trend analysis, momentum assessment, and signal generation for trading decisions.',
    helpVerification:
      '1) SMA tab: enter an option ticker (O:SPY251219C00600000) or stock ticker (AAPL), set window/timespan, click Fetch. Expect timestamped values. '
      + '2) EMA tab: same flow, EMA weights recent prices more heavily. '
      + '3) RSI tab: same flow, values between 0-100 (>70 overbought, <30 oversold). '
      + '4) MACD tab: configure short/long/signal windows, click Fetch. Expect value, signal, and histogram columns.',
  },
  {
    id: 'market-ops',
    service: 'Market Operations',
    group: 'rest',
    description:
      'Read-only reference data: trade/quote condition codes, exchange listings, upcoming market holidays (with local calendar comparison), and real-time market trading status.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Market Ops section: Conditions (fetch condition codes by asset class/data type), Exchanges (list by asset class/locale), Market Holidays (Massive vs local comparison), Market Status (real-time open/close).',
    purpose:
      'Lookup and verify cross-asset reference data directly from Massive. The holiday tab also provides a side-by-side comparison with the local reference_us_holidays table.',
    helpVerification:
      '1) Conditions tab: select asset class and data type filters, click Fetch. Expect a table of condition IDs, names, and descriptions. '
      + '2) Exchanges tab: filter by asset class/locale, click Fetch. Expect exchange rows with MIC codes and URLs. '
      + '3) Market Holidays tab: click Fetch & Compare. Shows Massive holidays, local holidays, and a diff summary (in both / massive only / local only). '
      + '4) Market Status tab: click Fetch. Displays current status cards for each market (equities, options, forex, crypto, etc.).',
  },
  // ── Project (derived workflows, not in REST Options taxonomy) ──
  {
    id: 'reference',
    service: 'Reference / contracts',
    group: 'project',
    description: 'Expirations and strikes for an underlying',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'GET /research/option-expirations?provider=massive or Research → Option Discovery',
    purpose: 'Resolve option expirations and strikes for an underlying before building chains or screens.',
    helpVerification:
      'Call GET /research/option-expirations?symbol=SYMBOL&provider=massive. In the app, use Research → Option Discovery which uses the same API when Massive is configured.',
  },
  {
    id: 'daily-oi',
    service: 'Daily open interest',
    group: 'project',
    description: 'Historical daily OI backfill into option_open_interest_daily',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification: 'GET /research/option-oi — worker OI placeholder only',
    purpose: 'Track daily open interest per contract; full Massive OI backfill may be added later.',
    helpVerification:
      'GET /research/option-oi?symbol=… returns rows from option_open_interest_daily when populated. The OI enqueue job is a placeholder; chain snapshot may include OI when available.',
  },
  {
    id: 'corporate-actions',
    service: 'Corporate actions',
    group: 'project',
    description:
      'Dividends and splits synced via Massive REST to massive_corporate_action table.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Settings → Feed → Massive Option → Corporate actions: Enqueue sync for a ticker, then Load from DB. Or: POST /research/massive/sync kind=corporate_action, then GET /research/massive/corporate-actions?symbol=AAPL.',
    purpose: 'Sync stock dividends and splits from Massive reference APIs into PostgreSQL for corporate-action awareness.',
    helpVerification:
      'POST /research/massive/sync with kind corporate_action and payload { "symbol": "AAPL" }. Then GET /research/massive/corporate-actions?symbol=AAPL&limit=50. UI: Enqueue sync, then Load from DB.',
  },
  // ── WebSocket (5 Sections, matching coverage CSV order) ──
  {
    id: 'ws-aggregates-s',
    service: 'Aggregates (Per Second)',
    group: 'ws',
    description: 'WebSocket per-second aggregate bars for options channel A.O:{optionsTicker}.',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification:
      'WebSocket → Aggregates (Per Second): copy verify command with --channel "A.O:…" and run in terminal.',
    purpose: 'Stream second-by-second OHLCV bars for a single options contract in real time.',
    helpVerification:
      'Open WebSocket → Aggregates (Per Second), copy command, run python scripts/verify_massive_options_ws.py --config ... --channel "A.O:...".',
    testHint: 'Browser cannot run the Python script; copy the command to a terminal.',
  },
  {
    id: 'ws-aggregates-m',
    service: 'Aggregates (Per Minute)',
    group: 'ws',
    description: 'WebSocket per-minute aggregate bars for options channel AM.O:{optionsTicker}.',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification:
      'WebSocket → Aggregates (Per Minute): copy verify command with --channel "AM.O:…" and run in terminal.',
    purpose: 'Stream minute-by-minute OHLCV bars for a single options contract in real time.',
    helpVerification:
      'Open WebSocket → Aggregates (Per Minute), copy command, run python scripts/verify_massive_options_ws.py --config ... --channel "AM.O:...".',
    testHint: 'Browser cannot run the Python script; copy the command to a terminal.',
  },
  {
    id: 'ws-quotes',
    service: 'Quotes',
    group: 'ws',
    description: 'WebSocket real-time BBO quotes for options channel Q.O:{optionsTicker}.',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification:
      'WebSocket → Quotes: copy verify command with --channel "Q.O:…" and run in terminal.',
    purpose: 'Stream top-of-book bid/ask updates for a single options contract.',
    helpVerification:
      'Open WebSocket → Quotes, copy command, run python scripts/verify_massive_options_ws.py --config ... --channel "Q.O:...".',
    testHint: 'Browser cannot run the Python script; copy the command to a terminal.',
  },
  {
    id: 'ws-trades',
    service: 'Trades',
    group: 'ws',
    description: 'WebSocket tick-level trades for options channel T.O:{optionsTicker}. Requires Developer tier and trades_enabled.',
    tierMin: 'developer',
    requiresTrades: true,
    projectStatus: 'partial',
    verification:
      'WebSocket → Trades: copy verify command with --channel "T.O:…" and run in terminal.',
    purpose: 'Stream tick-by-tick trade prints for a single options contract.',
    helpVerification:
      'Open WebSocket → Trades, copy command, run python scripts/verify_massive_options_ws.py --config ... --channel "T.O:...".',
    testHint: 'Browser cannot run the Python script; copy the command to a terminal.',
  },
  {
    id: 'fmv',
    service: 'Fair Market Value',
    group: 'ws',
    description:
      'Fair Market Value streaming via WebSocket channel FMV.O:{optionsTicker}. '
      + 'Delivers real-time fair market value estimates for option contracts. Requires Business tier.',
    tierMin: 'business',
    projectStatus: 'partial',
    verification:
      'WebSocket → Fair Market Value: WS FMV Channel tab provides a one-click copy of the verify command '
      + 'for python scripts/verify_massive_options_ws.py with --channel "FMV.O:…". '
      + 'Tier & Delivery tab explains entitlement and latency semantics.',
    purpose:
      'Stream real-time fair market value estimates for option contracts via Massive WebSocket. '
      + 'FMV provides a single consolidated price that reflects the best available fair value.',
    helpVerification:
      '1) WS FMV Channel tab: enter an options ticker, copy the verify command, run in a terminal. '
      + 'Expect auth success, subscription confirmation, and FMV messages during market hours. '
      + '2) Tier & Delivery tab: informational; describes Business tier requirement, latency, and delivery semantics.',
  },
  // ── WebSocket: Connectivity verification (not a Massive doc section) ──
  {
    id: 'websocket',
    service: 'Connectivity verification',
    group: 'ws',
    description:
      'Options Starter includes WS access. A standalone verification script is provided; the engine does not maintain a persistent WS bridge.',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification:
      'Run: python scripts/verify_massive_options_ws.py --config config/config.dev.yaml — prints auth status and first messages from the options WS feed.',
    purpose: 'Verify WebSocket connectivity via CLI script. Not a Massive doc section — local verify entry point.',
    helpVerification:
      'From the repo root, run the verify script with your config. Starter plans often use the delayed WebSocket host; the script may retry automatically. Expect subscription success and occasional data during market hours.',
    testHint: 'Browser cannot run the Python script; copy the command to a terminal.',
  },
  {
    id: 'flat-file-day-aggs',
    service: 'Day aggregates',
    group: 'flat',
    description: 'Daily OHLCV across all US options as downloadable S3 flat file.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of daily aggregates for all US options from S3. Alternative to REST per-contract aggregates.',
    helpVerification: 'Not yet available in this project. See Massive documentation for S3 flat file access.',
  },
  {
    id: 'flat-file-minute-aggs',
    service: 'Minute aggregates',
    group: 'flat',
    description: 'Minute-level OHLCV across all US options as downloadable S3 flat file.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of minute-level aggregates for all US options from S3.',
    helpVerification: 'Not yet available in this project. See Massive documentation for S3 flat file access.',
  },
  {
    id: 'flat-file-quotes',
    service: 'Quotes',
    group: 'flat',
    description: 'Top-of-book quotes with nanosecond timestamps as downloadable S3 flat file.',
    tierMin: 'starter',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of top-of-book option quotes from S3 for historical analysis.',
    helpVerification: 'Not yet available in this project. See Massive documentation for S3 flat file access.',
  },
  {
    id: 'flat-file-trades',
    service: 'Trades',
    group: 'flat',
    description: 'Tick-level trades with nanosecond timestamps as downloadable S3 flat file. Requires Developer tier.',
    tierMin: 'developer',
    projectStatus: 'not-implemented',
    verification: 'N/A — bulk download not yet integrated.',
    purpose: 'Bulk download of tick-level option trades from S3 for detailed historical analysis.',
    helpVerification: 'Not yet available in this project. Requires Developer tier. See Massive documentation for S3 flat file access.',
  },
]

export default rows
