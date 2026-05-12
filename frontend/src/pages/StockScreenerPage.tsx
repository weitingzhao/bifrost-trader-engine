import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { RightInspectorDrawer } from '../components/RightInspectorDrawer'
import { StockInspectorPanel } from '../components/StockInspectorPanel'
import {
  fetchSepaCriteriaStats,
  fetchFundamentalDistributionSymbols,
  fetchTechnicalDistributionSymbols,
  fetchFundamentalFilter,
  fetchTechnicalFilter,
  fetchSymbolsReadinessSnapshot,
  type SepaCriteriaStats,
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
const FUND_GROUP_LABELS: Record<string, string> = {
  eps: 'EPS',
  rev: 'Revenue',
}
const EXT_GROUP_LABELS: Record<string, string> = {
  quality:       'Quality',
  balance:       'Balance Sheet',
  cashflow:      'Cash Flow',
  valuation:     'Valuation',
  profitability: 'Profitability',
  efficiency:    'Efficiency',
  sentiment:     'Sentiment',
}
const TECH_GROUP_LABELS: Record<string, string> = {
  vol:     'Volume / Momentum',
  price52: '52-Week Range',
  sma:     'SMA Slope',
  price:   'Price Position',
}

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

const EXT_COND_CATALOG: { id: string; label: string; short: string; group: string }[] = [
  { id: 'gross_margin_ge_30pct',     label: 'Gross Margin ≥ 30%',        short: 'GM≥30',    group: 'quality' },
  { id: 'operating_margin_ge_10pct', label: 'Oper. Margin ≥ 10%',        short: 'OM≥10',    group: 'quality' },
  { id: 'net_margin_ge_5pct',        label: 'Net Margin ≥ 5%',           short: 'NM≥5',     group: 'quality' },
  { id: 'ocf_to_ni_ge_0_7',          label: 'OCF/NI ≥ 0.7',             short: 'OCF/NI',   group: 'quality' },
  { id: 'interest_coverage_ge_5x',   label: 'Interest Coverage ≥ 5×',    short: 'IC≥5',     group: 'quality' },
  { id: 'current_ratio_ge_1_5',      label: 'Current Ratio ≥ 1.5',       short: 'CR≥1.5',   group: 'balance' },
  { id: 'quick_ratio_ge_1_0',        label: 'Quick Ratio ≥ 1.0',         short: 'QR≥1',     group: 'balance' },
  { id: 'debt_to_equity_le_1',       label: 'D/E ≤ 1.0',                short: 'D/E≤1',    group: 'balance' },
  { id: 'net_debt_to_ebitda_le_3',   label: 'NetDebt/EBITDA ≤ 3',        short: 'ND/EB≤3',  group: 'balance' },
  { id: 'fcf_positive',              label: 'FCF Positive',              short: 'FCF>0',    group: 'cashflow' },
  { id: 'fcf_margin_ge_5pct',        label: 'FCF Margin ≥ 5%',           short: 'FCFm≥5',   group: 'cashflow' },
  { id: 'fcf_yield_ge_3pct',         label: 'FCF Yield ≥ 3%',            short: 'FCFy≥3',   group: 'cashflow' },
  { id: 'capex_intensity_le_15pct',  label: 'CapEx ≤ 15%',               short: 'CpX≤15',   group: 'cashflow' },
  { id: 'pe_le_60',                  label: 'P/E ≤ 60',                  short: 'PE≤60',    group: 'valuation' },
  { id: 'ps_le_15',                  label: 'P/S ≤ 15',                  short: 'PS≤15',    group: 'valuation' },
  { id: 'pb_le_8',                   label: 'P/B ≤ 8',                   short: 'PB≤8',     group: 'valuation' },
  { id: 'ev_to_ebitda_le_30',        label: 'EV/EBITDA ≤ 30',            short: 'EVEB≤30',  group: 'valuation' },
  { id: 'roe_ge_15pct',              label: 'ROE ≥ 15%',                 short: 'ROE≥15',   group: 'profitability' },
  { id: 'roa_ge_5pct',               label: 'ROA ≥ 5%',                  short: 'ROA≥5',    group: 'profitability' },
  { id: 'asset_turnover_ge_0_5',     label: 'Asset Turnover ≥ 0.5',      short: 'AT≥0.5',   group: 'efficiency' },
  { id: 'dso_le_75_days',            label: 'DSO ≤ 75 days',             short: 'DSO≤75',   group: 'efficiency' },
  { id: 'dio_le_120_days',           label: 'DIO ≤ 120 days',            short: 'DIO≤120',  group: 'efficiency' },
  { id: 'days_to_cover_le_5',                   label: 'Days to Cover ≤ 5',    short: 'DtC≤5',    group: 'sentiment' },
  { id: 'short_volume_ratio_recent_le_30pct',   label: 'Short Vol Ratio ≤ 30%', short: 'SVR≤30',   group: 'sentiment' },
  { id: 'short_interest_pct_of_float_le_15pct', label: 'SI % Float ≤ 15%',      short: 'SI%≤15',   group: 'sentiment' },
]

/** 11 SEPA technical conditions in display order (matches _TECH_COND_IDS on backend). */
const TECH_COND_CATALOG: { id: string; label: string; short: string; group: 'vol' | 'price52' | 'sma' | 'price' }[] = [
  { id: 'avg_volume_50_gt_threshold', label: 'Avg Volume 50D > 100K',   short: 'Vol',       group: 'vol' },
  { id: 'crs_ge_70',                  label: 'CRS ≥ 70',                short: 'CRS',       group: 'vol' },
  { id: 'close_ge_low52_x_1_3',       label: 'Close ≥ Low52W × 1.3',   short: '≥L52×1.3',  group: 'price52' },
  { id: 'close_ge_high52_x_0_75',     label: 'Close ≥ High52W × 0.75', short: '≥H52×0.75', group: 'price52' },
  { id: 'sma50_gt_sma150',            label: 'SMA50 > SMA150',          short: '50>150',     group: 'sma' },
  { id: 'sma50_gt_sma200',            label: 'SMA50 > SMA200',          short: '50>200',     group: 'sma' },
  { id: 'sma150_gt_sma200',           label: 'SMA150 > SMA200',         short: '150>200',    group: 'sma' },
  { id: 'sma200_rising_1m',           label: 'SMA200 Rising (1M)',       short: '200↑',       group: 'sma' },
  { id: 'price_gt_sma50',             label: 'Price > SMA50',            short: 'P>50',       group: 'price' },
  { id: 'price_gt_sma150',            label: 'Price > SMA150',           short: 'P>150',      group: 'price' },
  { id: 'price_gt_sma200',            label: 'Price > SMA200',           short: 'P>200',      group: 'price' },
]

type InspectorSeed = { passCount: number; passedConditions: string[] }
type InspectorState = { symbol: string; seed?: InspectorSeed }

function boolMark(v: boolean | undefined | null): ReactNode {
  if (v === undefined || v === null) return <span className="ssp-pill ssp-pill--na">—</span>
  return <span className={`ssp-pill ssp-pill--sm ${v ? 'ssp-pill--pass' : 'ssp-pill--fail'}`}>{v ? '✓' : '✗'}</span>
}

export function StockScreenerPage({ onBreadcrumbResearch, breadcrumbLabel = 'Stock Screener' }: StockScreenerPageProps) {
  const [symbolText, setSymbolText] = useState('')

  // ── Right-hand Stock inspector ──────────────────────────────────────────
  const [inspector, setInspector] = useState<InspectorState | null>(null)

  const openInspector = useCallback((symbol: string, seed?: InspectorSeed) => {
    const sym = (symbol || '').trim().toUpperCase()
    if (!sym) return
    setInspector((prev) => (prev?.symbol === sym ? null : { symbol: sym, seed }))
  }, [])
  const closeInspector = useCallback(() => setInspector(null), [])

  // ── Fundamental & Technical Distribution (top two cards) ────────────────
  const [criteriaStats, setCriteriaStats] = useState<SepaCriteriaStats | null>(null)
  const [criteriaLoading, setCriteriaLoading] = useState(false)
  const [criteriaErr, setCriteriaErr] = useState<string | null>(null)

  // Fundamental distribution — active bucket
  const [activeBucket, setActiveBucket] = useState<number | null>(null)
  const [bucketLoading, setBucketLoading] = useState(false)
  const [bucketLoadedCount, setBucketLoadedCount] = useState<number | null>(null)
  const [bucketError, setBucketError] = useState<string | null>(null)
  const distCacheRef = useRef<Map<number, string[]>>(new Map())

  // Technical distribution — active bucket
  const [activeTechBucket, setActiveTechBucket] = useState<number | null>(null)
  const [techBucketLoading, setTechBucketLoading] = useState(false)
  const [techBucketLoadedCount, setTechBucketLoadedCount] = useState<number | null>(null)
  const [techBucketError, setTechBucketError] = useState<string | null>(null)
  const techDistCacheRef = useRef<Map<number, string[]>>(new Map())

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

  // ── Condition filter chips (no auto-fetch; triggered by Apply Filter button) ──
  const [condFilter, setCondFilter] = useState<Set<string>>(new Set())
  const [techCondFilter, setTechCondFilter] = useState<Set<string>>(new Set())

  const toggleCondFilter = useCallback((id: string) => {
    setCondFilter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setFilterPreview(null)
    setFilterError(null)
  }, [])
  const clearCondFilter = useCallback(() => { setCondFilter(new Set()); setFilterPreview(null) }, [])

  const toggleTechCondFilter = useCallback((id: string) => {
    setTechCondFilter((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setFilterPreview(null)
    setFilterError(null)
  }, [])
  const clearTechCondFilter = useCallback(() => { setTechCondFilter(new Set()); setFilterPreview(null) }, [])

  // ── Apply Filter — two-step: 1) preview count  2) apply to Symbols/Results ──
  const [filterLoading, setFilterLoading] = useState(false)
  const [filterError, setFilterError] = useState<string | null>(null)
  // Preview state: pending symbols ready to be applied
  const [filterPreview, setFilterPreview] = useState<{ symbols: string[]; parts: string } | null>(null)

  /** Step 1: fetch count/symbols and show preview without pushing to Results yet */
  const previewFilter = useCallback(async () => {
    const fundActive = condFilter.size > 0
    const techActive = techCondFilter.size > 0
    if (!fundActive && !techActive) return
    setFilterLoading(true)
    setFilterError(null)
    setFilterPreview(null)
    try {
      let fundSyms: string[] | null = null
      let techSyms: string[] | null = null
      if (fundActive) {
        const res = await fetchFundamentalFilter({ include: Array.from(condFilter), limit: 2000 })
        if (!res.ok) throw new Error(res.error ?? 'Fundamental filter failed')
        fundSyms = (res.symbols ?? []).map((s) => s.symbol)
      }
      if (techActive) {
        const res = await fetchTechnicalFilter({ include: Array.from(techCondFilter), limit: 2000 })
        if (!res.ok) throw new Error(res.error ?? 'Technical filter failed')
        techSyms = (res.symbols ?? []).map((s) => s.symbol)
      }
      let result: string[]
      if (fundSyms && techSyms) {
        const ts = new Set(techSyms)
        result = fundSyms.filter((s) => ts.has(s))
      } else {
        result = fundSyms ?? techSyms ?? []
      }
      const parts = [
        fundActive && `${condFilter.size}F`,
        techActive && `${techCondFilter.size}T`,
      ].filter(Boolean).join(' ∩ ')
      setFilterPreview({ symbols: result, parts })
    } catch (e) {
      setFilterError(e instanceof Error ? e.message : 'Filter failed')
    } finally {
      setFilterLoading(false)
    }
  }, [condFilter, techCondFilter])

  /** Step 2: push previewed symbols to Symbols / Results */
  const applyFilter = useCallback(() => {
    if (!filterPreview) return
    setActiveBucket(null)
    setActiveTechBucket(null)
    setSymbolText(filterPreview.symbols.join(','))
  }, [filterPreview])

  // ── Results table sort state ────────────────────────────────────────────
  const [sortCol, setSortCol] = useState<'tech' | 'fund' | null>(null)
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const toggleSort = useCallback((col: 'tech' | 'fund') => {
    setSortCol((prev) => {
      if (prev === col) {
        setSortDir((d) => d === 'desc' ? 'asc' : 'desc')
        return col
      }
      setSortDir('desc')
      return col
    })
  }, [])

  // ── Symbols & readiness-driven main table ───────────────────────────────
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

  const handleBucketClick = useCallback((n: number, count: number) => {
    if (count === 0) return
    const isActivating = activeBucket !== n
    setActiveBucket(isActivating ? n : null)
    // Deactivate technical bucket when fundamental is clicked
    setActiveTechBucket(null)
    if (!isActivating) return

    const cached = distCacheRef.current.get(n)
    if (cached) {
      setSymbolText(cached.join(','))
      setBucketLoadedCount(cached.length)
      setBucketError(null)
      return
    }
    setBucketLoading(true)
    setBucketError(null)
    setBucketLoadedCount(null)
    fetchFundamentalDistributionSymbols(n).then((res) => {
      setBucketLoading(false)
      if (!res.ok) {
        setBucketError(res.error ?? 'Failed')
        return
      }
      const syms = (res.symbols ?? []).map((s) => s.symbol)
      distCacheRef.current.set(n, syms)
      setSymbolText(syms.join(','))
      setBucketLoadedCount(syms.length)
    })
  }, [activeBucket])

  const handleTechBucketClick = useCallback((n: number, count: number) => {
    if (count === 0) return
    const isActivating = activeTechBucket !== n
    setActiveTechBucket(isActivating ? n : null)
    // Deactivate fundamental bucket when technical is clicked
    setActiveBucket(null)
    if (!isActivating) return

    const cached = techDistCacheRef.current.get(n)
    if (cached) {
      setSymbolText(cached.join(','))
      setTechBucketLoadedCount(cached.length)
      setTechBucketError(null)
      return
    }
    setTechBucketLoading(true)
    setTechBucketError(null)
    setTechBucketLoadedCount(null)
    fetchTechnicalDistributionSymbols(n).then((res) => {
      setTechBucketLoading(false)
      if (!res.ok) {
        setTechBucketError(res.error ?? 'Failed')
        return
      }
      const syms = (res.symbols ?? []).map((s) => s.symbol)
      techDistCacheRef.current.set(n, syms)
      setSymbolText(syms.join(','))
      setTechBucketLoadedCount(syms.length)
    })
  }, [activeTechBucket])

  // Sorted rows for display
  const sortedRows = useMemo(() => {
    if (!sortCol) return readinessRows
    return [...readinessRows].sort((a, b) => {
      const va = sortCol === 'tech' ? (a.technical_pass_count ?? -1) : (a.fundamental_pass_count ?? -1)
      const vb = sortCol === 'tech' ? (b.technical_pass_count ?? -1) : (b.fundamental_pass_count ?? -1)
      return sortDir === 'desc' ? vb - va : va - vb
    })
  }, [readinessRows, sortCol, sortDir])

  // Summary derived from readiness rows
  const summary = useMemo(() => {
    if (readinessRows.length === 0) return null
    const found = readinessRows.filter((r) => r.found)
    const fundPass = found.filter((r) => (r.fundamental_pass_count ?? 0) === 8).length
    const techPass = found.filter((r) => r.technical_pass === true).length
    const insuff = found.filter((r) => r.fundamental_insufficient).length
    return {
      total: readinessRows.length,
      found: found.length,
      fundPass,
      techPass,
      insufficient: insuff,
    }
  }, [readinessRows])

  // Fundamental distribution — sorted by conditions_passed DESC (funnel: most conditions at top)
  const distRaw = criteriaStats?.fundamental?.pass_count_distribution ?? null
  const distBase = distRaw ? distRaw.reduce((s, d) => s + d.symbol_count, 0) || 1 : 1
  const dist = distRaw
    ? [...distRaw].filter((d) => d.symbol_count > 0).sort((a, b) => b.conditions_passed - a.conditions_passed)
    : null
  const distMaxCount = dist ? Math.max(...dist.map((d) => d.symbol_count), 1) : 1
  const barColorForN = (n: number) =>
    n === 8 ? 'ssp-dist-bar-fill--ok'
    : n >= 6  ? 'ssp-dist-bar-fill--good'
    : n >= 4  ? 'ssp-dist-bar-fill--warn'
    : n >= 2  ? 'ssp-dist-bar-fill--poor'
    :           'ssp-dist-bar-fill--error'

  // Technical distribution — sorted by conditions_passed DESC, top 8 shown
  const techDistRaw = criteriaStats?.technical?.pass_count_distribution ?? null
  const techDistBase = techDistRaw ? techDistRaw.reduce((s, d) => s + d.symbol_count, 0) || 1 : 1
  const techDist = techDistRaw
    ? [...techDistRaw].filter((d) => d.symbol_count > 0).sort((a, b) => b.conditions_passed - a.conditions_passed).slice(0, 8)
    : null
  const techDistMaxCount = techDist ? Math.max(...techDist.map((d) => d.symbol_count), 1) : 1
  const techBarColorForN = (n: number) =>
    n === 11 ? 'ssp-dist-bar-fill--tech-ok'
    : n >= 9  ? 'ssp-dist-bar-fill--tech-good'
    : n >= 7  ? 'ssp-dist-bar-fill--tech-warn'
    : n >= 4  ? 'ssp-dist-bar-fill--tech-poor'
    :           'ssp-dist-bar-fill--tech-error'

  // Auto-load: on first criteria load, populate Results with the top fundamental bucket
  const hasAutoLoadedRef = useRef(false)
  useEffect(() => {
    if (hasAutoLoadedRef.current || !dist || dist.length === 0) return
    const top = dist[0]
    if (!top || top.symbol_count === 0) return
    hasAutoLoadedRef.current = true
    handleBucketClick(top.conditions_passed, top.symbol_count)
  }, [dist, handleBucketClick])

  // Funnel-style row: centered bar gives visual taper when sorted by conditions_passed DESC
  const funnelRow = (
    conditions_passed: number,
    symbol_count: number,
    maxCount: number,
    base: number,
    colorFn: (n: number) => string,
    activeBucketVal: number | null,
    clickFn: (n: number, c: number) => void,
    suffix: string,
  ) => {
    const widthPct = Math.round(symbol_count / maxCount * 100)
    const sharePct = Math.round(symbol_count / base * 100)
    const isActive = activeBucketVal === conditions_passed
    const isClickable = symbol_count > 0
    const isFull = conditions_passed === parseInt(suffix)
    return (
      <div
        key={conditions_passed}
        className={`ssp-funnel-row${isClickable ? ' ssp-funnel-row--clickable' : ''}${isActive ? ' ssp-funnel-row--active' : ''}`}
        onClick={() => clickFn(conditions_passed, symbol_count)}
        role={isClickable ? 'button' : undefined}
        tabIndex={isClickable ? 0 : undefined}
        onKeyDown={isClickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') clickFn(conditions_passed, symbol_count) } : undefined}
        title={isClickable ? `Load ${symbol_count} symbols → Results` : undefined}
      >
        <span className={`ssp-funnel-label${isFull ? (suffix === '11' ? ' ssp-funnel-label--full-tech' : ' ssp-funnel-label--full') : ''}`}>
          {isFull ? `${suffix}/${suffix} ★` : `${conditions_passed}/${suffix}`}
        </span>
        <div className="ssp-funnel-bar-wrap">
          <div className={`ssp-funnel-bar-fill ${colorFn(conditions_passed)}`} style={{ width: `${widthPct}%` }} />
        </div>
        <span className="ssp-funnel-stat">
          {symbol_count.toLocaleString()}
          <span className="ssp-funnel-stat-sub">({sharePct}%)</span>
        </span>
      </div>
    )
  }

  return (
    <div className="card process-section stock-screener-page wl2 ssp-page">
      <div className="research-page-head">
        <SectionPageTitle
          menu="Research"
          pageTitle={breadcrumbLabel}
          onMenuClick={onBreadcrumbResearch}
          menuNavigateAriaLabel="Go to Research home"
          infoText="Discover symbols by SEPA conditions and inspect their daily readiness snapshot. All calculations come from the unified Stock Data Readiness pipeline; this page only filters and views."
          style={{ margin: 0 }}
        />
      </div>

      {/* Top: 4-column grid (Tech Dist · Fund Dist · Tech Conditions · Fund Conditions) */}
      <div className="ssp-top-grid ssp-top-grid--quad">
        {/* ── Card 1: Technical Distribution (top-left) ───────────────────── */}
        <section className="ssp-card">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title">
              Technical Dist.
            </h3>
            <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => void loadCriteriaStats()} disabled={criteriaLoading} title="Refresh">
              {criteriaLoading ? '…' : '↻'}
            </button>
          </header>
          {activeTechBucket != null && (
            <div className="ssp-dist-active-hint ssp-dist-active-hint--tech">
              {techBucketLoading && <span>Loading…</span>}
              {techBucketError && <span className="ssp-status-err">{techBucketError}</span>}
              {!techBucketLoading && !techBucketError && techBucketLoadedCount != null && (
                <span><span className="ssp-dist-active-badge ssp-dist-active-badge--tech">{activeTechBucket}/11</span> — {techBucketLoadedCount} → Results</span>
              )}
            </div>
          )}
          <div className="ssp-dist-body">
            {criteriaErr && <div className="ssp-empty-line ssp-status-err">{criteriaErr}</div>}
            {techDist
              ? <div className="ssp-dist-rows">{techDist.map(({ conditions_passed, symbol_count }) => funnelRow(conditions_passed, symbol_count, techDistMaxCount, techDistBase, techBarColorForN, activeTechBucket, handleTechBucketClick, '11'))}</div>
              : !criteriaLoading && <div className="ssp-empty-line">No data — run technical backfill first.</div>}
          </div>
        </section>

        {/* ── Card 2: Fundamental Distribution ────────────────────────────── */}
        <section className="ssp-card">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title">
              Fundamental Dist.
            </h3>
            <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => void loadCriteriaStats()} disabled={criteriaLoading} title="Refresh">
              {criteriaLoading ? '…' : '↻'}
            </button>
          </header>
          {activeBucket != null && (
            <div className="ssp-dist-active-hint">
              {bucketLoading && <span>Loading…</span>}
              {bucketError && <span className="ssp-status-err">{bucketError}</span>}
              {!bucketLoading && !bucketError && bucketLoadedCount != null && (
                <span><span className="ssp-dist-active-badge">{activeBucket}/8</span> — {bucketLoadedCount} → Results</span>
              )}
            </div>
          )}
          <div className="ssp-dist-body">
            {criteriaErr && <div className="ssp-empty-line ssp-status-err">{criteriaErr}</div>}
            {dist
              ? <div className="ssp-dist-rows">{dist.map(({ conditions_passed, symbol_count }) => funnelRow(conditions_passed, symbol_count, distMaxCount, distBase, barColorForN, activeBucket, handleBucketClick, '8'))}</div>
              : !criteriaLoading && <div className="ssp-empty-line">No distribution data.</div>}
          </div>
        </section>

        {/* ── Card 3: Technical Conditions filter ─────────────────────────── */}
        <section className="ssp-card">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title">
              Technical Conditions
              {techCondFilter.size > 0 && <span className="ssp-filter-tab-badge ssp-filter-tab-badge--tech" style={{ marginLeft: 6 }}>{techCondFilter.size}</span>}
            </h3>
            {techCondFilter.size > 0 && (
              <button type="button" className="ssp-btn ssp-btn--ghost" onClick={clearTechCondFilter} title="Clear technical conditions">Clear</button>
            )}
          </header>
          <div className="ssp-cond-groups">
            {(['vol', 'price52', 'sma', 'price'] as const).map((g) => (
              <div key={g} className="ssp-cond-group">
                <div className="ssp-cond-group-header">{TECH_GROUP_LABELS[g]}</div>
                <div className="ssp-cond-chips-row">
                  {TECH_COND_CATALOG.filter(c => c.group === g).map(({ id, label }) => {
                    const active = techCondFilter.has(id)
                    return (
                      <button key={id} type="button"
                        className={`ssp-cond-chip ssp-cond-chip--tech-${g}${active ? ' ssp-cond-chip--active' : ''}`}
                        onClick={() => toggleTechCondFilter(id)}
                        title={active ? `Remove ${label}` : `Add ${label}`}
                      >
                        <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                        <span className="ssp-cond-chip-label">{label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── Card 3b: Tier-aware filter hint ───────────────────────────── */}
        <section className="ssp-card ssp-card--tier-hint">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title" style={{ fontSize: '0.82rem' }}>
              Extended Tiers
              <span className="ssp-check-secondary" style={{ fontWeight: 400, marginLeft: 8 }}>Momentum · Structure · Sentiment</span>
            </h3>
          </header>
          <p className="ssp-tier-hint-text">
            Technical evaluation now includes Tier 2 (Momentum 0–10), Tier 3 (Structure/Patterns),
            and Tier 4 (Sentiment/Short). Use the <strong>Inspector panel</strong> for per-symbol
            drill-down, or the <code>/momentum-filter</code> API with <code>min_score</code> for bulk screening.
          </p>
        </section>

        {/* ── Card 4: Fundamental Conditions filter ───────────────────────── */}
        <section className="ssp-card">
          <header className="ssp-card-head ssp-card-head--tight">
            <h3 className="ssp-card-title">
              Fundamental Conditions
              {condFilter.size > 0 && <span className="ssp-filter-tab-badge" style={{ marginLeft: 6 }}>{condFilter.size}</span>}
            </h3>
            {condFilter.size > 0 && (
              <button type="button" className="ssp-btn ssp-btn--ghost" onClick={clearCondFilter} title="Clear fundamental conditions">Clear</button>
            )}
          </header>
          <div className="ssp-cond-groups">
            {(['eps', 'rev'] as const).map((g) => (
              <div key={g} className="ssp-cond-group">
                <div className="ssp-cond-group-header">{FUND_GROUP_LABELS[g]}</div>
                <div className="ssp-cond-chips-row">
                  {SEPA_COND_CATALOG.filter(c => c.group === g).map(({ id, label }) => {
                    const active = condFilter.has(id)
                    return (
                      <button key={id} type="button"
                        className={`ssp-cond-chip ssp-cond-chip--${g}${active ? ' ssp-cond-chip--active' : ''}`}
                        onClick={() => toggleCondFilter(id)}
                        title={active ? `Remove ${label}` : `Add ${label}`}
                      >
                        <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                        <span className="ssp-cond-chip-label">{label}</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}

            {/* Extension fundamental groups */}
            {Object.entries(EXT_GROUP_LABELS).map(([gk, gLabel]) => {
              const items = EXT_COND_CATALOG.filter(c => c.group === gk)
              if (!items.length) return null
              const activeCount = items.filter(c => condFilter.has(c.id)).length
              return (
                <details key={gk} className="ssp-cond-group ssp-cond-group--ext">
                  <summary className="ssp-cond-group-header ssp-cond-group-header--ext">
                    {gLabel}
                    {activeCount > 0 && <span className="ssp-filter-tab-badge" style={{ marginLeft: 4 }}>{activeCount}</span>}
                  </summary>
                  <div className="ssp-cond-chips-row">
                    {items.map(({ id, label }) => {
                      const active = condFilter.has(id)
                      return (
                        <button key={id} type="button"
                          className={`ssp-cond-chip ssp-cond-chip--ext${active ? ' ssp-cond-chip--active' : ''}`}
                          onClick={() => toggleCondFilter(id)}
                          title={active ? `Remove ${label}` : `Add ${label}`}
                        >
                          <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                          <span className="ssp-cond-chip-label">{label}</span>
                        </button>
                      )
                    })}
                  </div>
                </details>
              )
            })}
          </div>
        </section>

      </div>

      {/* ── Filter action bar ────────────────────────────────────────────── */}
      {(condFilter.size > 0 || techCondFilter.size > 0) && (
        <div className="ssp-filter-bar">
          <div className="ssp-filter-bar-info">
            {condFilter.size > 0 && <span className="ssp-filter-bar-tag ssp-filter-bar-tag--fund">{condFilter.size} Fundamental</span>}
            {condFilter.size > 0 && techCondFilter.size > 0 && <span className="ssp-filter-bar-and">∩</span>}
            {techCondFilter.size > 0 && <span className="ssp-filter-bar-tag ssp-filter-bar-tag--tech">{techCondFilter.size} Technical</span>}
            {filterLoading && <span className="ssp-filter-bar-status ssp-filter-bar-status--loading">Searching…</span>}
            {!filterLoading && filterPreview && !filterError && (
              <span className="ssp-filter-bar-preview">
                <strong className="ssp-filter-bar-count">{filterPreview.symbols.length}</strong>
                <span className="ssp-filter-bar-status"> match{filterPreview.symbols.length !== 1 ? 'es' : ''} ({filterPreview.parts})</span>
                <span className="ssp-filter-bar-arrow"> — click Apply →</span>
              </span>
            )}
            {filterError && <span className="ssp-status-err ssp-filter-bar-status">{filterError}</span>}
          </div>
          {/* Step 1: preview count */}
          {!filterPreview && (
            <button
              type="button"
              className="ssp-btn ssp-btn--secondary"
              onClick={() => void previewFilter()}
              disabled={filterLoading}
            >
              {filterLoading ? 'Searching…' : 'Search'}
            </button>
          )}
          {/* Step 2: apply previewed symbols to Results */}
          {filterPreview && (
            <button
              type="button"
              className="ssp-btn ssp-btn--primary"
              onClick={applyFilter}
            >
              Apply ({filterPreview.symbols.length})
            </button>
          )}
          {filterPreview && (
            <button
              type="button"
              className="ssp-btn ssp-btn--ghost"
              onClick={() => setFilterPreview(null)}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className="ssp-btn ssp-btn--ghost"
            onClick={() => { clearCondFilter(); clearTechCondFilter(); setFilterPreview(null); setFilterError(null) }}
          >
            Clear
          </button>
        </div>
      )}

      {/* Symbols strip — compact single row above Results */}
      <div className="ssp-symbols-strip">
        <div className="ssp-symbols-strip-label">
          <span className="ssp-symbols-strip-title">Symbols</span>
          {readinessAsOf && <span className="ssp-symbols-strip-aux">as-of {readinessAsOf}</span>}
          {readinessLoading && <span className="ssp-symbols-strip-aux ssp-symbols-strip-loading">loading…</span>}
        </div>
        <div className="ssp-symbols-strip-input">
          <textarea
            className="ssp-symbols-textarea ssp-symbols-textarea--strip"
            rows={2}
            value={symbolText}
            onChange={(e) => {
              setActiveBucket(null)
              setActiveTechBucket(null)
              setFilterPreview(null)
              setSymbolText(e.target.value)
            }}
            placeholder="AAPL,MSFT,NVDA  — or select conditions above"
          />
        </div>
        <div className="ssp-symbols-strip-meta">
          <span className="ssp-symbols-strip-count">
            <span className="ssp-num--dim">Parsed </span>
            <strong>{symbols.length}</strong>
          </span>
          {summary && (
            <>
              <span className="ssp-symbols-strip-sep" />
              <span>
                <span className="ssp-num--dim">Found </span>
                <strong>{summary.found}</strong><span className="ssp-num--dim">/{summary.total}</span>
              </span>
              <span className="ssp-results-summary-good">
                F8/8 <strong>{summary.fundPass}</strong>
              </span>
              {summary.techPass > 0 && (
                <span className="ssp-results-summary-tech">
                  T11/11 <strong>{summary.techPass}</strong>
                </span>
              )}
              {summary.insufficient > 0 && (
                <span className="ssp-results-summary-warn">
                  insuff <strong>{summary.insufficient}</strong>
                </span>
              )}
            </>
          )}
          {readinessError && <span className="ssp-status-err">{readinessError}</span>}
        </div>
      </div>

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
                <th
                  className={`ssp-th-sortable${sortCol === 'tech' ? ' ssp-th-sortable--active' : ''}`}
                  onClick={() => toggleSort('tech')}
                  title="Sort by Technical pass count"
                >
                  Technical {sortCol === 'tech' ? (sortDir === 'desc' ? '↓' : '↑') : '⇅'}
                </th>
                <th
                  className={`ssp-th-sortable${sortCol === 'fund' ? ' ssp-th-sortable--active' : ''}`}
                  onClick={() => toggleSort('fund')}
                  title="Sort by Fundamental pass count"
                >
                  Fundamental {sortCol === 'fund' ? (sortDir === 'desc' ? '↓' : '↑') : '⇅'}
                </th>
                <th style={{ width: 70, textAlign: 'center' }}>Univ</th>
                <th style={{ width: 100 }}>Price</th>
                <th style={{ width: 150 }}>Statements</th>
                <th style={{ width: 90 }}>Short</th>
                <th style={{ width: 90 }}>As-of</th>
              </tr>
            </thead>
            <tbody>
              {readinessRows.length === 0 && (
                <tr className="ssp-table-empty">
                  <td colSpan={8}>
                    {readinessLoading
                      ? 'Loading readiness…'
                      : symbols.length === 0
                        ? 'Select a distribution bucket, apply a condition filter, or type symbols below.'
                        : readinessError
                          ? 'Failed to load readiness — see error above.'
                          : 'No readiness rows found.'}
                  </td>
                </tr>
              )}
              {sortedRows.map((r) => {
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
                const passedTech = new Set(r.passed_tech_conditions ?? [])
                const insuf = r.fundamental_insufficient ?? false
                const passCount = r.fundamental_pass_count ?? 0
                const techInsuf = r.technical_insufficient ?? false
                const techPassCount = r.technical_pass_count ?? 0
                const techEvalPresent = r.technical_pass !== undefined
                const fundCls =
                  insuf ? 'ssp-fund-cell--insuf'
                  : passCount === 8 ? 'ssp-fund-cell--all'
                  : passCount >= 5 ? 'ssp-fund-cell--good'
                  : passCount >= 2 ? 'ssp-fund-cell--warn'
                  : 'ssp-fund-cell--poor'
                const techCls =
                  !techEvalPresent ? 'ssp-fund-cell--insuf'
                  : techInsuf ? 'ssp-fund-cell--insuf'
                  : techPassCount === 11 ? 'ssp-fund-cell--all'
                  : techPassCount >= 8 ? 'ssp-fund-cell--good'
                  : techPassCount >= 5 ? 'ssp-fund-cell--warn'
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
                        {r.symbol}<span className="ssp-sym-open-hint" aria-hidden>↗</span>
                      </button>
                    </td>
                    {/* Technical column: pill + 11 condition dots */}
                    <td>
                      <div className="ssp-cond-col">
                        <span className={`ssp-fund-cell ${techCls}`} title={!techEvalPresent ? 'Not evaluated' : techInsuf ? 'Insufficient data' : `${techPassCount}/11 passed`}>
                          {!techEvalPresent ? '—' : techInsuf ? 'INS' : `${techPassCount}/11`}
                        </span>
                        {techEvalPresent && (
                          <div className="ssp-cond-dots">
                            {TECH_COND_CATALOG.map(({ id, short, group }) => {
                              const pass = passedTech.has(id)
                              return (
                                <span key={id}
                                  className={`ssp-cond-dot ssp-cond-dot--tech-${group}${pass ? ' ssp-cond-dot--pass' : ' ssp-cond-dot--fail'}${techInsuf ? ' ssp-cond-dot--dim' : ''}`}
                                  title={`${short}: ${techInsuf ? 'insufficient' : pass ? 'pass' : 'fail'}`}
                                >{pass ? '✓' : ''}</span>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </td>
                    {/* Fundamental column: pill + 8 condition dots */}
                    <td>
                      <div className="ssp-cond-col">
                        <span className={`ssp-fund-cell ${fundCls}`} title={insuf ? 'Insufficient data' : `${passCount}/8 passed`}>
                          {insuf ? 'INS' : `${passCount}/8`}
                        </span>
                        <div className="ssp-cond-dots">
                          {SEPA_COND_CATALOG.map(({ id, short, group }) => {
                            const pass = passed.has(id)
                            return (
                              <span key={id}
                                className={`ssp-cond-dot ssp-cond-dot--${group}${pass ? ' ssp-cond-dot--pass' : ' ssp-cond-dot--fail'}${insuf ? ' ssp-cond-dot--dim' : ''}`}
                                title={`${short}: ${insuf ? 'insufficient' : pass ? 'pass' : 'fail'}`}
                              >{pass ? '✓' : ''}</span>
                            )
                          })}
                        </div>
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
