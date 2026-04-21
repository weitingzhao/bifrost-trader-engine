import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  fetchBarQualityDetail,
  postMassiveSync,
  postOptionDayFillEligibility,
  postOptionMinFillEligibility,
  subscribeMassiveJobEvents,
  type MassiveJobApiRow,
  type OptionContractsReferenceGapResult,
  type OptionSnapshotsContractsGapResult,
  type WatchlistDbCoverageOptionBars,
  type WatchlistDbCoverageOptionContracts,
  type WatchlistDbCoverageOptionSnapshots,
} from '../../api'
import {
  formatRefJobIdShort,
  summarizeRefJobResult,
} from '../massive/stockReferenceJobHelpers'
import type { OptionsFocusDataset } from './optionFocusDataset'
import { DEFAULT_OPTION_MIN_PERIOD, OPTION_MIN_INTRADAY_PERIODS } from '../../utils/optionBarPeriods'

/** Watchlist optionable symbols max 80; batch chain jobs + Check rows need headroom (trim is display-only). */
const MAX_TRACKED = 128

/** Browsers stall with hundreds of EventSource connections; queue excess and coalesce UI updates. */
const MAX_CONCURRENT_JOB_SSE = 8

/** Align with All gaps / matrix coloring: below 97% is review or attention. */
const OPTION_CONTRACTS_COLUMN_HEALTH_PCT = 97

/** Massive option_day row-gap: POST /research/massive/sync fan-out chunk size (contracts per Celery job). */
const OPTION_DAY_ROW_GAP_FANOUT_CHUNK_SIZE = 200

/** Max missing option_day contracts pulled per symbol per enqueue (matches worker cap 2000). */
const OPTION_DAY_ROW_GAP_MAX_CONTRACTS = 2000

/** Parallel POST /research/massive/sync per Fill row gap batch so one slow symbol does not block the rest. */
const OPTION_DAY_ROW_GAP_ENQUEUE_CONCURRENCY = 4

/** If the Massive sync HTTP request hangs (server busy), abort so other symbols and chunks can continue. */
const OPTION_DAY_ROW_GAP_POST_TIMEOUT_MS = 180_000

function hasRefCompareDone(g: OptionContractsReferenceGapResult | undefined): boolean {
  return Boolean(g?.ok && g.compared_at)
}

/** Row-level PG vs reference mismatch (after Check). */
function symbolHasRowGapIssue(g: OptionContractsReferenceGapResult | undefined): boolean {
  if (!hasRefCompareDone(g)) return false
  return typeof g!.gap === 'number' && g!.gap !== 0
}

/** True when Compare hit server-side expiry or per-expiry page caps (aggregate gap may not cover the full chain). */
function poolHasRefCompareTruncation(
  refGapBySymbol: Record<string, OptionContractsReferenceGapResult | undefined>,
  poolUpper: string[],
): boolean {
  for (const s of poolUpper) {
    const g = refGapBySymbol[s]
    if (g?.ok && (g.expiries_truncated || g.truncated)) return true
  }
  return false
}

/** Nullable / ticker coverage still below healthy threshold (watchlist coverage row). */
function optionContractsNeedsColumnBackfill(
  oc: WatchlistDbCoverageOptionContracts | undefined,
): boolean {
  if (!oc?.has_data) return false
  const t = oc.ticker_pct
  const es = oc.exercise_style_pct
  const spc = oc.shares_per_contract_pct
  const optAvg = oc.optional_data_fill_avg_pct
  const sqlNullCells = oc.column_gap_count ?? 0
  return (
    sqlNullCells > 0 ||
    (t != null && t < OPTION_CONTRACTS_COLUMN_HEALTH_PCT) ||
    (es != null && es < OPTION_CONTRACTS_COLUMN_HEALTH_PCT) ||
    (spc != null && spc < OPTION_CONTRACTS_COLUMN_HEALTH_PCT) ||
    (optAvg != null && optAvg < OPTION_CONTRACTS_COLUMN_HEALTH_PCT)
  )
}

function optionDayNeedsColumnBackfill(od: WatchlistDbCoverageOptionBars | undefined): boolean {
  if (!od?.has_data) return false
  const parts = [od.ohlc_complete_pct, od.volume_pct, od.vwap_pct, od.optional_avg_pct]
  return parts.some(p => p != null && p < OPTION_CONTRACTS_COLUMN_HEALTH_PCT)
}

function optionSnapshotsNeedsColumnBackfill(os: WatchlistDbCoverageOptionSnapshots | undefined): boolean {
  if (!os?.has_data) return false
  const parts = [os.iv_pct, os.full_greeks_pct, os.open_interest_pct, os.optional_data_fill_avg_pct]
  return parts.some(p => p != null && p < OPTION_CONTRACTS_COLUMN_HEALTH_PCT)
}

const ico = 'data-overview-ctl__ico'

function IcoSelectAll({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m3 17 2 2 4-4" />
      <path d="m3 7 2 2 4-4" />
      <path d="M13 6h8" />
      <path d="M13 12h8" />
      <path d="M13 18h8" />
    </svg>
  )
}

function IcoClearPool({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

function IcoRefCheck({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  )
}

function IcoFillGap({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={15}
      height={15}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 17V3" />
      <path d="m6 11 6 6 6-6" />
      <path d="M19 21H5" />
    </svg>
  )
}

type OptionJobTrackItem = {
  /** Stable row id (React key); equals jobId once a Massive job exists. */
  trackKey: string
  jobId?: string
  kindLabel: string
  deduplicated?: boolean
  status: string
  job?: MassiveJobApiRow
  streamError?: string
  enqueuedAt: number
  /** Reference-gap compare row summary when no Celery job. */
  activitySummary?: string
}

function trimJobs(items: OptionJobTrackItem[]): OptionJobTrackItem[] {
  if (items.length <= MAX_TRACKED) return items
  const sorted = [...items].sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  while (sorted.length > MAX_TRACKED) sorted.shift()
  return sorted
}

function statusTone(status: string, streamErr?: string): 'ok' | 'err' | 'run' {
  if (streamErr) return 'err'
  const s = (status || '').toLowerCase()
  if (s === 'failed') return 'err'
  if (s === 'done') return 'ok'
  return 'run'
}

function formatEnqueueTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
  } catch {
    return '—'
  }
}

type EnqueuePlan =
  | {
      ok: true
      syncKind: string
      payload: Record<string, unknown>
      kindLabel: string
      needsSymbol: boolean
      hint: string
    }
  | { ok: false; error: string }

/** Maps Focus dataset to Massive sync job (queue: massive). */
export function buildDataOverviewOptionEnqueuePlan(
  focus: OptionsFocusDataset,
  underlying: string,
): EnqueuePlan {
  const u = underlying.trim().toUpperCase()

  const snap = (): EnqueuePlan => {
    if (!u) return { ok: false, error: 'Pick an underlying symbol.' }
    return {
      ok: true,
      syncKind: 'feed_option_snapshots',
      payload: { mode: 'chain', underlying: u },
      kindLabel: 'Chain snapshot',
      needsSymbol: true,
      hint: `Fetches option chain for ${u}; writes option_contracts and option_snapshots rows.`,
    }
  }

  const oiEod = (): EnqueuePlan => ({
    ok: true,
    syncKind: 'oi',
    payload: { mode: 'watchlist_eod' },
    kindLabel: 'EOD open interest (watchlist)',
    needsSymbol: false,
    hint: 'Runs OI chain snapshot for watchlist optionable symbols for latest EOD trade date.',
  })

  const eodPipe = (): EnqueuePlan => ({
    ok: true,
    syncKind: 'eod_pipeline',
    payload: {},
    kindLabel: 'EOD pipeline (OI + Max Pain)',
    needsSymbol: false,
    hint: 'Runs watchlist EOD OI and max-pain reports for the current trade date (skipped on non-trading days).',
  })

  switch (focus) {
    case 'all':
    case 'fundamental':
    case 'staging':
      return snap()
    case 'report':
      return eodPipe()
    case 'option_contracts':
      if (!u) return { ok: false, error: 'Pick an underlying symbol.' }
      return {
        ok: true,
        syncKind: 'feed_option_contracts',
        payload: { mode: 'reference_upsert', underlying: u },
        kindLabel: 'Reference contracts upsert',
        needsSymbol: true,
        hint: '',
      }
    case 'option_snapshots':
    case 'option_snapshots_with_underlying_day':
    case 'option_expiration_cache':
      return snap()
    case 'option_day':
    case 'option_min': {
      const s = snap()
      if (!s.ok) return s
      return {
        ...s,
        hint:
          'Chain snapshot fills option_contracts and option_snapshots. option_day / option_min OHLC bars require an aggregates backfill from Option Discovery or Feed Massive Option (not this button).',
      }
    }
    case 'option_open_interest_daily':
      return oiEod()
    case 'report_option_atm_iv_daily':
    case 'report_option_max_pain_daily':
      return eodPipe()
    default:
      return { ok: false, error: 'Unknown focus dataset.' }
  }
}

function DataOverviewOptionJobsSheet({
  open,
  onClose,
  items,
  onClearCompleted,
  onClearAll,
  onRefreshCoverage,
  maxTracked,
  sessionEnqueueTotal,
  bulkEnqueueTrimHint,
}: {
  open: boolean
  onClose: () => void
  items: OptionJobTrackItem[]
  onClearCompleted: () => void
  onClearAll: () => void
  /** Reload Data Overview coverage (watchlist matrix, global summary, job summaries) without a full page refresh. */
  onRefreshCoverage?: () => void | Promise<void>
  /** Display cap for the table below; older rows are dropped from this list only. */
  maxTracked: number
  /** Successful Celery enqueues this session (not reduced when rows trim). */
  sessionEnqueueTotal: number
  /** When a single bulk enqueue added more rows than maxTracked. */
  bulkEnqueueTrimHint: boolean
}) {
  const asideRef = useRef<HTMLDivElement | null>(null)
  const [refreshBusy, setRefreshBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (open) return
    setRefreshBusy(false)
  }, [open])

  const handleRefreshCoverage = useCallback(async () => {
    if (!onRefreshCoverage || refreshBusy) return
    setRefreshBusy(true)
    try {
      await Promise.resolve(onRefreshCoverage())
    } finally {
      setRefreshBusy(false)
    }
  }, [onRefreshCoverage, refreshBusy])

  if (!open) return null

  const sorted = [...items].sort((a, b) => b.enqueuedAt - a.enqueuedAt)
  const hasCompleted = items.some(
    x => (x.status || '').toLowerCase() === 'done' || (x.status || '').toLowerCase() === 'failed' || x.streamError,
  )
  const activeN = items.filter(x => {
    const s = (x.status || '').toLowerCase()
    return s !== 'done' && s !== 'failed' && !x.streamError
  }).length

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet ref-jobs-sheet--wide data-overview-option-jobs-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-opt-jobs-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-opt-jobs-title" className="ref-jobs-sheet-title">
            Option coverage jobs
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <p className="ref-jobs-sheet-meta">
          Session-only tracking for jobs enqueued from Data Overview (By symbol). Massive job rows update via stream;
          reference gap checks update per symbol as each completes. Use Refresh coverage to reload the watchlist matrix
          and summaries after jobs finish (no full page reload). Only the last {maxTracked} tracked rows are shown here;
          older rows drop from this list — jobs may still be running. Use Celery / job tables for full history.
        </p>
        <p className="ref-jobs-sheet-meta ref-jobs-sheet-meta--sub" role="note">
          Workers must consume broker queue <code>options_massive</code>. If the job table shows pending/enqueued but no
          task progress, open{' '}
          <button
            type="button"
            className="ref-jobs-sheet-link"
            onClick={() => {
              window.location.hash = '#settings-celery'
            }}
          >
            Settings → Celery
          </button>{' '}
          and ensure an <code>options_massive</code> worker instance is running (same Redis/config as the Massive API).
        </p>
        {sessionEnqueueTotal > 0 ? (
          <p className="ref-jobs-sheet-meta ref-jobs-sheet-meta--sub" role="status">
            Session enqueues (successful): <strong>{sessionEnqueueTotal}</strong>
          </p>
        ) : null}
        {bulkEnqueueTrimHint ? (
          <p className="ref-jobs-sheet-meta ref-jobs-sheet-meta--warn" role="status">
            This batch enqueued more than {maxTracked} jobs — some rows may no longer appear in the list above. Open{' '}
            <button
              type="button"
              className="ref-jobs-sheet-link"
              onClick={() => {
                window.location.hash = '#settings-celery'
              }}
            >
              Open Celery job details
            </button>{' '}
            or the job table for full history.
          </p>
        ) : null}

        <div className="ref-jobs-sheet-toolbar">
          {onRefreshCoverage ? (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void handleRefreshCoverage()}
              disabled={refreshBusy}
              title="Reload Data Overview coverage and job summaries from the server"
            >
              {refreshBusy ? 'Refreshing…' : 'Refresh coverage'}
            </button>
          ) : null}
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClearCompleted} disabled={!hasCompleted}>
            Clear completed
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClearAll} disabled={items.length === 0}>
            Clear all
          </button>
        </div>

        <div className="ref-jobs-sheet-table-wrap">
          {sorted.length === 0 ? (
            <p className="ref-jobs-sheet-empty">Enqueue a job to see status here.</p>
          ) : (
            <table className="ref-jobs-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Dedup</th>
                  <th scope="col">Job ID</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(item => {
                  const tone = statusTone(item.status, item.streamError)
                  const statusLabel = item.streamError ? 'failed' : item.status
                  const jid = item.jobId ?? ''
                  return (
                    <tr key={item.trackKey} className="ref-jobs-table-row">
                      <td className="ref-jobs-table-time">{formatEnqueueTime(item.enqueuedAt)}</td>
                      <td className="ref-jobs-table-kind">{item.kindLabel}</td>
                      <td>
                        <span className={`ref-jobs-sheet-status ref-jobs-sheet-status--${tone}`} title="Job status">
                          {statusLabel}
                        </span>
                        {item.streamError ? (
                          <p className="ref-jobs-table-stream-err" role="alert">
                            {item.streamError}
                          </p>
                        ) : null}
                      </td>
                      <td className="ref-jobs-table-dedup">{item.deduplicated ? 'Yes' : '—'}</td>
                      <td className="ref-jobs-table-id-cell">
                        <code className="ref-jobs-table-job-id" title={jid || undefined}>
                          {jid ? formatRefJobIdShort(jid) : '—'}
                        </code>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm ref-jobs-table-copy"
                          disabled={!jid}
                          onClick={() => {
                            if (!jid) return
                            void navigator.clipboard?.writeText(jid).catch(() => {})
                          }}
                        >
                          Copy
                        </button>
                      </td>
                      <td className="ref-jobs-table-summary">
                        {item.activitySummary ?? summarizeRefJobResult(item.job)}
                      </td>
                      <td className="ref-jobs-table-details-cell">
                        {item.job?.result != null ? (
                          <details className="feed-massive-details-debug ref-jobs-sheet-details">
                            <summary>JSON</summary>
                            <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '10rem' }}>
                              {typeof item.job.result === 'string'
                                ? item.job.result
                                : JSON.stringify(item.job.result, null, 2)}
                            </pre>
                          </details>
                        ) : (
                          <span className="ref-jobs-table-dash">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="ref-jobs-sheet-footer">
          <p className="ref-jobs-sheet-footer-hint">
            {activeN > 0 ? `${activeN} active` : 'No active jobs'}
            {' · '}
            <button
              type="button"
              className="ref-jobs-sheet-link"
              onClick={() => {
                window.location.hash = '#coverage-option'
              }}
            >
              Option Coverage
            </button>
            {' · '}
            <button
              type="button"
              className="ref-jobs-sheet-link"
              onClick={() => {
                window.location.hash = '#settings-celery'
              }}
            >
              Open Celery job details
            </button>
          </p>
        </div>
      </aside>
    </div>
  )
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

export type NullableOptionContractsColumnCode =
  | 'massive_option_ticker'
  | 'exercise_style'
  | 'shares_per_contract'

export type DataOverviewOptionJobsBarHandle = {
  /** Enqueue `contracts` / `reference_upsert` for one underlying; optional `expiration_date` scopes the Massive refresh. */
  enqueueReferenceUpsert: (
    underlying: string,
    options?: { expiration_date?: string },
  ) => Promise<void>
  /**
   * Column-level backfill for nullable option_contracts fields (All gaps).
   * `massive_option_ticker` → reference list upsert; `exercise_style` / `shares_per_contract` → detail API per row with ticker set.
   */
  enqueueNullableColumnFill: (underlying: string, column: NullableOptionContractsColumnCode) => Promise<void>
  /** Chain snapshot (option_snapshots row gap); optional expiry filter. */
  enqueueChainSnapshot: (underlying: string, options?: { expiration_date?: string }) => Promise<void>
  /** Per-contract snapshot column refresh (IV / Greeks / OI). */
  enqueueOptionSnapshotsContractColumnFill: (underlying: string) => Promise<void>
  /** Pool row gap for one symbol — option_day; optional `expiration_date` scopes to one expiry. */
  enqueueOptionDayPoolRowGap: (
    underlying: string,
    options?: { expiration_date?: string },
  ) => Promise<void>
  enqueueOptionDayPoolColumnFill: (underlying: string) => Promise<void>
  /** Pool row/column for one symbol — option_min (uses current Bar period); optional `expiration_date` scopes row gap. */
  enqueueOptionMinPoolRowGap: (
    underlying: string,
    options?: { expiration_date?: string },
  ) => Promise<void>
  enqueueOptionMinPoolColumnFill: (underlying: string) => Promise<void>
}

export type DataOverviewOptionJobsBarProps = {
  focusDataset: OptionsFocusDataset
  wlSymbols: string[]
  /** Symbols that already have at least one option_contracts row (Compare + gap logic). */
  symbolsWithOptionContractsData?: string[]
  onWatchlistRefreshRequested?: () => void | Promise<void>
  refGapBySymbol?: Record<string, OptionContractsReferenceGapResult>
  onCompareMassiveReference?: (
    symbols: string[],
    progress?: {
      onSymbolStart?: (symbol: string) => void
      onSymbolDone?: (symbol: string, result: OptionContractsReferenceGapResult) => void
      onSymbolError?: (symbol: string, message: string) => void
    },
    options?: { maxExpiries?: number },
  ) => void | Promise<void>
  refGapLoading?: boolean
  refGapError?: string | null
  snapshotGapBySymbol?: Record<string, OptionSnapshotsContractsGapResult>
  onCompareSnapshotGap?: (
    symbols: string[],
    progress?: {
      onSymbolStart?: (symbol: string) => void
      onSymbolDone?: (symbol: string, result: OptionSnapshotsContractsGapResult) => void
      onSymbolError?: (symbol: string, message: string) => void
    },
  ) => void | Promise<void>
  snapshotGapLoading?: boolean
  snapshotGapError?: string | null
  barsGapBySymbol?: Record<string, OptionContractsReferenceGapResult>
  onCompareBarsGap?: (
    symbols: string[],
    progress?: {
      onSymbolStart?: (symbol: string) => void
      onSymbolDone?: (symbol: string, result: OptionContractsReferenceGapResult) => void
      onSymbolError?: (symbol: string, message: string) => void
    },
  ) => void | Promise<void>
  barsGapLoading?: boolean
  barsGapError?: string | null
  /** option_contracts: uppercase symbols chosen in the matrix (Symbol column). */
  comparePool?: string[]
  /** Per-symbol option_contracts coverage (watchlist matrix); used to target column backfill. */
  optionContractsBySymbol?: Record<string, WatchlistDbCoverageOptionContracts>
  /** Per-symbol option_day coverage (watchlist matrix); used for option_day Fill column gating. */
  optionDayBySymbol?: Record<string, WatchlistDbCoverageOptionBars>
  /** Per-symbol option_snapshots coverage (watchlist matrix); Fill column gating. */
  optionSnapshotsBySymbol?: Record<string, WatchlistDbCoverageOptionSnapshots>
  onSelectAllComparePool?: () => void
  onClearComparePool?: () => void
  jobsSheetOpen: boolean
  onJobsSheetOpenChange: (open: boolean) => void
  /** option_contracts: open consolidated per-expiry gap sheet (watchlist-wide). */
  onOpenAllGapsSheet?: () => void
  /** option_contracts: open Gap scope explanation sheet only. */
  onOpenGapExplainSheet?: () => void
  /** option_min: bar period label (matches option_min.period in PostgreSQL). */
  optionMinPeriod?: string
  onOptionMinPeriodChange?: (period: string) => void
}

export const DataOverviewOptionJobsBar = forwardRef<
  DataOverviewOptionJobsBarHandle,
  DataOverviewOptionJobsBarProps
>(function DataOverviewOptionJobsBar(
  {
    focusDataset,
    wlSymbols,
    symbolsWithOptionContractsData = [],
    onWatchlistRefreshRequested,
    refGapBySymbol = {},
    onCompareMassiveReference,
    refGapLoading = false,
    refGapError = null,
    snapshotGapBySymbol = {},
    onCompareSnapshotGap,
    snapshotGapLoading = false,
    snapshotGapError = null,
    barsGapBySymbol = {},
    onCompareBarsGap,
    barsGapLoading = false,
    barsGapError = null,
    comparePool = [],
    optionContractsBySymbol = {},
    optionDayBySymbol = {},
    optionSnapshotsBySymbol = {},
    onSelectAllComparePool,
    onClearComparePool,
    jobsSheetOpen,
    onJobsSheetOpenChange,
    onOpenAllGapsSheet,
    onOpenGapExplainSheet,
    optionMinPeriod: optionMinPeriodProp = DEFAULT_OPTION_MIN_PERIOD,
    onOptionMinPeriodChange,
  },
  ref,
) {
  const [items, setItems] = useState<OptionJobTrackItem[]>([])
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [enqueueBusy, setEnqueueBusy] = useState(false)
  /** option_contracts pool: row vs column batch fill (mutually exclusive). */
  const [contractsFillBatch, setContractsFillBatch] = useState<'row' | 'column' | null>(null)
  /** option_min pool: Massive /v2/aggs orchestration jobs. */
  const [optionMinFillBatch, setOptionMinFillBatch] = useState<'row' | 'column' | null>(null)
  /** option_day pool: row/column fill jobs. */
  const [optionDayFillBatch, setOptionDayFillBatch] = useState<'row' | 'column' | null>(null)
  /** option_snapshots pool: chain vs per-contract column fill. */
  const [snapshotFillBatch, setSnapshotFillBatch] = useState<'row' | 'column' | null>(null)
  const [optionMinEligibility, setOptionMinEligibility] = useState<
    Record<string, { needs_row_fill: boolean; needs_column_fill: boolean }>
  >({})
  const [optionMinEligibilityLoading, setOptionMinEligibilityLoading] = useState(false)
  const [optionDayEligibility, setOptionDayEligibility] = useState<
    Record<string, { needs_row_fill: boolean; needs_column_fill: boolean }>
  >({})
  const [optionDayEligibilityLoading, setOptionDayEligibilityLoading] = useState(false)
  const [enqueueErr, setEnqueueErr] = useState<string | null>(null)
  /** Successful Celery enqueues this session (Jobs sheet; not reduced when the list trims). */
  const [sessionEnqueueTotal, setSessionEnqueueTotal] = useState(0)
  /** Set when a bulk enqueue added more rows than MAX_TRACKED in one batch. */
  const [bulkEnqueueTrimHint, setBulkEnqueueTrimHint] = useState(false)
  /** Massive reference compare: distinct expiries scanned (server clamps to cap). */
  const [referenceCompareMaxExpiries, setReferenceCompareMaxExpiries] = useState(60)

  const optionMinPeriod = optionMinPeriodProp

  const bumpSessionEnqueue = useCallback((n: number) => {
    if (n > 0) setSessionEnqueueTotal(prev => prev + n)
  }, [])

  const sseClosersRef = useRef<Map<string, () => void>>(new Map())
  const jobSseQueueRef = useRef<string[]>([])
  const queuedJobStreamsRef = useRef<Set<string>>(new Set())
  const activeJobSseRef = useRef(0)
  const pendingJobUiRef = useRef<
    Map<string, { status?: string; job?: MassiveJobApiRow; streamError?: string; terminal?: boolean }>
  >(new Map())
  const flushJobUiRafRef = useRef<number | null>(null)
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      sseClosersRef.current.forEach(close => close())
      sseClosersRef.current.clear()
      jobSseQueueRef.current = []
      queuedJobStreamsRef.current.clear()
      activeJobSseRef.current = 0
      pendingJobUiRef.current.clear()
      if (flushJobUiRafRef.current != null) {
        cancelAnimationFrame(flushJobUiRafRef.current)
        flushJobUiRafRef.current = null
      }
      if (refreshDebounceRef.current) {
        clearTimeout(refreshDebounceRef.current)
        refreshDebounceRef.current = null
      }
    },
    [],
  )

  const scheduleWatchlistRefresh = useCallback(() => {
    if (refreshDebounceRef.current) clearTimeout(refreshDebounceRef.current)
    refreshDebounceRef.current = window.setTimeout(() => {
      onWatchlistRefreshRequested?.()
      refreshDebounceRef.current = null
    }, 1200)
  }, [onWatchlistRefreshRequested])

  useEffect(() => {
    if (focusDataset === 'option_contracts') return
    const syms = wlSymbols.map(s => s.trim().toUpperCase()).filter(Boolean)
    setSelectedSymbol(cur => {
      if (syms.length === 0) return ''
      if (cur && syms.includes(cur)) return cur
      return syms[0]!
    })
  }, [wlSymbols, focusDataset])

  const plan = useMemo(() => {
    if (focusDataset === 'option_contracts') {
      const first = (comparePool[0] ?? '').trim()
      return buildDataOverviewOptionEnqueuePlan(focusDataset, first)
    }
    return buildDataOverviewOptionEnqueuePlan(focusDataset, selectedSymbol)
  }, [focusDataset, selectedSymbol, comparePool])

  const scheduleJobUiFlush = useCallback(() => {
    if (flushJobUiRafRef.current != null) return
    flushJobUiRafRef.current = requestAnimationFrame(() => {
      flushJobUiRafRef.current = null
      const batch = pendingJobUiRef.current
      if (batch.size === 0) return
      pendingJobUiRef.current = new Map()
      setItems(prev =>
        prev.map(row => {
          const id = row.jobId
          if (!id) return row
          const p = batch.get(id)
          if (!p) return row
          return {
            ...row,
            ...(p.streamError !== undefined ? { streamError: p.streamError } : {}),
            ...(p.status !== undefined ? { status: p.status } : {}),
            ...(p.job !== undefined ? { job: p.job } : {}),
          }
        }),
      )
    })
  }, [])

  const openJobStreamNow = useCallback(
    (jid: string) => {
      activeJobSseRef.current += 1
      const sub = subscribeMassiveJobEvents(
        jid,
        data => {
          if (!data.ok) {
            if (!sseClosersRef.current.has(jid)) return
          }
          const cur = pendingJobUiRef.current.get(jid) ?? {}
          if (!data.ok) {
            pendingJobUiRef.current.set(jid, {
              ...cur,
              streamError: data.error ?? 'Job stream error',
              status: 'failed',
            })
            scheduleJobUiFlush()
            sseClosersRef.current.delete(jid)
            activeJobSseRef.current = Math.max(0, activeJobSseRef.current - 1)
            while (
              activeJobSseRef.current < MAX_CONCURRENT_JOB_SSE &&
              jobSseQueueRef.current.length > 0
            ) {
              const next = jobSseQueueRef.current.shift()
              if (!next) break
              queuedJobStreamsRef.current.delete(next)
              openJobStreamNow(next)
            }
            return
          }
          const j = data.job
          const st = (j?.status ?? '').trim() || 'running'
          const stLower = st.toLowerCase()
          pendingJobUiRef.current.set(jid, { ...cur, status: st, job: j })
          scheduleJobUiFlush()
          if (stLower === 'done' || stLower === 'failed') {
            if (!sseClosersRef.current.has(jid)) return
            sseClosersRef.current.delete(jid)
            if (stLower === 'done') scheduleWatchlistRefresh()
            activeJobSseRef.current = Math.max(0, activeJobSseRef.current - 1)
            while (
              activeJobSseRef.current < MAX_CONCURRENT_JOB_SSE &&
              jobSseQueueRef.current.length > 0
            ) {
              const next = jobSseQueueRef.current.shift()
              if (!next) break
              queuedJobStreamsRef.current.delete(next)
              openJobStreamNow(next)
            }
          }
        },
        { timeoutSec: 86400 },
      )
      sseClosersRef.current.set(jid, sub.close)
    },
    [scheduleJobUiFlush, scheduleWatchlistRefresh],
  )

  const startJobStream = useCallback(
    (jid: string) => {
      if (sseClosersRef.current.has(jid) || queuedJobStreamsRef.current.has(jid)) return
      if (activeJobSseRef.current >= MAX_CONCURRENT_JOB_SSE) {
        queuedJobStreamsRef.current.add(jid)
        jobSseQueueRef.current.push(jid)
        return
      }
      openJobStreamNow(jid)
    },
    [openJobStreamNow],
  )

  const pushJob = useCallback(
    (params: { jobId: string; kindLabel: string; deduplicated: boolean }) => {
      const now = Date.now()
      const jid = params.jobId
      setItems(prev => {
        const next: OptionJobTrackItem[] = [
          ...prev,
          {
            trackKey: jid,
            jobId: jid,
            kindLabel: params.kindLabel,
            deduplicated: params.deduplicated,
            status: params.deduplicated ? 'deduplicated (waiting)' : 'enqueued',
            enqueuedAt: now,
          },
        ]
        return trimJobs(next)
      })
      setSessionEnqueueTotal(c => c + 1)
      onJobsSheetOpenChange(true)
      startJobStream(jid)
    },
    [startJobStream, onJobsSheetOpenChange],
  )

  const isContractsFocus = focusDataset === 'option_contracts'
  const isSnapshotsFocus = focusDataset === 'option_snapshots'
  const isBarsFocus = focusDataset === 'option_day' || focusDataset === 'option_min'
  const isMinFocus = focusDataset === 'option_min'
  const isDayFocus = focusDataset === 'option_day'

  const poolUpper = useMemo(
    () => comparePool.map(s => s.trim().toUpperCase()).filter(Boolean),
    [comparePool],
  )

  /** Pooled symbols with a finished Check and a non-zero row Gap (reference upsert candidates). */
  const rowGapFillTargets = useMemo(() => {
    if (!isContractsFocus) return [] as string[]
    return poolUpper.filter(sym => symbolHasRowGapIssue(refGapBySymbol[sym]))
  }, [isContractsFocus, poolUpper, refGapBySymbol])

  /** Pooled symbols with Check + nullable/ticker coverage still below healthy threshold. */
  const columnFillTargets = useMemo(() => {
    if (!isContractsFocus) return [] as string[]
    return poolUpper.filter(sym => {
      if (!hasRefCompareDone(refGapBySymbol[sym])) return false
      const oc = optionContractsBySymbol[sym]
      return optionContractsNeedsColumnBackfill(oc)
    })
  }, [isContractsFocus, poolUpper, refGapBySymbol, optionContractsBySymbol])

  /** option_min: pooled symbols with Check done and non-zero Gap (same rule as option_contracts row fill). */
  const optionMinRowFillTargets = useMemo(() => {
    if (!isMinFocus) return [] as string[]
    return poolUpper.filter(sym => {
      if (!hasRefCompareDone(barsGapBySymbol[sym])) return false
      return symbolHasRowGapIssue(barsGapBySymbol[sym])
    })
  }, [isMinFocus, poolUpper, barsGapBySymbol])

  /** option_min: pooled symbols with Check done and incomplete OHLC/volume/vwap rows in lookback. */
  const optionMinColumnFillTargets = useMemo(() => {
    if (!isMinFocus) return [] as string[]
    return poolUpper.filter(sym => {
      if (!hasRefCompareDone(barsGapBySymbol[sym])) return false
      return Boolean(optionMinEligibility[sym]?.needs_column_fill)
    })
  }, [isMinFocus, poolUpper, barsGapBySymbol, optionMinEligibility])

  /** option_day: same gap rule as option_min row fill (bars vs contracts Check). */
  const optionDayRowFillTargets = useMemo(() => {
    if (!isDayFocus) return [] as string[]
    return poolUpper.filter(sym => {
      if (!hasRefCompareDone(barsGapBySymbol[sym])) return false
      return symbolHasRowGapIssue(barsGapBySymbol[sym])
    })
  }, [isDayFocus, poolUpper, barsGapBySymbol])

  /** option_day: watchlist metrics below 97% or PG incomplete rows in lookback. */
  const optionDayColumnFillTargets = useMemo(() => {
    if (!isDayFocus) return [] as string[]
    return poolUpper.filter(sym => {
      if (!hasRefCompareDone(barsGapBySymbol[sym])) return false
      const od = optionDayBySymbol[sym]
      const elig = optionDayEligibility[sym]?.needs_column_fill
      return optionDayNeedsColumnBackfill(od) || Boolean(elig)
    })
  }, [isDayFocus, poolUpper, barsGapBySymbol, optionDayBySymbol, optionDayEligibility])

  /** option_snapshots: non-zero gap after Check (chain snapshot candidates). */
  const snapshotRowFillTargets = useMemo(() => {
    if (!isSnapshotsFocus) return [] as string[]
    return poolUpper.filter(sym => {
      if (!hasRefCompareDone(snapshotGapBySymbol[sym])) return false
      return symbolHasRowGapIssue(snapshotGapBySymbol[sym])
    })
  }, [isSnapshotsFocus, poolUpper, snapshotGapBySymbol])

  /** option_snapshots: column health from watchlist coverage. */
  const snapshotColumnFillTargets = useMemo(() => {
    if (!isSnapshotsFocus) return [] as string[]
    return poolUpper.filter(sym => {
      if (!hasRefCompareDone(snapshotGapBySymbol[sym])) return false
      return optionSnapshotsNeedsColumnBackfill(optionSnapshotsBySymbol[sym])
    })
  }, [isSnapshotsFocus, poolUpper, snapshotGapBySymbol, optionSnapshotsBySymbol])

  useEffect(() => {
    if (!isMinFocus || poolUpper.length === 0) {
      setOptionMinEligibility({})
      return
    }
    if (barsGapLoading) return
    let cancelled = false
    setOptionMinEligibilityLoading(true)
    void postOptionMinFillEligibility(poolUpper, optionMinPeriod, 7).then(res => {
      if (cancelled || !res.ok || !res.results) return
      const next: Record<string, { needs_row_fill: boolean; needs_column_fill: boolean }> = {}
      for (const [k, v] of Object.entries(res.results)) {
        next[k.trim().toUpperCase()] = {
          needs_row_fill: Boolean(v.needs_row_fill),
          needs_column_fill: Boolean(v.needs_column_fill),
        }
      }
      setOptionMinEligibility(next)
    }).finally(() => {
      if (!cancelled) setOptionMinEligibilityLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isMinFocus, poolUpper, optionMinPeriod, barsGapLoading])

  useEffect(() => {
    if (!isDayFocus || poolUpper.length === 0) {
      setOptionDayEligibility({})
      return
    }
    if (barsGapLoading) return
    let cancelled = false
    setOptionDayEligibilityLoading(true)
    void postOptionDayFillEligibility(poolUpper, 30).then(res => {
      if (cancelled || !res.ok || !res.results) return
      const next: Record<string, { needs_row_fill: boolean; needs_column_fill: boolean }> = {}
      for (const [k, v] of Object.entries(res.results)) {
        next[k.trim().toUpperCase()] = {
          needs_row_fill: Boolean(v.needs_row_fill),
          needs_column_fill: Boolean(v.needs_column_fill),
        }
      }
      setOptionDayEligibility(next)
    }).finally(() => {
      if (!cancelled) setOptionDayEligibilityLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [isDayFocus, poolUpper, barsGapLoading])

  const handleEnqueueRowGap = useCallback(async () => {
    setEnqueueErr(null)
    const pool = rowGapFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill row gap only enqueues symbols with a Compare result and a non-zero Gap.',
      )
      return
    }
    setContractsFillBatch('row')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `fill-row-${batchId}-${sym}`,
            kindLabel: `Fill row gap · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)

      let nOk = 0
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `fill-row-${batchId}-${sym}`
        const res = await postMassiveSync('feed_option_contracts', {
          mode: 'reference_upsert',
          underlying: sym,
        })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const jid = res.job_id
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const dedup = Boolean(res.deduplicated)
        const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
        setItems(prev =>
          prev.map(row =>
            row.trackKey === tk
              ? {
                  ...row,
                  jobId: jid,
                  deduplicated: dedup,
                  status: st,
                }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setContractsFillBatch(null)
    }
  }, [rowGapFillTargets, onJobsSheetOpenChange, scheduleWatchlistRefresh, startJobStream, bumpSessionEnqueue])

  const handleEnqueueColumnData = useCallback(async () => {
    setEnqueueErr(null)
    const pool = columnFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill column data requires Compare complete and (C gap > 0 or nullable/ticker coverage below 97%).',
      )
      return
    }
    setContractsFillBatch('column')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `fill-col-${batchId}-${sym}`,
            kindLabel: `Fill column data · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)

      let nOk = 0
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `fill-col-${batchId}-${sym}`
        const res = await postMassiveSync('feed_option_contracts', {
          mode: 'nullable_column_backfill',
          underlying: sym,
          columns: ['exercise_style', 'shares_per_contract'],
          max_contracts: 5000,
        })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const jid = res.job_id
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const dedup = Boolean(res.deduplicated)
        const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
        setItems(prev =>
          prev.map(row =>
            row.trackKey === tk
              ? {
                  ...row,
                  jobId: jid,
                  deduplicated: dedup,
                  status: st,
                }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setContractsFillBatch(null)
    }
  }, [columnFillTargets, onJobsSheetOpenChange, scheduleWatchlistRefresh, startJobStream, bumpSessionEnqueue])

  const handleEnqueueOptionMinRowGap = useCallback(async () => {
    setEnqueueErr(null)
    const pool = optionMinRowFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill row gap only enqueues symbols with a Compare result and a non-zero Gap.',
      )
      return
    }
    setOptionMinFillBatch('row')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `opt-min-row-${batchId}-${sym}`,
            kindLabel: `Fill option_min row gap · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)
      let nOk = 0
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `opt-min-row-${batchId}-${sym}`
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_min_pool_row_gap',
          underlying: sym,
          period: optionMinPeriod,
          lookback_days: 7,
          max_contracts: 300,
        })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const jid = res.job_id
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const dedup = Boolean(res.deduplicated)
        const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
        setItems(prev =>
          prev.map(row =>
            row.trackKey === tk
              ? { ...row, jobId: jid, deduplicated: dedup, status: st, kindLabel: `Fill option_min row gap · ${sym}` }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setOptionMinFillBatch(null)
    }
  }, [
    optionMinRowFillTargets,
    optionMinPeriod,
    onJobsSheetOpenChange,
    scheduleWatchlistRefresh,
    startJobStream,
    bumpSessionEnqueue,
  ])

  const handleEnqueueOptionMinColumnData = useCallback(async () => {
    setEnqueueErr(null)
    const pool = optionMinColumnFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill column data re-fetches Massive /v2/aggs for symbols with incomplete OHLC, volume, or VWAP in option_min.',
      )
      return
    }
    setOptionMinFillBatch('column')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `opt-min-col-${batchId}-${sym}`,
            kindLabel: `Fill option_min column data · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)
      let nOk = 0
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `opt-min-col-${batchId}-${sym}`
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_min_pool_column_fill',
          underlying: sym,
          period: optionMinPeriod,
          lookback_days: 7,
          max_contracts: 300,
        })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const jid = res.job_id
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const dedup = Boolean(res.deduplicated)
        const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
        setItems(prev =>
          prev.map(row =>
            row.trackKey === tk
              ? { ...row, jobId: jid, deduplicated: dedup, status: st, kindLabel: `Fill option_min column data · ${sym}` }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setOptionMinFillBatch(null)
    }
  }, [
    optionMinColumnFillTargets,
    optionMinPeriod,
    onJobsSheetOpenChange,
    scheduleWatchlistRefresh,
    startJobStream,
    bumpSessionEnqueue,
  ])

  const handleEnqueueOptionDayRowGap = useCallback(async () => {
    setEnqueueErr(null)
    const pool = optionDayRowFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill row gap only enqueues symbols with a Compare result and a non-zero Gap.',
      )
      return
    }
    setOptionDayFillBatch('row')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `opt-day-row-${batchId}-${sym}`,
            kindLabel: `Fill option_day row gap · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)
      let nOk = 0
      let aborted = false
      for (let off = 0; off < pool.length && !aborted; off += OPTION_DAY_ROW_GAP_ENQUEUE_CONCURRENCY) {
        const slice = pool.slice(off, off + OPTION_DAY_ROW_GAP_ENQUEUE_CONCURRENCY)
        await Promise.all(
          slice.map(async (sym, j) => {
            if (aborted) return
            const i = off + j
            const tk = `opt-day-row-${batchId}-${sym}`
            const controller = new AbortController()
            const tid = window.setTimeout(() => controller.abort(), OPTION_DAY_ROW_GAP_POST_TIMEOUT_MS)
            let res: Awaited<ReturnType<typeof postMassiveSync>>
            try {
              res = await postMassiveSync(
                'feed_options_aggregate',
                {
                  mode: 'option_day_pool_row_gap',
                  underlying: sym,
                  row_lookback_days: 730,
                  max_contracts: OPTION_DAY_ROW_GAP_MAX_CONTRACTS,
                  max_expiries: 60,
                  chunk_size: OPTION_DAY_ROW_GAP_FANOUT_CHUNK_SIZE,
                },
                { signal: controller.signal },
              )
            } catch (e) {
              const isAbort = e instanceof Error && e.name === 'AbortError'
              const msg = isAbort
                ? `Enqueue request timed out after ${OPTION_DAY_ROW_GAP_POST_TIMEOUT_MS / 1000}s (server did not respond in time).`
                : e instanceof Error
                  ? e.message
                  : 'Request failed'
              setItems(prev =>
                prev.map(row =>
                  row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
                ),
              )
              return
            } finally {
              window.clearTimeout(tid)
            }
            if (!res.ok) {
              const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
              aborted = true
              setEnqueueErr(msg)
              setItems(prev =>
                prev.map(row =>
                  row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
                ),
              )
              return
            }
            if (res.fan_out && res.job_ids && res.job_ids.length > 0) {
              const ids = res.job_ids
              const n = ids.length
              setItems(prev => {
                const rest = prev.filter(row => row.trackKey !== tk)
                const added = ids.map((jid, ci) => ({
                  trackKey: `${tk}-c${ci}`,
                  jobId: jid,
                  kindLabel: `Fill option_day row gap · ${sym} (${ci + 1}/${n})`,
                  deduplicated: false,
                  status: 'enqueued' as const,
                  enqueuedAt: batchId + i + ci * 0.001,
                }))
                return trimJobs([...rest, ...added])
              })
              ids.forEach(jid => {
                startJobStream(jid)
              })
              nOk += 1
            } else if (res.fan_out && (!res.job_ids || res.job_ids.length === 0)) {
              setItems(prev =>
                prev.map(row =>
                  row.trackKey === tk
                    ? {
                        ...row,
                        status: 'done',
                        streamError: undefined,
                        kindLabel: `Fill option_day row gap · ${sym} (no targets)`,
                      }
                    : row,
                ),
              )
              nOk += 1
            } else {
              const jid = res.job_id
              if (!jid) {
                const msg = `No job_id for ${sym}`
                aborted = true
                setEnqueueErr(msg)
                setItems(prev =>
                  prev.map(row =>
                    row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
                  ),
                )
                return
              }
              const dedup = Boolean(res.deduplicated)
              const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
              setItems(prev =>
                prev.map(row =>
                  row.trackKey === tk
                    ? { ...row, jobId: jid, deduplicated: dedup, status: st, kindLabel: `Fill option_day row gap · ${sym}` }
                    : row,
                ),
              )
              startJobStream(jid)
              nOk += 1
            }
          }),
        )
        if (off + slice.length < pool.length && !aborted) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setOptionDayFillBatch(null)
    }
  }, [
    optionDayRowFillTargets,
    onJobsSheetOpenChange,
    scheduleWatchlistRefresh,
    startJobStream,
    bumpSessionEnqueue,
  ])

  const handleEnqueueOptionDayColumnData = useCallback(async () => {
    setEnqueueErr(null)
    const pool = optionDayColumnFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill column data targets symbols with watchlist option_day health below 97% or incomplete OHLC/volume/VWAP rows in PostgreSQL.',
      )
      return
    }
    setOptionDayFillBatch('column')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `opt-day-col-${batchId}-${sym}`,
            kindLabel: `Fill option_day column data · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)
      let nOk = 0
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `opt-day-col-${batchId}-${sym}`
        let priority_dates: string[] | undefined
        try {
          const bq = await fetchBarQualityDetail(sym, 'option_day', undefined, 60)
          const badDays = (bq.daily ?? []).filter(
            r =>
              (r.ohlc_pct != null && r.ohlc_pct < OPTION_CONTRACTS_COLUMN_HEALTH_PCT) ||
              (r.volume_pct != null && r.volume_pct < OPTION_CONTRACTS_COLUMN_HEALTH_PCT) ||
              (r.vwap_pct != null && r.vwap_pct < OPTION_CONTRACTS_COLUMN_HEALTH_PCT),
          )
          priority_dates = badDays.map(r => r.bar_day).slice(0, 40)
          if (priority_dates.length === 0) priority_dates = undefined
        } catch {
          priority_dates = undefined
        }
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_day_pool_column_fill',
          underlying: sym,
          column_lookback_days: 30,
          max_rows: 300,
          ...(priority_dates ? { priority_dates } : {}),
        })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const jid = res.job_id
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row =>
              row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row,
            ),
          )
          break
        }
        const dedup = Boolean(res.deduplicated)
        const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
        setItems(prev =>
          prev.map(row =>
            row.trackKey === tk
              ? { ...row, jobId: jid, deduplicated: dedup, status: st, kindLabel: `Fill option_day column data · ${sym}` }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setOptionDayFillBatch(null)
    }
  }, [
    optionDayColumnFillTargets,
    onJobsSheetOpenChange,
    scheduleWatchlistRefresh,
    startJobStream,
    bumpSessionEnqueue,
  ])

  const handleEnqueueSnapshotRowGap = useCallback(async () => {
    setEnqueueErr(null)
    const pool = snapshotRowFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill row gap only enqueues symbols with a Compare result and a non-zero Gap.',
      )
      return
    }
    setSnapshotFillBatch('row')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `snap-row-${batchId}-${sym}`,
            kindLabel: `Chain snapshot (row gap) · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)
      let nOk = 0
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `snap-row-${batchId}-${sym}`
        const res = await postMassiveSync('feed_option_snapshots', { underlying: sym })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row => (row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row)),
          )
          break
        }
        const jid = res.job_id
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row => (row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row)),
          )
          break
        }
        const dedup = Boolean(res.deduplicated)
        const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
        setItems(prev =>
          prev.map(row =>
            row.trackKey === tk
              ? {
                  ...row,
                  jobId: jid,
                  deduplicated: dedup,
                  status: st,
                  kindLabel: `Chain snapshot (row gap) · ${sym}`,
                }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setSnapshotFillBatch(null)
    }
  }, [snapshotRowFillTargets, onJobsSheetOpenChange, scheduleWatchlistRefresh, startJobStream, bumpSessionEnqueue])

  const handleEnqueueSnapshotColumnData = useCallback(async () => {
    setEnqueueErr(null)
    const pool = snapshotColumnFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill column data targets symbols with snapshot IV / Greeks / OI coverage below 97% on the watchlist matrix.',
      )
      return
    }
    setSnapshotFillBatch('column')
    const batchId = Date.now()
    try {
      setItems(prev =>
        trimJobs([
          ...prev,
          ...pool.map((sym, i) => ({
            trackKey: `snap-col-${batchId}-${sym}`,
            kindLabel: `Snapshot per-contract column fill · ${sym}`,
            status: 'Enqueueing…',
            enqueuedAt: batchId + i,
          })),
        ]),
      )
      onJobsSheetOpenChange(true)
      let nOk = 0
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `snap-col-${batchId}-${sym}`
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_snapshots_pool_contract_fill',
          underlying: sym,
          max_contracts: 80,
        })
        if (!res.ok) {
          const msg = res.error ?? res.message ?? `Enqueue failed for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row => (row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row)),
          )
          break
        }
        const jid = res.job_id
        if (!jid) {
          const msg = `No job_id for ${sym}`
          setEnqueueErr(msg)
          setItems(prev =>
            prev.map(row => (row.trackKey === tk ? { ...row, status: 'failed', streamError: msg } : row)),
          )
          break
        }
        const dedup = Boolean(res.deduplicated)
        const st = dedup ? 'deduplicated (waiting)' : 'enqueued'
        setItems(prev =>
          prev.map(row =>
            row.trackKey === tk
              ? {
                  ...row,
                  jobId: jid,
                  deduplicated: dedup,
                  status: st,
                  kindLabel: `Snapshot per-contract column fill · ${sym}`,
                }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) {
        bumpSessionEnqueue(nOk)
        if (pool.length > MAX_TRACKED) setBulkEnqueueTrimHint(true)
        scheduleWatchlistRefresh()
      }
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setSnapshotFillBatch(null)
    }
  }, [snapshotColumnFillTargets, onJobsSheetOpenChange, scheduleWatchlistRefresh, startJobStream, bumpSessionEnqueue])

  const handleEnqueue = useCallback(async () => {
    setEnqueueErr(null)
    if (focusDataset === 'option_contracts') {
      await handleEnqueueRowGap()
      return
    }
    if (!plan.ok) {
      setEnqueueErr(plan.error)
      return
    }
    setEnqueueBusy(true)
    try {
      const res = await postMassiveSync(plan.syncKind, plan.payload)
      if (!res.ok) {
        setEnqueueErr(res.error ?? res.message ?? 'Enqueue failed')
        return
      }
      const jid = res.job_id
      if (!jid) {
        setEnqueueErr('No job_id returned')
        return
      }
      pushJob({ jobId: jid, kindLabel: plan.kindLabel, deduplicated: Boolean(res.deduplicated) })
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setEnqueueBusy(false)
    }
  }, [focusDataset, handleEnqueueRowGap, plan, pushJob])

  const activeCount = items.filter(x => {
    const s = (x.status || '').toLowerCase()
    return s !== 'done' && s !== 'failed' && !x.streamError
  }).length

  const clearCompleted = useCallback(() => {
    setItems(prev => {
      for (const x of prev) {
        const s = (x.status || '').toLowerCase()
        if (s === 'done' || s === 'failed' || x.streamError) {
          if (x.jobId) {
            sseClosersRef.current.get(x.jobId)?.()
            sseClosersRef.current.delete(x.jobId)
          }
        }
      }
      return prev.filter(x => {
        const s = (x.status || '').toLowerCase()
        return s !== 'done' && s !== 'failed' && !x.streamError
      })
    })
  }, [])

  const clearAll = useCallback(() => {
    sseClosersRef.current.forEach(close => close())
    sseClosersRef.current.clear()
    setItems([])
    setSessionEnqueueTotal(0)
    setBulkEnqueueTrimHint(false)
  }, [])

  const watchlistUpper = useMemo(
    () => wlSymbols.map(s => s.trim().toUpperCase()).filter(Boolean),
    [wlSymbols],
  )

  /** True when every watchlist symbol is in the pool (or watchlist is empty). */
  const allWatchlistInPool = useMemo(() => {
    if (watchlistUpper.length === 0) return true
    const set = new Set(poolUpper)
    return watchlistUpper.every(s => set.has(s))
  }, [watchlistUpper, poolUpper])

  const showSelectAllButton = watchlistUpper.length > 0 && !allWatchlistInPool
  const showClearButton = poolUpper.length > 0

  const compareEligible = useMemo(
    () =>
      poolUpper.filter(su => symbolsWithOptionContractsData.some(x => x.trim().toUpperCase() === su)),
    [poolUpper, symbolsWithOptionContractsData],
  )

  const poolGapRollup = useMemo(() => {
    if (poolUpper.length < 2) return null
    let pg = 0
    let refTot = 0
    let gapSum = 0
    let allCompared = true
    let comparedAt: string | undefined
    for (const su of poolUpper) {
      const g = refGapBySymbol[su]
      if (!g?.ok || !g.compared_at) {
        allCompared = false
        break
      }
      if (g.pg_total != null) pg += g.pg_total
      if (g.massive_total != null) refTot += g.massive_total
      if (typeof g.gap === 'number') gapSum += g.gap
      comparedAt = g.compared_at
    }
    if (!allCompared) return { kind: 'partial' as const, n: poolUpper.length }
    const coveragePct = refTot > 0 ? Math.round((pg / refTot) * 1000) / 10 : null
    return { kind: 'sum' as const, n: poolUpper.length, pg, refTot, gapSum, comparedAt, coveragePct }
  }, [poolUpper, refGapBySymbol])

  const poolSnapshotGapRollup = useMemo(() => {
    if (poolUpper.length < 2) return null
    let pg = 0
    let refTot = 0
    let gapSum = 0
    let allCompared = true
    let comparedAt: string | undefined
    for (const su of poolUpper) {
      const g = snapshotGapBySymbol[su]
      if (!g?.ok || !g.compared_at) {
        allCompared = false
        break
      }
      if (g.pg_total != null) pg += g.pg_total
      if (g.massive_total != null) refTot += g.massive_total
      if (typeof g.gap === 'number') gapSum += g.gap
      comparedAt = g.compared_at
    }
    if (!allCompared) return { kind: 'partial' as const, n: poolUpper.length }
    const coveragePct = refTot > 0 ? Math.round((pg / refTot) * 1000) / 10 : null
    return { kind: 'sum' as const, n: poolUpper.length, pg, refTot, gapSum, comparedAt, coveragePct }
  }, [poolUpper, snapshotGapBySymbol])

  /** Pool-level Cov% = 100 × ΣPG ÷ ΣRef (same as per-symbol definition, aggregated). */
  const poolBarsGapRollup = useMemo(() => {
    if (poolUpper.length < 2) return null
    let pg = 0
    let refTot = 0
    let gapSum = 0
    let allCompared = true
    let comparedAt: string | undefined
    for (const su of poolUpper) {
      const g = barsGapBySymbol[su]
      if (!g?.ok || !g.compared_at) {
        allCompared = false
        break
      }
      if (g.pg_total != null) pg += g.pg_total
      if (g.massive_total != null) refTot += g.massive_total
      if (typeof g.gap === 'number') gapSum += g.gap
      comparedAt = g.compared_at
    }
    if (!allCompared) return { kind: 'partial' as const, n: poolUpper.length }
    const coveragePct = refTot > 0 ? Math.round((pg / refTot) * 1000) / 10 : null
    return { kind: 'sum' as const, n: poolUpper.length, pg, refTot, gapSum, comparedAt, coveragePct }
  }, [poolUpper, barsGapBySymbol])

  const runCompareWithSheetTracking = useCallback(async () => {
    if (!onCompareMassiveReference || compareEligible.length === 0) return
    const batchId = Date.now()
    const syms = [...compareEligible]
    setItems(prev =>
      trimJobs([
        ...prev,
        ...syms.map((sym, i) => ({
          trackKey: `check-${batchId}-${sym}`,
          kindLabel: `Reference gap · ${sym}`,
          status: 'Running…',
          enqueuedAt: batchId + i,
        })),
      ]),
    )

    await onCompareMassiveReference(
      comparePool,
      {
        onSymbolStart: sym => {
          setItems(prev =>
            prev.map(r =>
              r.trackKey === `check-${batchId}-${sym}` ? { ...r, status: 'Running…' } : r,
            ),
          )
        },
        onSymbolDone: (sym, result) => {
          const gap = result.ok && typeof result.gap === 'number' ? result.gap : null
          const activitySummary =
            result.ok && gap != null
              ? `Gap ${gap > 0 ? `+${gap.toLocaleString()}` : gap.toLocaleString()}`
              : result.ok
                ? 'OK'
                : '—'
          setItems(prev =>
            prev.map(r =>
              r.trackKey === `check-${batchId}-${sym}`
                ? { ...r, status: 'done', activitySummary }
                : r,
            ),
          )
        },
        onSymbolError: (sym, message) => {
          setItems(prev =>
            prev.map(r =>
              r.trackKey === `check-${batchId}-${sym}`
                ? { ...r, status: 'failed', streamError: message }
                : r,
            ),
          )
        },
      },
      { maxExpiries: referenceCompareMaxExpiries },
    )
  }, [onCompareMassiveReference, compareEligible, comparePool, referenceCompareMaxExpiries])

  const runCompareSnapshotWithSheetTracking = useCallback(async () => {
    if (!onCompareSnapshotGap || compareEligible.length === 0) return
    const batchId = Date.now()
    const syms = [...compareEligible]
    setItems(prev =>
      trimJobs([
        ...prev,
        ...syms.map((sym, i) => ({
          trackKey: `snap-check-${batchId}-${sym}`,
          kindLabel: `Snapshot gap · ${sym}`,
          status: 'Running…',
          enqueuedAt: batchId + i,
        })),
      ]),
    )

    await onCompareSnapshotGap(comparePool, {
      onSymbolStart: sym => {
        setItems(prev =>
          prev.map(r =>
            r.trackKey === `snap-check-${batchId}-${sym}` ? { ...r, status: 'Running…' } : r,
          ),
        )
      },
      onSymbolDone: (sym, result) => {
        const gap = result.ok && typeof result.gap === 'number' ? result.gap : null
        const activitySummary =
          result.ok && gap != null
            ? `Gap ${gap > 0 ? `+${gap.toLocaleString()}` : gap.toLocaleString()}`
            : result.ok
              ? 'OK'
              : '—'
        setItems(prev =>
          prev.map(r =>
            r.trackKey === `snap-check-${batchId}-${sym}`
              ? { ...r, status: 'done', activitySummary }
              : r,
          ),
        )
      },
      onSymbolError: (sym, message) => {
        setItems(prev =>
          prev.map(r =>
            r.trackKey === `snap-check-${batchId}-${sym}`
              ? { ...r, status: 'failed', streamError: message }
              : r,
          ),
        )
      },
    })
  }, [onCompareSnapshotGap, compareEligible, comparePool])

  const runCompareBarsGapWithSheetTracking = useCallback(async () => {
    if (!onCompareBarsGap || poolUpper.length === 0) return
    const batchId = Date.now()
    const syms = [...poolUpper]
    setItems(prev =>
      trimJobs([
        ...prev,
        ...syms.map((sym, i) => ({
          trackKey: `bars-check-${batchId}-${sym}`,
          kindLabel: `Bars gap · ${sym}`,
          status: 'Running…',
          enqueuedAt: batchId + i,
        })),
      ]),
    )

    await onCompareBarsGap(comparePool, {
      onSymbolStart: sym => {
        setItems(prev =>
          prev.map(r =>
            r.trackKey === `bars-check-${batchId}-${sym}` ? { ...r, status: 'Running…' } : r,
          ),
        )
      },
      onSymbolDone: (sym, result) => {
        const gap = result.ok && typeof result.gap === 'number' ? result.gap : null
        const activitySummary =
          result.ok && gap != null
            ? `Gap ${gap > 0 ? `+${gap.toLocaleString()}` : gap.toLocaleString()}`
            : result.ok
              ? 'OK'
              : '—'
        setItems(prev =>
          prev.map(r =>
            r.trackKey === `bars-check-${batchId}-${sym}`
              ? { ...r, status: 'done', activitySummary }
              : r,
          ),
        )
      },
      onSymbolError: (sym, message) => {
        setItems(prev =>
          prev.map(r =>
            r.trackKey === `bars-check-${batchId}-${sym}`
              ? { ...r, status: 'failed', streamError: message }
              : r,
          ),
        )
      },
    })
  }, [onCompareBarsGap, poolUpper, comparePool])

  /** Single-symbol strip (pool size 1) or non-contracts unused strip path. */
  const selectedRefGap = useMemo(() => {
    if (isContractsFocus) {
      if (poolUpper.length !== 1) return undefined
      return refGapBySymbol[poolUpper[0]!]
    }
    const u = selectedSymbol.trim().toUpperCase()
    if (!u) return undefined
    return refGapBySymbol[u]
  }, [isContractsFocus, poolUpper, refGapBySymbol, selectedSymbol])

  const selectedSnapshotGap = useMemo(() => {
    if (!isSnapshotsFocus) return undefined
    if (poolUpper.length === 1) return snapshotGapBySymbol[poolUpper[0]!]
    const u = selectedSymbol.trim().toUpperCase()
    if (!u) return undefined
    return snapshotGapBySymbol[u]
  }, [isSnapshotsFocus, poolUpper, snapshotGapBySymbol, selectedSymbol])

  const selectedBarsGap = useMemo(() => {
    if (!isBarsFocus) return undefined
    if (poolUpper.length === 1) return barsGapBySymbol[poolUpper[0]!]
    const u = selectedSymbol.trim().toUpperCase()
    if (!u) return undefined
    return barsGapBySymbol[u]
  }, [isBarsFocus, poolUpper, barsGapBySymbol, selectedSymbol])

  const activeGapRollup = isContractsFocus
    ? poolGapRollup
    : isSnapshotsFocus
      ? poolSnapshotGapRollup
      : isBarsFocus
        ? poolBarsGapRollup
        : null
  const selectedActiveGap: OptionContractsReferenceGapResult | OptionSnapshotsContractsGapResult | undefined =
    isContractsFocus ? selectedRefGap : isSnapshotsFocus ? selectedSnapshotGap : isBarsFocus ? selectedBarsGap : undefined
  const gapLoading = (isContractsFocus && refGapLoading) || (isSnapshotsFocus && snapshotGapLoading) || (isBarsFocus && barsGapLoading)

  /** Every pooled symbol has finished Check with gap 0 — row-level reference upsert not needed. */
  const poolFullyClosed = useMemo(() => {
    if (!isContractsFocus || poolUpper.length === 0) return false
    return poolUpper.every(sym => {
      const g = refGapBySymbol[sym]
      return (
        g?.ok === true &&
        g.has_rows === true &&
        Boolean(g.compared_at) &&
        typeof g.gap === 'number' &&
        g.gap === 0
      )
    })
  }, [isContractsFocus, poolUpper, refGapBySymbol])

  const contractsFillBusy = contractsFillBatch != null
  const canEnqueueRow = isContractsFocus
    ? !contractsFillBusy && rowGapFillTargets.length > 0
    : plan.ok && !enqueueBusy
  const canEnqueueColumn = isContractsFocus && !contractsFillBusy && columnFillTargets.length > 0

  const fillRowGapButtonTitle = useMemo(() => {
    if (!isContractsFocus) return ''
    if (contractsFillBusy) return 'Another fill batch is in progress.'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (rowGapFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(refGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill row gap only enqueues symbols with a Compare result and a non-zero Gap.'
      }
      if (poolHasRefCompareTruncation(refGapBySymbol, poolUpper)) {
        return 'Aggregate gap may be incomplete: one or more symbols hit expiry or Massive API page limits. Raise Max expiries (Advanced) and run Check again before relying on Fill row gap.'
      }
      return 'Every checked symbol has Gap 0 — no row-level reference upsert is needed for this pool.'
    }
    return `Row-level gap: enqueue ${rowGapFillTargets.length} reference upsert job(s) for symbols with a non-zero Gap after Check (full underlying). Merges massive_option_ticker from the list API. Use Fill column data or All gaps for exercise_style / shares_per_contract detail.`
  }, [isContractsFocus, contractsFillBusy, poolUpper, rowGapFillTargets.length, refGapBySymbol])

  const fillColumnDataButtonTitle = useMemo(() => {
    if (!isContractsFocus) return ''
    if (contractsFillBusy) return 'Another fill batch is in progress.'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (columnFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(refGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill column data enqueues symbols with Compare complete and either SQL NULL cells (C gap &gt; 0) or nullable/ticker coverage below 97% on the watchlist matrix.'
      }
      return 'No pooled symbols need nullable column backfill at this threshold, or option_contracts coverage is not loaded — refresh the watchlist.'
    }
    return `Nullable columns: enqueue ${columnFillTargets.length} detail backfill job(s) for exercise_style and shares_per_contract (max 5000 contracts per symbol). Symbols with Check complete and (C gap &gt; 0 or column metrics below 97%). Rows need non-empty massive_option_ticker for detail calls.`
  }, [isContractsFocus, contractsFillBusy, poolUpper, columnFillTargets.length, refGapBySymbol])

  const optionMinFillBusy = optionMinFillBatch != null
  const optionDayFillBusy = optionDayFillBatch != null
  const canEnqueueOptionMinRow =
    isMinFocus &&
    !optionMinFillBusy &&
    !optionDayFillBusy &&
    !barsGapLoading &&
    optionMinRowFillTargets.length > 0
  const canEnqueueOptionMinColumn =
    isMinFocus &&
    !optionMinFillBusy &&
    !optionDayFillBusy &&
    !barsGapLoading &&
    !optionMinEligibilityLoading &&
    optionMinColumnFillTargets.length > 0

  const canEnqueueOptionDayRow =
    isDayFocus &&
    !optionDayFillBusy &&
    !optionMinFillBusy &&
    !barsGapLoading &&
    optionDayRowFillTargets.length > 0
  const canEnqueueOptionDayColumn =
    isDayFocus &&
    !optionDayFillBusy &&
    !optionMinFillBusy &&
    !barsGapLoading &&
    !optionDayEligibilityLoading &&
    optionDayColumnFillTargets.length > 0

  const snapshotFillBusy = snapshotFillBatch != null
  const canEnqueueSnapshotRow =
    isSnapshotsFocus &&
    !snapshotFillBusy &&
    !snapshotGapLoading &&
    snapshotRowFillTargets.length > 0
  const canEnqueueSnapshotColumn =
    isSnapshotsFocus &&
    !snapshotFillBusy &&
    !snapshotGapLoading &&
    snapshotColumnFillTargets.length > 0

  const fillOptionMinRowGapButtonTitle = useMemo(() => {
    if (!isMinFocus) return ''
    if (optionMinFillBusy) return 'Another fill batch is in progress.'
    if (barsGapLoading) return 'Wait for Check to finish.'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (optionMinRowFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(barsGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill row gap only enqueues symbols with a non-zero Gap (option_min vs option_contracts for this period).'
      }
      return 'Every checked symbol has Gap 0 for this period — no intraday aggregates backfill is needed.'
    }
    return `Enqueue Massive /v2/aggs (option_min_pool_row_gap) for up to 300 missing contracts per symbol (${optionMinPeriod}, 7-day window).`
  }, [
    isMinFocus,
    optionMinFillBusy,
    barsGapLoading,
    poolUpper,
    optionMinRowFillTargets.length,
    barsGapBySymbol,
    optionMinPeriod,
  ])

  const fillOptionMinColumnDataButtonTitle = useMemo(() => {
    if (!isMinFocus) return ''
    if (optionMinFillBusy) return 'Another fill batch is in progress.'
    if (barsGapLoading) return 'Wait for Check to finish.'
    if (optionMinEligibilityLoading) return 'Loading column health…'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (optionMinColumnFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(barsGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill column data re-fetches /v2/aggs for symbols with NULL OHLC, volume, or VWAP rows in the lookback window.'
      }
      return 'No pooled symbols need column refresh — incomplete bar rows are absent for this period in the lookback window.'
    }
    return `Enqueue Massive /v2/aggs (option_min_pool_column_fill) for up to 300 contracts per symbol (${optionMinPeriod}, 7-day window).`
  }, [
    isMinFocus,
    optionMinFillBusy,
    barsGapLoading,
    optionMinEligibilityLoading,
    poolUpper,
    optionMinColumnFillTargets.length,
    barsGapBySymbol,
    optionMinPeriod,
  ])

  const fillOptionDayRowGapButtonTitle = useMemo(() => {
    if (!isDayFocus) return ''
    if (optionDayFillBusy) return 'Another fill batch is in progress.'
    if (optionMinFillBusy) return 'Wait for the other bars fill batch to finish.'
    if (barsGapLoading) return 'Wait for Check to finish.'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (optionDayRowFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(barsGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill row gap only enqueues symbols with a non-zero Gap (option_day vs option_contracts).'
      }
      return 'Every checked symbol has Gap 0 — no daily aggregates backfill is needed for missing contract coverage.'
    }
    return 'Enqueue Celery option_day_pool_row_gap: Massive GET /v2/aggs (daily), fan-out into multiple jobs (~200 contracts each, up to 2000 total per symbol, ~2y window).'
  }, [
    isDayFocus,
    optionDayFillBusy,
    optionMinFillBusy,
    barsGapLoading,
    poolUpper,
    optionDayRowFillTargets.length,
    barsGapBySymbol,
  ])

  const fillOptionDayColumnDataButtonTitle = useMemo(() => {
    if (!isDayFocus) return ''
    if (optionDayFillBusy) return 'Another fill batch is in progress.'
    if (optionMinFillBusy) return 'Wait for the other bars fill batch to finish.'
    if (barsGapLoading) return 'Wait for Check to finish.'
    if (optionDayEligibilityLoading) return 'Loading column health…'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (optionDayColumnFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(barsGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill column data uses GET /v1/open-close plus optional VWAP from day aggs for incomplete rows.'
      }
      return 'No pooled symbols need column refresh at this threshold.'
    }
    return 'Enqueue option_day_pool_column_fill: open-close per trading day (30d lookback, max 300 rows), prioritizing bar-quality days below 97% when available.'
  }, [
    isDayFocus,
    optionDayFillBusy,
    optionMinFillBusy,
    barsGapLoading,
    optionDayEligibilityLoading,
    poolUpper,
    optionDayColumnFillTargets.length,
    barsGapBySymbol,
  ])

  const fillSnapshotRowGapButtonTitle = useMemo(() => {
    if (!isSnapshotsFocus) return ''
    if (snapshotFillBusy) return 'Another fill batch is in progress.'
    if (snapshotGapLoading) return 'Wait for Check to finish.'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (snapshotRowFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(snapshotGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill row gap enqueues chain snapshot for symbols with a non-zero Gap vs option_snapshots.'
      }
      return 'Every checked symbol has Gap 0 — no chain snapshot row fill is needed.'
    }
    return 'Enqueue Massive chain snapshot (GET /v3/snapshot/options) for pooled symbols with non-zero Gap after Check.'
  }, [isSnapshotsFocus, snapshotFillBusy, snapshotGapLoading, poolUpper, snapshotRowFillTargets.length, snapshotGapBySymbol])

  const fillSnapshotColumnDataButtonTitle = useMemo(() => {
    if (!isSnapshotsFocus) return ''
    if (snapshotFillBusy) return 'Another fill batch is in progress.'
    if (snapshotGapLoading) return 'Wait for Check to finish.'
    if (poolUpper.length === 0) {
      return 'Add symbols to the compare pool (click Symbol in the matrix), or use Select all.'
    }
    if (snapshotColumnFillTargets.length === 0) {
      const anyUnchecked = poolUpper.some(s => !hasRefCompareDone(snapshotGapBySymbol[s]))
      if (anyUnchecked) {
        return 'Run Check on the pool first. Fill column data uses per-contract snapshot API for symbols with IV / Greeks / OI coverage below 97% on the watchlist matrix.'
      }
      return 'No pooled symbols need snapshot column refresh at this threshold.'
    }
    return 'Enqueue option_snapshots_pool_contract_fill: per-contract GET /v3/snapshot/options/{u}/{contract}, capped per job.'
  }, [isSnapshotsFocus, snapshotFillBusy, snapshotGapLoading, poolUpper, snapshotColumnFillTargets.length, snapshotGapBySymbol])

  const canCompareSelected =
    isContractsFocus && !refGapLoading && compareEligible.length > 0 && Boolean(onCompareMassiveReference)

  const canCompareSnapshotSelected =
    isSnapshotsFocus &&
    !snapshotGapLoading &&
    !snapshotFillBusy &&
    compareEligible.length > 0 &&
    Boolean(onCompareSnapshotGap)

  const canCompareBarsSelected =
    isBarsFocus &&
    !barsGapLoading &&
    !optionMinFillBusy &&
    !optionDayFillBusy &&
    poolUpper.length > 0 &&
    Boolean(onCompareBarsGap)

  const selectedGapNumClass =
    selectedActiveGap?.ok === true && typeof selectedActiveGap.gap === 'number'
      ? selectedActiveGap.gap === 0
        ? 'data-overview-ref-strip__gap-num data-overview-ref-strip__gap-num--ok'
        : 'data-overview-ref-strip__gap-num data-overview-ref-strip__gap-num--warn'
      : 'data-overview-ref-strip__gap-num'

  const rollupGapNumClass =
    activeGapRollup?.kind === 'sum' && typeof activeGapRollup.gapSum === 'number'
      ? activeGapRollup.gapSum === 0
        ? 'data-overview-ref-strip__gap-num data-overview-ref-strip__gap-num--ok'
        : 'data-overview-ref-strip__gap-num data-overview-ref-strip__gap-num--warn'
      : 'data-overview-ref-strip__gap-num'

  const rollupCovPctClass =
    activeGapRollup?.kind === 'sum' && activeGapRollup.coveragePct != null
      ? activeGapRollup.coveragePct === 100
        ? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--ok'
        : 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn'
      : 'data-overview-ref-strip__cov-pct'

  const symbolSelectDisabled =
    !plan.ok ||
    !plan.needsSymbol ||
    wlSymbols.length === 0 ||
    (isContractsFocus
      ? contractsFillBusy
      : isSnapshotsFocus
        ? snapshotGapLoading || snapshotFillBusy
        : isBarsFocus
          ? barsGapLoading || optionMinFillBusy || optionDayFillBusy
          : enqueueBusy)

  useImperativeHandle(
    ref,
    () => ({
      enqueueReferenceUpsert: async (underlying: string, options?: { expiration_date?: string }) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        const payload: Record<string, unknown> = {
          mode: 'reference_upsert',
          underlying: u,
        }
        const exp = options?.expiration_date?.trim()
        if (exp) payload.expiration_date = exp
        const res = await postMassiveSync('feed_option_contracts', payload)
        if (!res.ok) {
          throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        }
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        const dedup = Boolean(res.deduplicated)
        const label = exp
          ? `Reference contracts · ${u} · ${exp}`
          : `Reference contracts · ${u}`
        pushJob({ jobId: jid, kindLabel: label, deduplicated: dedup })
        scheduleWatchlistRefresh()
      },
      enqueueNullableColumnFill: async (underlying: string, column: NullableOptionContractsColumnCode) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        if (column === 'massive_option_ticker') {
          const payload: Record<string, unknown> = {
            mode: 'reference_upsert',
            underlying: u,
          }
          const res = await postMassiveSync('feed_option_contracts', payload)
          if (!res.ok) {
            throw new Error(res.error ?? res.message ?? 'Enqueue failed')
          }
          const jid = res.job_id
          if (!jid) throw new Error('No job_id returned')
          const dedup = Boolean(res.deduplicated)
          pushJob({
            jobId: jid,
            kindLabel: `Reference contracts (ticker) · ${u}`,
            deduplicated: dedup,
          })
          scheduleWatchlistRefresh()
          return
        }
        const res = await postMassiveSync('feed_option_contracts', {
          mode: 'nullable_column_backfill',
          underlying: u,
          column,
          max_contracts: 5000,
        })
        if (!res.ok) {
          throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        }
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        const dedup = Boolean(res.deduplicated)
        const colLabel =
          column === 'exercise_style'
            ? 'exercise_style'
            : column === 'shares_per_contract'
              ? 'shares_per_contract'
              : column
        pushJob({
          jobId: jid,
          kindLabel: `Nullable columns · ${u} · ${colLabel}`,
          deduplicated: dedup,
        })
        scheduleWatchlistRefresh()
      },
      enqueueChainSnapshot: async (underlying: string, options?: { expiration_date?: string }) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        const payload: Record<string, unknown> = { underlying: u }
        const exp = options?.expiration_date?.trim()
        if (exp) payload.expiration_date = exp
        const res = await postMassiveSync('feed_option_snapshots', payload)
        if (!res.ok) throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        const dedup = Boolean(res.deduplicated)
        const label = exp ? `Chain snapshot · ${u} · ${exp}` : `Chain snapshot · ${u}`
        pushJob({ jobId: jid, kindLabel: label, deduplicated: dedup })
        startJobStream(jid)
        scheduleWatchlistRefresh()
      },
      enqueueOptionSnapshotsContractColumnFill: async (underlying: string) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_snapshots_pool_contract_fill',
          underlying: u,
          max_contracts: 80,
        })
        if (!res.ok) throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        const dedup = Boolean(res.deduplicated)
        pushJob({
          jobId: jid,
          kindLabel: `Snapshot per-contract column fill · ${u}`,
          deduplicated: dedup,
        })
        startJobStream(jid)
        scheduleWatchlistRefresh()
      },
      enqueueOptionDayPoolRowGap: async (
        underlying: string,
        options?: { expiration_date?: string },
      ) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        const exp = (options?.expiration_date ?? '').trim().slice(0, 32)
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_day_pool_row_gap',
          underlying: u,
          row_lookback_days: 730,
          max_contracts: OPTION_DAY_ROW_GAP_MAX_CONTRACTS,
          max_expiries: 60,
          chunk_size: OPTION_DAY_ROW_GAP_FANOUT_CHUNK_SIZE,
          ...(exp ? { expiration_date: exp } : {}),
        })
        if (!res.ok) throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        if (res.fan_out && res.job_ids && res.job_ids.length > 0) {
          const ids = res.job_ids
          const n = ids.length
          ids.forEach((jid, ci) => {
            pushJob({
              jobId: jid,
              kindLabel: exp
                ? `Fill option_day row gap · ${u} · ${exp} (${ci + 1}/${n})`
                : `Fill option_day row gap · ${u} (${ci + 1}/${n})`,
              deduplicated: false,
            })
            startJobStream(jid)
          })
          scheduleWatchlistRefresh()
          return
        }
        if (res.fan_out && (!res.job_ids || res.job_ids.length === 0)) {
          scheduleWatchlistRefresh()
          return
        }
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        pushJob({
          jobId: jid,
          kindLabel: exp
            ? `Fill option_day row gap · ${u} · ${exp}`
            : `Fill option_day row gap · ${u}`,
          deduplicated: Boolean(res.deduplicated),
        })
        startJobStream(jid)
        scheduleWatchlistRefresh()
      },
      enqueueOptionDayPoolColumnFill: async (underlying: string) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        let priority_dates: string[] | undefined
        try {
          const bq = await fetchBarQualityDetail(u, 'option_day', undefined, 60)
          const badDays = (bq.daily ?? []).filter(
            r =>
              (r.ohlc_pct != null && r.ohlc_pct < OPTION_CONTRACTS_COLUMN_HEALTH_PCT) ||
              (r.volume_pct != null && r.volume_pct < OPTION_CONTRACTS_COLUMN_HEALTH_PCT) ||
              (r.vwap_pct != null && r.vwap_pct < OPTION_CONTRACTS_COLUMN_HEALTH_PCT),
          )
          priority_dates = badDays.map(r => r.bar_day).slice(0, 40)
          if (priority_dates.length === 0) priority_dates = undefined
        } catch {
          priority_dates = undefined
        }
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_day_pool_column_fill',
          underlying: u,
          column_lookback_days: 30,
          max_rows: 300,
          ...(priority_dates ? { priority_dates } : {}),
        })
        if (!res.ok) throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        pushJob({
          jobId: jid,
          kindLabel: `Fill option_day column data · ${u}`,
          deduplicated: Boolean(res.deduplicated),
        })
        startJobStream(jid)
        scheduleWatchlistRefresh()
      },
      enqueueOptionMinPoolRowGap: async (
        underlying: string,
        options?: { expiration_date?: string },
      ) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        const exp = (options?.expiration_date ?? '').trim().slice(0, 32)
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_min_pool_row_gap',
          underlying: u,
          period: optionMinPeriod,
          lookback_days: 7,
          max_contracts: 300,
          ...(exp ? { expiration_date: exp } : {}),
        })
        if (!res.ok) throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        pushJob({
          jobId: jid,
          kindLabel: exp
            ? `Fill option_min row gap · ${u} · ${exp}`
            : `Fill option_min row gap · ${u}`,
          deduplicated: Boolean(res.deduplicated),
        })
        startJobStream(jid)
        scheduleWatchlistRefresh()
      },
      enqueueOptionMinPoolColumnFill: async (underlying: string) => {
        const u = underlying.trim().toUpperCase()
        if (!u) throw new Error('Underlying symbol is required.')
        const res = await postMassiveSync('feed_options_aggregate', {
          mode: 'option_min_pool_column_fill',
          underlying: u,
          period: optionMinPeriod,
          lookback_days: 7,
          max_contracts: 300,
        })
        if (!res.ok) throw new Error(res.error ?? res.message ?? 'Enqueue failed')
        const jid = res.job_id
        if (!jid) throw new Error('No job_id returned')
        pushJob({
          jobId: jid,
          kindLabel: `Fill option_min column data · ${u}`,
          deduplicated: Boolean(res.deduplicated),
        })
        startJobStream(jid)
        scheduleWatchlistRefresh()
      },
    }),
    [pushJob, scheduleWatchlistRefresh, startJobStream, optionMinPeriod],
  )

  return (
    <div className="data-overview-option-jobs-bar">
      {!isContractsFocus && !isSnapshotsFocus && !isBarsFocus ? (
        <>
          <div className="data-overview-option-jobs-bar__row">
            <div className="data-overview-option-jobs-bar__actions">
              {activeCount > 0 ? (
                <span className="ref-jobs-active-pill" aria-live="polite">
                  {activeCount} active
                </span>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!canEnqueueRow}
                onClick={() => void handleEnqueue()}
              >
                {enqueueBusy ? 'Enqueueing…' : 'Enqueue'}
              </button>
            </div>
            <label className="data-overview-option-jobs-bar__sym">
              <span className="data-overview-option-jobs-bar__sym-label">Underlying</span>
              <select
                className="form-input data-overview-option-jobs-bar__sym-select"
                value={selectedSymbol}
                disabled={symbolSelectDisabled}
                onChange={e => setSelectedSymbol(e.target.value)}
                aria-label="Underlying symbol for single enqueue"
              >
                {wlSymbols.length === 0 ? <option value="">—</option> : null}
                {wlSymbols.map(s => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {plan.ok ? (
            <p className="data-overview-option-jobs-bar__hint" title={plan.hint}>
              {plan.hint}
            </p>
          ) : (
            <p className="data-overview-option-jobs-bar__hint data-overview-option-jobs-bar__hint--err" role="status">
              {plan.error}
            </p>
          )}
        </>
      ) : isContractsFocus || isSnapshotsFocus || isBarsFocus ? (
        <section
          className="data-overview-contracts-panel"
          aria-label={
            isContractsFocus ? 'Reference gap pool and actions' :
            isSnapshotsFocus ? 'Snapshot gap pool and actions' :
            'Bars gap pool and actions'
          }
        >
          {!plan.ok && poolUpper.length > 0 ? (
            <p className="data-overview-option-jobs-bar__hint data-overview-option-jobs-bar__hint--err" role="status">
              {plan.error}
            </p>
          ) : null}
          {isContractsFocus ? (
            <details
              className="data-overview-contracts-panel__conclusion"
              style={{ marginBottom: 'var(--space-2)' }}
            >
              <summary className="data-overview-contracts-panel__conclusion-sum">Advanced · reference compare</summary>
              <div className="data-overview-contracts-panel__conclusion-body">
                <label className="data-overview-option-jobs-bar__sym" style={{ alignItems: 'center', gap: '0.5rem' }}>
                  <span className="data-overview-option-jobs-bar__sym-label">Max expiries</span>
                  <select
                    className="form-input data-overview-option-jobs-bar__sym-select"
                    value={referenceCompareMaxExpiries}
                    disabled={refGapLoading}
                    onChange={e => setReferenceCompareMaxExpiries(Number(e.target.value))}
                    aria-label="Maximum distinct expiries scanned per symbol on Check"
                  >
                    <option value={60}>60 (default)</option>
                    <option value={90}>90</option>
                    <option value={120}>120 (server cap)</option>
                  </select>
                </label>
                <p className="data-overview-option-jobs-bar__hint" style={{ marginTop: 'var(--space-2)', marginBottom: 0 }}>
                  Higher values increase Compare time and Massive API usage. Rollup Gap / Cov% only cover expiries included in
                  this scan.
                </p>
              </div>
            </details>
          ) : null}
          {isMinFocus ? (
            <div
              className="data-overview-contracts-panel__option-min-period"
              style={{ marginBottom: 'var(--space-2)' }}
            >
              <label className="data-overview-option-jobs-bar__sym" style={{ alignItems: 'center', gap: '0.5rem' }}>
                <span className="data-overview-option-jobs-bar__sym-label">Bar period</span>
                <select
                  className="form-input data-overview-option-jobs-bar__sym-select"
                  value={optionMinPeriod}
                  disabled={optionMinFillBusy || optionDayFillBusy || barsGapLoading}
                  onChange={e => onOptionMinPeriodChange?.(e.target.value)}
                  aria-label="option_min bar period for Check and Fill actions"
                >
                  {OPTION_MIN_INTRADAY_PERIODS.map(p => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ) : null}
          <div className="data-overview-contracts-panel__toolbar">
            <div className="data-overview-contracts-panel__toolbar-left">
              {activeCount > 0 ? (
                <span className="ref-jobs-active-pill" aria-live="polite">
                  {activeCount} active
                </span>
              ) : null}
              {gapLoading ? (
                <button
                  type="button"
                  className="data-overview-check-run-pill"
                  onClick={() => onJobsSheetOpenChange(true)}
                  title="Open Option coverage jobs to see Check progress and per-symbol rows."
                >
                  {isSnapshotsFocus ? 'Checking snapshot gaps…' : isBarsFocus ? 'Checking bars gaps…' : 'Checking reference gaps…'}
                </button>
              ) : null}
              <div className="data-overview-contracts-panel__pool" aria-label="Compare pool">
                <div className="data-overview-contracts-panel__group-head">
                  <span className="data-overview-contracts-panel__group-kicker">Pool</span>
                  <span className="data-overview-contracts-panel__group-count" title="Symbols in pool">
                    {poolUpper.length}
                  </span>
                </div>
                <div className="data-overview-contracts-panel__group-actions">
                  {showSelectAllButton ? (
                    <button
                      type="button"
                      className="data-overview-ctl data-overview-ctl--plain"
                      disabled={!onSelectAllComparePool}
                      title="Add every watchlist symbol to the compare pool."
                      onClick={() => onSelectAllComparePool?.()}
                    >
                      <IcoSelectAll className={ico} />
                      <span>Select all</span>
                    </button>
                  ) : null}
                  {showClearButton ? (
                    <button
                      type="button"
                      className="data-overview-ctl data-overview-ctl--plain"
                      disabled={!onClearComparePool}
                      title="Remove all symbols from the compare pool."
                      onClick={() => onClearComparePool?.()}
                    >
                      <IcoClearPool className={ico} />
                      <span>Clear</span>
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
            <div className="data-overview-contracts-panel__toolbar-right" aria-label="Reference gap">
              {(isContractsFocus || isSnapshotsFocus || isDayFocus || isMinFocus) && onOpenGapExplainSheet ? (
                <button
                  type="button"
                  className="data-overview-ctl data-overview-ctl--plain"
                  title={
                    isDayFocus
                      ? 'How Ref, Gap, and Cov% are defined for option_day bars vs option_contracts.'
                      : isMinFocus
                        ? 'How Ref, Gap, and Cov% are defined for option_min bars vs option_contracts (per Bar period).'
                        : isSnapshotsFocus
                          ? 'How Ref, Gap, and Cov% are defined for option_snapshots vs chain snapshot API.'
                          : 'How Ref, Gap, Cov%, and per-expiry breakdown are defined.'
                  }
                  onClick={() => onOpenGapExplainSheet()}
                >
                  <span>Gap scope</span>
                </button>
              ) : null}
              {(isContractsFocus || isSnapshotsFocus || isDayFocus || isMinFocus) && onOpenAllGapsSheet ? (
                <button
                  type="button"
                  className="data-overview-ctl data-overview-ctl--plain"
                  title={
                    isContractsFocus
                      ? 'Open per-expiry reference gap detail for pooled symbols.'
                      : isSnapshotsFocus
                        ? 'Open per-expiry snapshot gap detail for pooled symbols.'
                        : 'Open per-expiry bars gap detail for pooled symbols (same Check data).'
                  }
                  onClick={() => onOpenAllGapsSheet()}
                >
                  <span>All gaps</span>
                </button>
              ) : null}
              <button
                type="button"
                className="data-overview-ctl data-overview-ctl--check"
                disabled={isContractsFocus ? !canCompareSelected : isSnapshotsFocus ? !canCompareSnapshotSelected : !canCompareBarsSelected}
                title={
                  isSnapshotsFocus
                    ? 'Compare Massive GET /v3/snapshot/options vs PG option_snapshots for pooled symbols with option_contracts (one symbol per request).'
                    : isBarsFocus
                      ? 'Compare option_day / option_min bar coverage vs option_contracts (purely local, no external API call).'
                      : 'Compare Massive reference vs PG for pooled symbols that already have option_contracts rows (batched, 10 per request).'
                }
                onClick={() =>
                  void (isContractsFocus ? runCompareWithSheetTracking() : isSnapshotsFocus ? runCompareSnapshotWithSheetTracking() : runCompareBarsGapWithSheetTracking())
                }
              >
                <IcoRefCheck className={ico} />
                <span>{gapLoading ? 'Checking…' : 'Check'}</span>
              </button>
              {isContractsFocus ? (
                <>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill"
                    disabled={!canEnqueueRow}
                    title={fillRowGapButtonTitle}
                    onClick={() => void handleEnqueueRowGap()}
                    aria-label="Fill row gap"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {contractsFillBatch === 'row' ? 'Filling…' : 'Fill row gap'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill data-overview-ctl--fill-column"
                    disabled={!canEnqueueColumn}
                    title={fillColumnDataButtonTitle}
                    onClick={() => void handleEnqueueColumnData()}
                    aria-label="Fill column data"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {contractsFillBatch === 'column' ? 'Filling…' : 'Fill column data'}
                    </span>
                  </button>
                </>
              ) : isSnapshotsFocus ? (
                <>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill"
                    disabled={!canEnqueueSnapshotRow}
                    title={fillSnapshotRowGapButtonTitle}
                    onClick={() => void handleEnqueueSnapshotRowGap()}
                    aria-label="Fill row gap for option_snapshots"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {snapshotFillBatch === 'row' ? 'Filling…' : 'Fill row gap'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill data-overview-ctl--fill-column"
                    disabled={!canEnqueueSnapshotColumn}
                    title={fillSnapshotColumnDataButtonTitle}
                    onClick={() => void handleEnqueueSnapshotColumnData()}
                    aria-label="Fill column data for option_snapshots"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {snapshotFillBatch === 'column' ? 'Filling…' : 'Fill column data'}
                    </span>
                  </button>
                </>
              ) : isDayFocus ? (
                <>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill"
                    disabled={!canEnqueueOptionDayRow}
                    title={fillOptionDayRowGapButtonTitle}
                    onClick={() => void handleEnqueueOptionDayRowGap()}
                    aria-label="Fill row gap for option_day"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {optionDayFillBatch === 'row' ? 'Filling…' : 'Fill row gap'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill data-overview-ctl--fill-column"
                    disabled={!canEnqueueOptionDayColumn}
                    title={fillOptionDayColumnDataButtonTitle}
                    onClick={() => void handleEnqueueOptionDayColumnData()}
                    aria-label="Fill column data for option_day"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {optionDayFillBatch === 'column' ? 'Filling…' : 'Fill column data'}
                    </span>
                  </button>
                </>
              ) : isMinFocus ? (
                <>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill"
                    disabled={!canEnqueueOptionMinRow}
                    title={fillOptionMinRowGapButtonTitle}
                    onClick={() => void handleEnqueueOptionMinRowGap()}
                    aria-label="Fill row gap for option_min"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {optionMinFillBatch === 'row' ? 'Filling…' : 'Fill row gap'}
                    </span>
                  </button>
                  <button
                    type="button"
                    className="data-overview-ctl data-overview-ctl--fill data-overview-ctl--fill-column"
                    disabled={!canEnqueueOptionMinColumn}
                    title={fillOptionMinColumnDataButtonTitle}
                    onClick={() => void handleEnqueueOptionMinColumnData()}
                    aria-label="Fill column data for option_min"
                  >
                    <IcoFillGap className={ico} />
                    <span>
                      {optionMinFillBatch === 'column' ? 'Filling…' : 'Fill column data'}
                    </span>
                  </button>
                </>
              ) : null}
            </div>
          </div>

          <div className="data-overview-contracts-panel__summary" aria-live="polite">
            {poolUpper.length >= 2 && activeGapRollup?.kind === 'sum' ? (
              <span className="data-overview-ref-strip__meta">
                <strong>{activeGapRollup.n} symbols</strong>
                {' · '}
                PG {activeGapRollup.pg.toLocaleString()}
                {' · '}
                Ref {activeGapRollup.refTot.toLocaleString()}
                {' · '}
                Gap{' '}
                <span className={rollupGapNumClass}>
                  {activeGapRollup.gapSum > 0
                    ? `+${activeGapRollup.gapSum.toLocaleString()}`
                    : activeGapRollup.gapSum.toLocaleString()}
                </span>
                {activeGapRollup.coveragePct != null ? (
                  <>
                    {' · '}
                    <span className={rollupCovPctClass} title="Pool Cov% = 100 × ΣPG ÷ ΣRef">
                      {activeGapRollup.coveragePct}%
                    </span>
                  </>
                ) : null}
                <span className="data-overview-ref-strip__time" title="compared_at (UTC, last symbol in batch)">
                  {' '}
                  · {activeGapRollup.comparedAt}
                </span>
              </span>
            ) : selectedActiveGap?.ok && selectedActiveGap.compared_at ? (
              <span className="data-overview-ref-strip__meta">
                <strong>{poolUpper.length === 1 ? poolUpper[0] : selectedSymbol.trim().toUpperCase() || '—'}</strong>
                {' · '}
                PG {selectedActiveGap.pg_total != null ? selectedActiveGap.pg_total.toLocaleString() : '—'}
                {' · '}
                Ref {selectedActiveGap.massive_total != null ? selectedActiveGap.massive_total.toLocaleString() : '—'}
                {' · '}
                Gap{' '}
                <span className={selectedGapNumClass}>
                  {selectedActiveGap.gap != null
                    ? selectedActiveGap.gap > 0
                      ? `+${selectedActiveGap.gap.toLocaleString()}`
                      : selectedActiveGap.gap.toLocaleString()
                    : '—'}
                </span>
                {selectedActiveGap.coverage_pct != null ? (
                  <>
                    {' · '}
                    <span
                      className={
                        selectedActiveGap.coverage_pct === 100
                          ? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--ok'
                          : 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn'
                      }
                    >
                      {selectedActiveGap.coverage_pct}%
                    </span>
                  </>
                ) : null}
                {isContractsFocus &&
                selectedActiveGap.distinct_expiry_total != null &&
                selectedActiveGap.expiries_scanned != null ? (
                  <>
                    {' · '}
                    <span
                      className="data-overview-ref-strip__meta data-overview-ref-strip__meta--muted"
                      title="Expiries scanned in this Compare vs distinct expiries in PostgreSQL"
                    >
                      {selectedActiveGap.expiries_scanned}/{selectedActiveGap.distinct_expiry_total} exp.
                    </span>
                  </>
                ) : null}
                <span className="data-overview-ref-strip__time" title="compared_at (UTC)">
                  {' '}
                  · {selectedActiveGap.compared_at}
                </span>
              </span>
            ) : poolUpper.length >= 2 && activeGapRollup?.kind === 'partial' ? (
              <span className="data-overview-ref-strip__meta data-overview-ref-strip__meta--muted">
                {activeGapRollup.n} symbols — run <strong>Check</strong> for Ref / Gap.
              </span>
            ) : poolUpper.length > 0 ? (
              <span className="data-overview-ref-strip__meta data-overview-ref-strip__meta--muted">
                Run <strong>Check</strong> for PG / Ref / Gap.
              </span>
            ) : (
              <span className="data-overview-ref-strip__meta data-overview-ref-strip__meta--muted">—</span>
            )}
          </div>

          {isContractsFocus ? (
            <details className="data-overview-contracts-panel__conclusion">
              <summary className="data-overview-contracts-panel__conclusion-sum">
                Pool & actions — summary
              </summary>
              <div className="data-overview-contracts-panel__conclusion-body">
                <p className="data-overview-contracts-panel__guide-text">
                  <span className="data-overview-contracts-panel__em">Pool:</span> <strong>Symbol</strong> column,{' '}
                  <strong>Select all</strong>, or <strong>Clear</strong>.{' '}
                  <span className="data-overview-contracts-panel__em">Check</span> vs PG.{' '}
                  <span className="data-overview-contracts-panel__em">Fill row gap</span> is available only after{' '}
                  <strong>Check</strong> and enqueues reference upsert only for pooled symbols that still have a{' '}
                  <strong>non-zero Gap</strong> (full underlying; list API + <code>massive_option_ticker</code>).{' '}
                  <span className="data-overview-contracts-panel__em">Fill column data</span> also requires Check and enqueues
                  detail backfill only for symbols whose watchlist <code>option_contracts</code> metrics are still below{' '}
                  <strong>97%</strong> (ticker / nullable averages). Per-column actions also live under{' '}
                  <span className="data-overview-contracts-panel__em">All gaps</span>. <strong>Gap scope</strong> defines Ref,
                  Gap, Cov%, and per-expiry sections.
                </p>
              </div>
            </details>
          ) : isSnapshotsFocus ? (
            <details className="data-overview-contracts-panel__conclusion">
              <summary className="data-overview-contracts-panel__conclusion-sum">
                Pool & snapshot Check
              </summary>
              <div className="data-overview-contracts-panel__conclusion-body">
                <p className="data-overview-contracts-panel__guide-text">
                  <span className="data-overview-contracts-panel__em">Check</span> calls Massive{' '}
                  <code>GET /v3/snapshot/options/&#123;underlying&#125;</code> per expiry (see <strong>Gap scope</strong>). Ref counts
                  contracts returned by that API that map to <code>option_contracts.contract_key</code>. Requires{' '}
                  <code>option_contracts</code> rows for the symbol.
                </p>
              </div>
            </details>
          ) : isBarsFocus ? (
            <details className="data-overview-contracts-panel__conclusion">
              <summary className="data-overview-contracts-panel__conclusion-sum">
                Pool & bars Check
              </summary>
              <div className="data-overview-contracts-panel__conclusion-body">
                <p className="data-overview-contracts-panel__guide-text">
                  <span className="data-overview-contracts-panel__em">Check</span> compares{' '}
                  <code>{focusDataset === 'option_min' ? 'option_min' : 'option_day'}</code> bar coverage against{' '}
                  <code>option_contracts</code> (purely local — no external API). Ref = distinct (expiry, strike, right) in{' '}
                  <code>option_contracts</code>. Gap = contracts with no bar. Click <strong>↗</strong> on a symbol for daily / expiry quality breakdown.
                  {' '}
                  Open <strong>All gaps</strong> for per-expiry tables (same data as <strong>Check</strong>). Symbol-level{' '}
                  <strong>Fill row gap</strong> / <strong>Fill column data</strong> match the toolbar. Use <strong>↗</strong> /{' '}
                  <strong>Bar quality</strong> for extra daily or expiry metrics.
                  {isDayFocus ? (
                    <>
                      {' '}
                      For <code>option_day</code>, <strong>Fill row gap</strong> enqueues <code>option_day_pool_row_gap</code>{' '}
                      (Massive GET /v2/aggs daily, ~2y window, capped contracts per run). <strong>Fill column data</strong> runs{' '}
                      <code>option_day_pool_column_fill</code> using GET /v1/open-close for incomplete rows; bar-quality days
                      below 97% are prioritized when enqueuing column fill.
                    </>
                  ) : null}
                  {isMinFocus ? (
                    <>
                      {' '}
                      For <code>option_min</code>, pick <strong>Bar period</strong> to match <code>option_min.period</code>{' '}
                      (e.g. 5 mins). <strong>Fill row gap</strong> enqueues Celery <code>option_min_pool_row_gap</code> (Massive
                      GET /v2/aggs, up to 300 contracts per run, 7-day window). <strong>Fill column data</strong> runs{' '}
                      <code>option_min_pool_column_fill</code> to refresh rows with missing OHLC, volume, or VWAP.
                    </>
                  ) : null}
                </p>
              </div>
            </details>
          ) : null}

          {poolFullyClosed ? (
            <p className="data-overview-contracts-panel__gate" role="status">
              Every pooled symbol has finished <strong>Check</strong> with total <strong>gap 0</strong> —{' '}
              <strong>Fill row gap</strong> is not needed. If nullable columns are still below 97% after Check, use{' '}
              <strong>Fill column data</strong> (when enabled) or <strong>All gaps</strong>.
            </p>
          ) : null}
          {isContractsFocus && refGapError ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>
              {refGapError}
            </p>
          ) : null}
          {isSnapshotsFocus && snapshotGapError ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>
              {snapshotGapError}
            </p>
          ) : null}
          {isBarsFocus && barsGapError ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>
              {barsGapError}
            </p>
          ) : null}
        </section>
      ) : null}

      {enqueueErr ? (
        <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>
          {enqueueErr}
        </p>
      ) : null}

      <DataOverviewOptionJobsSheet
        open={jobsSheetOpen}
        onClose={() => onJobsSheetOpenChange(false)}
        items={items}
        onClearCompleted={clearCompleted}
        onClearAll={clearAll}
        onRefreshCoverage={onWatchlistRefreshRequested}
        maxTracked={MAX_TRACKED}
        sessionEnqueueTotal={sessionEnqueueTotal}
        bulkEnqueueTrimHint={bulkEnqueueTrimHint}
      />
    </div>
  )
})

DataOverviewOptionJobsBar.displayName = 'DataOverviewOptionJobsBar'
