import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { fetchDbCoverageSummary, fetchWatchlistDbCoverage } from '../api'
import type { DbCoverageSummaryRow, WatchlistDbCoverageSymbolRow } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { COVERAGE_OPTION_SUBSECTION, COVERAGE_STOCK_SUBSECTIONS, FEED_MASSIVE_STOCK_ID } from './settings/settingsConstants'

interface DataOverviewPageProps {
  status: StatusResponse | null
}

const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000

function detailLabel(hash: string): string {
  if (hash === COVERAGE_OPTION_SUBSECTION.id) return 'Option Coverage'
  if (hash === COVERAGE_STOCK_SUBSECTIONS[0].id) return 'Stock — IB Live (Redis)'
  if (hash === COVERAGE_STOCK_SUBSECTIONS[1].id) return 'Stock — Massive Delay (DB)'
  return 'Open'
}

function fmtTs(iso: string | null): string {
  if (!iso) return '—'
  if (iso.length >= 16) return iso.slice(0, 16).replace('T', ' ')
  return iso
}

/** Human-readable age from server age_seconds (UTC), English. */
function fmtAgeSeconds(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  const h = Math.floor(s / 3600)
  const d = Math.floor(h / 24)
  const hr = h % 24
  const min = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${hr}h ago`
  if (h > 0) return `${h}h ${min}m ago`
  return `${m}m ago`
}

function snapshotStale(ts: string | null): boolean {
  if (!ts) return false
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return false
  return Date.now() - t > SNAPSHOT_STALE_MS
}

function coverageScore(r: WatchlistDbCoverageSymbolRow): number {
  let n = 0
  if (r.option_contracts.has_data) n++
  if (r.option_snapshots.has_data) n++
  if (r.report_option_atm_iv_daily.has_data) n++
  if (r.stock_day.has_data) n++
  return n
}

type WatchlistSectionTab = 'options' | 'stocks'

export function DataOverviewPage(_props: DataOverviewPageProps) {
  const [wlRows, setWlRows] = useState<WatchlistDbCoverageSymbolRow[]>([])
  const [wlTab, setWlTab] = useState<WatchlistSectionTab>('options')
  const [wlGeneratedAt, setWlGeneratedAt] = useState<string | null>(null)
  const [wlMessage, setWlMessage] = useState<string | null>(null)
  const [wlError, setWlError] = useState<string | null>(null)

  const [rows, setRows] = useState<DbCoverageSummaryRow[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setWlError(null)
    setGlobalError(null)
    setWlMessage(null)
    try {
      const [wl, g] = await Promise.all([fetchWatchlistDbCoverage(), fetchDbCoverageSummary()])

      if (!wl.ok) {
        setWlRows([])
        setWlGeneratedAt(null)
        setWlError(wl.error ?? 'Watchlist coverage failed')
      } else {
        setWlRows(wl.symbols ?? [])
        setWlGeneratedAt(wl.generated_at ?? null)
        setWlMessage(typeof wl.message === 'string' ? wl.message : null)
      }

      if (!g.ok) {
        setRows([])
        setGeneratedAt(null)
        setGlobalError(g.error ?? 'Global summary failed')
      } else {
        setRows(g.tables ?? [])
        setGeneratedAt(g.generated_at ?? null)
      }
    } catch (e) {
      setWlRows([])
      setRows([])
      setWlGeneratedAt(null)
      setGeneratedAt(null)
      setWlError(e instanceof Error ? e.message : 'Failed to load')
      setGlobalError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const openDetail = (hash: string) => {
    window.location.hash = `#${hash}`
  }

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
        Data Overview
        <InfoTooltip text="Watchlist section: per-symbol PostgreSQL freshness for optionable STK symbols. Global section: distinct counts across the whole database." />
      </h2>

      <p className="section-hint" style={{ marginBottom: 'var(--space-2)' }}>
        Watchlist coverage uses the same universe as Daily Data Status (STK with optionable=true). Global summary is not limited to the watchlist.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          Refresh loads both watchlist matrix and global aggregates.
        </span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={loading} onClick={() => void loadAll()}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Watchlist matrix */}
      <section className="replay-section" aria-labelledby="data-overview-wl-head" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 id="data-overview-wl-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          Watchlist coverage
          <InfoTooltip text="One row per watchlist symbol (max 80). Options tab centers on option_contracts aggregates; Stocks tab shows stock_day only. Snapshots & ATM IV are optional detail. Snapshot time older than 24 hours is highlighted in the detail table." />
        </h3>
        {wlError ? <p className="status-page-msg err" role="alert">{wlError}</p> : null}
        {wlGeneratedAt ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            Generated at {wlGeneratedAt}
          </p>
        ) : null}
        {wlMessage && !wlError ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>{wlMessage}</p>
        ) : null}

        {wlRows.length > 0 ? (
          <>
            <div className="feed-massive-agg-tabs-wrap" style={{ marginBottom: 'var(--space-3)' }}>
              <div className="feed-massive-agg-tabs" role="tablist" aria-label="Watchlist coverage datasets">
                <button
                  type="button"
                  role="tab"
                  id="data-overview-wl-tab-options"
                  className={`feed-massive-agg-tab${wlTab === 'options' ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={wlTab === 'options'}
                  tabIndex={wlTab === 'options' ? 0 : -1}
                  onClick={() => setWlTab('options')}
                >
                  Options
                </button>
                <button
                  type="button"
                  role="tab"
                  id="data-overview-wl-tab-stocks"
                  className={`feed-massive-agg-tab${wlTab === 'stocks' ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={wlTab === 'stocks'}
                  tabIndex={wlTab === 'stocks' ? 0 : -1}
                  onClick={() => setWlTab('stocks')}
                >
                  Stocks
                </button>
              </div>
            </div>

            {wlTab === 'options' ? (
              <>
                <div className="feed-massive-table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Symbol</th>
                        <th scope="col">
                          Age since last row
                          <InfoTooltip text="Based on max(created_at) in option_contracts — a last row activity proxy, same semantics as Contracts coverage newest_ts. Not a dedicated Celery job completion time." />
                        </th>
                        <th scope="col">
                          Completeness
                          <InfoTooltip text="ticker% = rows with massive_option_ticker set; identity% = rows with symbol, expiry, and option_right non-empty. Same definitions as GET /research/massive/contracts-coverage." />
                        </th>
                        <th scope="col">Rows</th>
                        <th scope="col">Expiries / strikes</th>
                        <th scope="col">
                          Mismatch
                          <InfoTooltip text="Rows where contract_key does not contain underlying symbol (mapping consistency check)." />
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {wlRows.map(r => {
                        const oc = r.option_contracts
                        const ticker = oc.ticker_pct
                        const ident = oc.identity_pct
                        const completeness = oc.has_data && ticker != null && ident != null
                          ? `${ticker}% / ${ident}%`
                          : '—'
                        return (
                          <tr key={r.symbol}>
                            <th scope="row"><strong>{r.symbol}</strong></th>
                            <td
                              style={{ fontSize: 'var(--text-caption)' }}
                              title={oc.newest_created_at ? `newest_created_at: ${oc.newest_created_at}` : undefined}
                            >
                              {fmtAgeSeconds(oc.age_seconds)}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>{completeness}</td>
                            <td>{oc.has_data && oc.row_count != null ? oc.row_count : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {oc.has_data && oc.distinct_expirations != null && oc.distinct_strikes != null
                                ? `${oc.distinct_expirations} / ${oc.distinct_strikes}`
                                : '—'}
                            </td>
                            <td>{oc.has_data && oc.mapping_mismatch_count != null ? oc.mapping_mismatch_count : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>

                <details className="replay-section" style={{ marginTop: 'var(--space-3)' }}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 'var(--space-2)' }}>
                    Snapshots &amp; ATM IV
                  </summary>
                  <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
                    option_snapshots and report_option_atm_iv_daily — same data as before, without extra API calls.
                  </p>
                  <div className="feed-massive-table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th scope="col">Symbol</th>
                          <th scope="col">option_snapshots</th>
                          <th scope="col">report ATM IV</th>
                          <th scope="col">Data OK</th>
                        </tr>
                      </thead>
                      <tbody>
                        {wlRows.map(r => {
                          const st = r.option_snapshots.snapshots_last_ts
                          const stale = snapshotStale(st)
                          const ok = coverageScore(r)
                          return (
                            <tr key={r.symbol}>
                              <th scope="row"><strong>{r.symbol}</strong></th>
                              <td
                                style={{
                                  fontSize: 'var(--text-caption)',
                                  color: stale ? '#fbbf24' : undefined,
                                }}
                                title={stale ? 'Snapshot older than 24h' : undefined}
                              >
                                {r.option_snapshots.has_data ? fmtTs(r.option_snapshots.snapshots_last_ts) : '—'}
                              </td>
                              <td style={{ fontSize: 'var(--text-caption)' }}>
                                {r.report_option_atm_iv_daily.has_data
                                  ? `${fmtTs(r.report_option_atm_iv_daily.atm_iv_last_trade_date)} / ${fmtTs(r.report_option_atm_iv_daily.atm_iv_last_created_at)}`
                                  : '—'}
                              </td>
                              <td>{ok}/4</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </details>
              </>
            ) : (
              <div className="feed-massive-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Symbol</th>
                      <th scope="col">Last bar</th>
                      <th scope="col">stock_day created</th>
                      <th scope="col">OK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wlRows.map(r => (
                      <tr key={r.symbol}>
                        <th scope="row"><strong>{r.symbol}</strong></th>
                        <td style={{ fontSize: 'var(--text-caption)' }}>
                          {r.stock_day.has_data ? fmtTs(r.stock_day.stock_day_last_bar) : '—'}
                        </td>
                        <td style={{ fontSize: 'var(--text-caption)' }}>
                          {r.stock_day.has_data ? fmtTs(r.stock_day.stock_day_last_created_at) : '—'}
                        </td>
                        <td>{r.stock_day.has_data ? 'Yes' : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
        {!loading && !wlError && wlRows.length === 0 && !wlMessage ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)' }}>No watchlist rows.</p>
        ) : null}
      </section>

      {/* Global summary */}
      <section className="replay-section" aria-labelledby="data-overview-summary-head">
        <h3 id="data-overview-summary-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
          Global PostgreSQL coverage
          <InfoTooltip text="Distinct symbols use normalized upper-case tickers. option_snapshots uses the underlying segment of contract_key (SYM|OPT|…)." />
        </h3>

        {globalError ? <p className="status-page-msg err" role="alert">{globalError}</p> : null}
        {generatedAt ? (
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            Generated at {generatedAt}
          </p>
        ) : null}

        <div className="feed-massive-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col">Table</th>
                <th scope="col">Domain</th>
                <th scope="col">Distinct symbols</th>
                <th scope="col">Newest row / activity</th>
                <th scope="col">Trade / bar date</th>
                <th scope="col">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.id}>
                  <td>{row.dataset_label}</td>
                  <td><code>{row.table_name}</code></td>
                  <td>{row.domain}</td>
                  <td>{row.error ? '—' : (row.distinct_symbols ?? '—')}</td>
                  <td style={{ fontSize: 'var(--text-caption)' }}>{row.error ? row.error : (row.newest_activity ?? '—')}</td>
                  <td style={{ fontSize: 'var(--text-caption)' }}>{row.newest_trade_date ?? '—'}</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => openDetail(row.drill_down_hash)}
                    >
                      {detailLabel(row.drill_down_hash)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!loading && rows.length === 0 && !globalError ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)' }}>No rows returned.</p>
        ) : null}
      </section>

      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginTop: 'var(--space-4)' }}>
        Massive option sync and chain tools:{' '}
        <button type="button" className="page-title-breadcrumb-link" style={{ fontSize: 'inherit', padding: 0 }} onClick={() => { window.location.hash = `#${COVERAGE_OPTION_SUBSECTION.id}` }}>
          Data Coverage → Option
        </button>
        {' · '}
        Stock daily bars (DB):{' '}
        <button type="button" className="page-title-breadcrumb-link" style={{ fontSize: 'inherit', padding: 0 }} onClick={() => { window.location.hash = `#${FEED_MASSIVE_STOCK_ID}` }}>
          Feed → Massive → Stock
        </button>
      </p>
    </div>
  )
}
