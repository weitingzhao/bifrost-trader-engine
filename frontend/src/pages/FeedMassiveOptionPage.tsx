import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { StatusResponse } from '../types'
import {
  fetchMassiveStatus,
  postMassiveSync,
  postMassiveApiCoverageSync,
  fetchMassiveJobsList,
  subscribeMassiveJobEvents,
  fetchCorporateActions,
  fetchOptionExpirations,
  fetchResearchOptionOi,
  fetchContractsCoverage,
  fetchMassiveLastTrade,
  fetchMassiveHistQuotes,
  fetchMassiveHistTrades,
} from '../api'
import type {
  MassiveStatusResponse,
  MassiveJobApiRow,
  CorporateActionRow,
  MassiveOptionExpirationsDebug,
  ContractsCoverageResponse,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import type { ChecklistRow } from './massiveFeedChecklistRows'
import { CAPABILITY_GROUP_LABELS, CAPABILITY_GROUP_ORDER, type CapabilityGroup } from './massiveFeedChecklistRows'
import { feedMassiveSvcAnchorId } from './massive/feedMassiveAnchors'
import {
  capabilityGroupForRowId,
  checklistEffectiveStatusLabel,
  effectiveChecklistProjectStatus,
  groupedOptionFeedChecklistRows,
  optionFeedChecklistRows,
  shortServiceLabel,
  tierOkForRow,
  tradesOkForRow,
} from './massive/massiveChecklistStatus'
import { FeedMassiveServiceBlock } from './massive/FeedMassiveServiceBlock'
import type { EffectiveServiceStatus } from './massive/FeedMassiveServiceBlock'
import { parseFeedMassiveSvcFromHash, parseFeedMassiveTabFromHash } from './massive/feedMassiveTabUtils'

const WS_VERIFY_CMD = 'python scripts/verify_massive_options_ws.py --config config/config.dev.yaml'

const MASSIVE_OPTION_COVERAGE_PLAN_URL = `${import.meta.env.BASE_URL}plans/massive_api_coverage.html`

const checklistRows = optionFeedChecklistRows()

/** Second-level tabs inside REST API on Massive Option. */
const OPTION_REST_SECTION_ORDER = ['contracts', 'aggregates', 'snapshot', 'trades-quotes'] as const
const OPTION_REST_SECTION_LABELS: Record<(typeof OPTION_REST_SECTION_ORDER)[number], string> = {
  contracts: 'Contracts',
  aggregates: 'Aggregate Bars (OHLC)',
  snapshot: 'Snapshots',
  'trades-quotes': 'Trade & Quotes',
}
/** Second-level tabs inside WebSocket on Massive Option. */
const OPTION_WS_SECTION_ORDER = [
  'ws-aggregates-s',
  'ws-aggregates-m',
  'ws-quotes',
  'ws-trades',
  'fmv',
  'websocket',
] as const
const OPTION_WS_SECTION_LABELS: Record<(typeof OPTION_WS_SECTION_ORDER)[number], string> = {
  'ws-aggregates-s': 'Aggregates (Per Second)',
  'ws-aggregates-m': 'Aggregates (Per Minute)',
  'ws-quotes': 'Quotes',
  'ws-trades': 'Trades',
  fmv: 'Fair Market Value',
  websocket: 'Connectivity Verification',
}
const OPTION_FLAT_IDS = checklistRows.filter(r => r.group === 'flat').map(r => r.id)
const OPTION_REST_ID_SET = new Set<string>(OPTION_REST_SECTION_ORDER)
const OPTION_WS_ID_SET = new Set<string>(OPTION_WS_SECTION_ORDER)
const OPTION_FLAT_ID_SET = new Set<string>(OPTION_FLAT_IDS)

function checklistRowById(id: string): ChecklistRow {
  const r = checklistRows.find(x => x.id === id)
  if (!r) throw new Error(`checklist row ${id}`)
  return r
}

function latestJobForKind(jobs: MassiveJobApiRow[], kind: string): MassiveJobApiRow | undefined {
  const k = kind.toLowerCase()
  return jobs.find(j => (j.kind || '').toLowerCase() === k)
}

function jobEvidenceLine(j: MassiveJobApiRow | undefined): string {
  if (!j) return 'No recent job of this kind in the list (refresh Job queue).'
  return `Last job #${j.job_id}: ${j.status ?? '—'} — ${fmtJobResult(j)}`
}

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
  const mode = r.mode as string | undefined
  if (mode === 'open_close' || mode === 'prev') {
    const s = r.summary as Record<string, unknown> | undefined
    if (s) {
      const parts: string[] = []
      if (s.open != null) parts.push(`O ${s.open}`)
      if (s.close != null) parts.push(`C ${s.close}`)
      if (s.high != null) parts.push(`H ${s.high}`)
      if (s.low != null) parts.push(`L ${s.low}`)
      if (s.volume != null) parts.push(`V ${s.volume}`)
      return parts.length ? `${mode}: ${parts.join(' / ')}` : mode
    }
    return mode
  }
  if (r.rows_written != null) {
    const s = r.summary as Record<string, unknown> | undefined
    const ivInfo = s?.rows_with_iv != null ? `, IV ${s.rows_with_iv}/${s.results_count ?? r.rows_written}` : ''
    const gkInfo = s?.rows_with_full_greeks != null ? `, full greeks ${s.rows_with_full_greeks}` : ''
    return `rows ${String(r.rows_written)}${ivInfo}${gkInfo}`
  }
  if (r.rows_upserted != null) return `upserted ${String(r.rows_upserted)}`
  if (r.bars_upserted != null) return `bars ${String(r.bars_upserted)}`
  if (r.message != null) return String(r.message)
  return '—'
}

function feedMassiveOverviewDotClass(eff: EffectiveServiceStatus): string {
  if (eff === 'implemented') return 'feed-massive-tab-dot feed-massive-tab-dot--ok'
  if (eff === 'partial') return 'feed-massive-tab-dot feed-massive-tab-dot--partial'
  if (eff === 'not-on-tier') return 'feed-massive-tab-dot feed-massive-tab-dot--tier'
  return 'feed-massive-tab-dot feed-massive-tab-dot--fail'
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

function CardIconCorpAction() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="2" y="7" width="20" height="14" rx="2" ry="2" />
      <path d="M16 7V5a4 4 0 0 0-8 0v2" />
    </svg>
  )
}

function CardIconTrades() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M16 3h5v5" />
      <path d="M8 21H3v-5" />
      <path d="M21 3 14 10" />
      <path d="M3 21l7-7" />
    </svg>
  )
}

function CardIconFmv() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 3h12l4 6-10 12L2 9l4-6z" />
      <path d="M2 9h20" />
      <path d="M10 3l-4 6 6 12 6-12-4-6" />
    </svg>
  )
}

interface FeedMassiveCapabilityPanelProps {
  capId: string
  checklistRow: ChecklistRow
  effectiveStatus: EffectiveServiceStatus
  expanded: boolean
  onToggle: () => void
  highlight: boolean
  ariaLabel: string
  children: ReactNode
}

function FeedMassiveCapabilityPanel({
  capId,
  checklistRow,
  effectiveStatus,
  expanded,
  onToggle,
  highlight,
  ariaLabel,
  children,
}: FeedMassiveCapabilityPanelProps) {
  const statusWords = checklistEffectiveStatusLabel(effectiveStatus)
  return (
    <section
      id={feedMassiveSvcAnchorId(capId)}
      className={`feed-massive-card feed-massive-cap-section${expanded ? ' feed-massive-cap-section--expanded' : ' feed-massive-cap-section--collapsed'}${highlight ? ' feed-massive-card--cap-active' : ''}`}
      aria-label={ariaLabel}
    >
      <div className="feed-massive-cap-panel-header">
        <button
          type="button"
          className="feed-massive-cap-panel-toggle"
          aria-expanded={expanded}
          aria-controls={`feed-massive-cap-body-${capId}`}
          id={`feed-massive-cap-head-${capId}`}
          onClick={onToggle}
        >
          <span
            className={`feed-massive-cap-panel-chevron${expanded ? ' feed-massive-cap-panel-chevron--open' : ''}`}
            aria-hidden
          />
          <span className="feed-massive-cap-panel-title">{shortServiceLabel(checklistRow)}</span>
          <span
            className={feedMassiveOverviewDotClass(effectiveStatus)}
            title={statusWords}
            aria-label={`Status: ${statusWords}`}
          />
        </button>
      </div>
      {expanded ? (
        <div
          id={`feed-massive-cap-body-${capId}`}
          className="feed-massive-cap-panel-body"
          role="region"
          aria-labelledby={`feed-massive-cap-head-${capId}`}
        >
          {children}
        </div>
      ) : null}
    </section>
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
  const [_jobsLoading, setJobsLoading] = useState(false)
  const [_jobsError, setJobsError] = useState<string | null>(null)
  /** Which capability section is focused after chip click or hash deep-link (border highlight). */
  const [highlightedCapabilityId, setHighlightedCapabilityId] = useState<string | null>(null)
  /** Collapsible capability groups in sticky nav (REST / WebSocket / Flat Files / Project). */
  const [capNavGroupExpanded, setCapNavGroupExpanded] = useState<Record<CapabilityGroup, boolean>>(() =>
    CAPABILITY_GROUP_ORDER.reduce(
      (acc, g) => {
        acc[g] = true
        return acc
      },
      {} as Record<CapabilityGroup, boolean>,
    ),
  )
  /** Per-capability body expanded; default collapsed. */
  const [capExpanded, setCapExpanded] = useState<Record<string, boolean>>({})
  /** Top-level delivery channel: REST / WebSocket / Flat Files (Project stays below). */
  const [channelTab, setChannelTab] = useState<'rest' | 'ws' | 'flat'>('rest')
  /** Second-level section within each channel (tabs). */
  const [deliveryRestSubTab, setDeliveryRestSubTab] = useState<(typeof OPTION_REST_SECTION_ORDER)[number]>('contracts')
  const [deliveryWsSubTab, setDeliveryWsSubTab] = useState<(typeof OPTION_WS_SECTION_ORDER)[number]>('ws-aggregates-s')
  const [deliveryFlatSubTab, setDeliveryFlatSubTab] = useState<string>(OPTION_FLAT_IDS[0] ?? 'flat-file-day-aggs')

  const [snapType, setSnapType] = useState<'chain' | 'contract' | 'unified'>('contract')
  const [snapSymbol, setSnapSymbol] = useState('NVDA')
  const [snapBusy, setSnapBusy] = useState(false)
  const [snapErr, setSnapErr] = useState<string | null>(null)
  const [snapResult, setSnapResult] = useState<{ summary: Record<string, unknown>; content: unknown; content_truncated?: boolean } | null>(null)

  // Chain optional filters
  const [chainExpDate, setChainExpDate] = useState('')
  const [chainExpDateGte, setChainExpDateGte] = useState('')
  const [chainExpDateLte, setChainExpDateLte] = useState('')
  const [chainStrike, setChainStrike] = useState('')
  const [chainStrikeGte, setChainStrikeGte] = useState('')
  const [chainStrikeLte, setChainStrikeLte] = useState('')
  const [chainContractType, setChainContractType] = useState<'' | 'call' | 'put'>('')
  const [chainLimit, setChainLimit] = useState('250')
  const [chainSort, setChainSort] = useState('')
  const [chainOrder, setChainOrder] = useState<'' | 'asc' | 'desc'>('')

  // Contract snapshot params
  const [contractUnderlying, setContractUnderlying] = useState('AAPL')
  const [contractTicker, setContractTicker] = useState('')

  // Unified snapshot params
  const [unifiedTickers, setUnifiedTickers] = useState('')
  const [unifiedAssetType, setUnifiedAssetType] = useState<'' | 'stocks' | 'options' | 'fx' | 'crypto' | 'indices'>('')
  const [unifiedLimit, setUnifiedLimit] = useState('10')

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

  // Open/Close aggregates
  const [ocTicker, setOcTicker] = useState('')
  const [ocDate, setOcDate] = useState('')
  const [ocBusy, setOcBusy] = useState(false)
  const [ocErr, setOcErr] = useState<string | null>(null)

  // Previous day aggregates
  const [prevTicker, setPrevTicker] = useState('')
  const [prevBusy, setPrevBusy] = useState(false)
  const [prevErr, setPrevErr] = useState<string | null>(null)

  // WS copy feedback
  const [wsCopied, setWsCopied] = useState<string | null>(null)

  /** Embedded official API vs project coverage sheet (static HTML from public/plans). */
  const [apiCoverageOpen, setApiCoverageOpen] = useState(false)
  const [apiCoverageSyncBusy, setApiCoverageSyncBusy] = useState(false)
  const [apiCoverageSyncMsg, setApiCoverageSyncMsg] = useState<string | null>(null)

  /** Which Aggregate Bars (OHLC) REST sub-tab is active (Massive DocPage names in UI). */
  const [aggSubTab, setAggSubTab] = useState<
    'custom_bars' | 'open_close' | 'prev'
  >('custom_bars')

  // Greeks/IV state removed — migrated to OptionCoveragePage

  const [ctSubTab, setCtSubTab] = useState<
    'contracts_list' | 'contract_detail' | 'db_verify' | 'snapshot_link'
  >('contracts_list')
  const [ctListSymbol, setCtListSymbol] = useState('NVDA')
  const [ctListExpDate, setCtListExpDate] = useState('')
  const [ctListContractType, setCtListContractType] = useState<'' | 'call' | 'put'>('')
  const [ctListLimit, setCtListLimit] = useState('100')
  const [ctListBusy, setCtListBusy] = useState(false)
  const [ctListErr, setCtListErr] = useState<string | null>(null)
  const [ctDetailTicker, setCtDetailTicker] = useState('')
  const [ctDetailBusy, setCtDetailBusy] = useState(false)
  const [ctDetailErr, setCtDetailErr] = useState<string | null>(null)
  const [ctDetailResult, setCtDetailResult] = useState<Record<string, unknown> | null>(null)
  const [ctSnapTicker, setCtSnapTicker] = useState('')
  const [ctSnapUnderlying, setCtSnapUnderlying] = useState('AAPL')
  const [ctSnapBusy, setCtSnapBusy] = useState(false)
  const [ctSnapErr, setCtSnapErr] = useState<string | null>(null)
  const [ctSnapResult, setCtSnapResult] = useState<Record<string, unknown> | null>(null)
  const [ctCoverage, setCtCoverage] = useState<ContractsCoverageResponse | null>(null)
  const [ctCoverageBusy, setCtCoverageBusy] = useState(false)

  const [fmvSubTab, setFmvSubTab] = useState<'ws-fmv' | 'tier-delivery'>('ws-fmv')
  const [fmvTicker, setFmvTicker] = useState('O:SPY251219C00600000')

  const [oiBusy, setOiBusy] = useState(false)
  const [oiErr, setOiErr] = useState<string | null>(null)

  const [corpSymbol, setCorpSymbol] = useState('AAPL')
  const [corpBusy, setCorpBusy] = useState(false)
  const [corpErr, setCorpErr] = useState<string | null>(null)
  const [corpRows, setCorpRows] = useState<CorporateActionRow[]>([])
  const [corpDbLoading, setCorpDbLoading] = useState(false)

  // Greeks/IV DB verify state removed — migrated to OptionCoveragePage

  const [refSymbol, setRefSymbol] = useState('NVDA')
  const [refTestBusy, setRefTestBusy] = useState(false)
  const [refTestMsg, setRefTestMsg] = useState<string | null>(null)
  /** Full lists from last successful GET /research/option-expirations (same as Evidence counts). */
  const [refTestExpirations, setRefTestExpirations] = useState<string[]>([])
  const [refTestStrikes, setRefTestStrikes] = useState<number[]>([])
  const [refTestDebug, setRefTestDebug] = useState<MassiveOptionExpirationsDebug | null>(null)


  /** Which Trades & Quotes sub-tab is active. */
  const [tqSubTab, setTqSubTab] = useState<
    'last_trade' | 'hist_quotes' | 'hist_trades' | 'flat_quotes' | 'flat_trades'
  >('hist_trades')
  const [tqLastTradeTicker, setTqLastTradeTicker] = useState('')
  const [tqLastTradeBusy, setTqLastTradeBusy] = useState(false)
  const [tqLastTradeErr, setTqLastTradeErr] = useState<string | null>(null)
  const [tqLastTradeResult, setTqLastTradeResult] = useState<Record<string, unknown> | null>(null)

  const [tqHistQuotesTicker, setTqHistQuotesTicker] = useState('')
  const [tqHistQuotesFrom, setTqHistQuotesFrom] = useState('')
  const [tqHistQuotesTo, setTqHistQuotesTo] = useState('')
  const [tqHistQuotesLimit, setTqHistQuotesLimit] = useState('100')
  const [tqHistQuotesSort, setTqHistQuotesSort] = useState<'asc' | 'desc'>('asc')
  const [tqHistQuotesBusy, setTqHistQuotesBusy] = useState(false)
  const [tqHistQuotesErr, setTqHistQuotesErr] = useState<string | null>(null)
  const [tqHistQuotesResult, setTqHistQuotesResult] = useState<Record<string, unknown> | null>(null)

  const [tqHistTradesTicker, setTqHistTradesTicker] = useState('')
  const [tqHistTradesFrom, setTqHistTradesFrom] = useState('')
  const [tqHistTradesTo, setTqHistTradesTo] = useState('')
  const [tqHistTradesLimit, setTqHistTradesLimit] = useState('100')
  const [tqHistTradesSort, setTqHistTradesSort] = useState<'asc' | 'desc'>('asc')
  const [tqHistTradesBusy, setTqHistTradesBusy] = useState(false)
  const [tqHistTradesErr, setTqHistTradesErr] = useState<string | null>(null)
  const [tqHistTradesResult, setTqHistTradesResult] = useState<Record<string, unknown> | null>(null)

  const [oiFetchSym, setOiFetchSym] = useState('NVDA')
  const [oiFetchBusy, setOiFetchBusy] = useState(false)
  const [oiFetchMsg, setOiFetchMsg] = useState<string | null>(null)

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

  const toggleCap = useCallback((id: string) => {
    setCapExpanded(prev => ({ ...prev, [id]: !prev[id] }))
  }, [])

  const scrollToSection = useCallback((id: string) => {
    setHighlightedCapabilityId(id)
    setCapExpanded(prev => ({ ...prev, [id]: true }))
    const g = capabilityGroupForRowId(id)
    if (g === 'rest' || g === 'ws' || g === 'flat') {
      setChannelTab(g)
    }
    if (OPTION_REST_ID_SET.has(id)) {
      setDeliveryRestSubTab(id as (typeof OPTION_REST_SECTION_ORDER)[number])
    }
    if (OPTION_WS_ID_SET.has(id)) {
      setDeliveryWsSubTab(id as (typeof OPTION_WS_SECTION_ORDER)[number])
    }
    if (OPTION_FLAT_ID_SET.has(id)) {
      setDeliveryFlatSubTab(id)
    }
    if (g) {
      setCapNavGroupExpanded(prev => (prev[g] ? prev : { ...prev, [g]: true }))
    }
    const el = document.getElementById(feedMassiveSvcAnchorId(id))
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      const next = `${window.location.pathname}${window.location.search}#${feedMassiveSvcAnchorId(id)}`
      window.history.replaceState(null, '', next)
    }
  }, [])

  useEffect(() => {
    const resolveIdFromHash = (hash: string): string | null => {
      const fromTab = parseFeedMassiveTabFromHash(hash)
      if (fromTab && checklistRows.some(r => r.id === fromTab)) return fromTab
      const fromSvc = parseFeedMassiveSvcFromHash(hash)
      if (fromSvc && checklistRows.some(r => r.id === fromSvc)) return fromSvc
      return null
    }
    const onHashChange = () => {
      const id = resolveIdFromHash(window.location.hash)
      if (id) scrollToSection(id)
      else setHighlightedCapabilityId(null)
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [scrollToSection])

  useEffect(() => {
    const id =
      parseFeedMassiveTabFromHash(window.location.hash) ??
      parseFeedMassiveSvcFromHash(window.location.hash)
    if (id && checklistRows.some(r => r.id === id)) {
      requestAnimationFrame(() => scrollToSection(id))
    }
  }, [scrollToSection])

  const runRefExpirationsTest = useCallback(async () => {
    const sym = refSymbol.trim().toUpperCase()
    if (!sym) {
      setRefTestMsg('Symbol required')
      return
    }
    setRefTestBusy(true)
    setRefTestMsg(null)
    setRefTestExpirations([])
    setRefTestStrikes([])
    setRefTestDebug(null)
    try {
      const r = await fetchOptionExpirations(sym, 'massive', { debug: true })
      if (r.massive_debug) setRefTestDebug(r.massive_debug)
      if (r.error) setRefTestMsg(r.error)
      else {
        setRefTestExpirations(r.expirations)
        setRefTestStrikes(Array.isArray(r.strikes) ? r.strikes : [])
        setRefTestMsg(
          `OK: ${r.expirations.length} expirations${r.strikes?.length ? `, ${r.strikes.length} strikes` : ''}.`,
        )
      }
    } catch (err) {
      setRefTestMsg(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setRefTestBusy(false)
    }
  }, [refSymbol])

  // runGreeksSample removed — migrated to OptionCoveragePage

  // Greeks/IV callbacks removed — migrated to OptionCoveragePage

  const loadCtCoverage = useCallback(async (sym?: string) => {
    const s = (sym || ctListSymbol || '').trim().toUpperCase()
    if (!s) return
    setCtCoverageBusy(true)
    try {
      const r = await fetchContractsCoverage(s)
      setCtCoverage(r)
    } catch { /* ignore */ } finally { setCtCoverageBusy(false) }
  }, [ctListSymbol])

  const runCtContractsList = useCallback(async () => {
    const s = ctListSymbol.trim().toUpperCase()
    if (!s) { setCtListErr('Underlying symbol required'); return }
    setCtListErr(null)
    setCtListBusy(true)
    try {
      const payload: Record<string, unknown> = { underlying: s }
      if (ctListExpDate.trim()) payload.expiration_date = ctListExpDate.trim()
      if (ctListContractType) payload.contract_type = ctListContractType
      const lim = parseInt(ctListLimit, 10)
      if (lim > 0) payload.limit = lim
      const res = await postMassiveSync('contracts', payload)
      if (!res.ok) { setCtListErr(res.error ?? res.message ?? 'Enqueue failed'); setCtListBusy(false); return }
      if (!res.job_id) { setCtListErr('No job_id'); setCtListBusy(false); return }
      const sub = subscribeMassiveJobEvents(
        res.job_id,
        ev => {
          if (!ev.ok) { setCtListErr(ev.error || 'SSE error'); setCtListBusy(false); sub.close(); return }
          const st = ev.job?.status
          if (st === 'done' || st === 'failed') {
            const jr = ev.job?.result as Record<string, unknown> | undefined
            if (st === 'failed') setCtListErr((jr?.error as string) || 'Job failed')
            setCtListBusy(false)
            sub.close()
            loadJobs()
            loadCtCoverage(s)
          }
        },
        { timeoutSec: 240 },
      )
    } catch (e) {
      setCtListErr(e instanceof Error ? e.message : 'Failed')
      setCtListBusy(false)
    }
  }, [ctListSymbol, ctListExpDate, ctListContractType, ctListLimit, loadJobs, loadCtCoverage])

  const runCtContractDetail = useCallback(async () => {
    const t = ctDetailTicker.trim()
    if (!t) { setCtDetailErr('Options ticker required'); return }
    setCtDetailErr(null)
    setCtDetailResult(null)
    setCtDetailBusy(true)
    try {
      const res = await postMassiveSync('contracts', { mode: 'detail', options_ticker: t })
      if (!res.ok) { setCtDetailErr(res.error ?? res.message ?? 'Enqueue failed'); setCtDetailBusy(false); return }
      if (!res.job_id) { setCtDetailErr('No job_id'); setCtDetailBusy(false); return }
      const sub = subscribeMassiveJobEvents(
        res.job_id,
        ev => {
          if (!ev.ok) { setCtDetailErr(ev.error || 'SSE error'); setCtDetailBusy(false); sub.close(); return }
          const st = ev.job?.status
          if (st === 'done' || st === 'failed') {
            const jr = ev.job?.result as Record<string, unknown> | undefined
            if (st === 'done' && jr?.content) setCtDetailResult(jr.content as Record<string, unknown>)
            else if (st === 'failed') setCtDetailErr((jr?.error as string) || 'Job failed')
            setCtDetailBusy(false)
            sub.close()
            loadJobs()
          }
        },
        { timeoutSec: 240 },
      )
    } catch (e) {
      setCtDetailErr(e instanceof Error ? e.message : 'Failed')
      setCtDetailBusy(false)
    }
  }, [ctDetailTicker, loadJobs])

  const runCtSnapshotLink = useCallback(async () => {
    const u = ctSnapUnderlying.trim().toUpperCase()
    const t = ctSnapTicker.trim()
    if (!u || !t) { setCtSnapErr('Both underlying and option ticker required'); return }
    setCtSnapErr(null)
    setCtSnapResult(null)
    setCtSnapBusy(true)
    try {
      const res = await postMassiveSync('snapshot', { snapshot_type: 'contract', underlying: u, option_contract: t })
      if (!res.ok) { setCtSnapErr(res.error ?? res.message ?? 'Enqueue failed'); setCtSnapBusy(false); return }
      if (!res.job_id) { setCtSnapErr('No job_id'); setCtSnapBusy(false); return }
      const sub = subscribeMassiveJobEvents(
        res.job_id,
        ev => {
          if (!ev.ok) { setCtSnapErr(ev.error || 'SSE error'); setCtSnapBusy(false); sub.close(); return }
          const st = ev.job?.status
          if (st === 'done' || st === 'failed') {
            const jr = ev.job?.result as Record<string, unknown> | undefined
            if (st === 'done') setCtSnapResult(jr ?? null)
            else setCtSnapErr((jr?.error as string) || 'Job failed')
            setCtSnapBusy(false)
            sub.close()
            loadJobs()
          }
        },
        { timeoutSec: 240 },
      )
    } catch (e) {
      setCtSnapErr(e instanceof Error ? e.message : 'Failed')
      setCtSnapBusy(false)
    }
  }, [ctSnapUnderlying, ctSnapTicker, loadJobs])

  const runTqLastTrade = useCallback(async () => {
    const t = tqLastTradeTicker.trim()
    if (!t) { setTqLastTradeErr('Options ticker required'); return }
    setTqLastTradeErr(null)
    setTqLastTradeResult(null)
    setTqLastTradeBusy(true)
    try {
      const r = await fetchMassiveLastTrade(t)
      if (r.error) { setTqLastTradeErr(r.error); return }
      setTqLastTradeResult(r)
    } catch (e) {
      setTqLastTradeErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setTqLastTradeBusy(false)
    }
  }, [tqLastTradeTicker])

  const runTqHistQuotes = useCallback(async () => {
    const t = tqHistQuotesTicker.trim()
    if (!t) { setTqHistQuotesErr('Options ticker required'); return }
    setTqHistQuotesErr(null)
    setTqHistQuotesResult(null)
    setTqHistQuotesBusy(true)
    try {
      const r = await fetchMassiveHistQuotes(t, {
        timestamp_gte: tqHistQuotesFrom.trim() || undefined,
        timestamp_lte: tqHistQuotesTo.trim() || undefined,
        limit: parseInt(tqHistQuotesLimit, 10) || 100,
        sort: tqHistQuotesSort,
      })
      if (r.error) { setTqHistQuotesErr(r.error); return }
      setTqHistQuotesResult(r)
    } catch (e) {
      setTqHistQuotesErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setTqHistQuotesBusy(false)
    }
  }, [tqHistQuotesTicker, tqHistQuotesFrom, tqHistQuotesTo, tqHistQuotesLimit, tqHistQuotesSort])

  const runTqHistTrades = useCallback(async () => {
    const t = tqHistTradesTicker.trim()
    if (!t) { setTqHistTradesErr('Options ticker required'); return }
    setTqHistTradesErr(null)
    setTqHistTradesResult(null)
    setTqHistTradesBusy(true)
    try {
      const r = await fetchMassiveHistTrades(t, {
        timestamp_gte: tqHistTradesFrom.trim() || undefined,
        timestamp_lte: tqHistTradesTo.trim() || undefined,
        limit: parseInt(tqHistTradesLimit, 10) || 100,
        sort: tqHistTradesSort,
      })
      if (r.error) { setTqHistTradesErr(r.error); return }
      setTqHistTradesResult(r)
    } catch (e) {
      setTqHistTradesErr(e instanceof Error ? e.message : 'Failed')
    } finally {
      setTqHistTradesBusy(false)
    }
  }, [tqHistTradesTicker, tqHistTradesFrom, tqHistTradesTo, tqHistTradesLimit, tqHistTradesSort])

  const runOiApiFetch = useCallback(async () => {
    const s = oiFetchSym.trim().toUpperCase()
    if (!s) {
      setOiFetchMsg('Symbol required')
      return
    }
    setOiFetchBusy(true)
    setOiFetchMsg(null)
    try {
      const r = await fetchResearchOptionOi(s, { limit: 5 })
      if (r.error) setOiFetchMsg(r.error)
      else setOiFetchMsg(`OK: ${r.rows.length} row(s) from GET /research/option-oi.`)
    } catch (err) {
      setOiFetchMsg(err instanceof Error ? err.message : 'Failed')
    } finally {
      setOiFetchBusy(false)
    }
  }, [oiFetchSym])

  const copyWsCommand = useCallback((channel?: string) => {
    const cmd = channel
      ? `python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --channel "${channel}"`
      : WS_VERIFY_CMD
    navigator.clipboard.writeText(cmd).then(
      () => { setWsCopied(channel ?? '_default'); setTimeout(() => setWsCopied(null), 2000) },
      () => { /* ignore */ },
    )
  }, [])

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
    let payload: Record<string, unknown> = {}
    if (snapType === 'chain') {
      const u = snapSymbol.trim().toUpperCase()
      if (!u) { setSnapErr('Underlying symbol required'); return }
      payload = { snapshot_type: 'chain', underlying: u }
      if (chainExpDate.trim()) payload.expiration_date = chainExpDate.trim()
      if (chainExpDateGte.trim()) payload.expiration_date_gte = chainExpDateGte.trim()
      if (chainExpDateLte.trim()) payload.expiration_date_lte = chainExpDateLte.trim()
      if (chainStrike.trim()) payload.strike_price = parseFloat(chainStrike)
      if (chainStrikeGte.trim()) payload.strike_price_gte = parseFloat(chainStrikeGte)
      if (chainStrikeLte.trim()) payload.strike_price_lte = parseFloat(chainStrikeLte)
      if (chainContractType) payload.contract_type = chainContractType
      if (chainLimit.trim()) payload.limit = parseInt(chainLimit, 10)
      if (chainSort.trim()) payload.sort = chainSort.trim()
      if (chainOrder) payload.order = chainOrder
    } else if (snapType === 'contract') {
      const u = contractUnderlying.trim().toUpperCase()
      const oc = contractTicker.trim()
      if (!u || !oc) { setSnapErr('Underlying and option contract ticker required'); return }
      payload = { snapshot_type: 'contract', underlying: u, option_contract: oc }
    } else {
      const t = unifiedTickers.trim()
      if (!t) { setSnapErr('At least one ticker required'); return }
      payload = { snapshot_type: 'unified', tickers: t }
      if (unifiedAssetType) payload.asset_type = unifiedAssetType
      if (unifiedLimit.trim()) payload.limit = parseInt(unifiedLimit, 10)
    }
    setSnapErr(null)
    setSnapResult(null)
    setSnapBusy(true)
    try {
      const res = await postMassiveSync('snapshot', payload)
      if (!res.ok) {
        setSnapErr(res.error ?? res.message ?? 'Enqueue failed')
        setSnapBusy(false)
        return
      }
      if (!res.job_id) { setSnapErr('No job_id'); setSnapBusy(false); return }
      const sub = subscribeMassiveJobEvents(
        res.job_id,
        ev => {
          if (!ev.ok) { setSnapErr(ev.error || 'SSE error'); setSnapBusy(false); sub.close(); return }
          const st = ev.job?.status
          if (st === 'done' || st === 'failed') {
            const jr = ev.job?.result as Record<string, unknown> | undefined
            if (st === 'done' && jr?.summary) {
              setSnapResult({
                summary: jr.summary as Record<string, unknown>,
                content: jr.content,
                content_truncated: Boolean(jr.content_truncated),
              })
            } else if (st === 'failed') {
              setSnapErr((jr?.error as string) || 'Job failed')
            }
            setSnapBusy(false)
            sub.close()
            loadJobs()
          }
        },
        { timeoutSec: 240 },
      )
    } catch (e) {
      setSnapErr(e instanceof Error ? e.message : 'Failed')
      setSnapBusy(false)
    }
  }, [snapType, snapSymbol, chainExpDate, chainExpDateGte, chainExpDateLte, chainStrike, chainStrikeGte, chainStrikeLte, chainContractType, chainLimit, chainSort, chainOrder, contractUnderlying, contractTicker, unifiedTickers, unifiedAssetType, unifiedLimit, loadJobs])

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

  const runOpenClose = useCallback(async () => {
    setOcErr(null)
    setOcBusy(true)
    try {
      const payload: Record<string, unknown> = {
        options_ticker: ocTicker.trim(),
        date: ocDate.trim(),
        mode: 'open_close',
      }
      const res = await postMassiveSync('aggregates', payload)
      if (!res.ok) {
        setOcErr(res.error ?? res.message ?? 'Enqueue failed')
        setOcBusy(false)
        return
      }
      if (!res.job_id) {
        setOcErr('No job_id')
        setOcBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setOcBusy(false)
        loadJobs()
      })
    } catch (e) {
      setOcErr(e instanceof Error ? e.message : 'Failed')
      setOcBusy(false)
    }
  }, [ocTicker, ocDate, loadJobs, trackJob])

  const runPrevDay = useCallback(async () => {
    setPrevErr(null)
    setPrevBusy(true)
    try {
      const payload: Record<string, unknown> = {
        options_ticker: prevTicker.trim(),
        mode: 'prev',
      }
      const res = await postMassiveSync('aggregates', payload)
      if (!res.ok) {
        setPrevErr(res.error ?? res.message ?? 'Enqueue failed')
        setPrevBusy(false)
        return
      }
      if (!res.job_id) {
        setPrevErr('No job_id')
        setPrevBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setPrevBusy(false)
        loadJobs()
      })
    } catch (e) {
      setPrevErr(e instanceof Error ? e.message : 'Failed')
      setPrevBusy(false)
    }
  }, [prevTicker, loadJobs, trackJob])

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

  const runCorpAction = useCallback(async () => {
    const sym = corpSymbol.trim().toUpperCase()
    if (!sym) { setCorpErr('Symbol required'); return }
    setCorpErr(null)
    setCorpBusy(true)
    try {
      const res = await postMassiveSync('corporate_action', { symbol: sym })
      if (!res.ok) {
        setCorpErr(res.error ?? res.message ?? 'Enqueue failed')
        setCorpBusy(false)
        return
      }
      if (!res.job_id) {
        setCorpErr('No job_id')
        setCorpBusy(false)
        return
      }
      const sub = trackJob(res.job_id, () => {
        sub.close()
        setCorpBusy(false)
        loadJobs()
      })
    } catch (e) {
      setCorpErr(e instanceof Error ? e.message : 'Failed')
      setCorpBusy(false)
    }
  }, [corpSymbol, loadJobs, trackJob])

  const loadCorpFromDb = useCallback(async () => {
    const sym = corpSymbol.trim().toUpperCase()
    if (!sym) { setCorpErr('Symbol required'); return }
    setCorpDbLoading(true)
    setCorpErr(null)
    try {
      const res = await fetchCorporateActions(sym, { limit: 50 })
      if (!res.ok) { setCorpErr(res.error ?? 'Load failed'); setCorpRows([]); return }
      setCorpRows(res.rows)
    } catch (e) {
      setCorpErr(e instanceof Error ? e.message : 'Load failed')
      setCorpRows([])
    } finally {
      setCorpDbLoading(false)
    }
  }, [corpSymbol])

  // runVerify removed — migrated to OptionCoveragePage

  const configured = massiveStatus?.configured

  const rRef = checklistRowById('reference')
  const effRef = effectiveChecklistProjectStatus(
    rRef,
    Boolean(configured),
    tierOkForRow(rRef, massiveStatus, Boolean(configured)),
    tradesOkForRow(rRef, massiveStatus),
  )
  const rSnap = checklistRowById('snapshot')
  const effSnap = effectiveChecklistProjectStatus(
    rSnap,
    Boolean(configured),
    tierOkForRow(rSnap, massiveStatus, Boolean(configured)),
    tradesOkForRow(rSnap, massiveStatus),
  )
  const rAgg = checklistRowById('aggregates')
  const effAgg = effectiveChecklistProjectStatus(
    rAgg,
    Boolean(configured),
    tierOkForRow(rAgg, massiveStatus, Boolean(configured)),
    tradesOkForRow(rAgg, massiveStatus),
  )
  // rGk/effGk removed — greeks-iv migrated to OptionCoveragePage
  const rOi = checklistRowById('daily-oi')
  const effOi = effectiveChecklistProjectStatus(
    rOi,
    Boolean(configured),
    tierOkForRow(rOi, massiveStatus, Boolean(configured)),
    tradesOkForRow(rOi, massiveStatus),
  )
  const rTr = checklistRowById('trades-quotes')
  const effTr = effectiveChecklistProjectStatus(
    rTr,
    Boolean(configured),
    tierOkForRow(rTr, massiveStatus, Boolean(configured)),
    tradesOkForRow(rTr, massiveStatus),
  )
  const rCorp = checklistRowById('corporate-actions')
  const effCorp = effectiveChecklistProjectStatus(
    rCorp,
    Boolean(configured),
    tierOkForRow(rCorp, massiveStatus, Boolean(configured)),
    tradesOkForRow(rCorp, massiveStatus),
  )
  const rWs = checklistRowById('websocket')
  const effWs = effectiveChecklistProjectStatus(
    rWs,
    Boolean(configured),
    tierOkForRow(rWs, massiveStatus, Boolean(configured)),
    tradesOkForRow(rWs, massiveStatus),
  )
  const rWsAggS = checklistRowById('ws-aggregates-s')
  const effWsAggS = effectiveChecklistProjectStatus(
    rWsAggS,
    Boolean(configured),
    tierOkForRow(rWsAggS, massiveStatus, Boolean(configured)),
    tradesOkForRow(rWsAggS, massiveStatus),
  )
  const rWsAggM = checklistRowById('ws-aggregates-m')
  const effWsAggM = effectiveChecklistProjectStatus(
    rWsAggM,
    Boolean(configured),
    tierOkForRow(rWsAggM, massiveStatus, Boolean(configured)),
    tradesOkForRow(rWsAggM, massiveStatus),
  )
  const rWsQuotes = checklistRowById('ws-quotes')
  const effWsQuotes = effectiveChecklistProjectStatus(
    rWsQuotes,
    Boolean(configured),
    tierOkForRow(rWsQuotes, massiveStatus, Boolean(configured)),
    tradesOkForRow(rWsQuotes, massiveStatus),
  )
  const rWsTrades = checklistRowById('ws-trades')
  const effWsTrades = effectiveChecklistProjectStatus(
    rWsTrades,
    Boolean(configured),
    tierOkForRow(rWsTrades, massiveStatus, Boolean(configured)),
    tradesOkForRow(rWsTrades, massiveStatus),
  )
  const rCt = checklistRowById('contracts')
  const effCt = effectiveChecklistProjectStatus(
    rCt,
    Boolean(configured),
    tierOkForRow(rCt, massiveStatus, Boolean(configured)),
    tradesOkForRow(rCt, massiveStatus),
  )

  // greeksQuality / greeksEvidence removed — migrated to OptionCoveragePage

  const contractsEvidence = (() => {
    const cov = ctCoverage
    if (!cov || !cov.ok || !cov.total) {
      const latest = latestJobForKind(jobs, 'contracts')
      return latest ? jobEvidenceLine(latest) : 'No contracts data loaded. Use All Contracts tab to fetch.'
    }
    const c = cov.coverage
    return `${cov.total} contracts in DB for ${cov.symbol}. Ticker mapped: ${c?.with_massive_ticker ?? 0} (${c?.ticker_pct ?? 0}%). ${c?.distinct_expirations ?? 0} expirations, ${c?.distinct_strikes ?? 0} strikes.`
  })()

  const rFmv = checklistRowById('fmv')
  const effFmv = effectiveChecklistProjectStatus(
    rFmv,
    Boolean(configured),
    tierOkForRow(rFmv, massiveStatus, Boolean(configured)),
    tradesOkForRow(rFmv, massiveStatus),
  )

  const fmvEvidence = (() => {
    if (effFmv === 'not-on-tier') return 'Business tier required. Verify command available for reference.'
    return 'Copy the WS verify command to test FMV.O channel connectivity.'
  })()

  const flatFileRows = checklistRows.filter(r => r.group === 'flat')
  const flatFileEffMap = Object.fromEntries(
    flatFileRows.map(r => [r.id, effectiveChecklistProjectStatus(
      r, Boolean(configured),
      tierOkForRow(r, massiveStatus, Boolean(configured)),
      tradesOkForRow(r, massiveStatus),
    )])
  )
  const flatPanelRow = flatFileRows.find(r => r.id === deliveryFlatSubTab) ?? flatFileRows[0]

  const pendingJobCount = jobs.filter(j => {
    const s = (j.status || '').toLowerCase()
    return s === 'pending' || s === 'running'
  }).length

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

      <section
        className="feed-massive-api-coverage-banner"
        id="feed-massive-api-coverage"
        aria-label="Massive API coverage sheet"
      >
        <div className="feed-massive-api-coverage-banner-row">
          <div className="feed-massive-api-coverage-copy">
            <div className="feed-massive-api-coverage-title">Official API vs project coverage</div>
            <p className="feed-massive-api-coverage-desc">
              Massive / Polygon Options endpoints, use cases, checklist mapping, and pytest status. Same viewer is
              available under MkDocs Research → Massive API coverage.
            </p>
          </div>
          <div className="feed-massive-api-coverage-actions">
            <a
              href={MASSIVE_OPTION_COVERAGE_PLAN_URL}
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
                  const res = await postMassiveApiCoverageSync()
                  if (res.ok) {
                    setApiCoverageSyncMsg('Synced coverage HTML to frontend/public/plans.')
                  } else {
                    setApiCoverageSyncMsg(res.error ?? 'Sync failed')
                  }
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
        {apiCoverageSyncMsg ? (
          <p className="feed-massive-api-coverage-sync-msg">{apiCoverageSyncMsg}</p>
        ) : null}
        {apiCoverageOpen ? (
          <div className="feed-massive-api-coverage-frame-wrap">
            <iframe
              title="Massive API coverage sheet"
              src={`${MASSIVE_OPTION_COVERAGE_PLAN_URL}?embed=1`}
              className="feed-massive-api-coverage-iframe"
            />
          </div>
        ) : null}
      </section>

      <nav className="feed-massive-tab-nav-section feed-massive-cap-nav-sticky" aria-label="Massive capabilities">
        <div className="feed-massive-cap-sheet">
          <div className="feed-massive-queue-summary">
            <span className="feed-massive-queue-summary-label">Queue</span>
            <span className="feed-massive-queue-summary-stat">
              Workers: <strong>{_status?.celery?.workers?.length ?? 0}</strong>
            </span>
            {pendingJobCount > 0 ? (
              <span className="feed-massive-queue-summary-stat">
                Active jobs: <strong>{pendingJobCount > 99 ? '99+' : pendingJobCount}</strong>
              </span>
            ) : null}
            <a href="#settings-celery" className="feed-massive-queue-summary-link">Celery queue details</a>
            {!_status?.celery?.workers?.length ? (
              <span className="feed-massive-queue-summary-warn">No workers — start a worker with -Q massive (or run_celery default including massive_stocks*, massive*)</span>
            ) : null}
          </div>
          <p className="feed-massive-cap-hint">
            Capabilities grouped by delivery channel. Click a group header to show or hide chips; click a chip to jump
            and expand that section.
          </p>
          {groupedOptionFeedChecklistRows().map(({ group, rows: groupRows }) => {
            const navOpen = capNavGroupExpanded[group]
            const groupHasHighlight = groupRows.some(row => highlightedCapabilityId === row.id)
            return (
              <div key={group} className="feed-massive-cap-group">
                <button
                  type="button"
                  className={`feed-massive-cap-group-toggle${groupHasHighlight ? ' feed-massive-cap-group-toggle--active' : ''}`}
                  aria-expanded={navOpen}
                  aria-controls={`feed-massive-cap-group-panel-${group}`}
                  id={`feed-massive-cap-group-head-${group}`}
                  onClick={() => setCapNavGroupExpanded(prev => ({ ...prev, [group]: !prev[group] }))}
                >
                  <span
                    className={`feed-massive-cap-group-chevron${navOpen ? ' feed-massive-cap-group-chevron--open' : ''}`}
                    aria-hidden
                  >
                    ▼
                  </span>
                  <span className="feed-massive-cap-group-label">{CAPABILITY_GROUP_LABELS[group]}</span>
                </button>
                <div
                  id={`feed-massive-cap-group-panel-${group}`}
                  className="feed-massive-cap-group-panel"
                  hidden={!navOpen}
                  role="region"
                  aria-labelledby={`feed-massive-cap-group-head-${group}`}
                >
                  <div className="feed-massive-cap-summary">
                    {groupRows.map(row => {
                      const tierOk = tierOkForRow(row, massiveStatus, Boolean(configured))
                      const tradesOk = tradesOkForRow(row, massiveStatus)
                      const eff = effectiveChecklistProjectStatus(row, Boolean(configured), tierOk, tradesOk)
                      return (
                        <a
                          key={row.id}
                          href={`#${feedMassiveSvcAnchorId(row.id)}`}
                          className={`feed-massive-tab-chip${highlightedCapabilityId === row.id ? ' feed-massive-tab-chip--active' : ''}`}
                          aria-current={highlightedCapabilityId === row.id ? 'location' : undefined}
                          onClick={e => {
                            e.preventDefault()
                            scrollToSection(row.id)
                          }}
                        >
                          <span className={feedMassiveOverviewDotClass(eff)} title={checklistEffectiveStatusLabel(eff)} aria-hidden />
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

      {!configured && (
        <p className="status-page-msg err" role="alert">
          Massive API key not configured. Set massive credentials in server config.
        </p>
      )}

      <div className="feed-massive-tab-panel">
        <div className="feed-massive-delivery-tabs">
          <div className="feed-massive-delivery-tablist" role="tablist" aria-label="Massive data channel">
            <button
              type="button"
              role="tab"
              id="feed-massive-delivery-tab-rest"
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
              id="feed-massive-delivery-tab-ws"
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
              id="feed-massive-delivery-tab-flat"
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
              id="feed-massive-group-rest"
              aria-labelledby="feed-massive-delivery-tab-rest"
            >
            <div className="feed-massive-delivery-tablist" role="tablist" aria-label="REST API sections">
              {OPTION_REST_SECTION_ORDER.map(sid => (
                <button
                  key={sid}
                  type="button"
                  role="tab"
                  id={`feed-massive-rest-subtab-${sid}`}
                  className={`feed-massive-delivery-tab${deliveryRestSubTab === sid ? ' feed-massive-delivery-tab--active' : ''}`}
                  aria-selected={deliveryRestSubTab === sid}
                  tabIndex={deliveryRestSubTab === sid ? 0 : -1}
                  onClick={() => setDeliveryRestSubTab(sid)}
                >
                  {OPTION_REST_SECTION_LABELS[sid]}
                </button>
              ))}
            </div>

        {deliveryRestSubTab === 'contracts' ? (
        <>
        {/* Contracts */}
        <FeedMassiveCapabilityPanel
          capId="contracts"
          checklistRow={rCt}
          effectiveStatus={effCt}
          expanded={capExpanded.contracts === true}
          onToggle={() => toggleCap('contracts')}
          highlight={highlightedCapabilityId === 'contracts'}
          ariaLabel="Contracts"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effCt}
            checklistRow={rCt}
            evidence={contractsEvidence}
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="3" width="16" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M6 7h8M6 10h5M6 13h7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                </span>
                <h3>Contracts</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Massive Options REST: All Contracts (<code>GET /v3/reference/options/contracts</code>) and Contract Overview (<code>GET /v3/reference/options/contracts/&#123;options_ticker&#125;</code>), plus DB coverage and contract-level snapshots.
            </p>
          </FeedMassiveServiceBlock>

          <div className="feed-massive-agg-tabs-wrap">
            <div className="feed-massive-agg-tabs" role="tablist" aria-label="Contracts API variants">
              <button
                type="button" role="tab"
                id="feed-massive-ct-tab-list"
                className={`feed-massive-agg-tab${ctSubTab === 'contracts_list' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={ctSubTab === 'contracts_list'}
                tabIndex={ctSubTab === 'contracts_list' ? 0 : -1}
                onClick={() => setCtSubTab('contracts_list')}
              >
                All Contracts
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button" role="tab"
                id="feed-massive-ct-tab-detail"
                className={`feed-massive-agg-tab${ctSubTab === 'contract_detail' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={ctSubTab === 'contract_detail'}
                tabIndex={ctSubTab === 'contract_detail' ? 0 : -1}
                onClick={() => setCtSubTab('contract_detail')}
              >
                Contract Overview
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button" role="tab"
                id="feed-massive-ct-tab-verify"
                className={`feed-massive-agg-tab${ctSubTab === 'db_verify' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={ctSubTab === 'db_verify'}
                tabIndex={ctSubTab === 'db_verify' ? 0 : -1}
                onClick={() => setCtSubTab('db_verify')}
              >
                DB Verify
                <span className="feed-massive-agg-tab-badge">PG</span>
              </button>
              <button
                type="button" role="tab"
                id="feed-massive-ct-tab-snap"
                className={`feed-massive-agg-tab${ctSubTab === 'snapshot_link' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={ctSubTab === 'snapshot_link'}
                tabIndex={ctSubTab === 'snapshot_link' ? 0 : -1}
                onClick={() => setCtSubTab('snapshot_link')}
              >
                Snapshot Link
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
            </div>

            <div className="feed-massive-agg-tab-panels">

              {ctSubTab === 'contracts_list' ? (
                <div className="feed-massive-agg-tab-panel" role="tabpanel" id="feed-massive-ct-panel-list" aria-labelledby="feed-massive-ct-tab-list">
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>All Contracts</strong> — <code>GET /v3/reference/options/contracts</code>. Returns a paginated index (<code>results</code>, <code>next_url</code>) of option contracts (active and expired). Filter by <code>underlying_ticker</code>, <code>contract_type</code>, <code>expiration_date</code> (YYYY-MM-DD), <code>limit</code> (API default 10, max 1000), <code>sort</code>, <code>order</code>, and range operators as in Massive docs.</p>
                    <p><strong>When to use:</strong> Market availability, contract exploration, or populating the local <code>option_contracts</code> reference table before snapshots.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/reference/options/contracts</code></p>
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">underlying_ticker</span>
                      <input className="form-input" value={ctListSymbol} onChange={e => setCtListSymbol(e.target.value)} disabled={ctListBusy || !configured} autoComplete="off" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">expiration_date</span>
                      <input className="form-input" value={ctListExpDate} onChange={e => setCtListExpDate(e.target.value)} disabled={ctListBusy || !configured} placeholder="YYYY-MM-DD" autoComplete="off" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">contract_type</span>
                      <select className="form-input" value={ctListContractType} onChange={e => setCtListContractType(e.target.value as '' | 'call' | 'put')} disabled={ctListBusy || !configured}>
                        <option value="">All</option>
                        <option value="call">call</option>
                        <option value="put">put</option>
                      </select>
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">limit</span>
                      <input className="form-input" type="number" value={ctListLimit} onChange={e => setCtListLimit(e.target.value)} disabled={ctListBusy || !configured} min={1} max={250} />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                    <button type="button" className="btn btn-secondary" disabled={ctListBusy || !configured} onClick={() => runCtContractsList()}>
                      {ctListBusy ? 'Running\u2026' : 'Fetch contracts'}
                    </button>
                    <button type="button" className="btn btn-primary" disabled={ctCoverageBusy} onClick={() => loadCtCoverage()}>
                      {ctCoverageBusy ? 'Loading\u2026' : 'Check Coverage'}
                    </button>
                  </div>
                  {ctListErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{ctListErr}</p> : null}
                  {ctCoverage && ctCoverage.ok && ctCoverage.total != null && ctCoverage.total > 0 ? (
                    <div className="gk-quality-summary-strip" style={{ marginTop: 'var(--space-3)' }}>
                      <div className="gk-quality-summary-cell"><span className="gk-quality-summary-val">{ctCoverage.total}</span><span className="gk-quality-summary-lbl">Contracts</span></div>
                      <div className="gk-quality-summary-cell"><span className="gk-quality-summary-val">{ctCoverage.coverage?.with_massive_ticker ?? 0}</span><span className="gk-quality-summary-lbl">With Ticker</span></div>
                      <div className="gk-quality-summary-cell"><span className="gk-quality-summary-val">{ctCoverage.coverage?.ticker_pct ?? 0}%</span><span className="gk-quality-summary-lbl">Ticker %</span></div>
                      <div className="gk-quality-summary-cell"><span className="gk-quality-summary-val">{ctCoverage.coverage?.distinct_expirations ?? 0}</span><span className="gk-quality-summary-lbl">Expirations</span></div>
                      <div className="gk-quality-summary-cell"><span className="gk-quality-summary-val">{ctCoverage.coverage?.distinct_strikes ?? 0}</span><span className="gk-quality-summary-lbl">Strikes</span></div>
                      {ctCoverage.coverage?.mapping_mismatch != null && ctCoverage.coverage.mapping_mismatch > 0 ? (
                        <div className="gk-quality-summary-cell"><span className="gk-quality-summary-val" style={{ color: 'var(--clr-warning)' }}>{ctCoverage.coverage.mapping_mismatch}</span><span className="gk-quality-summary-lbl">Mismatches</span></div>
                      ) : null}
                      {ctCoverage.freshness?.stale_rows != null && ctCoverage.freshness.stale_rows > 0 ? (
                        <div className="gk-quality-summary-cell"><span className="gk-quality-summary-val" style={{ color: 'var(--clr-warning)' }}>{ctCoverage.freshness.stale_rows}</span><span className="gk-quality-summary-lbl">Stale (&gt;7d)</span></div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {ctSubTab === 'contract_detail' ? (
                <div className="feed-massive-agg-tab-panel" role="tabpanel" id="feed-massive-ct-panel-detail" aria-labelledby="feed-massive-ct-tab-detail">
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Contract Overview</strong> — <code>GET /v3/reference/options/contracts/&#123;options_ticker&#125;</code>. Path parameter <code>options_ticker</code> identifies the contract (Massive deprecates the list endpoint&apos;s <code>ticker</code> query param for this). Optional query <code>as_of</code> (YYYY-MM-DD) is not exposed in this form.</p>
                    <p><strong>When to use:</strong> Contract specification reference, chain analysis, or validating a single contract&apos;s <code>results</code> object (cfi, contract_type, exercise_style, expiration_date, strike_price, shares_per_contract, primary_exchange, underlying_ticker, additional_underlyings).</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/reference/options/contracts/&#123;options_ticker&#125;</code></p>
                  </div>
                  <label className="feed-massive-field" style={{ marginBottom: 'var(--space-3)' }}>
                    <span className="form-label">options_ticker</span>
                    <input
                      className="form-input" style={{ maxWidth: '100%' }}
                      value={ctDetailTicker} onChange={e => setCtDetailTicker(e.target.value)}
                      disabled={ctDetailBusy || !configured}
                      placeholder="O:AAPL211119C00085000" autoComplete="off"
                    />
                  </label>
                  <button type="button" className="btn btn-secondary" disabled={ctDetailBusy || !configured} onClick={() => runCtContractDetail()}>
                    {ctDetailBusy ? 'Running\u2026' : 'Fetch overview'}
                  </button>
                  {ctDetailErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{ctDetailErr}</p> : null}
                  {ctDetailResult ? (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <table className="status-page-table" style={{ fontSize: '0.82rem' }}>
                        <tbody>
                          {(['ticker', 'underlying_ticker', 'expiration_date', 'strike_price', 'contract_type', 'exercise_style', 'shares_per_contract', 'primary_exchange', 'cfi'] as const).map(key => (
                            <tr key={key}>
                              <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{key}</td>
                              <td>{ctDetailResult[key] != null ? String(ctDetailResult[key]) : '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {ctSubTab === 'db_verify' ? (
                <div className="feed-massive-agg-tab-panel" role="tabpanel" id="feed-massive-ct-panel-verify" aria-labelledby="feed-massive-ct-tab-verify">
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Verify local <code>option_contracts</code> table coverage and mapping consistency against the Massive API. Shows how many contracts have a Polygon ticker mapped, identity completeness, and freshness.</p>
                    <p><strong>When to use:</strong> After running chain snapshots (which populate <code>option_contracts</code>), use this to audit data quality and identify gaps before downstream analysis.</p>
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Symbol</span>
                      <input className="form-input" value={ctListSymbol} onChange={e => setCtListSymbol(e.target.value)} disabled={ctCoverageBusy} autoComplete="off" />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-primary" disabled={ctCoverageBusy} onClick={() => loadCtCoverage()}>
                      {ctCoverageBusy ? 'Loading\u2026' : 'Check Coverage'}
                    </button>
                  </div>
                  {ctCoverage && ctCoverage.ok && ctCoverage.total != null && ctCoverage.total > 0 ? (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <table className="status-page-table" style={{ fontSize: '0.82rem' }}>
                        <thead>
                          <tr>
                            <th>Metric</th>
                            <th>Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr><td>Total contracts</td><td>{ctCoverage.total}</td></tr>
                          <tr><td>With Massive ticker</td><td>{ctCoverage.coverage?.with_massive_ticker ?? 0} ({ctCoverage.coverage?.ticker_pct ?? 0}%)</td></tr>
                          <tr><td>Complete identity</td><td>{ctCoverage.coverage?.with_complete_identity ?? 0} ({ctCoverage.coverage?.identity_pct ?? 0}%)</td></tr>
                          <tr><td>Mapping mismatches</td><td>{ctCoverage.coverage?.mapping_mismatch ?? 0}</td></tr>
                          <tr><td>Distinct expirations</td><td>{ctCoverage.coverage?.distinct_expirations ?? 0}</td></tr>
                          <tr><td>Distinct strikes</td><td>{ctCoverage.coverage?.distinct_strikes ?? 0}</td></tr>
                          <tr><td>Oldest entry</td><td>{ctCoverage.freshness?.oldest_ts ?? '—'}</td></tr>
                          <tr><td>Newest entry</td><td>{ctCoverage.freshness?.newest_ts ?? '—'}</td></tr>
                          <tr><td>Stale (&gt;7 days)</td><td>{ctCoverage.freshness?.stale_rows ?? 0}</td></tr>
                        </tbody>
                      </table>
                    </div>
                  ) : ctCoverage && ctCoverage.ok && ctCoverage.total === 0 ? (
                    <p className="status-page-msg" style={{ marginTop: 'var(--space-3)' }}>No contracts found in <code>option_contracts</code> for this symbol. Run a chain snapshot first to populate.</p>
                  ) : ctCoverage && !ctCoverage.ok ? (
                    <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{ctCoverage.error ?? 'Failed to load coverage'}</p>
                  ) : null}
                </div>
              ) : null}

              {ctSubTab === 'snapshot_link' ? (
                <div className="feed-massive-agg-tab-panel" role="tabpanel" id="feed-massive-ct-panel-snap" aria-labelledby="feed-massive-ct-tab-snap">
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> From a known contract ticker, trigger a single-contract snapshot to verify live quote data (bid/ask/greeks/IV) end-to-end. Completes the contract → snapshot verification loop.</p>
                    <p><strong>When to use:</strong> After discovering a contract via list/detail tabs, verify its live market data through the snapshot pipeline.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/snapshot/options/&#123;underlyingAsset&#125;/&#123;optionContract&#125;</code></p>
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Underlying</span>
                      <input className="form-input" value={ctSnapUnderlying} onChange={e => setCtSnapUnderlying(e.target.value)} disabled={ctSnapBusy || !configured} autoComplete="off" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Options ticker</span>
                      <input className="form-input" value={ctSnapTicker} onChange={e => setCtSnapTicker(e.target.value)} disabled={ctSnapBusy || !configured} placeholder="O:SPY251219C00600000" autoComplete="off" />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={ctSnapBusy || !configured} onClick={() => runCtSnapshotLink()}>
                      {ctSnapBusy ? 'Running\u2026' : 'Fetch Contract Snapshot'}
                    </button>
                  </div>
                  {ctSnapErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{ctSnapErr}</p> : null}
                  {ctSnapResult ? (
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <details>
                        <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.82rem' }}>Snapshot result</summary>
                        <pre style={{ maxHeight: '20rem', overflow: 'auto', fontSize: '0.75rem', marginTop: 'var(--space-2)', padding: 'var(--space-2)', borderRadius: 'var(--radius-sm)', background: 'var(--surface-2, #f5f5f5)' }}>
                          {JSON.stringify(ctSnapResult, null, 2)}
                        </pre>
                      </details>
                    </div>
                  ) : null}
                </div>
              ) : null}

            </div>
          </div>
        </FeedMassiveCapabilityPanel>
        </>
        ) : null}

        {deliveryRestSubTab === 'aggregates' ? (
        <>
        {/* REST Aggregate Bars (OHLC): three DocPage rows — Custom / Daily Ticker Summary / Previous Day Bar (see massive_api_coverage.csv). WS aggregates are separate sections below. */}
        <FeedMassiveCapabilityPanel
          capId="aggregates"
          checklistRow={rAgg}
          effectiveStatus={effAgg}
          expanded={capExpanded.aggregates === true}
          onToggle={() => toggleCap('aggregates')}
          highlight={highlightedCapabilityId === 'aggregates'}
          ariaLabel={rAgg.service}
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effAgg}
            checklistRow={rAgg}
            evidence={jobEvidenceLine(latestJobForKind(jobs, 'aggregates'))}
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconBars />
                </span>
                <h3>{rAgg.service}</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">{rAgg.description}</p>
          </FeedMassiveServiceBlock>

          <div className="feed-massive-agg-tabs-wrap">
            <div
              className="feed-massive-agg-tabs"
              role="tablist"
              aria-label="Aggregate Bars (OHLC) REST endpoints"
            >
              <button
                type="button"
                role="tab"
                id="feed-massive-agg-tab-custom"
                className={`feed-massive-agg-tab${aggSubTab === 'custom_bars' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={aggSubTab === 'custom_bars'}
                tabIndex={aggSubTab === 'custom_bars' ? 0 : -1}
                onClick={() => setAggSubTab('custom_bars')}
              >
                Custom Bars (OHLC)
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-agg-tab-openclose"
                className={`feed-massive-agg-tab${aggSubTab === 'open_close' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={aggSubTab === 'open_close'}
                tabIndex={aggSubTab === 'open_close' ? 0 : -1}
                onClick={() => setAggSubTab('open_close')}
              >
                Daily Ticker Summary (OHLC)
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-agg-tab-prev"
                className={`feed-massive-agg-tab${aggSubTab === 'prev' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={aggSubTab === 'prev'}
                tabIndex={aggSubTab === 'prev' ? 0 : -1}
                onClick={() => setAggSubTab('prev')}
              >
                Previous Day Bar (OHLC)
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
            </div>

            <div className="feed-massive-agg-tab-panels">
              {aggSubTab === 'custom_bars' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-agg-panel-custom"
                  aria-labelledby="feed-massive-agg-tab-custom"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Retrieve aggregated historical OHLCV data for a specific options contract over a custom date range and time interval (second / minute / hour / day). Bars are constructed from qualifying trades only.</p>
                    <p><strong>When to use:</strong> Backfilling per-contract price bars for charting, technical analysis, or strategy backtesting. This is the primary aggregate endpoint for historical research.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v2/aggs/ticker/&#123;optionsTicker&#125;/range/&#123;multiplier&#125;/&#123;timespan&#125;/&#123;from&#125;/&#123;to&#125;</code></p>
                  </div>
                  <label className="feed-massive-field" style={{ marginBottom: 'var(--space-3)' }}>
                    <span className="form-label">Options ticker</span>
                    <input
                      className="form-input"
                      style={{ maxWidth: '100%' }}
                      value={aggTicker}
                      onChange={e => setAggTicker(e.target.value)}
                      disabled={aggBusy || !configured}
                      placeholder="O:SPY251219C00600000"
                      autoComplete="off"
                    />
                  </label>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Symbol</span>
                      <input className="form-input" value={aggSymbol} onChange={e => setAggSymbol(e.target.value)} disabled={aggBusy || !configured} />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Expiry</span>
                      <input className="form-input" value={aggExpiry} onChange={e => setAggExpiry(e.target.value)} disabled={aggBusy || !configured} placeholder="YYYYMMDD" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Strike</span>
                      <input className="form-input" value={aggStrike} onChange={e => setAggStrike(e.target.value)} disabled={aggBusy || !configured} />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Right</span>
                      <select className="form-input" value={aggRight} onChange={e => setAggRight(e.target.value as 'C' | 'P')} disabled={aggBusy || !configured}>
                        <option value="C">Call</option>
                        <option value="P">Put</option>
                      </select>
                    </label>
                  </div>
                  <div className="feed-massive-form-grid feed-massive-form-grid--wide">
                    <label className="feed-massive-field">
                      <span className="form-label">Start (ms)</span>
                      <input className="form-input" value={aggStartMs} onChange={e => setAggStartMs(e.target.value)} disabled={aggBusy || !configured} />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">End (ms)</span>
                      <input className="form-input" value={aggEndMs} onChange={e => setAggEndMs(e.target.value)} disabled={aggBusy || !configured} />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Timespan</span>
                      <input className="form-input" value={aggTimespan} onChange={e => setAggTimespan(e.target.value)} disabled={aggBusy || !configured} />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Multiplier</span>
                      <input className="form-input" value={aggMult} onChange={e => setAggMult(e.target.value)} disabled={aggBusy || !configured} />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={aggBusy || !configured} onClick={() => runAggregates()}>
                      {aggBusy ? 'Running\u2026' : 'Enqueue Custom Bars (OHLC)'}
                    </button>
                  </div>
                  {aggErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{aggErr}</p> : null}
                </div>
              ) : null}

              {aggSubTab === 'open_close' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-agg-panel-openclose"
                  aria-labelledby="feed-massive-agg-tab-openclose"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Retrieve the opening and closing prices for a specific options contract on a given date, including pre-market and after-hours trade prices.</p>
                    <p><strong>When to use:</strong> Daily performance analysis, historical end-of-day archiving, after-hours price review, or portfolio tracking where a single-day summary per contract is sufficient.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v1/open-close/&#123;optionsTicker&#125;/&#123;date&#125;</code></p>
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Options ticker</span>
                      <input className="form-input" value={ocTicker} onChange={e => setOcTicker(e.target.value)} disabled={ocBusy || !configured} placeholder="O:SPY251219C00600000" autoComplete="off" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Date (YYYY-MM-DD)</span>
                      <input className="form-input" value={ocDate} onChange={e => setOcDate(e.target.value)} disabled={ocBusy || !configured} placeholder="2025-12-19" />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={ocBusy || !configured} onClick={() => runOpenClose()}>
                      {ocBusy ? 'Running\u2026' : 'Enqueue Daily Ticker Summary (OHLC)'}
                    </button>
                  </div>
                  {ocErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{ocErr}</p> : null}
                </div>
              ) : null}

              {aggSubTab === 'prev' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-agg-panel-prev"
                  aria-labelledby="feed-massive-agg-tab-prev"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Retrieve the previous trading day&apos;s OHLC, volume, and VWAP for a specified option contract in a single call — no need to calculate the previous trading date yourself.</p>
                    <p><strong>When to use:</strong> Baseline comparison for today&apos;s price action, quick daily reporting, or building overnight change metrics without maintaining a trading calendar.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v2/aggs/ticker/&#123;optionsTicker&#125;/prev</code></p>
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Options ticker</span>
                      <input className="form-input" value={prevTicker} onChange={e => setPrevTicker(e.target.value)} disabled={prevBusy || !configured} placeholder="O:SPY251219C00600000" autoComplete="off" />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={prevBusy || !configured} onClick={() => runPrevDay()}>
                      {prevBusy ? 'Running\u2026' : 'Enqueue Previous Day Bar (OHLC)'}
                    </button>
                  </div>
                  {prevErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{prevErr}</p> : null}
                </div>
              ) : null}

            </div>
          </div>
        </FeedMassiveCapabilityPanel>
        </>
        ) : null}

        {deliveryRestSubTab === 'snapshot' ? (
        <>
        {/* REST Snapshots: Contract → Chain → Unified (tab order); DocPage names per massive_api_coverage.csv */}
        <FeedMassiveCapabilityPanel
          capId="snapshot"
          checklistRow={rSnap}
          effectiveStatus={effSnap}
          expanded={capExpanded.snapshot === true}
          onToggle={() => toggleCap('snapshot')}
          highlight={highlightedCapabilityId === 'snapshot'}
          ariaLabel={rSnap.service}
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effSnap}
            checklistRow={rSnap}
            evidence={jobEvidenceLine(latestJobForKind(jobs, 'snapshot'))}
            testArea={
              <button
                type="button"
                className="btn btn-primary"
                disabled={snapBusy || !configured}
                onClick={() => runSnapshot()}
              >
                {snapBusy
                  ? 'Running…'
                  : `Enqueue ${
                      snapType === 'chain'
                        ? 'Option Chain Snapshot'
                        : snapType === 'contract'
                          ? 'Option Contract Snapshot'
                          : 'Unified Snapshot'
                    }`}
              </button>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconSnapshot />
                </span>
                <h3>{rSnap.service}</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">{rSnap.description}</p>
          </FeedMassiveServiceBlock>

          <div className="feed-massive-agg-tabs-wrap">
            <div
              className="feed-massive-agg-tabs"
              role="tablist"
              aria-label="Snapshots REST DocPage rows"
            >
              <button
                type="button"
                role="tab"
                id="feed-massive-snap-tab-contract"
                className={`feed-massive-agg-tab${snapType === 'contract' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={snapType === 'contract'}
                tabIndex={snapType === 'contract' ? 0 : -1}
                disabled={snapBusy}
                onClick={() => {
                  setSnapType('contract')
                  setSnapErr(null)
                  setSnapResult(null)
                }}
              >
                Option Contract Snapshot
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-snap-tab-chain"
                className={`feed-massive-agg-tab${snapType === 'chain' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={snapType === 'chain'}
                tabIndex={snapType === 'chain' ? 0 : -1}
                disabled={snapBusy}
                onClick={() => {
                  setSnapType('chain')
                  setSnapErr(null)
                  setSnapResult(null)
                }}
              >
                Option Chain Snapshot
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-snap-tab-unified"
                className={`feed-massive-agg-tab${snapType === 'unified' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={snapType === 'unified'}
                tabIndex={snapType === 'unified' ? 0 : -1}
                disabled={snapBusy}
                onClick={() => {
                  setSnapType('unified')
                  setSnapErr(null)
                  setSnapResult(null)
                }}
              >
                Unified Snapshot
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
            </div>

            <div className="feed-massive-agg-tab-panels">
          {/* ── Contract form ── */}
          {snapType === 'contract' ? (
            <div
              className="snap-wb-form feed-massive-agg-tab-panel"
              role="tabpanel"
              id="feed-massive-snap-panel-contract"
              aria-labelledby="feed-massive-snap-tab-contract"
            >
              <div className="snap-wb-scenario">
                <p className="snap-wb-scenario-title">Use cases</p>
                <p className="snap-wb-scenario-text">
                  Evaluate a single contract before placing a trade — see break-even, greeks, IV, and OI in one call.
                  Risk assessment for an existing position by checking current market snapshot.
                  Strategy refinement when comparing a shortlist of specific contracts.
                </p>
                <p className="snap-wb-scenario-title">Documentation purpose</p>
                <p className="snap-wb-scenario-text">
                  <code>GET /v3/snapshot/options/{'{underlyingAsset}'}/{'{optionContract}'}</code> — returns a single contract snapshot
                  with break-even price, greeks, implied volatility, open interest, last quote and trade, and underlying asset info.
                  No server-side filtering needed; you target exactly one contract by its OPRA-style ticker.
                </p>
              </div>
              <div className="feed-massive-form-grid">
                <label className="feed-massive-field">
                  <span className="form-label">Underlying *</span>
                  <input className="form-input" value={contractUnderlying} onChange={e => setContractUnderlying(e.target.value)} disabled={snapBusy || !configured} autoComplete="off" placeholder="AAPL" />
                </label>
                <label className="feed-massive-field" style={{ gridColumn: '1 / -1' }}>
                  <span className="form-label">Option contract ticker *</span>
                  <input className="form-input" value={contractTicker} onChange={e => setContractTicker(e.target.value)} disabled={snapBusy || !configured} autoComplete="off" placeholder="O:AAPL251219C00200000" />
                </label>
              </div>
            </div>
          ) : null}

          {/* ── Chain form ── */}
          {snapType === 'chain' ? (
            <div
              className="snap-wb-form feed-massive-agg-tab-panel"
              role="tabpanel"
              id="feed-massive-snap-panel-chain"
              aria-labelledby="feed-massive-snap-tab-chain"
            >
              <div className="snap-wb-scenario">
                <p className="snap-wb-scenario-title">Use cases</p>
                <p className="snap-wb-scenario-text">
                  Market overview for an entire underlying — compare all strikes and expirations at once.
                  Strategy comparison across the full chain. Research and modeling with greeks, IV, and OI.
                  Portfolio refinement by filtering specific expiration ranges or strike zones.
                </p>
                <p className="snap-wb-scenario-title">Documentation purpose</p>
                <p className="snap-wb-scenario-text">
                  <code>GET /v3/snapshot/options/{'{underlyingAsset}'}</code> — returns paginated snapshots for all contracts
                  of a given underlying, including pricing, greeks, IV, OI, last trade and quote.
                  Supports server-side filtering by strike price, expiration date, and contract type.
                  Persists rows into <code>option_contracts</code> and <code>option_snapshots</code>.
                </p>
              </div>
              <div className="feed-massive-form-grid">
                <label className="feed-massive-field">
                  <span className="form-label">Underlying *</span>
                  <input className="form-input" value={snapSymbol} onChange={e => setSnapSymbol(e.target.value)} disabled={snapBusy || !configured} autoComplete="off" placeholder="NVDA" />
                </label>
                <label className="feed-massive-field">
                  <span className="form-label">Contract type</span>
                  <select className="form-input" value={chainContractType} onChange={e => setChainContractType(e.target.value as '' | 'call' | 'put')} disabled={snapBusy || !configured}>
                    <option value="">All</option>
                    <option value="call">Call</option>
                    <option value="put">Put</option>
                  </select>
                </label>
                <label className="feed-massive-field">
                  <span className="form-label">Limit</span>
                  <input className="form-input" value={chainLimit} onChange={e => setChainLimit(e.target.value)} disabled={snapBusy || !configured} placeholder="250" />
                </label>
                <label className="feed-massive-field">
                  <span className="form-label">Order</span>
                  <select className="form-input" value={chainOrder} onChange={e => setChainOrder(e.target.value as '' | 'asc' | 'desc')} disabled={snapBusy || !configured}>
                    <option value="">Default</option>
                    <option value="asc">Ascending</option>
                    <option value="desc">Descending</option>
                  </select>
                </label>
              </div>
              <details className="snap-wb-adv-filters">
                <summary>Advanced filters</summary>
                <div className="feed-massive-form-grid" style={{ marginTop: 'var(--space-2)' }}>
                  <label className="feed-massive-field">
                    <span className="form-label">Expiration (exact)</span>
                    <input className="form-input" value={chainExpDate} onChange={e => setChainExpDate(e.target.value)} disabled={snapBusy || !configured} placeholder="YYYY-MM-DD" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Expiration &ge;</span>
                    <input className="form-input" value={chainExpDateGte} onChange={e => setChainExpDateGte(e.target.value)} disabled={snapBusy || !configured} placeholder="YYYY-MM-DD" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Expiration &le;</span>
                    <input className="form-input" value={chainExpDateLte} onChange={e => setChainExpDateLte(e.target.value)} disabled={snapBusy || !configured} placeholder="YYYY-MM-DD" />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Strike (exact)</span>
                    <input className="form-input" value={chainStrike} onChange={e => setChainStrike(e.target.value)} disabled={snapBusy || !configured} />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Strike &ge;</span>
                    <input className="form-input" value={chainStrikeGte} onChange={e => setChainStrikeGte(e.target.value)} disabled={snapBusy || !configured} />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Strike &le;</span>
                    <input className="form-input" value={chainStrikeLte} onChange={e => setChainStrikeLte(e.target.value)} disabled={snapBusy || !configured} />
                  </label>
                  <label className="feed-massive-field">
                    <span className="form-label">Sort field</span>
                    <input className="form-input" value={chainSort} onChange={e => setChainSort(e.target.value)} disabled={snapBusy || !configured} placeholder="e.g. strike_price" />
                  </label>
                </div>
              </details>
            </div>
          ) : null}

          {/* ── Unified form ── */}
          {snapType === 'unified' ? (
            <div
              className="snap-wb-form feed-massive-agg-tab-panel"
              role="tabpanel"
              id="feed-massive-snap-panel-unified"
              aria-labelledby="feed-massive-snap-tab-unified"
            >
              <div className="snap-wb-scenario">
                <p className="snap-wb-scenario-title">Use cases</p>
                <p className="snap-wb-scenario-text">
                  Cross-market analysis — compare stocks, options, forex, and crypto snapshots in a single request.
                  Diversified portfolio monitoring with one API call covering all held asset types.
                  Multi-asset trading strategies that need a unified view of current conditions across markets.
                </p>
                <p className="snap-wb-scenario-title">Documentation purpose</p>
                <p className="snap-wb-scenario-text">
                  <code>GET /v3/snapshot</code> — retrieves unified market data snapshots for multiple tickers
                  across asset classes (stocks, options, forex, crypto, indices).
                  Accepts a comma-separated ticker list (up to 250) via <code>ticker.any_of</code> and optional <code>type</code> filter.
                  Response includes last trade, last quote, session OHLCV, greeks (for options), and per-ticker errors for unresolvable tickers.
                </p>
              </div>
              <div className="feed-massive-form-grid">
                <label className="feed-massive-field" style={{ gridColumn: '1 / -1' }}>
                  <span className="form-label">Tickers (comma separated) *</span>
                  <input className="form-input" value={unifiedTickers} onChange={e => setUnifiedTickers(e.target.value)} disabled={snapBusy || !configured} autoComplete="off" placeholder="AAPL,O:AAPL251219C00200000,C:BTC-USD" />
                </label>
                <label className="feed-massive-field">
                  <span className="form-label">Asset type</span>
                  <select className="form-input" value={unifiedAssetType} onChange={e => setUnifiedAssetType(e.target.value as typeof unifiedAssetType)} disabled={snapBusy || !configured}>
                    <option value="">All</option>
                    <option value="stocks">Stocks</option>
                    <option value="options">Options</option>
                    <option value="fx">Forex</option>
                    <option value="crypto">Crypto</option>
                    <option value="indices">Indices</option>
                  </select>
                </label>
                <label className="feed-massive-field">
                  <span className="form-label">Limit</span>
                  <input className="form-input" value={unifiedLimit} onChange={e => setUnifiedLimit(e.target.value)} disabled={snapBusy || !configured} placeholder="10" />
                </label>
              </div>
            </div>
          ) : null}

            </div>
          </div>

          {/* Error */}
          {snapErr ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {snapErr}
            </p>
          ) : null}

          {/* Result: Summary + Content */}
          {snapResult ? (
            <div className="snap-wb-result">
              <div className="snap-wb-summary">
                <h4 className="snap-wb-summary-title">Summary</h4>
                <div className="snap-wb-summary-grid">
                  {Object.entries(snapResult.summary).map(([k, v]) => (
                    <div key={k} className="snap-wb-summary-item">
                      <span className="snap-wb-summary-key">{k.replace(/_/g, ' ')}</span>
                      <span className="snap-wb-summary-val">
                        {typeof v === 'boolean' ? (v ? 'Yes' : 'No')
                          : Array.isArray(v) ? (v.length === 0 ? '—' : v.map(x => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(', '))
                          : typeof v === 'object' && v !== null ? JSON.stringify(v)
                          : v == null ? '—' : String(v)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <details className="feed-massive-details-debug" open>
                <summary>
                  Content{snapResult.content_truncated ? ' (truncated to 100 items)' : ''}
                  {Array.isArray(snapResult.content) ? ` — ${(snapResult.content as unknown[]).length} item(s)` : ''}
                </summary>
                <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '32rem' }}>
                  {JSON.stringify(snapResult.content, null, 2)}
                </pre>
              </details>
            </div>
          ) : null}
        </FeedMassiveCapabilityPanel>
        </>
        ) : null}

        {deliveryRestSubTab === 'trades-quotes' ? (
        <>
        {/* REST tab order: Trades, Last Trade, Quotes; then Flat Files: Quotes, Trades. */}
        <FeedMassiveCapabilityPanel
          capId="trades-quotes"
          checklistRow={rTr}
          effectiveStatus={effTr}
          expanded={capExpanded['trades-quotes'] === true}
          onToggle={() => toggleCap('trades-quotes')}
          highlight={highlightedCapabilityId === 'trades-quotes'}
          ariaLabel={rTr.service}
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effTr}
            checklistRow={rTr}
            evidence={
              tqLastTradeResult
                ? `Last Trade fetched. ${tqHistQuotesResult ? `Quotes: ${tqHistQuotesResult.count ?? '?'} row(s). ` : ''}${tqHistTradesResult ? `Trades: ${tqHistTradesResult.count ?? '?'} row(s).` : ''}`
                : 'Use the tabs below to query Massive Trade & Quotes REST endpoints (and Flat Files pointers).'
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconTrades />
                </span>
                <h3>{rTr.service}</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">{rTr.description}</p>
          </FeedMassiveServiceBlock>

          <div className="feed-massive-agg-tabs-wrap">
            <div
              className="feed-massive-agg-tabs"
              role="tablist"
              aria-label="Trade & Quotes REST and Flat Files"
            >
              <button
                type="button"
                role="tab"
                id="feed-massive-tq-tab-hist-trades"
                className={`feed-massive-agg-tab${tqSubTab === 'hist_trades' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={tqSubTab === 'hist_trades'}
                tabIndex={tqSubTab === 'hist_trades' ? 0 : -1}
                onClick={() => setTqSubTab('hist_trades')}
              >
                Trades
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-tq-tab-last-trade"
                className={`feed-massive-agg-tab${tqSubTab === 'last_trade' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={tqSubTab === 'last_trade'}
                tabIndex={tqSubTab === 'last_trade' ? 0 : -1}
                onClick={() => setTqSubTab('last_trade')}
              >
                Last Trade
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-tq-tab-hist-quotes"
                className={`feed-massive-agg-tab${tqSubTab === 'hist_quotes' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={tqSubTab === 'hist_quotes'}
                tabIndex={tqSubTab === 'hist_quotes' ? 0 : -1}
                onClick={() => setTqSubTab('hist_quotes')}
              >
                Quotes
                <span className="feed-massive-agg-tab-badge">REST</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-tq-tab-flat-quotes"
                className={`feed-massive-agg-tab${tqSubTab === 'flat_quotes' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={tqSubTab === 'flat_quotes'}
                tabIndex={tqSubTab === 'flat_quotes' ? 0 : -1}
                onClick={() => setTqSubTab('flat_quotes')}
              >
                Quotes (Flat Files)
                <span className="feed-massive-agg-tab-badge">File</span>
              </button>
              <button
                type="button"
                role="tab"
                id="feed-massive-tq-tab-flat-trades"
                className={`feed-massive-agg-tab${tqSubTab === 'flat_trades' ? ' feed-massive-agg-tab--active' : ''}`}
                aria-selected={tqSubTab === 'flat_trades'}
                tabIndex={tqSubTab === 'flat_trades' ? 0 : -1}
                onClick={() => setTqSubTab('flat_trades')}
              >
                Trades (Flat Files)
                <span className="feed-massive-agg-tab-badge">File</span>
              </button>
            </div>

            <div className="feed-massive-agg-tab-panels">
              {/* --- Trades (REST DocPage, Developer) — tab order first --- */}
              {tqSubTab === 'hist_trades' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-tq-panel-hist-trades"
                  aria-labelledby="feed-massive-tq-tab-hist-trades"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Retrieve tick-level trade data for an options contract over a time range — price, size, exchange, conditions, and SIP timestamp.</p>
                    <p><strong>When to use:</strong> Granular trade analysis, building VWAP from ticks, verifying executions against the tape, or microstructure research.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/trades/&#123;optionsTicker&#125;</code></p>
                    {!massiveStatus?.trades_enabled ? (
                      <p className="feed-massive-tier-gate-notice">
                        <strong>Developer tier required.</strong> This endpoint requires <code>trades_enabled</code>. Your current configuration does not enable option trades.
                      </p>
                    ) : null}
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Options ticker</span>
                      <input
                        className="form-input"
                        value={tqHistTradesTicker}
                        onChange={e => setTqHistTradesTicker(e.target.value)}
                        disabled={tqHistTradesBusy || !configured || !massiveStatus?.trades_enabled}
                        placeholder="O:SPY251219C00600000"
                        autoComplete="off"
                      />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Timestamp (from, ns)</span>
                      <input className="form-input" value={tqHistTradesFrom} onChange={e => setTqHistTradesFrom(e.target.value)} disabled={tqHistTradesBusy || !configured || !massiveStatus?.trades_enabled} placeholder="optional" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Timestamp (to, ns)</span>
                      <input className="form-input" value={tqHistTradesTo} onChange={e => setTqHistTradesTo(e.target.value)} disabled={tqHistTradesBusy || !configured || !massiveStatus?.trades_enabled} placeholder="optional" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Limit</span>
                      <input className="form-input" value={tqHistTradesLimit} onChange={e => setTqHistTradesLimit(e.target.value)} disabled={tqHistTradesBusy || !configured || !massiveStatus?.trades_enabled} placeholder="100" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Sort</span>
                      <select className="form-input" value={tqHistTradesSort} onChange={e => setTqHistTradesSort(e.target.value as 'asc' | 'desc')} disabled={tqHistTradesBusy || !configured || !massiveStatus?.trades_enabled}>
                        <option value="asc">Ascending</option>
                        <option value="desc">Descending</option>
                      </select>
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={tqHistTradesBusy || !configured || !massiveStatus?.trades_enabled} onClick={() => runTqHistTrades()}>
                      {tqHistTradesBusy ? 'Fetching\u2026' : 'Fetch Trades'}
                    </button>
                  </div>
                  {tqHistTradesErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tqHistTradesErr}</p> : null}
                  {tqHistTradesResult ? (
                    <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                      <summary>
                        Result{Array.isArray(tqHistTradesResult.results) ? ` — ${tqHistTradesResult.results.length} trade(s)` : ''}
                      </summary>
                      <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '32rem' }}>
                        {JSON.stringify(tqHistTradesResult, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {/* --- Last Trade (REST, Starter) --- */}
              {tqSubTab === 'last_trade' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-tq-panel-last-trade"
                  aria-labelledby="feed-massive-tq-tab-last-trade"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Retrieve the most recent trade for a specific options contract — price, size, exchange, conditions, and SIP timestamp.</p>
                    <p><strong>When to use:</strong> Quick check of the latest execution for a contract before placing an order, confirming fills, or building real-time trade tickers.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v2/last/trade/&#123;optionsTicker&#125;</code></p>
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Options ticker</span>
                      <input
                        className="form-input"
                        value={tqLastTradeTicker}
                        onChange={e => setTqLastTradeTicker(e.target.value)}
                        disabled={tqLastTradeBusy || !configured}
                        placeholder="O:SPY251219C00600000"
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={tqLastTradeBusy || !configured} onClick={() => runTqLastTrade()}>
                      {tqLastTradeBusy ? 'Fetching\u2026' : 'Fetch Last Trade'}
                    </button>
                  </div>
                  {tqLastTradeErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tqLastTradeErr}</p> : null}
                  {tqLastTradeResult ? (
                    <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                      <summary>Result</summary>
                      <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '24rem' }}>
                        {JSON.stringify(tqLastTradeResult, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {/* --- Quotes (REST DocPage, Starter) --- */}
              {tqSubTab === 'hist_quotes' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-tq-panel-hist-quotes"
                  aria-labelledby="feed-massive-tq-tab-hist-quotes"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Retrieve historical NBBO quotes (best bid/ask) for an options contract over a time range with nanosecond timestamps.</p>
                    <p><strong>When to use:</strong> Analyzing bid-ask spread dynamics, measuring liquidity over time, backtesting fill-price assumptions, or auditing quote-level market microstructure.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>GET /v3/quotes/&#123;optionsTicker&#125;</code></p>
                  </div>
                  <div className="feed-massive-form-grid">
                    <label className="feed-massive-field">
                      <span className="form-label">Options ticker</span>
                      <input
                        className="form-input"
                        value={tqHistQuotesTicker}
                        onChange={e => setTqHistQuotesTicker(e.target.value)}
                        disabled={tqHistQuotesBusy || !configured}
                        placeholder="O:SPY251219C00600000"
                        autoComplete="off"
                      />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Timestamp (from, ns)</span>
                      <input className="form-input" value={tqHistQuotesFrom} onChange={e => setTqHistQuotesFrom(e.target.value)} disabled={tqHistQuotesBusy || !configured} placeholder="optional" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Timestamp (to, ns)</span>
                      <input className="form-input" value={tqHistQuotesTo} onChange={e => setTqHistQuotesTo(e.target.value)} disabled={tqHistQuotesBusy || !configured} placeholder="optional" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Limit</span>
                      <input className="form-input" value={tqHistQuotesLimit} onChange={e => setTqHistQuotesLimit(e.target.value)} disabled={tqHistQuotesBusy || !configured} placeholder="100" />
                    </label>
                    <label className="feed-massive-field">
                      <span className="form-label">Sort</span>
                      <select className="form-input" value={tqHistQuotesSort} onChange={e => setTqHistQuotesSort(e.target.value as 'asc' | 'desc')} disabled={tqHistQuotesBusy || !configured}>
                        <option value="asc">Ascending</option>
                        <option value="desc">Descending</option>
                      </select>
                    </label>
                  </div>
                  <div style={{ marginTop: 'var(--space-3)' }}>
                    <button type="button" className="btn btn-secondary" disabled={tqHistQuotesBusy || !configured} onClick={() => runTqHistQuotes()}>
                      {tqHistQuotesBusy ? 'Fetching\u2026' : 'Fetch Quotes'}
                    </button>
                  </div>
                  {tqHistQuotesErr ? <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>{tqHistQuotesErr}</p> : null}
                  {tqHistQuotesResult ? (
                    <details className="feed-massive-details-debug" open style={{ marginTop: 'var(--space-3)' }}>
                      <summary>
                        Result{Array.isArray(tqHistQuotesResult.results) ? ` — ${tqHistQuotesResult.results.length} quote(s)` : ''}
                      </summary>
                      <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '32rem' }}>
                        {JSON.stringify(tqHistQuotesResult, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              ) : null}

              {/* --- Quotes (Flat Files product; informational) --- */}
              {tqSubTab === 'flat_quotes' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-tq-panel-flat-quotes"
                  aria-labelledby="feed-massive-tq-tab-flat-quotes"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Download bulk top-of-book BBO quote data for all US options as flat files (S3). Files contain nanosecond-precision timestamps and are suitable for large-scale backtesting or data warehousing.</p>
                    <p><strong>When to use:</strong> Full-market historical quote research, building local quote databases, or any use case where REST pagination is too slow for the data volume needed.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>S3 flat file download — Options Quotes</code></p>
                    <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)' }}>
                      Flat file downloads are managed via the Polygon Files API or dashboard. This tab is informational — use the Polygon dashboard to access S3 download links for options quote files.
                    </p>
                  </div>
                </div>
              ) : null}

              {/* --- Trades (Flat Files product; informational) --- */}
              {tqSubTab === 'flat_trades' ? (
                <div
                  className="feed-massive-agg-tab-panel"
                  role="tabpanel"
                  id="feed-massive-tq-panel-flat-trades"
                  aria-labelledby="feed-massive-tq-tab-flat-trades"
                >
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Download bulk tick-level trade data for all US options as flat files (S3). Files contain nanosecond-precision timestamps, exchange codes, and trade conditions.</p>
                    <p><strong>When to use:</strong> Full-market historical trade research, VWAP computation across the entire options universe, or any use case requiring comprehensive trade tape data.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>S3 flat file download — Options Trades</code></p>
                    {!massiveStatus?.trades_enabled ? (
                      <p className="feed-massive-tier-gate-notice">
                        <strong>Developer tier likely required.</strong> Trades flat files may not be available on Starter plans.
                      </p>
                    ) : null}
                    <p style={{ marginTop: 'var(--space-2)', color: 'var(--text-muted)' }}>
                      Flat file downloads are managed via the Polygon Files API or dashboard. This tab is informational — use the Polygon dashboard to access S3 download links for options trade files.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </FeedMassiveCapabilityPanel>
        </>
        ) : null}

            </div>
          ) : null}

          {channelTab === 'ws' ? (
            <div
              className="feed-massive-delivery-panel"
              role="tabpanel"
              id="feed-massive-group-ws"
              aria-labelledby="feed-massive-delivery-tab-ws"
            >
            <div className="feed-massive-delivery-tablist" role="tablist" aria-label="WebSocket sections">
              {OPTION_WS_SECTION_ORDER.map(sid => (
                <button
                  key={sid}
                  type="button"
                  role="tab"
                  id={`feed-massive-ws-subtab-${sid}`}
                  className={`feed-massive-delivery-tab${deliveryWsSubTab === sid ? ' feed-massive-delivery-tab--active' : ''}`}
                  aria-selected={deliveryWsSubTab === sid}
                  tabIndex={deliveryWsSubTab === sid ? 0 : -1}
                  onClick={() => setDeliveryWsSubTab(sid)}
                >
                  {OPTION_WS_SECTION_LABELS[sid]}
                </button>
              ))}
            </div>

        {deliveryWsSubTab === 'ws-aggregates-s' ? (
        <FeedMassiveCapabilityPanel
          capId="ws-aggregates-s"
          checklistRow={rWsAggS}
          effectiveStatus={effWsAggS}
          expanded={capExpanded['ws-aggregates-s'] === true}
          onToggle={() => toggleCap('ws-aggregates-s')}
          highlight={highlightedCapabilityId === 'ws-aggregates-s'}
          ariaLabel="Aggregates (Per Second)"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effWsAggS}
            checklistRow={rWsAggS}
            evidence="Copy command to verify channel A.O"
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden><CardIconBars /></span>
                <h3>Aggregates (Per Second)</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">Stream per-second OHLCV bars for one options contract.</p>
            <p className="feed-massive-agg-sub-endpoint"><code>WS channel: A.O:&#123;optionsTicker&#125;</code></p>
            <div className="feed-massive-ws-cmd-row">
              <code className="feed-massive-ws-cmd">python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --channel &quot;A.O:SPY251219C00600000&quot;</code>
              <button type="button" className="btn btn-xs btn-secondary" onClick={() => copyWsCommand('A.O:SPY251219C00600000')}>
                {wsCopied === 'A.O:SPY251219C00600000' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </FeedMassiveServiceBlock>
        </FeedMassiveCapabilityPanel>
        ) : null}

        {deliveryWsSubTab === 'ws-aggregates-m' ? (
        <FeedMassiveCapabilityPanel
          capId="ws-aggregates-m"
          checklistRow={rWsAggM}
          effectiveStatus={effWsAggM}
          expanded={capExpanded['ws-aggregates-m'] === true}
          onToggle={() => toggleCap('ws-aggregates-m')}
          highlight={highlightedCapabilityId === 'ws-aggregates-m'}
          ariaLabel="Aggregates (Per Minute)"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effWsAggM}
            checklistRow={rWsAggM}
            evidence="Copy command to verify channel AM.O"
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden><CardIconBars /></span>
                <h3>Aggregates (Per Minute)</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">Stream per-minute OHLCV bars for one options contract.</p>
            <p className="feed-massive-agg-sub-endpoint"><code>WS channel: AM.O:&#123;optionsTicker&#125;</code></p>
            <div className="feed-massive-ws-cmd-row">
              <code className="feed-massive-ws-cmd">python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --channel &quot;AM.O:SPY251219C00600000&quot;</code>
              <button type="button" className="btn btn-xs btn-secondary" onClick={() => copyWsCommand('AM.O:SPY251219C00600000')}>
                {wsCopied === 'AM.O:SPY251219C00600000' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </FeedMassiveServiceBlock>
        </FeedMassiveCapabilityPanel>
        ) : null}

        {deliveryWsSubTab === 'ws-quotes' ? (
        <FeedMassiveCapabilityPanel
          capId="ws-quotes"
          checklistRow={rWsQuotes}
          effectiveStatus={effWsQuotes}
          expanded={capExpanded['ws-quotes'] === true}
          onToggle={() => toggleCap('ws-quotes')}
          highlight={highlightedCapabilityId === 'ws-quotes'}
          ariaLabel="Quotes"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effWsQuotes}
            checklistRow={rWsQuotes}
            evidence="Copy command to verify channel Q.O"
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden><CardIconTrades /></span>
                <h3>Quotes</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">Stream BBO quote updates for one options contract.</p>
            <p className="feed-massive-agg-sub-endpoint"><code>WS channel: Q.O:&#123;optionsTicker&#125;</code></p>
            <div className="feed-massive-ws-cmd-row">
              <code className="feed-massive-ws-cmd">python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --channel &quot;Q.O:SPY251219C00600000&quot;</code>
              <button type="button" className="btn btn-xs btn-secondary" onClick={() => copyWsCommand('Q.O:SPY251219C00600000')}>
                {wsCopied === 'Q.O:SPY251219C00600000' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </FeedMassiveServiceBlock>
        </FeedMassiveCapabilityPanel>
        ) : null}

        {deliveryWsSubTab === 'ws-trades' ? (
        <FeedMassiveCapabilityPanel
          capId="ws-trades"
          checklistRow={rWsTrades}
          effectiveStatus={effWsTrades}
          expanded={capExpanded['ws-trades'] === true}
          onToggle={() => toggleCap('ws-trades')}
          highlight={highlightedCapabilityId === 'ws-trades'}
          ariaLabel="Trades"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effWsTrades}
            checklistRow={rWsTrades}
            evidence="Copy command to verify channel T.O"
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden><CardIconTrades /></span>
                <h3>Trades</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">Stream tick-by-tick trade prints for one options contract.</p>
            <p className="feed-massive-agg-sub-endpoint"><code>WS channel: T.O:&#123;optionsTicker&#125;</code></p>
            {!massiveStatus?.trades_enabled ? (
              <div className="feed-massive-tier-gate-notice">Developer tier required for T.O channel access.</div>
            ) : null}
            <div className="feed-massive-ws-cmd-row">
              <code className="feed-massive-ws-cmd">python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --channel &quot;T.O:SPY251219C00600000&quot;</code>
              <button type="button" className="btn btn-xs btn-secondary" onClick={() => copyWsCommand('T.O:SPY251219C00600000')}>
                {wsCopied === 'T.O:SPY251219C00600000' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </FeedMassiveServiceBlock>
        </FeedMassiveCapabilityPanel>
        ) : null}

        {deliveryWsSubTab === 'fmv' ? (
        <FeedMassiveCapabilityPanel
          capId="fmv"
          checklistRow={rFmv}
          effectiveStatus={effFmv}
          expanded={capExpanded.fmv === true}
          onToggle={() => toggleCap('fmv')}
          highlight={highlightedCapabilityId === 'fmv'}
          ariaLabel="Fair Market Value"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effFmv}
            checklistRow={rFmv}
            evidence={fmvEvidence}
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconFmv />
                </span>
                <h3>Fair Market Value</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Real-time fair market value estimates for option contracts via Massive WebSocket.
              FMV provides a consolidated price reflecting the best available fair value. Requires Business tier.
            </p>
          </FeedMassiveServiceBlock>

          <div className="feed-massive-agg-tabs-wrap">
            <div className="feed-massive-agg-tabs" role="tablist">
              {([
                { key: 'ws-fmv' as const, label: 'WS FMV Channel', badge: 'WS' },
                { key: 'tier-delivery' as const, label: 'Tier & Delivery', badge: 'Info' },
              ]).map(t => (
                <button
                  key={t.key}
                  role="tab"
                  aria-selected={fmvSubTab === t.key}
                  className={`feed-massive-agg-tab${fmvSubTab === t.key ? ' active' : ''}`}
                  onClick={() => setFmvSubTab(t.key)}
                >
                  {t.label}
                  <span className="feed-massive-agg-tab-badge">{t.badge}</span>
                </button>
              ))}
            </div>

            <div className="feed-massive-agg-tab-panels">
              <div className="feed-massive-agg-tab-panel" role="tabpanel">
                {fmvSubTab === 'ws-fmv' ? (
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Use case:</strong> Stream real-time fair market value (FMV) estimates for a specific option contract. FMV consolidates bid/ask information into a single fair value price, useful for mark-to-market, risk monitoring, and order placement decisions.</p>
                    <p style={{ fontSize: '0.78rem', opacity: 0.75, marginTop: 'var(--space-1)' }}><strong>When to use:</strong> Subscribe during market hours for live FMV updates. Ideal for real-time portfolio valuation and automated trading systems that need a single reference price.</p>
                    <p className="feed-massive-agg-sub-endpoint"><code>WS: wss://socket.polygon.io/options → FMV.O:&#123;optionsTicker&#125;</code></p>
                    <div className="feed-massive-tier-gate-notice">
                      Business tier required for FMV channel access.
                    </div>
                    <div style={{ marginTop: 'var(--space-3)' }}>
                      <label className="feed-massive-field" style={{ maxWidth: '26rem' }}>
                        <span className="form-label">Options ticker (for verify command)</span>
                        <input
                          className="form-input"
                          value={fmvTicker}
                          onChange={e => setFmvTicker(e.target.value)}
                          placeholder="O:SPY251219C00600000"
                          autoComplete="off"
                        />
                      </label>
                    </div>
                    <div style={{ marginTop: 'var(--space-2)' }}>
                      <div className="feed-massive-ws-sub-block">
                        <pre className="feed-massive-ws-cmd">{`python scripts/verify_massive_options_ws.py --config config/config.dev.yaml --channel "FMV.${fmvTicker.trim() || 'O:SPY251219C00600000'}"`}</pre>
                        <button
                          type="button"
                          className="btn btn-xs btn-secondary"
                          aria-label="Copy WebSocket verify command for FMV"
                          onClick={() => copyWsCommand(`FMV.${fmvTicker.trim() || 'O:SPY251219C00600000'}`)}
                        >
                          {wsCopied === `FMV.${fmvTicker.trim() || 'O:SPY251219C00600000'}` ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="feed-massive-agg-sub-doc">
                    <p><strong>Tier requirement:</strong> The FMV WebSocket channel (<code>FMV.O:*</code>) is available exclusively on the <strong>Business</strong> tier. Starter and Developer plans do not include FMV access.</p>
                    <p style={{ marginTop: 'var(--space-2)' }}><strong>Delivery semantics:</strong> FMV messages are pushed in real-time via the Polygon Options WebSocket. Each message contains a fair market value estimate computed from the current order book. During market hours, expect updates as order book conditions change.</p>
                    <p style={{ marginTop: 'var(--space-2)' }}><strong>Latency:</strong> Business tier provides real-time WebSocket delivery with no artificial delay. FMV values reflect the latest available market data at the time of computation.</p>
                    <p style={{ marginTop: 'var(--space-2)' }}><strong>Engine integration:</strong> The current project provides a verification entry point (CLI script). No persistent FMV bridge or database persistence is implemented — FMV data is consumed ephemerally via the verify script.</p>
                    <div className="feed-massive-tier-gate-notice" style={{ marginTop: 'var(--space-3)' }}>
                      Business tier required. Current plan does not include FMV entitlement.
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </FeedMassiveCapabilityPanel>
        ) : null}

        {deliveryWsSubTab === 'websocket' ? (
        <FeedMassiveCapabilityPanel
          capId="websocket"
          checklistRow={rWs}
          effectiveStatus={effWs}
          expanded={capExpanded.websocket === true}
          onToggle={() => toggleCap('websocket')}
          highlight={highlightedCapabilityId === 'websocket'}
          ariaLabel="Connectivity verification"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effWs}
            checklistRow={rWs}
            evidence={
              configured
                ? 'API key configured. Proof is via CLI (see Test); browser does not open a WS.'
                : 'Configure Massive API key first.'
            }
            testArea={
              <div>
                <pre className="feed-massive-ws-cmd">{WS_VERIFY_CMD}</pre>
                <button type="button" className="btn btn-secondary" onClick={() => copyWsCommand()}>
                  Copy command
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <h3>WebSocket streaming</h3>
            </div>
            <p className="feed-massive-card-lead">
              Verify connectivity with the standalone script (delayed/real-time host per plan). No persistent bridge in this app.
            </p>
          </FeedMassiveServiceBlock>
        </FeedMassiveCapabilityPanel>
        ) : null}

            </div>
          ) : null}

          {channelTab === 'flat' ? (
            <div
              className="feed-massive-delivery-panel"
              role="tabpanel"
              id="feed-massive-group-flat"
              aria-labelledby="feed-massive-delivery-tab-flat"
            >
            <div className="feed-massive-delivery-tablist" role="tablist" aria-label="Flat Files sections">
              {flatFileRows.map(row => (
                <button
                  key={row.id}
                  type="button"
                  role="tab"
                  id={`feed-massive-flat-subtab-${row.id}`}
                  className={`feed-massive-delivery-tab${deliveryFlatSubTab === row.id ? ' feed-massive-delivery-tab--active' : ''}`}
                  aria-selected={deliveryFlatSubTab === row.id}
                  tabIndex={deliveryFlatSubTab === row.id ? 0 : -1}
                  onClick={() => setDeliveryFlatSubTab(row.id)}
                >
                  {row.service}
                </button>
              ))}
            </div>
        {flatPanelRow ? (
            <FeedMassiveCapabilityPanel
              capId={flatPanelRow.id}
              checklistRow={flatPanelRow}
              effectiveStatus={flatFileEffMap[flatPanelRow.id] ?? flatPanelRow.projectStatus}
              expanded={capExpanded[flatPanelRow.id] === true}
              onToggle={() => toggleCap(flatPanelRow.id)}
              highlight={highlightedCapabilityId === flatPanelRow.id}
              ariaLabel={flatPanelRow.service}
            >
              <FeedMassiveServiceBlock
                effectiveStatus={flatFileEffMap[flatPanelRow.id] ?? flatPanelRow.projectStatus}
                checklistRow={flatPanelRow}
                evidence={flatPanelRow.projectStatus === 'not-implemented'
                  ? 'Not yet integrated. S3 flat file download is available from Massive directly.'
                  : 'Flat file access configured.'}
              >
                <div className="feed-massive-card-head">
                  <h3>{flatPanelRow.service}</h3>
                </div>
                <p className="feed-massive-card-lead">{flatPanelRow.description}</p>
                <p className="feed-massive-flat-delivery-note">
                  <strong>Delivery:</strong> S3 bulk download. Files cover all US options for a given date.
                  See <a className="feed-massive-flat-doc-link" href="https://polygon.io/flat-files" target="_blank" rel="noopener noreferrer">Massive flat file documentation</a> for access details.
                </p>
                {flatPanelRow.tierMin !== 'starter' ? (
                  <div className="feed-massive-tier-gate-notice">
                    {flatPanelRow.tierMin === 'developer' ? 'Developer' : 'Business'} tier required.
                  </div>
                ) : null}
              </FeedMassiveServiceBlock>
            </FeedMassiveCapabilityPanel>
        ) : null}

            </div>
          ) : null}
        </div>

        <h3 className="feed-massive-group-header" id="feed-massive-group-project">Project</h3>

        {/* Reference / contracts */}
        <FeedMassiveCapabilityPanel
          capId="reference"
          checklistRow={rRef}
          effectiveStatus={effRef}
          expanded={capExpanded.reference === true}
          onToggle={() => toggleCap('reference')}
          highlight={highlightedCapabilityId === 'reference'}
          ariaLabel="Reference contracts"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effRef}
            checklistRow={rRef}
            evidence={refTestMsg ?? (configured ? 'Run Test to fetch expirations via Massive REST.' : 'Configure Massive API key first.')}
            testArea={
              <div className="feed-massive-inline-actions" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
                <label className="feed-massive-field">
                  <span className="form-label">Symbol</span>
                  <input
                    className="form-input"
                    value={refSymbol}
                    onChange={e => setRefSymbol(e.target.value)}
                    disabled={refTestBusy || !configured}
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={refTestBusy || !configured}
                  onClick={() => runRefExpirationsTest()}
                >
                  {refTestBusy ? 'Running…' : 'Run expirations test'}
                </button>
                {onGoToScreener ? (
                  <button type="button" className="btn btn-secondary" onClick={onGoToScreener}>
                    Open Option Discovery
                  </button>
                ) : null}
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <h3>Reference / contracts</h3>
            </div>
            <p className="feed-massive-card-lead">
              Massive-backed expirations and strikes (same API as Research → Option Discovery when using Massive).
              Read-only: no rows are written to PostgreSQL (
              <code style={{ fontSize: '0.85em' }}>option_snapshots</code> or other tables). After a successful run,
              expand <strong>Expirations</strong> and <strong>Strikes</strong> below for the full lists.
            </p>
            {refTestExpirations.length > 0 || refTestStrikes.length > 0 ? (
              <div className="feed-massive-ref-lists">
                {refTestExpirations.length > 0 ? (
                  <details className="feed-massive-details-debug" open>
                    <summary>Expirations ({refTestExpirations.length})</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0}>
                      {refTestExpirations.join('\n')}
                    </pre>
                  </details>
                ) : null}
                {refTestStrikes.length > 0 ? (
                  <details className="feed-massive-details-debug" open>
                    <summary>Strikes ({refTestStrikes.length})</summary>
                    <pre className="feed-massive-pre-json" tabIndex={0}>
                      {refTestStrikes.map(s => String(s)).join('\n')}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}
            {refTestDebug ? (
              <div className="feed-massive-ref-debug" style={{ marginTop: 'var(--space-3)' }}>
                <details className="feed-massive-details-debug">
                  <summary>
                    Contract samples ({refTestDebug.contract_samples.length}
                    {refTestDebug.contract_samples_truncated ? ', truncated' : ''})
                  </summary>
                  <pre
                    className="feed-massive-pre-json"
                    tabIndex={0}
                  >
                    {JSON.stringify(refTestDebug.contract_samples, null, 2)}
                  </pre>
                </details>
                <details className="feed-massive-details-debug">
                  <summary>Raw requests and responses ({refTestDebug.pages.length} page(s))</summary>
                  <pre
                    className="feed-massive-pre-json"
                    tabIndex={0}
                  >
                    {JSON.stringify(refTestDebug.pages, null, 2)}
                  </pre>
                </details>
              </div>
            ) : null}
          </FeedMassiveServiceBlock>
        </FeedMassiveCapabilityPanel>

        {/* Greeks / IV migrated to Data Coverage → Option (OptionCoveragePage) */}

        {/* Daily open interest */}
        <FeedMassiveCapabilityPanel
          capId="daily-oi"
          checklistRow={rOi}
          effectiveStatus={effOi}
          expanded={capExpanded['daily-oi'] === true}
          onToggle={() => toggleCap('daily-oi')}
          highlight={highlightedCapabilityId === 'daily-oi'}
          ariaLabel="Open interest"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effOi}
            checklistRow={rOi}
            evidence={oiFetchMsg ?? jobEvidenceLine(latestJobForKind(jobs, 'oi'))}
            testArea={
              <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="feed-massive-field">
                  <span className="form-label">Symbol</span>
                  <input
                    className="form-input"
                    value={oiFetchSym}
                    onChange={e => setOiFetchSym(e.target.value)}
                    disabled={oiFetchBusy}
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="btn btn-secondary" disabled={oiFetchBusy} onClick={() => runOiApiFetch()}>
                  {oiFetchBusy ? 'Loading…' : 'GET option-oi'}
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconOi />
                </span>
                <h3>Open interest</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Placeholder job; prefer chain snapshot for OI when available. Use GET option-oi to read stored daily OI rows.
            </p>
          </FeedMassiveServiceBlock>
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
        </FeedMassiveCapabilityPanel>

        {/* Corporate actions */}
        <FeedMassiveCapabilityPanel
          capId="corporate-actions"
          checklistRow={rCorp}
          effectiveStatus={effCorp}
          expanded={capExpanded['corporate-actions'] === true}
          onToggle={() => toggleCap('corporate-actions')}
          highlight={highlightedCapabilityId === 'corporate-actions'}
          ariaLabel="Corporate actions"
        >
          <FeedMassiveServiceBlock
            effectiveStatus={effCorp}
            checklistRow={rCorp}
            evidence={
              corpRows.length > 0
                ? `${corpRows.length} row(s) loaded from DB for current query. ${jobEvidenceLine(latestJobForKind(jobs, 'corporate_action'))}`
                : jobEvidenceLine(latestJobForKind(jobs, 'corporate_action'))
            }
            testArea={
              <div className="feed-massive-inline-actions" style={{ alignItems: 'flex-end', flexWrap: 'wrap' }}>
                <label className="feed-massive-field">
                  <span className="form-label">Underlying</span>
                  <input
                    className="form-input"
                    value={corpSymbol}
                    onChange={e => setCorpSymbol(e.target.value)}
                    disabled={corpBusy || !configured}
                    autoComplete="off"
                  />
                </label>
                <button type="button" className="btn btn-secondary" disabled={corpBusy || !configured} onClick={() => runCorpAction()}>
                  {corpBusy ? 'Running…' : 'Enqueue sync'}
                </button>
                <button type="button" className="btn btn-primary" disabled={corpDbLoading} onClick={() => loadCorpFromDb()}>
                  {corpDbLoading ? 'Loading…' : 'Load from DB'}
                </button>
              </div>
            }
          >
            <div className="feed-massive-card-head">
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <span className="feed-massive-card-icon" aria-hidden>
                  <CardIconCorpAction />
                </span>
                <h3>Corporate actions</h3>
              </div>
            </div>
            <p className="feed-massive-card-lead">
              Dividends and stock splits via Massive REST. Enter a stock ticker, sync from API, then load persisted rows from PostgreSQL.
            </p>
          </FeedMassiveServiceBlock>
          {corpErr ? (
            <p className="status-page-msg err" role="alert" style={{ marginTop: 'var(--space-3)' }}>
              {corpErr}
            </p>
          ) : null}
          {corpRows.length > 0 ? (
            <div className="feed-massive-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Symbol</th>
                    <th scope="col">Type</th>
                    <th scope="col">Ex date</th>
                    <th scope="col">Amount</th>
                    <th scope="col">Ratio</th>
                    <th scope="col">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {corpRows.map((r, i) => (
                    <tr key={`${r.symbol}-${r.action_type}-${r.ex_date}-${i}`}>
                      <td>{r.symbol}</td>
                      <td><span className={r.action_type === 'dividend' ? 'feed-massive-badge feed-massive-badge--done' : 'feed-massive-badge feed-massive-badge--run'}>{r.action_type}</span></td>
                      <td>{r.ex_date ?? '—'}</td>
                      <td>{r.amount != null ? r.amount.toFixed(4) : '—'}</td>
                      <td>{r.ratio_from != null && r.ratio_to != null ? `${r.ratio_from}:${r.ratio_to}` : '—'}</td>
                      <td style={{ maxWidth: '14rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.description ?? undefined}>
                        {r.description ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </FeedMassiveCapabilityPanel>

      </div>
    </div>
  )
}
