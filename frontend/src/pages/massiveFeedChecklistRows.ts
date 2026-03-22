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
    service: 'Option aggregates (bars)',
    description: 'Per-contract OHLCV bars via fetch_option_aggs',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'Enqueue aggregates → query option_aggregate_bars in PostgreSQL',
    purpose: 'Backfill per-contract OHLCV bars into option_min for analysis and charts.',
    helpVerification:
      'Enqueue aggregates with options_ticker, symbol, expiry, strike, right, and a Unix ms window. Confirm rows in PostgreSQL option_min with source=massive.',
  },
  {
    id: 'greeks-iv',
    service: 'Greeks / IV on snapshot',
    description: 'Greeks and implied vol stored alongside snapshot rows',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification: 'Query option_snapshots columns (greeks stored if provider returns them)',
    purpose: 'Store implied volatility and greeks next to quotes when Massive includes them on the chain snapshot.',
    helpVerification:
      'After a successful chain snapshot, use Verify in PostgreSQL for that symbol and expiration. Check IV and greek columns; empty values mean the provider did not return them for those contracts.',
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
    purpose: 'Real-time options quotes or aggregates via Polygon/Massive WebSocket; verified offline with a script, not a long-lived UI connection.',
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
]

export default rows
