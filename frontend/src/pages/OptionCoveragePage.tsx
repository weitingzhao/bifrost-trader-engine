import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchMassiveStatus,
  postMassiveSync,
  fetchMassiveJobsList,
  subscribeMassiveJobEvents,
  fetchOptionSnapshotsPg,
  fetchOptionExpirations,
  fetchGreeksCoverage,
  fetchDbCoverageSummary,
} from '../api'
import type {
  MassiveStatusResponse,
  MassiveJobApiRow,
  OptionSnapshotRow,
  GreeksCoverageResponse,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { DailyDataChecklistSection } from './massive/DailyDataChecklistSection'
import { FEED_MASSIVE_DAILY_DATA_ID } from './massive/feedMassiveTabUtils'
import { COVERAGE_OVERVIEW_SUBSECTION } from './settings/settingsConstants'

interface OptionCoveragePageProps {
  status: StatusResponse | null
}

function OptionCoverageDbSummaryInline({ refreshKey }: { refreshKey: number }) {
  const [line, setLine] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLine(null)
    void fetchDbCoverageSummary()
      .then(res => {
        if (cancelled) return
        setLoading(false)
        if (!res.ok) {
          setLine(res.error ?? 'Could not load DB summary')
          return
        }
        const parts = (res.tables ?? [])
          .filter(t => !t.error)
          .map(t => `${t.table_name} ${t.distinct_symbols ?? '—'}`)
        setLine(parts.length > 0 ? parts.join(' · ') : 'No tables returned')
      })
      .catch(() => {
        if (!cancelled) {
          setLoading(false)
          setLine('Could not load DB summary')
        }
      })
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  if (loading && line == null) {
    return (
      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
        Loading PostgreSQL coverage snapshot…
      </p>
    )
  }
  if (!line) return null
  return (
    <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)', lineHeight: 1.5 }}>
      <strong style={{ color: 'var(--color-text-muted)' }}>DB snapshot:</strong> {line}
    </p>
  )
}

export function OptionCoveragePage(_props: OptionCoveragePageProps) {
  const [dbSummaryRefreshKey, setDbSummaryRefreshKey] = useState(0)
  const onDailyChecklistRefreshed = useCallback(() => {
    setDbSummaryRefreshKey(k => k + 1)
  }, [])

  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [, setJobs] = useState<MassiveJobApiRow[]>([])

  const [gkSubTab, setGkSubTab] = useState<
    'chain_snapshot' | 'contract_snapshot' | 'db_verify' | 'unified_snapshot'
  >('db_verify')
  const [gkChainSymbol, setGkChainSymbol] = useState('NVDA')
  const [gkChainBusy, setGkChainBusy] = useState(false)
  const [gkChainErr, setGkChainErr] = useState<string | null>(null)
  const [gkContractUnderlying, setGkContractUnderlying] = useState('AAPL')
  const [gkContractTicker, setGkContractTicker] = useState('')
  const [gkContractBusy, setGkContractBusy] = useState(false)
  const [gkContractErr, setGkContractErr] = useState<string | null>(null)
  const [gkContractResult, setGkContractResult] = useState<Record<string, unknown> | null>(null)
  const [gkUnifiedTickers, setGkUnifiedTickers] = useState('')
  const [gkUnifiedBusy, setGkUnifiedBusy] = useState(false)
  const [gkUnifiedErr, setGkUnifiedErr] = useState<string | null>(null)
  const [gkUnifiedResult, setGkUnifiedResult] = useState<Record<string, unknown> | null>(null)
  const [gkCoverage, setGkCoverage] = useState<GreeksCoverageResponse | null>(null)
  const [gkCoverageBusy, setGkCoverageBusy] = useState(false)

  const [verifySymbol, setVerifySymbol] = useState('')
  const [verifyExp, setVerifyExp] = useState('')
  const [verifyStrikes, setVerifyStrikes] = useState('')
  const [verifyRows, setVerifyRows] = useState<OptionSnapshotRow[]>([])
  const [verifyUnderlying, setVerifyUnderlying] = useState<number | undefined>(undefined)
  const [verifyLoading, setVerifyLoading] = useState(false)
  const [verifyErr, setVerifyErr] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => { if (!cancelled) setMassiveStatus(s) })
      .catch(() => { if (!cancelled) setMassiveStatus(null) })
    return () => { cancelled = true }
  }, [])

  const loadJobs = useCallback(async () => {
    try {
      const res = await fetchMassiveJobsList({ limit: 40 })
      if (res.ok) setJobs(res.jobs)
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadJobs() }, [loadJobs])

  useEffect(() => {
    const scrollDaily = () => {
      const h = window.location.hash.replace('#', '')
      if (h === FEED_MASSIVE_DAILY_DATA_ID) {
        requestAnimationFrame(() => {
          document.getElementById(FEED_MASSIVE_DAILY_DATA_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      }
    }
    scrollDaily()
    window.addEventListener('hashchange', scrollDaily)
    return () => window.removeEventListener('hashchange', scrollDaily)
  }, [])

  const configured = massiveStatus?.configured

  const loadGkCoverage = useCallback(async (sym: string) => {
    if (!sym.trim()) return
    setGkCoverageBusy(true)
    try {
      const res = await fetchGreeksCoverage(sym.trim())
      setGkCoverage(res)
    } catch {
      setGkCoverage(null)
    } finally {
      setGkCoverageBusy(false)
    }
  }, [])

  const runGkChainSnapshot = useCallback(async () => {
    const u = gkChainSymbol.trim().toUpperCase()
    if (!u) { setGkChainErr('Underlying symbol required'); return }
    setGkChainErr(null)
    setGkChainBusy(true)
    try {
      const res = await postMassiveSync('snapshot', { snapshot_type: 'chain', underlying: u })
      if (!res.ok) { setGkChainErr(res.error ?? res.message ?? 'Enqueue failed'); setGkChainBusy(false); return }
      if (!res.job_id) { setGkChainErr('No job_id'); setGkChainBusy(false); return }
      const sub = subscribeMassiveJobEvents(
        res.job_id,
        ev => {
          if (!ev.ok) { setGkChainErr(ev.error || 'SSE error'); setGkChainBusy(false); sub.close(); return }
          const st = ev.job?.status
          if (st === 'done' || st === 'failed') {
            if (st === 'failed') {
              const jr = ev.job?.result as Record<string, unknown> | undefined
              setGkChainErr((jr?.error as string) || 'Job failed')
            } else {
              loadGkCoverage(u)
            }
            setGkChainBusy(false)
            sub.close()
            loadJobs()
          }
        },
        { timeoutSec: 240 },
      )
    } catch (e) {
      setGkChainErr(e instanceof Error ? e.message : 'Failed')
      setGkChainBusy(false)
    }
  }, [gkChainSymbol, loadJobs, loadGkCoverage])

  const runGkContractSnapshot = useCallback(async () => {
    const u = gkContractUnderlying.trim().toUpperCase()
    const oc = gkContractTicker.trim()
    if (!u || !oc) { setGkContractErr('Underlying and option contract ticker required'); return }
    setGkContractErr(null)
    setGkContractResult(null)
    setGkContractBusy(true)
    try {
      const res = await postMassiveSync('snapshot', { snapshot_type: 'contract', underlying: u, option_contract: oc })
      if (!res.ok) { setGkContractErr(res.error ?? res.message ?? 'Enqueue failed'); setGkContractBusy(false); return }
      if (!res.job_id) { setGkContractErr('No job_id'); setGkContractBusy(false); return }
      const sub = subscribeMassiveJobEvents(
        res.job_id,
        ev => {
          if (!ev.ok) { setGkContractErr(ev.error || 'SSE error'); setGkContractBusy(false); sub.close(); return }
          const st = ev.job?.status
          if (st === 'done' || st === 'failed') {
            const jr = ev.job?.result as Record<string, unknown> | undefined
            if (st === 'done' && jr?.content) {
              setGkContractResult(jr.content as Record<string, unknown>)
            } else if (st === 'failed') {
              setGkContractErr((jr?.error as string) || 'Job failed')
            }
            setGkContractBusy(false)
            sub.close()
            loadJobs()
          }
        },
        { timeoutSec: 240 },
      )
    } catch (e) {
      setGkContractErr(e instanceof Error ? e.message : 'Failed')
      setGkContractBusy(false)
    }
  }, [gkContractUnderlying, gkContractTicker, loadJobs])

  const runGkUnifiedSnapshot = useCallback(async () => {
    const t = gkUnifiedTickers.trim()
    if (!t) { setGkUnifiedErr('At least one ticker required'); return }
    setGkUnifiedErr(null)
    setGkUnifiedResult(null)
    setGkUnifiedBusy(true)
    try {
      const res = await postMassiveSync('snapshot', { snapshot_type: 'unified', tickers: t, asset_type: 'options' })
      if (!res.ok) { setGkUnifiedErr(res.error ?? res.message ?? 'Enqueue failed'); setGkUnifiedBusy(false); return }
      if (!res.job_id) { setGkUnifiedErr('No job_id'); setGkUnifiedBusy(false); return }
      const sub = subscribeMassiveJobEvents(
        res.job_id,
        ev => {
          if (!ev.ok) { setGkUnifiedErr(ev.error || 'SSE error'); setGkUnifiedBusy(false); sub.close(); return }
          const st = ev.job?.status
          if (st === 'done' || st === 'failed') {
            const jr = ev.job?.result as Record<string, unknown> | undefined
            if (st === 'done' && jr?.summary) {
              setGkUnifiedResult(jr as Record<string, unknown>)
            } else if (st === 'failed') {
              setGkUnifiedErr((jr?.error as string) || 'Job failed')
            }
            setGkUnifiedBusy(false)
            sub.close()
            loadJobs()
          }
        },
        { timeoutSec: 240 },
      )
    } catch (e) {
      setGkUnifiedErr(e instanceof Error ? e.message : 'Failed')
      setGkUnifiedBusy(false)
    }
  }, [gkUnifiedTickers, loadJobs])

  const runGreeksSample = useCallback(async () => {
    setVerifyErr(null)
    setVerifyLoading(true)
    try {
      const ex = await fetchOptionExpirations('NVDA', 'massive')
      const raw = ex.expirations[0]
      if (!raw || ex.error) {
        setVerifyErr(ex.error ?? 'No expirations from Massive')
        setVerifyRows([])
        return
      }
      const expNorm = raw.length >= 8 ? raw.replace(/-/g, '').slice(0, 8) : raw
      setVerifySymbol('NVDA')
      setVerifyExp(expNorm)
      const res = await fetchOptionSnapshotsPg('NVDA', expNorm, undefined, 'massive')
      setVerifyRows(res.rows)
      setVerifyUnderlying(res.underlying_price)
      if (res.error) setVerifyErr(res.error)
    } catch (err) {
      setVerifyErr(err instanceof Error ? err.message : 'Failed')
      setVerifyRows([])
    } finally {
      setVerifyLoading(false)
    }
  }, [])

  const runVerify = useCallback(async () => {
    const s = verifySymbol.trim().toUpperCase()
    const e = verifyExp.trim()
    if (!s || !e) { setVerifyErr('Symbol and expiration required'); return }
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

  const greeksQuality = (() => {
    if (verifyRows.length === 0) return null
    const total = verifyRows.length
    const withIv = verifyRows.filter(r => r.iv != null).length
    const withAnyGreek = verifyRows.filter(r => r.delta != null || r.gamma != null || r.theta != null || r.vega != null).length
    const withFullGreeks = verifyRows.filter(r => r.delta != null && r.gamma != null && r.theta != null && r.vega != null).length
    const withOi = verifyRows.filter(r => r.open_interest != null).length
    return {
      total, withIv, withAnyGreek, withFullGreeks, withOi,
      ivPct: total > 0 ? Math.round((withIv / total) * 100) : 0,
      greeksPct: total > 0 ? Math.round((withFullGreeks / total) * 100) : 0,
    }
  })()

  const greeksEvidence =
    verifyRows.length === 0
      ? 'No rows loaded. Use Load sample or DB Verify tab.'
      : greeksQuality && greeksQuality.withIv > 0
        ? `IV in ${greeksQuality.withIv}/${greeksQuality.total} rows (${greeksQuality.ivPct}%), full greeks in ${greeksQuality.withFullGreeks} (${greeksQuality.greeksPct}%).`
        : 'Loaded rows have no IV/greeks — provider may omit them for these contracts.'

  return (
    <div className="card process-section market-data-page market-data-page--settings-embed">
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        <button
          type="button"
          className="page-title-breadcrumb-link"
          onClick={() => { window.location.hash = '#settings-heartbeat' }}
          aria-label="Go to Settings"
        >
          Settings
        </button>
        {' / '}
        Option Coverage
        <InfoTooltip text="Daily option pipeline status, then Greeks/IV and coverage metrics from Massive snapshot endpoints. Massive data is delayed (~15 minutes). Chain snapshots persist to PostgreSQL; contract and unified return data without writing." />
      </h2>

      <section className="replay-section" aria-labelledby="option-coverage-pipeline-head">
        <h3 id="option-coverage-pipeline-head" className="page-title-with-tooltip">
          Research tables (PostgreSQL)
          <InfoTooltip text="Distinct symbol counts and freshness for option research and shared stock_day. Full table with domains is on Data Overview." />
        </h3>
        <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)', maxWidth: '52rem', lineHeight: 1.5 }}>
          Screener and Greeks tooling read option_contracts, option_snapshots, report_option_atm_iv_daily, and stock_day. Refresh Daily Data Status below to reload the snapshot line after sync jobs.
        </p>
        <OptionCoverageDbSummaryInline refreshKey={dbSummaryRefreshKey} />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          style={{ marginBottom: 'var(--space-3)' }}
          onClick={() => { window.location.hash = `#${COVERAGE_OVERVIEW_SUBSECTION.id}` }}
        >
          Open Data Overview
        </button>
      </section>

      <DailyDataChecklistSection configured={Boolean(configured)} onChecklistRefreshed={onDailyChecklistRefreshed} />

      <section className="replay-section" aria-labelledby="option-coverage-greeks-head">
        <h3 id="option-coverage-greeks-head" className="page-title-with-tooltip">
          Greeks / IV
          <InfoTooltip text="Implied volatility, delta, gamma, theta, vega, and open interest from Massive snapshot endpoints. Coverage and freshness metrics quantify data quality." />
        </h3>
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <button type="button" className="btn btn-secondary" disabled={verifyLoading} onClick={() => runGreeksSample()}>
            {verifyLoading ? 'Loading\u2026' : 'Load sample (NVDA)'}
          </button>
          {greeksQuality ? (
            <span style={{ marginLeft: 'var(--space-3)', fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
              {greeksEvidence}
            </span>
          ) : null}
        </div>

        <div className="feed-massive-agg-tabs-wrap">
          <div className="feed-massive-agg-tabs" role="tablist" aria-label="Greeks / IV API variants">
            {(['chain_snapshot', 'contract_snapshot', 'db_verify', 'unified_snapshot'] as const).map(tab => {
              const labels: Record<string, string> = { chain_snapshot: 'Chain Snapshot', contract_snapshot: 'Contract Snapshot', db_verify: 'DB Verify', unified_snapshot: 'Unified' }
              const badges: Record<string, string> = { chain_snapshot: 'REST', contract_snapshot: 'REST', db_verify: 'PG', unified_snapshot: 'REST' }
              return (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  className={`feed-massive-agg-tab${gkSubTab === tab ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={gkSubTab === tab}
                  tabIndex={gkSubTab === tab ? 0 : -1}
                  onClick={() => setGkSubTab(tab)}
                >
                  {labels[tab]}
                  <span className="feed-massive-agg-tab-badge">{badges[tab]}</span>
                </button>
              )
            })}
          </div>

          <div className="feed-massive-agg-tab-panels">
            {gkSubTab === 'chain_snapshot' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Fetch the full option chain for an underlying, persisting greeks and IV into <code>option_snapshots</code>.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/snapshot/options/&#123;underlyingAsset&#125;</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Underlying *</span>
                    <input className="form-input" value={gkChainSymbol} onChange={e => setGkChainSymbol(e.target.value)} disabled={gkChainBusy || !configured} autoComplete="off" placeholder="NVDA" />
                  </label>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-primary" disabled={gkChainBusy || !configured} onClick={() => runGkChainSnapshot()}>
                    {gkChainBusy ? 'Running\u2026' : 'Enqueue Chain Snapshot'}
                  </button>
                  <button type="button" className="btn btn-secondary" disabled={gkCoverageBusy || !gkChainSymbol.trim()} onClick={() => loadGkCoverage(gkChainSymbol)} style={{ marginLeft: 'var(--space-2)' }}>
                    {gkCoverageBusy ? 'Loading\u2026' : 'Check Coverage'}
                  </button>
                </div>
                {gkChainErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{gkChainErr}</p> : null}
                {gkCoverageBusy ? <p style={{ marginTop: 'var(--space-3)', fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>Loading coverage stats…</p> : null}
                {gkCoverage?.ok && gkCoverage.total != null && gkCoverage.total > 0 && (
                  <div className="gk-quality-summary" style={{ marginTop: 'var(--space-3)' }}>
                    <div style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-tiny)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--color-text-muted)' }}>
                      Coverage for {gkCoverage.symbol} ({gkCoverage.total} contracts, source: {gkCoverage.source})
                    </div>
                    <div className="gk-quality-summary-grid">
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">Total</span><span className="gk-quality-summary-value">{gkCoverage.total}</span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">With IV</span><span className="gk-quality-summary-value">{gkCoverage.coverage?.with_iv ?? 0} <span className="gk-quality-summary-pct">({gkCoverage.coverage?.iv_pct ?? 0}%)</span></span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">Full greeks</span><span className="gk-quality-summary-value">{gkCoverage.coverage?.with_full_greeks ?? 0} <span className="gk-quality-summary-pct">({gkCoverage.coverage?.full_greeks_pct ?? 0}%)</span></span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">With OI</span><span className="gk-quality-summary-value">{gkCoverage.coverage?.with_oi ?? 0}</span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">Stale (&gt;24h)</span><span className="gk-quality-summary-value">{gkCoverage.freshness?.stale_rows ?? 0}</span></div>
                      {gkCoverage.freshness?.newest_ts && (
                        <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">Newest</span><span className="gk-quality-summary-value" style={{ fontSize: 'var(--text-tiny)' }}>{gkCoverage.freshness.newest_ts}</span></div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {gkSubTab === 'contract_snapshot' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve a single contract snapshot with full greeks, IV, break-even price, and open interest.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/snapshot/options/&#123;underlyingAsset&#125;/&#123;optionContract&#125;</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Underlying *</span>
                    <input className="form-input" value={gkContractUnderlying} onChange={e => setGkContractUnderlying(e.target.value)} disabled={gkContractBusy || !configured} autoComplete="off" placeholder="AAPL" />
                  </label>
                  <label className="feed-massive-field" style={{ gridColumn: '1 / -1' }}>
                    <span className="form-label">Option contract ticker *</span>
                    <input className="form-input" value={gkContractTicker} onChange={e => setGkContractTicker(e.target.value)} disabled={gkContractBusy || !configured} autoComplete="off" placeholder="O:AAPL251219C00200000" />
                  </label>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-primary" disabled={gkContractBusy || !configured} onClick={() => runGkContractSnapshot()}>
                    {gkContractBusy ? 'Running\u2026' : 'Enqueue Contract Snapshot'}
                  </button>
                </div>
                {gkContractErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{gkContractErr}</p> : null}
                {gkContractResult && (
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <div className="snap-wb-summary">
                      <h4 className="snap-wb-summary-title">Greeks / IV</h4>
                      <div className="snap-wb-summary-grid">
                        {(() => {
                          const r = gkContractResult as Record<string, unknown>
                          const g = (typeof r.greeks === 'object' && r.greeks != null ? r.greeks : {}) as Record<string, unknown>
                          const entries: [string, unknown][] = [
                            ['IV', r.implied_volatility], ['Delta', g.delta], ['Gamma', g.gamma],
                            ['Theta', g.theta], ['Vega', g.vega], ['Open interest', r.open_interest], ['Break-even', r.break_even_price],
                          ]
                          return entries.map(([k, v]) => (
                            <div key={k} className="snap-wb-summary-item">
                              <span className="snap-wb-summary-key">{k}</span>
                              <span className="snap-wb-summary-val">{v != null && Number.isFinite(Number(v)) ? Number(v).toFixed(6) : '\u2014'}</span>
                            </div>
                          ))
                        })()}
                      </div>
                    </div>
                    <details className="feed-massive-details-debug">
                      <summary>Full contract response</summary>
                      <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>{JSON.stringify(gkContractResult, null, 2)}</pre>
                    </details>
                  </div>
                )}
              </div>
            )}

            {gkSubTab === 'db_verify' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Read stored snapshot rows from PostgreSQL and verify IV, greeks, and open interest coverage.</p>
                </div>
                <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end' }}>
                  <label className="feed-massive-field">
                    <span className="form-label">Symbol</span>
                    <input className="form-input" value={verifySymbol} onChange={e => setVerifySymbol(e.target.value)} disabled={verifyLoading} autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Expiration</span>
                    <input className="form-input" value={verifyExp} onChange={e => setVerifyExp(e.target.value)} placeholder="YYYYMMDD" disabled={verifyLoading} />
                  </label>
                  <label className="feed-massive-field" style={{ flex: '1 1 12rem', minWidth: '10rem' }}>
                    <span className="form-label">Strikes (CSV)</span>
                    <input className="form-input" value={verifyStrikes} onChange={e => setVerifyStrikes(e.target.value)} disabled={verifyLoading} placeholder="Optional" />
                  </label>
                  <button type="button" className="btn btn-primary" disabled={verifyLoading} onClick={() => runVerify()}>
                    {verifyLoading ? 'Loading\u2026' : 'Load'}
                  </button>
                </div>
                {verifyUnderlying != null && (
                  <div className="feed-massive-verify-meta">Underlying (row / fallback): <strong>{verifyUnderlying.toFixed(2)}</strong></div>
                )}
                {verifyErr && <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{verifyErr}</p>}
                {greeksQuality && (
                  <div className="gk-quality-summary">
                    <div className="gk-quality-summary-grid">
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">Total rows</span><span className="gk-quality-summary-value">{greeksQuality.total}</span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">With IV</span><span className="gk-quality-summary-value">{greeksQuality.withIv} <span className="gk-quality-summary-pct">({greeksQuality.ivPct}%)</span></span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">Any greek</span><span className="gk-quality-summary-value">{greeksQuality.withAnyGreek}</span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">Full greeks</span><span className="gk-quality-summary-value">{greeksQuality.withFullGreeks} <span className="gk-quality-summary-pct">({greeksQuality.greeksPct}%)</span></span></div>
                      <div className="gk-quality-summary-item"><span className="gk-quality-summary-label">With OI</span><span className="gk-quality-summary-value">{greeksQuality.withOi}</span></div>
                    </div>
                  </div>
                )}
                {verifyRows.length > 0 && (
                  <div className="feed-massive-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Strike</th><th scope="col">Right</th><th scope="col">Mark</th>
                          <th scope="col">Day close</th>
                          <th scope="col">IV</th><th scope="col">Delta</th><th scope="col">Gamma</th>
                          <th scope="col">Theta</th><th scope="col">Vega</th><th scope="col">OI</th>
                        </tr>
                      </thead>
                      <tbody>
                        {verifyRows.map((row, i) => (
                          <tr key={`${row.strike}-${row.right}-${i}`}>
                            <td>{row.strike}</td>
                            <td>{row.right}</td>
                            <td>
                              {row.mark != null && Number.isFinite(row.mark) ? row.mark.toFixed(2) : '\u2014'}
                            </td>
                            <td>
                              {row.day_close != null && Number.isFinite(row.day_close)
                                ? row.day_close.toFixed(2)
                                : '\u2014'}
                            </td>
                            <td>{row.iv != null && Number.isFinite(row.iv) ? row.iv.toFixed(4) : '\u2014'}</td>
                            <td>{row.delta != null && Number.isFinite(row.delta) ? row.delta.toFixed(4) : '\u2014'}</td>
                            <td>{row.gamma != null && Number.isFinite(row.gamma) ? row.gamma.toFixed(6) : '\u2014'}</td>
                            <td>{row.theta != null && Number.isFinite(row.theta) ? row.theta.toFixed(4) : '\u2014'}</td>
                            <td>{row.vega != null && Number.isFinite(row.vega) ? row.vega.toFixed(4) : '\u2014'}</td>
                            <td>{row.open_interest != null ? row.open_interest : '\u2014'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {gkSubTab === 'unified_snapshot' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve unified market data snapshots for multiple option tickers in a single request.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/snapshot</code> (type=options)</p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field" style={{ gridColumn: '1 / -1' }}>
                    <span className="form-label">Tickers (comma separated) *</span>
                    <input className="form-input" value={gkUnifiedTickers} onChange={e => setGkUnifiedTickers(e.target.value)} disabled={gkUnifiedBusy || !configured} autoComplete="off" placeholder="O:AAPL251219C00200000,O:NVDA251219C00150000" />
                  </label>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-primary" disabled={gkUnifiedBusy || !configured} onClick={() => runGkUnifiedSnapshot()}>
                    {gkUnifiedBusy ? 'Running\u2026' : 'Enqueue Unified Snapshot'}
                  </button>
                </div>
                {gkUnifiedErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{gkUnifiedErr}</p> : null}
                {gkUnifiedResult && (
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <details className="feed-massive-details-debug" open>
                      <summary>Result{Array.isArray((gkUnifiedResult as Record<string, unknown>).content) ? ` \u2014 ${((gkUnifiedResult as Record<string, unknown>).content as unknown[]).length} item(s)` : ''}</summary>
                      <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>{JSON.stringify(gkUnifiedResult, null, 2)}</pre>
                    </details>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
