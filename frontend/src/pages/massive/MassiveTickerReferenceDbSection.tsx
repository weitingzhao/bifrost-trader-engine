import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MutableRefObject } from 'react'
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
  postTickerReferenceJob,
  subscribeMassiveJobEvents,
} from '../../api'
import type { TickerReferenceJobKind, TickerReferenceSearchRow } from '../../api'
import { TickerReferenceJobsSheet } from './TickerReferenceJobsSheet'
import { RefJobDetailPanel } from './RefJobDetailPanel'
import {
  DEFAULT_TICKER_REF_SEARCH_LIMIT,
  MAX_REF_JOBS_TRACKED,
  REF_TICKER_JOB_ROWS,
  countActiveRefJobs,
  getRefCatalogRow,
  isRefJobTerminal,
  parseRefJobSymbols,
  refJobKindShortLabel,
  DEFAULT_TICKER_REF_MISSING_LIMIT,
  validateMissingOverviewLimit,
  validateRefJobSymbolsForEnqueue,
  validateSearchLimit,
  validateSingleTickerSymbol,
  validateTickerRefSearchQuery,
  type OverviewEnqueueMode,
  type RefJobTrackItem,
} from './stockReferenceJobHelpers'

const DEFAULT_REF_JOB_SYMBOLS = 'AAPL, MSFT, GOOGL'

function trimRefJobItems(
  items: RefJobTrackItem[],
  closers: MutableRefObject<Map<string, () => void>>,
): RefJobTrackItem[] {
  if (items.length <= MAX_REF_JOBS_TRACKED) return items
  const sorted = [...items].sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  while (sorted.length > MAX_REF_JOBS_TRACKED) {
    const ev = sorted.shift()!
    closers.current.get(ev.jobId)?.()
    closers.current.delete(ev.jobId)
  }
  return sorted
}

export interface MassiveTickerReferenceDbSectionProps {
  panelId?: string
  ariaLabelledBy?: string
  showInitControls?: boolean
}

/**
 * PostgreSQL-backed ticker reference: Scheme C master–detail (job list + per-job enqueue + verify).
 * Shared by Feed → Massive Stock and Data Coverage → Massive Stock.
 */
export function MassiveTickerReferenceDbSection({
  panelId = 'massive-stock-refdb-panel',
  ariaLabelledBy = 'massive-stock-refdb-heading',
  showInitControls = true,
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

  const [jobBusy, setJobBusy] = useState<TickerReferenceJobKind | null>(null)
  const [jobMsg, setJobMsg] = useState<string | null>(null)
  const [refJobItems, setRefJobItems] = useState<RefJobTrackItem[]>([])
  const [jobsSheetOpen, setJobsSheetOpen] = useState(false)

  const sseClosersRef = useRef<Map<string, () => void>>(new Map())

  useEffect(
    () => () => {
      sseClosersRef.current.forEach(close => close())
      sseClosersRef.current.clear()
    },
    [],
  )

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
    if (selectedRefJobKind !== 'ticker_reference_overview') {
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
    if (selectedRefJobKind !== 'ticker_reference_related') {
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
    if (selectedRefJobKind !== 'ticker_reference_universe') {
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
    if (selectedRefJobKind !== 'ticker_reference_instrument_types') {
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

  const startJobStream = useCallback((jid: string) => {
    if (sseClosersRef.current.has(jid)) return
    const sub = subscribeMassiveJobEvents(
      jid,
      data => {
        setRefJobItems(prev =>
          prev.map(row => {
            if (row.jobId !== jid) return row
            if (!data.ok) {
              sseClosersRef.current.delete(jid)
              return {
                ...row,
                streamError: data.error ?? 'Job stream error',
                status: 'failed',
              }
            }
            const j = data.job
            const st = (j?.status ?? '').trim() || 'running'
            const stLower = st.toLowerCase()
            if (stLower === 'done' || stLower === 'failed') {
              sseClosersRef.current.delete(jid)
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
  }, [])

  const enqueueOne = useCallback(
    async (
      kind: TickerReferenceJobKind,
      payload: Record<string, unknown>,
      priority?: string,
    ) => {
      setJobBusy(kind)
      setJobMsg(null)
      setEnqueueErr(null)
      setVerifyErr(null)
      setRefJobSymbolsErr(null)
      try {
        const res = await postTickerReferenceJob({
          kind,
          payload,
          ...(priority ? { priority } : {}),
        })
        if (!res.ok) {
          setEnqueueErr(res.error ?? 'Enqueue failed')
          return
        }
        const tag = res.deduplicated ? `${res.job_id ?? '?'} (deduplicated)` : (res.job_id ?? '?')
        setJobMsg(`Enqueued ${kind}: job ${tag}. Open Jobs for details.`)
        const jid = res.job_id
        if (jid) {
          const now = Date.now()
          setRefJobItems(prev => {
            const idx = prev.findIndex(x => x.jobId === jid)
            let next: RefJobTrackItem[]
            if (idx >= 0) {
              next = [...prev]
              next[idx] = {
                ...next[idx],
                kind,
                domain: 'tickers',
                deduplicated: Boolean(res.deduplicated),
                status: res.deduplicated ? 'deduplicated (waiting)' : 'enqueued',
                streamError: undefined,
                job: undefined,
                enqueuedAt: next[idx].enqueuedAt,
              }
            } else {
              next = [
                ...prev,
                {
                  jobId: jid,
                  kind,
                  domain: 'tickers',
                  deduplicated: Boolean(res.deduplicated),
                  status: res.deduplicated ? 'deduplicated (waiting)' : 'enqueued',
                  enqueuedAt: now,
                },
              ]
            }
            return trimRefJobItems(next, sseClosersRef)
          })
          setJobsSheetOpen(true)
          startJobStream(jid)
        }
      } catch (e: unknown) {
        setEnqueueErr(e instanceof Error ? e.message : String(e))
      } finally {
        setJobBusy(null)
      }
    },
    [startJobStream],
  )

  const handleClearCompletedJobs = useCallback(() => {
    setRefJobItems(prev => prev.filter(i => !isRefJobTerminal(i)))
  }, [])

  const handleClearAllJobs = useCallback(() => {
    sseClosersRef.current.forEach(close => close())
    sseClosersRef.current.clear()
    setRefJobItems([])
  }, [])

  const runEnqueueUniverse = useCallback(() => {
    void enqueueOne(
      'ticker_reference_universe',
      { full_universe: true, limit: 1000, sort: 'ticker', order: 'asc' },
      'high',
    )
  }, [enqueueOne])

  const runEnqueueTickerTypes = useCallback(() => {
    void enqueueOne('ticker_reference_instrument_types', {}, 'high')
  }, [enqueueOne])

  const runEnqueueOverview = useCallback(() => {
    if (overviewEnqueueMode === 'symbols') {
      const symbols = parseRefJobSymbols(refJobSymbols)
      const v = validateRefJobSymbolsForEnqueue(symbols)
      if (!v.ok) {
        setRefJobSymbolsErr(v.message)
        return
      }
      void enqueueOne('ticker_reference_overview', { mode: 'symbols', symbols })
      return
    }
    if (overviewEnqueueMode === 'stale') {
      const h = Math.max(1, Math.floor(Number(overviewStaleHours) || 720))
      void enqueueOne('ticker_reference_overview', { mode: 'stale', stale_hours: h })
      return
    }
    if (overviewEnqueueMode === 'missing') {
      void enqueueOne('ticker_reference_overview', { mode: 'missing' })
      return
    }
    void enqueueOne('ticker_reference_overview', { mode: 'all' })
  }, [enqueueOne, overviewEnqueueMode, overviewStaleHours, refJobSymbols])

  const runEnqueueRelated = useCallback(() => {
    const symbols = parseRefJobSymbols(refJobSymbols)
    const v = validateRefJobSymbolsForEnqueue(symbols)
    if (!v.ok) {
      setRefJobSymbolsErr(v.message)
      return
    }
    void enqueueOne('ticker_reference_related', { mode: 'symbols', symbols })
  }, [enqueueOne, refJobSymbols])

  const onDetailEnqueue = useCallback(() => {
    if (selectedRefJobKind === 'ticker_reference_universe') runEnqueueUniverse()
    else if (selectedRefJobKind === 'ticker_reference_instrument_types') runEnqueueTickerTypes()
    else if (selectedRefJobKind === 'ticker_reference_overview') runEnqueueOverview()
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

  const anyJobBusy = jobBusy != null
  const disabledForJobs = busy || anyJobBusy
  const activeJobCount = countActiveRefJobs(refJobItems)

  const catalogRow = getRefCatalogRow(selectedRefJobKind)

  return (
    <div className="feed-massive-agg-tab-panel" role="tabpanel" id={panelId} aria-labelledby={ariaLabelledBy}>
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
            <div className="feed-massive-refdb-jobs-toolbar-actions">
              {activeJobCount > 0 ? (
                <span className="ref-jobs-active-pill" aria-live="polite">
                  {activeJobCount} active
                </span>
              ) : null}
              <button type="button" className="btn btn-secondary" onClick={() => setJobsSheetOpen(true)}>
                Jobs
              </button>
            </div>
          </div>

          <p className="feed-massive-agg-sub-doc" style={{ marginBottom: 'var(--space-2)', maxWidth: '42rem' }}>
            Select a job, enqueue with job-specific options, then verify rows against PostgreSQL.
          </p>

          {catalogRow ? (
            <div className="ref-jobs-md">
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
                jobBusyKind={jobBusy}
                overviewEnqueueMode={overviewEnqueueMode}
                setOverviewEnqueueMode={onOverviewModeChange}
                overviewStaleHours={overviewStaleHours}
                setOverviewStaleHours={setOverviewStaleHours}
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
        <p className="status-page-msg ok" role="status" style={{ marginTop: 'var(--space-2)' }}>
          {jobMsg}
        </p>
      ) : null}

      {enqueueErr ? (
        <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>
          {enqueueErr}
        </p>
      ) : null}
      {verifyErr ? (
        <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-2)' }}>
          {verifyErr}
        </p>
      ) : null}

      {selectedRefJobKind === 'ticker_reference_universe' && searchRows.length > 0 ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Search results ({searchRows.length})</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '16rem' }}>
            {JSON.stringify(searchRows, null, 2)}
          </pre>
        </details>
      ) : null}

      {selectedRefJobKind === 'ticker_reference_overview' && detail ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Merged ticker row (DB)</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(detail, null, 2)}
          </pre>
        </details>
      ) : null}

      {selectedRefJobKind === 'ticker_reference_overview' && missingOverviewTickers != null ? (
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

      {selectedRefJobKind === 'ticker_reference_related' && related ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Single symbol — related peers (DB)</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '20rem' }}>
            {JSON.stringify(related, null, 2)}
          </pre>
        </details>
      ) : null}

      {selectedRefJobKind === 'ticker_reference_related' && missingRelatedTickers != null ? (
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

      {selectedRefJobKind === 'ticker_reference_related' && filledRelatedTickers != null ? (
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

      {selectedRefJobKind === 'ticker_reference_instrument_types' && typesRows ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Instrument types ({typesRows.length})</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(typesRows, null, 2)}
          </pre>
        </details>
      ) : null}

      <TickerReferenceJobsSheet
        open={jobsSheetOpen}
        onClose={() => setJobsSheetOpen(false)}
        items={refJobItems}
        onClearCompleted={handleClearCompletedJobs}
        onClearAll={handleClearAllJobs}
      />
    </div>
  )
}
