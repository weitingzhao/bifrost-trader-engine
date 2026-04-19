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
} from '../../api'
import {
  formatRefJobIdShort,
  summarizeRefJobResult,
} from '../massive/stockReferenceJobHelpers'
import type { OptionsFocusDataset } from './optionFocusDataset'
import { DEFAULT_OPTION_MIN_PERIOD, OPTION_MIN_INTRADAY_PERIODS } from '../../utils/optionBarPeriods'

/** Watchlist optionable symbols max 80; batch chain jobs need headroom. */
const MAX_TRACKED = 96

/** Align with All gaps / matrix coloring: below 97% is review or attention. */
const OPTION_CONTRACTS_COLUMN_HEALTH_PCT = 97

function hasRefCompareDone(g: OptionContractsReferenceGapResult | undefined): boolean {
  return Boolean(g?.ok && g.compared_at)
}

/** Row-level PG vs reference mismatch (after Check). */
function symbolHasRowGapIssue(g: OptionContractsReferenceGapResult | undefined): boolean {
  if (!hasRefCompareDone(g)) return false
  return typeof g!.gap === 'number' && g!.gap !== 0
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
  return (
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
      syncKind: 'snapshot',
      payload: { snapshot_type: 'chain', underlying: u },
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
        syncKind: 'contracts',
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
}: {
  open: boolean
  onClose: () => void
  items: OptionJobTrackItem[]
  onClearCompleted: () => void
  onClearAll: () => void
  /** Reload Data Overview coverage (watchlist matrix, global summary, job summaries) without a full page refresh. */
  onRefreshCoverage?: () => void | Promise<void>
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
          and summaries after jobs finish (no full page reload).
        </p>

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
              Celery queues
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
  const [optionMinEligibility, setOptionMinEligibility] = useState<
    Record<string, { needs_row_fill: boolean; needs_column_fill: boolean }>
  >({})
  const [optionMinEligibilityLoading, setOptionMinEligibilityLoading] = useState(false)
  const [optionDayEligibility, setOptionDayEligibility] = useState<
    Record<string, { needs_row_fill: boolean; needs_column_fill: boolean }>
  >({})
  const [optionDayEligibilityLoading, setOptionDayEligibilityLoading] = useState(false)
  const [enqueueErr, setEnqueueErr] = useState<string | null>(null)

  const optionMinPeriod = optionMinPeriodProp

  const sseClosersRef = useRef<Map<string, () => void>>(new Map())
  const refreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      sseClosersRef.current.forEach(close => close())
      sseClosersRef.current.clear()
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

  const startJobStream = useCallback((jid: string) => {
    if (sseClosersRef.current.has(jid)) return
    const sub = subscribeMassiveJobEvents(
      jid,
      data => {
        setItems(prev =>
          prev.map(row => {
            if (row.jobId !== jid) return row
            if (!data.ok) {
              sseClosersRef.current.delete(jid)
              return { ...row, streamError: data.error ?? 'Job stream error', status: 'failed' }
            }
            const j = data.job
            const st = (j?.status ?? '').trim() || 'running'
            const stLower = st.toLowerCase()
            if (stLower === 'done' || stLower === 'failed') {
              sseClosersRef.current.delete(jid)
              if (stLower === 'done') scheduleWatchlistRefresh()
            }
            return {
              ...row,
              status: st,
              job: j,
              streamError: row.streamError,
            }
          }),
        )
      },
      { timeoutSec: 86400 },
    )
    sseClosersRef.current.set(jid, sub.close)
  }, [scheduleWatchlistRefresh])

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
      onJobsSheetOpenChange(true)
      startJobStream(jid)
    },
    [startJobStream, onJobsSheetOpenChange],
  )

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
        const res = await postMassiveSync('contracts', payload)
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
          const res = await postMassiveSync('contracts', payload)
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
        const res = await postMassiveSync('contracts', {
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
    }),
    [pushJob, scheduleWatchlistRefresh],
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
        const res = await postMassiveSync('contracts', {
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
      if (nOk > 0) scheduleWatchlistRefresh()
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setContractsFillBatch(null)
    }
  }, [rowGapFillTargets, onJobsSheetOpenChange, scheduleWatchlistRefresh, startJobStream])

  const handleEnqueueColumnData = useCallback(async () => {
    setEnqueueErr(null)
    const pool = columnFillTargets
    if (pool.length === 0) {
      setEnqueueErr(
        'Run Check on the pool first. Fill column data only enqueues symbols with a Compare result and nullable column coverage below 97%.',
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
        const res = await postMassiveSync('contracts', {
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
      if (nOk > 0) scheduleWatchlistRefresh()
    } catch (e) {
      setEnqueueErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setContractsFillBatch(null)
    }
  }, [columnFillTargets, onJobsSheetOpenChange, scheduleWatchlistRefresh, startJobStream])

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
        const res = await postMassiveSync('aggregates', {
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
      if (nOk > 0) scheduleWatchlistRefresh()
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
        const res = await postMassiveSync('aggregates', {
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
      if (nOk > 0) scheduleWatchlistRefresh()
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
      for (let i = 0; i < pool.length; i++) {
        const sym = pool[i]!
        const tk = `opt-day-row-${batchId}-${sym}`
        const res = await postMassiveSync('aggregates', {
          mode: 'option_day_pool_row_gap',
          underlying: sym,
          row_lookback_days: 730,
          max_contracts: 300,
          max_expiries: 60,
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
              ? { ...row, jobId: jid, deduplicated: dedup, status: st, kindLabel: `Fill option_day row gap · ${sym}` }
              : row,
          ),
        )
        startJobStream(jid)
        nOk += 1
        if (i < pool.length - 1) await delayMs(75)
      }
      if (nOk > 0) scheduleWatchlistRefresh()
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
        const res = await postMassiveSync('aggregates', {
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
      if (nOk > 0) scheduleWatchlistRefresh()
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
  ])

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
    return { kind: 'sum' as const, n: poolUpper.length, pg, refTot, gapSum, comparedAt }
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
    return { kind: 'sum' as const, n: poolUpper.length, pg, refTot, gapSum, comparedAt }
  }, [poolUpper, snapshotGapBySymbol])

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

    await onCompareMassiveReference(comparePool, {
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
    })
  }, [onCompareMassiveReference, compareEligible, comparePool])

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
        return 'Run Check on the pool first. Fill column data only enqueues symbols with Compare complete and nullable/ticker coverage below 97% (watchlist matrix).'
      }
      return 'No pooled symbols need nullable column backfill at this threshold, or option_contracts coverage is not loaded — refresh the watchlist.'
    }
    return `Nullable columns: enqueue ${columnFillTargets.length} detail backfill job(s) for exercise_style and shares_per_contract (max 5000 contracts per symbol). Only symbols with Check complete and column metrics below 97%. Rows need non-empty massive_option_ticker for detail calls.`
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
    return 'Enqueue Celery option_day_pool_row_gap: Massive GET /v2/aggs (daily) up to 300 contracts per symbol (~2y window).'
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

  const canCompareSelected =
    isContractsFocus && !refGapLoading && compareEligible.length > 0 && Boolean(onCompareMassiveReference)

  const canCompareSnapshotSelected =
    isSnapshotsFocus &&
    !snapshotGapLoading &&
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

  const symbolSelectDisabled =
    !plan.ok ||
    !plan.needsSymbol ||
    wlSymbols.length === 0 ||
    (isContractsFocus
      ? contractsFillBusy
      : isSnapshotsFocus
        ? snapshotGapLoading
        : isBarsFocus
          ? barsGapLoading || optionMinFillBusy || optionDayFillBusy
          : enqueueBusy)

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
              {(isContractsFocus || isSnapshotsFocus || isDayFocus) && onOpenGapExplainSheet ? (
                <button
                  type="button"
                  className="data-overview-ctl data-overview-ctl--plain"
                  title="How Ref, Gap, Cov%, and per-expiry breakdown are defined."
                  onClick={() => onOpenGapExplainSheet()}
                >
                  <span>Gap scope</span>
                </button>
              ) : null}
              {isContractsFocus && onOpenAllGapsSheet ? (
                <button
                  type="button"
                  className="data-overview-ctl data-overview-ctl--plain"
                  title="Open per-expiry gap detail for every watchlist symbol."
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
      />
    </div>
  )
})

DataOverviewOptionJobsBar.displayName = 'DataOverviewOptionJobsBar'
