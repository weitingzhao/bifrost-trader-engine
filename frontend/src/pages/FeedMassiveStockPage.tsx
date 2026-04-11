import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchMassiveReferenceTickers,
  fetchMassiveRelatedCompanies,
  fetchMassiveStatus,
  fetchMassiveStockBarsRange,
  fetchMassiveStockGroupedDaily,
  fetchMassiveStockOpenClose,
  fetchMassiveStockPrev,
  fetchMassiveTickerDetail,
  fetchMassiveTickerTypes,
  postMassiveStocksApiCoverageSync,
} from '../api'
import type { MassiveStatusResponse } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import stockChecklistRows from './massiveStockFeedChecklistRows'
import type { ChecklistRow } from './massiveStockFeedChecklistRows'
import { CAPABILITY_GROUP_LABELS, CAPABILITY_GROUP_ORDER, type CapabilityGroup } from './massiveStockFeedChecklistRows'
import {
  feedMassiveStockSvcAnchorId,
  parseFeedMassiveStockSvcFromHash,
  parseFeedMassiveStockTabFromHash,
  parseFeedMassiveStockTickersSubTabFromHash,
} from './massive/feedMassiveStockTabUtils'
import {
  checklistEffectiveStatusLabel,
  effectiveChecklistProjectStatus,
  groupedStockChecklistRows,
  shortServiceLabel,
  stockCapabilityGroupForRowId,
  tierOkForRow,
  tradesOkForRow,
  type EffectiveServiceStatus,
} from './massive/massiveStockChecklistStatus'
import { FeedMassiveServiceBlock } from './massive/FeedMassiveServiceBlock'
import { MassiveTickerReferenceDbSection } from './massive/MassiveTickerReferenceDbSection'

/** `frontend/public/plans/` — must respect Vite `base` so `/plans/...` works when not deployed at domain root. */
const MASSIVE_STOCKS_COVERAGE_PLAN_URL = `${import.meta.env.BASE_URL}plans/massive_stocks_api_coverage.html`

// ── Helpers ────────────────────────────────────────────────────────────────

function overviewDotClass(eff: EffectiveServiceStatus): string {
  if (eff === 'implemented') return 'feed-massive-tab-dot feed-massive-tab-dot--ok'
  if (eff === 'partial') return 'feed-massive-tab-dot feed-massive-tab-dot--partial'
  if (eff === 'not-on-tier') return 'feed-massive-tab-dot feed-massive-tab-dot--tier'
  return 'feed-massive-tab-dot feed-massive-tab-dot--fail'
}

const REST_SECTION_ORDER = [
  'stock-tickers',
  'stock-aggregates',
  'stock-snapshots',
  'stock-trades-quotes',
  'stock-technical-indicators',
  'stock-market-ops',
  'stock-corporate-actions',
  'stock-fundamentals',
  'stock-filings',
  'stock-news',
] as const

const REST_SECTION_LABELS: Record<string, string> = {
  'stock-tickers': 'Tickers',
  'stock-aggregates': 'Aggregate Bars (OHLC)',
  'stock-snapshots': 'Snapshots',
  'stock-trades-quotes': 'Trades & Quotes',
  'stock-technical-indicators': 'Technical Indicators',
  'stock-market-ops': 'Market Operations',
  'stock-corporate-actions': 'Corporate Actions',
  'stock-fundamentals': 'Fundamentals',
  'stock-filings': 'Filings & Disclosures',
  'stock-news': 'News',
}

// ── Capability Panel (mirrors FeedMassiveCapabilityPanel from Options page) ─

interface StockCapabilityPanelProps {
  capId: string
  checklistRow: ChecklistRow
  effectiveStatus: EffectiveServiceStatus
  expanded: boolean
  onToggle: () => void
  highlight: boolean
  ariaLabel: string
  children: ReactNode
}

function StockCapabilityPanel({
  capId,
  checklistRow,
  effectiveStatus,
  expanded,
  onToggle,
  highlight,
  ariaLabel,
  children,
}: StockCapabilityPanelProps) {
  const statusWords = checklistEffectiveStatusLabel(effectiveStatus)
  return (
    <section
      id={feedMassiveStockSvcAnchorId(capId)}
      className={`feed-massive-card feed-massive-cap-section${expanded ? ' feed-massive-cap-section--expanded' : ' feed-massive-cap-section--collapsed'}${highlight ? ' feed-massive-card--cap-active' : ''}`}
      aria-label={ariaLabel}
    >
      <div className="feed-massive-cap-panel-header">
        <button
          type="button"
          className="feed-massive-cap-panel-toggle"
          aria-expanded={expanded}
          aria-controls={`feed-massive-stock-cap-body-${capId}`}
          id={`feed-massive-stock-cap-head-${capId}`}
          onClick={onToggle}
        >
          <span
            className={`feed-massive-cap-panel-chevron${expanded ? ' feed-massive-cap-panel-chevron--open' : ''}`}
            aria-hidden
          />
          <span className="feed-massive-cap-panel-title">{shortServiceLabel(checklistRow)}</span>
          <span
            className={overviewDotClass(effectiveStatus)}
            title={statusWords}
            aria-label={`Status: ${statusWords}`}
          />
        </button>
      </div>
      {expanded ? (
        <div
          id={`feed-massive-stock-cap-body-${capId}`}
          className="feed-massive-cap-panel-body"
          role="region"
          aria-labelledby={`feed-massive-stock-cap-head-${capId}`}
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}

// ── Page props ─────────────────────────────────────────────────────────────

interface FeedMassiveStockPageProps {
  status: StatusResponse | null
  onGoToFeed?: () => void
  breadcrumbLabel?: string
}

// ── Main Page ──────────────────────────────────────────────────────────────

export function FeedMassiveStockPage({
  status: _status,
  onGoToFeed,
  breadcrumbLabel = 'Massive Stock',
}: FeedMassiveStockPageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [highlightedCapabilityId, setHighlightedCapabilityId] = useState<string | null>(null)
  const [capNavGroupExpanded, setCapNavGroupExpanded] = useState<Record<CapabilityGroup, boolean>>(() =>
    CAPABILITY_GROUP_ORDER.reduce((acc, g) => { acc[g] = true; return acc }, {} as Record<CapabilityGroup, boolean>),
  )
  const [capExpanded, setCapExpanded] = useState<Record<string, boolean>>({})

  const [apiCoverageOpen, setApiCoverageOpen] = useState(false)
  const [apiCoverageSyncBusy, setApiCoverageSyncBusy] = useState(false)
  const [apiCoverageSyncMsg, setApiCoverageSyncMsg] = useState<string | null>(null)

  // ── Tickers sub-tab state ─────────────────────────────────────────────────
  const [tkSubTab, setTkSubTab] = useState<
    'all_tickers' | 'ticker_overview' | 'ticker_types' | 'related_tickers' | 'reference_db'
  >('all_tickers')

  // All Tickers form fields
  const [tkAllTicker, setTkAllTicker] = useState('')
  const [tkAllMarket, setTkAllMarket] = useState('')
  const [tkAllType, setTkAllType] = useState('')
  const [tkAllExchange, setTkAllExchange] = useState('')
  const [tkAllSearch, setTkAllSearch] = useState('')
  const [tkAllActive, setTkAllActive] = useState('')
  const [tkAllDate, setTkAllDate] = useState('')
  const [tkAllLimit, setTkAllLimit] = useState('100')
  const [tkAllCursor, setTkAllCursor] = useState('')

  const [tkAllBusy, setTkAllBusy] = useState(false)
  const [tkAllErr, setTkAllErr] = useState<string | null>(null)
  const [tkAllResult, setTkAllResult] = useState<Record<string, unknown> | null>(null)

  const [tkOvBusy, setTkOvBusy] = useState(false)
  const [tkOvErr, setTkOvErr] = useState<string | null>(null)
  const [tkOvResult, setTkOvResult] = useState<Record<string, unknown> | null>(null)

  const [tkTypesBusy, setTkTypesBusy] = useState(false)
  const [tkTypesErr, setTkTypesErr] = useState<string | null>(null)
  const [tkTypesResult, setTkTypesResult] = useState<Record<string, unknown> | null>(null)

  const [tkRelBusy, setTkRelBusy] = useState(false)
  const [tkRelErr, setTkRelErr] = useState<string | null>(null)
  const [tkRelResult, setTkRelResult] = useState<Record<string, unknown> | null>(null)

  // Ticker Overview form fields
  const [tkOvTicker, setTkOvTicker] = useState('AAPL')
  const [tkOvDate, setTkOvDate] = useState('')

  // Ticker Types form fields
  const [tkTypesAssetClass, setTkTypesAssetClass] = useState('')
  const [tkTypesLocale, setTkTypesLocale] = useState('')

  // Related Tickers form fields
  const [tkRelTicker, setTkRelTicker] = useState('AAPL')

  // Aggregate Bars (OHLC) sub-tabs
  const [aggSubTab, setAggSubTab] = useState<'custom_bars' | 'grouped_daily' | 'open_close' | 'prev'>('custom_bars')
  const [aggStTicker, setAggStTicker] = useState('AAPL')
  const [aggStMult, setAggStMult] = useState('1')
  const [aggStTs, setAggStTs] = useState('minute')
  const [aggStStartMs, setAggStStartMs] = useState('')
  const [aggStEndMs, setAggStEndMs] = useState('')
  const [aggStBusy, setAggStBusy] = useState(false)
  const [aggStErr, setAggStErr] = useState<string | null>(null)
  const [aggStResult, setAggStResult] = useState<Record<string, unknown> | null>(null)

  const [gdDate, setGdDate] = useState('2024-06-03')
  const [gdBusy, setGdBusy] = useState(false)
  const [gdErr, setGdErr] = useState<string | null>(null)
  const [gdResult, setGdResult] = useState<Record<string, unknown> | null>(null)

  const [ocStTicker, setOcStTicker] = useState('AAPL')
  const [ocDate, setOcDate] = useState('2024-06-03')
  const [ocBusy, setOcBusy] = useState(false)
  const [ocErr, setOcErr] = useState<string | null>(null)
  const [ocResult, setOcResult] = useState<Record<string, unknown> | null>(null)

  const [prevStTicker, setPrevStTicker] = useState('AAPL')
  const [prevBusy, setPrevBusy] = useState(false)
  const [prevErr, setPrevErr] = useState<string | null>(null)
  const [prevResult, setPrevResult] = useState<Record<string, unknown> | null>(null)

  const loadStatus = useCallback(async () => {
    try { setMassiveStatus(await fetchMassiveStatus()) } catch { /* ignore */ }
  }, [])

  useEffect(() => { loadStatus() }, [loadStatus])

  const runTkAllTickers = useCallback(async () => {
    setTkAllBusy(true)
    setTkAllErr(null)
    setTkAllResult(null)
    try {
      const lim = Math.min(1000, Math.max(1, parseInt(tkAllLimit, 10) || 100))
      let active: boolean | undefined
      if (tkAllActive === 'true') active = true
      else if (tkAllActive === 'false') active = false
      const res = await fetchMassiveReferenceTickers({
        ticker: tkAllTicker.trim() || undefined,
        type: tkAllType.trim() || undefined,
        market: tkAllMarket.trim() || undefined,
        exchange: tkAllExchange.trim() || undefined,
        search: tkAllSearch.trim() || undefined,
        active,
        date: tkAllDate.trim() || undefined,
        limit: lim,
        cursor: tkAllCursor.trim() || undefined,
      })
      if (!res.ok) {
        setTkAllErr(res.error ?? 'Request failed')
        return
      }
      setTkAllResult(res.data ?? null)
    } catch (e: unknown) {
      setTkAllErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTkAllBusy(false)
    }
  }, [
    tkAllTicker, tkAllType, tkAllMarket, tkAllExchange, tkAllSearch, tkAllActive,
    tkAllDate, tkAllLimit, tkAllCursor,
  ])

  const runTkOverview = useCallback(async () => {
    const t = tkOvTicker.trim()
    if (!t) {
      setTkOvErr('Ticker is required')
      return
    }
    setTkOvBusy(true)
    setTkOvErr(null)
    setTkOvResult(null)
    try {
      const res = await fetchMassiveTickerDetail(t, { date: tkOvDate.trim() || undefined })
      if (!res.ok) {
        setTkOvErr(res.error ?? 'Request failed')
        return
      }
      setTkOvResult(res.data ?? null)
    } catch (e: unknown) {
      setTkOvErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTkOvBusy(false)
    }
  }, [tkOvTicker, tkOvDate])

  const runTkTypes = useCallback(async () => {
    setTkTypesBusy(true)
    setTkTypesErr(null)
    setTkTypesResult(null)
    try {
      const res = await fetchMassiveTickerTypes({
        asset_class: tkTypesAssetClass.trim() || undefined,
        locale: tkTypesLocale.trim() || undefined,
      })
      if (!res.ok) {
        setTkTypesErr(res.error ?? 'Request failed')
        return
      }
      setTkTypesResult(res.data ?? null)
    } catch (e: unknown) {
      setTkTypesErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTkTypesBusy(false)
    }
  }, [tkTypesAssetClass, tkTypesLocale])

  const runTkRelated = useCallback(async () => {
    const t = tkRelTicker.trim()
    if (!t) {
      setTkRelErr('Ticker is required')
      return
    }
    setTkRelBusy(true)
    setTkRelErr(null)
    setTkRelResult(null)
    try {
      const res = await fetchMassiveRelatedCompanies(t)
      if (!res.ok) {
        setTkRelErr(res.error ?? 'Request failed')
        return
      }
      setTkRelResult(res.data ?? null)
    } catch (e: unknown) {
      setTkRelErr(e instanceof Error ? e.message : String(e))
    } finally {
      setTkRelBusy(false)
    }
  }, [tkRelTicker])

  const runAggCustom = useCallback(async () => {
    const t = aggStTicker.trim()
    if (!t) {
      setAggStErr('Ticker is required')
      return
    }
    const startMs = parseInt(aggStStartMs.trim(), 10)
    const endMs = parseInt(aggStEndMs.trim(), 10)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      setAggStErr('Start and end must be Unix timestamps in milliseconds')
      return
    }
    const mult = parseInt(aggStMult.trim(), 10) || 1
    setAggStBusy(true)
    setAggStErr(null)
    setAggStResult(null)
    try {
      const res = await fetchMassiveStockBarsRange({
        ticker: t,
        multiplier: mult,
        timespan: aggStTs.trim() || 'minute',
        start_ms: startMs,
        end_ms: endMs,
      })
      if (!res.ok) {
        setAggStErr(res.error ?? 'Request failed')
        return
      }
      setAggStResult(res.data ?? null)
    } catch (e: unknown) {
      setAggStErr(e instanceof Error ? e.message : String(e))
    } finally {
      setAggStBusy(false)
    }
  }, [aggStTicker, aggStMult, aggStTs, aggStStartMs, aggStEndMs])

  const runAggGrouped = useCallback(async () => {
    const d = gdDate.trim()
    if (!d) {
      setGdErr('Date is required (YYYY-MM-DD)')
      return
    }
    setGdBusy(true)
    setGdErr(null)
    setGdResult(null)
    try {
      const res = await fetchMassiveStockGroupedDaily(d)
      if (!res.ok) {
        setGdErr(res.error ?? 'Request failed')
        return
      }
      setGdResult(res.data ?? null)
    } catch (e: unknown) {
      setGdErr(e instanceof Error ? e.message : String(e))
    } finally {
      setGdBusy(false)
    }
  }, [gdDate])

  const runAggOpenClose = useCallback(async () => {
    const t = ocStTicker.trim()
    const d = ocDate.trim()
    if (!t || !d) {
      setOcErr('Ticker and date are required')
      return
    }
    setOcBusy(true)
    setOcErr(null)
    setOcResult(null)
    try {
      const res = await fetchMassiveStockOpenClose(t, d)
      if (!res.ok) {
        setOcErr(res.error ?? 'Request failed')
        return
      }
      setOcResult(res.data ?? null)
    } catch (e: unknown) {
      setOcErr(e instanceof Error ? e.message : String(e))
    } finally {
      setOcBusy(false)
    }
  }, [ocStTicker, ocDate])

  const runAggPrev = useCallback(async () => {
    const t = prevStTicker.trim()
    if (!t) {
      setPrevErr('Ticker is required')
      return
    }
    setPrevBusy(true)
    setPrevErr(null)
    setPrevResult(null)
    try {
      const res = await fetchMassiveStockPrev(t)
      if (!res.ok) {
        setPrevErr(res.error ?? 'Request failed')
        return
      }
      setPrevResult(res.data ?? null)
    } catch (e: unknown) {
      setPrevErr(e instanceof Error ? e.message : String(e))
    } finally {
      setPrevBusy(false)
    }
  }, [prevStTicker])

  const toggleCap = useCallback((id: string) => {
    setCapExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const scrollToSection = useCallback((id: string) => {
    setHighlightedCapabilityId(id)
    setCapExpanded(prev => ({ ...prev, [id]: true }))
    const g = stockCapabilityGroupForRowId(id)
    if (g) setCapNavGroupExpanded(prev => prev[g] ? prev : { ...prev, [g]: true })
    setTimeout(() => {
      document.getElementById(feedMassiveStockSvcAnchorId(id))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
  }, [])

  useEffect(() => {
    const applyMassiveStockHash = () => {
      const raw = window.location.hash
      const tkSub = parseFeedMassiveStockTickersSubTabFromHash(raw)
      if (tkSub) {
        setTkSubTab(tkSub)
        requestAnimationFrame(() => scrollToSection('stock-tickers'))
        return
      }
      const fromTab = parseFeedMassiveStockTabFromHash(raw)
      const fromSvc = parseFeedMassiveStockSvcFromHash(raw)
      const id =
        (fromTab && stockChecklistRows.some(r => r.id === fromTab) ? fromTab : null) ??
        (fromSvc && stockChecklistRows.some(r => r.id === fromSvc) ? fromSvc : null)
      if (id) {
        requestAnimationFrame(() => scrollToSection(id))
      } else {
        setHighlightedCapabilityId(null)
      }
    }
    applyMassiveStockHash()
    window.addEventListener('hashchange', applyMassiveStockHash)
    return () => window.removeEventListener('hashchange', applyMassiveStockHash)
  }, [scrollToSection])

  useEffect(() => {
    if (!highlightedCapabilityId) return
    const t = setTimeout(() => setHighlightedCapabilityId(null), 2200)
    return () => clearTimeout(t)
  }, [highlightedCapabilityId])

  const configured = Boolean(massiveStatus?.configured)

  // ── Derive per-row effective status ──────────────────────────────────────
  function rowEff(row: ChecklistRow): EffectiveServiceStatus {
    return effectiveChecklistProjectStatus(
      row, configured,
      tierOkForRow(row, massiveStatus, configured),
      tradesOkForRow(row, massiveStatus),
    )
  }

  function rowById(id: string): ChecklistRow {
    const r = stockChecklistRows.find(x => x.id === id)
    if (!r) throw new Error(`Stock checklist row not found: ${id}`)
    return r
  }

  // ── Evidence helper ───────────────────────────────────────────────────────
  function evidenceFor(row: ChecklistRow): ReactNode {
    if (row.id === 'stock-tickers' && row.projectStatus === 'implemented') {
      return (
        <span className="feed-massive-svc-evidence-ok">
          REST proxy on the Massive server: use Execute on each Tickers sub-tab to call Polygon and inspect the JSON response.
        </span>
      )
    }
    if (row.id === 'stock-aggregates' && row.projectStatus === 'implemented') {
      return (
        <span className="feed-massive-svc-evidence-ok">
          REST proxy on the Massive server: use Execute on each Aggregate Bars sub-tab to call Polygon OHLC endpoints and inspect the JSON response.
        </span>
      )
    }
    if (row.projectStatus === 'implemented') {
      return (
        <span className="feed-massive-svc-evidence-ok">
          Shared implementation via Massive Option page. Use the existing UI with stock tickers.
        </span>
      )
    }
    return (
      <span className="feed-massive-svc-evidence-pending">
        Not yet implemented for stocks. See coverage sheet for target endpoints.
      </span>
    )
  }

  // ── Render Tickers section with 4 sub-tabs ───────────────────────────────
  function renderTickersCap() {
    const id = 'stock-tickers'
    const row = rowById(id)
    const eff = rowEff(row)
    return (
      <StockCapabilityPanel
        key={id}
        capId={id}
        checklistRow={row}
        effectiveStatus={eff}
        expanded={capExpanded[id] === true}
        onToggle={() => toggleCap(id)}
        highlight={highlightedCapabilityId === id}
        ariaLabel={row.service}
      >
        <FeedMassiveServiceBlock effectiveStatus={eff} checklistRow={row} evidence={evidenceFor(row)}>
          <div className="feed-massive-card-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className="feed-massive-card-icon" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M6 7h8M6 10h5M6 13h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </span>
              <h3>{row.service}</h3>
            </div>
          </div>
          <p className="feed-massive-card-lead">{row.description}</p>
        </FeedMassiveServiceBlock>

        <div className="feed-massive-agg-tabs-wrap">
          <div className="feed-massive-agg-tabs" role="tablist" aria-label="Tickers API and PostgreSQL reference">
            <button
              type="button" role="tab"
              id="feed-massive-stk-tk-tab-all"
              className={`feed-massive-agg-tab${tkSubTab === 'all_tickers' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={tkSubTab === 'all_tickers'}
              tabIndex={tkSubTab === 'all_tickers' ? 0 : -1}
              onClick={() => setTkSubTab('all_tickers')}
            >
              All Tickers
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button" role="tab"
              id="feed-massive-stk-tk-tab-overview"
              className={`feed-massive-agg-tab${tkSubTab === 'ticker_overview' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={tkSubTab === 'ticker_overview'}
              tabIndex={tkSubTab === 'ticker_overview' ? 0 : -1}
              onClick={() => setTkSubTab('ticker_overview')}
            >
              Ticker Overview
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button" role="tab"
              id="feed-massive-stk-tk-tab-types"
              className={`feed-massive-agg-tab${tkSubTab === 'ticker_types' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={tkSubTab === 'ticker_types'}
              tabIndex={tkSubTab === 'ticker_types' ? 0 : -1}
              onClick={() => setTkSubTab('ticker_types')}
            >
              Ticker Types
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button" role="tab"
              id="feed-massive-stk-tk-tab-related"
              className={`feed-massive-agg-tab${tkSubTab === 'related_tickers' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={tkSubTab === 'related_tickers'}
              tabIndex={tkSubTab === 'related_tickers' ? 0 : -1}
              onClick={() => setTkSubTab('related_tickers')}
            >
              Related Tickers
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button" role="tab"
              id="feed-massive-stk-tk-tab-refdb"
              className={`feed-massive-agg-tab${tkSubTab === 'reference_db' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={tkSubTab === 'reference_db'}
              tabIndex={tkSubTab === 'reference_db' ? 0 : -1}
              onClick={() => setTkSubTab('reference_db')}
            >
              Reference (DB)
              <span className="feed-massive-agg-tab-badge">PG</span>
            </button>
          </div>

          <div className="feed-massive-agg-tab-panels">

            {/* ── All Tickers ─────────────────────────────────────────────── */}
            {tkSubTab === 'all_tickers' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-tk-panel-all"
                aria-labelledby="feed-massive-stk-tk-tab-all"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve a comprehensive list of ticker symbols supported by Massive
                    across all asset classes — stocks, indices, forex, crypto. Filter by market type, instrument type,
                    exchange MIC, keyword search, or active status. Supports cursor pagination up to 1,000 results per page.
                  </p>
                  <p>
                    <strong>When to use:</strong> Building a ticker universe for screening, asset discovery pipelines,
                    or populating reference tables with the full Massive coverage set.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/reference/tickers</code></p>
                </div>

                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker</span>
                    <input
                      className="form-input"
                      value={tkAllTicker}
                      onChange={e => setTkAllTicker(e.target.value)}
                      disabled={!configured || tkAllBusy}
                      placeholder="AAPL"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Market</span>
                    <select
                      className="form-input"
                      value={tkAllMarket}
                      onChange={e => setTkAllMarket(e.target.value)}
                      disabled={!configured || tkAllBusy}
                    >
                      <option value="">All markets</option>
                      <option value="stocks">Stocks</option>
                      <option value="crypto">Crypto</option>
                      <option value="fx">FX</option>
                      <option value="otc">OTC</option>
                      <option value="indices">Indices</option>
                    </select>
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Type</span>
                    <input
                      className="form-input"
                      value={tkAllType}
                      onChange={e => setTkAllType(e.target.value)}
                      disabled={!configured || tkAllBusy}
                      placeholder="CS (Common Stock)"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Exchange (MIC)</span>
                    <input
                      className="form-input"
                      value={tkAllExchange}
                      onChange={e => setTkAllExchange(e.target.value)}
                      disabled={!configured || tkAllBusy}
                      placeholder="XNAS"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Search</span>
                    <input
                      className="form-input"
                      value={tkAllSearch}
                      onChange={e => setTkAllSearch(e.target.value)}
                      disabled={!configured || tkAllBusy}
                      placeholder="Apple"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Active</span>
                    <select
                      className="form-input"
                      value={tkAllActive}
                      onChange={e => setTkAllActive(e.target.value)}
                      disabled={!configured || tkAllBusy}
                    >
                      <option value="">Default (active)</option>
                      <option value="true">Active only</option>
                      <option value="false">Delisted only</option>
                    </select>
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Date</span>
                    <input
                      className="form-input"
                      value={tkAllDate}
                      onChange={e => setTkAllDate(e.target.value)}
                      disabled={!configured || tkAllBusy}
                      placeholder="YYYY-MM-DD"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input
                      className="form-input"
                      type="number"
                      value={tkAllLimit}
                      onChange={e => setTkAllLimit(e.target.value)}
                      disabled={!configured || tkAllBusy}
                      min={1}
                      max={1000}
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Cursor</span>
                    <input
                      className="form-input"
                      value={tkAllCursor}
                      onChange={e => setTkAllCursor(e.target.value)}
                      disabled={!configured || tkAllBusy}
                      placeholder="Next page (from response)"
                      autoComplete="off"
                    />
                  </label>
                </div>

                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-3)' }}>
                  <p>
                    <strong>Key response fields:</strong>{' '}
                    <code>ticker</code>, <code>name</code>, <code>market</code>, <code>locale</code>,{' '}
                    <code>primary_exchange</code>, <code>type</code>, <code>active</code>,{' '}
                    <code>currency_name</code>, <code>composite_figi</code>, <code>cik</code>,{' '}
                    <code>last_updated_utc</code>, <code>delisted_utc</code>
                  </p>
                  <p style={{ marginTop: 'var(--space-2)' }}>
                    <strong>Proxy:</strong> <code>GET /research/massive/tickers</code>
                  </p>
                </div>

                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || tkAllBusy} onClick={runTkAllTickers}>
                    {tkAllBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {tkAllErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkAllErr}</p> : null}
                {tkAllResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>
                      Result
                      {Array.isArray(tkAllResult.results)
                        ? ` — ${tkAllResult.results.length} ticker(s)`
                        : ''}
                    </summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(tkAllResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {/* ── Ticker Overview ──────────────────────────────────────────── */}
            {tkSubTab === 'ticker_overview' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-tk-panel-overview"
                aria-labelledby="feed-massive-stk-tk-tab-overview"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve comprehensive details for a single ticker: primary exchange,
                    standardized identifiers (CIK, composite FIGI, share class FIGI), market capitalization, SIC
                    industry classification, headquarters address, employee count, and branding assets (logo and
                    icon URLs). Also returns <code>ticker_root</code> and <code>ticker_suffix</code> for share-class
                    disambiguation (e.g. BRK.A vs BRK.B).
                  </p>
                  <p>
                    <strong>When to use:</strong> Company due diligence, enriching UI with logos, validating
                    fundamental metadata, or cross-referencing SEC/EDGAR data by CIK.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/reference/tickers/&#123;ticker&#125;</code></p>
                </div>

                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">
                      Ticker <span style={{ color: 'var(--clr-error, #e05)' }}>*</span>
                    </span>
                    <input
                      className="form-input"
                      value={tkOvTicker}
                      onChange={e => setTkOvTicker(e.target.value)}
                      disabled={!configured || tkOvBusy}
                      placeholder="AAPL"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Date</span>
                    <input
                      className="form-input"
                      value={tkOvDate}
                      onChange={e => setTkOvDate(e.target.value)}
                      disabled={!configured || tkOvBusy}
                      placeholder="YYYY-MM-DD (optional)"
                      autoComplete="off"
                    />
                  </label>
                </div>

                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-3)' }}>
                  <p>
                    <strong>Key response fields:</strong>{' '}
                    <code>active</code>, <code>address</code> (address1 / city / state / postal_code),{' '}
                    <code>branding</code> (logo_url, icon_url), <code>cik</code>, <code>composite_figi</code>,{' '}
                    <code>currency_name</code>, <code>description</code>, <code>homepage_url</code>,{' '}
                    <code>list_date</code>, <code>locale</code>, <code>market</code>, <code>market_cap</code>,{' '}
                    <code>name</code>, <code>phone_number</code>, <code>primary_exchange</code>,{' '}
                    <code>round_lot</code>, <code>share_class_figi</code>,{' '}
                    <code>share_class_shares_outstanding</code>, <code>sic_code</code>,{' '}
                    <code>sic_description</code>, <code>ticker</code>, <code>ticker_root</code>,{' '}
                    <code>ticker_suffix</code>, <code>total_employees</code>,{' '}
                    <code>weighted_shares_outstanding</code>
                  </p>
                  <p style={{ marginTop: 'var(--space-2)' }}>
                    <strong>Proxy:</strong> <code>GET /research/massive/tickers/&#123;ticker&#125;</code>
                  </p>
                </div>

                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || tkOvBusy} onClick={runTkOverview}>
                    {tkOvBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {tkOvErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkOvErr}</p> : null}
                {tkOvResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(tkOvResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {/* ── Ticker Types ─────────────────────────────────────────────── */}
            {tkSubTab === 'ticker_types' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-tk-panel-types"
                aria-labelledby="feed-massive-stk-tk-tab-types"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve a reference list of all ticker types supported by Massive,
                    categorized by asset class and locale. Each entry includes a short code (e.g. <code>CS</code> for
                    Common Stock, <code>ETF</code>, <code>ADRC</code> for ADR Common) and a human-readable description.
                  </p>
                  <p>
                    <strong>When to use:</strong> Populate type filter dropdowns for the All Tickers query, understand
                    asset classifications before building screening pipelines, or construct lookup tables that map
                    type codes to descriptions.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/reference/tickers/types</code></p>
                </div>

                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Asset Class</span>
                    <select
                      className="form-input"
                      value={tkTypesAssetClass}
                      onChange={e => setTkTypesAssetClass(e.target.value)}
                      disabled={!configured || tkTypesBusy}
                    >
                      <option value="">All</option>
                      <option value="stocks">Stocks</option>
                      <option value="options">Options</option>
                      <option value="crypto">Crypto</option>
                      <option value="fx">FX</option>
                      <option value="indices">Indices</option>
                    </select>
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Locale</span>
                    <select
                      className="form-input"
                      value={tkTypesLocale}
                      onChange={e => setTkTypesLocale(e.target.value)}
                      disabled={!configured || tkTypesBusy}
                    >
                      <option value="">All</option>
                      <option value="us">US</option>
                      <option value="global">Global</option>
                    </select>
                  </label>
                </div>

                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-3)' }}>
                  <p>
                    <strong>Key response fields (per result):</strong>{' '}
                    <code>code</code> (e.g. <code>CS</code>, <code>ETF</code>, <code>ADRC</code>,{' '}
                    <code>WARRANT</code>, <code>UNIT</code>), <code>description</code>,{' '}
                    <code>asset_class</code>, <code>locale</code>
                  </p>
                  <p style={{ marginTop: 'var(--space-2)' }}>
                    <strong>Proxy:</strong> <code>GET /research/massive/tickers/types</code>
                  </p>
                </div>

                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || tkTypesBusy} onClick={runTkTypes}>
                    {tkTypesBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {tkTypesErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkTypesErr}</p> : null}
                {tkTypesResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>
                      Result
                      {Array.isArray(tkTypesResult.results)
                        ? ` — ${tkTypesResult.results.length} type(s)`
                        : ''}
                    </summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(tkTypesResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {/* ── Related Tickers ──────────────────────────────────────────── */}
            {tkSubTab === 'related_tickers' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-tk-panel-related"
                aria-labelledby="feed-massive-stk-tk-tab-related"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Discover tickers related to a specified stock through Massive's
                    analysis of news coverage and historical returns data. Returns a ranked list of peers,
                    competitors, and thematically similar companies.
                  </p>
                  <p>
                    <strong>When to use:</strong> Peer identification for sector/comparable analysis, building a
                    competitor watchlist, discovering correlated instruments for hedging or diversification research.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /v1/related-companies/&#123;ticker&#125;</code></p>
                </div>

                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">
                      Ticker <span style={{ color: 'var(--clr-error, #e05)' }}>*</span>
                    </span>
                    <input
                      className="form-input"
                      value={tkRelTicker}
                      onChange={e => setTkRelTicker(e.target.value)}
                      disabled={!configured || tkRelBusy}
                      placeholder="AAPL"
                      autoComplete="off"
                    />
                  </label>
                </div>

                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-3)' }}>
                  <p>
                    <strong>Key response fields:</strong>{' '}
                    <code>ticker</code> (the queried symbol),{' '}
                    <code>results[].ticker</code> (related ticker symbols ranked by news/returns similarity)
                  </p>
                  <p style={{ marginTop: 'var(--space-2)' }}>
                    <strong>Proxy:</strong> <code>GET /research/massive/related-companies/&#123;ticker&#125;</code>
                  </p>
                </div>

                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || tkRelBusy} onClick={runTkRelated}>
                    {tkRelBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {tkRelErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkRelErr}</p> : null}
                {tkRelResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(tkRelResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {/* ── Reference (PostgreSQL) ───────────────────────────────────── */}
            {tkSubTab === 'reference_db' ? (
              <MassiveTickerReferenceDbSection
                panelId="feed-massive-stk-tk-panel-refdb"
                ariaLabelledBy="feed-massive-stk-tk-tab-refdb"
              />
            ) : null}

          </div>
        </div>
      </StockCapabilityPanel>
    )
  }

  // ── Aggregate Bars (OHLC) — four REST sub-tabs ───────────────────────────
  function renderStockAggregatesCap() {
    const id = 'stock-aggregates'
    const row = rowById(id)
    const eff = rowEff(row)
    return (
      <StockCapabilityPanel
        key={id}
        capId={id}
        checklistRow={row}
        effectiveStatus={eff}
        expanded={capExpanded[id] === true}
        onToggle={() => toggleCap(id)}
        highlight={highlightedCapabilityId === id}
        ariaLabel={row.service}
      >
        <FeedMassiveServiceBlock effectiveStatus={eff} checklistRow={row} evidence={evidenceFor(row)}>
          <div className="feed-massive-card-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className="feed-massive-card-icon" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M3 16V4M7 16V9M11 16V6M15 16V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </span>
              <h3>{row.service}</h3>
            </div>
          </div>
          <p className="feed-massive-card-lead">{row.description}</p>
        </FeedMassiveServiceBlock>

        <div className="feed-massive-agg-tabs-wrap">
          <div className="feed-massive-agg-tabs" role="tablist" aria-label="Stock aggregate REST endpoints">
            <button
              type="button"
              role="tab"
              id="feed-massive-stk-agg-tab-custom"
              className={`feed-massive-agg-tab${aggSubTab === 'custom_bars' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={aggSubTab === 'custom_bars'}
              tabIndex={aggSubTab === 'custom_bars' ? 0 : -1}
              onClick={() => setAggSubTab('custom_bars')}
            >
              Custom Bars
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button"
              role="tab"
              id="feed-massive-stk-agg-tab-grouped"
              className={`feed-massive-agg-tab${aggSubTab === 'grouped_daily' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={aggSubTab === 'grouped_daily'}
              tabIndex={aggSubTab === 'grouped_daily' ? 0 : -1}
              onClick={() => setAggSubTab('grouped_daily')}
            >
              Grouped Daily
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button"
              role="tab"
              id="feed-massive-stk-agg-tab-oc"
              className={`feed-massive-agg-tab${aggSubTab === 'open_close' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={aggSubTab === 'open_close'}
              tabIndex={aggSubTab === 'open_close' ? 0 : -1}
              onClick={() => setAggSubTab('open_close')}
            >
              Open / Close
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button"
              role="tab"
              id="feed-massive-stk-agg-tab-prev"
              className={`feed-massive-agg-tab${aggSubTab === 'prev' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={aggSubTab === 'prev'}
              tabIndex={aggSubTab === 'prev' ? 0 : -1}
              onClick={() => setAggSubTab('prev')}
            >
              Previous day
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
          </div>

          <div className="feed-massive-agg-tab-panels">
            {aggSubTab === 'custom_bars' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-agg-panel-custom"
                aria-labelledby="feed-massive-stk-agg-tab-custom"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve aggregated OHLCV bars for a stock over a custom time range and
                    interval (minute, hour, day, etc.). Bars are built from qualifying trades.
                  </p>
                  <p>
                    <strong>When to use:</strong> Charting, backtesting, and research where you need more than a single
                    trading day or a fixed calendar window.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint">
                    <code>GET /v2/aggs/ticker/&#123;stocksTicker&#125;/range/&#123;multiplier&#125;/&#123;timespan&#125;/&#123;from&#125;/&#123;to&#125;</code>
                  </p>
                </div>
                <label className="feed-massive-field" style={{ marginBottom: 'var(--space-3)' }}>
                  <span className="form-label">Stock ticker</span>
                  <input
                    className="form-input"
                    value={aggStTicker}
                    onChange={e => setAggStTicker(e.target.value)}
                    disabled={!configured || aggStBusy}
                    placeholder="AAPL"
                    autoComplete="off"
                  />
                </label>
                <div className="feed-massive-form-grid feed-massive-form-grid--wide">
                  <label className="feed-massive-field">
                    <span className="form-label">Start (Unix ms)</span>
                    <input
                      className="form-input"
                      value={aggStStartMs}
                      onChange={e => setAggStStartMs(e.target.value)}
                      disabled={!configured || aggStBusy}
                      placeholder="e.g. 1717200000000"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">End (Unix ms)</span>
                    <input
                      className="form-input"
                      value={aggStEndMs}
                      onChange={e => setAggStEndMs(e.target.value)}
                      disabled={!configured || aggStBusy}
                      placeholder="e.g. 1717286400000"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Timespan</span>
                    <input
                      className="form-input"
                      value={aggStTs}
                      onChange={e => setAggStTs(e.target.value)}
                      disabled={!configured || aggStBusy}
                      placeholder="minute"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Multiplier</span>
                    <input
                      className="form-input"
                      value={aggStMult}
                      onChange={e => setAggStMult(e.target.value)}
                      disabled={!configured || aggStBusy}
                      placeholder="1"
                      autoComplete="off"
                    />
                  </label>
                </div>
                <p className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <strong>Proxy:</strong> <code>GET /research/massive/stocks/bars/range</code>
                </p>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || aggStBusy} onClick={runAggCustom}>
                    {aggStBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {aggStErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{aggStErr}</p> : null}
                {aggStResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(aggStResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {aggSubTab === 'grouped_daily' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-agg-panel-grouped"
                aria-labelledby="feed-massive-stk-agg-tab-grouped"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve daily OHLCV bars for <em>all</em> US stocks on a single calendar
                    date in one response. Response can be very large.
                  </p>
                  <p>
                    <strong>When to use:</strong> Universe-wide daily screening, gap analysis, or bulk EOD snapshots
                    for a specific session date.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint">
                    <code>GET /v2/aggs/grouped/locale/us/market/stocks/&#123;date&#125;</code>
                  </p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Date (YYYY-MM-DD)</span>
                    <input
                      className="form-input"
                      value={gdDate}
                      onChange={e => setGdDate(e.target.value)}
                      disabled={!configured || gdBusy}
                      placeholder="2024-06-03"
                      autoComplete="off"
                    />
                  </label>
                </div>
                <p className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <strong>Proxy:</strong> <code>GET /research/massive/stocks/bars/grouped-daily/&#123;date&#125;</code>
                </p>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || gdBusy} onClick={runAggGrouped}>
                    {gdBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {gdErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{gdErr}</p> : null}
                {gdResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(gdResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {aggSubTab === 'open_close' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-agg-panel-oc"
                aria-labelledby="feed-massive-stk-agg-tab-oc"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Official open, high, low, close, and volume for one stock on one date,
                    including pre-market and after-hours where available.
                  </p>
                  <p>
                    <strong>When to use:</strong> Single-day summaries, EOD reporting, or extended-hours review without
                    pulling full intraday aggregates.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint">
                    <code>GET /v1/open-close/&#123;stocksTicker&#125;/&#123;date&#125;</code>
                  </p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Stock ticker</span>
                    <input
                      className="form-input"
                      value={ocStTicker}
                      onChange={e => setOcStTicker(e.target.value)}
                      disabled={!configured || ocBusy}
                      placeholder="AAPL"
                      autoComplete="off"
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Date (YYYY-MM-DD)</span>
                    <input
                      className="form-input"
                      value={ocDate}
                      onChange={e => setOcDate(e.target.value)}
                      disabled={!configured || ocBusy}
                      placeholder="2024-06-03"
                      autoComplete="off"
                    />
                  </label>
                </div>
                <p className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <strong>Proxy:</strong> <code>GET /research/massive/stocks/bars/open-close/&#123;ticker&#125;/&#123;date&#125;</code>
                </p>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || ocBusy} onClick={runAggOpenClose}>
                    {ocBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {ocErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{ocErr}</p> : null}
                {ocResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(ocResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            {aggSubTab === 'prev' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-agg-panel-prev"
                aria-labelledby="feed-massive-stk-agg-tab-prev"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Previous <em>trading</em> day OHLCV for a stock in one call — no calendar
                    math on the client.
                  </p>
                  <p>
                    <strong>When to use:</strong> Overnight change metrics, daily baselines, or quick prior-session
                    reference.
                  </p>
                  <p className="feed-massive-agg-sub-endpoint">
                    <code>GET /v2/aggs/ticker/&#123;stocksTicker&#125;/prev</code>
                  </p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Stock ticker</span>
                    <input
                      className="form-input"
                      value={prevStTicker}
                      onChange={e => setPrevStTicker(e.target.value)}
                      disabled={!configured || prevBusy}
                      placeholder="AAPL"
                      autoComplete="off"
                    />
                  </label>
                </div>
                <p className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <strong>Proxy:</strong> <code>GET /research/massive/stocks/bars/prev/&#123;ticker&#125;</code>
                </p>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <button type="button" className="btn btn-secondary" disabled={!configured || prevBusy} onClick={runAggPrev}>
                    {prevBusy ? 'Loading\u2026' : 'Execute'}
                  </button>
                </div>
                {prevErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{prevErr}</p> : null}
                {prevResult ? (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>
                      {JSON.stringify(prevResult, null, 2)}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </StockCapabilityPanel>
    )
  }

  // ── Render a single capability section ───────────────────────────────────
  function renderCap(id: string) {
    const row = rowById(id)
    const eff = rowEff(row)
    return (
      <StockCapabilityPanel
        key={id}
        capId={id}
        checklistRow={row}
        effectiveStatus={eff}
        expanded={capExpanded[id] === true}
        onToggle={() => toggleCap(id)}
        highlight={highlightedCapabilityId === id}
        ariaLabel={row.service}
      >
        <FeedMassiveServiceBlock effectiveStatus={eff} checklistRow={row} evidence={evidenceFor(row)}>
          <div className="feed-massive-card-head">
            <h3>{row.service}</h3>
          </div>
          <p className="feed-massive-card-lead">{row.description}</p>
        </FeedMassiveServiceBlock>
      </StockCapabilityPanel>
    )
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="card process-section feed-massive-option-page">

      {/* Title */}
      <div className="feed-massive-title-block">
        <div className="feed-massive-title-main">
          <h2 className="page-title-with-tooltip" style={{ marginBottom: 0 }}>
            {onGoToFeed ? (
              <>
                <button type="button" className="page-title-breadcrumb-link" onClick={onGoToFeed} aria-label="Go to Feed">
                  Feed
                </button>
                {' / '}
              </>
            ) : null}
            {breadcrumbLabel}{' '}
            <InfoTooltip text="Massive (Polygon) Stocks API coverage sheet and capability status. Shared endpoints (Technical Indicators, Market Ops, Corporate Actions) already work via Massive Option. Stock-specific endpoints are planned." />
          </h2>
          {configured && (
            <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice}>
              Delayed feed
            </span>
          )}
        </div>
      </div>

      {/* Status strip */}
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
            <span className="feed-massive-status-key">Source</span>
            <span className="feed-massive-status-value">Polygon / Massive Stocks</span>
          </div>
        </div>
        {massiveStatus?.delay_notice ? (
          <p className="feed-massive-status-note">{massiveStatus.delay_notice}</p>
        ) : null}
      </section>

      {/* Coverage Sheet banner */}
      <section
        className="feed-massive-api-coverage-banner"
        id="feed-massive-stock-api-coverage"
        aria-label="Massive Stocks API coverage sheet"
      >
        <div className="feed-massive-api-coverage-banner-row">
          <div className="feed-massive-api-coverage-copy">
            <div className="feed-massive-api-coverage-title">Official Stocks API vs project coverage</div>
            <p className="feed-massive-api-coverage-desc">
              Massive / Polygon Stocks endpoints, use cases, checklist mapping, and implementation status.
              Same viewer is available under MkDocs Research → Massive Stocks API coverage.
            </p>
          </div>
          <div className="feed-massive-api-coverage-actions">
            <a
              href={MASSIVE_STOCKS_COVERAGE_PLAN_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary"
            >
              Open in new tab
            </a>
            <button
              type="button"
              className="btn-secondary"
              disabled={apiCoverageSyncBusy}
              onClick={async () => {
                setApiCoverageSyncBusy(true)
                setApiCoverageSyncMsg(null)
                try {
                  const res = await postMassiveStocksApiCoverageSync()
                  setApiCoverageSyncMsg(res.ok ? 'Synced stocks coverage HTML to frontend/public/plans.' : (res.error ?? 'Sync failed'))
                } catch (e) {
                  setApiCoverageSyncMsg(e instanceof Error ? e.message : 'Sync failed')
                } finally {
                  setApiCoverageSyncBusy(false)
                }
              }}
            >
              {apiCoverageSyncBusy ? 'Syncing…' : 'Sync HTML'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setApiCoverageOpen(v => !v)}
              aria-expanded={apiCoverageOpen}
            >
              {apiCoverageOpen ? 'Hide embedded viewer' : 'Show embedded viewer'}
            </button>
          </div>
        </div>
        {apiCoverageSyncMsg ? <p className="feed-massive-api-coverage-sync-msg">{apiCoverageSyncMsg}</p> : null}
        {apiCoverageOpen ? (
          <div className="feed-massive-api-coverage-frame-wrap">
            <iframe
              title="Massive Stocks API coverage sheet"
              src={`${MASSIVE_STOCKS_COVERAGE_PLAN_URL}?embed=1`}
              className="feed-massive-api-coverage-iframe"
            />
          </div>
        ) : null}
      </section>

      {/* Sticky nav with capability chips */}
      <nav className="feed-massive-tab-nav-section feed-massive-cap-nav-sticky" aria-label="Massive Stock capabilities">
        <div className="feed-massive-cap-sheet">
          <p className="feed-massive-cap-hint">
            Capabilities grouped by delivery channel. Click a group header to show or hide chips; click a chip to jump and expand that section.
          </p>
          {groupedStockChecklistRows().map(({ group, rows: groupRows }) => {
            const navOpen = capNavGroupExpanded[group]
            const groupHasHighlight = groupRows.some(row => highlightedCapabilityId === row.id)
            return (
              <div key={group} className="feed-massive-cap-group">
                <button
                  type="button"
                  className={`feed-massive-cap-group-toggle${groupHasHighlight ? ' feed-massive-cap-group-toggle--active' : ''}`}
                  aria-expanded={navOpen}
                  aria-controls={`feed-massive-stock-cap-group-panel-${group}`}
                  id={`feed-massive-stock-cap-group-head-${group}`}
                  onClick={() => setCapNavGroupExpanded(prev => ({ ...prev, [group]: !prev[group] }))}
                >
                  <span className={`feed-massive-cap-group-chevron${navOpen ? ' feed-massive-cap-group-chevron--open' : ''}`} aria-hidden>▼</span>
                  <span className="feed-massive-cap-group-label">{CAPABILITY_GROUP_LABELS[group]}</span>
                </button>
                <div
                  id={`feed-massive-stock-cap-group-panel-${group}`}
                  className="feed-massive-cap-group-panel"
                  hidden={!navOpen}
                  role="region"
                  aria-labelledby={`feed-massive-stock-cap-group-head-${group}`}
                >
                  <div className="feed-massive-cap-summary">
                    {groupRows.map(row => {
                      const eff = rowEff(row)
                      return (
                        <a
                          key={row.id}
                          href={`#${feedMassiveStockSvcAnchorId(row.id)}`}
                          className={`feed-massive-tab-chip${highlightedCapabilityId === row.id ? ' feed-massive-tab-chip--active' : ''}`}
                          aria-current={highlightedCapabilityId === row.id ? 'location' : undefined}
                          onClick={e => { e.preventDefault(); scrollToSection(row.id) }}
                        >
                          <span className={overviewDotClass(eff)} title={checklistEffectiveStatusLabel(eff)} aria-hidden />
                          <span className="feed-massive-tab-chip-label">{shortServiceLabel(row)}</span>
                        </a>
                      )
                    })}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </nav>

      {/* Not configured warning */}
      {!configured && (
        <p className="status-page-msg err" role="alert">
          Massive API key not configured. Set massive credentials in server config. Shared capabilities (Technical Indicators, Market Ops) are already functional via Massive Option.
        </p>
      )}

      {/* Main capability panels */}
      <div className="feed-massive-tab-panel">

        {/* REST API */}
        <h3 className="feed-massive-group-header" id="feed-massive-stock-group-rest">REST API</h3>

        {REST_SECTION_ORDER.map(id => {
          const row = stockChecklistRows.find(r => r.id === id)
          if (!row) return null
          return (
            <div key={id}>
              <h4 className="feed-massive-section-header">{REST_SECTION_LABELS[id]}</h4>
              {id === 'stock-tickers'
                ? renderTickersCap()
                : id === 'stock-aggregates'
                  ? renderStockAggregatesCap()
                  : renderCap(id)}
            </div>
          )
        })}

        {/* WebSocket */}
        <h3 className="feed-massive-group-header" id="feed-massive-stock-group-ws">WebSocket</h3>
        {stockChecklistRows
          .filter(r => r.group === 'ws')
          .map(row => renderCap(row.id))}

        {/* Flat Files */}
        <h3 className="feed-massive-group-header" id="feed-massive-stock-group-flat">Flat Files</h3>
        {stockChecklistRows
          .filter(r => r.group === 'flat')
          .map(row => renderCap(row.id))}

        {/* Project — only rendered if rows exist in this group */}
        {stockChecklistRows.some(r => r.group === 'project') && (
          <>
            <h3 className="feed-massive-group-header" id="feed-massive-stock-group-project">Project</h3>
            {stockChecklistRows
              .filter(r => r.group === 'project')
              .map(row => renderCap(row.id))}
          </>
        )}

      </div>
    </div>
  )
}
