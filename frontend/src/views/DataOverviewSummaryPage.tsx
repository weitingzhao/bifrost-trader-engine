import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchDbCoverageSummary,
  fetchMassiveCeleryBeatSchedule,
  fetchMassiveJobsList,
  fetchMassiveJobsSummary,
  fetchWatchlistDbCoverage,
} from '../api'
import type {
  DbCoverageSummaryRow,
  JobQueueStatusCounts,
  MassiveCeleryBeatEntry,
  MassiveJobApiRow,
  WatchlistDbCoverageSymbolRow,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { DataOverviewWatchlistOptionsSummaryTable } from './dataOverview/DataOverviewWatchlistOptions'
import { DataOverviewWatchlistStocksSummaryTable } from './dataOverview/DataOverviewWatchlistStocks'
import {
  COVERAGE_OPTION_SUBSECTION,
  COVERAGE_OVERVIEW_DETAIL_ID,
  COVERAGE_STOCK_SUBSECTIONS,
  FEED_MASSIVE_STOCK_ID,
} from './settings/settingsConstants'

const BREADCRUMB_LINK =
  'border-0 bg-transparent p-0 font-inherit text-[var(--color-link)] hover:text-[var(--color-link-hover)] hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]'

const PAGE_TITLE =
  'm-0 inline-flex flex-wrap items-center gap-2 text-[length:var(--text-headline)] font-bold tracking-tight text-foreground'

const SECTION_TITLE =
  'm-0 inline-flex flex-wrap items-center gap-2 text-[length:var(--text-body)] font-semibold tracking-tight text-foreground'

interface DataOverviewSummaryPageProps {
  status: StatusResponse | null
}

function detailLabel(hash: string): string {
  if (hash === COVERAGE_OPTION_SUBSECTION.id) return 'Option Coverage'
  if (hash === COVERAGE_STOCK_SUBSECTIONS[0].id) return 'Stock — IB Live (Redis)'
  if (hash === COVERAGE_STOCK_SUBSECTIONS[1].id) return 'Stock — Massive Delay (DB)'
  return 'Open'
}

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

function isoToAgeSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 1000))
}

function globalRowFreshness(row: DbCoverageSummaryRow): string {
  if (row.error) return '—'
  const act = row.newest_activity
  if (act) return fmtAgeSeconds(isoToAgeSeconds(act))
  const td = row.newest_trade_date
  if (td && td.length >= 10) {
    const t = Date.parse(`${td.slice(0, 10)}T12:00:00.000Z`)
    if (Number.isFinite(t)) return fmtAgeSeconds(Math.max(0, Math.floor((Date.now() - t) / 1000)))
  }
  return '—'
}

function fmtCrontabUtc(c: Record<string, string | number>): string {
  const h = c.hour
  const m = c.minute ?? 0
  return `hour=${String(h)} minute=${String(m)}`
}

function fmtJobTs(ts: number | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

function queueSummaryLine(c: JobQueueStatusCounts): string {
  return `pending ${c.pending} · running ${c.running} · failed ${c.failed} · done ${c.done}`
}

const emptyCounts = (): JobQueueStatusCounts => ({
  pending: 0,
  running: 0,
  done: 0,
  failed: 0,
})

export function DataOverviewSummaryPage(_props: DataOverviewSummaryPageProps) {
  const [wlRows, setWlRows] = useState<WatchlistDbCoverageSymbolRow[]>([])
  const [wlGeneratedAt, setWlGeneratedAt] = useState<string | null>(null)
  const [wlMessage, setWlMessage] = useState<string | null>(null)
  const [wlError, setWlError] = useState<string | null>(null)

  const [rows, setRows] = useState<DbCoverageSummaryRow[]>([])
  const [generatedAt, setGeneratedAt] = useState<string | null>(null)
  const [globalError, setGlobalError] = useState<string | null>(null)

  const [beatEntries, setBeatEntries] = useState<MassiveCeleryBeatEntry[]>([])
  const [beatError, setBeatError] = useState<string | null>(null)
  const [jobsOpt, setJobsOpt] = useState<JobQueueStatusCounts>(() => emptyCounts())
  const [jobsStock, setJobsStock] = useState<JobQueueStatusCounts>(() => emptyCounts())
  const [jobsSummaryError, setJobsSummaryError] = useState<string | null>(null)
  const [recentJobs, setRecentJobs] = useState<MassiveJobApiRow[]>([])
  const [jobsListError, setJobsListError] = useState<string | null>(null)

  const [loading, setLoading] = useState(true)

  const applyPipelineFetchResults = useCallback((settled: readonly PromiseSettledResult<unknown>[]) => {
    type Wl = Awaited<ReturnType<typeof fetchWatchlistDbCoverage>>
    type G = Awaited<ReturnType<typeof fetchDbCoverageSummary>>
    type Beat = Awaited<ReturnType<typeof fetchMassiveCeleryBeatSchedule>>
    type Jq = Awaited<ReturnType<typeof fetchMassiveJobsSummary>>
    type Jlist = Awaited<ReturnType<typeof fetchMassiveJobsList>>
    const wl = settled[0].status === 'fulfilled' ? (settled[0].value as Wl) : null
    const g = settled[1].status === 'fulfilled' ? (settled[1].value as G) : null
    const beat = settled[2].status === 'fulfilled' ? (settled[2].value as Beat) : null
    const jq = settled[3].status === 'fulfilled' ? (settled[3].value as Jq) : null
    const js = settled[4].status === 'fulfilled' ? (settled[4].value as Jq) : null
    const jlist = settled[5].status === 'fulfilled' ? (settled[5].value as Jlist) : null

    if (wl?.ok) {
      setWlRows(wl.symbols ?? [])
      setWlGeneratedAt(wl.generated_at ?? null)
      setWlMessage(typeof wl.message === 'string' ? wl.message : null)
      setWlError(null)
    } else {
      setWlRows([])
      setWlGeneratedAt(null)
      setWlMessage(null)
      setWlError(
        wl && !wl.ok
          ? wl.error ?? 'Watchlist coverage failed'
          : settled[0].status === 'rejected'
            ? (settled[0].reason instanceof Error ? settled[0].reason.message : 'Watchlist coverage failed')
            : 'Watchlist coverage failed',
      )
    }

    if (g?.ok) {
      setRows(g.tables ?? [])
      setGeneratedAt(g.generated_at ?? null)
      setGlobalError(null)
    } else {
      setRows([])
      setGeneratedAt(null)
      setGlobalError(
        g && !g.ok
          ? g.error ?? 'Global summary failed'
          : settled[1].status === 'rejected'
            ? (settled[1].reason instanceof Error ? settled[1].reason.message : 'Global summary failed')
            : 'Global summary failed',
      )
    }

    if (beat?.ok && Array.isArray(beat.entries)) {
      setBeatEntries(beat.entries)
      setBeatError(null)
    } else {
      setBeatEntries([])
      setBeatError(
        beat && beat.ok === false
          ? beat.error ?? 'Failed to load Celery Beat schedule'
          : settled[2].status === 'rejected'
            ? (settled[2].reason instanceof Error ? settled[2].reason.message : 'Failed to load Celery Beat schedule')
            : 'Failed to load Celery Beat schedule',
      )
    }

    const optOk = Boolean(jq?.ok && jq.counts)
    const stOk = Boolean(js?.ok && js.counts)
    if (optOk) {
      setJobsOpt(jq!.counts!)
    } else {
      setJobsOpt(emptyCounts())
    }
    if (stOk) {
      setJobsStock(js!.counts!)
    } else {
      setJobsStock(emptyCounts())
    }
    if (optOk && stOk) {
      setJobsSummaryError(null)
    } else {
      const parts: string[] = []
      if (!optOk) {
        parts.push(
          jq && !jq.ok
            ? jq.error ?? 'Options Massive queue unavailable'
            : settled[3].status === 'rejected'
              ? (settled[3].reason instanceof Error ? settled[3].reason.message : 'Options Massive queue unavailable')
              : 'Options Massive queue unavailable',
        )
      }
      if (!stOk) {
        parts.push(
          js && !js.ok
            ? js.error ?? 'Stocks Massive queue unavailable'
            : settled[4].status === 'rejected'
              ? (settled[4].reason instanceof Error ? settled[4].reason.message : 'Stocks Massive queue unavailable')
              : 'Stocks Massive queue unavailable',
        )
      }
      setJobsSummaryError(parts.join(' · '))
    }

    if (jlist?.ok && Array.isArray(jlist.jobs)) {
      setRecentJobs(jlist.jobs)
      setJobsListError(null)
    } else {
      setRecentJobs([])
      setJobsListError(
        jlist && !jlist.ok
          ? jlist.error ?? 'Recent jobs unavailable'
          : settled[5].status === 'rejected'
            ? (settled[5].reason instanceof Error ? settled[5].reason.message : 'Recent jobs unavailable')
            : 'Recent jobs unavailable',
      )
    }
  }, [])

  const loadAll = useCallback(async () => {
    setLoading(true)
    setWlError(null)
    setGlobalError(null)
    setWlMessage(null)
    setBeatError(null)
    setJobsSummaryError(null)
    setJobsListError(null)

    const settled = await Promise.allSettled([
      fetchWatchlistDbCoverage(),
      fetchDbCoverageSummary(),
      fetchMassiveCeleryBeatSchedule(),
      fetchMassiveJobsSummary('options_massive'),
      fetchMassiveJobsSummary('stocks_massive'),
      fetchMassiveJobsList({ limit: 10 }),
    ])

    applyPipelineFetchResults(settled)
    setLoading(false)
  }, [applyPipelineFetchResults])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const openDetail = (hash: string) => {
    window.location.hash = `#${hash}`
  }

  return (
    <PageSection className="market-data-page market-data-page--settings-embed min-w-0">
      <h2 className={PAGE_TITLE} style={{ marginBottom: 'var(--space-2)' }}>
        <button
          type="button"
          className={BREADCRUMB_LINK}
          onClick={() => { window.location.hash = '#settings-heartbeat' }}
          aria-label="Go to Settings"
        >
          Settings
        </button>
        <span className="text-foreground">
          {' / '}
          <button
            type="button"
            className={BREADCRUMB_LINK}
            onClick={() => { window.location.hash = `#${COVERAGE_OVERVIEW_DETAIL_ID}` }}
            aria-label="Go to Data Overview Detail"
          >
            Data Overview
          </button>
          {' / '}
          <span className="font-bold">Summary</span>
        </span>
        <InfoTooltip text="Aggregates only: watchlist summary tables, job queues, Celery Beat, global PostgreSQL coverage. Per-symbol matrix and jobs toolbar are on Data Overview → Detail." />
      </h2>

      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
        <button
          type="button"
          className={BREADCRUMB_LINK}
          style={{ fontSize: 'inherit', padding: 0 }}
          onClick={() => { window.location.hash = `#${COVERAGE_OVERVIEW_DETAIL_ID}` }}
        >
          Open Detail
        </button>
        {' — '}
        per-symbol matrix, Focus dataset, and coverage jobs.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-3)', marginBottom: 'var(--space-4)' }}>
        <span style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)' }}>
          Massive-only coverage and pipeline status.
        </span>
        <Button variant="secondary" size="sm" type="button" disabled={loading} onClick={() => void loadAll()}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>

      <section className="replay-section" aria-labelledby="data-overview-wl-summary-head" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 id="data-overview-wl-summary-head" className={SECTION_TITLE} style={{ marginBottom: 'var(--space-2)' }}>
          Watchlist coverage (summary)
          <InfoTooltip text="Watchlist-scoped aggregates by dataset. For per-symbol columns, use Data Overview → Detail." />
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
            <div style={{ marginBottom: 'var(--space-4)' }}>
              <h4 className={SECTION_TITLE} style={{ marginBottom: 'var(--space-2)' }}>
                Options (watchlist summary)
                <InfoTooltip text="Watchlist-scoped aggregates across symbols (max 80). Same metrics as Data Overview → Detail option datasets summary block." />
              </h4>
              <DataOverviewWatchlistOptionsSummaryTable wlRows={wlRows} />
            </div>
            <div>
              <h4 className={SECTION_TITLE} style={{ marginBottom: 'var(--space-2)' }}>
                Stocks (watchlist summary)
                <InfoTooltip text="Fundamental stock datasets for the same watchlist universe. Per-symbol matrix is on Data Overview → Detail." />
              </h4>
              <DataOverviewWatchlistStocksSummaryTable wlRows={wlRows} />
            </div>
          </>
        ) : null}
        {!loading && !wlError && wlRows.length === 0 && !wlMessage ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-caption)' }}>No watchlist rows.</p>
        ) : null}
      </section>

      <section className="replay-section" aria-labelledby="data-overview-pipeline-head" style={{ marginBottom: 'var(--space-4)' }}>
        <h3 id="data-overview-pipeline-head" className={SECTION_TITLE} style={{ marginBottom: 'var(--space-2)' }}>
          Massive job queues and schedule
          <InfoTooltip text="Queue counts come from job_massive_backfill (Ops API). Scheduled tasks list Celery Beat entries in UTC; actual execution requires Celery Beat and workers. Full job tables: Option Coverage and Massive Stock pages." />
        </h3>
        {jobsSummaryError ? (
          <p className="status-page-msg err" role="alert">{jobsSummaryError}</p>
        ) : null}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-3)',
          }}
        >
          <div
            className="replay-section"
            style={{ flex: '1 1 260px', margin: 0, padding: 'var(--space-3)' }}
          >
            <h4 className="mp-chart-subtitle" style={{ marginTop: 0 }}>Options Massive queue</h4>
            <p style={{ fontSize: 'var(--text-caption)', marginBottom: 'var(--space-2)' }}>{queueSummaryLine(jobsOpt)}</p>
            <Button variant="secondary" size="sm" type="button" onClick={() => openDetail(COVERAGE_OPTION_SUBSECTION.id)}
            >
              Open job details — Options
            </Button>
          </div>
          <div
            className="replay-section"
            style={{ flex: '1 1 260px', margin: 0, padding: 'var(--space-3)' }}
          >
            <h4 className="mp-chart-subtitle" style={{ marginTop: 0 }}>Stocks Massive queue</h4>
            <p style={{ fontSize: 'var(--text-caption)', marginBottom: 'var(--space-2)' }}>{queueSummaryLine(jobsStock)}</p>
            <Button variant="secondary" size="sm" type="button" onClick={() => openDetail(FEED_MASSIVE_STOCK_ID)}
            >
              Open job details — Stock
            </Button>
          </div>
        </div>

        {beatError ? <p className="status-page-msg err" role="alert">{beatError}</p> : null}
        {!beatError && beatEntries.length > 0 ? (
          <div className="feed-massive-table-wrap" style={{ marginBottom: 'var(--space-3)' }}>
            <h4 className="mp-chart-subtitle">Scheduled tasks (Celery Beat, UTC)</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Label</th>
                  <th scope="col">Schedule</th>
                  <th scope="col">Task</th>
                </tr>
              </thead>
              <tbody>
                {beatEntries.map(e => (
                  <tr key={e.name}>
                    <td><code>{e.name}</code></td>
                    <td>{e.label}</td>
                    <td style={{ fontSize: 'var(--text-caption)' }}>{fmtCrontabUtc(e.crontab)}</td>
                    <td style={{ fontSize: 'var(--text-caption)' }}><code>{e.task}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginTop: 'var(--space-2)' }}>
              Execution depends on Celery Beat and workers consuming the options_massive / stocks_massive queues.
            </p>
          </div>
        ) : null}

        {jobsListError ? <p className="status-page-msg err" role="alert">{jobsListError}</p> : null}
        {!jobsListError && recentJobs.length > 0 ? (
          <div className="feed-massive-table-wrap">
            <h4 className="mp-chart-subtitle">Recent jobs (newest first)</h4>
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Job ID</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {recentJobs.map(j => (
                  <tr key={j.job_id}>
                    <td><code>{j.job_id}</code></td>
                    <td>{j.kind ?? '—'}</td>
                    <td>{j.status ?? '—'}</td>
                    <td style={{ fontSize: 'var(--text-caption)' }}>{fmtJobTs(j.created_ts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="replay-section" aria-labelledby="data-overview-summary-head">
        <h3 id="data-overview-summary-head" className={SECTION_TITLE} style={{ marginBottom: 'var(--space-2)' }}>
          Global PostgreSQL coverage (Massive)
          <InfoTooltip text="Whole-database aggregates for Massive source rows. Option contracts count symbols with massive_option_ticker set. Distinct symbols use normalized tickers; option_snapshots counts the underlying segment of contract_key." />
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
                <th scope="col">Freshness</th>
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
                  <td style={{ fontSize: 'var(--text-caption)' }}>{globalRowFreshness(row)}</td>
                  <td>
                    <Button variant="secondary" size="sm" type="button" onClick={() => openDetail(row.drill_down_hash)}
                    >
                      {detailLabel(row.drill_down_hash)}
                    </Button>
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
        <button type="button" className={BREADCRUMB_LINK} style={{ fontSize: 'inherit', padding: 0 }} onClick={() => { window.location.hash = `#${COVERAGE_OPTION_SUBSECTION.id}` }}>
          Data Coverage → Option
        </button>
        {' · '}
        Stock daily bars (DB):{' '}
        <button type="button" className={BREADCRUMB_LINK} style={{ fontSize: 'inherit', padding: 0 }} onClick={() => { window.location.hash = `#${FEED_MASSIVE_STOCK_ID}` }}>
          Feed → Massive → Stock
        </button>
      </p>
    </PageSection>
  )
}
