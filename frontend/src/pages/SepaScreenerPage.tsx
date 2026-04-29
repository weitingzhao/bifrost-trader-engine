import { useMemo, useState } from 'react'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { runSepaPhase1, type SepaPhase1SymbolResult } from '../api/research/sepa'
import { runSepaCrs, type SepaCrsRow } from '../api/research/sepaCrs'
import { runSepaFundamentals, type SepaFundamentalsRow } from '../api/research/sepaFundamentals'
import {
  fetchSepaPhase4Job,
  fetchSepaPhase4JobResult,
  fetchSepaPhase4Jobs,
  submitSepaPhase4Job,
  type SepaPhase4JobListItem,
  type SepaPhase4JobResultResponse,
  type SepaPhase4JobSummary,
} from '../api/research/sepaPhase4Jobs'

interface SepaScreenerPageProps {
  onBreadcrumbResearch?: () => void
  breadcrumbLabel?: string
}

function parseSymbols(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\n,\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    ),
  )
}

type MainSummary = { total: number; passed: number; failed: number; insufficient_data: number }

function mapPhase4JobResultToMainTable(result: SepaPhase4JobResultResponse): {
  nextRows: SepaPhase1SymbolResult[]
  nextCrs: Record<string, SepaCrsRow>
  nextFund: Record<string, SepaFundamentalsRow>
  summary: MainSummary | null
} {
  const nextRows: SepaPhase1SymbolResult[] = []
  const nextCrs: Record<string, SepaCrsRow> = {}
  const nextFund: Record<string, SepaFundamentalsRow> = {}
  for (const row of result.rows || []) {
    const phase1 = row.phase1 as SepaPhase1SymbolResult | undefined
    const crs = row.crs as SepaCrsRow | undefined
    const fundamentals = row.fundamentals as SepaFundamentalsRow | undefined
    if (phase1) nextRows.push(phase1)
    if (crs?.symbol) nextCrs[crs.symbol] = crs
    if (fundamentals?.symbol) nextFund[fundamentals.symbol] = fundamentals
  }
  const summary = result.summary
    ? {
        total: Number(result.summary.total_symbols ?? 0),
        passed: Number(result.summary.final_passed ?? 0),
        failed: Math.max(0, Number(result.summary.total_symbols ?? 0) - Number(result.summary.final_passed ?? 0)),
        insufficient_data: Number(result.summary.failed_symbols ?? 0),
      }
    : null
  return { nextRows, nextCrs, nextFund, summary }
}

export function SepaScreenerPage({ onBreadcrumbResearch, breadcrumbLabel = 'SEPA Screener' }: SepaScreenerPageProps) {
  const [symbolText, setSymbolText] = useState('AAPL,MSFT,NVDA,AMZN')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<SepaPhase1SymbolResult[]>([])
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [summary, setSummary] = useState<{ total: number; passed: number; failed: number; insufficient_data: number } | null>(null)
  const [crsLoading, setCrsLoading] = useState(false)
  const [crsMin, setCrsMin] = useState(70)
  const [onlyCrsPass, setOnlyCrsPass] = useState(false)
  const [crsBySymbol, setCrsBySymbol] = useState<Record<string, SepaCrsRow>>({})
  const [crsVersion, setCrsVersion] = useState<string | null>(null)
  const [fundLoading, setFundLoading] = useState(false)
  const [onlyFundPass, setOnlyFundPass] = useState(false)
  const [fundBySymbol, setFundBySymbol] = useState<Record<string, SepaFundamentalsRow>>({})
  const [fundVersion, setFundVersion] = useState<string | null>(null)
  const [phase4Loading, setPhase4Loading] = useState(false)
  const [phase4JobId, setPhase4JobId] = useState<string | null>(null)
  const [phase4Status, setPhase4Status] = useState<string | null>(null)
  const [phase4Summary, setPhase4Summary] = useState<Partial<SepaPhase4JobSummary> | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyRows, setHistoryRows] = useState<SepaPhase4JobListItem[]>([])
  const [historyStatus, setHistoryStatus] = useState('')
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [historyRowLoadingId, setHistoryRowLoadingId] = useState<string | null>(null)

  const symbols = useMemo(() => parseSymbols(symbolText), [symbolText])

  const run = async () => {
    if (!symbols.length) {
      setError('Please input at least one symbol.')
      return
    }
    setLoading(true)
    setError(null)
    setRows([])
    setSummary(null)
    try {
      const res = await runSepaPhase1({
        symbols,
        volume_threshold: 100000,
        strict_sma200_rising: false,
        source: 'massive',
        lookback_days: 400,
      })
      if (!res.ok) throw new Error(res.error || 'SEPA phase1 failed')
      setRows(res.results || [])
      setSummary(res.summary ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SEPA phase1 failed')
    } finally {
      setLoading(false)
    }
  }

  const runCrs = async () => {
    if (!symbols.length) {
      setError('Please input at least one symbol.')
      return
    }
    setCrsLoading(true)
    setError(null)
    try {
      const res = await runSepaCrs({
        symbols,
        source: 'massive',
        lookback_days: 420,
        min_crs: crsMin,
      })
      if (!res.ok) throw new Error(res.error || 'SEPA CRS failed')
      const map: Record<string, SepaCrsRow> = {}
      for (const r of res.results || []) map[r.symbol] = r
      setCrsBySymbol(map)
      setCrsVersion(res.crs_version ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SEPA CRS failed')
    } finally {
      setCrsLoading(false)
    }
  }

  const runFundamentals = async () => {
    if (!symbols.length) {
      setError('Please input at least one symbol.')
      return
    }
    setFundLoading(true)
    setError(null)
    try {
      const res = await runSepaFundamentals({
        symbols,
        eps_q2q_threshold: 0.25,
        rev_q2q_threshold: 0.25,
        eps_3y_threshold: 0.15,
        rev_3y_threshold: 0.15,
      })
      if (!res.ok) throw new Error(res.error || 'SEPA fundamentals failed')
      const map: Record<string, SepaFundamentalsRow> = {}
      for (const r of res.results || []) map[r.symbol] = r
      setFundBySymbol(map)
      setFundVersion(res.rule_version ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SEPA fundamentals failed')
    } finally {
      setFundLoading(false)
    }
  }

  const runPhase4Job = async () => {
    if (!symbols.length) {
      setError('Please input at least one symbol.')
      return
    }
    setPhase4Loading(true)
    setError(null)
    setPhase4Summary(null)
    try {
      const submit = await submitSepaPhase4Job({
        symbols,
        source: 'massive',
        lookback_days: 420,
        min_crs: crsMin,
        max_workers: 4,
        max_retries: 3,
        rate_limit_rps: 4,
        cache_ttl_sec: 21600,
        use_parallel: true,
      })
      if (!submit.ok || !submit.job_id) throw new Error(submit.error || 'submit phase4 job failed')
      setPhase4JobId(submit.job_id)
      let done = false
      for (let i = 0; i < 300; i += 1) {
        const st = await fetchSepaPhase4Job(submit.job_id)
        if (!st.ok) throw new Error(st.error || 'phase4 status failed')
        setPhase4Status(st.status)
        setPhase4Summary(st.summary ?? null)
        if (st.status === 'succeeded' || st.status === 'partial' || st.status === 'failed') {
          done = true
          break
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1200))
      }
      if (!done) throw new Error('phase4 job polling timeout')
      const result = await fetchSepaPhase4JobResult(submit.job_id, 0, 1000)
      if (!result.ok) throw new Error(result.error || 'phase4 result failed')
      const { nextRows, nextCrs, nextFund, summary: nextSummary } = mapPhase4JobResultToMainTable(result)
      if (nextRows.length) setRows(nextRows)
      else setRows([])
      setCrsBySymbol(nextCrs)
      setFundBySymbol(nextFund)
      setSummary(nextSummary)
      setExpanded({})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'SEPA phase4 job failed')
    } finally {
      setPhase4Loading(false)
    }
  }

  const runPhase4HistorySearch = async () => {
    setHistoryLoading(true)
    setError(null)
    try {
      const createdFrom = historyFrom ? new Date(historyFrom).toISOString() : undefined
      const createdTo = historyTo ? new Date(historyTo).toISOString() : undefined
      const res = await fetchSepaPhase4Jobs({
        status: historyStatus || undefined,
        created_from: createdFrom,
        created_to: createdTo,
        limit: 50,
        offset: 0,
      })
      if (!res.ok) throw new Error(res.error || 'Load phase4 jobs failed')
      setHistoryRows(res.jobs || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load phase4 jobs failed')
    } finally {
      setHistoryLoading(false)
    }
  }

  const loadPhase4JobIntoMain = async (jobId: string) => {
    const id = (jobId || '').trim()
    if (!id) return
    setHistoryRowLoadingId(id)
    setError(null)
    try {
      const st = await fetchSepaPhase4Job(id)
      if (!st.ok) throw new Error(st.error || 'phase4 status failed')
      setPhase4JobId(id)
      setPhase4Status(st.status)
      setPhase4Summary(st.summary ?? null)
      const result = await fetchSepaPhase4JobResult(id, 0, 1000)
      if (!result.ok) throw new Error(result.error || 'phase4 result failed')
      const { nextRows, nextCrs, nextFund, summary: nextSummary } = mapPhase4JobResultToMainTable(result)
      if (nextRows.length) setRows(nextRows)
      else setRows([])
      setCrsBySymbol(nextCrs)
      setFundBySymbol(nextFund)
      setSummary(nextSummary)
      setExpanded({})
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load phase4 job into table failed')
    } finally {
      setHistoryRowLoadingId(null)
    }
  }

  const displayRows = useMemo(() => {
    return rows.filter((r) => {
      if (onlyCrsPass && !crsBySymbol[r.symbol]?.pass) return false
      if (onlyFundPass && !fundBySymbol[r.symbol]?.fundamental_pass) return false
      return true
    })
  }, [rows, onlyCrsPass, crsBySymbol, onlyFundPass, fundBySymbol])

  return (
    <div className="container page-content">
      <SectionPageTitle
        menu="Research"
        pageTitle={breadcrumbLabel}
        onMenuClick={onBreadcrumbResearch}
        menuNavigateAriaLabel="Go to Research home"
        infoText="SEPA screener supports phase-1 technical filter, CRS ranking, and fundamentals re-screening."
      />

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-body">
          <div className="mb-2 fw-semibold">Symbols</div>
          <textarea
            className="form-control"
            rows={3}
            value={symbolText}
            onChange={(e) => setSymbolText(e.target.value)}
            placeholder="AAPL,MSFT,NVDA"
          />
          <div className="text-muted mt-2" style={{ fontSize: 12 }}>
            Parsed: {symbols.length} symbols (max 300 per request)
          </div>
          <div className="mt-3">
            <button className="btn btn-primary btn-sm" onClick={run} disabled={loading}>
              {loading ? 'Running…' : 'Run SEPA Phase 1'}
            </button>
            <button className="btn btn-secondary btn-sm ms-2" onClick={runCrs} disabled={crsLoading}>
              {crsLoading ? 'Running CRS…' : 'Run CRS'}
            </button>
            <button className="btn btn-secondary btn-sm ms-2" onClick={runFundamentals} disabled={fundLoading}>
              {fundLoading ? 'Running Fundamentals…' : 'Run Fundamentals'}
            </button>
            <button className="btn btn-dark btn-sm ms-2" onClick={runPhase4Job} disabled={phase4Loading}>
              {phase4Loading ? 'Running Phase4 Job…' : 'Run Phase4 Job'}
            </button>
          </div>
          <div className="mt-3 d-flex align-items-center gap-3 flex-wrap">
            <label className="d-flex align-items-center gap-2 mb-0">
              <span style={{ fontSize: 12 }}>CRS min</span>
              <input
                type="number"
                className="form-control form-control-sm"
                style={{ width: 90 }}
                value={crsMin}
                min={0}
                max={100}
                onChange={(e) => setCrsMin(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
              />
            </label>
            <label className="d-flex align-items-center gap-2 mb-0">
              <input
                type="checkbox"
                checked={onlyCrsPass}
                onChange={(e) => setOnlyCrsPass(e.target.checked)}
              />
              <span style={{ fontSize: 12 }}>Only CRS pass ({'>='} {crsMin})</span>
            </label>
            <label className="d-flex align-items-center gap-2 mb-0">
              <input
                type="checkbox"
                checked={onlyFundPass}
                onChange={(e) => setOnlyFundPass(e.target.checked)}
              />
              <span style={{ fontSize: 12 }}>Only fundamentals pass</span>
            </label>
            {crsVersion ? <span className="text-muted" style={{ fontSize: 12 }}>CRS: {crsVersion}</span> : null}
            {fundVersion ? <span className="text-muted" style={{ fontSize: 12 }}>Fund: {fundVersion}</span> : null}
          </div>
          {error ? <div className="text-danger mt-2">{error}</div> : null}
          {phase4JobId ? (
            <div className="text-muted mt-2" style={{ fontSize: 12 }}>
              Phase4 job: <code>{phase4JobId}</code> {phase4Status ? `(${phase4Status})` : ''}
            </div>
          ) : null}
          {phase4Summary ? (
            <div className="text-muted mt-1" style={{ fontSize: 12 }}>
              cache(redis/pg): {phase4Summary.cache_hit_redis ?? 0}/{phase4Summary.cache_hit_postgres ?? 0}, external calls: {phase4Summary.fundamentals_external_calls ?? 0}, retry: {phase4Summary.retry_count ?? 0}
            </div>
          ) : null}
        </div>
      </div>

      <div className="card" style={{ marginBottom: 12 }}>
        <div className="card-body">
          <div className="d-flex align-items-center justify-content-between flex-wrap gap-2">
            <div className="fw-semibold">Phase4 Job History</div>
            <button className="btn btn-outline-dark btn-sm" onClick={runPhase4HistorySearch} disabled={historyLoading}>
              {historyLoading ? 'Loading…' : 'Search Jobs'}
            </button>
          </div>
          <div className="row g-2 mt-2">
            <div className="col-md-3">
              <label className="form-label mb-1" style={{ fontSize: 12 }}>Status</label>
              <select className="form-select form-select-sm" value={historyStatus} onChange={(e) => setHistoryStatus(e.target.value)}>
                <option value="">All</option>
                <option value="queued">queued</option>
                <option value="running">running</option>
                <option value="succeeded">succeeded</option>
                <option value="partial">partial</option>
                <option value="failed">failed</option>
              </select>
            </div>
            <div className="col-md-4">
              <label className="form-label mb-1" style={{ fontSize: 12 }}>Created from</label>
              <input
                type="datetime-local"
                className="form-control form-control-sm"
                value={historyFrom}
                onChange={(e) => setHistoryFrom(e.target.value)}
              />
            </div>
            <div className="col-md-4">
              <label className="form-label mb-1" style={{ fontSize: 12 }}>Created to</label>
              <input
                type="datetime-local"
                className="form-control form-control-sm"
                value={historyTo}
                onChange={(e) => setHistoryTo(e.target.value)}
              />
            </div>
          </div>
          <div className="text-muted mb-2" style={{ fontSize: 12 }}>
            Click a row to load that job&apos;s result into the main table below.
          </div>
          <div className="table-responsive mt-3">
            <table className="table table-sm align-middle mb-0">
              <thead>
                <tr>
                  <th>Job ID</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Progress</th>
                  <th>Total</th>
                  <th>Final pass</th>
                  <th>Duration(s)</th>
                </tr>
              </thead>
              <tbody>
                {historyRows.length ? historyRows.map((j) => (
                  <tr
                    key={j.job_id}
                    role="button"
                    tabIndex={0}
                    className={historyRowLoadingId === j.job_id ? 'table-active' : ''}
                    style={{ cursor: 'pointer' }}
                    onClick={() => void loadPhase4JobIntoMain(j.job_id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void loadPhase4JobIntoMain(j.job_id)
                      }
                    }}
                    title="Load this job into the main table"
                  >
                    <td><code>{j.job_id}</code></td>
                    <td>{j.status}{historyRowLoadingId === j.job_id ? ' …' : ''}</td>
                    <td>{j.created_at ? String(j.created_at).replace('T', ' ').slice(0, 19) : '—'}</td>
                    <td>{j.progress ? `${j.progress.stage} (${j.progress.pct}%)` : '—'}</td>
                    <td>{j.summary?.total_symbols ?? '—'}</td>
                    <td>{j.summary?.final_passed ?? '—'}</td>
                    <td>{j.summary?.duration_sec ?? '—'}</td>
                  </tr>
                )) : (
                  <tr>
                    <td colSpan={7} className="text-muted">No jobs loaded. Use filters and click Search Jobs.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {summary ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="card-body" style={{ fontSize: 13 }}>
            <strong>Summary</strong>: total {summary.total}, passed {summary.passed}, failed {summary.failed}, insufficient data {summary.insufficient_data}
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="card-body">
          <div className="table-responsive">
            <table className="table table-sm align-middle">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Symbol</th>
                  <th style={{ width: 100 }}>CRS</th>
                  <th style={{ width: 110 }}>ret252</th>
                  <th style={{ width: 90 }}>CRS pass</th>
                  <th style={{ width: 120 }}>Technical pass</th>
                  <th style={{ width: 140 }}>Fundamentals pass</th>
                  <th style={{ width: 120 }}>Pass count</th>
                  <th style={{ width: 120 }}>Fail count</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {displayRows.flatMap((r) => {
                  const crs = crsBySymbol[r.symbol]
                  const fund = fundBySymbol[r.symbol]
                  const mainRow = (
                    <tr key={r.symbol}>
                      <td>
                        <button
                          className="btn btn-link p-0"
                          onClick={() => setExpanded((prev) => ({ ...prev, [r.symbol]: !prev[r.symbol] }))}
                        >
                          {expanded[r.symbol] ? '▼' : '▶'} {r.symbol}
                        </button>
                      </td>
                      <td>{crs?.crs_score ?? '—'}</td>
                      <td>{crs?.ret252 != null ? `${(crs.ret252 * 100).toFixed(2)}%` : '—'}</td>
                      <td>{crs ? (crs.pass ? 'PASS' : 'FAIL') : '—'}</td>
                      <td>{r.technical_pass ? 'PASS' : 'FAIL'}</td>
                      <td>{fund ? (fund.fundamental_pass ? 'PASS' : 'FAIL') : '—'}</td>
                      <td>{r.pass_count ?? '—'}</td>
                      <td>{r.fail_count ?? '—'}</td>
                      <td>{r.error ?? '—'}</td>
                    </tr>
                  )
                  const detailRow = expanded[r.symbol] ? (
                    <tr key={`${r.symbol}-detail`}>
                        <td colSpan={9}>
                          <div className="table-responsive">
                            <table className="table table-sm mb-0">
                              <thead>
                                <tr>
                                  <th>Domain</th>
                                  <th>Condition</th>
                                  <th>Pass</th>
                                  <th>Actual</th>
                                  <th>Threshold</th>
                                  <th>Reason</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(r.conditions || []).map((c) => (
                                  <tr key={`${r.symbol}-t-${c.id}`}>
                                    <td>Technical</td>
                                    <td><code>{c.id}</code></td>
                                    <td>{c.pass ? 'PASS' : 'FAIL'}</td>
                                    <td>{c.actual ?? '—'}</td>
                                    <td>{c.threshold ?? '—'}</td>
                                    <td>{c.reason}</td>
                                  </tr>
                                ))}
                                {(fund?.conditions || []).map((c) => (
                                  <tr key={`${r.symbol}-f-${c.id}`}>
                                    <td>Fundamentals</td>
                                    <td><code>{c.id}</code></td>
                                    <td>{c.pass ? 'PASS' : 'FAIL'}</td>
                                    <td>{c.actual ?? '—'}</td>
                                    <td>{c.threshold ?? '—'}</td>
                                    <td>{c.reason}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                  ) : null
                  return detailRow ? [mainRow, detailRow] : [mainRow]
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}

