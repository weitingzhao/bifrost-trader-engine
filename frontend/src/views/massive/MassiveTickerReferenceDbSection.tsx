import { useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import {
  fetchTickerReferenceDetail,
  fetchTickerReferenceFilledRelated,
  fetchTickerReferenceMissingOverview,
  fetchTickerReferenceMissingRelated,
  fetchTickerReferenceOverviewCoverage,
  fetchTickerReferenceRelated,
  fetchTickerReferenceRelatedCoverage,
  fetchTickerReferenceTickerTypesRowCount,
  fetchTickerReferenceUniverseCount,
  fetchTickerTypesFromDb,
  fetchTickerReferenceSearch,
} from '../../api'
import type { TickerReferenceJobKind, TickerReferenceSearchRow } from '../../api'
import { Button } from '@/components/ui/button'
import { RefJobDetailPanel } from './RefJobDetailPanel'
import { useMassiveRefJobSession } from './MassiveRefJobSessionContext'
import {
  DEFAULT_TICKER_REF_SEARCH_LIMIT,
  REF_TICKER_JOB_ROWS,
  getRefCatalogRow,
  parseRefJobSymbols,
  refJobKindShortLabel,
  DEFAULT_TICKER_REF_MISSING_LIMIT,
  validateMissingOverviewLimit,
  validateRefJobSymbolsForEnqueue,
  validateSearchLimit,
  validateSingleTickerSymbol,
  validateTickerRefSearchQuery,
  isFeedStocksTickersRelatedRefKind,
  isFeedStocksTickersOverviewRefKind,
  isFeedStocksTickersReferenceUniverseRefKind,
  isFeedStocksTickersTypesRefKind,
  type OverviewEnqueueMode,
  type RelatedEnqueueMode,
} from './stockReferenceJobHelpers'

const DEFAULT_REF_JOB_SYMBOLS = 'AAPL, MSFT, GOOGL'


export interface MassiveTickerReferenceDbSectionProps {
  panelId?: string
  ariaLabelledBy?: string
  showInitControls?: boolean
  /** When false, hide the Jobs control (use section-level Jobs for Massive Delay DB). */
  showJobsToolbar?: boolean
  /** Use `region` when this block sits inside another tab panel (Massive Delay DB). */
  rootRole?: 'tabpanel' | 'region'
}

/**
 * PostgreSQL-backed ticker reference: Scheme C master–detail (job list + per-job enqueue + verify).
 * Shared by Feed → Massive Stock and Data Coverage → Stock → Massive Delay (DB).
 */
export function MassiveTickerReferenceDbSection({
  panelId = 'massive-stock-refdb-panel',
  ariaLabelledBy = 'massive-stock-refdb-heading',
  showInitControls = true,
  showJobsToolbar = true,
  rootRole = 'tabpanel',
}: MassiveTickerReferenceDbSectionProps) {
  const [selectedRefJobKind, setSelectedRefJobKind] = useState<TickerReferenceJobKind>(REF_TICKER_JOB_ROWS[0].kind)

  const [searchQuery, setSearchQuery] = useState('A')
  const [searchLimit, setSearchLimitState] = useState(DEFAULT_TICKER_REF_SEARCH_LIMIT)
  const [overviewSymbol, setOverviewSymbol] = useState('AAPL')
  const [relatedSymbol, setRelatedSymbol] = useState('AAPL')

  const [busy, setBusy] = useState(false)
  const [verifyErr, setVerifyErr] = useState<string | null>(null)
  const [enqueueErr, setEnqueueErr] = useState<string | null>(null)

  const [searchRows, setSearchRows] = useState<TickerReferenceSearchRow[]>([])
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [related, setRelated] = useState<Record<string, unknown> | null>(null)
  const [typesRows, setTypesRows] = useState<Record<string, unknown>[] | null>(null)

  const [refJobSymbols, setRefJobSymbols] = useState(DEFAULT_REF_JOB_SYMBOLS)
  const [refJobSymbolsErr, setRefJobSymbolsErr] = useState<string | null>(null)
  const [overviewEnqueueMode, setOverviewEnqueueMode] = useState<OverviewEnqueueMode>('missing')
  const [overviewStaleHours, setOverviewStaleHours] = useState(720)
  const [relatedEnqueueMode, setRelatedEnqueueMode] = useState<RelatedEnqueueMode>('missing')
  const [relatedStaleHours, setRelatedStaleHours] = useState(720)

  const [overviewCoverage, setOverviewCoverage] = useState<{
    total_tickers: number
    missing: number
    filled: number
  } | null>(null)
  const [overviewCoverageLoading, setOverviewCoverageLoading] = useState(false)

  const [overviewMissingLimit, setOverviewMissingLimit] = useState(DEFAULT_TICKER_REF_MISSING_LIMIT)
  const [missingOverviewTickers, setMissingOverviewTickers] = useState<string[] | null>(null)
  const [missingOverviewTotal, setMissingOverviewTotal] = useState<number | null>(null)
  const [missingOverviewHasMore, setMissingOverviewHasMore] = useState(false)
  const [overviewVerifyKind, setOverviewVerifyKind] = useState<'merged' | 'missing' | null>(null)
  const [overviewMissingVerifyAppend, setOverviewMissingVerifyAppend] = useState(false)

  const [relatedCoverage, setRelatedCoverage] = useState<{
    total_tickers: number
    missing: number
    filled: number
  } | null>(null)
  const [relatedCoverageLoading, setRelatedCoverageLoading] = useState(false)
  const [relatedListPageLimit, setRelatedListPageLimit] = useState(DEFAULT_TICKER_REF_MISSING_LIMIT)
  const [missingRelatedTickers, setMissingRelatedTickers] = useState<string[] | null>(null)
  const [missingRelatedTotal, setMissingRelatedTotal] = useState<number | null>(null)
  const [missingRelatedHasMore, setMissingRelatedHasMore] = useState(false)
  const [filledRelatedTickers, setFilledRelatedTickers] = useState<string[] | null>(null)
  const [filledRelatedTotal, setFilledRelatedTotal] = useState<number | null>(null)
  const [filledRelatedHasMore, setFilledRelatedHasMore] = useState(false)
  const [relatedVerifyKind, setRelatedVerifyKind] = useState<'symbol' | 'missing' | 'filled' | null>(null)
  const [relatedMissingVerifyAppend, setRelatedMissingVerifyAppend] = useState(false)
  const [relatedFilledVerifyAppend, setRelatedFilledVerifyAppend] = useState(false)

  const [universeRowCount, setUniverseRowCount] = useState<number | null>(null)
  const [universeRowCountLoading, setUniverseRowCountLoading] = useState(false)
  const [tickerTypesRowCount, setTickerTypesRowCount] = useState<number | null>(null)
  const [tickerTypesRowCountLoading, setTickerTypesRowCountLoading] = useState(false)

  const refJobSession = useMassiveRefJobSession()
  const [jobMsg, setJobMsg] = useState<string | null>(null)

  useEffect(() => {
    setVerifyErr(null)
    setEnqueueErr(null)
    setSearchRows([])
    setDetail(null)
    setRelated(null)
    setTypesRows(null)
    setMissingOverviewTickers(null)
    setMissingOverviewTotal(null)
    setMissingOverviewHasMore(false)
    setOverviewVerifyKind(null)
    setOverviewMissingVerifyAppend(false)
    setRelatedCoverage(null)
    setMissingRelatedTickers(null)
    setMissingRelatedTotal(null)
    setMissingRelatedHasMore(false)
    setFilledRelatedTickers(null)
    setFilledRelatedTotal(null)
    setFilledRelatedHasMore(false)
    setRelatedVerifyKind(null)
    setRelatedMissingVerifyAppend(false)
    setRelatedFilledVerifyAppend(false)
    setUniverseRowCount(null)
    setTickerTypesRowCount(null)
  }, [selectedRefJobKind])

  useEffect(() => {
    if (!isFeedStocksTickersOverviewRefKind(selectedRefJobKind)) {
      return
    }
    let cancelled = false
    setOverviewCoverageLoading(true)
    void fetchTickerReferenceOverviewCoverage().then(res => {
      if (cancelled) return
      if (!res.ok || res.total_tickers == null || res.missing == null || res.filled == null) {
        setOverviewCoverage(null)
        return
      }
      setOverviewCoverage({
        total_tickers: res.total_tickers,
        missing: res.missing,
        filled: res.filled,
      })
    }).finally(() => {
      if (!cancelled) setOverviewCoverageLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selectedRefJobKind])

  useEffect(() => {
    if (!isFeedStocksTickersRelatedRefKind(selectedRefJobKind)) {
      return
    }
    let cancelled = false
    setRelatedCoverageLoading(true)
    void fetchTickerReferenceRelatedCoverage().then(res => {
      if (cancelled) return
      if (!res.ok || res.total_tickers == null || res.missing == null || res.filled == null) {
        setRelatedCoverage(null)
        return
      }
      setRelatedCoverage({
        total_tickers: res.total_tickers,
        missing: res.missing,
        filled: res.filled,
      })
    }).finally(() => {
      if (!cancelled) setRelatedCoverageLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [selectedRefJobKind])

  useEffect(() => {
    if (!isFeedStocksTickersReferenceUniverseRefKind(selectedRefJobKind)) {
      return
    }
    let cancelled = false
    setUniverseRowCountLoading(true)
    void fetchTickerReferenceUniverseCount()
      .then(res => {
        if (cancelled) return
        if (!res.ok || res.total_tickers == null || !Number.isFinite(res.total_tickers)) {
          setUniverseRowCount(null)
          return
        }
        setUniverseRowCount(res.total_tickers)
      })
      .finally(() => {
        if (!cancelled) setUniverseRowCountLoading(false)
      })
    return () => {
      cancelled = true
      setUniverseRowCountLoading(false)
    }
  }, [selectedRefJobKind])

  useEffect(() => {
    if (!isFeedStocksTickersTypesRefKind(selectedRefJobKind)) {
      return
    }
    let cancelled = false
    setTickerTypesRowCountLoading(true)
    void fetchTickerReferenceTickerTypesRowCount()
      .then(res => {
        if (cancelled) return
        if (!res.ok || res.total_ticker_types == null || !Number.isFinite(res.total_ticker_types)) {
          setTickerTypesRowCount(null)
          return
        }
        setTickerTypesRowCount(res.total_ticker_types)
      })
      .finally(() => {
        if (!cancelled) setTickerTypesRowCountLoading(false)
      })
    return () => {
      cancelled = true
      setTickerTypesRowCountLoading(false)
    }
  }, [selectedRefJobKind])

  const enqueueOne = useCallback(
    async (
      kind: TickerReferenceJobKind,
      payload: Record<string, unknown>,
      priority?: string,
    ) => {
      setJobMsg(null)
      setEnqueueErr(null)
      setVerifyErr(null)
      setRefJobSymbolsErr(null)
      try {
        const res = await refJobSession.enqueueTickerReferenceJob(kind, payload, priority)
        if (!res.ok) {
          setEnqueueErr(res.error ?? 'Enqueue failed')
          return
        }
        const tag = res.deduplicated ? `${res.job_id ?? '?'} (deduplicated)` : (res.job_id ?? '?')
        setJobMsg(`Enqueued ${kind}: job ${tag}. Open Jobs for details.`)
      } catch (e: unknown) {
        setEnqueueErr(e instanceof Error ? e.message : String(e))
      }
    },
    [refJobSession],
  )

  const runEnqueueUniverse = useCallback(() => {
    void enqueueOne(
      'feed_stocks_tickers_reference_universe',
      { full_universe: true, limit: 1000, sort: 'ticker', order: 'asc' },
      'high',
    )
  }, [enqueueOne])

  const runEnqueueTickerTypes = useCallback(() => {
    void enqueueOne('feed_stocks_tickers_types', {}, 'high')
  }, [enqueueOne])

  const runEnqueueOverview = useCallback(() => {
    if (overviewEnqueueMode === 'symbols') {
      const symbols = parseRefJobSymbols(refJobSymbols)
      const v = validateRefJobSymbolsForEnqueue(symbols)
      if (!v.ok) {
        setRefJobSymbolsErr(v.message)
        return
      }
      void enqueueOne('feed_stocks_tickers_overview', { mode: 'symbols', symbols })
      return
    }
    if (overviewEnqueueMode === 'stale') {
      const h = Math.max(1, Math.floor(Number(overviewStaleHours) || 720))
      void enqueueOne('feed_stocks_tickers_overview', { mode: 'stale', stale_hours: h })
      return
    }
    if (overviewEnqueueMode === 'missing') {
      void enqueueOne('feed_stocks_tickers_overview', { mode: 'missing' })
      return
    }
    void enqueueOne('feed_stocks_tickers_overview', { mode: 'all' })
  }, [enqueueOne, overviewEnqueueMode, overviewStaleHours, refJobSymbols])

  const runEnqueueRelated = useCallback(() => {
    if (relatedEnqueueMode === 'symbols') {
      const symbols = parseRefJobSymbols(refJobSymbols)
      const v = validateRefJobSymbolsForEnqueue(symbols)
      if (!v.ok) {
        setRefJobSymbolsErr(v.message)
        return
      }
      void enqueueOne('feed_stocks_tickers_related', { mode: 'symbols', symbols })
      return
    }
    if (relatedEnqueueMode === 'stale') {
      const h = Math.max(1, Math.floor(Number(relatedStaleHours) || 720))
      void enqueueOne('feed_stocks_tickers_related', { mode: 'stale', stale_hours: h })
      return
    }
    if (relatedEnqueueMode === 'missing') {
      void enqueueOne('feed_stocks_tickers_related', { mode: 'missing' })
      return
    }
    void enqueueOne('feed_stocks_tickers_related', { mode: 'all' })
  }, [enqueueOne, relatedEnqueueMode, relatedStaleHours, refJobSymbols])

  const onDetailEnqueue = useCallback(() => {
    if (isFeedStocksTickersReferenceUniverseRefKind(selectedRefJobKind)) runEnqueueUniverse()
    else if (isFeedStocksTickersTypesRefKind(selectedRefJobKind)) runEnqueueTickerTypes()
    else if (isFeedStocksTickersOverviewRefKind(selectedRefJobKind)) runEnqueueOverview()
    else runEnqueueRelated()
  }, [selectedRefJobKind, runEnqueueUniverse, runEnqueueTickerTypes, runEnqueueOverview, runEnqueueRelated])

  const runVerifySearch = useCallback(async () => {
    const vq = validateTickerRefSearchQuery(searchQuery)
    const vl = validateSearchLimit(searchLimit)
    if (!vq.ok) {
      setVerifyErr(vq.message)
      return
    }
    if (!vl.ok) {
      setVerifyErr(vl.message)
      return
    }
    setBusy(true)
    setOverviewVerifyKind(null)
    setRelatedVerifyKind(null)
    setVerifyErr(null)
    setEnqueueErr(null)
    setSearchRows([])
    try {
      const res = await fetchTickerReferenceSearch({ q: vq.value, limit: vl.value })
      if (!res.ok) {
        setVerifyErr(res.error ?? 'Request failed')
        return
      }
      setSearchRows(res.results ?? [])
    } catch (e: unknown) {
      setVerifyErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [searchQuery, searchLimit])

  const runVerifyOverviewMerged = useCallback(async () => {
    const vs = validateSingleTickerSymbol(overviewSymbol)
    if (!vs.ok) {
      setVerifyErr(vs.message)
      return
    }
    setBusy(true)
    setRelatedVerifyKind(null)
    setOverviewVerifyKind('merged')
    setVerifyErr(null)
    setEnqueueErr(null)
    setDetail(null)
    setRelated(null)
    try {
      const d = await fetchTickerReferenceDetail(vs.value)
      if (!d.ok) {
        setVerifyErr(d.error ?? 'Detail request failed')
        return
      }
      setDetail((d.ticker as Record<string, unknown> | undefined) ?? null)
    } catch (e: unknown) {
      setVerifyErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setOverviewVerifyKind(null)
    }
  }, [overviewSymbol])

  const runVerifyOverviewMissing = useCallback(
    async (append: boolean) => {
      const vl = validateMissingOverviewLimit(overviewMissingLimit)
      if (!vl.ok) {
        setVerifyErr(vl.message)
        return
      }
      const offset = append && missingOverviewTickers != null ? missingOverviewTickers.length : 0
      setBusy(true)
      setRelatedVerifyKind(null)
      setOverviewVerifyKind('missing')
      setOverviewMissingVerifyAppend(append)
      setVerifyErr(null)
      setEnqueueErr(null)
      if (!append) {
        setMissingOverviewTickers(null)
        setMissingOverviewTotal(null)
        setMissingOverviewHasMore(false)
      }
      try {
        const res = await fetchTickerReferenceMissingOverview({ limit: vl.value, offset })
        if (!res.ok) {
          setVerifyErr(res.error ?? 'Missing overview request failed')
          return
        }
        const next = res.tickers ?? []
        const rawTotal = res.total_missing
        const totalMissing =
          typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null
        setMissingOverviewTotal(totalMissing)
        setMissingOverviewHasMore(Boolean(res.has_more))
        setMissingOverviewTickers(prev => {
          if (append && prev != null) return [...prev, ...next]
          return next
        })
      } catch (e: unknown) {
        setVerifyErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        setOverviewVerifyKind(null)
        setOverviewMissingVerifyAppend(false)
      }
    },
    [overviewMissingLimit, missingOverviewTickers],
  )

  const runVerifyRelatedDb = useCallback(async () => {
    const vs = validateSingleTickerSymbol(relatedSymbol)
    if (!vs.ok) {
      setVerifyErr(vs.message)
      return
    }
    setBusy(true)
    setOverviewVerifyKind(null)
    setRelatedVerifyKind('symbol')
    setVerifyErr(null)
    setEnqueueErr(null)
    setRelated(null)
    try {
      const rel = await fetchTickerReferenceRelated(vs.value)
      if (!rel.ok) {
        setVerifyErr(rel.error ?? 'Related request failed')
        return
      }
      setRelated(rel.data ?? null)
    } catch (e: unknown) {
      setVerifyErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
      setRelatedVerifyKind(null)
    }
  }, [relatedSymbol])

  const runVerifyRelatedMissing = useCallback(
    async (append: boolean) => {
      const vl = validateMissingOverviewLimit(relatedListPageLimit)
      if (!vl.ok) {
        setVerifyErr(vl.message)
        return
      }
      const offset = append && missingRelatedTickers != null ? missingRelatedTickers.length : 0
      setBusy(true)
      setOverviewVerifyKind(null)
      setRelatedVerifyKind('missing')
      setRelatedMissingVerifyAppend(append)
      setVerifyErr(null)
      setEnqueueErr(null)
      if (!append) {
        setMissingRelatedTickers(null)
        setMissingRelatedTotal(null)
        setMissingRelatedHasMore(false)
      }
      try {
        const res = await fetchTickerReferenceMissingRelated({ limit: vl.value, offset })
        if (!res.ok) {
          setVerifyErr(res.error ?? 'Missing related request failed')
          return
        }
        const next = res.tickers ?? []
        const rawTotal = res.total_missing
        const totalMissing =
          typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null
        setMissingRelatedTotal(totalMissing)
        setMissingRelatedHasMore(Boolean(res.has_more))
        setMissingRelatedTickers(prev => {
          if (append && prev != null) return [...prev, ...next]
          return next
        })
      } catch (e: unknown) {
        setVerifyErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        setRelatedVerifyKind(null)
        setRelatedMissingVerifyAppend(false)
      }
    },
    [relatedListPageLimit, missingRelatedTickers],
  )

  const runVerifyRelatedFilled = useCallback(
    async (append: boolean) => {
      const vl = validateMissingOverviewLimit(relatedListPageLimit)
      if (!vl.ok) {
        setVerifyErr(vl.message)
        return
      }
      const offset = append && filledRelatedTickers != null ? filledRelatedTickers.length : 0
      setBusy(true)
      setOverviewVerifyKind(null)
      setRelatedVerifyKind('filled')
      setRelatedFilledVerifyAppend(append)
      setVerifyErr(null)
      setEnqueueErr(null)
      if (!append) {
        setFilledRelatedTickers(null)
        setFilledRelatedTotal(null)
        setFilledRelatedHasMore(false)
      }
      try {
        const res = await fetchTickerReferenceFilledRelated({ limit: vl.value, offset })
        if (!res.ok) {
          setVerifyErr(res.error ?? 'Filled related request failed')
          return
        }
        const next = res.tickers ?? []
        const rawTotal = res.total_filled
        const totalFilled =
          typeof rawTotal === 'number' && Number.isFinite(rawTotal) ? rawTotal : null
        setFilledRelatedTotal(totalFilled)
        setFilledRelatedHasMore(Boolean(res.has_more))
        setFilledRelatedTickers(prev => {
          if (append && prev != null) return [...prev, ...next]
          return next
        })
      } catch (e: unknown) {
        setVerifyErr(e instanceof Error ? e.message : String(e))
      } finally {
        setBusy(false)
        setRelatedVerifyKind(null)
        setRelatedFilledVerifyAppend(false)
      }
    },
    [relatedListPageLimit, filledRelatedTickers],
  )

  const runVerifyInstrumentTypes = useCallback(async () => {
    setBusy(true)
    setOverviewVerifyKind(null)
    setRelatedVerifyKind(null)
    setVerifyErr(null)
    setEnqueueErr(null)
    setTypesRows(null)
    try {
      const res = await fetchTickerTypesFromDb({ asset_class: 'stocks', locale: 'us' })
      if (!res.ok) {
        setVerifyErr(res.error ?? 'Request failed')
        return
      }
      setTypesRows(res.results ?? [])
    } catch (e: unknown) {
      setVerifyErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const onOverviewModeChange = useCallback((m: OverviewEnqueueMode) => {
    setOverviewEnqueueMode(m)
    setRefJobSymbolsErr(null)
  }, [])

  const onRelatedModeChange = useCallback((m: RelatedEnqueueMode) => {
    setRelatedEnqueueMode(m)
    setRefJobSymbolsErr(null)
  }, [])

  const focusRefJobTab = useCallback((kind: TickerReferenceJobKind) => {
    window.requestAnimationFrame(() => {
      document.getElementById(`ref-job-tab-${kind}`)?.focus()
    })
  }, [])

  const onRefJobTabKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>, rowIndex: number) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') {
        return
      }
      e.preventDefault()
      const last = REF_TICKER_JOB_ROWS.length - 1
      let next = rowIndex
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        next = Math.min(rowIndex + 1, last)
      } else {
        next = Math.max(rowIndex - 1, 0)
      }
      const kind = REF_TICKER_JOB_ROWS[next].kind
      setSelectedRefJobKind(kind)
      focusRefJobTab(kind)
    },
    [focusRefJobTab],
  )

  const anyJobBusy = refJobSession.jobBusyKind != null
  const disabledForJobs = busy || anyJobBusy
  const activeJobCount = refJobSession.activeJobCount

  const catalogRow = getRefCatalogRow(selectedRefJobKind)

  return (
    <div className="feed-massive-agg-tab-panel" role={rootRole} id={panelId} aria-labelledby={ariaLabelledBy}>
      {showInitControls ? (
        <div
          className="feed-massive-refdb-jobs"
          style={{ marginTop: 'var(--space-3)' }}
          role="region"
          aria-label="Ticker reference jobs"
        >
          <div className="feed-massive-refdb-jobs-toolbar">
            <div className="form-label" style={{ marginBottom: 0 }}>
              Enqueue reference jobs
            </div>
            {showJobsToolbar ? (
              <div className="feed-massive-refdb-jobs-toolbar-actions">
                {activeJobCount > 0 ? (
                  <span className="ref-jobs-active-pill" aria-live="polite">
                    {activeJobCount} active
                  </span>
                ) : null}
                <Button type="button" variant="secondary" onClick={() => refJobSession.openJobsSheet()}>
                  Jobs
                </Button>
              </div>
            ) : null}
          </div>

          <p className="feed-massive-agg-sub-doc" style={{ marginBottom: 'var(--space-2)', maxWidth: '42rem' }}>
            Select a job, enqueue with job-specific options, then verify rows against PostgreSQL.
          </p>

          {catalogRow ? (
            <div className="ref-jobs-md ref-jobs-md--tabs">
              <ul className="ref-jobs-md-nav" role="tablist" aria-label="Ticker reference job kinds">
                {REF_TICKER_JOB_ROWS.map((row, rowIndex) => {
                  const selected = selectedRefJobKind === row.kind
                  return (
                    <li key={row.kind} className="ref-jobs-md-nav-item">
                      <button
                        type="button"
                        role="tab"
                        id={`ref-job-tab-${row.kind}`}
                        aria-selected={selected}
                        aria-controls="ref-job-detail-panel"
                        tabIndex={selected ? 0 : -1}
                        className="ref-jobs-md-tab"
                        onClick={() => setSelectedRefJobKind(row.kind)}
                        onKeyDown={e => onRefJobTabKeyDown(e, rowIndex)}
                      >
                        {refJobKindShortLabel(row.kind)}
                      </button>
                    </li>
                  )
                })}
              </ul>
              <RefJobDetailPanel
                catalogRow={catalogRow}
                disabledForJobs={disabledForJobs}
                busyVerify={busy}
                jobBusyKind={refJobSession.jobBusyKind}
                overviewEnqueueMode={overviewEnqueueMode}
                setOverviewEnqueueMode={onOverviewModeChange}
                overviewStaleHours={overviewStaleHours}
                setOverviewStaleHours={setOverviewStaleHours}
                relatedEnqueueMode={relatedEnqueueMode}
                setRelatedEnqueueMode={onRelatedModeChange}
                relatedStaleHours={relatedStaleHours}
                setRelatedStaleHours={setRelatedStaleHours}
                refJobSymbols={refJobSymbols}
                setRefJobSymbols={v => {
                  setRefJobSymbols(v)
                  setRefJobSymbolsErr(null)
                }}
                refJobSymbolsErr={refJobSymbolsErr}
                onEnqueue={onDetailEnqueue}
                searchQuery={searchQuery}
                setSearchQuery={setSearchQuery}
                searchLimit={searchLimit}
                setSearchLimit={n => {
                  const vl = validateSearchLimit(n)
                  setSearchLimitState(vl.ok ? vl.value : DEFAULT_TICKER_REF_SEARCH_LIMIT)
                }}
                overviewSymbol={overviewSymbol}
                setOverviewSymbol={setOverviewSymbol}
                relatedSymbol={relatedSymbol}
                setRelatedSymbol={setRelatedSymbol}
                onVerifySearch={runVerifySearch}
                onVerifyOverviewMerged={runVerifyOverviewMerged}
                onVerifyOverviewMissingFirst={() => void runVerifyOverviewMissing(false)}
                onVerifyOverviewMissingMore={() => void runVerifyOverviewMissing(true)}
                overviewMissingLimit={overviewMissingLimit}
                setOverviewMissingLimit={n => {
                  const vl = validateMissingOverviewLimit(n)
                  if (vl.ok) setOverviewMissingLimit(vl.value)
                }}
                missingOverviewHasMore={missingOverviewHasMore}
                missingOverviewLoadedCount={missingOverviewTickers?.length ?? 0}
                onVerifyRelatedDb={runVerifyRelatedDb}
                onVerifyInstrumentTypes={runVerifyInstrumentTypes}
                overviewCoverage={overviewCoverage}
                overviewCoverageLoading={overviewCoverageLoading}
                overviewVerifyKind={overviewVerifyKind}
                overviewMissingVerifyAppend={overviewMissingVerifyAppend}
                relatedCoverage={relatedCoverage}
                relatedCoverageLoading={relatedCoverageLoading}
                relatedListPageLimit={relatedListPageLimit}
                setRelatedListPageLimit={n => {
                  const vl = validateMissingOverviewLimit(n)
                  if (vl.ok) setRelatedListPageLimit(vl.value)
                }}
                onVerifyRelatedMissingFirst={() => void runVerifyRelatedMissing(false)}
                onVerifyRelatedMissingMore={() => void runVerifyRelatedMissing(true)}
                onVerifyRelatedFilledFirst={() => void runVerifyRelatedFilled(false)}
                onVerifyRelatedFilledMore={() => void runVerifyRelatedFilled(true)}
                missingRelatedHasMore={missingRelatedHasMore}
                missingRelatedLoadedCount={missingRelatedTickers?.length ?? 0}
                filledRelatedHasMore={filledRelatedHasMore}
                filledRelatedLoadedCount={filledRelatedTickers?.length ?? 0}
                relatedVerifyKind={relatedVerifyKind}
                relatedMissingVerifyAppend={relatedMissingVerifyAppend}
                relatedFilledVerifyAppend={relatedFilledVerifyAppend}
                universeRowCount={universeRowCount}
                universeRowCountLoading={universeRowCountLoading}
                tickerTypesRowCount={tickerTypesRowCount}
                tickerTypesRowCountLoading={tickerTypesRowCountLoading}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {jobMsg ? (
        <p className={cn(w9.statusPageMsg, 'ok')} role="status" style={{ marginTop: 'var(--space-2)' }}>
          {jobMsg}
        </p>
      ) : null}

      {enqueueErr ? (
        <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-2)' }}>
          {enqueueErr}
        </p>
      ) : null}
      {verifyErr ? (
        <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-2)' }}>
          {verifyErr}
        </p>
      ) : null}

      {isFeedStocksTickersReferenceUniverseRefKind(selectedRefJobKind) && searchRows.length > 0 ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Search results ({searchRows.length})</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '16rem' }}>
            {JSON.stringify(searchRows, null, 2)}
          </pre>
        </details>
      ) : null}

      {isFeedStocksTickersOverviewRefKind(selectedRefJobKind) && detail ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Merged ticker row (DB)</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(detail, null, 2)}
          </pre>
        </details>
      ) : null}

      {isFeedStocksTickersOverviewRefKind(selectedRefJobKind) && missingOverviewTickers != null ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>
            Tickers without overview ({missingOverviewTickers.length}
            {missingOverviewTotal != null && missingOverviewTotal > missingOverviewTickers.length
              ? ` of ${missingOverviewTotal}`
              : ''}
            )
          </summary>
          <p className="feed-massive-agg-sub-doc" style={{ marginBottom: 'var(--space-2)' }}>
            Symbols in <code>tickers</code> with no row in <code>ticker_overview</code> (same set as enqueue “Missing only”).
            {missingOverviewHasMore ? ' Use Load more below for the next page.' : ''}
          </p>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(missingOverviewTickers, null, 2)}
          </pre>
        </details>
      ) : null}

      {isFeedStocksTickersRelatedRefKind(selectedRefJobKind) && related ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Single symbol — related peers (DB)</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '20rem' }}>
            {JSON.stringify(related, null, 2)}
          </pre>
        </details>
      ) : null}

      {isFeedStocksTickersRelatedRefKind(selectedRefJobKind) && missingRelatedTickers != null ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>
            Tickers without related rows ({missingRelatedTickers.length}
            {missingRelatedTotal != null && missingRelatedTotal > missingRelatedTickers.length
              ? ` of ${missingRelatedTotal}`
              : ''}
            )
          </summary>
          <p className="feed-massive-agg-sub-doc" style={{ marginBottom: 'var(--space-2)' }}>
            No rows in <code>ticker_related_tickers</code> with <code>from_tickers_id</code> for these symbols (ordered
            A–Z). Empty API syncs also leave no rows.
            {missingRelatedHasMore ? ' Use Load more (missing) for the next page.' : ''}
          </p>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(missingRelatedTickers, null, 2)}
          </pre>
        </details>
      ) : null}

      {isFeedStocksTickersRelatedRefKind(selectedRefJobKind) && filledRelatedTickers != null ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>
            Tickers with related rows ({filledRelatedTickers.length}
            {filledRelatedTotal != null && filledRelatedTotal > filledRelatedTickers.length
              ? ` of ${filledRelatedTotal}`
              : ''}
            )
          </summary>
          <p className="feed-massive-agg-sub-doc" style={{ marginBottom: 'var(--space-2)' }}>
            Distinct symbols that have at least one <code>ticker_related_tickers</code> row as source ticker.
            {filledRelatedHasMore ? ' Use Load more (filled) for the next page.' : ''}
          </p>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(filledRelatedTickers, null, 2)}
          </pre>
        </details>
      ) : null}

      {isFeedStocksTickersTypesRefKind(selectedRefJobKind) && typesRows ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Instrument types ({typesRows.length})</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(typesRows, null, 2)}
          </pre>
        </details>
      ) : null}

    </div>
  )
}
