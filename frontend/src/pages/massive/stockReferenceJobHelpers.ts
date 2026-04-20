import type { MassiveJobApiRow, TickerReferenceJobKind } from '../../api'
import type { MassiveStockTickersSubTab } from './feedMassiveStockTabUtils'

export const MAX_REF_JOBS_TRACKED = 20

/** Session-tracked Massive stock job scope (extend for future REST domains). */
export type MassiveStockRefJobDomain = 'tickers' | 'ohlc'

/** Jobs shown in the shared session sheet (ticker_reference_* and feed_stocks_aggregate; legacy `stock_ohlc_sync`). */
export type TrackedMassiveDbJobKind = TickerReferenceJobKind | 'feed_stocks_aggregate' | 'stock_ohlc_sync'

export type RefJobTrackItem = {
  jobId: string
  kind: TrackedMassiveDbJobKind
  domain?: MassiveStockRefJobDomain
  deduplicated?: boolean
  status: string
  job?: MassiveJobApiRow
  streamError?: string
  enqueuedAt: number
}

/** First catalog block under Enqueue reference jobs (add more sections alongside later). */
export const REF_TICKER_JOB_CATALOG = {
  sectionTitle: 'Ticker reference',
  sectionSubtitle: 'POST /research/massive/jobs/ticker-reference',
  sectionId: 'ref-jobs-catalog-ticker-reference',
} as const

export const MAX_REF_JOB_SYMBOLS = 100

export function parseRefJobSymbols(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
}

export function validateRefJobSymbolsForEnqueue(
  symbols: string[],
): { ok: true } | { ok: false; message: string } {
  if (symbols.length === 0) {
    return { ok: false, message: 'Enter at least one symbol.' }
  }
  if (symbols.length > MAX_REF_JOB_SYMBOLS) {
    return { ok: false, message: `At most ${MAX_REF_JOB_SYMBOLS} symbols allowed.` }
  }
  return { ok: true }
}

/** Max length for ``GET .../reference/tickers/search`` query param (backend ``max_length``). */
export const MAX_TICKER_REF_SEARCH_Q = 128

/** Max ``limit`` for ticker reference search (backend ``le=100``). */
export const MAX_TICKER_REF_SEARCH_LIMIT = 100

export const DEFAULT_TICKER_REF_SEARCH_LIMIT = 20

/** Page size for missing-overview / missing-related / filled-related lists (backend ``le=2000``). */
export const MAX_TICKER_REF_MISSING_LIMIT = 2000
export const DEFAULT_TICKER_REF_MISSING_LIMIT = 2000

export function validateMissingOverviewLimit(
  n: number,
): { ok: true; value: number } | { ok: false; message: string } {
  if (!Number.isFinite(n)) {
    return { ok: false, message: 'Limit must be a number.' }
  }
  const v = Math.floor(n)
  if (v < 1 || v > MAX_TICKER_REF_MISSING_LIMIT) {
    return { ok: false, message: `Limit must be between 1 and ${MAX_TICKER_REF_MISSING_LIMIT}.` }
  }
  return { ok: true, value: v }
}

export function validateTickerRefSearchQuery(
  q: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const t = q.trim()
  if (!t) {
    return { ok: false, message: 'Enter a search query.' }
  }
  if (t.length > MAX_TICKER_REF_SEARCH_Q) {
    return { ok: false, message: `Query must be at most ${MAX_TICKER_REF_SEARCH_Q} characters.` }
  }
  return { ok: true, value: t }
}

export function validateSearchLimit(
  n: number,
): { ok: true; value: number } | { ok: false; message: string } {
  if (!Number.isFinite(n)) {
    return { ok: false, message: 'Limit must be a number.' }
  }
  const v = Math.floor(n)
  if (v < 1 || v > MAX_TICKER_REF_SEARCH_LIMIT) {
    return { ok: false, message: `Limit must be between 1 and ${MAX_TICKER_REF_SEARCH_LIMIT}.` }
  }
  return { ok: true, value: v }
}

const _SINGLE_SYMBOL_RE = /^[A-Z0-9][A-Z0-9.-]*$/

export function validateSingleTickerSymbol(
  raw: string,
): { ok: true; value: string } | { ok: false; message: string } {
  const s = raw.trim().toUpperCase()
  if (!s) {
    return { ok: false, message: 'Enter a ticker symbol.' }
  }
  if (!_SINGLE_SYMBOL_RE.test(s)) {
    return { ok: false, message: 'Invalid ticker format (letters, digits, dot, hyphen).' }
  }
  return { ok: true, value: s }
}

export type OverviewEnqueueMode = 'missing' | 'stale' | 'symbols' | 'all'

/** Same scope modes as Overview; used for ``feed_stocks_tickers_related`` enqueue payload. */
export type RelatedEnqueueMode = OverviewEnqueueMode

/** Subtitles for PostgreSQL column (English UI). */
export const REF_CATALOG_PG_LABELS = {
  business: 'Business tables',
  job: 'Job tables',
} as const

/** Static rows for the ticker reference enqueue catalog (UI metadata only). */
export const REF_TICKER_JOB_ROWS: ReadonlyArray<{
  kind: TickerReferenceJobKind
  queueNote: string
  hint: string
  needsSymbols: boolean
  /** Short Massive REST path (Polygon-style); deep-link opens matching Tickers sub-tab on Massive Stock page. */
  restEndpointShort: string
  tickersSubTab: MassiveStockTickersSubTab
  /** Domain / market data tables (see massive.tasks ticker_reference_*). */
  businessTables: readonly string[]
  /** Job bookkeeping (cursors, massive_backfill job rows, etc.). */
  jobTables: readonly string[]
}> = [
  {
    kind: 'feed_stocks_tickers_reference_universe',
    queueNote: 'massive_stocks_high',
    hint: 'Full pagination until no cursor (1000 rows/page, sort ticker asc).',
    needsSymbols: false,
    restEndpointShort: 'GET v3/ref/tickers',
    tickersSubTab: 'all_tickers',
    businessTables: ['tickers'],
    jobTables: ['job_ticker_reference_state'],
  },
  {
    kind: 'feed_stocks_tickers_types',
    queueNote: 'massive_stocks_high',
    hint: 'Replaces all rows from the API (truncate + insert).',
    needsSymbols: false,
    restEndpointShort: 'GET v3/ref/tickers/types',
    tickersSubTab: 'ticker_types',
    businessTables: ['ticker_types'],
    jobTables: [],
  },
  {
    kind: 'feed_stocks_tickers_overview',
    queueNote: 'massive_stocks',
    hint:
      'Payload mode: missing (no ticker_overview row), stale (missing or older than stale_hours), symbols (list), or all tickers.',
    needsSymbols: false,
    restEndpointShort: 'GET v3/ref/tickers/{t}',
    tickersSubTab: 'ticker_overview',
    businessTables: ['tickers', 'ticker_overview'],
    jobTables: [],
  },
  {
    kind: 'feed_stocks_tickers_related',
    queueNote: 'massive_stocks',
    hint:
      'Payload mode: missing (no related rows), stale (missing or older than stale_hours by MAX(fetched_at)), symbols (list), or all tickers.',
    needsSymbols: false,
    restEndpointShort: 'GET v1/related/{t}',
    tickersSubTab: 'related_tickers',
    businessTables: ['ticker_related_tickers'],
    jobTables: [],
  },
]

export type RefTickerCatalogRow = (typeof REF_TICKER_JOB_ROWS)[number]

export function getRefCatalogRow(kind: TickerReferenceJobKind) {
  return REF_TICKER_JOB_ROWS.find(
    r =>
      r.kind === kind ||
      ((kind === 'ticker_reference_universe' || kind === 'stock_reference_universe') &&
        r.kind === 'feed_stocks_tickers_reference_universe') ||
      ((kind === 'ticker_reference_ticker_types' ||
        kind === 'ticker_reference_instrument_types' ||
        kind === 'stock_reference_instrument_types') &&
        r.kind === 'feed_stocks_tickers_types') ||
      (kind === 'ticker_reference_related' && r.kind === 'feed_stocks_tickers_related') ||
      (kind === 'ticker_reference_overview' && r.kind === 'feed_stocks_tickers_overview'),
  )
}

/** Related-tickers backfill job (canonical ``feed_stocks_tickers_related``; legacy ``ticker_reference_related``). */
export function isFeedStocksTickersRelatedRefKind(kind: string | undefined): boolean {
  return kind === 'feed_stocks_tickers_related' || kind === 'ticker_reference_related'
}

/** Ticker overview backfill job (canonical feed_stocks_tickers_overview; legacy ticker_reference_overview). */
export function isFeedStocksTickersOverviewRefKind(kind: string | undefined): boolean {
  return kind === 'feed_stocks_tickers_overview' || kind === 'ticker_reference_overview'
}

/** Full tickers universe sync (canonical feed_stocks_tickers_reference_universe; legacy names). */
export function isFeedStocksTickersReferenceUniverseRefKind(kind: string | undefined): boolean {
  return (
    kind === 'feed_stocks_tickers_reference_universe' ||
    kind === 'ticker_reference_universe' ||
    kind === 'stock_reference_universe'
  )
}

/** Ticker types dictionary job (canonical feed_stocks_tickers_types; legacy names). */
export function isFeedStocksTickersTypesRefKind(kind: string | undefined): boolean {
  return (
    kind === 'feed_stocks_tickers_types' ||
    kind === 'ticker_reference_ticker_types' ||
    kind === 'ticker_reference_instrument_types' ||
    kind === 'stock_reference_instrument_types'
  )
}

export function refJobKindShortLabel(kind: TrackedMassiveDbJobKind): string {
  switch (kind) {
    case 'feed_stocks_aggregate':
    case 'stock_ohlc_sync':
      return 'Stock OHLC'
    case 'feed_stocks_tickers_reference_universe':
    case 'ticker_reference_universe':
    case 'stock_reference_universe':
      return 'Universe'
    case 'feed_stocks_tickers_overview':
    case 'ticker_reference_overview':
    case 'stock_reference_overview':
      return 'Overview'
    case 'feed_stocks_tickers_related':
    case 'ticker_reference_related':
    case 'stock_reference_related':
      return 'Related'
    case 'feed_stocks_tickers_types':
    case 'ticker_reference_ticker_types':
    case 'ticker_reference_instrument_types':
    case 'stock_reference_instrument_types':
      return 'Ticker types'
    default:
      return kind
  }
}

export function refJobKindDisplayLabel(item: RefJobTrackItem): string {
  if (item.kind !== 'feed_stocks_aggregate' && item.kind !== 'stock_ohlc_sync') {
    return refJobKindShortLabel(item.kind)
  }
  const r = item.job?.result as Record<string, unknown> | undefined
  const summary = r?.summary as Record<string, unknown> | undefined
  const mode =
    typeof summary?.custom_bars_sync_mode === 'string'
      ? summary.custom_bars_sync_mode
      : undefined
  if (mode === 'daily_smart') {
    return 'Stock OHLC · smart'
  }
  return refJobKindShortLabel(item.kind)
}

export function summarizeRefJobResult(job: MassiveJobApiRow | undefined): string {
  const r = job?.result as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object') return '—'
  if (typeof r.error === 'string') return r.error
  const phase = typeof r.phase === 'string' ? r.phase.toLowerCase() : ''
  const summary = r.summary as Record<string, unknown> | undefined
  if (summary && typeof summary === 'object') {
    const pd = summary.period_detail as Record<string, unknown> | undefined
    if (
      summary.custom_bars_sync_mode === 'daily_smart' &&
      pd &&
      typeof pd.resolved_start_date === 'string' &&
      typeof pd.resolved_end_date === 'string'
    ) {
      const pol =
        pd.daily_sync_policy === 'full_20y'
          ? 'full'
          : pd.daily_sync_policy === 'gapfill_overlap'
            ? 'gapfill'
            : String(pd.daily_sync_policy ?? '')
      const rows = typeof r.rows_upserted === 'number' ? r.rows_upserted : null
      return `${pol} ${pd.resolved_start_date}→${pd.resolved_end_date} · rows ${String(rows ?? '—')}`
    }
    if (
      summary.custom_bars_sync_mode === 'daily_smart' &&
      summary.symbols_requested != null
    ) {
      const rows = typeof r.rows_upserted === 'number' ? r.rows_upserted : null
      return `daily smart · ${String(summary.symbols_ok ?? '—')}/${String(summary.symbols_requested)} sym · rows ${String(rows ?? '—')}`
    }
    const total = summary.total_symbols
    const processed = summary.processed
    const remaining = summary.remaining
    if (phase === 'running' && total != null && processed != null) {
      const pct = summary.pct != null ? ` (${String(summary.pct)}%)` : ''
      const ok = summary.symbols_upserted != null ? ` · ok ${String(summary.symbols_upserted)}` : ''
      const fail = summary.symbols_failed != null ? ` · err ${String(summary.symbols_failed)}` : ''
      const cur =
        typeof summary.current_symbol === 'string' && summary.current_symbol.trim()
          ? ` · now ${summary.current_symbol.trim()}`
          : ''
      return `${String(processed)}/${String(total)}${pct} · ${String(remaining ?? '—')} left${ok}${fail}${cur}`
    }
    if (summary.symbols_upserted != null && summary.symbols_requested != null) {
      return `${String(summary.symbols_upserted)} / ${String(summary.symbols_requested)} symbols`
    }
    if (summary.symbols_processed != null && summary.total_requested != null) {
      return `${String(summary.symbols_processed)} / ${String(summary.total_requested)} related`
    }
    if (summary.rows_upserted != null) return `rows upserted ${String(summary.rows_upserted)}`
    if (summary.pages != null) return `pages ${String(summary.pages)}`
  }
  if (r.total != null) return `rows ${String(r.total)}`
  if (r.rows_written != null) return `rows ${String(r.rows_written)}`
  if (r.rows_upserted != null) return `rows upserted ${String(r.rows_upserted)}`
  if (r.message != null) return String(r.message)
  try {
    return JSON.stringify(r)
  } catch {
    return '—'
  }
}

export function isRefJobTerminal(item: RefJobTrackItem): boolean {
  if (item.streamError) return true
  const s = (item.status || '').toLowerCase()
  return s === 'done' || s === 'failed'
}

export function countActiveRefJobs(items: RefJobTrackItem[]): number {
  return items.filter(i => !isRefJobTerminal(i)).length
}

/** Compact display for job id in tables. */
export function formatRefJobIdShort(id: string, head = 10): string {
  if (id.length <= head + 6) return id
  return `${id.slice(0, head)}…${id.slice(-4)}`
}
