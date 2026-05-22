import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import type { StatusResponse } from '../types'
import {
  fetchMassiveReferenceTickers,
  fetchMassiveRelatedCompanies,
  fetchMassiveStatus,
  fetchMassiveStockBarsRange,
  fetchMassiveStockGroupedDaily,
  fetchMassiveStockOpenClose,
  fetchMassiveStockPrev,
  fetchMassiveStockIncomeStatements,
  fetchMassiveStockBalanceSheets,
  fetchMassiveStockCashFlowStatements,
  fetchMassiveStockRatios,
  fetchMassiveStockShortInterest,
  fetchMassiveStockShortVolume,
  fetchMassiveStockFloat,
  fetchMassiveStockNews,
  fetchMassiveEdgarIndex,
  fetchMassive10KSections,
  fetchMassive8KText,
  fetchMassive13FFilings,
  fetchMassiveRiskFactors,
  fetchMassiveRiskCategories,
  fetchMassiveForm3,
  fetchMassiveForm4,
  fetchMassiveTickerDetail,
  fetchMassiveTickerTypes,
  postMassiveStocksApiCoverageSync,
} from '../api'
import type { MassiveStatusResponse } from '../api'
import { AppSelect } from '../components/AppSelect'
import { SectionPageTitle } from '../components/SectionPageTitle'
import { PageSection } from '@/components/shared/page-section'
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
import { MassiveRefJobSessionProvider } from './massive/MassiveRefJobSessionContext'
import { MassiveTickerReferenceDbSection } from './massive/MassiveTickerReferenceDbSection'

import { baseUrlForStaticAssets } from '@/lib/publicEnv'
import { Button } from '@/components/ui/button'

/** `frontend/public/plans/` — respect base path when not deployed at domain root. */
const MASSIVE_STOCKS_COVERAGE_PLAN_URL = `${baseUrlForStaticAssets()}plans/massive_stocks_api_coverage.html`

/** Default Custom Bars window: one regular session (09:30–16:00 ET) on 2024-06-03 — works with multiplier 1 × timespan minute. */
const STOCK_CUSTOM_BARS_DEFAULT_START_MS = 1717421400000
const STOCK_CUSTOM_BARS_DEFAULT_END_MS = 1717444800000

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
  'stock-corporate-actions': 'Corporate Actions',
  'stock-fundamentals': 'Fundamentals',
  'stock-filings': 'Filings & Disclosures',
  'stock-news': 'News',
}

const STOCK_WS_SECTION_ORDER = stockChecklistRows.filter(r => r.group === 'ws').map(r => r.id)
const STOCK_FLAT_SECTION_ORDER = stockChecklistRows.filter(r => r.group === 'flat').map(r => r.id)
const STOCK_REST_ID_SET = new Set<string>(REST_SECTION_ORDER)
const STOCK_WS_ID_SET = new Set<string>(STOCK_WS_SECTION_ORDER)
const STOCK_FLAT_ID_SET = new Set<string>(STOCK_FLAT_SECTION_ORDER)

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
  const [channelTab, setChannelTab] = useState<'rest' | 'ws' | 'flat'>('rest')
  const [deliveryRestSubTab, setDeliveryRestSubTab] = useState<(typeof REST_SECTION_ORDER)[number]>(REST_SECTION_ORDER[0])
  const [deliveryWsSubTab, setDeliveryWsSubTab] = useState<string>(STOCK_WS_SECTION_ORDER[0] ?? 'stock-ws-aggregates-s')
  const [deliveryFlatSubTab, setDeliveryFlatSubTab] = useState<string>(STOCK_FLAT_SECTION_ORDER[0] ?? 'stock-flat-file-day-aggs')

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
  const [aggSubTab, setAggSubTab] = useState<
    'custom_bars' | 'daily_market_summary' | 'daily_ticker_summary' | 'previous_day_bar'
  >('custom_bars')
  const [aggStTicker, setAggStTicker] = useState('AAPL')
  const [aggStMult, setAggStMult] = useState('1')
  const [aggStTs, setAggStTs] = useState('minute')
  const [aggStStartMs, setAggStStartMs] = useState(String(STOCK_CUSTOM_BARS_DEFAULT_START_MS))
  const [aggStEndMs, setAggStEndMs] = useState(String(STOCK_CUSTOM_BARS_DEFAULT_END_MS))
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

  // ── Fundamentals sub-tabs ─────────────────────────────────────────────────
  const [fundSubTab, setFundSubTab] = useState<
    'income_statements' | 'balance_sheets' | 'cash_flow' | 'ratios' | 'short_interest' | 'short_volume' | 'float'
  >('income_statements')

  const [fundTicker, setFundTicker] = useState('AAPL')
  const [fundTimeframe, setFundTimeframe] = useState('annual')
  const [fundFiscalYear, setFundFiscalYear] = useState('')
  const [fundFiscalQuarter, setFundFiscalQuarter] = useState('')
  const [fundPeriodEnd, setFundPeriodEnd] = useState('')
  const [fundFilingDate, setFundFilingDate] = useState('')
  const [fundLimit, setFundLimit] = useState('4')

  const [fundISBusy, setFundISBusy] = useState(false)
  const [fundISErr, setFundISErr] = useState<string | null>(null)
  const [fundISResult, setFundISResult] = useState<Record<string, unknown> | null>(null)

  const [fundBSBusy, setFundBSBusy] = useState(false)
  const [fundBSErr, setFundBSErr] = useState<string | null>(null)
  const [fundBSResult, setFundBSResult] = useState<Record<string, unknown> | null>(null)

  const [fundCFBusy, setFundCFBusy] = useState(false)
  const [fundCFErr, setFundCFErr] = useState<string | null>(null)
  const [fundCFResult, setFundCFResult] = useState<Record<string, unknown> | null>(null)

  const [fundRatiosBusy, setFundRatiosBusy] = useState(false)
  const [fundRatiosErr, setFundRatiosErr] = useState<string | null>(null)
  const [fundRatiosResult, setFundRatiosResult] = useState<Record<string, unknown> | null>(null)

  const [fundSITicker, setFundSITicker] = useState('AAPL')
  const [fundSIDate, setFundSIDate] = useState('')
  const [fundSILimit, setFundSILimit] = useState('10')
  const [fundSIBusy, setFundSIBusy] = useState(false)
  const [fundSIErr, setFundSIErr] = useState<string | null>(null)
  const [fundSIResult, setFundSIResult] = useState<Record<string, unknown> | null>(null)

  const [fundSVTicker, setFundSVTicker] = useState('AAPL')
  const [fundSVDate, setFundSVDate] = useState('')
  const [fundSVLimit, setFundSVLimit] = useState('10')
  const [fundSVBusy, setFundSVBusy] = useState(false)
  const [fundSVErr, setFundSVErr] = useState<string | null>(null)
  const [fundSVResult, setFundSVResult] = useState<Record<string, unknown> | null>(null)

  const [fundFloatTicker, setFundFloatTicker] = useState('AAPL')
  const [fundFloatLimit, setFundFloatLimit] = useState('10')
  const [fundFloatBusy, setFundFloatBusy] = useState(false)
  const [fundFloatErr, setFundFloatErr] = useState<string | null>(null)
  const [fundFloatResult, setFundFloatResult] = useState<Record<string, unknown> | null>(null)

  // ── Filings & Disclosures sub-tabs ───────────────────────────────────────
  const [filingsSubTab, setFilingsSubTab] = useState<
    'edgar_index' | 'sections_10k' | 'text_8k' | 'form_13f' | 'risk_factors' | 'risk_categories' | 'form_3' | 'form_4'
  >('edgar_index')

  // Edgar Index form
  const [flEiTicker, setFlEiTicker] = useState('AAPL')
  const [flEiCik, setFlEiCik] = useState('')
  const [flEiFormType, setFlEiFormType] = useState('')
  const [flEiDateGte, setFlEiDateGte] = useState('')
  const [flEiDateLte, setFlEiDateLte] = useState('')
  const [flEiLimit, setFlEiLimit] = useState('100')
  const [flEiBusy, setFlEiBusy] = useState(false)
  const [flEiErr, setFlEiErr] = useState<string | null>(null)
  const [flEiResult, setFlEiResult] = useState<Record<string, unknown> | null>(null)

  // 10-K Sections form
  const [fl10kTicker, setFl10kTicker] = useState('AAPL')
  const [fl10kCik, setFl10kCik] = useState('')
  const [fl10kSection, setFl10kSection] = useState('')
  const [fl10kDateGte, setFl10kDateGte] = useState('')
  const [fl10kDateLte, setFl10kDateLte] = useState('')
  const [fl10kPeriodEndGte, setFl10kPeriodEndGte] = useState('')
  const [fl10kPeriodEndLte, setFl10kPeriodEndLte] = useState('')
  const [fl10kLimit, setFl10kLimit] = useState('5')
  const [fl10kBusy, setFl10kBusy] = useState(false)
  const [fl10kErr, setFl10kErr] = useState<string | null>(null)
  const [fl10kResult, setFl10kResult] = useState<Record<string, unknown> | null>(null)

  // 8-K Text form
  const [fl8kTicker, setFl8kTicker] = useState('AAPL')
  const [fl8kCik, setFl8kCik] = useState('')
  const [fl8kFormType, setFl8kFormType] = useState('')
  const [fl8kDateGte, setFl8kDateGte] = useState('')
  const [fl8kDateLte, setFl8kDateLte] = useState('')
  const [fl8kLimit, setFl8kLimit] = useState('5')
  const [fl8kBusy, setFl8kBusy] = useState(false)
  const [fl8kErr, setFl8kErr] = useState<string | null>(null)
  const [fl8kResult, setFl8kResult] = useState<Record<string, unknown> | null>(null)

  // 13-F Filings form
  const [fl13fFilerCik, setFl13fFilerCik] = useState('')
  const [fl13fDateGte, setFl13fDateGte] = useState('')
  const [fl13fDateLte, setFl13fDateLte] = useState('')
  const [fl13fLimit, setFl13fLimit] = useState('50')
  const [fl13fBusy, setFl13fBusy] = useState(false)
  const [fl13fErr, setFl13fErr] = useState<string | null>(null)
  const [fl13fResult, setFl13fResult] = useState<Record<string, unknown> | null>(null)

  // Risk Factors form
  const [flRfTicker, setFlRfTicker] = useState('AAPL')
  const [flRfCik, setFlRfCik] = useState('')
  const [flRfDateGte, setFlRfDateGte] = useState('')
  const [flRfDateLte, setFlRfDateLte] = useState('')
  const [flRfLimit, setFlRfLimit] = useState('20')
  const [flRfBusy, setFlRfBusy] = useState(false)
  const [flRfErr, setFlRfErr] = useState<string | null>(null)
  const [flRfResult, setFlRfResult] = useState<Record<string, unknown> | null>(null)

  // Risk Categories form
  const [flRcPrimary, setFlRcPrimary] = useState('')
  const [flRcSecondary, setFlRcSecondary] = useState('')
  const [flRcTertiary, setFlRcTertiary] = useState('')
  const [flRcLimit, setFlRcLimit] = useState('200')
  const [flRcBusy, setFlRcBusy] = useState(false)
  const [flRcErr, setFlRcErr] = useState<string | null>(null)
  const [flRcResult, setFlRcResult] = useState<Record<string, unknown> | null>(null)

  // Form 3 form
  const [flF3IssuerCik, setFlF3IssuerCik] = useState('')
  const [flF3OwnerCik, setFlF3OwnerCik] = useState('')
  const [flF3Tickers, setFlF3Tickers] = useState('AAPL')
  const [flF3DateGte, setFlF3DateGte] = useState('')
  const [flF3DateLte, setFlF3DateLte] = useState('')
  const [flF3Limit, setFlF3Limit] = useState('50')
  const [flF3Busy, setFlF3Busy] = useState(false)
  const [flF3Err, setFlF3Err] = useState<string | null>(null)
  const [flF3Result, setFlF3Result] = useState<Record<string, unknown> | null>(null)

  // Form 4 form
  const [flF4IssuerCik, setFlF4IssuerCik] = useState('')
  const [flF4OwnerCik, setFlF4OwnerCik] = useState('')
  const [flF4Tickers, setFlF4Tickers] = useState('AAPL')
  const [flF4TxCode, setFlF4TxCode] = useState('')
  const [flF4DateGte, setFlF4DateGte] = useState('')
  const [flF4DateLte, setFlF4DateLte] = useState('')
  const [flF4Limit, setFlF4Limit] = useState('50')
  const [flF4Busy, setFlF4Busy] = useState(false)
  const [flF4Err, setFlF4Err] = useState<string | null>(null)
  const [flF4Result, setFlF4Result] = useState<Record<string, unknown> | null>(null)

  // News form
  const [newsTicker, setNewsTicker] = useState('AAPL')
  const [newsPublishedGte, setNewsPublishedGte] = useState('')
  const [newsPublishedLte, setNewsPublishedLte] = useState('')
  const [newsLimit, setNewsLimit] = useState('20')
  const [newsSort, setNewsSort] = useState('published_utc')
  const [newsOrder, setNewsOrder] = useState('desc')
  const [newsBusy, setNewsBusy] = useState(false)
  const [newsErr, setNewsErr] = useState<string | null>(null)
  const [newsResult, setNewsResult] = useState<Record<string, unknown> | null>(null)

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

  const runFundamentalsFinancials = useCallback(async (
    fetcher: typeof fetchMassiveStockIncomeStatements,
    setBusy: (b: boolean) => void,
    setErr: (e: string | null) => void,
    setResult: (r: Record<string, unknown> | null) => void,
  ) => {
    const t = fundTicker.trim()
    if (!t) { setErr('Ticker is required'); return }
    setBusy(true); setErr(null); setResult(null)
    try {
      const res = await fetcher(t, {
        timeframe: fundTimeframe || undefined,
        fiscal_year: fundFiscalYear ? parseInt(fundFiscalYear, 10) : undefined,
        fiscal_quarter: fundFiscalQuarter ? parseInt(fundFiscalQuarter, 10) : undefined,
        period_end: fundPeriodEnd || undefined,
        filing_date: fundFilingDate || undefined,
        limit: Math.min(1000, Math.max(1, parseInt(fundLimit, 10) || 4)),
      })
      if (!res.ok) { setErr(res.error ?? 'Request failed'); return }
      setResult(res.data ?? null)
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(false) }
  }, [fundTicker, fundTimeframe, fundFiscalYear, fundFiscalQuarter, fundPeriodEnd, fundFilingDate, fundLimit])

  const runFundIS = useCallback(() =>
    runFundamentalsFinancials(fetchMassiveStockIncomeStatements, setFundISBusy, setFundISErr, setFundISResult),
    [runFundamentalsFinancials])

  const runFundBS = useCallback(() =>
    runFundamentalsFinancials(fetchMassiveStockBalanceSheets, setFundBSBusy, setFundBSErr, setFundBSResult),
    [runFundamentalsFinancials])

  const runFundCF = useCallback(() =>
    runFundamentalsFinancials(fetchMassiveStockCashFlowStatements, setFundCFBusy, setFundCFErr, setFundCFResult),
    [runFundamentalsFinancials])

  const runFundRatios = useCallback(async () => {
    const t = fundTicker.trim()
    if (!t) { setFundRatiosErr('Ticker is required'); return }
    setFundRatiosBusy(true); setFundRatiosErr(null); setFundRatiosResult(null)
    try {
      const res = await fetchMassiveStockRatios(t, { limit: Math.min(1000, Math.max(1, parseInt(fundLimit, 10) || 4)) })
      if (!res.ok) { setFundRatiosErr(res.error ?? 'Request failed'); return }
      setFundRatiosResult(res.data ?? null)
    } catch (e: unknown) {
      setFundRatiosErr(e instanceof Error ? e.message : String(e))
    } finally { setFundRatiosBusy(false) }
  }, [fundTicker, fundLimit])

  const runFundShortInterest = useCallback(async () => {
    const t = fundSITicker.trim()
    if (!t) { setFundSIErr('Ticker is required'); return }
    setFundSIBusy(true); setFundSIErr(null); setFundSIResult(null)
    try {
      const res = await fetchMassiveStockShortInterest(t, {
        settlement_date: fundSIDate || undefined,
        limit: Math.min(1000, Math.max(1, parseInt(fundSILimit, 10) || 10)),
      })
      if (!res.ok) { setFundSIErr(res.error ?? 'Request failed'); return }
      setFundSIResult(res.data ?? null)
    } catch (e: unknown) {
      setFundSIErr(e instanceof Error ? e.message : String(e))
    } finally { setFundSIBusy(false) }
  }, [fundSITicker, fundSIDate, fundSILimit])

  const runFundShortVolume = useCallback(async () => {
    const t = fundSVTicker.trim()
    if (!t) { setFundSVErr('Ticker is required'); return }
    setFundSVBusy(true); setFundSVErr(null); setFundSVResult(null)
    try {
      const res = await fetchMassiveStockShortVolume(t, {
        date: fundSVDate || undefined,
        limit: Math.min(1000, Math.max(1, parseInt(fundSVLimit, 10) || 10)),
      })
      if (!res.ok) { setFundSVErr(res.error ?? 'Request failed'); return }
      setFundSVResult(res.data ?? null)
    } catch (e: unknown) {
      setFundSVErr(e instanceof Error ? e.message : String(e))
    } finally { setFundSVBusy(false) }
  }, [fundSVTicker, fundSVDate, fundSVLimit])

  const runFundFloat = useCallback(async () => {
    const t = fundFloatTicker.trim()
    if (!t) { setFundFloatErr('Ticker is required'); return }
    setFundFloatBusy(true); setFundFloatErr(null); setFundFloatResult(null)
    try {
      const res = await fetchMassiveStockFloat(t, {
        limit: Math.min(5000, Math.max(1, parseInt(fundFloatLimit, 10) || 10)),
      })
      if (!res.ok) { setFundFloatErr(res.error ?? 'Request failed'); return }
      setFundFloatResult(res.data ?? null)
    } catch (e: unknown) {
      setFundFloatErr(e instanceof Error ? e.message : String(e))
    } finally { setFundFloatBusy(false) }
  }, [fundFloatTicker, fundFloatLimit])

  const runEdgarIndex = useCallback(async () => {
    setFlEiBusy(true); setFlEiErr(null); setFlEiResult(null)
    try {
      const res = await fetchMassiveEdgarIndex({
        ticker: flEiTicker.trim() || undefined,
        cik: flEiCik.trim() || undefined,
        form_type: flEiFormType.trim() || undefined,
        filing_date_gte: flEiDateGte.trim() || undefined,
        filing_date_lte: flEiDateLte.trim() || undefined,
        limit: Math.min(50000, Math.max(1, parseInt(flEiLimit, 10) || 100)),
      })
      if (!res.ok) { setFlEiErr(res.error ?? 'Request failed'); return }
      setFlEiResult(res.data ?? null)
    } catch (e: unknown) { setFlEiErr(e instanceof Error ? e.message : String(e)) }
    finally { setFlEiBusy(false) }
  }, [flEiTicker, flEiCik, flEiFormType, flEiDateGte, flEiDateLte, flEiLimit])

  const run10KSections = useCallback(async () => {
    setFl10kBusy(true); setFl10kErr(null); setFl10kResult(null)
    try {
      const res = await fetchMassive10KSections({
        ticker: fl10kTicker.trim() || undefined,
        cik: fl10kCik.trim() || undefined,
        section: fl10kSection.trim() || undefined,
        filing_date_gte: fl10kDateGte.trim() || undefined,
        filing_date_lte: fl10kDateLte.trim() || undefined,
        period_end_gte: fl10kPeriodEndGte.trim() || undefined,
        period_end_lte: fl10kPeriodEndLte.trim() || undefined,
        limit: Math.min(99, Math.max(1, parseInt(fl10kLimit, 10) || 5)),
      })
      if (!res.ok) { setFl10kErr(res.error ?? 'Request failed'); return }
      setFl10kResult(res.data ?? null)
    } catch (e: unknown) { setFl10kErr(e instanceof Error ? e.message : String(e)) }
    finally { setFl10kBusy(false) }
  }, [fl10kTicker, fl10kCik, fl10kSection, fl10kDateGte, fl10kDateLte, fl10kPeriodEndGte, fl10kPeriodEndLte, fl10kLimit])

  const run8KText = useCallback(async () => {
    setFl8kBusy(true); setFl8kErr(null); setFl8kResult(null)
    try {
      const res = await fetchMassive8KText({
        ticker: fl8kTicker.trim() || undefined,
        cik: fl8kCik.trim() || undefined,
        form_type: fl8kFormType.trim() || undefined,
        filing_date_gte: fl8kDateGte.trim() || undefined,
        filing_date_lte: fl8kDateLte.trim() || undefined,
        limit: Math.min(99, Math.max(1, parseInt(fl8kLimit, 10) || 5)),
      })
      if (!res.ok) { setFl8kErr(res.error ?? 'Request failed'); return }
      setFl8kResult(res.data ?? null)
    } catch (e: unknown) { setFl8kErr(e instanceof Error ? e.message : String(e)) }
    finally { setFl8kBusy(false) }
  }, [fl8kTicker, fl8kCik, fl8kFormType, fl8kDateGte, fl8kDateLte, fl8kLimit])

  const run13FFilings = useCallback(async () => {
    setFl13fBusy(true); setFl13fErr(null); setFl13fResult(null)
    try {
      const res = await fetchMassive13FFilings({
        filer_cik: fl13fFilerCik.trim() || undefined,
        filing_date_gte: fl13fDateGte.trim() || undefined,
        filing_date_lte: fl13fDateLte.trim() || undefined,
        limit: Math.min(1000, Math.max(1, parseInt(fl13fLimit, 10) || 50)),
      })
      if (!res.ok) { setFl13fErr(res.error ?? 'Request failed'); return }
      setFl13fResult(res.data ?? null)
    } catch (e: unknown) { setFl13fErr(e instanceof Error ? e.message : String(e)) }
    finally { setFl13fBusy(false) }
  }, [fl13fFilerCik, fl13fDateGte, fl13fDateLte, fl13fLimit])

  const runRiskFactors = useCallback(async () => {
    setFlRfBusy(true); setFlRfErr(null); setFlRfResult(null)
    try {
      const res = await fetchMassiveRiskFactors({
        ticker: flRfTicker.trim() || undefined,
        cik: flRfCik.trim() || undefined,
        filing_date_gte: flRfDateGte.trim() || undefined,
        filing_date_lte: flRfDateLte.trim() || undefined,
        limit: Math.min(49999, Math.max(1, parseInt(flRfLimit, 10) || 20)),
      })
      if (!res.ok) { setFlRfErr(res.error ?? 'Request failed'); return }
      setFlRfResult(res.data ?? null)
    } catch (e: unknown) { setFlRfErr(e instanceof Error ? e.message : String(e)) }
    finally { setFlRfBusy(false) }
  }, [flRfTicker, flRfCik, flRfDateGte, flRfDateLte, flRfLimit])

  const runRiskCategories = useCallback(async () => {
    setFlRcBusy(true); setFlRcErr(null); setFlRcResult(null)
    try {
      const res = await fetchMassiveRiskCategories({
        primary_category: flRcPrimary.trim() || undefined,
        secondary_category: flRcSecondary.trim() || undefined,
        tertiary_category: flRcTertiary.trim() || undefined,
        limit: Math.min(999, Math.max(1, parseInt(flRcLimit, 10) || 200)),
      })
      if (!res.ok) { setFlRcErr(res.error ?? 'Request failed'); return }
      setFlRcResult(res.data ?? null)
    } catch (e: unknown) { setFlRcErr(e instanceof Error ? e.message : String(e)) }
    finally { setFlRcBusy(false) }
  }, [flRcPrimary, flRcSecondary, flRcTertiary, flRcLimit])

  const runForm3 = useCallback(async () => {
    setFlF3Busy(true); setFlF3Err(null); setFlF3Result(null)
    try {
      const res = await fetchMassiveForm3({
        issuer_cik: flF3IssuerCik.trim() || undefined,
        owner_cik: flF3OwnerCik.trim() || undefined,
        tickers: flF3Tickers.trim() || undefined,
        filing_date_gte: flF3DateGte.trim() || undefined,
        filing_date_lte: flF3DateLte.trim() || undefined,
        limit: Math.min(10000, Math.max(1, parseInt(flF3Limit, 10) || 50)),
      })
      if (!res.ok) { setFlF3Err(res.error ?? 'Request failed'); return }
      setFlF3Result(res.data ?? null)
    } catch (e: unknown) { setFlF3Err(e instanceof Error ? e.message : String(e)) }
    finally { setFlF3Busy(false) }
  }, [flF3IssuerCik, flF3OwnerCik, flF3Tickers, flF3DateGte, flF3DateLte, flF3Limit])

  const runForm4 = useCallback(async () => {
    setFlF4Busy(true); setFlF4Err(null); setFlF4Result(null)
    try {
      const res = await fetchMassiveForm4({
        issuer_cik: flF4IssuerCik.trim() || undefined,
        owner_cik: flF4OwnerCik.trim() || undefined,
        tickers: flF4Tickers.trim() || undefined,
        transaction_code: flF4TxCode.trim() || undefined,
        filing_date_gte: flF4DateGte.trim() || undefined,
        filing_date_lte: flF4DateLte.trim() || undefined,
        limit: Math.min(10000, Math.max(1, parseInt(flF4Limit, 10) || 50)),
      })
      if (!res.ok) { setFlF4Err(res.error ?? 'Request failed'); return }
      setFlF4Result(res.data ?? null)
    } catch (e: unknown) { setFlF4Err(e instanceof Error ? e.message : String(e)) }
    finally { setFlF4Busy(false) }
  }, [flF4IssuerCik, flF4OwnerCik, flF4Tickers, flF4TxCode, flF4DateGte, flF4DateLte, flF4Limit])

  const runStockNews = useCallback(async () => {
    setNewsBusy(true); setNewsErr(null); setNewsResult(null)
    try {
      const res = await fetchMassiveStockNews({
        ticker: newsTicker.trim() || undefined,
        published_utc_gte: newsPublishedGte.trim() || undefined,
        published_utc_lte: newsPublishedLte.trim() || undefined,
        limit: Math.min(1000, Math.max(1, parseInt(newsLimit, 10) || 20)),
        sort: newsSort.trim() || undefined,
        order: newsOrder.trim() || undefined,
      })
      if (!res.ok) { setNewsErr(res.error ?? 'Request failed'); return }
      setNewsResult(res.data ?? null)
    } catch (e: unknown) {
      setNewsErr(e instanceof Error ? e.message : String(e))
    } finally {
      setNewsBusy(false)
    }
  }, [newsTicker, newsPublishedGte, newsPublishedLte, newsLimit, newsSort, newsOrder])

  const toggleCap = useCallback((id: string) => {
    setCapExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const scrollToSection = useCallback((id: string) => {
    setHighlightedCapabilityId(id)
    setCapExpanded(prev => ({ ...prev, [id]: true }))
    const g = stockCapabilityGroupForRowId(id)
    if (g === 'rest' || g === 'ws' || g === 'flat') {
      setChannelTab(g)
    }
    if (STOCK_REST_ID_SET.has(id)) {
      setDeliveryRestSubTab(id as (typeof REST_SECTION_ORDER)[number])
    }
    if (STOCK_WS_ID_SET.has(id)) {
      setDeliveryWsSubTab(id)
    }
    if (STOCK_FLAT_ID_SET.has(id)) {
      setDeliveryFlatSubTab(id)
    }
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

  const stockWsRows = stockChecklistRows.filter(r => r.group === 'ws')
  const stockFlatRows = stockChecklistRows.filter(r => r.group === 'flat')
  const stockWsPanelRow = stockWsRows.find(r => r.id === deliveryWsSubTab) ?? stockWsRows[0]
  const stockFlatPanelRow = stockFlatRows.find(r => r.id === deliveryFlatSubTab) ?? stockFlatRows[0]

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
    if (row.id === 'stock-corporate-actions' && row.projectStatus === 'implemented') {
      return (
        <span className="feed-massive-svc-evidence-ok">
          Corporate actions sync UI: Feed → Massive Option → Corporate actions (same PostgreSQL table as stocks).
        </span>
      )
    }
    if (row.projectStatus === 'implemented') {
      return (
        <span className="feed-massive-svc-evidence-ok">
          Implemented in-app; use the controls in this section or Feed → Massive Common for shared cross-asset REST tools.
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
                    <AppSelect
                      className="form-input"
                      value={tkAllMarket}
                      onChange={setTkAllMarket}
                      disabled={!configured || tkAllBusy}
                      options={[
                        { value: '', label: 'All markets' },
                        { value: 'stocks', label: 'Stocks' },
                        { value: 'crypto', label: 'Crypto' },
                        { value: 'fx', label: 'FX' },
                        { value: 'otc', label: 'OTC' },
                        { value: 'indices', label: 'Indices' },
                      ]}
                    />
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
                    <AppSelect
                      className="form-input"
                      value={tkAllActive}
                      onChange={setTkAllActive}
                      disabled={!configured || tkAllBusy}
                      options={[
                        { value: '', label: 'Default (active)' },
                        { value: 'true', label: 'Active only' },
                        { value: 'false', label: 'Delisted only' },
                      ]}
                    />
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
                  <Button variant="secondary" type="button" disabled={!configured || tkAllBusy} onClick={runTkAllTickers}>
                    {tkAllBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {tkAllErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkAllErr}</p> : null}
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
                  <Button variant="secondary" type="button" disabled={!configured || tkOvBusy} onClick={runTkOverview}>
                    {tkOvBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {tkOvErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkOvErr}</p> : null}
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
                    <AppSelect
                      className="form-input"
                      value={tkTypesAssetClass}
                      onChange={setTkTypesAssetClass}
                      disabled={!configured || tkTypesBusy}
                      options={[
                        { value: '', label: 'All' },
                        { value: 'stocks', label: 'Stocks' },
                        { value: 'options', label: 'Options' },
                        { value: 'crypto', label: 'Crypto' },
                        { value: 'fx', label: 'FX' },
                        { value: 'indices', label: 'Indices' },
                      ]}
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Locale</span>
                    <AppSelect
                      className="form-input"
                      value={tkTypesLocale}
                      onChange={setTkTypesLocale}
                      disabled={!configured || tkTypesBusy}
                      options={[
                        { value: '', label: 'All' },
                        { value: 'us', label: 'US' },
                        { value: 'global', label: 'Global' },
                      ]}
                    />
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
                  <Button variant="secondary" type="button" disabled={!configured || tkTypesBusy} onClick={runTkTypes}>
                    {tkTypesBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {tkTypesErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkTypesErr}</p> : null}
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
                  <Button variant="secondary" type="button" disabled={!configured || tkRelBusy} onClick={runTkRelated}>
                    {tkRelBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {tkRelErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{tkRelErr}</p> : null}
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
              <MassiveRefJobSessionProvider>
                <MassiveTickerReferenceDbSection
                  panelId="feed-massive-stk-tk-panel-refdb"
                  ariaLabelledBy="feed-massive-stk-tk-tab-refdb"
                />
              </MassiveRefJobSessionProvider>
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
              id="feed-massive-stk-agg-tab-daily-market"
              className={`feed-massive-agg-tab${aggSubTab === 'daily_market_summary' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={aggSubTab === 'daily_market_summary'}
              tabIndex={aggSubTab === 'daily_market_summary' ? 0 : -1}
              onClick={() => setAggSubTab('daily_market_summary')}
            >
              Daily Market Summary
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button"
              role="tab"
              id="feed-massive-stk-agg-tab-daily-ticker"
              className={`feed-massive-agg-tab${aggSubTab === 'daily_ticker_summary' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={aggSubTab === 'daily_ticker_summary'}
              tabIndex={aggSubTab === 'daily_ticker_summary' ? 0 : -1}
              onClick={() => setAggSubTab('daily_ticker_summary')}
            >
              Daily Ticker Summary
              <span className="feed-massive-agg-tab-badge">REST</span>
            </button>
            <button
              type="button"
              role="tab"
              id="feed-massive-stk-agg-tab-previous-day"
              className={`feed-massive-agg-tab${aggSubTab === 'previous_day_bar' ? ' feed-massive-agg-tab--active' : ''}`}
              aria-selected={aggSubTab === 'previous_day_bar'}
              tabIndex={aggSubTab === 'previous_day_bar' ? 0 : -1}
              onClick={() => setAggSubTab('previous_day_bar')}
            >
              Previous Day Bar
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
                    <strong>Use case:</strong> Retrieve aggregated historical OHLC and volume for a stock ticker over a
                    custom date range and time interval (Eastern Time). Aggregates use qualifying trades only; empty
                    intervals mean no eligible trades in that window.
                  </p>
                  <p>
                    <strong>When to use:</strong> Data visualization, technical analysis, backtesting strategies, and
                    market research (including pre-market, regular session, and after-hours where applicable).
                  </p>
                  <p>
                    <strong>Demo inputs:</strong> Defaults are Unix ms for Mon <code>2024-06-03</code> regular hours only
                    (09:30–16:00 America/New_York), <code>1</code> × <code>minute</code> — a small, realistic slice for Execute
                    without editing fields.
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
                      placeholder={`e.g. ${STOCK_CUSTOM_BARS_DEFAULT_START_MS}`}
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
                      placeholder={`e.g. ${STOCK_CUSTOM_BARS_DEFAULT_END_MS}`}
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
                  <Button variant="secondary" type="button" disabled={!configured || aggStBusy} onClick={runAggCustom}>
                    {aggStBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {aggStErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{aggStErr}</p> : null}
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

            {aggSubTab === 'daily_market_summary' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-agg-panel-daily-market"
                aria-labelledby="feed-massive-stk-agg-tab-daily-market"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve daily OHLC, volume, and volume-weighted average price (VWAP)
                    for <em>all</em> U.S. stocks on a specified trading date in one request. The payload can be very
                    large.
                  </p>
                  <p>
                    <strong>When to use:</strong> Market overview, bulk data processing, historical research, and
                    portfolio comparison.
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
                  <Button variant="secondary" type="button" disabled={!configured || gdBusy} onClick={runAggGrouped}>
                    {gdBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {gdErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{gdErr}</p> : null}
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

            {aggSubTab === 'daily_ticker_summary' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-agg-panel-daily-ticker"
                aria-labelledby="feed-massive-stk-agg-tab-daily-ticker"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve opening and closing prices for one stock on one calendar date,
                    together with high, low, volume, and pre-market / after-hours trade prices when available.
                  </p>
                  <p>
                    <strong>When to use:</strong> Daily performance analysis, historical data collection, after-hours
                    insights, and portfolio tracking.
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
                  <Button variant="secondary" type="button" disabled={!configured || ocBusy} onClick={runAggOpenClose}>
                    {ocBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {ocErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{ocErr}</p> : null}
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

            {aggSubTab === 'previous_day_bar' ? (
              <div
                className="feed-massive-agg-tab-panel"
                role="tabpanel"
                id="feed-massive-stk-agg-panel-previous-day"
                aria-labelledby="feed-massive-stk-agg-tab-previous-day"
              >
                <div className="feed-massive-agg-sub-doc">
                  <p>
                    <strong>Use case:</strong> Retrieve the previous <em>trading</em> day open, high, low, and close
                    (OHLC) for a stock, including volume, in one call — no client-side calendar logic for the prior
                    session.
                  </p>
                  <p>
                    <strong>When to use:</strong> Baseline comparison, technical analysis, market research, and daily
                    reporting.
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
                  <Button variant="secondary" type="button" disabled={!configured || prevBusy} onClick={runAggPrev}>
                    {prevBusy ? 'Loading\u2026' : 'Execute'}
                  </Button>
                </div>
                {prevErr ? <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{prevErr}</p> : null}
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

  // ── Fundamentals — 7 sub-tabs ─────────────────────────────────────────────
  function renderFundamentalsCap() {
    const id = 'stock-fundamentals'
    const row = rowById(id)
    const eff = rowEff(row)

    const sharedFinancialsForm = (busy: boolean) => (
      <div className="feed-massive-form-grid">
        <label className="feed-massive-field">
          <span className="form-label">Ticker <span style={{ color: 'var(--clr-error, #e05)' }}>*</span></span>
          <input className="form-input" value={fundTicker} onChange={e => setFundTicker(e.target.value)}
            disabled={!configured || busy} placeholder="AAPL" autoComplete="off" />
        </label>
        <label className="feed-massive-field">
          <span className="form-label">Timeframe</span>
          <AppSelect
            className="form-input"
            value={fundTimeframe}
            onChange={setFundTimeframe}
            disabled={!configured || busy}
            options={[
              { value: 'annual', label: 'Annual' },
              { value: 'quarterly', label: 'Quarterly' },
              { value: 'trailing_twelve_months', label: 'Trailing 12 months' },
            ]}
          />
        </label>
        <label className="feed-massive-field">
          <span className="form-label">Fiscal Year</span>
          <input className="form-input" value={fundFiscalYear} onChange={e => setFundFiscalYear(e.target.value)}
            disabled={!configured || busy} placeholder="e.g. 2024" autoComplete="off" />
        </label>
        <label className="feed-massive-field">
          <span className="form-label">Fiscal Quarter</span>
          <AppSelect
            className="form-input"
            value={fundFiscalQuarter}
            onChange={setFundFiscalQuarter}
            disabled={!configured || busy}
            options={[
              { value: '', label: 'Any' },
              { value: '1', label: 'Q1' },
              { value: '2', label: 'Q2' },
              { value: '3', label: 'Q3' },
              { value: '4', label: 'Q4' },
            ]}
          />
        </label>
        <label className="feed-massive-field">
          <span className="form-label">Period End</span>
          <input className="form-input" value={fundPeriodEnd} onChange={e => setFundPeriodEnd(e.target.value)}
            disabled={!configured || busy} placeholder="YYYY-MM-DD" autoComplete="off" />
        </label>
        <label className="feed-massive-field">
          <span className="form-label">Filing Date</span>
          <input className="form-input" value={fundFilingDate} onChange={e => setFundFilingDate(e.target.value)}
            disabled={!configured || busy} placeholder="YYYY-MM-DD" autoComplete="off" />
        </label>
        <label className="feed-massive-field">
          <span className="form-label">Limit</span>
          <input className="form-input" type="number" value={fundLimit} onChange={e => setFundLimit(e.target.value)}
            disabled={!configured || busy} min={1} max={1000} />
        </label>
      </div>
    )

    return (
      <StockCapabilityPanel
        key={id} capId={id} checklistRow={row} effectiveStatus={eff}
        expanded={capExpanded[id] === true} onToggle={() => toggleCap(id)}
        highlight={highlightedCapabilityId === id} ariaLabel={row.service}
      >
        <FeedMassiveServiceBlock effectiveStatus={eff} checklistRow={row} evidence={evidenceFor(row)}>
          <div className="feed-massive-card-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className="feed-massive-card-icon" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M4 5h12M4 9h8M4 13h10M4 17h6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
              </span>
              <h3>{row.service}</h3>
            </div>
          </div>
          <p className="feed-massive-card-lead">{row.description}</p>
        </FeedMassiveServiceBlock>

        <div className="feed-massive-agg-tabs-wrap">
          <div className="feed-massive-agg-tabs" role="tablist" aria-label="Fundamentals API endpoints">
            {(
              [
                ['income_statements', 'Income Statements'],
                ['balance_sheets', 'Balance Sheets'],
                ['cash_flow', 'Cash Flow'],
                ['ratios', 'Ratios'],
                ['short_interest', 'Short Interest'],
                ['short_volume', 'Short Volume'],
                ['float', 'Float'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" role="tab"
                id={`feed-massive-stk-fund-tab-${key}`}
                className={`feed-massive-agg-tab${fundSubTab === key ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={fundSubTab === key}
                tabIndex={fundSubTab === key ? 0 : -1}
                onClick={() => setFundSubTab(key)}
              >
                {label}
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
            ))}
          </div>

          <div className="feed-massive-agg-tab-panels">

            {/* ── Income Statements ──────────────────────────────────────── */}
            {fundSubTab === 'income_statements' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fund-panel-income"
                aria-labelledby="feed-massive-stk-fund-tab-income_statements">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve P&amp;L data — revenue, gross profit, operating income, net income, EPS — for annual, quarterly, or trailing-twelve-month periods.</p>
                  <p><strong>When to use:</strong> Earnings trend analysis, profitability screening, fundamental research.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/financials/v1/income-statements</code></p>
                </div>
                {sharedFinancialsForm(fundISBusy)}
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>revenues</code>, <code>gross_profit</code>, <code>operating_income_loss</code>, <code>net_income_loss</code>, <code>basic_earnings_per_share</code>, <code>diluted_earnings_per_share</code>, <code>research_and_development</code>, <code>fiscal_year</code>, <code>fiscal_quarter</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/fundamentals/income-statements</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fundISBusy} onClick={runFundIS}>
                    {fundISBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fundISErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fundISErr}</p>}
                {fundISResult && (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result{Array.isArray((fundISResult as Record<string, unknown>).results) ? ` — ${((fundISResult as Record<string, unknown>).results as unknown[]).length} period(s)` : ''}</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(fundISResult, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}

            {/* ── Balance Sheets ─────────────────────────────────────────── */}
            {fundSubTab === 'balance_sheets' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fund-panel-bs"
                aria-labelledby="feed-massive-stk-fund-tab-balance_sheets">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve point-in-time assets, liabilities, and equity — cash, receivables, inventory, PP&amp;E, short/long-term debt, retained earnings.</p>
                  <p><strong>When to use:</strong> Financial health assessment, solvency screening, debt-to-equity calculation.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/financials/v1/balance-sheets</code></p>
                </div>
                {sharedFinancialsForm(fundBSBusy)}
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>assets</code>, <code>current_assets</code>, <code>cash_and_cash_equivalents_including_short_term_investments</code>, <code>liabilities</code>, <code>long_term_debt</code>, <code>equity</code>, <code>retained_earnings</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/fundamentals/balance-sheets</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fundBSBusy} onClick={runFundBS}>
                    {fundBSBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fundBSErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fundBSErr}</p>}
                {fundBSResult && (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result{Array.isArray((fundBSResult as Record<string, unknown>).results) ? ` — ${((fundBSResult as Record<string, unknown>).results as unknown[]).length} period(s)` : ''}</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(fundBSResult, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}

            {/* ── Cash Flow Statements ───────────────────────────────────── */}
            {fundSubTab === 'cash_flow' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fund-panel-cf"
                aria-labelledby="feed-massive-stk-fund-tab-cash_flow">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve operating cash flow (OCF), CapEx, asset sales, debt issuance/repayment, and dividends paid to assess cash generation quality and free cash flow.</p>
                  <p><strong>When to use:</strong> FCF analysis, capital allocation research, quality-of-earnings checks.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/financials/v1/cash-flow-statements</code></p>
                </div>
                {sharedFinancialsForm(fundCFBusy)}
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>net_cash_from_operating_activities</code>, <code>net_cash_from_investing_activities</code>, <code>net_cash_from_financing_activities</code>, <code>purchase_of_property_plant_and_equipment</code>, <code>dividends</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/fundamentals/cash-flow-statements</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fundCFBusy} onClick={runFundCF}>
                    {fundCFBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fundCFErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fundCFErr}</p>}
                {fundCFResult && (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result{Array.isArray((fundCFResult as Record<string, unknown>).results) ? ` — ${((fundCFResult as Record<string, unknown>).results as unknown[]).length} period(s)` : ''}</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(fundCFResult, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}

            {/* ── Ratios ─────────────────────────────────────────────────── */}
            {fundSubTab === 'ratios' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fund-panel-ratios"
                aria-labelledby="feed-massive-stk-fund-tab-ratios">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve valuation, profitability, liquidity, and leverage ratios (P/E, P/B, ROE, D/E, dividend yield, EPS) combined with the latest daily stock price.</p>
                  <p><strong>When to use:</strong> Quantitative screening, ratio scorecards, comparative valuation.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/financials/v1/ratios</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker <span style={{ color: 'var(--clr-error, #e05)' }}>*</span></span>
                    <input className="form-input" value={fundTicker} onChange={e => setFundTicker(e.target.value)}
                      disabled={!configured || fundRatiosBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={fundLimit} onChange={e => setFundLimit(e.target.value)}
                      disabled={!configured || fundRatiosBusy} min={1} max={1000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>price_to_earnings</code>, <code>price_to_book</code>, <code>price_to_sales</code>, <code>return_on_equity</code>, <code>return_on_assets</code>, <code>debt_to_equity</code>, <code>dividend_yield</code>, <code>earnings_per_share</code>, <code>market_cap</code>, <code>enterprise_value</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/fundamentals/ratios</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fundRatiosBusy} onClick={runFundRatios}>
                    {fundRatiosBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fundRatiosErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fundRatiosErr}</p>}
                {fundRatiosResult && (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(fundRatiosResult, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}

            {/* ── Short Interest ─────────────────────────────────────────── */}
            {fundSubTab === 'short_interest' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fund-panel-si"
                aria-labelledby="feed-massive-stk-fund-tab-short_interest">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve total shares sold short, average daily volume, and days-to-cover by settlement date to assess short squeeze risk and monitor crowded short positions.</p>
                  <p><strong>When to use:</strong> Short squeeze screening, sentiment analysis, pre-earnings risk assessment.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/v1/short-interest</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker <span style={{ color: 'var(--clr-error, #e05)' }}>*</span></span>
                    <input className="form-input" value={fundSITicker} onChange={e => setFundSITicker(e.target.value)}
                      disabled={!configured || fundSIBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Settlement Date</span>
                    <input className="form-input" value={fundSIDate} onChange={e => setFundSIDate(e.target.value)}
                      disabled={!configured || fundSIBusy} placeholder="YYYY-MM-DD (optional)" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={fundSILimit} onChange={e => setFundSILimit(e.target.value)}
                      disabled={!configured || fundSIBusy} min={1} max={1000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>short_interest</code>, <code>avg_daily_volume</code>, <code>days_to_cover</code>, <code>settlement_date</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/fundamentals/short-interest</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fundSIBusy} onClick={runFundShortInterest}>
                    {fundSIBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fundSIErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fundSIErr}</p>}
                {fundSIResult && (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result{Array.isArray((fundSIResult as Record<string, unknown>).results) ? ` — ${((fundSIResult as Record<string, unknown>).results as unknown[]).length} record(s)` : ''}</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(fundSIResult, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}

            {/* ── Short Volume ───────────────────────────────────────────── */}
            {fundSubTab === 'short_volume' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fund-panel-sv"
                aria-labelledby="feed-massive-stk-fund-tab-short_volume">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve daily short-sale volume per trading venue (NYSE, NASDAQ, ADF) and the overall short-volume ratio (short/total) for trend and sentiment analysis.</p>
                  <p><strong>When to use:</strong> Intraday short-selling activity monitoring, venue distribution research, short-ratio trend tracking.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/v1/short-volume</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker <span style={{ color: 'var(--clr-error, #e05)' }}>*</span></span>
                    <input className="form-input" value={fundSVTicker} onChange={e => setFundSVTicker(e.target.value)}
                      disabled={!configured || fundSVBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Date</span>
                    <input className="form-input" value={fundSVDate} onChange={e => setFundSVDate(e.target.value)}
                      disabled={!configured || fundSVBusy} placeholder="YYYY-MM-DD (optional)" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={fundSVLimit} onChange={e => setFundSVLimit(e.target.value)}
                      disabled={!configured || fundSVBusy} min={1} max={1000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>short_volume</code>, <code>short_volume_ratio</code>, <code>total_volume</code>, <code>nyse_short_volume</code>, <code>nasdaq_carteret_short_volume</code>, <code>adf_short_volume</code>, <code>date</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/fundamentals/short-volume</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fundSVBusy} onClick={runFundShortVolume}>
                    {fundSVBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fundSVErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fundSVErr}</p>}
                {fundSVResult && (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result{Array.isArray((fundSVResult as Record<string, unknown>).results) ? ` — ${((fundSVResult as Record<string, unknown>).results as unknown[]).length} record(s)` : ''}</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(fundSVResult, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}

            {/* ── Float ──────────────────────────────────────────────────── */}
            {fundSubTab === 'float' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fund-panel-float"
                aria-labelledby="feed-massive-stk-fund-tab-float">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve freely tradable shares (<code>free_float</code>) and their percentage of total shares outstanding (<code>free_float_percent</code>), excluding strategic holders, insiders, and 5%+ shareholders.</p>
                  <p><strong>When to use:</strong> Float-adjusted screening, short-float ratio calculation, supply/demand analysis for volatility assessment.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/vX/float</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker <span style={{ color: 'var(--clr-error, #e05)' }}>*</span></span>
                    <input className="form-input" value={fundFloatTicker} onChange={e => setFundFloatTicker(e.target.value)}
                      disabled={!configured || fundFloatBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={fundFloatLimit} onChange={e => setFundFloatLimit(e.target.value)}
                      disabled={!configured || fundFloatBusy} min={1} max={5000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>free_float</code>, <code>free_float_percent</code>, <code>effective_date</code>, <code>ticker</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/fundamentals/float</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fundFloatBusy} onClick={runFundFloat}>
                    {fundFloatBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fundFloatErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fundFloatErr}</p>}
                {fundFloatResult && (
                  <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                    <summary>Result{Array.isArray((fundFloatResult as Record<string, unknown>).results) ? ` — ${((fundFloatResult as Record<string, unknown>).results as unknown[]).length} record(s)` : ''}</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(fundFloatResult, null, 2)}</pre>
                  </details>
                )}
              </div>
            )}

          </div>
        </div>
      </StockCapabilityPanel>
    )
  }

  // ── Render Filings & Disclosures section with 8 sub-tabs ─────────────────
  function renderFilingsCap() {
    const id = 'stock-filings'
    const row = rowById(id)
    const eff = rowEff(row)

    const resultBlock = (result: Record<string, unknown> | null, label?: string) =>
      result ? (
        <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
          <summary>{label ?? 'Result'}{Array.isArray((result).results) ? ` — ${((result).results as unknown[]).length} record(s)` : ''}</summary>
          <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(result, null, 2)}</pre>
        </details>
      ) : null

    return (
      <StockCapabilityPanel
        key={id} capId={id} checklistRow={row} effectiveStatus={eff}
        expanded={capExpanded[id] === true} onToggle={() => toggleCap(id)}
        highlight={highlightedCapabilityId === id} ariaLabel={row.service}
      >
        <FeedMassiveServiceBlock effectiveStatus={eff} checklistRow={row} evidence={evidenceFor(row)}>
          <div className="feed-massive-card-head">
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span className="feed-massive-card-icon" aria-hidden>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="3" y="2" width="14" height="16" rx="2" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M7 6h6M7 9h6M7 12h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                </svg>
              </span>
              <h3>{row.service}</h3>
            </div>
          </div>
          <p className="feed-massive-card-lead">{row.description}</p>
        </FeedMassiveServiceBlock>

        <div className="feed-massive-agg-tabs-wrap">
          <div className="feed-massive-agg-tabs" role="tablist" aria-label="Filings & Disclosures API endpoints">
            {(
              [
                ['edgar_index', 'Edgar Index'],
                ['sections_10k', '10-K Sections'],
                ['text_8k', '8-K Text'],
                ['form_13f', '13-F Filings'],
                ['risk_factors', 'Risk Factors'],
                ['risk_categories', 'Risk Categories'],
                ['form_3', 'Form 3'],
                ['form_4', 'Form 4'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} type="button" role="tab"
                id={`feed-massive-stk-fl-tab-${key}`}
                className={`feed-massive-agg-tab${filingsSubTab === key ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={filingsSubTab === key}
                tabIndex={filingsSubTab === key ? 0 : -1}
                onClick={() => setFilingsSubTab(key)}
              >
                {label}
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
            ))}
          </div>

          <div className="feed-massive-agg-tab-panels">

            {/* ── Edgar Index ────────────────────────────────────────────── */}
            {filingsSubTab === 'edgar_index' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-edgar" aria-labelledby="feed-massive-stk-fl-tab-edgar_index">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Search the SEC EDGAR database for corporate filings (10-K, 10-Q, 8-K, S-1, etc.) by ticker, CIK, form type, or filing date range with powerful comparison operators.</p>
                  <p><strong>When to use:</strong> Discover filing history for a company, monitor new submissions, or build event-driven pipelines triggered by specific form types.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/filings/vX/index</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker</span>
                    <input className="form-input" value={flEiTicker} onChange={e => setFlEiTicker(e.target.value)}
                      disabled={!configured || flEiBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">CIK</span>
                    <input className="form-input" value={flEiCik} onChange={e => setFlEiCik(e.target.value)}
                      disabled={!configured || flEiBusy} placeholder="0000320193" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Form Type</span>
                    <input className="form-input" value={flEiFormType} onChange={e => setFlEiFormType(e.target.value)}
                      disabled={!configured || flEiBusy} placeholder="10-K, 10-Q, 8-K…" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≥</span>
                    <input className="form-input" value={flEiDateGte} onChange={e => setFlEiDateGte(e.target.value)}
                      disabled={!configured || flEiBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≤</span>
                    <input className="form-input" value={flEiDateLte} onChange={e => setFlEiDateLte(e.target.value)}
                      disabled={!configured || flEiBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={flEiLimit} onChange={e => setFlEiLimit(e.target.value)}
                      disabled={!configured || flEiBusy} min={1} max={50000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>accession_number</code>, <code>cik</code>, <code>ticker</code>, <code>issuer_name</code>, <code>form_type</code>, <code>filing_date</code>, <code>filing_url</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/edgar-index</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || flEiBusy} onClick={runEdgarIndex}>
                    {flEiBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {flEiErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{flEiErr}</p>}
                {resultBlock(flEiResult)}
              </div>
            )}

            {/* ── 10-K Sections ─────────────────────────────────────────── */}
            {filingsSubTab === 'sections_10k' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-10k" aria-labelledby="feed-massive-stk-fl-tab-sections_10k">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Extract plain-text sections from annual 10-K filings — business overview, risk factors, MD&A, financial statements, legal proceedings, and more.</p>
                  <p><strong>When to use:</strong> NLP text analysis, risk assessment, competitive benchmarking from standardized annual report sections. Each result includes the full section text.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/filings/10-K/vX/sections</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker</span>
                    <input className="form-input" value={fl10kTicker} onChange={e => setFl10kTicker(e.target.value)}
                      disabled={!configured || fl10kBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">CIK</span>
                    <input className="form-input" value={fl10kCik} onChange={e => setFl10kCik(e.target.value)}
                      disabled={!configured || fl10kBusy} placeholder="0000320193" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Section</span>
                    <input className="form-input" value={fl10kSection} onChange={e => setFl10kSection(e.target.value)}
                      disabled={!configured || fl10kBusy} placeholder="e.g. RISK_FACTORS, MD_AND_A" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≥</span>
                    <input className="form-input" value={fl10kDateGte} onChange={e => setFl10kDateGte(e.target.value)}
                      disabled={!configured || fl10kBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≤</span>
                    <input className="form-input" value={fl10kDateLte} onChange={e => setFl10kDateLte(e.target.value)}
                      disabled={!configured || fl10kBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Period End ≥</span>
                    <input className="form-input" value={fl10kPeriodEndGte} onChange={e => setFl10kPeriodEndGte(e.target.value)}
                      disabled={!configured || fl10kBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Period End ≤</span>
                    <input className="form-input" value={fl10kPeriodEndLte} onChange={e => setFl10kPeriodEndLte(e.target.value)}
                      disabled={!configured || fl10kBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit (max 99)</span>
                    <input className="form-input" type="number" value={fl10kLimit} onChange={e => setFl10kLimit(e.target.value)}
                      disabled={!configured || fl10kBusy} min={1} max={99} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>cik</code>, <code>ticker</code>, <code>filing_date</code>, <code>period_end</code>, <code>section</code>, <code>text</code>, <code>filing_url</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/10k-sections</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fl10kBusy} onClick={run10KSections}>
                    {fl10kBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fl10kErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fl10kErr}</p>}
                {resultBlock(fl10kResult)}
              </div>
            )}

            {/* ── 8-K Text ───────────────────────────────────────────────── */}
            {filingsSubTab === 'text_8k' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-8k" aria-labelledby="feed-massive-stk-fl-tab-text_8k">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve parsed plain-text from the core Items sections of Form 8-K current reports — material events, M&A, executive changes, earnings announcements.</p>
                  <p><strong>When to use:</strong> Real-time event detection, M&A tracking, automated text analysis for major corporate event items. Includes <code>items_text</code> parsed from the filing body.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/filings/8-K/vX/text</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker</span>
                    <input className="form-input" value={fl8kTicker} onChange={e => setFl8kTicker(e.target.value)}
                      disabled={!configured || fl8kBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">CIK</span>
                    <input className="form-input" value={fl8kCik} onChange={e => setFl8kCik(e.target.value)}
                      disabled={!configured || fl8kBusy} placeholder="0000320193" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Form Type</span>
                    <input className="form-input" value={fl8kFormType} onChange={e => setFl8kFormType(e.target.value)}
                      disabled={!configured || fl8kBusy} placeholder="8-K, 8-K/A" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≥</span>
                    <input className="form-input" value={fl8kDateGte} onChange={e => setFl8kDateGte(e.target.value)}
                      disabled={!configured || fl8kBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≤</span>
                    <input className="form-input" value={fl8kDateLte} onChange={e => setFl8kDateLte(e.target.value)}
                      disabled={!configured || fl8kBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit (max 99)</span>
                    <input className="form-input" type="number" value={fl8kLimit} onChange={e => setFl8kLimit(e.target.value)}
                      disabled={!configured || fl8kBusy} min={1} max={99} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>accession_number</code>, <code>ticker</code>, <code>cik</code>, <code>filing_date</code>, <code>items_text</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/8k-text</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fl8kBusy} onClick={run8KText}>
                    {fl8kBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fl8kErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fl8kErr}</p>}
                {resultBlock(fl8kResult)}
              </div>
            )}

            {/* ── 13-F Filings ──────────────────────────────────────────── */}
            {filingsSubTab === 'form_13f' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-13f" aria-labelledby="feed-massive-stk-fl-tab-form_13f">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve institutional equity holdings from quarterly Form 13-F filings. See what hedge funds, mutual funds, and $100M+ asset managers hold.</p>
                  <p><strong>When to use:</strong> Analyze institutional ownership trends, track portfolio entries/exits by specific managers, or identify crowded institutional positions.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/filings/vX/13-F</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Filer CIK</span>
                    <input className="form-input" value={fl13fFilerCik} onChange={e => setFl13fFilerCik(e.target.value)}
                      disabled={!configured || fl13fBusy} placeholder="SEC CIK of the institution" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≥</span>
                    <input className="form-input" value={fl13fDateGte} onChange={e => setFl13fDateGte(e.target.value)}
                      disabled={!configured || fl13fBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≤</span>
                    <input className="form-input" value={fl13fDateLte} onChange={e => setFl13fDateLte(e.target.value)}
                      disabled={!configured || fl13fBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={fl13fLimit} onChange={e => setFl13fLimit(e.target.value)}
                      disabled={!configured || fl13fBusy} min={1} max={1000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>accession_number</code>, <code>filer_cik</code>, <code>filing_date</code>, <code>issuer_name</code>, <code>market_value</code>, <code>shares_or_principal_amount</code>, <code>period</code>, <code>voting_authority_sole</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/13f</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || fl13fBusy} onClick={run13FFilings}>
                    {fl13fBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {fl13fErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{fl13fErr}</p>}
                {resultBlock(fl13fResult)}
              </div>
            )}

            {/* ── Risk Factors ───────────────────────────────────────────── */}
            {filingsSubTab === 'risk_factors' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-rf" aria-labelledby="feed-massive-stk-fl-tab-risk_factors">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Access standardized, machine-readable risk factor disclosures from SEC filings. Each record includes the supporting text and a three-level taxonomy classification (primary / secondary / tertiary category).</p>
                  <p><strong>When to use:</strong> Build risk dashboards, compare risk profiles across companies, track how a company's disclosed risks change over time.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/filings/vX/risk-factors</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Ticker</span>
                    <input className="form-input" value={flRfTicker} onChange={e => setFlRfTicker(e.target.value)}
                      disabled={!configured || flRfBusy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">CIK</span>
                    <input className="form-input" value={flRfCik} onChange={e => setFlRfCik(e.target.value)}
                      disabled={!configured || flRfBusy} placeholder="0000320193" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≥</span>
                    <input className="form-input" value={flRfDateGte} onChange={e => setFlRfDateGte(e.target.value)}
                      disabled={!configured || flRfBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≤</span>
                    <input className="form-input" value={flRfDateLte} onChange={e => setFlRfDateLte(e.target.value)}
                      disabled={!configured || flRfBusy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={flRfLimit} onChange={e => setFlRfLimit(e.target.value)}
                      disabled={!configured || flRfBusy} min={1} max={49999} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>cik</code>, <code>ticker</code>, <code>filing_date</code>, <code>primary_category</code>, <code>secondary_category</code>, <code>tertiary_category</code>, <code>supporting_text</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/risk-factors</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || flRfBusy} onClick={runRiskFactors}>
                    {flRfBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {flRfErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{flRfErr}</p>}
                {resultBlock(flRfResult)}
              </div>
            )}

            {/* ── Risk Categories ────────────────────────────────────────── */}
            {filingsSubTab === 'risk_categories' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-rc" aria-labelledby="feed-massive-stk-fl-tab-risk_categories">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Browse the hierarchical taxonomy used to classify risk factors — three levels of categories with descriptions. Use this as a reference to understand and filter the Risk Factors endpoint.</p>
                  <p><strong>When to use:</strong> Discover all available risk categories before filtering Risk Factors, or build risk classification models and category-level analytics dashboards.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/taxonomies/vX/risk-factors</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Primary Category</span>
                    <input className="form-input" value={flRcPrimary} onChange={e => setFlRcPrimary(e.target.value)}
                      disabled={!configured || flRcBusy} placeholder="e.g. MARKET_RISK" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Secondary Category</span>
                    <input className="form-input" value={flRcSecondary} onChange={e => setFlRcSecondary(e.target.value)}
                      disabled={!configured || flRcBusy} placeholder="optional filter" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Tertiary Category</span>
                    <input className="form-input" value={flRcTertiary} onChange={e => setFlRcTertiary(e.target.value)}
                      disabled={!configured || flRcBusy} placeholder="optional filter" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit (max 999)</span>
                    <input className="form-input" type="number" value={flRcLimit} onChange={e => setFlRcLimit(e.target.value)}
                      disabled={!configured || flRcBusy} min={1} max={999} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>description</code>, <code>primary_category</code>, <code>secondary_category</code>, <code>tertiary_category</code>, <code>taxonomy</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/risk-categories</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || flRcBusy} onClick={runRiskCategories}>
                    {flRcBusy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {flRcErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{flRcErr}</p>}
                {resultBlock(flRcResult)}
              </div>
            )}

            {/* ── Form 3 ─────────────────────────────────────────────────── */}
            {filingsSubTab === 'form_3' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-f3" aria-labelledby="feed-massive-stk-fl-tab-form_3">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve Form 3 filings — initial statements of beneficial ownership filed by corporate insiders (directors, officers, 10%+ shareholders) when first acquiring a reportable position.</p>
                  <p><strong>When to use:</strong> Track insider position initiations, identify new insider appointments, monitor initial ownership disclosures for governance analysis.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/filings/vX/form-3</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Tickers</span>
                    <input className="form-input" value={flF3Tickers} onChange={e => setFlF3Tickers(e.target.value)}
                      disabled={!configured || flF3Busy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Issuer CIK</span>
                    <input className="form-input" value={flF3IssuerCik} onChange={e => setFlF3IssuerCik(e.target.value)}
                      disabled={!configured || flF3Busy} placeholder="CIK of the company" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Owner CIK</span>
                    <input className="form-input" value={flF3OwnerCik} onChange={e => setFlF3OwnerCik(e.target.value)}
                      disabled={!configured || flF3Busy} placeholder="CIK of the insider" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≥</span>
                    <input className="form-input" value={flF3DateGte} onChange={e => setFlF3DateGte(e.target.value)}
                      disabled={!configured || flF3Busy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≤</span>
                    <input className="form-input" value={flF3DateLte} onChange={e => setFlF3DateLte(e.target.value)}
                      disabled={!configured || flF3Busy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={flF3Limit} onChange={e => setFlF3Limit(e.target.value)}
                      disabled={!configured || flF3Busy} min={1} max={10000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>accession_number</code>, <code>filing_date</code>, <code>period_of_report</code>, <code>issuer_name</code>, <code>owner_name</code>, <code>security_title</code>, <code>shares_owned</code>, <code>is_director</code>, <code>is_officer</code>, <code>is_ten_percent_owner</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/form-3</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || flF3Busy} onClick={runForm3}>
                    {flF3Busy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {flF3Err && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{flF3Err}</p>}
                {resultBlock(flF3Result)}
              </div>
            )}

            {/* ── Form 4 ─────────────────────────────────────────────────── */}
            {filingsSubTab === 'form_4' && (
              <div className="feed-massive-agg-tab-panel" role="tabpanel"
                id="feed-massive-stk-fl-panel-f4" aria-labelledby="feed-massive-stk-fl-tab-form_4">
                <div className="feed-massive-agg-sub-doc">
                  <p><strong>Use case:</strong> Retrieve Form 4 filings documenting changes in insider securities ownership — purchases, sales, option exercises, and awards. Filter by transaction code to isolate open-market buys (P) or sales (S).</p>
                  <p><strong>When to use:</strong> Insider trading signal analysis, track buying clusters before earnings, identify insider selling pressure, or monitor executive compensation awards.</p>
                  <p className="feed-massive-agg-sub-endpoint"><code>GET /stocks/filings/vX/form-4</code></p>
                </div>
                <div className="feed-massive-form-grid">
                  <label className="feed-massive-field">
                    <span className="form-label">Tickers</span>
                    <input className="form-input" value={flF4Tickers} onChange={e => setFlF4Tickers(e.target.value)}
                      disabled={!configured || flF4Busy} placeholder="AAPL" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Issuer CIK</span>
                    <input className="form-input" value={flF4IssuerCik} onChange={e => setFlF4IssuerCik(e.target.value)}
                      disabled={!configured || flF4Busy} placeholder="CIK of the company" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Owner CIK</span>
                    <input className="form-input" value={flF4OwnerCik} onChange={e => setFlF4OwnerCik(e.target.value)}
                      disabled={!configured || flF4Busy} placeholder="CIK of the insider" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Transaction Code</span>
                    <AppSelect
                      className="form-input"
                      value={flF4TxCode}
                      onChange={setFlF4TxCode}
                      disabled={!configured || flF4Busy}
                      options={[
                        { value: '', label: 'Any' },
                        { value: 'P', label: 'P — Open-market purchase' },
                        { value: 'S', label: 'S — Open-market sale' },
                        { value: 'A', label: 'A — Grant/award' },
                        { value: 'M', label: 'M — Option exercise' },
                        { value: 'F', label: 'F — Tax withholding' },
                        { value: 'G', label: 'G — Gift' },
                      ]}
                    />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≥</span>
                    <input className="form-input" value={flF4DateGte} onChange={e => setFlF4DateGte(e.target.value)}
                      disabled={!configured || flF4Busy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Filing Date ≤</span>
                    <input className="form-input" value={flF4DateLte} onChange={e => setFlF4DateLte(e.target.value)}
                      disabled={!configured || flF4Busy} placeholder="YYYY-MM-DD" autoComplete="off" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Limit</span>
                    <input className="form-input" type="number" value={flF4Limit} onChange={e => setFlF4Limit(e.target.value)}
                      disabled={!configured || flF4Busy} min={1} max={10000} />
                  </label>
                </div>
                <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
                  <p><strong>Key fields:</strong> <code>accession_number</code>, <code>filing_date</code>, <code>issuer_name</code>, <code>owner_name</code>, <code>transaction_shares</code>, <code>transaction_price_per_share</code>, <code>transaction_value</code>, <code>is_director</code>, <code>is_officer</code></p>
                  <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/filings/form-4</code></p>
                </div>
                <div style={{ marginTop: 'var(--space-3)' }}>
                  <Button variant="secondary" type="button" disabled={!configured || flF4Busy} onClick={runForm4}>
                    {flF4Busy ? 'Loading…' : 'Execute'}
                  </Button>
                </div>
                {flF4Err && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{flF4Err}</p>}
                {resultBlock(flF4Result)}
              </div>
            )}

          </div>
        </div>
      </StockCapabilityPanel>
    )
  }

  function renderNewsCap() {
    const id = 'stock-news'
    const row = rowById(id)
    const eff = rowEff(row)
    return (
      <StockCapabilityPanel
        key={id} capId={id} checklistRow={row} effectiveStatus={eff}
        expanded={capExpanded[id] === true} onToggle={() => toggleCap(id)}
        highlight={highlightedCapabilityId === id} ariaLabel={row.service}
      >
        <FeedMassiveServiceBlock effectiveStatus={eff} checklistRow={row} evidence={evidenceFor(row)}>
          <div className="feed-massive-card-head">
            <h3>{row.service}</h3>
          </div>
          <p className="feed-massive-card-lead">{row.description}</p>
        </FeedMassiveServiceBlock>

        <div className="feed-massive-agg-sub-doc">
          <p><strong>Use case:</strong> Retrieve stock-related news articles with ticker and publication time filters for event tracking and research context.</p>
          <p><strong>When to use:</strong> Earnings/news event correlation, catalyst detection, and timeline reconstruction around large price moves.</p>
          <p className="feed-massive-agg-sub-endpoint"><code>GET /v2/reference/news</code></p>
        </div>

        <div className="feed-massive-form-grid">
          <label className="feed-massive-field">
            <span className="form-label">Ticker</span>
            <input className="form-input" value={newsTicker} onChange={e => setNewsTicker(e.target.value)}
              disabled={!configured || newsBusy} placeholder="AAPL" autoComplete="off" />
          </label>
          <label className="feed-massive-field">
            <span className="form-label">Published UTC ≥</span>
            <input className="form-input" value={newsPublishedGte} onChange={e => setNewsPublishedGte(e.target.value)}
              disabled={!configured || newsBusy} placeholder="2026-04-01T00:00:00Z" autoComplete="off" />
          </label>
          <label className="feed-massive-field">
            <span className="form-label">Published UTC ≤</span>
            <input className="form-input" value={newsPublishedLte} onChange={e => setNewsPublishedLte(e.target.value)}
              disabled={!configured || newsBusy} placeholder="2026-04-28T23:59:59Z" autoComplete="off" />
          </label>
          <label className="feed-massive-field">
            <span className="form-label">Limit</span>
            <input className="form-input" type="number" value={newsLimit} onChange={e => setNewsLimit(e.target.value)}
              disabled={!configured || newsBusy} min={1} max={1000} />
          </label>
          <label className="feed-massive-field">
            <span className="form-label">Sort</span>
            <input className="form-input" value={newsSort} onChange={e => setNewsSort(e.target.value)}
              disabled={!configured || newsBusy} placeholder="published_utc" autoComplete="off" />
          </label>
          <label className="feed-massive-field">
            <span className="form-label">Order</span>
            <AppSelect
              className="form-input"
              value={newsOrder}
              onChange={setNewsOrder}
              disabled={!configured || newsBusy}
              options={[
                { value: 'desc', label: 'desc' },
                { value: 'asc', label: 'asc' },
              ]}
            />
          </label>
        </div>

        <div className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-2)' }}>
          <p><strong>Key fields:</strong> <code>id</code>, <code>title</code>, <code>author</code>, <code>published_utc</code>, <code>article_url</code>, <code>tickers[]</code>, <code>publisher.name</code></p>
          <p style={{ marginTop: 'var(--space-1)' }}><strong>Proxy:</strong> <code>GET /research/massive/stocks/news</code></p>
        </div>
        <div style={{ marginTop: 'var(--space-3)' }}>
          <Button variant="secondary" type="button" disabled={!configured || newsBusy} onClick={runStockNews}>
            {newsBusy ? 'Loading…' : 'Execute'}
          </Button>
        </div>
        {newsErr && <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-3)' }}>{newsErr}</p>}
        {newsResult ? (
          <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
            <summary>Result{Array.isArray((newsResult).results) ? ` — ${((newsResult).results as unknown[]).length} record(s)` : ''}</summary>
            <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '28rem' }}>{JSON.stringify(newsResult, null, 2)}</pre>
          </details>
        ) : null}
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
    <PageSection className="feed-massive-option-page min-w-0">

      {/* Title */}
      <div className="feed-massive-title-block">
        <div className="feed-massive-title-main">
          <SectionPageTitle
            menu="Feed"
            pageTitle={breadcrumbLabel}
            onMenuClick={onGoToFeed}
            menuNavigateAriaLabel="Go to Feed"
            infoText="Massive (Polygon) Stocks API coverage sheet and capability status. Shared REST (Technical Indicators, Market Operations) lives under Feed → Massive Common; corporate actions sync UI remains under Feed → Massive Option. Stock-specific endpoints are planned."
            style={{ marginBottom: 0 }}
          >
            {configured ? (
              <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice}>
                Delayed feed
              </span>
            ) : null}
          </SectionPageTitle>
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
            <Button variant="secondary" asChild><a
              href={MASSIVE_STOCKS_COVERAGE_PLAN_URL}
              target="_blank"
              rel="noopener noreferrer"
              
            >
              Open in new tab
            </a></Button>
            <Button variant="secondary" type="button" disabled={apiCoverageSyncBusy} onClick={async () => {
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
            </Button>
            <Button variant="secondary" type="button" onClick={() => setApiCoverageOpen(v => !v)}
              aria-expanded={apiCoverageOpen}
            >
              {apiCoverageOpen ? 'Hide embedded viewer' : 'Show embedded viewer'}
            </Button>
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
        <p className={cn(w9.statusPageMsg, 'err')} role="alert">
          Massive API key not configured. Set massive credentials in server config. Shared capabilities (Technical Indicators, Market Operations) are under Feed → Massive Common.
        </p>
      )}

      {/* Main capability panels */}
      <div className="feed-massive-tab-panel">

        <section
          className="feed-massive-card"
          style={{ marginBottom: 'var(--space-4)' }}
          aria-labelledby="feed-massive-delay-db-nav-heading"
        >
          <h3 id="feed-massive-delay-db-nav-heading" className="feed-massive-section-header">
            Massive Delay (DB)
          </h3>
          <p className="feed-massive-card-lead">
            Celery jobs that persist Massive REST data to PostgreSQL (reference sync and stock OHLC) live on Data Coverage → Stock → Massive Delay (DB).
          </p>
          <Button variant="secondary" type="button" onClick={() => { window.location.hash = '#coverage-massive-stock' }}
          >
            Open Massive Delay (DB)
          </Button>
        </section>

        <div className="feed-massive-delivery-tabs">
          <div className="feed-massive-delivery-tablist" role="tablist" aria-label="Massive data channel">
            <button
              type="button"
              role="tab"
              id="feed-massive-stock-delivery-tab-rest"
              className={`feed-massive-delivery-tab${channelTab === 'rest' ? ' feed-massive-delivery-tab--active' : ''}`}
              aria-selected={channelTab === 'rest'}
              tabIndex={channelTab === 'rest' ? 0 : -1}
              onClick={() => setChannelTab('rest')}
            >
              REST API
            </button>
            <button
              type="button"
              role="tab"
              id="feed-massive-stock-delivery-tab-ws"
              className={`feed-massive-delivery-tab${channelTab === 'ws' ? ' feed-massive-delivery-tab--active' : ''}`}
              aria-selected={channelTab === 'ws'}
              tabIndex={channelTab === 'ws' ? 0 : -1}
              onClick={() => setChannelTab('ws')}
            >
              WebSocket
            </button>
            <button
              type="button"
              role="tab"
              id="feed-massive-stock-delivery-tab-flat"
              className={`feed-massive-delivery-tab${channelTab === 'flat' ? ' feed-massive-delivery-tab--active' : ''}`}
              aria-selected={channelTab === 'flat'}
              tabIndex={channelTab === 'flat' ? 0 : -1}
              onClick={() => setChannelTab('flat')}
            >
              Flat Files
            </button>
          </div>

          {channelTab === 'rest' ? (
            <div
              className="feed-massive-delivery-panel"
              role="tabpanel"
              id="feed-massive-stock-group-rest"
              aria-labelledby="feed-massive-stock-delivery-tab-rest"
            >
              <div className="feed-massive-delivery-tablist" role="tablist" aria-label="REST API sections">
                {REST_SECTION_ORDER.map(id => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    id={`feed-massive-stock-rest-subtab-${id}`}
                    className={`feed-massive-delivery-tab${deliveryRestSubTab === id ? ' feed-massive-delivery-tab--active' : ''}`}
                    aria-selected={deliveryRestSubTab === id}
                    tabIndex={deliveryRestSubTab === id ? 0 : -1}
                    onClick={() => setDeliveryRestSubTab(id)}
                  >
                    {REST_SECTION_LABELS[id]}
                  </button>
                ))}
              </div>
              {REST_SECTION_ORDER.map(id => {
                if (deliveryRestSubTab !== id) return null
                return (
                  <div key={id}>
                    {id === 'stock-tickers'
                      ? renderTickersCap()
                      : id === 'stock-aggregates'
                        ? renderStockAggregatesCap()
                        : id === 'stock-fundamentals'
                          ? renderFundamentalsCap()
                          : id === 'stock-filings'
                            ? renderFilingsCap()
                            : id === 'stock-news'
                              ? renderNewsCap()
                            : renderCap(id)}
                  </div>
                )
              })}
            </div>
          ) : null}

          {channelTab === 'ws' ? (
            <div
              className="feed-massive-delivery-panel"
              role="tabpanel"
              id="feed-massive-stock-group-ws"
              aria-labelledby="feed-massive-stock-delivery-tab-ws"
            >
              <div className="feed-massive-delivery-tablist" role="tablist" aria-label="WebSocket sections">
                {stockWsRows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    role="tab"
                    id={`feed-massive-stock-ws-subtab-${row.id}`}
                    className={`feed-massive-delivery-tab${deliveryWsSubTab === row.id ? ' feed-massive-delivery-tab--active' : ''}`}
                    aria-selected={deliveryWsSubTab === row.id}
                    tabIndex={deliveryWsSubTab === row.id ? 0 : -1}
                    onClick={() => setDeliveryWsSubTab(row.id)}
                  >
                    {row.service}
                  </button>
                ))}
              </div>
              {stockWsPanelRow ? renderCap(stockWsPanelRow.id) : null}
            </div>
          ) : null}

          {channelTab === 'flat' ? (
            <div
              className="feed-massive-delivery-panel"
              role="tabpanel"
              id="feed-massive-stock-group-flat"
              aria-labelledby="feed-massive-stock-delivery-tab-flat"
            >
              <div className="feed-massive-delivery-tablist" role="tablist" aria-label="Flat Files sections">
                {stockFlatRows.map(row => (
                  <button
                    key={row.id}
                    type="button"
                    role="tab"
                    id={`feed-massive-stock-flat-subtab-${row.id}`}
                    className={`feed-massive-delivery-tab${deliveryFlatSubTab === row.id ? ' feed-massive-delivery-tab--active' : ''}`}
                    aria-selected={deliveryFlatSubTab === row.id}
                    tabIndex={deliveryFlatSubTab === row.id ? 0 : -1}
                    onClick={() => setDeliveryFlatSubTab(row.id)}
                  >
                    {row.service}
                  </button>
                ))}
              </div>
              {stockFlatPanelRow ? renderCap(stockFlatPanelRow.id) : null}
            </div>
          ) : null}
        </div>

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
    </PageSection>
  )
}
