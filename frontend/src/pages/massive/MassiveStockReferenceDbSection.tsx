import { useCallback, useState } from 'react'
import {
  fetchStockReferenceDetail,
  fetchStockReferenceInstrumentTypes,
  fetchStockReferenceRelated,
  fetchStockReferenceSearch,
  postStockReferenceJob,
} from '../../api'
import type { StockReferenceJobKind, StockReferenceSearchRow } from '../../api'

const DEFAULT_REF_JOB_SYMBOLS = 'AAPL, MSFT, GOOGL'

function parseRefJobSymbols(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map(s => s.trim().toUpperCase())
    .filter(Boolean)
}

export interface MassiveStockReferenceDbSectionProps {
  /** e.g. feed tab panel id */
  panelId?: string
  /** e.g. feed tab id for aria-labelledby */
  ariaLabelledBy?: string
  /** Show enqueue controls for PostgreSQL reference bootstrap (Celery). */
  showInitControls?: boolean
}

/**
 * PostgreSQL-backed stock reference: search, detail+related, instrument types.
 * Shared by Feed → Stock Data (Tickers → Reference DB) and Data Coverage → Stock Data.
 */
export function MassiveStockReferenceDbSection({
  panelId = 'massive-stock-refdb-panel',
  ariaLabelledBy = 'massive-stock-refdb-heading',
  showInitControls = true,
}: MassiveStockReferenceDbSectionProps) {
  const [q, setQ] = useState('A')
  const [sym, setSym] = useState('AAPL')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [searchRows, setSearchRows] = useState<StockReferenceSearchRow[]>([])
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null)
  const [related, setRelated] = useState<Record<string, unknown> | null>(null)
  const [typesRows, setTypesRows] = useState<Record<string, unknown>[] | null>(null)

  const [refJobSymbols, setRefJobSymbols] = useState(DEFAULT_REF_JOB_SYMBOLS)
  const [jobBusy, setJobBusy] = useState<StockReferenceJobKind | null>(null)
  const [jobMsg, setJobMsg] = useState<string | null>(null)

  const enqueueOne = useCallback(
    async (
      kind: StockReferenceJobKind,
      payload: Record<string, unknown>,
      priority?: string,
    ) => {
      setJobBusy(kind)
      setJobMsg(null)
      setErr(null)
      try {
        const res = await postStockReferenceJob({
          kind,
          payload,
          ...(priority ? { priority } : {}),
        })
        if (!res.ok) {
          setErr(res.error ?? 'Enqueue failed')
          return
        }
        const tag = res.deduplicated ? `${res.job_id ?? '?'} (deduplicated)` : (res.job_id ?? '?')
        setJobMsg(`Enqueued ${kind}: job ${tag}`)
      } catch (e: unknown) {
        setErr(e instanceof Error ? e.message : String(e))
      } finally {
        setJobBusy(null)
      }
    },
    [],
  )

  const runEnqueueUniverse = useCallback(() => {
    void enqueueOne(
      'stock_reference_universe',
      { max_pages: 3, limit: 1000, sort: 'ticker', order: 'asc' },
      'high',
    )
  }, [enqueueOne])

  const runEnqueueInstrumentTypes = useCallback(() => {
    void enqueueOne('stock_reference_instrument_types', {}, 'high')
  }, [enqueueOne])

  const runEnqueueOverview = useCallback(() => {
    const symbols = parseRefJobSymbols(refJobSymbols)
    if (!symbols.length) {
      setErr('Enter at least one symbol for the overview job')
      return
    }
    void enqueueOne('stock_reference_overview', { mode: 'symbols', symbols })
  }, [enqueueOne, refJobSymbols])

  const runEnqueueRelated = useCallback(() => {
    const symbols = parseRefJobSymbols(refJobSymbols)
    if (!symbols.length) {
      setErr('Enter at least one symbol for the related job')
      return
    }
    void enqueueOne('stock_reference_related', { mode: 'symbols', symbols })
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
      const res = await fetchStockReferenceSearch({ q: qq, limit: 30 })
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
        fetchStockReferenceDetail(s),
        fetchStockReferenceRelated(s),
      ])
      if (!d.ok) {
        setErr(d.error ?? 'Detail request failed')
        return
      }
      if (!rel.ok) {
        setErr(rel.error ?? 'Related request failed')
        return
      }
      setDetail(d.stock ?? null)
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
      const res = await fetchStockReferenceInstrumentTypes({ asset_class: 'stocks', locale: 'us' })
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

  return (
    <div
      className="feed-massive-agg-tab-panel"
      role="tabpanel"
      id={panelId}
      aria-labelledby={ariaLabelledBy}
    >
      <div className="feed-massive-agg-sub-doc">
        <p>
          <strong>Use case:</strong> Query synced rows in PostgreSQL (<code>stocks</code>,{' '}
          <code>stock_related_tickers</code>, <code>ticker_instrument_types</code>) with optional Redis cache.
          Populate data via Celery jobs (<code>POST /research/massive/jobs/stock-reference</code>). Workers
          must listen on <code>massive_stocks</code> / <code>massive_stocks_high</code> (priority), not the
          options queues <code>massive</code> / <code>massive_high</code>.
        </p>
        <p className="feed-massive-agg-sub-endpoint">
          <code>GET /research/massive/stocks/search</code>
          {' · '}
          <code>GET /research/massive/stocks/&#123;symbol&#125;</code>
          {' · '}
          <code>GET /research/massive/instrument-types</code>
        </p>
      </div>

      {showInitControls ? (
        <div
          className="feed-massive-refdb-jobs"
          style={{ marginTop: 'var(--space-3)' }}
          role="group"
          aria-label="Enqueue stock reference Celery jobs"
        >
          <div className="form-label" style={{ marginBottom: 'var(--space-2)' }}>
            Enqueue reference jobs
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
                  {jobBusy === 'stock_reference_universe' ? 'Enqueueing…' : 'Enqueue universe sync'}
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                <code>stock_reference_universe</code>: up to 3 pages (1000 rows/page, sort ticker asc). High priority
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
                  {jobBusy === 'stock_reference_instrument_types' ? 'Enqueueing…' : 'Enqueue instrument types'}
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                <code>stock_reference_instrument_types</code>: fills <code>ticker_instrument_types</code>. High priority
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
                  {jobBusy === 'stock_reference_overview' ? 'Enqueueing…' : 'Enqueue ticker overview'}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={disabledForJobs}
                  onClick={runEnqueueRelated}
                >
                  {jobBusy === 'stock_reference_related' ? 'Enqueueing…' : 'Enqueue related tickers'}
                </button>
              </div>
              <p className="form-hint" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                <code>stock_reference_overview</code> and <code>stock_reference_related</code> use{' '}
                <code>mode: symbols</code>. Related needs rows in <code>stocks</code> (from universe or overview).
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
          <summary>Stock row</summary>
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
    </div>
  )
}
