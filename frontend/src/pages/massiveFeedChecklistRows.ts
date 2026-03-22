export interface ChecklistRow {
  id: string
  service: string
  description: string
  tierMin: 'starter' | 'developer'
  requiresTrades?: boolean
  projectStatus: 'implemented' | 'partial' | 'not-implemented'
  verification: string
}

const rows: ChecklistRow[] = [
  {
    id: 'reference',
    service: 'Reference / contracts',
    description: 'Expirations and strikes for an underlying',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'GET /research/option-expirations?provider=massive or Research → Option Discovery',
  },
  {
    id: 'snapshot',
    service: 'Chain snapshot',
    description: 'Full option chain quotes persisted to option_snapshots',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'Enqueue snapshot → GET /research/option-snapshots or Verify section below',
  },
  {
    id: 'aggregates',
    service: 'Option aggregates (bars)',
    description: 'Per-contract OHLCV bars via fetch_option_aggs',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'Enqueue aggregates → query option_aggregate_bars in PostgreSQL',
  },
  {
    id: 'greeks-iv',
    service: 'Greeks / IV on snapshot',
    description: 'Greeks and implied vol stored alongside snapshot rows',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification: 'Query option_snapshots columns (greeks stored if provider returns them)',
  },
  {
    id: 'daily-oi',
    service: 'Daily open interest',
    description: 'Historical daily OI backfill into option_open_interest_daily',
    tierMin: 'starter',
    projectStatus: 'partial',
    verification: 'GET /research/option-oi — worker OI placeholder only',
  },
  {
    id: 'trades',
    service: 'Option trades',
    description: 'Real-time or historical option trade ticks',
    tierMin: 'developer',
    requiresTrades: true,
    projectStatus: 'not-implemented',
    verification: 'GET /research/option-trades (403 if tier insufficient)',
  },
  {
    id: 'corporate-actions',
    service: 'Corporate actions',
    description: 'Splits, dividends, and other corporate events',
    tierMin: 'developer',
    projectStatus: 'not-implemented',
    verification: 'N/A — roadmap',
  },
  {
    id: 'websocket',
    service: 'WebSocket streaming',
    description: 'Live quote stream via Massive WS endpoint',
    tierMin: 'developer',
    projectStatus: 'not-implemented',
    verification: 'N/A — roadmap',
  },
  {
    id: 'celery-queue',
    service: 'Celery massive queue',
    description: 'Worker consuming the dedicated `massive` task queue',
    tierMin: 'starter',
    projectStatus: 'implemented',
    verification: 'POST /research/massive/sync + GET /research/massive/jobs — requires -Q massive worker',
  },
]

export default rows
