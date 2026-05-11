import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { RightInspectorDrawer } from '../components/RightInspectorDrawer'
import { StockInspectorPanel } from '../components/StockInspectorPanel'
import {
  fetchSepaCriteriaStats,
  fetchFundamentalDistributionSymbols,
  fetchFundamentalFilter,
  fetchSymbolsReadinessSnapshot,
  type SepaCriteriaStats,
  type FundDistSymbolRow,
  type ReadinessSnapshotRow,
} from '../api/research/dataReadiness'
import '../styles/data-readiness.css'
import '../styles/stock-screener.css'

interface StockScreenerPageProps {
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

/** 8 canonical SEPA fundamental conditions in display order. */
const SEPA_COND_CATALOG: { id: string; label: string; short: string; group: 'eps' | 'rev' }[] = [
  { id: 'eps_q2q_ge_25pct', label: 'EPS QoQ ≥ 25%',         short: 'EPS Q2Q',    group: 'eps' },
  { id: 'rev_q2q_ge_25pct', label: 'Revenue QoQ ≥ 25%',     short: 'Rev Q2Q',    group: 'rev' },
  { id: 'eps_acc_2q',       label: 'EPS Accelerating (2Q)', short: 'EPS Acc 2Q', group: 'eps' },
  { id: 'rev_acc_2q',       label: 'Revenue Accel (2Q)',    short: 'Rev Acc 2Q', group: 'rev' },
  { id: 'eps_3y_ge_15pct',  label: 'EPS 3Y CAGR ≥ 15%',     short: 'EPS 3Y',     group: 'eps' },
  { id: 'rev_3y_ge_15pct',  label: 'Revenue 3Y CAGR ≥ 15%', short: 'Rev 3Y',     group: 'rev' },
  { id: 'eps_acc_fy',       label: 'EPS Accelerating (FY)', short: 'EPS Acc FY', group: 'eps' },
  { id: 'rev_acc_fy',       label: 'Revenue Accel (FY)',    short: 'Rev Acc FY', group: 'rev' },
]

type InspectorSeed = { passCount: number; passedConditions: string[] }
type InspectorState = { symbol: string; seed?: InspectorSeed }

function boolMark(v: boolean | undefined | null): ReactNode {
  if (v === undefined || v === null) return <span className="ssp-pill ssp-pill--na">—</span>
  return <span className={`ssp-pill ssp-pill--sm ${v ? 'ssp-pill--pass' : 'ssp-pill--fail'}`}>{v ? '✓' : '✗'}</span>
}

export function StockScreenerPage({ onBreadcrumbResearch, breadcrumbLabel = 'Stock Screener' }: StockScreenerPageProps) {
  const [symbolText, setSymbolText] = useState('AAPL,MSFT,NVDA,AMZN')

  // ── Right-hand Stock inspector ──────────────────────────────────────────
  const [inspector, setInspector] = useState<InspectorState | null>(null)

  const openInspector = useCallback((symbol: string, seed?: InspectorSeed) => {
    const sym = (symbol || '').trim().toUpperCase()
    if (!sym) return
    setInspector((prev) => (prev?.symbol === sym ? null : { symbol: sym, seed }))
  }, [])
  const closeInspector = useCallback(() => setInspector(null), [])

  // ── Fundamental Distribution (top-left card) ────────────────────────────
  const [criteriaStats, setCriteriaStats] = useState<SepaCriteriaStats | null>(null)
  const [criteriaLoading, setCriteriaLoading] = useState(false)
  const [criteriaErr, setCriteriaErr] = useState<string | null>(null)
  const [expandedDistBucket, setExpandedDistBucket] = useState<number | null>(null)
  const [distSymbolsCache, setDistSymbolsCache] = useState<
    Map<number, { loading: boolean; symbols: FundDistSymbolRow[]; error: string | null }>
  >(new Map())

  const loadCriteriaStats = useCallback(async () => {
    setCriteriaLoading(true)
    setCriteriaErr(null)
    try {
      const res = await fetchSepaCriteriaStats()
      if (!res.ok) throw new Error(res.error ?? 'Failed')
      setCriteriaStats(res)
    } catch (e) {
      setCriteriaErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setCriteriaLoading(false)
    }
  }, [])

  useEffect(() => { void loadCriteriaStats() }, [loadCriteriaStats])

  // ── Filter by Conditions (top-middle card) ──────────────────────────────
  const [condFilter, setCondFilter] = useState<Set<string>>(new Set())
  const [condResult, setCondResult] = useState<FundDistSymbolRow[] | null>(null)
  const [condResultCount, setCondResultCount] = useState<number | null>(null)
  const [condResultTruncated, setCondResultTruncated] = useState(false)
  const [condFilterLoading, setCondFilterLoading] = useState(false)
  const [condFilterError, setCondFilterError] = useState<string | null>(null)
  const condFilterKey = useMemo(() => Array.from(condFilter).sort().join(','), [condFilter])

  useEffect(() => {
    if (condFilter.size === 0) {
      setCondResult(null)
      setCondResultCount(null)
      setCondResultTruncated(false)
      setCondFilterError(null)
      return
    }
    let cancelled = false
    setCondFilterLoading(true)
    setCondFilterError(null)
    const include = Array.from(condFilter)
    const handle = window.setTimeout(() => {
      fetchFundamentalFilter({ include, limit: 1000 })
        .then((res) => {
          if (cancelled) return
          if (!res.ok) {
            setCondResult([])
            setCondResultCount(0)
            setCondResultTruncated(false)
            setCondFilterError(res.error ?? 'Failed')
            return
          }
          const syms = res.symbols ?? []
          setCondResult(syms)
          setCondResultCount(typeof res.count === 'number' ? res.count : syms.length)
          setCondResultTruncated(syms.length >= (res.limit ?? 1000))
        })
        .catch((e) => {
          if (!cancelled) setCondFilterError(e instanceof Error ? e.message : 'Network error')
        })
        .finally(() => {
          if (!cancelled) setCondFilterLoading(false)
        })
    }, 180)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [condFilter, condFilterKey])

  const toggleCondFilter = useCallback((id: string) => {
    setCondFilter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])
  const clearCondFilter = useCallback(() => setCondFilter(new Set()), [])

  // ── Symbols & readiness-driven main table (top-right + below) ───────────
  const [loadedFromDist, setLoadedFromDist] = useState<FundDistSymbolRow[]>([])
  const [loadedFromBucket, setLoadedFromBucket] = useState<number | null>(null)
  const symbols = useMemo(() => parseSymbols(symbolText), [symbolText])
  const symbolsKey = useMemo(() => symbols.join(','), [symbols])

  const [readinessRows, setReadinessRows] = useState<ReadinessSnapshotRow[]>([])
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [readinessError, setReadinessError] = useState<string | null>(null)
  const [readinessAsOf, setReadinessAsOf] = useState<string | null>(null)

  useEffect(() => {
    if (symbols.length === 0) {
      setReadinessRows([])
      setReadinessAsOf(null)
      setReadinessError(null)
      return
    }
    let cancelled = false
    setReadinessLoading(true)
    setReadinessError(null)
    const handle = window.setTimeout(() => {
      fetchSymbolsReadinessSnapshot(symbols)
        .then((res) => {
          if (cancelled) return
          if (!res.ok) {
            setReadinessRows([])
            setReadinessAsOf(null)
            setReadinessError(res.error ?? 'Failed')
            return
          }
          setReadinessRows(res.symbols ?? [])
          setReadinessAsOf(res.as_of_date ?? null)
        })
        .catch((e) => {
          if (!cancelled) setReadinessError(e instanceof Error ? e.message : 'Network error')
        })
        .finally(() => {
          if (!cancelled) setReadinessLoading(false)
        })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
    // symbolsKey is the canonical dependency; including `symbols` for ESLint exhaustive-deps.
  }, [symbolsKey, symbols])

  const applyDistSymbolsToScreener = useCallback((syms: FundDistSymbolRow[], bucketN: number | null) => {
    if (syms.length === 0) return
    setLoadedFromDist(syms)
    setLoadedFromBucket(bucketN)
    setSymbolText(syms.map((s) => s.symbol).join(','))
  }, [])

  const handleBucketClick = useCallback((n: number, count: number) => {
    if (count === 0) return
    const isExpanding = expandedDistBucket !== n
    setExpandedDistBucket(isExpanding ? n : null)
    if (!isExpanding) return

    const cached = distSymbolsCache.get(n)
    if (cached && !cached.loading && !cached.error) {
      applyDistSymbolsToScreener(cached.symbols, n)
      return
    }
    setDistSymbolsCache((prev) => new Map(prev).set(n, { loading: true, symbols: [], error: null }))
    fetchFundamentalDistributionSymbols(n).then((res) => {
      const syms = res.ok ? res.symbols : []
      setDistSymbolsCache((prev) =>
        new Map(prev).set(n, {
          loading: false,
          symbols: syms,
          error: res.ok ? null : (res.error ?? 'Failed'),
        }),
      )
      if (res.ok) applyDistSymbolsToScreener(syms, n)
    })
  }, [expandedDistBucket, distSymbolsCache, applyDistSymbolsToScreener])

  // Summary derived from readiness rows
  const summary = useMemo(() => {
    if (readinessRows.length === 0) return null
    const found = readinessRows.filter((r) => r.found)
    const fundPass = found.filter((r) => (r.fundamental_pass_count ?? 0) === 8).length
    const insuff = found.filter((r) => r.fundamental_insufficient).length
    return {
      total: readinessRows.length,
      found: found.length,
      fundPass,
      insufficient: insuff,
    }
  }, [readinessRows])

  // Fundamental distribution data prep
  const dist = criteriaStats?.fundamental?.pass_count_distribution ?? null
  const distMaxCount = dist ? Math.max(...dist.map((d) => d.symbol_count), 1) : 1
  const distBase = dist ? dist.reduce((s, d) => s + d.symbol_count, 0) || 1 : 1
  const barColorForN = (n: number) =>
    n === 8 ? 'ssp-dist-bar-fill--ok'
    : n >= 6  ? 'ssp-dist-bar-fill--good'
    : n >= 4  ? 'ssp-dist-bar-fill--warn'
    : n >= 2  ? 'ssp-dist-bar-fill--poor'
    :           'ssp-dist-bar-fill--error'

  return (
    <div className="card process-section stock-screener-page wl2 ssp-page">
      <div className="research-page-head">
        <SectionPageTitle
          menu="Research"
          pageTitle={breadcrumbLabel}
          onMenuClick={onBreadcrumbResearch}
          menuNavigateAriaLabel="Go to Research home"
          infoText="Discover symbols by SEPA fundamental conditions and inspect their daily readiness snapshot. All calculations come from the unified Stock Data Readiness pipeline; this page only filters and views."
          style={{ margin: 0 }}
        />
      </div>

      {/* Top: 3-column equal grid (Fund Dist · Filter Cond · Symbols) */}
      <div className="ssp-top-grid ssp-top-grid--triple">
        {/* ── Card 1: Fundamental Distribution ───────────────────────────── */}
        <section className="ssp-card">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title">
              Fundamental Distribution
              <span className="ssp-card-title-aux">conditions passed</span>
            </h3>
            <button
              type="button"
              className="ssp-btn ssp-btn--ghost"
              onClick={() => void loadCriteriaStats()}
              disabled={criteriaLoading}
              title="Refresh distribution"
            >
              {criteriaLoading ? '…' : '↻'}
            </button>
          </header>

          <div className="ssp-dist-body">
            {criteriaErr && <div className="ssp-empty-line ssp-status-err">{criteriaErr}</div>}
            {dist ? (
              <>
                <div className="ssp-dist-hint">Click a row to load that bucket's symbols.</div>
                <div className="ssp-dist-rows">
                  {dist.map(({ conditions_passed, symbol_count }) => {
                    const widthPct = Math.round(symbol_count / distMaxCount * 100)
                    const sharePct = Math.round(symbol_count / distBase * 100)
                    const isExpanded = expandedDistBucket === conditions_passed
                    const bucketData = distSymbolsCache.get(conditions_passed)
                    const isClickable = symbol_count > 0
                    return (
                      <div key={conditions_passed}>
                        <div
                          className={`ssp-dist-row${isClickable ? ' ssp-dist-row--clickable' : ''}${isExpanded ? ' ssp-dist-row--expanded' : ''}`}
                          onClick={() => handleBucketClick(conditions_passed, symbol_count)}
                          role={isClickable ? 'button' : undefined}
                          tabIndex={isClickable ? 0 : undefined}
                          onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') handleBucketClick(conditions_passed, symbol_count) } : undefined}
                          title={isClickable ? `Click to load ${symbol_count} symbols` : undefined}
                        >
                          <span className={`ssp-dist-label${conditions_passed === 8 ? ' ssp-dist-label--full' : ''}`}>
                            {conditions_passed === 8 ? '8/8 ★' : `${conditions_passed}/8`}
                            {isClickable && <span className="ssp-dist-chevron">{isExpanded ? ' ▴' : ' ▾'}</span>}
                          </span>
                          <div className="ssp-dist-bar">
                            <div
                              className={`ssp-dist-bar-fill ${barColorForN(conditions_passed)}`}
                              style={{ width: `${widthPct}%` }}
                            />
                          </div>
                          <span className="ssp-dist-stat">
                            {symbol_count.toLocaleString()}
                            <span className="ssp-dist-stat-sub">({sharePct}%)</span>
                          </span>
                        </div>
                        {isExpanded && (
                          <div className="ssp-dist-syms">
                            {bucketData?.loading && <span className="ssp-empty-line">Loading symbols…</span>}
                            {bucketData?.error && <span className="ssp-empty-line ssp-status-err">{bucketData.error}</span>}
                            {bucketData && !bucketData.loading && !bucketData.error && (
                              <div className="ssp-dist-syms-chips">
                                {bucketData.symbols.map((s) => (
                                  <span
                                    key={s.symbol}
                                    className="ssp-dist-chip"
                                    title={`${s.symbol} — ${s.pass_count}/8 · click to view detail`}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      openInspector(s.symbol, {
                                        passCount: s.pass_count,
                                        passedConditions: s.passed_conditions,
                                      })
                                    }}
                                  >
                                    {s.symbol}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              !criteriaLoading && <div className="ssp-empty-line">No distribution data.</div>
            )}
          </div>
        </section>

        {/* ── Card 2: Filter by Conditions ────────────────────────────────── */}
        <section className="ssp-card">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title">
              Filter by Conditions
              <span className="ssp-card-title-aux">AND across 8 SEPA</span>
            </h3>
            {condFilter.size > 0 && (
              <button
                type="button"
                className="ssp-btn ssp-btn--ghost ssp-cond-filter-clear"
                onClick={clearCondFilter}
                title="Clear all condition filters"
              >
                Clear
              </button>
            )}
          </header>

          <div className="ssp-cond-filter-hint">
            {condFilter.size === 0
              ? 'Click any condition to find symbols that pass it.'
              : `${condFilter.size} selected${
                  condFilterLoading
                    ? ' · loading…'
                    : condResultCount != null
                      ? ` · ${condResultCount.toLocaleString()} match${condResultCount === 1 ? '' : 'es'}${condResultTruncated ? '+' : ''}`
                      : ''
                }`}
          </div>

          <div className="ssp-cond-filter-chips">
            {SEPA_COND_CATALOG.map(({ id, label, group }) => {
              const active = condFilter.has(id)
              return (
                <button
                  key={id}
                  type="button"
                  className={`ssp-cond-chip ssp-cond-chip--${group}${active ? ' ssp-cond-chip--active' : ''}`}
                  onClick={() => toggleCondFilter(id)}
                  title={active ? `Remove ${label} from filter` : `Add ${label} to filter`}
                >
                  <span className="ssp-cond-chip-check" aria-hidden>
                    {active ? '✓' : ''}
                  </span>
                  <span className="ssp-cond-chip-label">{label}</span>
                </button>
              )
            })}
          </div>

          {condFilter.size > 0 && (
            <div className="ssp-cond-filter-result">
              {condFilterError && <div className="ssp-empty-line ssp-status-err">{condFilterError}</div>}
              {!condFilterError && condResult && condResult.length === 0 && !condFilterLoading && (
                <div className="ssp-empty-line">No symbols match all selected conditions.</div>
              )}
              {!condFilterError && condResult && condResult.length > 0 && (
                <>
                  <div className="ssp-cond-result-chips">
                    {condResult.map((s) => (
                      <span
                        key={s.symbol}
                        className="ssp-dist-chip"
                        title={`${s.symbol} — ${s.pass_count}/8 · click to open inspector`}
                        onClick={() =>
                          openInspector(s.symbol, {
                            passCount: s.pass_count,
                            passedConditions: s.passed_conditions,
                          })
                        }
                      >
                        {s.symbol}
                        <span className="ssp-cond-result-frac">{s.pass_count}/8</span>
                      </span>
                    ))}
                  </div>
                  {condResultTruncated && (
                    <div className="ssp-empty-line">
                      Showing first {condResult.length.toLocaleString()} matches (limit reached).
                    </div>
                  )}
                  <div className="ssp-cond-result-actions">
                    <button
                      type="button"
                      className="ssp-btn ssp-btn--secondary"
                      onClick={() => applyDistSymbolsToScreener(condResult, null)}
                      title="Replace the Symbols input with these matches"
                    >
                      Load into Screener
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </section>

        {/* ── Card 3: Symbols (input + summary) ──────────────────────────── */}
        <section className="ssp-card">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title">
              Symbols
              <span className="ssp-card-title-aux">
                {readinessAsOf ? `as-of ${readinessAsOf}` : 'live readiness'}
              </span>
            </h3>
            {readinessLoading && <span className="ssp-loaded-sub">Loading…</span>}
          </header>

          <div className="ssp-input-block">
            <textarea
              className="ssp-symbols-textarea"
              rows={5}
              value={symbolText}
              onChange={(e) => setSymbolText(e.target.value)}
              placeholder="AAPL,MSFT,NVDA"
            />
            <div className="ssp-symbols-meta">
              <span>
                Parsed: <strong style={{ color: 'var(--color-text-main)' }}>{symbols.length}</strong>
              </span>
              {summary && (
                <span className="ssp-symbols-summary">
                  <span>Found <strong>{summary.found}</strong>/<strong>{summary.total}</strong></span>
                  <span className="ssp-results-summary-good"> · 8/8 <strong>{summary.fundPass}</strong></span>
                  {summary.insufficient > 0 && (
                    <span className="ssp-results-summary-warn"> · insuff <strong>{summary.insufficient}</strong></span>
                  )}
                </span>
              )}
            </div>
            {readinessError && <div className="ssp-empty-line ssp-status-err">{readinessError}</div>}
          </div>
        </section>
      </div>

      {/* Loaded-from chips */}
      {loadedFromDist.length > 0 && (
        <div className="ssp-loaded-strip">
          <div className="ssp-loaded-meta">
            <span className="ssp-loaded-title">
              Loaded from{' '}
              {loadedFromBucket == null
                ? <span style={{ color: 'var(--color-accent)' }}>condition filter</span>
                : loadedFromBucket === 8
                  ? <span style={{ color: 'var(--color-success)' }}>8/8 ★</span>
                  : `${loadedFromBucket}/8`}
            </span>
            <span className="ssp-loaded-sub">
              {loadedFromDist.length} symbol{loadedFromDist.length !== 1 ? 's' : ''} · click chip for detail
            </span>
          </div>
          <div className="ssp-loaded-chips">
            {loadedFromDist.map((s) => (
              <span
                key={s.symbol}
                className={`ssp-loaded-chip${inspector?.symbol === s.symbol ? ' ssp-loaded-chip--active' : ''}`}
                onClick={() => openInspector(s.symbol, {
                  passCount: s.pass_count,
                  passedConditions: s.passed_conditions,
                })}
                title={`${s.symbol} — ${s.pass_count}/8 conditions passed`}
              >
                {s.symbol}
                <span className="ssp-loaded-chip-frac">{s.pass_count}/8</span>
              </span>
            ))}
          </div>
          <div className="ssp-loaded-actions">
            <button
              type="button"
              className="ssp-btn ssp-btn--ghost"
              onClick={() => { setLoadedFromDist([]); setLoadedFromBucket(null) }}
              title="Clear loaded symbols"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Results — readiness-driven */}
      <section className="ssp-card">
        <header className="ssp-card-head ssp-card-head--tight">
          <h3 className="ssp-card-title">
            Results
            {readinessRows.length > 0 && <span className="ssp-card-title-aux">{readinessRows.length} shown · readiness snapshot</span>}
          </h3>
        </header>

        <div className="ssp-table-wrap">
          <table className="ssp-table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Symbol</th>
                <th style={{ width: 70 }}>Fund</th>
                <th>Conditions</th>
                <th style={{ width: 70, textAlign: 'center' }}>Univ</th>
                <th style={{ width: 100 }}>Price</th>
                <th style={{ width: 150 }}>Statements</th>
                <th style={{ width: 90 }}>Short</th>
                <th style={{ width: 100 }}>As-of</th>
              </tr>
            </thead>
            <tbody>
              {readinessRows.length === 0 && (
                <tr className="ssp-table-empty">
                  <td colSpan={8}>
                    {readinessLoading
                      ? 'Loading readiness for parsed symbols…'
                      : symbols.length === 0
                        ? 'No symbols yet. Click a Fundamental Distribution bucket, use Filter by Conditions, or paste symbols above.'
                        : readinessError
                          ? 'Failed to load readiness — see error above.'
                          : 'No readiness rows.'}
                  </td>
                </tr>
              )}
              {readinessRows.map((r) => {
                if (!r.found) {
                  return (
                    <tr key={r.symbol} className="ssp-row-missing">
                      <td>
                        <button
                          type="button"
                          className="ssp-sym-open"
                          onClick={() => openInspector(r.symbol)}
                          title={`Open ${r.symbol} inspector`}
                        >
                          {r.symbol}
                        </button>
                      </td>
                      <td colSpan={7} className="ssp-num--dim">
                        No row in stock_readiness_daily — run the universe snapshot from Stock Data Readiness.
                      </td>
                    </tr>
                  )
                }
                const passed = new Set(r.passed_conditions ?? [])
                const insuf = r.fundamental_insufficient ?? false
                const passCount = r.fundamental_pass_count ?? 0
                const fundCls =
                  insuf ? 'ssp-fund-cell--insuf'
                  : passCount === 8 ? 'ssp-fund-cell--all'
                  : passCount >= 5 ? 'ssp-fund-cell--good'
                  : passCount >= 2 ? 'ssp-fund-cell--warn'
                  : 'ssp-fund-cell--poor'
                const isActive = inspector?.symbol === r.symbol
                const seed: InspectorSeed = {
                  passCount,
                  passedConditions: Array.from(passed),
                }
                return (
                  <tr key={r.symbol} className={isActive ? 'ssp-row-active' : ''}>
                    <td>
                      <button
                        type="button"
                        className="ssp-sym-open"
                        onClick={() => openInspector(r.symbol, seed)}
                        title={isActive ? 'Close inspector' : `Open ${r.symbol} inspector`}
                      >
                        {r.symbol}
                      </button>
                    </td>
                    <td>
                      <span
                        className={`ssp-fund-cell ${fundCls}`}
                        title={insuf ? 'Insufficient data' : `${passCount}/8 conditions passed`}
                      >
                        {insuf ? 'INS' : `${passCount}/8`}
                      </span>
                    </td>
                    <td>
                      <div className="ssp-cond-dots">
                        {SEPA_COND_CATALOG.map(({ id, short, group }) => {
                          const pass = passed.has(id)
                          return (
                            <span
                              key={id}
                              className={`ssp-cond-dot ssp-cond-dot--${group}${pass ? ' ssp-cond-dot--pass' : ' ssp-cond-dot--fail'}${insuf ? ' ssp-cond-dot--dim' : ''}`}
                              title={`${short}: ${insuf ? 'insufficient' : pass ? 'pass' : 'fail'}`}
                            >
                              {pass ? '✓' : ''}
                            </span>
                          )
                        })}
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>{boolMark(r.included_in_universe)}</td>
                    <td>
                      <span className="ssp-data-pair">
                        {boolMark(r.price_ready)}
                        <span className="ssp-num--dim">{(r.bar_count_lookback ?? 0).toLocaleString()}b</span>
                      </span>
                    </td>
                    <td>
                      <div className="ssp-stmt-row">
                        <span
                          className={`ssp-stmt-chip${r.income_stmt_ready ? ' ssp-stmt-chip--ok' : ''}`}
                          title={`Income: ${r.income_stmt_q_count ?? 0}Q · ${r.income_stmt_a_count ?? 0}A`}
                        >IS</span>
                        <span className={`ssp-stmt-chip${r.balance_sheet_present ? ' ssp-stmt-chip--ok' : ''}`} title="Balance Sheet">BS</span>
                        <span className={`ssp-stmt-chip${r.cash_flow_present ? ' ssp-stmt-chip--ok' : ''}`} title="Cash Flow">CF</span>
                        <span className={`ssp-stmt-chip${r.ratios_present ? ' ssp-stmt-chip--ok' : ''}`} title="Ratios">RT</span>
                      </div>
                    </td>
                    <td>
                      <div className="ssp-stmt-row">
                        <span className={`ssp-stmt-chip${r.short_interest_present ? ' ssp-stmt-chip--ok' : ''}`} title="Short Interest">SI</span>
                        <span className={`ssp-stmt-chip${r.short_volume_present ? ' ssp-stmt-chip--ok' : ''}`} title="Short Volume">SV</span>
                      </div>
                    </td>
                    <td className="ssp-num ssp-num--dim">{r.as_of_date ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Shared right-hand Stock inspector (same component used on Positions). */}
      <RightInspectorDrawer open={inspector != null} ariaLabel="Stock detail">
        {inspector && (
          <StockInspectorPanel
            symbol={inspector.symbol}
            fundamentalSeed={inspector.seed}
            onClose={closeInspector}
          />
        )}
      </RightInspectorDrawer>
    </div>
  )
}
