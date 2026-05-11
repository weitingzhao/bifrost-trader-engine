import { useEffect, useState, useCallback, useMemo, useRef, Fragment, type RefObject } from 'react'
import type { IbAccountSnapshot, StatusResponse, Operation, RealtimeQuote, SystemMessage } from './types'
import {
  fetchStatus,
  fetchOperations,
  fetchHealth,
  postRefreshAccounts,
  fetchQuotes,
  subscribeQuotes,
  fetchBarsBenchmark,
  fetchSystemMessages,
  subscribeSystemMessages,
} from './api'
import { postMonitorStop } from './api/monitor/monitor'
import { fetchOpsWorkers, fetchQueueSummary } from './api/ops/ops'
import { celeryMetricsFromStatus } from './pages/status/celeryMetrics'
import {
  celeryQueuePendingBadgeTotal,
  computeCeleryRuntimeLamp,
  supportedQueueNamesFromSummary,
} from './utils/celeryRuntime'
import { LivePage } from './pages/LivePage'
import { AccountsPage } from './pages/AccountsPage'
import { OptionScreenerPage } from './pages/OptionScreenerPage'
import { StockScreenerPage } from './pages/StockScreenerPage'
import { StockDataReadinessPage } from './pages/StockDataReadinessPage'
import { PositionsPage } from './pages/PositionsPage'
import { TradeHistoryPage } from './pages/TradeHistoryPage'
import type { PortfolioView } from './pages/portfolio/types'
import { PerformancePage } from './pages/PerformancePage'
import { ResearchRiskAnalysisPage } from './pages/ResearchRiskAnalysisPage'
import { SettingsPage } from './pages/SettingsPage'
import { TransferPayPage } from './pages/TransferPayPage'
import { ModelAnalysisPage } from './pages/ModelAnalysisPage'
import { BacktestPage } from './pages/BacktestPage'
import { OptionDiscoveryPage } from './pages/OptionDiscoveryPage'
import OptionGreeksPage from './pages/OptionGreeksPage'
import { StrategyStructurePage } from './pages/StrategyStructurePage'
import { StrategyOpportunityPage } from './pages/StrategyOpportunityPage'
import { StrategyInstancesPage } from './pages/StrategyInstancesPage'
import { StrategyWinRatePage } from './pages/StrategyWinRatePage'
import { StrategyAllocationPage } from './pages/StrategyAllocationPage'
import { GatesConfigPage } from './pages/GatesConfigPage'
import { StructureTypeConfigPage } from './pages/StructureTypeConfigPage'
import { WatchlistPage } from './pages/WatchlistPage'
import { MainTabIcon, SubmenuIcon, NavGroupDivider, type TabId, type TabGroup } from './components/AppNavIcons'
import { UI_BUILD_LABEL } from './uiBuildLabel'
import { useSettingsApiHealthProbes } from './hooks/useSettingsApiHealthProbes'
import { useSocketIngestProbe } from './hooks/useSocketIngestProbe'
import { MessageCenter, type MessageCenterHandle } from './components/MessageCenter'
import { isMassiveCommonFeedHash, isMassiveOverviewFeedHash } from './pages/massive/feedMassiveCommonTabUtils'
import { FEED_MASSIVE_DAILY_DATA_ID, isMassiveOptionFeedHash } from './pages/massive/feedMassiveTabUtils'
import { isMassiveStockFeedHash } from './pages/massive/feedMassiveStockTabUtils'
import { SettingsSidebarLampGlyph } from './pages/settings/settingsSidebarLampGlyphs'
import type { SettingsSidebarLampGlyphId } from './pages/settings/settingsSidebarLampGlyphs'
import {
  COVERAGE_OVERVIEW_SUBSECTION,
  COVERAGE_OVERVIEW_GROUP_LABEL,
  COVERAGE_OVERVIEW_LEGACY_ID,
  COVERAGE_OVERVIEW_SUBSECTIONS,
  COVERAGE_OVERVIEW_SUMMARY_ID,
  COVERAGE_OPTION_SUBSECTION,
  COVERAGE_STOCK_GROUP_LABEL,
  COVERAGE_STOCK_SUBSECTIONS,
  FEED_MASSIVE_COMMON_ID,
  FEED_MASSIVE_OPTION_ID,
  FEED_MASSIVE_OVERVIEW_ID,
  FEED_MASSIVE_STOCK_ID,
  FEED_SUBSECTIONS,
} from './pages/settings/settingsConstants'
import { SettingsSectionIcon } from './pages/settings/SettingsSectionIcon'
import logoImg from '../img/logo.png'
import { fmtPctCompact, fmtUsdCompact } from './utils/format'
import {
  IB_CONNECTION_MSG_AUTO_DISMISS_SEC,
  IB_OPERATOR_COMMAND_LIFETIME_SEC,
  SYSTEM_MESSAGE_BACKEND_TTL_SEC,
  isIbOperatorCommandMessage,
} from './utils/systemMessageLifecycle'
import { aggregateDaemonProcessesHealthFromStatus } from './utils/socketIngestLamp'
import {
  computeAccountSyncLamp,
  computeLiveNavLamp,
  computeMarketStreamsOk,
  computeOpenOrdersSectionOk,
} from './utils/livePageLamps'
import {
  computeDailyChange,
  mergeQuotesIntoSymbolMap,
  normalizeBenchmarkMap,
  quoteDisplayLast,
  type DailyBenchmark,
} from './pages/accounts/accountsUtils'
import './App.css'
import './styles/settings-celery.css'
import './styles/data-readiness.css'

const THEME_KEY = 'bifrost-monitor-theme'
const SYSTEM_MESSAGE_BOOTSTRAP_LIMIT = 50

/** Header ⋮ → Docs: MkDocs handbook (not Monitor /docs). Dev: `python scripts/run_mkdocs.py`. Prod: static `/mkdocs/` after `./scripts/bifrost_ssh.sh --deploy-mkdocs`. */
function mkdocsHandbookHref(): string {
  const explicit = import.meta.env.VITE_MKDOCS_URL?.trim()
  if (explicit) return explicit
  if (import.meta.env.DEV) return 'http://127.0.0.1:8000/'
  return '/mkdocs/'
}

type StreamTone = 'neutral' | 'positive' | 'negative'

interface StreamSummaryItem {
  label: string
  value: string
  tone: StreamTone
}

function mergeSystemMessages(prev: SystemMessage[], incoming: SystemMessage[]): SystemMessage[] {
  const deduped = new Map<string, SystemMessage>()
  // incoming first, prev later → prev wins on duplicate IDs (stable existing state)
  for (const message of [...incoming, ...prev]) {
    if (!message || typeof message.message_id !== 'string' || !message.message_id) continue
    deduped.set(message.message_id, message)
  }
  const cutoff = Date.now() / 1000 - SYSTEM_MESSAGE_BACKEND_TTL_SEC
  return Array.from(deduped.values())
    .filter((m) => Number(m.occurred_at || 0) > cutoff)
    .sort((a, b) => Number(b.occurred_at || 0) - Number(a.occurred_at || 0))
}

/** Dashboard strip: Open orders summary + Market Streams marquee. */
function DashboardStrip({
  streamLamp,
  streamItems,
  onStreamClick,
  openOrderCount,
  onOpenOrdersClick,
  openOrdersLamp,
  openOrdersLampTitle,
}: {
  streamLamp: 'green' | 'yellow' | 'red' | 'none'
  streamItems: StreamSummaryItem[]
  onStreamClick?: () => void
  openOrderCount: number
  onOpenOrdersClick?: () => void
  /** Lamp shown before "Open orders" (e.g. green when there are orders). */
  openOrdersLamp?: 'green' | 'yellow' | 'red' | 'none'
  /** Tooltip for the lamp (Account Sync drives DB open orders). */
  openOrdersLampTitle?: string
}) {
  const tickerItems =
    streamItems.length > 0
      ? [...streamItems, ...streamItems]
      : [
          { label: 'Streams', value: 'No data', tone: 'neutral' as const },
          { label: 'Streams', value: 'No data', tone: 'neutral' as const },
        ]

  return (
    <section className="card dashboard-strip" aria-label="Dashboard">
      <div className="dashboard-strip-grid">
        <div className="dashboard-open-orders-cluster" aria-label="Open orders summary">
          <button
            type="button"
            className="dashboard-open-orders-btn"
            onClick={onOpenOrdersClick}
            aria-label="Open orders"
            title="View open orders on Live page"
          >
            {openOrdersLamp != null && (
              <span
                className={`lamp-icon ${openOrdersLamp}`}
                aria-hidden
                title={
                  openOrdersLampTitle != null && openOrdersLampTitle !== ''
                    ? openOrdersLampTitle
                    : openOrdersLamp === 'green'
                      ? 'Open orders: Account Sync Daemon healthy (DB sync).'
                      : 'Open orders: Account Sync Daemon degraded or unknown.'
                }
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
                </svg>
              </span>
            )}
            <span className="dashboard-open-orders-label">Open orders</span>
            <span className="dashboard-open-orders-value">{openOrderCount}</span>
          </button>
        </div>
        <div className="dashboard-streams-cluster" aria-label="Market streams summary">
          <button
            type="button"
            className="dashboard-streams-inline dashboard-streams-btn"
            onClick={onStreamClick}
            aria-label="Go to Live page"
            title="Go to Live page"
          >
            <span className={`lamp-icon ${streamLamp}`} aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 12h-4l-3 9L9 3 6 12H2" />
              </svg>
            </span>
            <div className="dashboard-streams-marquee">
              <div className="dashboard-streams-track">
                {tickerItems.map((item, index) => (
                  <span key={`${item.label}-${item.value}-${index}`} className="dashboard-streams-item">
                    <span className="dashboard-streams-item-label">{item.label}</span>
                    <span className={`dashboard-streams-item-value tone-${item.tone}`}>{item.value}</span>
                  </span>
                ))}
              </div>
            </div>
          </button>
        </div>
      </div>
    </section>
  )
}
type ThemeId = 'dark' | 'light'

function loadTheme(): ThemeId {
  try {
    const t = localStorage.getItem(THEME_KEY)
    if (t === 'light' || t === 'dark') return t
  } catch {}
  return 'light'
}

function applyTheme(theme: ThemeId) {
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : '')
}

const APP_DOC_TITLE = 'Bifrost Trader'

function appDocumentTitle(configProfile: string | undefined | null): string {
  if (configProfile === 'dev') return `${APP_DOC_TITLE} (Dev)`
  if (configProfile === 'prod') return `${APP_DOC_TITLE} (Prod)`
  return APP_DOC_TITLE
}

function appFaviconHref(configProfile: string | undefined | null): string {
  // Production is served by FastAPI: only `/favicon.svg` is routed; it returns the correct SVG by server
  // config_profile. `/favicon-dev.svg` and `/favicon-prod.svg` are not exposed as URLs — linking to them 404s.
  if (import.meta.env.PROD) {
    return '/favicon.svg'
  }
  if (configProfile === 'dev') return '/favicon-dev.svg'
  if (configProfile === 'prod') return '/favicon-prod.svg'
  return '/favicon.svg'
}

/** Tab title + favicon from status server profile (config.dev.yaml / config.prod.yaml). */
function applyAppChrome(configProfile: string | undefined | null) {
  document.title = appDocumentTitle(configProfile)
  const href = appFaviconHref(configProfile)
  const link =
    document.querySelector<HTMLLinkElement>('link[rel="icon"]') ??
    document.querySelector<HTMLLinkElement>('link[rel="shortcut icon"]')
  if (link) {
    link.href = href
    link.type = 'image/svg+xml'
  }
}

/** Header API pills: same glyphs and lamp rules as Settings → API sidebar. */
const HEADER_API_SHORTCUTS: {
  hash: string
  glyph: SettingsSidebarLampGlyphId
  title: string
  /** Short label for the ⋮ menu (header uses icon-only buttons). */
  menuLabel: string
  lampPicker: 'architecture' | 'account' | 'research' | 'massive'
}[] = [
  {
    hash: '#settings-api-architecture',
    glyph: 'api-architecture',
    title: 'Settings → API → Architecture',
    menuLabel: 'Architecture',
    lampPicker: 'architecture',
  },
  {
    hash: '#settings-api-account',
    glyph: 'api-account',
    title: 'Settings → API → Account',
    menuLabel: 'Account',
    lampPicker: 'account',
  },
  {
    hash: '#settings-api-research',
    glyph: 'api-research',
    title: 'Settings → API → Research',
    menuLabel: 'Research',
    lampPicker: 'research',
  },
  {
    hash: '#settings-api-massive',
    glyph: 'api-massive',
    title: 'Settings → API → Massive',
    menuLabel: 'Massive',
    lampPicker: 'massive',
  },
]

function headerApiShortcutLampClass(lamp: 'green' | 'yellow' | 'red' | 'none' | 'gray'): string {
  return `title-inline-lamp lamp-icon ${lamp === 'none' ? 'none' : lamp}`
}

function settingsHashKey(hash: string): string {
  return (hash.startsWith('#') ? hash.slice(1) : hash).trim()
}

function isDaemonSettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'settings-daemon' || h === 'settings-system' || h === 'settings-system-daemon'
}

function isSocketSettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return (
    h === 'settings-ws-connector' ||
    h === 'settings-market-ingest' ||
    h === 'settings-ib-connector' ||
    h === 'settings-ws-agent'
  )
}

function isCelerySettingsHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'settings-celery' || h === 'settings-system-celery' || h === 'settings-dashboard-celery'
}

function isCoverageOverviewHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return (
    h === COVERAGE_OVERVIEW_LEGACY_ID ||
    COVERAGE_OVERVIEW_SUBSECTIONS.some(s => s.id === h)
  )
}

function isCoverageOptionHash(hash: string): boolean {
  const h = settingsHashKey(hash)
  return h === 'coverage-option' || h === FEED_MASSIVE_DAILY_DATA_ID
}

type LampId = 'green' | 'yellow' | 'red' | 'none'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('live')
  const [quickCtrlMsg, setQuickCtrlMsg] = useState({ text: '', isErr: false })
  const [systemMessages, setSystemMessages] = useState<SystemMessage[]>([])
  const [urlHash, setUrlHash] = useState(() => (typeof window !== 'undefined' ? window.location.hash : ''))
  const [portfolioView, setPortfolioView] = useState<PortfolioView>('accounts')
  const [researchView, setResearchView] = useState<
    'risk' | 'screener' | 'sepa' | 'stockDataReadiness' | 'watchlist' | 'backtest' | 'options' | 'greeks'
  >('risk')
  const [strategyView, setStrategyView] = useState<'structure' | 'opportunity' | 'allocations' | 'gates' | 'typeConfig' | 'instances' | 'winRate'>('structure')
  /** Instance id from URL hash #/strategies/instances/:id; drives Strategy Instances detail view and back/forward. */
  const [urlStrategyInstanceId, setUrlStrategyInstanceId] = useState<number | null>(null)
  /** Opportunity id from #/strategies/opportunities/:id — opens edit form on Opportunity page. */
  const [urlStrategyOpportunityId, setUrlStrategyOpportunityId] = useState<number | null>(null)
  /** Win Rate → Instances: pre-fill Structure bubble filter (token bumps on each navigation). */
  const [instancesStructureFilterIntent, setInstancesStructureFilterIntent] = useState<{
    token: number
    structureName: string
  } | null>(null)
  const [theme, setTheme] = useState<ThemeId>(loadTheme)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const apiHealthProbes = useSettingsApiHealthProbes(true)
  const socketIngestProbe = useSocketIngestProbe(true, status)
  const [operations, setOperations] = useState<Operation[]>([])
  const [ibAccountIndex, setIbAccountIndex] = useState(0)
  const [accountsDisplay, setAccountsDisplay] = useState<IbAccountSnapshot[] | null>(null)
  const [ibAccountsRefreshing, setIbAccountsRefreshing] = useState(false)
  /** Short feedback after account refresh (success/fail/timeout); auto-cleared after a few seconds */
  const [accountsRefreshFeedback, setAccountsRefreshFeedback] = useState<string | null>(null)
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  /** Tick so quote-age and Account Sync–based open-orders lamps update without waiting on fetch. */
  const [liveLampClock, setLiveLampClock] = useState(0)
  const [benchmarks, setBenchmarks] = useState<Record<string, DailyBenchmark>>({})
  /** Celery: Ops /ops/workers + /ops/queues/summary (header lamp + badge; falls back to /status if Ops fails). */
  const [celeryRuntimeLampOverride, setCeleryRuntimeLampOverride] = useState<LampId | null>(null)
  const [celeryQueuePendingTotal, setCeleryQueuePendingTotal] = useState<number | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  /** ⋮ menu: UI build line hidden until user clicks "?". */
  const [headerMenuUiBuildOpen, setHeaderMenuUiBuildOpen] = useState(false)
  const headerMenuRef = useRef<HTMLDivElement>(null)
  const messageCenterRef = useRef<MessageCenterHandle>(null) as RefObject<MessageCenterHandle>
  const [msgDismissedIds, setMsgDismissedIds] = useState<Set<string>>(() => new Set())
  const ibAutoDismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const ibOperatorCmdDismissTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const dismissMessage = useCallback((id: string) => {
    setMsgDismissedIds((prev) => new Set([...prev, id]))
  }, [])

  const dismissAllMessages = useCallback(() => {
    setMsgDismissedIds((prev) => {
      const next = new Set(prev)
      for (const m of systemMessages) next.add(m.message_id)
      return next
    })
  }, [systemMessages])
  /** When GET /status is slow, setInterval would stack concurrent fetches — coalesce to one in-flight request. */
  const statusFetchRef = useRef<Promise<StatusResponse | null> | null>(null)
  const operationsFetchRef = useRef<Promise<void> | null>(null)
  const celeryOpsPollRef = useRef<Promise<void> | null>(null)

  /** When on Settings tab: which section is shown (system vs Massive vs config). Drives header menu highlight. */
  const hashToSettingsViewSection = useCallback((hash: string): 'system' | 'config' | 'massive' => {
    const h = (hash.startsWith('#') ? hash.slice(1) : hash).trim()
    if (!h) return 'system'
    const hashNorm = hash.startsWith('#') ? hash : `#${hash}`
    if (isMassiveOverviewFeedHash(hashNorm)) return 'massive'
    if (isMassiveCommonFeedHash(hashNorm)) return 'massive'
    if (isMassiveOptionFeedHash(hashNorm)) return 'massive'
    if (isMassiveStockFeedHash(hashNorm)) return 'massive'
    if (
      h === FEED_MASSIVE_DAILY_DATA_ID ||
      h === 'settings-subscribe' ||
      h.startsWith('settings-daemon') ||
      h.startsWith('settings-system') ||
      h.startsWith('settings-celery') ||
      h === 'settings-ws-connector' ||
      h === 'settings-market-ingest' ||
      h === 'settings-ib-connector' ||
      h === 'settings-ws-agent' ||
      h.startsWith('feed-') ||
      h.startsWith('coverage-')
    ) {
      return 'system'
    }
    return 'config'
  }, [])
  const [settingsViewSection, setSettingsViewSection] = useState<'system' | 'config' | 'massive' | null>(null)

  /** Browser tab: title + favicon reflect status server config (config.dev.yaml vs config.prod.yaml) when API is reachable. */
  useEffect(() => {
    let cancelled = false
    fetchHealth()
      .then((h) => {
        if (cancelled) return
        applyAppChrome(h.config_profile ?? null)
      })
      .catch(() => {
        if (!cancelled) applyAppChrome(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (activeTab !== 'settings') {
      setSettingsViewSection(null)
      return
    }
    setSettingsViewSection(hashToSettingsViewSection(window.location.hash))
    const onHashChange = () => setSettingsViewSection(hashToSettingsViewSection(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [activeTab, hashToSettingsViewSection])

  /** Sync Strategy tab from hash: instances, opportunities (incl. deep link to edit one opportunity). */
  useEffect(() => {
    const syncFromHash = () => {
      const raw = window.location.hash
      const h = raw.startsWith('#') ? raw.slice(1) : raw
      const instMatch = /^\/strategies\/instances(?:\/(\d+))?\/?$/.exec(h)
      const oppMatch = /^\/strategies\/opportunities(?:\/(\d+))?\/?$/.exec(h)
      if (instMatch) {
        setActiveTab('strategy')
        setStrategyView('instances')
        setUrlStrategyInstanceId(instMatch[1] != null ? Number(instMatch[1]) : null)
        setUrlStrategyOpportunityId(null)
      } else if (oppMatch) {
        setActiveTab('strategy')
        setStrategyView('opportunity')
        setInstancesStructureFilterIntent(null)
        setUrlStrategyOpportunityId(oppMatch[1] != null ? Number(oppMatch[1]) : null)
        setUrlStrategyInstanceId(null)
      }
    }
    syncFromHash()
    window.addEventListener('hashchange', syncFromHash)
    return () => window.removeEventListener('hashchange', syncFromHash)
  }, [])

  /** Deep links / bookmarks: #settings-celery, #settings-api-*, etc. must switch to Settings tab.
   * Without this, initial load stays on Live and SettingsPage never mounts (prod bookmarks looked "broken"). */
  useEffect(() => {
    const syncSettingsTabFromHash = () => {
      const raw = window.location.hash
      const h = raw.startsWith('#') ? raw.slice(1) : raw
      if (!h) return
      const impliesSettings =
        h.startsWith('settings-') ||
        h.startsWith('feed-') ||
        h.startsWith('coverage-') ||
        h.startsWith('ib-') ||
        h === 'flex-preference' ||
        h === 'settings-ib-connection' ||
        h === FEED_MASSIVE_DAILY_DATA_ID ||
        isMassiveOverviewFeedHash(raw.startsWith('#') ? raw : `#${raw}`) ||
        isMassiveCommonFeedHash(raw.startsWith('#') ? raw : `#${raw}`) ||
        isMassiveOptionFeedHash(raw.startsWith('#') ? raw : `#${raw}`) ||
        isMassiveStockFeedHash(raw.startsWith('#') ? raw : `#${raw}`)
      if (impliesSettings) setActiveTab('settings')
    }
    syncSettingsTabFromHash()
    window.addEventListener('hashchange', syncSettingsTabFromHash)
    return () => window.removeEventListener('hashchange', syncSettingsTabFromHash)
  }, [])

  useEffect(() => {
    if (!headerMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) setHeaderMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [headerMenuOpen])

  useEffect(() => {
    if (!headerMenuOpen) setHeaderMenuUiBuildOpen(false)
  }, [headerMenuOpen])

  useEffect(() => {
    const onHash = () => setUrlHash(window.location.hash)
    onHash()
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {}
  }, [theme])

  const loadStatus = useCallback(async () => {
    if (statusFetchRef.current) {
      return statusFetchRef.current
    }
    const run = (async (): Promise<StatusResponse | null> => {
      try {
        const j = await fetchStatus()
        setStatus(j)
        return j
      } catch {
        return null
      }
    })()
    const tracked = run.finally(() => {
      statusFetchRef.current = null
    })
    statusFetchRef.current = tracked
    return tracked
  }, [])

  const loadOperations = useCallback(async () => {
    if (operationsFetchRef.current) {
      return operationsFetchRef.current
    }
    const run = (async () => {
      try {
        const j = await fetchOperations(20)
        setOperations(j.operations || [])
      } catch {
        setOperations([])
      }
    })()
    const tracked = run.finally(() => {
      operationsFetchRef.current = null
    })
    operationsFetchRef.current = tracked
    return tracked
  }, [])

  /** Instance detail now renders as in-page sidebar; keep global shell/polling behavior unchanged. */
  const isDetailMode = false

  useEffect(() => {
    loadStatus()
    if (!isDetailMode) loadOperations()
    const statusInterval = isDetailMode ? 30000 : 5000
    const opsInterval = isDetailMode ? 60000 : 10000
    const t1 = setInterval(loadStatus, statusInterval)
    const t2 = setInterval(loadOperations, opsInterval)
    return () => {
      clearInterval(t1)
      clearInterval(t2)
    }
  }, [loadStatus, loadOperations, isDetailMode])

  useEffect(() => {
    if (isDetailMode) return
    const pollCeleryOps = () => {
      if (celeryOpsPollRef.current) return
      const run = Promise.all([fetchOpsWorkers(), fetchQueueSummary()])
        .then(([wRes, qRes]) => {
          const supported = supportedQueueNamesFromSummary(qRes.ok ? qRes.queues : [])
          const brokerOk = wRes.ok && wRes.broker?.connected === true
          const wrks = wRes.ok ? wRes.workers : []
          setCeleryRuntimeLampOverride(computeCeleryRuntimeLamp(brokerOk, wrks, supported))
          if (qRes.ok && qRes.queues.length > 0) {
            setCeleryQueuePendingTotal(celeryQueuePendingBadgeTotal(qRes.queues))
          } else {
            setCeleryQueuePendingTotal(null)
          }
        })
        .catch(() => {
          setCeleryRuntimeLampOverride(null)
          setCeleryQueuePendingTotal(null)
        })
      const tracked = run.finally(() => {
        celeryOpsPollRef.current = null
      })
      celeryOpsPollRef.current = tracked
    }
    pollCeleryOps()
    const t = setInterval(pollCeleryOps, 10000)
    return () => clearInterval(t)
  }, [isDetailMode])

  useEffect(() => {
    if (isDetailMode) return
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) {
          setQuotesMap((prev) => mergeQuotesIntoSymbolMap(prev, res.quotes!))
        }
      })
      .catch(() => {})
    const unsub = subscribeQuotes((q) => {
      setQuotesMap((prev) => mergeQuotesIntoSymbolMap(prev, [q]))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [isDetailMode])

  useEffect(() => {
    if (isDetailMode) return
    const id = setInterval(() => setLiveLampClock((c) => c + 1), 5000)
    return () => clearInterval(id)
  }, [isDetailMode])

  useEffect(() => {
    const acc = status?.portfolio?.accounts
    if (acc != null && accountsDisplay === null) setAccountsDisplay(acc ? [...acc] : [])
  }, [status?.portfolio?.accounts, accountsDisplay])

  // Sync accounts when backend reports new data (e.g. after fallback prices applied) so Market/Daily %/Daily $ update
  const lastAccountsFetchedAtRef = useRef<number | null>(null)
  useEffect(() => {
    const acc = status?.portfolio?.accounts
    const fetchedAt = status?.portfolio?.accounts_fetched_at
    if (acc == null || fetchedAt == null) return
    if (accountsDisplay !== null && fetchedAt !== lastAccountsFetchedAtRef.current) {
      lastAccountsFetchedAtRef.current = fetchedAt
      setAccountsDisplay([...acc])
    } else if (accountsDisplay === null) {
      lastAccountsFetchedAtRef.current = fetchedAt
    }
  }, [status?.portfolio?.accounts, status?.portfolio?.accounts_fetched_at, accountsDisplay])

  useEffect(() => {
    const t = setInterval(() => {
      loadStatus().then((j) => {
        const a = j?.portfolio?.accounts
        setAccountsDisplay(a ? [...a] : [])
      })
    }, 60 * 60 * 1000)
    return () => clearInterval(t)
  }, [loadStatus])

  useEffect(() => {
    if (accountsRefreshFeedback == null) return
    const t = setTimeout(() => setAccountsRefreshFeedback(null), 5000)
    return () => clearTimeout(t)
  }, [accountsRefreshFeedback])

  useEffect(() => {
    let cancelled = false
    fetchSystemMessages(SYSTEM_MESSAGE_BOOTSTRAP_LIMIT)
      .then((res) => {
        if (cancelled || !Array.isArray(res.messages)) return
        if (res.messages.length > 0) {
          setSystemMessages((prev) => mergeSystemMessages(prev, res.messages))
        }
      })
      .catch(() => {})
    const unsub = subscribeSystemMessages((message) => {
      setSystemMessages((prev) => mergeSystemMessages(prev, [message]))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])

  // Prune messages older than 1 hr from React state (matches backend TTL)
  useEffect(() => {
    if (systemMessages.length === 0) return
    const oldestExpiry = Math.min(...systemMessages.map((m) => Number(m.occurred_at || 0))) * 1000 + SYSTEM_MESSAGE_BACKEND_TTL_SEC * 1000
    const delayMs = Math.max(5000, oldestExpiry - Date.now())
    const t = setTimeout(() => {
      const cutoff = Date.now() / 1000 - SYSTEM_MESSAGE_BACKEND_TTL_SEC
      setSystemMessages((prev) => prev.filter((m) => Number(m.occurred_at || 0) > cutoff))
    }, delayMs)
    return () => clearTimeout(t)
  }, [systemMessages])

  // Auto-dismiss ib.connection messages 30 s after they occur.
  // Uses a ref-keyed timer map so each message is scheduled only once.
  useEffect(() => {
    const timers = ibAutoDismissTimersRef.current
    const now = Date.now() / 1000
    for (const m of systemMessages) {
      if (m.topic !== 'ib.connection') continue
      if (timers.has(m.message_id)) continue
      const age = now - Number(m.occurred_at || 0)
      const delayMs = Math.max(0, (IB_CONNECTION_MSG_AUTO_DISMISS_SEC - age) * 1000)
      const id = m.message_id
      timers.set(id, setTimeout(() => {
        setMsgDismissedIds((prev) => new Set([...prev, id]))
        timers.delete(id)
      }, delayMs))
    }
    // Cancel timers for messages that have been pruned from state
    for (const [id, timer] of timers) {
      if (!systemMessages.some((m) => m.message_id === id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }
  }, [systemMessages])

  // Auto-dismiss portfolio command messages (TWS fetch, Flex fetch/upload, …) after 10 minutes.
  useEffect(() => {
    const timers = ibOperatorCmdDismissTimersRef.current
    const now = Date.now() / 1000
    for (const m of systemMessages) {
      if (!isIbOperatorCommandMessage(m)) continue
      if (timers.has(m.message_id)) continue
      const age = now - Number(m.occurred_at || 0)
      const delayMs = Math.max(0, (IB_OPERATOR_COMMAND_LIFETIME_SEC - age) * 1000)
      const id = m.message_id
      timers.set(id, setTimeout(() => {
        setMsgDismissedIds((prev) => new Set([...prev, id]))
        timers.delete(id)
      }, delayMs))
    }
    for (const [id, timer] of timers) {
      if (!systemMessages.some((msg) => msg.message_id === id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }
  }, [systemMessages])

  const onRefreshAccounts = useCallback(async () => {
    setIbAccountsRefreshing(true)
    setAccountsRefreshFeedback(null)
    const requestedAt = Date.now() / 1000
    try {
      const res = await postRefreshAccounts()
      if (!res.ok) {
        setAccountsRefreshFeedback(res.error || 'Refresh request failed')
        return
      }
      let refreshed = false
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const j = await loadStatus()
        const ja = j?.portfolio?.accounts
        if (ja != null) setAccountsDisplay(ja ? [...ja] : [])
        const jf = j?.portfolio?.accounts_fetched_at
        if (jf != null && jf > requestedAt) {
          setAccountsRefreshFeedback('Refreshed')
          refreshed = true
          break
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (!refreshed) {
        setAccountsRefreshFeedback('Request sent; no data update detected yet. Try again later.')
      }
    } catch (e) {
      setAccountsRefreshFeedback(e instanceof Error ? e.message : 'Network or API error')
    } finally {
      setIbAccountsRefreshing(false)
    }
  }, [loadStatus])

  const j = status
  /** Same roll-up as Settings → Daemon: Strategy Engine + Account Sync process health (GET /status). */
  const daemonShortcutLamp = useMemo(() => aggregateDaemonProcessesHealthFromStatus(j), [j])
  const dl = daemonShortcutLamp.lamp
  // Strategy tab lamp = Trading Strategy status (same as Settings → Daemon → Trading Strategy)
  const hb = j?.daemon?.heartbeat
  const strategyLamp: LampId =
    !hb || !hb.daemon_alive ? 'red' : j?.daemon?.trading?.trading_suspended === true ? 'yellow' : 'green'
  const celeryLamp: LampId =
    celeryRuntimeLampOverride ?? celeryMetricsFromStatus(status).celeryLamp
  /** Same rules as Live page section lamps: Market Streams + Open Orders (no daemon). */
  const marketStreamsOk = useMemo(
    () => computeMarketStreamsOk(j, quotesMap),
    [j, quotesMap, liveLampClock],
  )
  const accountSyncLampForOpenOrders = useMemo(
    () => computeAccountSyncLamp(j),
    [j, liveLampClock],
  )
  const openOrdersSectionOk = useMemo(
    () => computeOpenOrdersSectionOk(j, Date.now() / 1000),
    [j, liveLampClock],
  )
  /** Live nav lamp: IB Broker Services + Daemon liveness (Open Orders requires daemon). */
  const liveNavLamp = useMemo(
    () => computeLiveNavLamp(j, hb?.daemon_alive === true),
    [j, hb?.daemon_alive],
  )
  const liveLamp: LampId = liveNavLamp.lamp
  const dashboardStreamsLamp: LampId = marketStreamsOk ? 'green' : 'red'
  const dashboardOpenOrdersLamp: LampId = openOrdersSectionOk ? 'green' : 'red'

  const watchlistSymbols = useMemo(
    () => [...new Set([...(status?.live_ui?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort(),
    [status?.live_ui?.subscribed_tickers, quotesMap],
  )
  const benchmarkSymbols = useMemo(
    () =>
      [
        ...new Set([
          ...watchlistSymbols,
          ...(status?.live_ui?.reference_indices?.map((r) => r.symbol) ?? []),
        ]),
      ].sort(),
    [watchlistSymbols, status?.live_ui?.reference_indices],
  )
  const streamSummaryItems = useMemo<StreamSummaryItem[]>(() => {
    const accountsList = status?.portfolio?.accounts ?? []
    const rows = watchlistSymbols.map((symbol) => {
      let qty = 0
      let totalCost = 0
      let hasCost = false
      for (const acc of accountsList) {
        for (const p of acc?.positions ?? []) {
          const sym = (p.symbol || '').trim()
          const secType = (p.secType || '').toString().toUpperCase()
          const posQty = typeof p.position === 'number' ? p.position : 0
          if (!sym || sym !== symbol || secType !== 'STK' || !Number.isFinite(posQty) || posQty === 0) continue
          qty += posQty
          if (p.avgCost != null && Number.isFinite(p.avgCost as number)) {
            totalCost += (p.avgCost as number) * posQty
            hasCost = true
          }
        }
      }
      const avgCost = hasCost && qty !== 0 ? totalCost / qty : null
      const symKey = (symbol || '').trim().toUpperCase()
      const quote = quotesMap[symKey] ?? quotesMap[symbol]
      const bench = benchmarks[symKey]
      const curr = quoteDisplayLast(quote)
      const { changePct, pnlVsBench } = computeDailyChange(bench, curr, qty ?? 0)
      const pnlCost =
        curr != null && avgCost != null && Number.isFinite(qty) && qty !== 0
          ? (curr - avgCost) * qty
          : null
      return { qty, avgCost, pnlCost, pnlVsBench, changePct }
    })

    const totalDailyDollar = rows.reduce(
      (acc, row) => acc + (row.pnlVsBench != null && Number.isFinite(row.pnlVsBench) ? row.pnlVsBench : 0),
      0,
    )
    const sumLastQty = watchlistSymbols.reduce((acc, symbol, index) => {
      const qty = Number.isFinite(rows[index]?.qty) ? rows[index]!.qty : 0
      const sk = (symbol || '').trim().toUpperCase()
      const last = quoteDisplayLast(quotesMap[sk] ?? quotesMap[symbol]) ?? 0
      return acc + last * qty
    }, 0)
    const totalDailyDenom = sumLastQty - totalDailyDollar
    const totalDailyPct =
      totalDailyDenom > 0 && Number.isFinite(totalDailyDollar)
        ? (totalDailyDollar / totalDailyDenom) * 100
        : null

    const toneForNumber = (value: number | null | undefined): StreamTone => {
      if (value == null || !Number.isFinite(value)) return 'neutral'
      if (value > 0) return 'positive'
      if (value < 0) return 'negative'
      return 'neutral'
    }

    const items: StreamSummaryItem[] = [
      {
        label: 'Market Streams',
        value: marketStreamsOk ? 'Online' : 'Offline',
        tone: marketStreamsOk ? 'positive' : 'negative',
      },
      ...watchlistSymbols.map((symbol, i) => {
        const row = rows[i]
        const pct = row?.changePct ?? null
        const dollar = row?.pnlVsBench ?? null
        const valueStr =
          pct != null && dollar != null
            ? `${fmtPctCompact(pct)} / ${fmtUsdCompact(dollar)}`
            : pct != null
              ? fmtPctCompact(pct)
              : dollar != null
                ? fmtUsdCompact(dollar)
                : '—'
        return {
          label: symbol,
          value: valueStr,
          tone: toneForNumber(pct ?? dollar),
        }
      }),
      {
        label: 'Daily %',
        value: fmtPctCompact(totalDailyPct),
        tone: toneForNumber(totalDailyPct),
      },
      {
        label: 'Daily $',
        value: fmtUsdCompact(totalDailyDollar),
        tone: toneForNumber(totalDailyDollar),
      },
    ]
    return items
  }, [status?.portfolio?.accounts, status?.live_ui?.reference_indices, watchlistSymbols, quotesMap, benchmarks, marketStreamsOk])

  useEffect(() => {
    if (benchmarkSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(benchmarkSymbols)
      .then((res) => {
        if (!cancelled) setBenchmarks(normalizeBenchmarkMap(res.benchmarks))
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [benchmarkSymbols.join(',')])

  /** Research submenu “Research” crumb → Risk Model (home). */
  const goResearchHome = useCallback(() => {
    setActiveTab('research')
    setResearchView('risk')
  }, [])

  /** Strategy submenu “Strategy” crumb → Structure (home). */
  const goStrategyStructure = useCallback(() => {
    setActiveTab('strategy')
    setStrategyView('structure')
  }, [])

  const tabList: { id: TabId; label: string; group: TabGroup; lamp?: 'green' | 'yellow' | 'red' | 'none'; lampTitle?: string }[] = [
    { id: 'live', label: 'Live', group: 'market', lamp: liveLamp, lampTitle: liveLamp !== 'green' ? liveNavLamp.title : undefined },
    { id: 'research', label: 'Research', group: 'research' },
    { id: 'replay', label: 'Portfolio', group: 'portfolio' },
    { id: 'strategy', label: 'Strategy', group: 'strategy', lamp: strategyLamp },
  ]

  /** Research dropdown: Screener (stocks vs options) vs Discovery vs Risk & tools. */
  const researchSubmenuGroups: {
    id: string
    label: string
    items: {
      id: 'risk' | 'screener' | 'sepa' | 'stockDataReadiness' | 'watchlist' | 'backtest' | 'options' | 'greeks';
      label: string
    }[]
  }[] = [
    {
      id: 'screener-section',
      label: 'Screener',
      items: [
        { id: 'sepa', label: 'Stock Screener' },
        { id: 'stockDataReadiness', label: 'Stock Data Readiness' },
        { id: 'screener', label: 'Option Screener' },
        { id: 'watchlist', label: 'Watchlist' },
      ],
    },
    {
      id: 'discovery',
      label: 'Discovery',
      items: [{ id: 'options', label: 'Option Discovery' }],
    },
    {
      id: 'risk-tools',
      label: 'Risk & tools',
      items: [
        { id: 'risk', label: 'Risk Model' },
        { id: 'backtest', label: 'Backtest' },
        { id: 'greeks', label: 'IV & Greeks' },
      ],
    },
  ]

  /** Strategy dropdown: one level with section labels (operations vs configuration). */
  const strategySubmenuGroups: {
    id: string
    label: string
    items: { id: 'structure' | 'opportunity' | 'allocations' | 'gates' | 'typeConfig' | 'instances' | 'winRate'; label: string }[]
  }[] = [
    {
      id: 'operations',
      label: 'Operations',
      items: [
        { id: 'instances', label: 'Instances' },
        { id: 'winRate', label: 'Win Rate' },
      ],
    },
    {
      id: 'configuration',
      label: 'Configuration',
      items: [
        { id: 'structure', label: 'Structure' },
        { id: 'opportunity', label: 'Opportunity' },
        { id: 'allocations', label: 'Allocations' },
        { id: 'gates', label: 'Gates' },
        { id: 'typeConfig', label: 'Option Category' },
      ],
    },
  ]

  /** Portfolio dropdown: Overview vs Activity & cash (same pattern as Strategy groups). */
  const portfolioSubmenuGroups: {
    id: string
    label: string
    items: { id: PortfolioView; label: string }[]
  }[] = [
    {
      id: 'overview',
      label: 'Overview',
      items: [
        { id: 'accounts', label: 'Accounts' },
        { id: 'open', label: 'Positions' },
        { id: 'performance', label: 'Performance' },
        { id: 'model-analysis', label: 'Model Analysis' },
      ],
    },
    {
      id: 'activity-cash',
      label: 'Activity & cash',
      items: [
        { id: 'ledger', label: 'Trade ledger' },
        { id: 'transfer', label: 'Transfer & Pay' },
      ],
    },
  ]
  const isStrategyInstanceDetailMode = isDetailMode

  const openDaemonInSettings = useCallback(() => {
    setActiveTab('settings')
    window.location.hash = '#settings-daemon'
  }, [])

  /** Open Settings → first Settings section (Daemon App / heartbeat). Used by header ⋮ menu "Settings". */
  const openSettingsToConfiguration = () => {
    setActiveTab('settings')
    window.location.hash = '#settings-heartbeat'
  }

  const openSettingsApiShortcut = useCallback((hash: string) => {
    setActiveTab('settings')
    window.location.hash = hash
  }, [])

  const openCeleryInSettings = () => {
    setActiveTab('settings')
    window.location.hash = '#settings-celery'
  }

  const openSocketInSettings = useCallback(() => {
    setActiveTab('settings')
    window.location.hash = '#settings-ws-connector'
  }, [])

  const openSettingsSectionById = useCallback((id: string) => {
    setActiveTab('settings')
    window.location.hash = `#${id.replace(/^#/, '')}`
  }, [])

  const runQuickStop = async (
    api: () => Promise<{ ok?: boolean; error?: string }>,
    label: string,
  ) => {
    setQuickCtrlMsg({ text: `${label}…`, isErr: false })
    try {
      const r = await api()
      setQuickCtrlMsg({ text: r.ok === true ? 'Done.' : (r.error ?? 'Failed'), isErr: r.ok !== true })
    } catch (e) {
      setQuickCtrlMsg({ text: (e instanceof Error ? e.message : 'Failed'), isErr: true })
    }
    setTimeout(() => setQuickCtrlMsg({ text: '', isErr: false }), 3000)
  }

  const renderTabButton = (id: TabId, label: string, lamp?: 'green' | 'yellow' | 'red' | 'none', lampTitle?: string) => (
    <button
      key={id}
      type="button"
      className={`app-tab ${activeTab === id ? 'active' : ''}`}
      onClick={() => setActiveTab(id)}
      aria-current={activeTab === id ? 'page' : undefined}
      title={lampTitle}
      aria-label={lampTitle ? `${label} — ${lampTitle}` : undefined}
    >
      {id !== 'live' && <MainTabIcon id={id} />}
      {lamp != null && id === 'live' && (
        <span className={`app-tab-lamp-icon lamp-icon ${lamp}`} aria-hidden>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
            <path d="M8 5v14l11-7L8 5z" />
          </svg>
        </span>
      )}
      {lamp != null && id !== 'live' && <span className={`lamp lamp-sm ${lamp}`} aria-hidden />}
      <span>{label}</span>
    </button>
  )

  return (
    <div className="app">
      {!isStrategyInstanceDetailMode && (
      <header className="app-header">
        <div className="app-header-left">
          <img src={logoImg} alt="Bifrost Trader" className="app-logo" />
          <nav className="app-tabs" aria-label="Live, Research, Portfolio, Strategy">
            {tabList.map(({ id, label, group, lamp, lampTitle }, idx) => {
              const showDivider = idx > 0 && tabList[idx - 1].group !== group
              const divider = showDivider ? <NavGroupDivider key={`div-${group}`} /> : null
              if (id === 'replay') {
                return (
                  <Fragment key={id}>
                    {divider}
                    <div className={`app-tab-group ${activeTab === id ? 'active' : ''}`}>
                      <button
                        type="button"
                        className={`app-tab app-tab-has-menu ${activeTab === id ? 'active' : ''}`}
                        onClick={() => setActiveTab(id)}
                        aria-current={activeTab === id ? 'page' : undefined}
                        aria-haspopup="menu"
                      >
                        <MainTabIcon id={id} />
                        <span>{label}</span>
                        <span className="app-tab-caret" aria-hidden>▾</span>
                      </button>
                      <div className="app-submenu" role="menu" aria-label="Portfolio sections">
                        {portfolioSubmenuGroups.map((group) => (
                          <div
                            key={group.id}
                            role="group"
                            className="app-submenu-group"
                            aria-labelledby={`portfolio-submenu-${group.id}`}
                          >
                            <div id={`portfolio-submenu-${group.id}`} className="app-submenu-group-label">
                              {group.label}
                            </div>
                            {group.items.map(({ id: viewId, label: viewLabel }) => (
                              <button
                                key={viewId}
                                type="button"
                                role="menuitemradio"
                                aria-checked={activeTab === 'replay' && portfolioView === viewId}
                                className={`app-submenu-item ${activeTab === 'replay' && portfolioView === viewId ? 'active' : ''}`}
                                onClick={() => {
                                  setActiveTab('replay')
                                  setPortfolioView(viewId)
                                }}
                              >
                                <SubmenuIcon name={viewId} />
                                <span>{viewLabel}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </Fragment>
                )
              }
              if (id === 'research') {
                return (
                  <Fragment key={id}>
                    {divider}
                    <div className={`app-tab-group ${activeTab === id ? 'active' : ''}`}>
                      <button
                        type="button"
                        className={`app-tab app-tab-has-menu ${activeTab === id ? 'active' : ''}`}
                        onClick={() => setActiveTab(id)}
                        aria-current={activeTab === id ? 'page' : undefined}
                        aria-haspopup="menu"
                      >
                        <MainTabIcon id={id} />
                        <span>{label}</span>
                        <span className="app-tab-caret" aria-hidden>▾</span>
                      </button>
                      <div className="app-submenu" role="menu" aria-label="Research sections">
                        {researchSubmenuGroups.map((group) => (
                          <div
                            key={group.id}
                            role="group"
                            className="app-submenu-group"
                            aria-labelledby={`research-submenu-${group.id}`}
                          >
                            <div id={`research-submenu-${group.id}`} className="app-submenu-group-label">
                              {group.label}
                            </div>
                            {group.items.map(({ id: viewId, label: viewLabel }) => (
                              <button
                                key={viewId}
                                type="button"
                                role="menuitemradio"
                                aria-checked={activeTab === 'research' && researchView === viewId}
                                className={`app-submenu-item ${activeTab === 'research' && researchView === viewId ? 'active' : ''}`}
                                onClick={() => {
                                  setActiveTab('research')
                                  setResearchView(viewId)
                                }}
                              >
                                <SubmenuIcon name={viewId} />
                                <span>{viewLabel}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </Fragment>
                )
              }
              if (id === 'strategy') {
                return (
                  <Fragment key={id}>
                    {divider}
                    <div className={`app-tab-group ${activeTab === id ? 'active' : ''}`}>
                      <button
                        type="button"
                        className={`app-tab app-tab-has-menu ${activeTab === id ? 'active' : ''}`}
                        onClick={() => setActiveTab(id)}
                        aria-current={activeTab === id ? 'page' : undefined}
                        aria-haspopup="menu"
                      >
                        {lamp != null && (
                          <span className={`app-tab-lamp-icon lamp-icon ${lamp}`} aria-hidden>
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M12 2L2 7l10 5 10-5-10-5z" />
                              <path d="M2 17l10 5 10-5" />
                            </svg>
                          </span>
                        )}
                        <span>{label}</span>
                        <span className="app-tab-caret" aria-hidden>▾</span>
                      </button>
                      <div className="app-submenu" role="menu" aria-label="Strategy sections">
                        {strategySubmenuGroups.map((group) => (
                          <div
                            key={group.id}
                            role="group"
                            className="app-submenu-group"
                            aria-labelledby={`strategy-submenu-${group.id}`}
                          >
                            <div id={`strategy-submenu-${group.id}`} className="app-submenu-group-label">
                              {group.label}
                            </div>
                            {group.items.map(({ id: viewId, label: viewLabel }) => (
                              <button
                                key={viewId}
                                type="button"
                                role="menuitemradio"
                                aria-checked={activeTab === 'strategy' && strategyView === viewId}
                                className={`app-submenu-item ${activeTab === 'strategy' && strategyView === viewId ? 'active' : ''}`}
                                onClick={() => {
                                  setActiveTab('strategy')
                                  setInstancesStructureFilterIntent(null)
                                  setStrategyView(viewId)
                                }}
                              >
                                <SubmenuIcon name={viewId} />
                                <span>{viewLabel}</span>
                              </button>
                            ))}
                          </div>
                        ))}
                      </div>
                    </div>
                  </Fragment>
                )
              }

              return (
                <Fragment key={id}>
                  {divider}
                  {renderTabButton(id, label, lamp, lampTitle)}
                </Fragment>
              )
            })}
          </nav>
        </div>
        <div className="app-header-right" ref={headerMenuRef}>
          {quickCtrlMsg.text ? (
            <span className={`app-header-system-msg ${quickCtrlMsg.isErr ? 'err' : ''}`}>{quickCtrlMsg.text}</span>
          ) : null}
          <MessageCenter
            ref={messageCenterRef}
            messages={systemMessages}
            dismissedIds={msgDismissedIds}
            onDismiss={dismissMessage}
            onDismissAll={dismissAllMessages}
          />
          <div className="app-header-system-lamps-wrap">
            <div
              className="app-header-lamp-stop-group app-header-api-shortcuts-group"
              aria-label="API settings shortcuts and stop monitor"
            >
              <div className="app-header-api-shortcuts" role="toolbar" aria-label="Open Settings API pages">
                {HEADER_API_SHORTCUTS.map(({ hash, glyph, title, lampPicker }) => {
                  const active = activeTab === 'settings' && urlHash === hash
                  const lamp =
                    lampPicker === 'architecture'
                      ? apiHealthProbes.architectureApiLamp
                      : lampPicker === 'account'
                        ? apiHealthProbes.accountApiLamp
                        : lampPicker === 'research'
                          ? apiHealthProbes.researchApiLamp
                          : apiHealthProbes.massiveApiLamp
                  return (
                    <button
                      key={hash}
                      type="button"
                      className={`app-header-api-shortcut-btn${active ? ' active' : ''}`}
                      title={title}
                      aria-label={title}
                      onClick={() => openSettingsApiShortcut(hash)}
                    >
                      <span className={headerApiShortcutLampClass(lamp)} aria-hidden>
                        <SettingsSidebarLampGlyph id={glyph} />
                      </span>
                    </button>
                  )
                })}
              </div>
              <button
                type="button"
                className="app-header-lamp-switch"
                onClick={() => runQuickStop(postMonitorStop, 'Stop Monitor API')}
                title="Stop Monitor API process"
                aria-label="Stop Monitor API process"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div
              className="app-header-lamp-stop-group app-header-api-shortcuts-group"
              aria-label="App runtime: Socket, Daemon, Celery"
            >
              <div className="app-header-api-shortcuts" role="toolbar" aria-label="Socket, Daemon, Celery shortcuts">
                <button
                  type="button"
                  className={`app-header-api-shortcut-btn${activeTab === 'settings' && isSocketSettingsHash(urlHash) ? ' active' : ''}`}
                  title={socketIngestProbe.title}
                  aria-label="Settings → Socket"
                  onClick={() => openSocketInSettings()}
                >
                  <span
                    className={`title-inline-lamp lamp-icon ${socketIngestProbe.lamp === 'none' ? 'none' : socketIngestProbe.lamp}`}
                    aria-hidden
                  >
                    <SettingsSidebarLampGlyph id="websocket" />
                  </span>
                </button>
                <button
                  type="button"
                  className={`app-header-api-shortcut-btn${activeTab === 'settings' && isDaemonSettingsHash(urlHash) ? ' active' : ''}`}
                  title={`${daemonShortcutLamp.title} — Settings → Daemon`}
                  aria-label="Settings → Daemon"
                  onClick={() => openDaemonInSettings()}
                >
                  <span className={headerApiShortcutLampClass(dl)} aria-hidden>
                    <SettingsSidebarLampGlyph id="daemon" />
                  </span>
                </button>
                <button
                  type="button"
                  className={`app-header-api-shortcut-btn app-header-api-shortcut-btn--celery${activeTab === 'settings' && isCelerySettingsHash(urlHash) ? ' active' : ''}`}
                  title="Celery workers and queue pending — Settings → Celery"
                  aria-label="Settings → Celery"
                  onClick={() => openCeleryInSettings()}
                >
                  <span className={headerApiShortcutLampClass(celeryLamp)} aria-hidden>
                    <SettingsSidebarLampGlyph id="celery" />
                  </span>
                  <span
                    className="app-header-queue-value app-header-queue-value--inline"
                    title="Queue summary Pending total (deduped: stocks_ib + options Massive once) — jobs waiting in queue"
                  >
                    {celeryQueuePendingTotal != null ? (celeryQueuePendingTotal > 99 ? '99+' : String(celeryQueuePendingTotal)) : '—'}
                  </span>
                </button>
              </div>
            </div>
          </div>
          {(() => {
            const activeMsgCount = systemMessages.filter((m) => !msgDismissedIds.has(m.message_id)).length
            return (
              <button
                type="button"
                className={`app-header-icon-btn ${headerMenuOpen ? 'active' : ''} ${activeTab === 'settings' ? 'active' : ''}`}
                onClick={() => setHeaderMenuOpen((o) => !o)}
                title={activeMsgCount > 0 ? `Menu — ${activeMsgCount} active messages` : 'Menu'}
                aria-label={activeMsgCount > 0 ? `Open menu (${activeMsgCount} active messages)` : 'Open menu'}
                aria-expanded={headerMenuOpen}
                aria-haspopup="menu"
              >
                {activeMsgCount > 0 && (
                  <span className="msc-bell-badge" aria-hidden>
                    {activeMsgCount > 99 ? '99+' : activeMsgCount}
                  </span>
                )}
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="12" cy="12" r="1" />
                  <circle cx="12" cy="5" r="1" />
                  <circle cx="12" cy="19" r="1" />
                </svg>
              </button>
            )
          })()}
          {headerMenuOpen && (
            <div className="app-header-menu" role="menu" aria-label="App menu">
              {(() => {
                const activeMsgCount = systemMessages.filter((m) => !msgDismissedIds.has(m.message_id)).length
                return (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="app-header-menu-item app-header-menu-item-messages"
                      onClick={() => { messageCenterRef.current?.openDrawer(); setHeaderMenuOpen(false) }}
                      title={activeMsgCount > 0 ? 'View system messages' : 'View system messages (none active)'}
                    >
                      <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" style={{ flexShrink: 0 }} aria-hidden>
                        <path d="M10 2a6 6 0 00-6 6v2.586l-1.707 1.707A1 1 0 003 14h14a1 1 0 00.707-1.707L16 10.586V8a6 6 0 00-6-6zM8.5 17a1.5 1.5 0 003 0H8.5z" />
                      </svg>
                      Messages
                      {activeMsgCount > 0 ? (
                        <span className="app-header-menu-msg-count">{activeMsgCount}</span>
                      ) : null}
                    </button>
                    <div className="app-header-menu-divider" role="presentation" />
                  </>
                )
              })()}
              <div className="app-header-menu-label" role="presentation">API</div>
              {HEADER_API_SHORTCUTS.map(({ hash, glyph, title, menuLabel, lampPicker }) => {
                const lamp =
                  lampPicker === 'architecture'
                    ? apiHealthProbes.architectureApiLamp
                    : lampPicker === 'account'
                      ? apiHealthProbes.accountApiLamp
                      : lampPicker === 'research'
                        ? apiHealthProbes.researchApiLamp
                        : apiHealthProbes.massiveApiLamp
                return (
                  <button
                    key={hash}
                    type="button"
                    role="menuitem"
                    className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && urlHash === hash ? 'active' : ''}`}
                    onClick={() => { openSettingsApiShortcut(hash); setHeaderMenuOpen(false) }}
                    title={title}
                  >
                    <span className={headerApiShortcutLampClass(lamp)} aria-hidden>
                      <SettingsSidebarLampGlyph id={glyph} />
                    </span>
                    {menuLabel}
                  </button>
                )
              })}
              <div className="app-header-menu-label" role="presentation">App</div>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && isSocketSettingsHash(urlHash) ? 'active' : ''}`}
                onClick={() => { openSocketInSettings(); setHeaderMenuOpen(false) }}
                title="Settings → Socket"
              >
                <span
                  className={`title-inline-lamp lamp-icon ${socketIngestProbe.lamp === 'none' ? 'none' : socketIngestProbe.lamp}`}
                  aria-hidden
                >
                  <SettingsSidebarLampGlyph id="websocket" />
                </span>
                Socket
              </button>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive app-header-menu-item-system ${activeTab === 'settings' && isDaemonSettingsHash(urlHash) ? 'active' : ''}`}
                onClick={() => { openDaemonInSettings(); setHeaderMenuOpen(false) }}
                title={`${daemonShortcutLamp.title} — Settings → Daemon`}
              >
                <span className={`app-header-menu-system-lamp title-inline-lamp lamp-icon ${dl}`} aria-hidden>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
                    <path d="M8 5v14l11-7L8 5z" />
                  </svg>
                </span>
                Daemon
              </button>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive app-header-menu-item-system ${activeTab === 'settings' && isCelerySettingsHash(urlHash) ? 'active' : ''}`}
                onClick={() => { openCeleryInSettings(); setHeaderMenuOpen(false) }}
                title="Settings → Celery"
              >
                <span className={`app-header-menu-system-lamp title-inline-lamp ${celeryLamp === 'none' ? 'none' : celeryLamp}`} aria-hidden>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                </span>
                Celery
              </button>
              <div className="app-header-menu-label" role="presentation">Data Coverage</div>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item ${activeTab === 'settings' && isCoverageOverviewHash(urlHash) ? 'active' : ''}`}
                onClick={() => { openSettingsSectionById(COVERAGE_OVERVIEW_SUMMARY_ID); setHeaderMenuOpen(false) }}
                title={`Settings → Data Coverage → ${COVERAGE_OVERVIEW_GROUP_LABEL} → Summary`}
              >
                <SettingsSectionIcon name={COVERAGE_OVERVIEW_SUBSECTION.icon} />
                {COVERAGE_OVERVIEW_GROUP_LABEL}
              </button>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item ${activeTab === 'settings' && isCoverageOptionHash(urlHash) ? 'active' : ''}`}
                onClick={() => { openSettingsSectionById(COVERAGE_OPTION_SUBSECTION.id); setHeaderMenuOpen(false) }}
                title={`Settings → Data Coverage → ${COVERAGE_OPTION_SUBSECTION.label}`}
              >
                <SettingsSectionIcon name={COVERAGE_OPTION_SUBSECTION.icon} />
                {COVERAGE_OPTION_SUBSECTION.label}
              </button>
              <div className="app-header-menu-label app-header-menu-label--coverage-stock" role="presentation">
                {COVERAGE_STOCK_GROUP_LABEL}
              </div>
              {COVERAGE_STOCK_SUBSECTIONS.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  role="menuitem"
                  className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && settingsHashKey(urlHash) === sub.id ? 'active' : ''}`}
                  onClick={() => { openSettingsSectionById(sub.id); setHeaderMenuOpen(false) }}
                  title={`Settings → Data Coverage → Stock → ${sub.label}`}
                >
                  <SettingsSectionIcon name={sub.icon} />
                  {sub.label}
                </button>
              ))}
              <div className="app-header-menu-label" role="presentation">Feed</div>
              {FEED_SUBSECTIONS.map((sub) => (
                <button
                  key={sub.id}
                  type="button"
                  role="menuitem"
                  className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && settingsHashKey(urlHash) === sub.id ? 'active' : ''}`}
                  onClick={() => { openSettingsSectionById(sub.id); setHeaderMenuOpen(false) }}
                  title={`Settings → Feed → ${sub.label}`}
                >
                  <SettingsSectionIcon name={sub.icon} />
                  {sub.label}
                </button>
              ))}
              <div className="app-header-menu-label app-header-menu-label--massive-feed" role="presentation">
                Massive
              </div>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && isMassiveOverviewFeedHash(urlHash) ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab('settings')
                  window.location.hash = `#${FEED_MASSIVE_OVERVIEW_ID}`
                  setHeaderMenuOpen(false)
                }}
                title="Settings → Feed → Massive → Overview"
              >
                <SettingsSectionIcon name="feed-massive" />
                Overview
              </button>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && isMassiveStockFeedHash(urlHash) ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab('settings')
                  window.location.hash = `#${FEED_MASSIVE_STOCK_ID}`
                  setHeaderMenuOpen(false)
                }}
                title="Settings → Feed → Massive → Stock"
              >
                <SettingsSectionIcon name="feed-massive-stock" />
                Stock
              </button>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && isMassiveOptionFeedHash(urlHash) ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab('settings')
                  window.location.hash = `#${FEED_MASSIVE_OPTION_ID}`
                  setHeaderMenuOpen(false)
                }}
                title="Settings → Feed → Massive → Option"
              >
                <SettingsSectionIcon name="feed-massive" />
                Option
              </button>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && isMassiveCommonFeedHash(urlHash) ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab('settings')
                  window.location.hash = `#${FEED_MASSIVE_COMMON_ID}`
                  setHeaderMenuOpen(false)
                }}
                title="Settings → Feed → Massive → Common"
              >
                <SettingsSectionIcon name="feed-massive" />
                Comm
              </button>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item ${activeTab === 'settings' && settingsViewSection === 'config' ? 'active' : ''}`}
                onClick={() => { openSettingsToConfiguration(); setHeaderMenuOpen(false) }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                  <line x1="4" y1="21" x2="4" y2="14" />
                  <line x1="4" y1="10" x2="4" y2="3" />
                  <line x1="12" y1="21" x2="12" y2="12" />
                  <line x1="12" y1="8" x2="12" y2="3" />
                  <line x1="20" y1="21" x2="20" y2="16" />
                  <line x1="20" y1="12" x2="20" y2="3" />
                  <line x1="1" y1="14" x2="7" y2="14" />
                  <line x1="9" y1="8" x2="15" y2="8" />
                  <line x1="17" y1="16" x2="23" y2="16" />
                </svg>
                Settings
              </button>
              <div className="app-header-menu-theme-row" role="group" aria-label="Theme">
                <span className="app-header-menu-theme-label">Theme</span>
                <div className="app-header-menu-theme-bubble" role="radiogroup" aria-label="Color theme">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={theme === 'light'}
                    className={`app-header-menu-theme-bubble-btn ${theme === 'light' ? 'active' : ''}`}
                    onClick={() => { setTheme('light'); setHeaderMenuOpen(false) }}
                    title="Light"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="12" r="5" />
                      <line x1="12" y1="1" x2="12" y2="3" />
                      <line x1="12" y1="21" x2="12" y2="23" />
                      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                      <line x1="1" y1="12" x2="3" y2="12" />
                      <line x1="21" y1="12" x2="23" y2="12" />
                      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={theme === 'dark'}
                    className={`app-header-menu-theme-bubble-btn ${theme === 'dark' ? 'active' : ''}`}
                    onClick={() => { setTheme('dark'); setHeaderMenuOpen(false) }}
                    title="Dark"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                    </svg>
                  </button>
                </div>
              </div>
              <div className="app-header-menu-docs-version-row" role="presentation">
                <a
                  href={mkdocsHandbookHref()}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="app-header-menu-item app-header-menu-docs-link"
                  role="menuitem"
                  onClick={() => setHeaderMenuOpen(false)}
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                    <path d="M8 7h8" />
                    <path d="M8 11h8" />
                  </svg>
                  Docs
                </a>
                <button
                  type="button"
                  className={`app-header-menu-ui-build-help-btn${headerMenuUiBuildOpen ? ' active' : ''}`}
                  onClick={() => setHeaderMenuUiBuildOpen((o) => !o)}
                  aria-expanded={headerMenuUiBuildOpen}
                  aria-controls="app-header-menu-ui-build-panel"
                  title="Show UI build label (compare after deploy for cache / stale static files)"
                >
                  ?
                </button>
              </div>
              <div
                id="app-header-menu-ui-build-panel"
                className="app-header-menu-ui-build"
                role="region"
                aria-label="UI build"
                hidden={!headerMenuUiBuildOpen}
                title="Compare after deploy to detect cache or stale static files."
              >
                <span className="app-header-menu-ui-build-label">UI build</span>
                <span className="app-header-menu-ui-build-value">{UI_BUILD_LABEL}</span>
              </div>
            </div>
          )}
        </div>
      </header>
      )}

      {!isStrategyInstanceDetailMode && (activeTab === 'live' || activeTab === 'strategy' || activeTab === 'replay' || activeTab === 'research') && (
        <DashboardStrip
          streamLamp={dashboardStreamsLamp}
          streamItems={streamSummaryItems}
          onStreamClick={() => setActiveTab('live')}
          openOrderCount={(status?.portfolio?.open_orders ?? []).length}
          onOpenOrdersClick={() => setActiveTab('live')}
          openOrdersLamp={dashboardOpenOrdersLamp}
          openOrdersLampTitle={`Open orders (PostgreSQL): ${accountSyncLampForOpenOrders.title}`}
        />
      )}

      {activeTab === 'replay' && (
        <>
          {/* Portfolio sub-pages: each menu item → one page component (AccountsPage, PositionsPage, PerformancePage, Trade ledger = TradeHistoryPage, TransferPayPage). */}
          {portfolioView === 'accounts' ? (
            <AccountsPage
              status={status}
              accountsDisplay={accountsDisplay}
              ibAccountIndex={ibAccountIndex}
              setIbAccountIndex={setIbAccountIndex}
              ibAccountsRefreshing={ibAccountsRefreshing}
              onRefreshAccounts={onRefreshAccounts}
              refreshFeedback={accountsRefreshFeedback}
              onViewChange={setPortfolioView}
            />
          ) : portfolioView === 'performance' ? (
            <PerformancePage status={status} onViewChange={setPortfolioView} />
          ) : portfolioView === 'model-analysis' ? (
            <ModelAnalysisPage status={status} onViewChange={setPortfolioView} />
          ) : portfolioView === 'transfer' ? (
            <TransferPayPage status={status} onViewChange={setPortfolioView} />
          ) : portfolioView === 'ledger' ? (
            <TradeHistoryPage
              status={status}
              onViewChange={setPortfolioView}
              showViewTabs={false}
            />
          ) : (
            <PositionsPage
              status={status}
              currentView={portfolioView}
              onViewChange={setPortfolioView}
              showViewTabs={false}
              onOpenOptionDiscovery={() => {
                setActiveTab('research')
                setResearchView('options')
              }}
            />
          )}
        </>
      )}

      {activeTab === 'research' && researchView === 'risk' && (
        <ResearchRiskAnalysisPage
          onGoToScreener={goResearchHome}
          breadcrumbLabel="Risk Model"
        />
      )}

      {activeTab === 'research' && researchView === 'screener' && (
        <OptionScreenerPage
          status={status}
          onBreadcrumbResearch={goResearchHome}
          onOpenOptionCoverage={() => {
            setActiveTab('settings')
            window.location.hash = `#${COVERAGE_OVERVIEW_SUMMARY_ID}`
          }}
          breadcrumbLabel="Option Screener"
        />
      )}

      {activeTab === 'research' && researchView === 'sepa' && (
        <StockScreenerPage
          onBreadcrumbResearch={goResearchHome}
          breadcrumbLabel="Stock Screener"
        />
      )}

      {activeTab === 'research' && researchView === 'stockDataReadiness' && (
        <StockDataReadinessPage
          onBreadcrumbResearch={goResearchHome}
          breadcrumbLabel="Stock Data Readiness"
          onOpenCelerySettings={openCeleryInSettings}
          onOpenFeedMassiveStock={() => {
            setActiveTab('settings')
            window.location.hash = `#${FEED_MASSIVE_STOCK_ID}`
          }}
          onOpenDataCoverageSummary={() => {
            setActiveTab('settings')
            window.location.hash = `#${COVERAGE_OVERVIEW_SUMMARY_ID}`
          }}
        />
      )}

      {activeTab === 'research' && researchView === 'backtest' && (
        <BacktestPage
          status={status}
          onGoToScreener={goResearchHome}
          breadcrumbLabel="Backtest"
        />
      )}

      {activeTab === 'research' && researchView === 'options' && (
        <OptionDiscoveryPage
          status={status}
          onGoToScreener={goResearchHome}
          onOpenMassiveFeed={() => {
            setActiveTab('settings')
            window.location.hash = `#${FEED_MASSIVE_DAILY_DATA_ID}`
          }}
          breadcrumbLabel="Option Discovery"
        />
      )}

      {activeTab === 'research' && researchView === 'greeks' && (
        <OptionGreeksPage
          onBreadcrumbResearch={goResearchHome}
          breadcrumbLabel="IV & Greeks"
        />
      )}

      {activeTab === 'strategy' && strategyView === 'structure' && (
        <StrategyStructurePage
          status={status}
          loadStatus={loadStatus}
          breadcrumbLabel="Structure"
          onNavigateToStrategy={goStrategyStructure}
        />
      )}

      {activeTab === 'strategy' && strategyView === 'opportunity' && (
        <StrategyOpportunityPage
          status={status}
          loadStatus={loadStatus}
          breadcrumbLabel="Opportunity"
          urlFocusOpportunityId={urlStrategyOpportunityId}
          onNavigateToStrategy={goStrategyStructure}
        />
      )}

      {activeTab === 'strategy' && strategyView === 'instances' && (
        <StrategyInstancesPage
          status={status}
          loadStatus={loadStatus}
          urlStrategyInstanceId={urlStrategyInstanceId}
          onNavigateToStrategy={goStrategyStructure}
          breadcrumbLabel="Instances"
          instancesStructureFilterIntent={instancesStructureFilterIntent}
        />
      )}

      {activeTab === 'strategy' && strategyView === 'winRate' && (
        <StrategyWinRatePage
          onGoToInstances={(opts) => {
            if (opts?.structureFilter?.trim()) {
              setInstancesStructureFilterIntent({
                token: Date.now(),
                structureName: opts.structureFilter.trim(),
              })
            } else {
              setInstancesStructureFilterIntent(null)
            }
            setStrategyView('instances')
          }}
        />
      )}

      {activeTab === 'strategy' && strategyView === 'allocations' && (
        <StrategyAllocationPage
          status={status}
          loadStatus={loadStatus}
          breadcrumbLabel="Allocations"
          onNavigateToStrategy={goStrategyStructure}
        />
      )}

      {activeTab === 'strategy' && strategyView === 'gates' && (
        <GatesConfigPage
          status={status}
          loadStatus={loadStatus}
          onGoToStrategy={goStrategyStructure}
          breadcrumbLabel="Gates"
        />
      )}

      {activeTab === 'research' && researchView === 'watchlist' && (
        <WatchlistPage status={status} onBreadcrumbResearch={goResearchHome} />
      )}

      {activeTab === 'strategy' && strategyView === 'typeConfig' && (
        <StructureTypeConfigPage breadcrumbLabel="Option Category" onNavigateToStrategy={goStrategyStructure} />
      )}

      {activeTab === 'live' && (
        <LivePage
          status={status}
          onNavigateToStrategy={goStrategyStructure}
          onNavigateToSubscribe={() => openSettingsSectionById('settings-subscribe')}
        />
      )}

      {activeTab === 'settings' && (
        <SettingsPage
          status={status}
          loadStatus={loadStatus}
          operations={operations}
          onNavigateToStrategy={goStrategyStructure}
          onNavigateToSocket={openSocketInSettings}
          onGoToScreener={goResearchHome}
          celeryLamp={celeryLamp}
          apiHealthProbes={apiHealthProbes}
        />
      )}
    </div>
  )
}
