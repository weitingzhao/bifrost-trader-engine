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
  fetchMomentumFilter,
  fetchTierFilter,
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

/** Core SEPA fundamental conditions */
const FUND_GROUP_LABELS: Record<string, string> = {
  eps: 'EPS',
  rev: 'Revenue',
}
/** Extended fundamental groups — displayed in 4-col grid */
const EXT_GROUP_LABELS: Record<string, string> = {
  quality:       'Quality',
  balance:       'Balance Sheet',
  cashflow:      'Cash Flow',
  valuation:     'Valuation',
  profitability: 'Profitability',
  efficiency:    'Efficiency',
  sentiment:     'Sentiment',
}
/** Tier 1 technical groups */
const TECH_GROUP_LABELS: Record<string, string> = {
  vol:     'Volume / Momentum',
  price52: '52-Week Range',
  sma:     'SMA Slope',
  price:   'Price Position',
}

// ── Catalogs ──────────────────────────────────────────────────────────────────

const SEPA_COND_CATALOG: { id: string; label: string; short: string; group: 'eps' | 'rev' }[] = [
  { id: 'eps_q2q_ge_25pct', label: 'EPS QoQ ≥ 25%',         short: 'EPS Q2Q',    group: 'eps' },
  { id: 'rev_q2q_ge_25pct', label: 'Revenue QoQ ≥ 25%',     short: 'Rev Q2Q',    group: 'rev' },
  { id: 'eps_acc_2q',       label: 'EPS Accelerating (2Q)', short: 'EPS Acc 2Q', group: 'eps' },
  { id: 'rev_acc_2q',       label: 'Revenue Accel (2Q)',    short: 'Rev Acc 2Q', group: 'rev' },
  { id: 'eps_3y_ge_15pct',  label: 'EPS 3Y CAGR ≥ 15%',    short: 'EPS 3Y',     group: 'eps' },
  { id: 'rev_3y_ge_15pct',  label: 'Revenue 3Y CAGR ≥ 15%', short: 'Rev 3Y',    group: 'rev' },
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

// ── Tier 2-4 indicator catalogs ───────────────────────────────────────────────

const MOMENTUM_INDICATORS: { id: string; label: string; group: 'oscillator' | 'roc' | 'rs' | 'trend' }[] = [
  { id: 'rsi_14_in_band',              label: 'RSI 14 In Band',      group: 'oscillator' },
  { id: 'macd_hist_positive',          label: 'MACD Hist Positive',  group: 'oscillator' },
  { id: 'roc_3m_positive',             label: 'ROC 3M Positive',     group: 'roc' },
  { id: 'roc_6m_positive',             label: 'ROC 6M Positive',     group: 'roc' },
  { id: 'roc_12m_positive',            label: 'ROC 12M Positive',    group: 'roc' },
  { id: 'multi_period_rs_4w_positive',  label: 'RS 4W Positive',     group: 'rs' },
  { id: 'multi_period_rs_13w_positive', label: 'RS 13W Positive',    group: 'rs' },
  { id: 'multi_period_rs_26w_positive', label: 'RS 26W Positive',    group: 'rs' },
  { id: 'slope_sma200_positive',        label: 'SMA200 Slope ↑',     group: 'trend' },
  { id: 'up_down_volume_50d_gt_1',      label: 'Up/Down Vol > 1',    group: 'trend' },
]

const MOMENTUM_GROUP_LABELS: Record<string, string> = {
  oscillator: 'Oscillator',
  roc: 'Rate of Change',
  rs: 'Relative Strength',
  trend: 'Trend / Volume',
}

const STRUCTURE_INDICATORS: { id: string; label: string }[] = [
  { id: 'realized_vol_contraction', label: 'Vol Contraction' },
  { id: 'bb_squeeze',               label: 'BB Squeeze' },
  { id: 'obv_slope_30d_positive',   label: 'OBV Slope ↑' },
  { id: 'adx_14_ge_25',             label: 'ADX 14 ≥ 25' },
  { id: 'aroon_oscillator_ge_50',   label: 'Aroon ≥ 50' },
  { id: 'tight_closes_5d',          label: 'Tight Closes 5D' },
  { id: 'vcp_contraction_3m',       label: 'VCP 3M' },
  { id: 'pocket_pivot_count',       label: 'Pocket Pivot' },
  { id: 'rsl_new_high',             label: 'RSL New High' },
  { id: 'base_metrics',             label: 'Base Metrics' },
]

const SENTIMENT_INDICATORS: { id: string; label: string }[] = [
  { id: 'days_to_cover_ge_5',                  label: 'Days to Cover ≥ 5' },
  { id: 'short_volume_ratio_le_30pct_recent',   label: 'Short Vol ≤ 30%' },
  { id: 'short_volume_ratio_trend_4w_falling',  label: 'Short Vol ↓ 4W' },
]

type TierKey = 'momentum' | 'structure' | 'sentiment'

interface TierFilterState {
  indicators: Set<string>
  minScore: number
}

type InspectorSeed = { passCount: number; passedConditions: string[] }
type InspectorState = { symbol: string; seed?: InspectorSeed }

function boolMark(v: boolean | undefined | null): ReactNode {
  if (v === undefined || v === null) return <span className="ssp-pill ssp-pill--na">—</span>
  return <span className={`ssp-pill ssp-pill--sm ${v ? 'ssp-pill--pass' : 'ssp-pill--fail'}`}>{v ? '✓' : '✗'}</span>
}

export function StockScreenerPage({ onBreadcrumbResearch, breadcrumbLabel = 'Stock Screener' }: StockScreenerPageProps) {
  const [symbolText, setSymbolText] = useState('')

  const [inspector, setInspector] = useState<InspectorState | null>(null)
  const openInspector = useCallback((symbol: string, seed?: InspectorSeed) => {
    const sym = (symbol || '').trim().toUpperCase()
    if (!sym) return
    setInspector((prev) => (prev?.symbol === sym ? null : { symbol: sym, seed }))
  }, [])
  const closeInspector = useCallback(() => setInspector(null), [])

  // ── Distribution stats ──────────────────────────────────────────────────────
  const [criteriaStats, setCriteriaStats] = useState<SepaCriteriaStats | null>(null)
  const [criteriaLoading, setCriteriaLoading] = useState(false)
  const [criteriaErr, setCriteriaErr] = useState<string | null>(null)

  const [activeBucket, setActiveBucket] = useState<number | null>(null)
  const [bucketLoading, setBucketLoading] = useState(false)
  const [bucketLoadedCount, setBucketLoadedCount] = useState<number | null>(null)
  const [bucketError, setBucketError] = useState<string | null>(null)
  const distCacheRef = useRef<Map<number, string[]>>(new Map())

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

  // ── Condition filter chips ──────────────────────────────────────────────────
  const [condFilter, setCondFilter] = useState<Set<string>>(new Set())
  const [techCondFilter, setTechCondFilter] = useState<Set<string>>(new Set())

  // Tier 2-4 filter state
  const [tierFilters, setTierFilters] = useState<Record<TierKey, TierFilterState>>(() => ({
    momentum: { indicators: new Set<string>(), minScore: 0 },
    structure: { indicators: new Set<string>(), minScore: 0 },
    sentiment: { indicators: new Set<string>(), minScore: 0 },
  }))
  const toggleCondFilter = useCallback((id: string) => {
    setCondFilter((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
    setFilterPreview(null); setFilterError(null)
  }, [])
  const clearCondFilter = useCallback(() => { setCondFilter(new Set()); setFilterPreview(null) }, [])

  const toggleTechCondFilter = useCallback((id: string) => {
    setTechCondFilter((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
    setFilterPreview(null); setFilterError(null)
  }, [])
  const clearTechCondFilter = useCallback(() => { setTechCondFilter(new Set()); setFilterPreview(null) }, [])

  const toggleTierIndicator = useCallback((tier: TierKey, id: string) => {
    setTierFilters((prev) => {
      const cur = prev[tier]
      const next = new Set(cur.indicators)
      next.has(id) ? next.delete(id) : next.add(id)
      return { ...prev, [tier]: { ...cur, indicators: next } }
    })
    setFilterPreview(null); setFilterError(null)
  }, [])

  const setTierMinScore = useCallback((tier: TierKey, score: number) => {
    setTierFilters((prev) => ({ ...prev, [tier]: { ...prev[tier], minScore: score } }))
    setFilterPreview(null); setFilterError(null)
  }, [])

  const clearTierFilter = useCallback((tier: TierKey) => {
    setTierFilters((prev) => ({ ...prev, [tier]: { indicators: new Set(), minScore: 0 } }))
    setFilterPreview(null)
  }, [])

  const clearAllTierFilters = useCallback(() => {
    setTierFilters({ momentum: { indicators: new Set(), minScore: 0 }, structure: { indicators: new Set(), minScore: 0 }, sentiment: { indicators: new Set(), minScore: 0 } })
    setFilterPreview(null)
  }, [])

  const tierActiveCount = useMemo(() => {
    let count = 0
    for (const k of ['momentum', 'structure', 'sentiment'] as TierKey[]) {
      const f = tierFilters[k]
      if (f.indicators.size > 0 || f.minScore > 0) count++
    }
    return count
  }, [tierFilters])

  // ── Apply Filter ────────────────────────────────────────────────────────────
  const [filterLoading, setFilterLoading] = useState(false)
  const [filterError, setFilterError] = useState<string | null>(null)
  const [filterPreview, setFilterPreview] = useState<{ symbols: string[]; parts: string } | null>(null)

  const previewFilter = useCallback(async () => {
    const fundActive = condFilter.size > 0
    const techActive = techCondFilter.size > 0
    const momentumActive = tierFilters.momentum.indicators.size > 0 || tierFilters.momentum.minScore > 0
    const structureActive = tierFilters.structure.indicators.size > 0 || tierFilters.structure.minScore > 0
    const sentimentActive = tierFilters.sentiment.indicators.size > 0 || tierFilters.sentiment.minScore > 0
    if (!fundActive && !techActive && !momentumActive && !structureActive && !sentimentActive) return

    setFilterLoading(true)
    setFilterError(null)
    setFilterPreview(null)

    try {
      const results: { label: string; syms: string[] }[] = []

      if (fundActive) {
        const res = await fetchFundamentalFilter({ include: Array.from(condFilter), limit: 2000 })
        if (!res.ok) throw new Error(res.error ?? 'Fundamental filter failed')
        results.push({ label: `${condFilter.size}F`, syms: (res.symbols ?? []).map((s) => s.symbol) })
      }
      if (techActive) {
        const res = await fetchTechnicalFilter({ include: Array.from(techCondFilter), limit: 2000 })
        if (!res.ok) throw new Error(res.error ?? 'Technical filter failed')
        results.push({ label: `${techCondFilter.size}T`, syms: (res.symbols ?? []).map((s) => s.symbol) })
      }
      if (momentumActive) {
        const f = tierFilters.momentum
        const res = await fetchMomentumFilter({
          include: f.indicators.size > 0 ? Array.from(f.indicators) : undefined,
          min_score: f.minScore > 0 ? f.minScore : undefined,
          limit: 2000,
        })
        if (!res.ok) throw new Error(res.error ?? 'Momentum filter failed')
        results.push({ label: `M(≥${f.minScore})`, syms: (res.symbols ?? []).map((s) => s.symbol) })
      }
      if (structureActive) {
        const f = tierFilters.structure
        const res = await fetchTierFilter({
          tier: 'structure',
          include: f.indicators.size > 0 ? Array.from(f.indicators) : undefined,
          min_score: f.minScore > 0 ? f.minScore : undefined,
          limit: 2000,
        })
        if (!res.ok) throw new Error(res.error ?? 'Structure filter failed')
        results.push({ label: `S(≥${f.minScore})`, syms: (res.symbols ?? []).map((s) => s.symbol) })
      }
      if (sentimentActive) {
        const f = tierFilters.sentiment
        const res = await fetchTierFilter({
          tier: 'sentiment',
          include: f.indicators.size > 0 ? Array.from(f.indicators) : undefined,
          min_score: f.minScore > 0 ? f.minScore : undefined,
          limit: 2000,
        })
        if (!res.ok) throw new Error(res.error ?? 'Sentiment filter failed')
        results.push({ label: `Se(≥${f.minScore})`, syms: (res.symbols ?? []).map((s) => s.symbol) })
      }

      let intersection: string[] = results[0]?.syms ?? []
      for (let i = 1; i < results.length; i++) {
        const s = new Set(results[i].syms)
        intersection = intersection.filter((x) => s.has(x))
      }
      const parts = results.map((r) => r.label).join(' ∩ ')
      setFilterPreview({ symbols: intersection, parts })
    } catch (e) {
      setFilterError(e instanceof Error ? e.message : 'Filter failed')
    } finally {
      setFilterLoading(false)
    }
  }, [condFilter, techCondFilter, tierFilters])

  const applyFilter = useCallback(() => {
    if (!filterPreview) return
    setActiveBucket(null); setActiveTechBucket(null)
    setSymbolText(filterPreview.symbols.join(','))
  }, [filterPreview])

  const clearExtGroupFilter = useCallback((gk: string) => {
    setCondFilter((prev) => {
      const next = new Set(prev)
      EXT_COND_CATALOG.filter((c) => c.group === gk).forEach((c) => next.delete(c.id))
      return next
    })
    setFilterPreview(null)
  }, [])

  const clearSepaGroupFilter = useCallback((g: 'eps' | 'rev') => {
    setCondFilter((prev) => {
      const next = new Set(prev)
      SEPA_COND_CATALOG.filter((c) => c.group === g).forEach((c) => next.delete(c.id))
      return next
    })
    setFilterPreview(null)
  }, [])

  const clearAllFilters = useCallback(() => {
    clearCondFilter(); clearTechCondFilter(); clearAllTierFilters()
    setFilterPreview(null); setFilterError(null)
  }, [clearCondFilter, clearTechCondFilter, clearAllTierFilters])

  const anyFilterActive = condFilter.size > 0 || techCondFilter.size > 0 || tierActiveCount > 0

  // ── Sort ────────────────────────────────────────────────────────────────────
  const [sortCol, setSortCol] = useState<'tech' | 'fund' | null>(null)
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc')
  const toggleSort = useCallback((col: 'tech' | 'fund') => {
    setSortCol((prev) => {
      if (prev === col) { setSortDir((d) => d === 'desc' ? 'asc' : 'desc'); return col }
      setSortDir('desc'); return col
    })
  }, [])

  // ── Symbols & readiness ─────────────────────────────────────────────────────
  const symbols = useMemo(() => parseSymbols(symbolText), [symbolText])
  const symbolsKey = useMemo(() => symbols.join(','), [symbols])

  const [readinessRows, setReadinessRows] = useState<ReadinessSnapshotRow[]>([])
  const [readinessLoading, setReadinessLoading] = useState(false)
  const [readinessError, setReadinessError] = useState<string | null>(null)
  const [readinessAsOf, setReadinessAsOf] = useState<string | null>(null)

  useEffect(() => {
    if (symbols.length === 0) {
      setReadinessRows([]); setReadinessAsOf(null); setReadinessError(null); return
    }
    let cancelled = false
    setReadinessLoading(true); setReadinessError(null)
    const handle = window.setTimeout(() => {
      fetchSymbolsReadinessSnapshot(symbols)
        .then((res) => {
          if (cancelled) return
          if (!res.ok) { setReadinessRows([]); setReadinessAsOf(null); setReadinessError(res.error ?? 'Failed'); return }
          setReadinessRows(res.symbols ?? [])
          setReadinessAsOf(res.as_of_date ?? null)
        })
        .catch((e) => { if (!cancelled) setReadinessError(e instanceof Error ? e.message : 'Network error') })
        .finally(() => { if (!cancelled) setReadinessLoading(false) })
    }, 200)
    return () => { cancelled = true; window.clearTimeout(handle) }
  }, [symbolsKey, symbols])

  const handleBucketClick = useCallback((n: number, count: number) => {
    if (count === 0) return
    const isActivating = activeBucket !== n
    setActiveBucket(isActivating ? n : null)
    setActiveTechBucket(null)
    if (!isActivating) return
    const cached = distCacheRef.current.get(n)
    if (cached) { setSymbolText(cached.join(',')); setBucketLoadedCount(cached.length); setBucketError(null); return }
    setBucketLoading(true); setBucketError(null); setBucketLoadedCount(null)
    fetchFundamentalDistributionSymbols(n).then((res) => {
      setBucketLoading(false)
      if (!res.ok) { setBucketError(res.error ?? 'Failed'); return }
      const syms = (res.symbols ?? []).map((s) => s.symbol)
      distCacheRef.current.set(n, syms); setSymbolText(syms.join(',')); setBucketLoadedCount(syms.length)
    })
  }, [activeBucket])

  const handleTechBucketClick = useCallback((n: number, count: number) => {
    if (count === 0) return
    const isActivating = activeTechBucket !== n
    setActiveTechBucket(isActivating ? n : null)
    setActiveBucket(null)
    if (!isActivating) return
    const cached = techDistCacheRef.current.get(n)
    if (cached) { setSymbolText(cached.join(',')); setTechBucketLoadedCount(cached.length); setTechBucketError(null); return }
    setTechBucketLoading(true); setTechBucketError(null); setTechBucketLoadedCount(null)
    fetchTechnicalDistributionSymbols(n).then((res) => {
      setTechBucketLoading(false)
      if (!res.ok) { setTechBucketError(res.error ?? 'Failed'); return }
      const syms = (res.symbols ?? []).map((s) => s.symbol)
      techDistCacheRef.current.set(n, syms); setSymbolText(syms.join(',')); setTechBucketLoadedCount(syms.length)
    })
  }, [activeTechBucket])

  const sortedRows = useMemo(() => {
    if (!sortCol) return readinessRows
    return [...readinessRows].sort((a, b) => {
      const va = sortCol === 'tech' ? (a.technical_pass_count ?? -1) : (a.fundamental_pass_count ?? -1)
      const vb = sortCol === 'tech' ? (b.technical_pass_count ?? -1) : (b.fundamental_pass_count ?? -1)
      return sortDir === 'desc' ? vb - va : va - vb
    })
  }, [readinessRows, sortCol, sortDir])

  const summary = useMemo(() => {
    if (readinessRows.length === 0) return null
    const found = readinessRows.filter((r) => r.found)
    return {
      total: readinessRows.length,
      found: found.length,
      fundPass: found.filter((r) => (r.fundamental_pass_count ?? 0) === 8).length,
      techPass: found.filter((r) => r.technical_pass === true).length,
      insufficient: found.filter((r) => r.fundamental_insufficient).length,
    }
  }, [readinessRows])

  // ── Distribution helpers ────────────────────────────────────────────────────
  const distRaw = criteriaStats?.fundamental?.pass_count_distribution ?? null
  const distBase = distRaw ? distRaw.reduce((s, d) => s + d.symbol_count, 0) || 1 : 1
  const distFiltered = distRaw
    ? [...distRaw].filter((d) => d.symbol_count > 0).sort((a, b) => b.conditions_passed - a.conditions_passed)
    : []
  const dist = distFiltered.length > 0 ? distFiltered : null
  const distMaxCount = dist ? Math.max(...dist.map((d) => d.symbol_count), 1) : 1
  const barColorForN = (n: number) =>
    n === 8 ? 'ssp-dist-bar-fill--ok' : n >= 6 ? 'ssp-dist-bar-fill--good' : n >= 4 ? 'ssp-dist-bar-fill--warn' : n >= 2 ? 'ssp-dist-bar-fill--poor' : 'ssp-dist-bar-fill--error'

  const techDistRaw = criteriaStats?.technical?.pass_count_distribution ?? null
  const techDistBase = techDistRaw ? techDistRaw.reduce((s, d) => s + d.symbol_count, 0) || 1 : 1
  const techDistFiltered = techDistRaw
    ? [...techDistRaw].filter((d) => d.symbol_count > 0).sort((a, b) => b.conditions_passed - a.conditions_passed).slice(0, 8)
    : []
  const techDist = techDistFiltered.length > 0 ? techDistFiltered : null
  const techDistMaxCount = techDist ? Math.max(...techDist.map((d) => d.symbol_count), 1) : 1
  const techBarColorForN = (n: number) =>
    n === 11 ? 'ssp-dist-bar-fill--tech-ok' : n >= 9 ? 'ssp-dist-bar-fill--tech-good' : n >= 7 ? 'ssp-dist-bar-fill--tech-warn' : n >= 4 ? 'ssp-dist-bar-fill--tech-poor' : 'ssp-dist-bar-fill--tech-error'

  const statsAsOfHint = useMemo(() => {
    const d = criteriaStats?.as_of_date
    if (!d) return null
    if (criteriaStats?.as_of_date_is_today) return `As of ${d}`
    return `As of ${d} (not today — refresh snapshot in Stock Data Readiness)`
  }, [criteriaStats?.as_of_date, criteriaStats?.as_of_date_is_today])

  const fundDistEmptyMsg = criteriaStats?.as_of_date
    ? `No fundamental distribution for ${criteriaStats.as_of_date}. Run fundamental backfill in Stock Data Readiness.`
    : 'No fundamental distribution — refresh snapshot and run fundamental backfill in Stock Data Readiness.'
  const techDistEmptyMsg = criteriaStats?.as_of_date
    ? `No technical distribution for ${criteriaStats.as_of_date}. Run technical backfill in Stock Data Readiness.`
    : 'No technical distribution — refresh snapshot and run technical backfill in Stock Data Readiness.'

  const hasAutoLoadedRef = useRef(false)
  useEffect(() => {
    if (hasAutoLoadedRef.current || !dist || dist.length === 0) return
    const top = dist[0]
    if (!top || top.symbol_count === 0) return
    hasAutoLoadedRef.current = true
    handleBucketClick(top.conditions_passed, top.symbol_count)
  }, [dist, handleBucketClick])

  const funnelRow = (
    conditions_passed: number, symbol_count: number, maxCount: number, base: number,
    colorFn: (n: number) => string, activeBucketVal: number | null,
    clickFn: (n: number, c: number) => void, suffix: string,
  ) => {
    const widthPct = Math.round(symbol_count / maxCount * 100)
    const sharePct = Math.round(symbol_count / base * 100)
    const isActive = activeBucketVal === conditions_passed
    const isClickable = symbol_count > 0
    const isFull = conditions_passed === parseInt(suffix)
    return (
      <div key={conditions_passed}
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
        <span className="ssp-funnel-stat">{symbol_count.toLocaleString()}<span className="ssp-funnel-stat-sub">({sharePct}%)</span></span>
      </div>
    )
  }

  // ── Tier helpers ────────────────────────────────────────────────────────────
  const tierCatalog: Record<TierKey, { id: string; label: string }[]> = {
    momentum: MOMENTUM_INDICATORS,
    structure: STRUCTURE_INDICATORS,
    sentiment: SENTIMENT_INDICATORS,
  }
  const tierMaxScore: Record<TierKey, number> = { momentum: 10, structure: 10, sentiment: 3 }


  return (
    <div className="card process-section stock-screener-page wl2 ssp-page">
      <div className="research-page-head">
        <SectionPageTitle
          menu="Research"
          pageTitle={breadcrumbLabel}
          onMenuClick={onBreadcrumbResearch}
          menuNavigateAriaLabel="Go to Research home"
          infoText="Discover symbols by SEPA conditions and inspect their daily readiness snapshot."
          style={{ margin: 0 }}
        />
      </div>

      {/* ══ Technical Section ═══════════════════════════════════════════════ */}
      <div className="ssp-section">
        <div className="ssp-section-header">
          <span className="ssp-section-label ssp-section-label--tech">Technical</span>
          <div className="ssp-section-rule" />
        </div>

        {/* Tech: 4-col layout — Dist(3) | Conditions(3) | Momentum(3) | Structure+Sentiment(3) */}
        <div className="ssp-tech-layout">

          {/* Col 1: SEPA Dist (3/12) */}
          <section className="ssp-card">
            <header className="ssp-card-head ssp-card-head--tight">
              <h3 className="ssp-card-title">
                SEPA Dist.
                {statsAsOfHint && <span className="ssp-card-title-aux">{statsAsOfHint}</span>}
              </h3>
              <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => void loadCriteriaStats()} disabled={criteriaLoading} title="Refresh">{criteriaLoading ? '…' : '↻'}</button>
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
                : criteriaLoading
                  ? <div className="ssp-empty-line">Loading distribution…</div>
                  : <div className="ssp-empty-line">{techDistEmptyMsg}</div>}
            </div>
          </section>

          {/* Col 2: SEPA Conditions (3/12) */}
          <section className="ssp-card">
            <header className="ssp-card-head ssp-card-head--tight">
              <h3 className="ssp-card-title">
                SEPA Conditions
                {techCondFilter.size > 0 && <span className="ssp-filter-tab-badge ssp-filter-tab-badge--tech" style={{ marginLeft: 4 }}>{techCondFilter.size}</span>}
              </h3>
              {techCondFilter.size > 0 && <button type="button" className="ssp-btn ssp-btn--ghost" onClick={clearTechCondFilter}>Clear</button>}
            </header>
            <div className="ssp-cond-groups">
              {(['vol', 'price52', 'sma', 'price'] as const).map((g) => (
                <div key={g} className={`ssp-cond-group ssp-cond-group--${g}`}>
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

          {/* Col 3: Momentum (3/12) — grouped like SEPA Conditions */}
          {(() => {
            const tk: TierKey = 'momentum'
            const f = tierFilters[tk]
            const activeCount = f.indicators.size + (f.minScore > 0 ? 1 : 0)
            return (
              <section className={`ssp-card ssp-card--tier-${tk}`}>
                <header className="ssp-card-head ssp-card-head--tight">
                  <h3 className={`ssp-card-title ssp-tier-card-title--${tk}`}>
                    Momentum
                    {activeCount > 0 && <span className={`ssp-tier-count-badge ssp-tier-count-badge--${tk}`} style={{ marginLeft: 4 }}>{activeCount}</span>}
                  </h3>
                  {activeCount > 0 && <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => clearTierFilter(tk)}>Clear</button>}
                </header>
                <div className="ssp-tier-score-row">
                  <span className="ssp-tier-score-label">Score ≥</span>
                  <div className="ssp-tier-score-inline">
                    <input type="range" min={0} max={tierMaxScore[tk]} value={f.minScore}
                      onChange={(e) => setTierMinScore(tk, Number(e.target.value))}
                      className="ssp-tier-score-slider"
                    />
                    <span className={`ssp-tier-score-val${f.minScore > 0 ? ` ssp-tier-score-val--${tk}` : ''}`}>
                      {f.minScore}/{tierMaxScore[tk]}
                    </span>
                  </div>
                </div>
                <div className="ssp-cond-groups">
                  {(['oscillator', 'roc', 'rs', 'trend'] as const).map((g) => (
                    <div key={g} className={`ssp-cond-group ssp-cond-group--${g}`}>
                      <div className="ssp-cond-group-header">{MOMENTUM_GROUP_LABELS[g]}</div>
                      <div className="ssp-cond-chips-row">
                        {MOMENTUM_INDICATORS.filter(c => c.group === g).map(({ id, label: chipLabel }) => {
                          const active = f.indicators.has(id)
                          return (
                            <button key={id} type="button"
                              className={`ssp-cond-chip ssp-cond-chip--tier-${tk}${active ? ' ssp-cond-chip--active' : ''}`}
                              onClick={() => toggleTierIndicator(tk, id)}
                              title={active ? `Remove ${chipLabel}` : `Add ${chipLabel}`}
                            >
                              <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                              <span className="ssp-cond-chip-label">{chipLabel}</span>
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )
          })()}

          {/* Col 4: Structure + Sentiment stacked (3/12) */}
          <div className="ssp-tech-cell-stacked">
            {(['structure', 'sentiment'] as TierKey[]).map((tk) => {
              const f = tierFilters[tk]
              const activeCount = f.indicators.size + (f.minScore > 0 ? 1 : 0)
              const tierLabel = tk.charAt(0).toUpperCase() + tk.slice(1)
              return (
                <section key={tk} className={`ssp-card ssp-card--tier-${tk}`}>
                  <header className="ssp-card-head ssp-card-head--tight">
                    <h3 className={`ssp-card-title ssp-tier-card-title--${tk}`}>
                      {tierLabel}
                      {activeCount > 0 && <span className={`ssp-tier-count-badge ssp-tier-count-badge--${tk}`} style={{ marginLeft: 4 }}>{activeCount}</span>}
                    </h3>
                    {activeCount > 0 && <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => clearTierFilter(tk)}>Clear</button>}
                  </header>
                  <div className="ssp-tier-score-row">
                    <span className="ssp-tier-score-label">Score ≥</span>
                    <div className="ssp-tier-score-inline">
                      <input type="range" min={0} max={tierMaxScore[tk]} value={f.minScore}
                        onChange={(e) => setTierMinScore(tk, Number(e.target.value))}
                        className="ssp-tier-score-slider"
                      />
                      <span className={`ssp-tier-score-val${f.minScore > 0 ? ` ssp-tier-score-val--${tk}` : ''}`}>
                        {f.minScore}/{tierMaxScore[tk]}
                      </span>
                    </div>
                  </div>
                  <div className="ssp-cond-chips-row">
                    {tierCatalog[tk].map(({ id, label: chipLabel }) => {
                      const active = f.indicators.has(id)
                      return (
                        <button key={id} type="button"
                          className={`ssp-cond-chip ssp-cond-chip--tier-${tk}${active ? ' ssp-cond-chip--active' : ''}`}
                          onClick={() => toggleTierIndicator(tk, id)}
                          title={active ? `Remove ${chipLabel}` : `Add ${chipLabel}`}
                        >
                          <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                          <span className="ssp-cond-chip-label">{chipLabel}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>

        </div>{/* end ssp-tech-layout */}

      </div>{/* end Technical section */}

      {/* ══ Fundamental Section ════════════════════════════════════════════════ */}
      <div className="ssp-section">
        <div className="ssp-section-header">
          <span className="ssp-section-label ssp-section-label--fund">Fundamental</span>
          <div className="ssp-section-rule" />
        </div>

        {/* Fund layout: left 3/12 (SEPA Dist) + right 9/12 (Conditions + Ext groups) */}
        <div className="ssp-fund-layout">

          {/* Left column: SEPA Distribution (3/12) */}
          <section className="ssp-card ssp-fund-dist">
            <header className="ssp-card-head ssp-card-head--tight">
              <h3 className="ssp-card-title">
                SEPA Dist.
                {statsAsOfHint && <span className="ssp-card-title-aux">{statsAsOfHint}</span>}
              </h3>
              <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => void loadCriteriaStats()} disabled={criteriaLoading} title="Refresh">{criteriaLoading ? '…' : '↻'}</button>
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
                : criteriaLoading
                  ? <div className="ssp-empty-line">Loading distribution…</div>
                  : <div className="ssp-empty-line">{fundDistEmptyMsg}</div>}
            </div>
          </section>

          {/* Right column 9/12: 4-col × 2-row grid
               Row 1: SEPA Conditions | Quality       | Balance Sheet | Cash Flow
               Row 2: (spans from R1) | Efficiency    | Sentiment     | Valuation + Profitability */}
          <div className="ssp-fund-right-grid">

            {/* SEPA Conditions — spans both rows */}
            <section className="ssp-card ssp-fund-sepa-conds ssp-fund-cell-sepa">
              <header className="ssp-card-head ssp-card-head--tight">
                <h3 className="ssp-card-title">
                  SEPA Conditions
                  {(['eps', 'rev'] as const).reduce((n, g) => n + SEPA_COND_CATALOG.filter(c => c.group === g && condFilter.has(c.id)).length, 0) > 0 && (
                    <span className="ssp-filter-tab-badge" style={{ marginLeft: 4 }}>
                      {(['eps', 'rev'] as const).reduce((n, g) => n + SEPA_COND_CATALOG.filter(c => c.group === g && condFilter.has(c.id)).length, 0)}
                    </span>
                  )}
                </h3>
                {(['eps', 'rev'] as const).some(g => SEPA_COND_CATALOG.filter(c => c.group === g).some(c => condFilter.has(c.id))) && (
                  <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => { clearSepaGroupFilter('eps'); clearSepaGroupFilter('rev') }}>Clear</button>
                )}
              </header>
              <div className="ssp-cond-groups">
                {(['eps', 'rev'] as const).map((g) => {
                  const groupActive = SEPA_COND_CATALOG.filter(c => c.group === g && condFilter.has(c.id)).length
                  return (
                    <div key={g} className={`ssp-cond-group ssp-cond-group--fund-${g}`}>
                      <div className="ssp-cond-group-header">
                        {FUND_GROUP_LABELS[g]}
                        {groupActive > 0 && <span className="ssp-filter-tab-badge" style={{ marginLeft: 4 }}>{groupActive}</span>}
                      </div>
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
                  )
                })}
              </div>
            </section>

            {/* Row 1 col 2–4: Quality, Balance Sheet, Cash Flow */}
            {(['quality', 'balance', 'cashflow'] as const).map((gk) => {
              const gLabel = EXT_GROUP_LABELS[gk]
              const items = EXT_COND_CATALOG.filter(c => c.group === gk)
              const activeCount = items.filter(c => condFilter.has(c.id)).length
              return (
                <section key={gk} className={`ssp-card ssp-card--group-${gk}`}>
                  <header className="ssp-card-head ssp-card-head--tight">
                    <h3 className={`ssp-card-title ssp-group-title--${gk}`}>
                      {gLabel}
                      {activeCount > 0 && <span className="ssp-filter-tab-badge" style={{ marginLeft: 4 }}>{activeCount}</span>}
                    </h3>
                    {activeCount > 0 && (
                      <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => clearExtGroupFilter(gk)}>Clear</button>
                    )}
                  </header>
                  <div className="ssp-cond-chips-row">
                    {items.map(({ id, label }) => {
                      const active = condFilter.has(id)
                      return (
                        <button key={id} type="button"
                          className={`ssp-cond-chip ssp-cond-chip--ext-${gk}${active ? ' ssp-cond-chip--active' : ''}`}
                          onClick={() => toggleCondFilter(id)}
                          title={active ? `Remove ${label}` : `Add ${label}`}
                        >
                          <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                          <span className="ssp-cond-chip-label">{label}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}

            {/* Row 2 col 2: Efficiency */}
            {/* Row 2 col 3: Sentiment */}
            {(['efficiency', 'sentiment'] as const).map((gk) => {
              const gLabel = EXT_GROUP_LABELS[gk]
              const items = EXT_COND_CATALOG.filter(c => c.group === gk)
              const activeCount = items.filter(c => condFilter.has(c.id)).length
              return (
                <section key={gk} className={`ssp-card ssp-card--group-${gk}`}>
                  <header className="ssp-card-head ssp-card-head--tight">
                    <h3 className={`ssp-card-title ssp-group-title--${gk}`}>
                      {gLabel}
                      {activeCount > 0 && <span className="ssp-filter-tab-badge" style={{ marginLeft: 4 }}>{activeCount}</span>}
                    </h3>
                    {activeCount > 0 && (
                      <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => clearExtGroupFilter(gk)}>Clear</button>
                    )}
                  </header>
                  <div className="ssp-cond-chips-row">
                    {items.map(({ id, label }) => {
                      const active = condFilter.has(id)
                      return (
                        <button key={id} type="button"
                          className={`ssp-cond-chip ssp-cond-chip--ext-${gk}${active ? ' ssp-cond-chip--active' : ''}`}
                          onClick={() => toggleCondFilter(id)}
                          title={active ? `Remove ${label}` : `Add ${label}`}
                        >
                          <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                          <span className="ssp-cond-chip-label">{label}</span>
                        </button>
                      )
                    })}
                  </div>
                </section>
              )
            })}

            {/* Row 2 col 4: Valuation + Profitability stacked */}
            <div className="ssp-fund-cell-stacked">
              {(['valuation', 'profitability'] as const).map((gk) => {
                const gLabel = EXT_GROUP_LABELS[gk]
                const items = EXT_COND_CATALOG.filter(c => c.group === gk)
                const activeCount = items.filter(c => condFilter.has(c.id)).length
                return (
                  <section key={gk} className={`ssp-card ssp-card--group-${gk}`}>
                    <header className="ssp-card-head ssp-card-head--tight">
                      <h3 className={`ssp-card-title ssp-group-title--${gk}`}>
                        {gLabel}
                        {activeCount > 0 && <span className="ssp-filter-tab-badge" style={{ marginLeft: 4 }}>{activeCount}</span>}
                      </h3>
                      {activeCount > 0 && (
                        <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => clearExtGroupFilter(gk)}>Clear</button>
                      )}
                    </header>
                    <div className="ssp-cond-chips-row">
                      {items.map(({ id, label }) => {
                        const active = condFilter.has(id)
                        return (
                          <button key={id} type="button"
                            className={`ssp-cond-chip ssp-cond-chip--ext-${gk}${active ? ' ssp-cond-chip--active' : ''}`}
                            onClick={() => toggleCondFilter(id)}
                            title={active ? `Remove ${label}` : `Add ${label}`}
                          >
                            <span className="ssp-cond-chip-check" aria-hidden>{active ? '✓' : ''}</span>
                            <span className="ssp-cond-chip-label">{label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </section>
                )
              })}
            </div>

          </div>{/* end ssp-fund-right-grid */}
        </div>{/* end ssp-fund-layout */}

      </div>{/* end Fundamental section */}

      {/* Filter action bar */}
      {anyFilterActive && (
        <div className="ssp-filter-bar">
          <div className="ssp-filter-bar-info">
            {condFilter.size > 0 && <span className="ssp-filter-bar-tag ssp-filter-bar-tag--fund">{condFilter.size} Fundamental</span>}
            {condFilter.size > 0 && techCondFilter.size > 0 && <span className="ssp-filter-bar-and">∩</span>}
            {techCondFilter.size > 0 && <span className="ssp-filter-bar-tag ssp-filter-bar-tag--tech">{techCondFilter.size} Technical</span>}
            {tierActiveCount > 0 && (condFilter.size > 0 || techCondFilter.size > 0) && <span className="ssp-filter-bar-and">∩</span>}
            {(['momentum', 'structure', 'sentiment'] as TierKey[]).map((tk) => {
              const f = tierFilters[tk]
              const n = f.indicators.size + (f.minScore > 0 ? 1 : 0)
              if (n === 0) return null
              return <span key={tk} className={`ssp-filter-bar-tag ssp-filter-bar-tag--${tk}`}>{n} {tk.charAt(0).toUpperCase() + tk.slice(1)}</span>
            })}
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
          {!filterPreview && (
            <button type="button" className="ssp-btn ssp-btn--secondary" onClick={() => void previewFilter()} disabled={filterLoading}>
              {filterLoading ? 'Searching…' : 'Search'}
            </button>
          )}
          {filterPreview && <button type="button" className="ssp-btn ssp-btn--primary" onClick={applyFilter}>Apply ({filterPreview.symbols.length})</button>}
          {filterPreview && <button type="button" className="ssp-btn ssp-btn--ghost" onClick={() => setFilterPreview(null)}>Retry</button>}
          <button type="button" className="ssp-btn ssp-btn--ghost" onClick={clearAllFilters}>Clear</button>
        </div>
      )}

      {/* Symbols strip */}
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
            onChange={(e) => { setActiveBucket(null); setActiveTechBucket(null); setFilterPreview(null); setSymbolText(e.target.value) }}
            placeholder="AAPL,MSFT,NVDA  — or select conditions above"
          />
        </div>
        <div className="ssp-symbols-strip-meta">
          <span className="ssp-symbols-strip-count"><span className="ssp-num--dim">Parsed </span><strong>{symbols.length}</strong></span>
          {summary && (
            <>
              <span className="ssp-symbols-strip-sep" />
              <span><span className="ssp-num--dim">Found </span><strong>{summary.found}</strong><span className="ssp-num--dim">/{summary.total}</span></span>
              <span className="ssp-results-summary-good">F8/8 <strong>{summary.fundPass}</strong></span>
              {summary.techPass > 0 && <span className="ssp-results-summary-tech">T11/11 <strong>{summary.techPass}</strong></span>}
              {summary.insufficient > 0 && <span className="ssp-results-summary-warn">insuff <strong>{summary.insufficient}</strong></span>}
            </>
          )}
          {readinessError && <span className="ssp-status-err">{readinessError}</span>}
        </div>
      </div>

      {/* Results table */}
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
                <th className={`ssp-th-sortable${sortCol === 'tech' ? ' ssp-th-sortable--active' : ''}`} onClick={() => toggleSort('tech')} title="Sort by Technical pass count">
                  Technical {sortCol === 'tech' ? (sortDir === 'desc' ? '↓' : '↑') : '⇅'}
                </th>
                <th className={`ssp-th-sortable${sortCol === 'fund' ? ' ssp-th-sortable--active' : ''}`} onClick={() => toggleSort('fund')} title="Sort by Fundamental pass count">
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
                    {readinessLoading ? 'Loading readiness…'
                      : symbols.length === 0 ? 'Select a distribution bucket, apply a condition filter, or type symbols below.'
                      : readinessError ? 'Failed to load readiness — see error above.'
                      : 'No readiness rows found.'}
                  </td>
                </tr>
              )}
              {sortedRows.map((r) => {
                if (!r.found) {
                  return (
                    <tr key={r.symbol} className="ssp-row-missing">
                      <td>
                        <button type="button" className="ssp-sym-open" onClick={() => openInspector(r.symbol)} title={`Open ${r.symbol} inspector`}>{r.symbol}</button>
                      </td>
                      <td colSpan={7} className="ssp-num--dim">No row in stock_readiness_daily — run the universe snapshot from Stock Data Readiness.</td>
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
                const fundCls = insuf ? 'ssp-fund-cell--insuf' : passCount === 8 ? 'ssp-fund-cell--all' : passCount >= 5 ? 'ssp-fund-cell--good' : passCount >= 2 ? 'ssp-fund-cell--warn' : 'ssp-fund-cell--poor'
                const techCls = !techEvalPresent ? 'ssp-fund-cell--insuf' : techInsuf ? 'ssp-fund-cell--insuf' : techPassCount === 11 ? 'ssp-fund-cell--all' : techPassCount >= 8 ? 'ssp-fund-cell--good' : techPassCount >= 5 ? 'ssp-fund-cell--warn' : 'ssp-fund-cell--poor'
                const isActive = inspector?.symbol === r.symbol
                const seed: InspectorSeed = { passCount, passedConditions: Array.from(passed) }
                return (
                  <tr key={r.symbol} className={isActive ? 'ssp-row-active' : ''}>
                    <td>
                      <button type="button" className="ssp-sym-open" onClick={() => openInspector(r.symbol, seed)} title={isActive ? 'Close inspector' : `Open ${r.symbol} inspector`}>
                        {r.symbol}<span className="ssp-sym-open-hint" aria-hidden>↗</span>
                      </button>
                    </td>
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
                                <span key={id} className={`ssp-cond-dot ssp-cond-dot--tech-${group}${pass ? ' ssp-cond-dot--pass' : ' ssp-cond-dot--fail'}${techInsuf ? ' ssp-cond-dot--dim' : ''}`} title={`${short}: ${techInsuf ? 'insufficient' : pass ? 'pass' : 'fail'}`}>{pass ? '✓' : ''}</span>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    </td>
                    <td>
                      <div className="ssp-cond-col">
                        <span className={`ssp-fund-cell ${fundCls}`} title={insuf ? 'Insufficient data' : `${passCount}/8 passed`}>{insuf ? 'INS' : `${passCount}/8`}</span>
                        <div className="ssp-cond-dots">
                          {SEPA_COND_CATALOG.map(({ id, short, group }) => {
                            const pass = passed.has(id)
                            return (
                              <span key={id} className={`ssp-cond-dot ssp-cond-dot--${group}${pass ? ' ssp-cond-dot--pass' : ' ssp-cond-dot--fail'}${insuf ? ' ssp-cond-dot--dim' : ''}`} title={`${short}: ${insuf ? 'insufficient' : pass ? 'pass' : 'fail'}`}>{pass ? '✓' : ''}</span>
                            )
                          })}
                        </div>
                      </div>
                    </td>
                    <td style={{ textAlign: 'center' }}>{boolMark(r.included_in_universe)}</td>
                    <td>
                      <span className="ssp-data-pair">{boolMark(r.price_ready)}<span className="ssp-num--dim">{(r.bar_count_lookback ?? 0).toLocaleString()}b</span></span>
                    </td>
                    <td>
                      <div className="ssp-stmt-row">
                        <span className={`ssp-stmt-chip${r.income_stmt_ready ? ' ssp-stmt-chip--ok' : ''}`} title={`Income: ${r.income_stmt_q_count ?? 0}Q · ${r.income_stmt_a_count ?? 0}A`}>IS</span>
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

      <RightInspectorDrawer open={inspector != null} ariaLabel="Stock detail">
        {inspector && (
          <StockInspectorPanel symbol={inspector.symbol} fundamentalSeed={inspector.seed} onClose={closeInspector} />
        )}
      </RightInspectorDrawer>
    </div>
  )
}
