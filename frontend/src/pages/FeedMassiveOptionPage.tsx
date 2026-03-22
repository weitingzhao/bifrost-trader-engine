import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchMassiveStatus,
  postMassiveSync,
  fetchMassiveJobsList,
  subscribeMassiveJobEvents,
  fetchOptionSnapshotsPg,
} from '../api'
import type { MassiveStatusResponse, MassiveJobApiRow, OptionSnapshotRow } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtTs } from '../utils/format'
import checklistRows from './massiveFeedChecklistRows'
import type { ChecklistRow } from './massiveFeedChecklistRows'

interface FeedMassiveOptionPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  onGoToFeed?: () => void
  breadcrumbLabel?: string
}

function fmtJobResult(j: MassiveJobApiRow): string {
  const r = j.result as Record<string, unknown> | undefined
  if (!r || typeof r !== 'object') return '—'
  const err = r.error
  if (typeof err === 'string') return err
  if (r.rows_written != null) return `rows ${String(r.rows_written)}`
  if (r.bars_upserted != null) return `bars ${String(r.bars_upserted)}`
  if (r.message != null) return String(r.message)
  return '—'
}

function jobStatusBadgeClass(st: string | undefined): string {
  const s = (st || '').toLowerCase()
  if (s === 'done') return 'feed-massive-badge feed-massive-badge--done'
  if (s === 'failed') return 'feed-massive-badge feed-massive-badge--fail'
  if (s === 'running') return 'feed-massive-badge feed-massive-badge--run'
  return 'feed-massive-badge feed-massive-badge--pending'
}

function checklistStatusLabel(s: ChecklistRow['projectStatus']): string {
  if (s === 'implemented') return 'Implemented'
  if (s === 'partial') return 'Partial'
  return 'Not implemented'
}

function checklistStatusClass(s: ChecklistRow['projectStatus']): string {
  if (s === 'implemented') return 'feed-massive-badge feed-massive-badge--done'
  if (s === 'partial') return 'feed-massive-badge feed-massive-badge--run'
  return 'feed-massive-badge feed-massive-badge--fail'
}

function CardIconSnapshot() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l9 4.5v9L12 21l-9-4.5v-9L12 3z" />
      <path d="M12 12l9-4.5M12 12v9M12 12L3 7.5" />
    </svg>
  )
}

function CardIconBars() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="20" x2="18" y2="10" />
      <line x1="12" y1="20" x2="12" y2="4" />
      <line x1="6" y1="20" x2="6" y2="14" />
    </svg>
  )
}

function CardIconOi() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" />
    </svg>
  )
}

function CardIconJobs() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}

function CardIconVerify() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

/** Massive option sync: Celery jobs, PostgreSQL snapshots (delayed chain data). */
export function FeedMassiveOptionPage({
  status: _status,
  onGoToScreener,
  onGoToFeed,
  breadcrumbLabel = 'Massive Option',
}: FeedMassiveOptionPageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [jobs, setJobs] = useState<MassiveJobApiRow[]>([])
  const [jobsLoading, setJobsLoading] = useState(false)
  const [jobsError, setJobsError] = useState<string | null>(null)

  const [snapSymbol, setSnapSymbol] = useState('NVDA')
  const [snapBusy, setSnapBusy] = useState(false)
  const [snapErr, setSnapErr] = useState<string | null>(null)

  const [aggTicker, setAggTicker] = useState('')
  const [aggSymbol, setAggSymbol] = useState('')
  const [aggExpiry, setAggExpiry] = useState('')
  const [aggStrike, setAggStrike] = useState('')
  const [aggRight, setAggRight] = useState<'C' | 'P'>('C')
  const [aggStartMs, setAggStartMs] = useState('')
  const [aggEndMs, setAggEndMs] = useState('')
  const [aggTimespan, setAggTimespan] = useState('minute')
  const [aggMult, setAggMult] = useState('1')
  const [aggBusy, setAggBusy] = useState(false)
  const [aggErr, setAggErr] = useState<string | null>(null)

  const [oiBusy, setOiBusy] = useState(false)
  const [oiErr, setOiErr] = useState<string | null>(null)

  const [verifySymbol, setVerifySymbol] = useState('')
  const [verifyExp, setVerifyExp] = useState('')
  const [verifyStrikes, setVerifyStrikes] = useState('')
  const [verifyRows, setVerifyRows] = useState<OptionSnapshotRow[]>([])
  const [verifyUnderlying, setVerifyUnderlying] = useState<number | undefined>(undefined)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyErr, setVerifyErr] = useState<string | null>(null)

  const loadJobs = useCallback(async () => {
    setJobsLoading(true)
    setJobsError(null)
    try {
      const res = await fetchMassiveJobsList({ limit: 40 })
      if (!res.ok) {
        setJobsError(res.error ?? 'Failed to load jobs')
        setJobs([])
        return
      }
      setJobs(res.jobs)
    } catch (e) {
      setJobsError(e instanceof Error ? e.message : 'Failed to load jobs')
      setJobs([])
    } finally {
      setJobsLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => {
        if (!cancelled) setMassiveStatus(s)
      })
      .catch(() => {
        if (!cancelled) setMassiveStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    loadJobs()
  }, [loadJobs])

  const trackJob = useCallback((jobId: string, onDone: () => void) => {
    const sub = subscribeMassiveJobEvents(
      jobId,
      ev => {
        if (!ev.ok) {
          onDone()
          return
        }
        const st = ev.job?.status
        if (st === 'done' || st === 'failed') {
          onDone()
        }
      },
      { timeoutSec: 240 },
    )
    return sub
  }, [])

  const runSnapshot = useCallback(async () => {
    const u = snapSymbol.trim().toUpperCase()
    if (!u) {
      setSnapErr('Underlying symbol required')
      return
    }
    setSnapErr(null)
    setSnapBusy(true)
    try {
      const res = await postMassiveSync('snapshot', { underlying: u })
      if (!res.ok) {
        setSnapErr(res.error ?? res.message ?? 'Enqueue failed')
        setSnapBusy(false)
        return
      }
      if (!res.job_id) {
        setSnapErr('No job_id')
        setSnapBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setSnapBusy(false)
        loadJobs()
      })
    } catch (e) {
      setSnapErr(e instanceof Error ? e.message : 'Failed')
      setSnapBusy(false)
    }
  }, [snapSymbol, loadJobs, trackJob])

  const runAggregates = useCallback(async () => {
    setAggErr(null)
    setAggBusy(true)
    try {
      const payload: Record<string, unknown> = {
        options_ticker: aggTicker.trim(),
        symbol: aggSymbol.trim().toUpperCase(),
        expiry: aggExpiry.trim(),
        strike: parseFloat(aggStrike),
        option_right: aggRight,
        timespan: aggTimespan.trim() || 'minute',
        multiplier: parseInt(aggMult, 10) || 1,
        start_ms: parseInt(aggStartMs, 10),
        end_ms: parseInt(aggEndMs, 10),
      }
      const res = await postMassiveSync('aggregates', payload)
      if (!res.ok) {
        setAggErr(res.error ?? res.message ?? 'Enqueue failed')
        setAggBusy(false)
        return
      }
      if (!res.job_id) {
        setAggErr('No job_id')
        setAggBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setAggBusy(false)
        loadJobs()
      })
    } catch (e) {
      setAggErr(e instanceof Error ? e.message : 'Failed')
      setAggBusy(false)
    }
  }, [
    aggTicker,
    aggSymbol,
    aggExpiry,
    aggStrike,
    aggRight,
    aggTimespan,
    aggMult,
    aggStartMs,
    aggEndMs,
    loadJobs,
    trackJob,
  ])

  const runOi = useCallback(async () => {
    setOiErr(null)
    setOiBusy(true)
    try {
      const res = await postMassiveSync('oi', {})
      if (!res.ok) {
        setOiErr(res.error ?? res.message ?? 'Enqueue failed')
        setOiBusy(false)
        return
      }
      if (!res.job_id) {
        setOiErr('No job_id')
        setOiBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setOiBusy(false)
        loadJobs()
      })
    } catch (e) {
      setOiErr(e instanceof Error ? e.message : 'Failed')
      setOiBusy(false)
    }
  }, [loadJobs, trackJob])

  const runVerify = useCallback(async () => {
    const s = verifySymbol.trim().toUpperCase()
    const e = verifyExp.trim()
    if (!s || !e) {
      setVerifyErr('Symbol and expiration required')
      return
    }
    setVerifyErr(null)
    setVerifyLoading(true)
    try {
      const res = await fetchOptionSnapshotsPg(s, e, verifyStrikes.trim() || undefined, 'massive')
      setVerifyRows(res.rows)
      setVerifyUnderlying(res.underlying_price)
      if (res.error) setVerifyErr(res.error)
    } catch (err) {
      setVerifyErr(err instanceof Error ? err.message : 'Load failed')
      setVerifyRows([])
    } finally {
      setVerifyLoading(false)
    }
  }, [verifySymbol, verifyExp, verifyStrikes])

  const configured = massiveStatus?.configured

  return (
    <div className="card process-section feed-massive-option-page">
      <div className="feed-massive-title-block">
        <div className="feed-massive-title-main">
          <h2 className="page-title-with-tooltip" style={{ marginBottom: 0 }}>
            {onGoToFeed ? (
              <>
                <button
                  type="button"
                  className="page-title-breadcrumb-link"
                  onClick={onGoToFeed}
                  aria-label="Go to Feed"
                >
                  Feed
                </button>
                {' / '}
              </>
            ) : onGoToScreener ? (
              <>
                <button
                  type="button"
                  className="page-title-breadcrumb-link"
                  onClick={onGoToScreener}
                  aria-label="Go to Screener"
                >
                  Research
                </button>
                {' / '}
              </>
            ) : null}
            {breadcrumbLabel}{' '}
            <InfoTooltip text="Enqueue Massive REST sync on the Celery `massive` queue; quotes are delayed (tier-dependent). Verify reads latest rows from PostgreSQL option_snapshots (source=massive). Worker implements snapshot, aggregates, and oi placeholder; other kinds may fail until implemented." />
          </h2>
          {configured && (
            <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice}>
              Delayed feed
            </span>
          )}
        </div>
      </div>

      <section className="feed-massive-status-strip" aria-label="Connection status">
        <div className="feed-massive-status-strip-grid">
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">API</span>
            <span className={configured ? 'feed-massive-status-value feed-massive-status-value--ok' : 'feed-massive-status-value feed-massive-status-value--bad'}>
              {configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">Tier</span>
            <span className="feed-massive-status-value">{massiveStatus?.tier ?? '—'}</span>
          </div>
          <div className="feed-massive-status-item">
            <span className="feed-massive-status-key">Option trades</span>
            <span className="feed-massive-status-value">
              {massiveStatus?.trades_enabled ? 'On' : 'Off'}
            </span>
          </div>
        </div>
        {massiveStatus?.delay_notice ? (
          <p className="feed-massive-status-note">{massiveStatus.delay_notice}</p>
        ) : null}
      </section>

      <section className="feed-massive-card feed-massive-checklist" aria-label="Service checklist">
        <div className="feed-massive-card-head">
          <h3>Massive feed service checklist</h3>
        </div>
        <p className="feed-massive-card-lead">
          Data capabilities by tier. Status reflects current project implementation.
          {_status?.celery_workers && _status.celery_workers.length > 0
            ? null
            : ' No Celery workers detected — start a worker with -Q massive to process sync tasks.'}
        </p>
        <div className="feed-massive-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Min tier</th>
                <th scope="col">Available</th>
                <th scope="col">Project status</th>
                <th scope="col">Verification</th>
              </tr>
            </thead>
            <tbody>
              {checklistRows.map(row => {
                const tierOk =
                  !massiveStatus || !configured
                    ? false
                    : row.tierMin === 'starter'
                      ? true
                      : (massiveStatus.tier || '').toLowerCase() === 'developer'
                const tradesOk = !row.requiresTrades || massiveStatus?.trades_enabled
                const available = configured && tierOk && tradesOk
                return (
                  <tr key={row.id}>
                    <td>
                      <strong>{row.service}</strong>
                      <br />
                      <span className="feed-massive-checklist-desc">{row.description}</span>
                    </td>
                    <td style={{ textTransform: 'capitalize' }}>{row.tierMin}</td>
                    <td>
                      {available
                        ? <span className="feed-massive-badge feed-massive-badge--done">Yes</span>
                        : <span className="feed-massive-badge feed-massive-badge--pending">No</span>}
                    </td>
                    <td>
                      <span className={checklistStatusClass(row.projectStatus)}>
                        {checklistStatusLabel(row.projectStatus)}
                      </span>
                    </td>
                    <td className="feed-massive-checklist-verify">{row.verification}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {!configured && (
        <p className="status-page-msg err" role="alert">
          Massive API key not configured. Set massive credentials in server config.
        </p>
      )}

      <div className="feed-massive-layout">
        <div className="feed-massive-col">
          <section className="feed-massive-card" aria-label="Underlying snapshot">
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconSnapshot />
                </span>
                <h3>Chain snapshot</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Pull a full option chain snapshot for one underlying and persist rows into{' '}
              <code style={{ fontSize: '0.85em' }}>option_snapshots</code>.
            </p>
            <div className="feed-massive-inline-actions">
              <label className="feed-massive-field">
                <span className="form-label">Underlying</span>
                <input
                  className="form-input"
                  value={snapSymbol}
                  onChange={e => setSnapSymbol(e.target.value)}
                  disabled={snapBusy || !configured}
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={snapBusy || !configured}
                onClick={() => runSnapshot()}
              >
                {snapBusy ? 'Running…' : 'Enqueue snapshot'}
              </button>
            </div>
            {snapErr ? (
              <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                {snapErr}
              </p>
            ) : null}
          </section>

          <section className="feed-massive-card" aria-label="Option aggregates">
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconBars />
                </span>
                <h3>Option aggregates</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Per-contract bars from Massive; requires options ticker and a Unix ms window.
            </p>
            <label className="feed-massive-field" style={{ marginBottom: 'var(--space-3)' }}>
              <span className="form-label">Options ticker</span>
              <input
                className="form-input"
                style={{ maxWidth: '100%' }}
                value={aggTicker}
                onChange={e => setAggTicker(e.target.value)}
                disabled={aggBusy || !configured}
                placeholder="O:…"
                autoComplete="off"
              />
            </label>
            <div className="feed-massive-form-grid">
              <label className="feed-massive-field">
                <span className="form-label">Symbol</span>
                <input
                  className="form-input"
                  value={aggSymbol}
                  onChange={e => setAggSymbol(e.target.value)}
                  disabled={aggBusy || !configured}
                />
              </label>
              <label className="feed-massive-field">
                <span className="form-label">Expiry</span>
                <input
                  className="form-input"
                  value={aggExpiry}
                  onChange={e => setAggExpiry(e.target.value)}
                  disabled={aggBusy || !configured}
                  placeholder="YYYYMMDD"
                />
              </label>
              <label className="feed-massive-field">
                <span className="form-label">Strike</span>
                <input
                  className="form-input"
                  value={aggStrike}
                  onChange={e => setAggStrike(e.target.value)}
                  disabled={aggBusy || !configured}
                />
              </label>
              <label className="feed-massive-field">
                <span className="form-label">Right</span>
                <select
                  className="form-input"
                  value={aggRight}
                  onChange={e => setAggRight(e.target.value as 'C' | 'P')}
                  disabled={aggBusy || !configured}
                >
                  <option value="C">Call</option>
                  <option value="P">Put</option>
                </select>
              </label>
            </div>
            <div className="feed-massive-form-grid feed-massive-form-grid--wide">
              <label className="feed-massive-field">
                <span className="form-label">Start (ms)</span>
                <input
                  className="form-input"
                  value={aggStartMs}
                  onChange={e => setAggStartMs(e.target.value)}
                  disabled={aggBusy || !configured}
                />
              </label>
              <label className="feed-massive-field">
                <span className="form-label">End (ms)</span>
                <input
                  className="form-input"
                  value={aggEndMs}
                  onChange={e => setAggEndMs(e.target.value)}
                  disabled={aggBusy || !configured}
                />
              </label>
              <label className="feed-massive-field">
                <span className="form-label">Timespan</span>
                <input
                  className="form-input"
                  value={aggTimespan}
                  onChange={e => setAggTimespan(e.target.value)}
                  disabled={aggBusy || !configured}
                />
              </label>
              <label className="feed-massive-field">
                <span className="form-label">Multiplier</span>
                <input
                  className="form-input"
                  value={aggMult}
                  onChange={e => setAggMult(e.target.value)}
                  disabled={aggBusy || !configured}
                />
              </label>
            </div>
            <div className="feed-massive-actions-row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={aggBusy || !configured}
                onClick={() => runAggregates()}
              >
                {aggBusy ? 'Running…' : 'Enqueue aggregates'}
              </button>
            </div>
            {aggErr ? (
              <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                {aggErr}
              </p>
            ) : null}
          </section>

          <section className="feed-massive-card feed-massive-card--muted" aria-label="Open interest">
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconOi />
                </span>
                <h3>Open interest</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Placeholder job; prefer chain snapshot for OI when available.
            </p>
            <div className="feed-massive-actions-row">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={oiBusy || !configured}
                onClick={() => runOi()}
              >
                {oiBusy ? 'Running…' : 'Enqueue OI job'}
              </button>
            </div>
            {oiErr ? (
              <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                {oiErr}
              </p>
            ) : null}
          </section>
        </div>

        <div className="feed-massive-col">
          <section className="feed-massive-card" aria-label="Recent jobs">
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconJobs />
                </span>
                <h3>Job queue</h3>
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ padding: '0.35rem 0.75rem', fontSize: 'var(--text-caption)' }}
                onClick={() => loadJobs()}
                disabled={jobsLoading}
              >
                {jobsLoading ? 'Loading…' : 'Refresh'}
              </button>
            </div>
            <p className="feed-massive-card-lead">Latest Massive sync tasks (newest first).</p>
            {jobsError ? (
              <p className="status-page-msg err" role="alert">
                {jobsError}
              </p>
            ) : null}
            <div className="feed-massive-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
                    <th scope="col">Kind</th>
                    <th scope="col">Status</th>
                    <th scope="col">Created</th>
                    <th scope="col">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.length === 0 && !jobsLoading ? (
                    <tr>
                      <td colSpan={5}>
                        <div className="feed-massive-empty">No jobs yet.</div>
                      </td>
                    </tr>
                  ) : (
                    jobs.map(j => (
                      <tr key={j.job_id}>
                        <td>
                          <span className="feed-massive-job-id">{j.job_id}</span>
                        </td>
                        <td>{j.kind ?? '—'}</td>
                        <td>
                          <span className={jobStatusBadgeClass(j.status)}>{j.status ?? '—'}</span>
                        </td>
                        <td>{j.created_ts != null ? fmtTs(j.created_ts) : '—'}</td>
                        <td style={{ maxWidth: '12rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={fmtJobResult(j)}>
                          {fmtJobResult(j)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="feed-massive-card" aria-label="Verify from database">
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconVerify />
                </span>
                <h3>Verify in PostgreSQL</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Read latest stored quotes for Massive source; empty strikes use ATM ladder when daily last exists.
            </p>
            <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end' }}>
              <label className="feed-massive-field">
                <span className="form-label">Symbol</span>
                <input
                  className="form-input"
                  value={verifySymbol}
                  onChange={e => setVerifySymbol(e.target.value)}
                  disabled={verifyLoading}
                  autoComplete="off"
                />
              </label>
              <label className="feed-massive-field">
                <span className="form-label">Expiration</span>
                <input
                  className="form-input"
                  value={verifyExp}
                  onChange={e => setVerifyExp(e.target.value)}
                  placeholder="YYYYMMDD"
                  disabled={verifyLoading}
                />
              </label>
              <label className="feed-massive-field" style={{ flex: '1 1 12rem', minWidth: '10rem' }}>
                <span className="form-label">Strikes (CSV)</span>
                <input
                  className="form-input"
                  value={verifyStrikes}
                  onChange={e => setVerifyStrikes(e.target.value)}
                  disabled={verifyLoading}
                  placeholder="Optional"
                />
              </label>
              <button type="button" className="btn btn-primary" disabled={verifyLoading} onClick={() => runVerify()}>
                {verifyLoading ? 'Loading…' : 'Load'}
              </button>
            </div>
            {verifyUnderlying != null ? (
              <div className="feed-massive-verify-meta">
                Underlying (row / fallback): <strong>{verifyUnderlying.toFixed(2)}</strong>
              </div>
            ) : null}
            {verifyErr ? (
              <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
                {verifyErr}
              </p>
            ) : null}
            {verifyRows.length > 0 ? (
              <div className="feed-massive-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Strike</th>
                      <th scope="col">Right</th>
                      <th scope="col">Bid</th>
                      <th scope="col">Ask</th>
                      <th scope="col">Last</th>
                      <th scope="col">Mid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verifyRows.map((row, i) => (
                      <tr key={`${row.strike}-${row.right}-${i}`}>
                        <td>{row.strike}</td>
                        <td>{row.right}</td>
                        <td>{row.bid ?? '—'}</td>
                        <td>{row.ask ?? '—'}</td>
                        <td>{row.last ?? '—'}</td>
                        <td>{row.mid ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}
