import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import {
  fetchTickerReferenceDetail,
  fetchTickerReferenceInstrumentTypes,
  fetchTickerReferenceRelated,
  fetchTickerReferenceSearch,
  postTickerReferenceJob,
  subscribeMassiveJobEvents,
} from '../../api'
import type { TickerReferenceJobKind, TickerReferenceSearchRow } from '../../api'
import { TickerReferenceJobsSheet } from './TickerReferenceJobsSheet'
import {
  MAX_REF_JOBS_TRACKED,
  countActiveRefJobs,
  isRefJobTerminal,
  type RefJobTrackItem,
} from './stockReferenceJobHelpers'

const DEFAULT_REF_JOB_SYMBOLS = 'AAPL, MSFT, GOOGL'

function parseRefJobSymbols(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
}

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
  /** e.g. feed tab panel id */
  panelId?: string
  /** e.g. feed tab id for aria-labelledby */
  ariaLabelledBy?: string
  /** Show enqueue controls for PostgreSQL reference bootstrap (Celery). */
  showInitControls?: boolean
}

/**
 * PostgreSQL-backed ticker reference: search, detail+related, instrument types.
 * Shared by Feed → Stock Data (Tickers → Reference DB) and Data Coverage → Stock Data.
 */
export function MassiveTickerReferenceDbSection({
  panelId = 'massive-stock-refdb-panel',
  ariaLabelledBy = 'massive-stock-refdb-heading',
  showInitControls = true,
}: MassiveTickerReferenceDbSectionProps) {
  const [q, setQ] = useState('A')
  const [sym, setSym] = useState('AAPL')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [searchRows, setSearchRows] = useState<TickerReferenceSearchRow[]>([])
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [related, setRelated] = useState<Record<string, unknown> | null>(null)
  const [typesRows, setTypesRows] = useState<Record<string, unknown>[] | null>(null)

  const [refJobSymbols, setRefJobSymbols] = useState(DEFAULT_REF_JOB_SYMBOLS)
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
      { timeoutSec: 600 },
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
      setErr(null)
      try {
        const res = await postTickerReferenceJob({
          kind,
          payload,
          ...(priority ? { priority } : {}),
        })
        if (!res.ok) {
          setErr(res.error ?? 'Enqueue failed')
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
        setErr(e instanceof Error ? e.message : String(e))
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
      { max_pages: 3, limit: 1000, sort: 'ticker', order: 'asc' },
      'high',
    )
  }, [enqueueOne])

  const runEnqueueInstrumentTypes = useCallback(() => {
    void enqueueOne('ticker_reference_instrument_types', {}, 'high')
  }, [enqueueOne])

  const runEnqueueOverview = useCallback(() => {
    const symbols = parseRefJobSymbols(refJobSymbols)
    if (!symbols.length) {
      setErr('Enter at least one symbol for the overview job')
      return
    }
    void enqueueOne('ticker_reference_overview', { mode: 'symbols', symbols })
  }, [enqueueOne, refJobSymbols])

  const runEnqueueRelated = useCallback(() => {
    const symbols = parseRefJobSymbols(refJobSymbols)
    if (!symbols.length) {
      setErr('Enter at least one symbol for the related job')
      return
    }
    void enqueueOne('ticker_reference_related', { mode: 'symbols', symbols })
  }, [enqueueOne, refJobSymbols])

  const runSearch = useCallback(async () => {
    const qq = q.trim()
    if (!qq) {
      setErr('Query is required')
      return
    }
    setBusy(true)
    setErr(null)
    setSearchRows([])
    try {
      const res = await fetchTickerReferenceSearch({ q: qq, limit: 30 })
      if (!res.ok) {
        setErr(res.error ?? 'Request failed')
        return
      }
      setSearchRows(res.results ?? [])
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [q])

  const runLoadDetail = useCallback(async () => {
    const s = sym.trim()
    if (!s) {
      setErr('Symbol is required')
      return
    }
    setBusy(true)
    setErr(null)
    setDetail(null)
    setRelated(null)
    try {
      const [d, rel] = await Promise.all([
        fetchTickerReferenceDetail(s),
        fetchTickerReferenceRelated(s),
      ])
      if (!d.ok) {
        setErr(d.error ?? 'Detail request failed')
        return
      }
      if (!rel.ok) {
        setErr(rel.error ?? 'Related request failed')
        return
      }
      setDetail((d.ticker as Record<string, unknown> | undefined) ?? null)
      setRelated(rel.data ?? null)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [sym])

  const runTypes = useCallback(async () => {
    setBusy(true)
    setErr(null)
    setTypesRows(null)
    try {
      const res = await fetchTickerReferenceInstrumentTypes({ asset_class: 'stocks', locale: 'us' })
      if (!res.ok) {
        setErr(res.error ?? 'Request failed')
        return
      }
      setTypesRows(res.results ?? [])
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const anyJobBusy = jobBusy != null
  const disabledForJobs = busy || anyJobBusy
  const activeJobCount = countActiveRefJobs(refJobItems)

  return (
    <div
      className="feed-massive-agg-tab-panel"
      role="tabpanel"
      id={panelId}
      aria-labelledby={ariaLabelledBy}
    >
      <div className="feed-massive-agg-sub-doc">
        <p>
          <strong>Use case:</strong> Query synced rows in PostgreSQL (<code>tickers</code>,{' '}
          <code>ticker_reference_details</code>, <code>ticker_related_tickers</code>,{' '}
          <code>ticker_instrument_types</code>) with optional Redis cache. Populate data via Celery jobs (
          <code>POST /research/massive/jobs/ticker-reference</code>). Workers must listen on{' '}
          <code>massive_stocks</code> / <code>massive_stocks_high</code> (priority), not the options queues{' '}
          <code>massive</code> / <code>massive_high</code>.
        </p>
        <p className="feed-massive-agg-sub-endpoint">
          <code>GET /research/massive/reference/tickers/search</code>
          {' · '}
          <code>GET /research/massive/reference/tickers/&#123;ticker&#125;</code>
          {' · '}
          <code>GET /research/massive/instrument-types</code>
        </p>
      </div>

      {showInitControls ? (
        <div
          className="feed-massive-refdb-jobs"
          style={{ marginTop: 'var(--space-3)' }}
          role="group"
          aria-label="Enqueue ticker reference Celery jobs"
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
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-3)',
            }}
          >
            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabledForJobs}
                  onClick={runEnqueueUniverse}
                >
                  {jobBusy === 'ticker_reference_universe' ? 'Enqueueing…' : 'Enqueue universe sync'}
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                <code>ticker_reference_universe</code>: up to 3 pages (1000 rows/page, sort ticker asc). High priority
                queue.
              </p>
            </div>

            <div>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-2)' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabledForJobs}
                  onClick={runEnqueueInstrumentTypes}
                >
                  {jobBusy === 'ticker_reference_instrument_types' ? 'Enqueueing…' : 'Enqueue instrument types'}
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                <code>ticker_reference_instrument_types</code>: fills <code>ticker_instrument_types</code>. High priority
                queue.
              </p>
            </div>

            <div>
              <label className="feed-massive-field" style={{ display: 'block', maxWidth: '28rem' }}>
                <span className="form-label">Symbols for overview &amp; related jobs</span>
                <input
                  className="form-input"
                  value={refJobSymbols}
                  onChange={e => setRefJobSymbols(e.target.value)}
                  disabled={disabledForJobs}
                  placeholder={DEFAULT_REF_JOB_SYMBOLS}
                  autoComplete="off"
                />
              </label>
              <div
                style={{
                  marginTop: 'var(--space-2)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 'var(--space-2)',
                }}
              >
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabledForJobs}
                  onClick={runEnqueueOverview}
                >
                  {jobBusy === 'ticker_reference_overview' ? 'Enqueueing…' : 'Enqueue ticker overview'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabledForJobs}
                  onClick={runEnqueueRelated}
                >
                  {jobBusy === 'ticker_reference_related' ? 'Enqueueing…' : 'Enqueue related tickers'}
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                <code>ticker_reference_overview</code> and <code>ticker_reference_related</code> use{' '}
                <code>mode: symbols</code>. Related needs rows in <code>tickers</code> (from universe or overview).
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {jobMsg ? (
        <p className="status-page-msg ok" role="status" style={{ marginTop: 'var(--space-2)' }}>
          {jobMsg}
        </p>
      ) : null}

      <div className="feed-massive-form-grid">
        <label className="feed-massive-field">
          <span className="form-label">Search query</span>
          <input
            className="form-input"
            value={q}
            onChange={e => setQ(e.target.value)}
            disabled={busy}
            placeholder="AAPL or Apple"
            autoComplete="off"
          />
        </label>
        <label className="feed-massive-field">
          <span className="form-label">Symbol (detail + related)</span>
          <input
            className="form-input"
            value={sym}
            onChange={e => setSym(e.target.value)}
            disabled={busy}
            placeholder="AAPL"
            autoComplete="off"
          />
        </label>
      </div>

      <div style={{ marginTop: 'var(--space-3)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={runSearch}>
          {busy ? 'Loading\u2026' : 'Search (DB)'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={runLoadDetail}>
          {busy ? 'Loading\u2026' : 'Load detail + related'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={runTypes}>
          {busy ? 'Loading\u2026' : 'Instrument types (DB)'}
        </button>
      </div>

      {err ? (
        <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
          {err}
        </p>
      ) : null}

      {searchRows.length > 0 ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Search results ({searchRows.length})</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '16rem' }}>
            {JSON.stringify(searchRows, null, 2)}
          </pre>
        </details>
      ) : null}

      {detail ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Ticker row</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
            {JSON.stringify(detail, null, 2)}
          </pre>
        </details>
      ) : null}

      {related ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>Related (DB)</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '20rem' }}>
            {JSON.stringify(related, null, 2)}
          </pre>
        </details>
      ) : null}

      {typesRows ? (
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
