export interface ChecklistRow {
  id: string
  service: string
  description: string
  tierMin: 'starter' | 'developer'
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
  {
    id: 'reference',
    service: 'Reference / contracts',
    description: 'Expirations and strikes for an underlying',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'GET /research/option-expirations?provider=massive or Research → Option Discovery',
    purpose: 'Resolve option expirations and strikes for an underlying before building chains or screens.',
    helpVerification:
      'Call GET /research/option-expirations?symbol=SYMBOL&provider=massive. In the app, use Research → Option Discovery which uses the same API when Massive is configured.',
  },
  {
    id: 'snapshot',
    service: 'Chain snapshot',
    description: 'Full option chain quotes persisted to option_snapshots',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'Enqueue snapshot → GET /research/option-snapshots or Verify section below',
    purpose: 'Pull a delayed full chain from Massive REST and persist bid/ask/last and greeks when returned.',
    helpVerification:
      'Enqueue a snapshot job for an underlying, wait until done, then GET /research/option-snapshots?symbol=&expiration=&source=massive or use Verify below.',
  },
  {
    id: 'aggregates',
    service: 'Option aggregates',
    description:
      'Five aggregate endpoints: REST Custom Bars (OHLCV over custom range), Daily Ticker Summary (open/close for a date), Previous Day Bar (last trading day OHLC); WebSocket per-second (A) and per-minute (AM) streams.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'REST: Enqueue aggregates with mode custom_bars | open_close | prev → check Job queue result. WS: run verify script with --channel "A.O:…" or "AM.O:…".',
    purpose:
      'Custom Bars backfills per-contract bars for charting and backtesting. Daily Summary provides single-day open/close + pre/after-hours. Previous Day gives a quick baseline without calendar math. WS A/AM deliver real-time second/minute bars for live monitoring.',
    helpVerification:
      'Custom Bars: Enqueue aggregates (mode custom_bars or omit mode) with options_ticker, symbol, expiry, strike, right, start_ms, end_ms. Open/Close: mode open_close with options_ticker + date (YYYY-MM-DD). Previous Day: mode prev with options_ticker. WS: copy the verify command from the Option aggregates section and run in a terminal.',
  },
  {
    id: 'greeks-iv',
    service: 'Greeks / IV',
    description:
      'IV, delta, gamma, theta, vega, and open interest from chain, contract, and unified snapshot endpoints. DB Verify tab shows per-row quality; chain snapshot reports coverage stats.',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Greeks/IV section: Chain Snapshot (enqueue + coverage stats), Contract Snapshot (single-contract greeks), DB Verify (expanded table with all greeks + quality summary), Unified Snapshot.',
    purpose:
      'Retrieve, persist, and verify implied volatility and greeks (delta, gamma, theta, vega) from Massive snapshot endpoints. Coverage and freshness metrics quantify data quality.',
    helpVerification:
      '1) Chain Snapshot tab: enqueue a chain snapshot for an underlying, then Check Coverage to see IV/greeks fill rates from GET /research/massive/greeks-coverage. '
      + '2) Contract Snapshot tab: look up a single contract\'s greeks and break-even price. '
      + '3) DB Verify tab: load stored rows from PostgreSQL; the quality summary shows with_iv, full_greeks, and OI counts. '
      + '4) Unified tab: cross-ticker greeks comparison via GET /v3/snapshot with type=options.',
  },
  {
    id: 'daily-oi',
    service: 'Daily open interest',
    description: 'Historical daily OI backfill into option_open_interest_daily',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification: 'GET /research/option-oi — worker OI placeholder only',
    purpose: 'Track daily open interest per contract; full Massive OI backfill may be added later.',
    helpVerification:
      'GET /research/option-oi?symbol=… returns rows from option_open_interest_daily when populated. The OI enqueue job is a placeholder; chain snapshot may include OI when available.',
  },
  {
    id: 'trades',
    service: 'Option trades',
    description:
      'Per Massive: not included on Starter; Developer tier may include trade ticks (see trades_enabled). This is a plan/tier limit, not a missing app feature when your tier excludes it.',
    tierMin: 'developer',
    requiresTrades: true,
    projectStatus: 'not-implemented',
    verification:
      'GET /research/option-trades — 403 when not entitled per Massive tier; when entitled, Celery sync is not wired yet in this app.',
    purpose: 'Optional tick-level option trades ingestion when your plan enables trades_enabled.',
    helpVerification:
      'Call GET /research/option-trades?symbol=… . HTTP 403 with a message means trades are disabled by tier or config. When entitled, stored rows appear in option_trades after sync is implemented.',
  },
  {
    id: 'corporate-actions',
    service: 'Corporate actions',
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
  {
    id: 'websocket',
    service: 'WebSocket streaming',
    description:
      'Options Starter includes WS access. A standalone verification script is provided; the engine does not maintain a persistent WS bridge.',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification:
      'Run: python scripts/verify_massive_options_ws.py --config config/config.dev.yaml — prints auth status and first messages from the options WS feed.',
    purpose: 'Real-time options quotes via Polygon/Massive WebSocket; verified offline with a script. For aggregate channels (A/AM), see the Option aggregates section.',
    helpVerification:
      'From the repo root, run the verify script with your config. Starter plans often use the delayed WebSocket host; the script may retry automatically. Expect subscription success and occasional data during market hours.',
    testHint: 'Browser cannot run the Python script; copy the command to a terminal.',
  },
  {
    id: 'celery-queue',
    service: 'Celery massive queue',
    description: 'Worker consuming the dedicated `massive` task queue',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification:
      'Settings → Feed → Celery (Massive queue table) or Feed → Massive Option — POST /research/massive/sync + GET /research/massive/jobs; worker needs -Q massive',
    purpose: 'Background execution of Massive sync jobs so the API server stays responsive.',
    helpVerification:
      'Start a Celery worker with -Q massive. Enqueue any sync job; GET /research/massive/jobs should show pending → running → done. Use Settings → Feed → Celery for the same job list shortcut.',
  },
  {
    id: 'contracts',
    service: 'Contracts',
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
    id: 'market-ops',
    service: 'Market Ops',
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
  {
    id: 'technical-indicators',
    service: 'Technical Indicators',
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
]

export default rows
