import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { IbAccountSnapshot, StatusResponse, Operation, RealtimeQuote } from './types'
import {
  fetchStatus,
  fetchOperations,
  fetchHealth,
  postRefreshAccounts,
  fetchQuotes,
  subscribeQuotes,
  fetchBarsBenchmark,
  fetchBarsJobs,
} from './api'
import { postStop } from './api/control'
import { postMonitorStop, postCeleryStop } from './api/monitor'
import { LivePage } from './pages/LivePage'
import { AccountsPage } from './pages/AccountsPage'
import { MarketDataPage } from './pages/MarketDataPage'
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
import { StrategyStructurePage } from './pages/StrategyStructurePage'
import { StrategyOpportunityPage } from './pages/StrategyOpportunityPage'
import { StrategyInstancesPage } from './pages/StrategyInstancesPage'
import { StrategyAllocationPage } from './pages/StrategyAllocationPage'
import { GatesConfigPage } from './pages/GatesConfigPage'
import { StructureTypeConfigPage } from './pages/StructureTypeConfigPage'
import { WatchlistPage } from './pages/WatchlistPage'
import { MainTabIcon, SubmenuIcon, type TabId } from './components/AppNavIcons'
import { isMassiveOptionFeedHash } from './pages/massive/feedMassiveTabUtils'
import { FEED_MASSIVE_OPTION_ID } from './pages/settings/settingsConstants'
import logoImg from '../img/logo.png'
import { fmtPctCompact, fmtUsdCompact } from './utils/format'
import './App.css'

const THEME_KEY = 'bifrost-monitor-theme'

type StreamTone = 'neutral' | 'positive' | 'negative'

interface StreamSummaryItem {
  label: string
  value: string
  tone: StreamTone
}

/** Dashboard strip: Open orders summary + Market Streams marquee. */
function DashboardStrip({
  streamLamp,
  streamItems,
  onStreamClick,
  openOrderCount,
  onOpenOrdersClick,
  openOrdersLamp,
}: {
  streamLamp: 'green' | 'yellow' | 'red' | 'none'
  streamItems: StreamSummaryItem[]
  onStreamClick?: () => void
  openOrderCount: number
  onOpenOrdersClick?: () => void
  /** Lamp shown before "Open orders" (e.g. green when there are orders). */
  openOrdersLamp?: 'green' | 'yellow' | 'red' | 'none'
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
              <span className={`lamp-icon ${openOrdersLamp}`} aria-hidden title={openOrdersLamp === 'green' ? 'Daemon alive; open orders data available' : 'Daemon down or no data'}>
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

type LampId = 'green' | 'yellow' | 'red' | 'none'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('live')
  type LampPopoverId = 'daemon' | 'monitor' | 'celery'
  const [lampHoverPopover, setLampHoverPopover] = useState<LampPopoverId | null>(null)
  const lampLeaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const systemLampRef = useRef<HTMLDivElement>(null)
  const [shutdownConfirmOpen, setShutdownConfirmOpen] = useState(false)
  const [shutdownAllLoading, setShutdownAllLoading] = useState(false)
  const [shutdownAllMsg, setShutdownAllMsg] = useState({ text: '', isErr: false })
  const [quickCtrlMsg, setQuickCtrlMsg] = useState({ text: '', isErr: false })
  const [portfolioView, setPortfolioView] = useState<PortfolioView>('accounts')
  const [researchView, setResearchView] = useState<'risk' | 'screener' | 'backtest' | 'options'>('risk')
  const [strategyView, setStrategyView] = useState<'structure' | 'opportunity' | 'allocations' | 'gates' | 'watchlist' | 'typeConfig' | 'instances'>('structure')
  /** Instance id from URL hash #/strategies/instances/:id; drives Strategy Instances detail view and back/forward. */
  const [urlStrategyInstanceId, setUrlStrategyInstanceId] = useState<number | null>(null)
  /** Opportunity id from #/strategies/opportunities/:id — opens edit form on Opportunity page. */
  const [urlStrategyOpportunityId, setUrlStrategyOpportunityId] = useState<number | null>(null)
  const [theme, setTheme] = useState<ThemeId>(loadTheme)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [ibAccountIndex, setIbAccountIndex] = useState(0)
  const [accountsDisplay, setAccountsDisplay] = useState<IbAccountSnapshot[] | null>(null)
  const [ibAccountsRefreshing, setIbAccountsRefreshing] = useState(false)
  /** Short feedback after account refresh (success/fail/timeout); auto-cleared after a few seconds */
  const [accountsRefreshFeedback, setAccountsRefreshFeedback] = useState<string | null>(null)
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [benchmarks, setBenchmarks] = useState<
    Record<string, { bar_time: number; close: number; prev_close?: number | null; is_today?: boolean; is_stale?: boolean }>
  >({})
  /** Celery bars worker queue counts (polled every 3s for dashboard) */
  const [workerJobPending, setWorkerJobPending] = useState<number | null>(null)
  const [workerJobRunning, setWorkerJobRunning] = useState<number | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const headerMenuRef = useRef<HTMLDivElement>(null)

  /** When on Settings tab: which section is shown (system vs Massive vs config). Drives header menu highlight. */
  const hashToSettingsViewSection = useCallback((hash: string): 'system' | 'config' | 'massive' => {
    const h = (hash.startsWith('#') ? hash.slice(1) : hash).trim()
    if (!h) return 'system'
    const hashNorm = hash.startsWith('#') ? hash : `#${hash}`
    if (isMassiveOptionFeedHash(hashNorm)) return 'massive'
    if (h.startsWith('settings-system') || h.startsWith('feed-')) return 'system'
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
        setUrlStrategyOpportunityId(oppMatch[1] != null ? Number(oppMatch[1]) : null)
        setUrlStrategyInstanceId(null)
      }
    }
    syncFromHash()
    window.addEventListener('hashchange', syncFromHash)
    return () => window.removeEventListener('hashchange', syncFromHash)
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
    if (!lampHoverPopover) return
    const onDocClick = (e: MouseEvent) => {
      if (systemLampRef.current && !systemLampRef.current.contains(e.target as Node)) setLampHoverPopover(null)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [lampHoverPopover])

  const openLampPopover = (id: LampPopoverId) => {
    if (lampLeaveTimeoutRef.current) {
      clearTimeout(lampLeaveTimeoutRef.current)
      lampLeaveTimeoutRef.current = null
    }
    setLampHoverPopover(id)
  }
  const closeLampPopover = () => {
    lampLeaveTimeoutRef.current = setTimeout(() => setLampHoverPopover(null), 120)
  }

  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {}
  }, [theme])

  const loadStatus = useCallback(async () => {
    try {
      const j = await fetchStatus()
      setStatus(j)
      return j
    } catch {
      // Keep previous status on failure so UI keeps updating (e.g. after Celery stop, one slow/timeout poll won't blank the page)
      return null
    }
  }, [])

  const loadOperations = useCallback(async () => {
    try {
      const j = await fetchOperations(20)
      setOperations(j.operations || [])
    } catch {
      setOperations([])
    }
  }, [])

  const isDetailMode =
    activeTab === 'strategy' && strategyView === 'instances' && urlStrategyInstanceId != null

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
    const pollWorkerJobs = () => {
      Promise.all([
        fetchBarsJobs(1, 0, 'pending'),
        fetchBarsJobs(1, 0, 'running'),
      ])
        .then(([pendingRes, runningRes]) => {
          setWorkerJobPending(pendingRes.total)
          setWorkerJobRunning(runningRes.total)
        })
        .catch(() => {
          setWorkerJobPending(null)
          setWorkerJobRunning(null)
        })
    }
    pollWorkerJobs()
    const t = setInterval(pollWorkerJobs, 3000)
    return () => clearInterval(t)
  }, [isDetailMode])

  useEffect(() => {
    if (isDetailMode) return
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) {
          setQuotesMap(() => Object.fromEntries(res.quotes!.map((q) => [q.symbol, q])))
        }
      })
      .catch(() => {})
    const unsub = subscribeQuotes((q) => {
      setQuotesMap((prev) => ({ ...prev, [q.symbol]: q }))
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [isDetailMode])

  useEffect(() => {
    if (status?.accounts != null && accountsDisplay === null)
      setAccountsDisplay(status.accounts ? [...status.accounts] : [])
  }, [status?.accounts, accountsDisplay])

  // Sync accounts when backend reports new data (e.g. after fallback prices applied) so Market/Daily %/Daily $ update
  const lastAccountsFetchedAtRef = useRef<number | null>(null)
  useEffect(() => {
    if (status?.accounts == null || status?.accounts_fetched_at == null) return
    const fetchedAt = status.accounts_fetched_at
    if (accountsDisplay !== null && fetchedAt !== lastAccountsFetchedAtRef.current) {
      lastAccountsFetchedAtRef.current = fetchedAt
      setAccountsDisplay([...status.accounts])
    } else if (accountsDisplay === null) {
      lastAccountsFetchedAtRef.current = fetchedAt
    }
  }, [status?.accounts, status?.accounts_fetched_at, accountsDisplay])

  useEffect(() => {
    const t = setInterval(() => {
      loadStatus().then((j) => setAccountsDisplay(j?.accounts ? [...j.accounts] : []))
    }, 60 * 60 * 1000)
    return () => clearInterval(t)
  }, [loadStatus])

  useEffect(() => {
    if (accountsRefreshFeedback == null) return
    const t = setTimeout(() => setAccountsRefreshFeedback(null), 5000)
    return () => clearTimeout(t)
  }, [accountsRefreshFeedback])

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
        if (j?.accounts != null) setAccountsDisplay(j.accounts ? [...j.accounts] : [])
        if (j?.accounts_fetched_at != null && j.accounts_fetched_at > requestedAt) {
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
  // System status lamp: green only when daemon/monitor/status all green; otherwise worst of the three
  const dl = (j?.daemon_lamp as 'green' | 'yellow' | 'red') || 'red'
  const ml = (j?.monitor_lamp as 'green' | 'yellow' | 'red') || 'red'
  // Strategy tab lamp = Trading Strategy status (same as System → Daemon Event → Trading Strategy)
  const hb = j?.daemon_heartbeat
  const strategyLamp: LampId =
    !hb || !hb.daemon_alive ? 'red' : j?.trading_suspended === true ? 'yellow' : 'green'
  const celeryLamp: LampId =
    status?.celery_broker_connected
      ? ((status?.celery_workers?.length ?? 0) > 0 ? 'green' : 'yellow')
      : 'red'
  const cl = celeryLamp as 'green' | 'yellow' | 'red'
  const systemLamp: 'green' | 'yellow' | 'red' | 'none' = (() => {
    if (dl === 'red' || ml === 'red' || cl === 'red') return 'red'
    if (dl === 'yellow' || ml === 'yellow' || cl === 'yellow') return 'yellow'
    return dl === 'green' && ml === 'green' && cl === 'green' ? 'green' : 'none'
  })()
  const daemonHeartbeat = status?.daemon_heartbeat
  // Market Streams: green only when daemon is alive, subscribed to ticker, and monitor can read Redis quotes
  const liveLamp: LampId =
    status?.redis_quotes_connected === true &&
    daemonHeartbeat?.daemon_alive === true &&
    daemonHeartbeat?.event_subscribe_ticker === true
      ? 'green'
      : 'red'

  const watchlistSymbols = useMemo(
    () => [...new Set([...(status?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort(),
    [status?.subscribed_tickers, quotesMap],
  )
  const benchmarkSymbols = useMemo(
    () =>
      [
        ...new Set([
          ...watchlistSymbols,
          ...(status?.reference_indices?.map((r) => r.symbol) ?? []),
        ]),
      ].sort(),
    [watchlistSymbols, status?.reference_indices],
  )
  const streamSummaryItems = useMemo<StreamSummaryItem[]>(() => {
    const accountsList = status?.accounts ?? []
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
      const quote = quotesMap[symbol]
      const bench = benchmarks[symbol]
      let changePct: number | null = null
      let pnlVsBench: number | null = null
      const qLast = quote?.last
      if (
        bench &&
        quote &&
        qLast != null &&
        Number.isFinite(qLast) &&
        Number.isFinite(bench.close) &&
        bench.close > 0
      ) {
        changePct = ((qLast - bench.close) / bench.close) * 100
        pnlVsBench = Number.isFinite(qty) ? (qLast - bench.close) * qty : null
      }
      const pnlCost =
        quote && avgCost != null && qLast != null && Number.isFinite(qLast) && Number.isFinite(qty) && qty !== 0
          ? (qLast - avgCost) * qty
          : null
      return { qty, avgCost, pnlCost, pnlVsBench, changePct }
    })

    const totalDailyDollar = rows.reduce(
      (acc, row) => acc + (row.pnlVsBench != null && Number.isFinite(row.pnlVsBench) ? row.pnlVsBench : 0),
      0,
    )
    const sumLastQty = watchlistSymbols.reduce((acc, symbol, index) => {
      const qty = Number.isFinite(rows[index]?.qty) ? rows[index]!.qty : 0
      const last =
        quotesMap[symbol]?.last != null && Number.isFinite(quotesMap[symbol].last)
          ? quotesMap[symbol].last
          : 0
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
        value: liveLamp === 'green' ? 'Online' : 'Offline',
        tone: liveLamp === 'green' ? 'positive' : 'negative',
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
  }, [status?.accounts, status?.reference_indices, watchlistSymbols, quotesMap, benchmarks, liveLamp])

  useEffect(() => {
    if (benchmarkSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(benchmarkSymbols)
      .then((res) => {
        if (!cancelled) setBenchmarks(res.benchmarks ?? {})
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [benchmarkSymbols.join(',')])

  const tabList: { id: TabId; label: string; lamp?: 'green' | 'yellow' | 'red' | 'none' }[] = [
    { id: 'live', label: 'Live', lamp: liveLamp },
    { id: 'strategy', label: 'Strategy', lamp: strategyLamp },
    { id: 'replay', label: 'Portfolio' },
    { id: 'research', label: 'Research' },
  ]

  /** Research dropdown: Discovery vs Risk & tools (same pattern as Strategy / Portfolio groups). */
  const researchSubmenuGroups: {
    id: string
    label: string
    items: { id: 'risk' | 'screener' | 'backtest' | 'options'; label: string }[]
  }[] = [
    {
      id: 'discovery',
      label: 'Discovery',
      items: [
        { id: 'screener', label: 'Screener' },
        { id: 'options', label: 'Option Discovery' },
      ],
    },
    {
      id: 'risk-tools',
      label: 'Risk & tools',
      items: [
        { id: 'risk', label: 'Risk Model' },
        { id: 'backtest', label: 'Backtest' },
      ],
    },
  ]

  /** Strategy dropdown: one level with section labels (operations vs configuration). */
  const strategySubmenuGroups: {
    id: string
    label: string
    items: { id: 'structure' | 'opportunity' | 'allocations' | 'gates' | 'watchlist' | 'typeConfig' | 'instances'; label: string }[]
  }[] = [
    {
      id: 'operations',
      label: 'Operations',
      items: [
        { id: 'watchlist', label: 'Watchlist' },
        { id: 'instances', label: 'Instances' },
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
        { id: 'typeConfig', label: 'Option Type Config' },
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

  const openSystemInSettings = () => {
    setActiveTab('settings')
    window.location.hash = '#settings-system'
  }

  /** Open Settings → first Configuration section (Daemon App). Used by header menu "Settings". */
  const openSettingsToConfiguration = () => {
    setActiveTab('settings')
    window.location.hash = '#settings-heartbeat'
  }

  /** Open Settings → System Status sub-page (System / Daemon / Celery). `#settings-system-server` = System (management monitor). */
  const openSystemInSettingsToSection = (section: 'system' | 'daemon' | 'celery') => {
    setActiveTab('settings')
    const hashSeg =
      section === 'system' ? 'server' : section === 'daemon' ? 'daemon' : 'celery'
    window.location.hash = `#settings-system-${hashSeg}`
  }

  const doShutdownAll = async () => {
    setShutdownConfirmOpen(false)
    setShutdownAllLoading(true)
    const errors: string[] = []
    try {
      setShutdownAllMsg({ text: 'Stopping Celery…', isErr: false })
      const r3 = await postCeleryStop()
      if (!r3.ok) errors.push(`Celery: ${r3.error ?? r3.statusText ?? 'failed'}`)
      setShutdownAllMsg({ text: 'Stopping Daemon…', isErr: false })
      const r1 = await postStop()
      if (!r1.ok) errors.push(`Daemon: ${r1.error ?? r1.statusText ?? 'failed'}`)
      setShutdownAllMsg({ text: 'Stopping Management…', isErr: false })
      const r2 = await postMonitorStop()
      if (!r2.ok) errors.push(`Management: ${r2.error ?? r2.statusText ?? 'failed'}`)
      setShutdownAllMsg({
        text: errors.length === 0 ? 'All systems shut down.' : `Shut down requested; some failed: ${errors.join('; ')}`,
        isErr: errors.length > 0,
      })
    } finally {
      setShutdownAllLoading(false)
    }
  }

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

  const renderTabButton = (id: TabId, label: string, lamp?: 'green' | 'yellow' | 'red' | 'none') => (
    <button
      key={id}
      type="button"
      className={`app-tab ${activeTab === id ? 'active' : ''}`}
      onClick={() => setActiveTab(id)}
      aria-current={activeTab === id ? 'page' : undefined}
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
      {shutdownConfirmOpen && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => setShutdownConfirmOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="shutdown-modal-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="shutdown-modal-title">Shutdown entire system?</h3>
            <p>
              Celery, then Daemon, then Management will be stopped in order. This cannot be undone.
            </p>
            <div className="data-reset-modal-actions">
              <button type="button" className="btn btn-secondary" onClick={() => setShutdownConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" className="btn-shutdown-all" onClick={doShutdownAll}>
                Shutdown
              </button>
            </div>
            {shutdownAllMsg.text ? (
              <p className={`status-page-msg ${shutdownAllMsg.isErr ? 'err' : 'ok'}`}>{shutdownAllMsg.text}</p>
            ) : null}
          </div>
        </div>
      )}
      {!isStrategyInstanceDetailMode && (
      <header className="app-header">
        <div className="app-header-left">
          <img src={logoImg} alt="Bifrost Trader" className="app-logo" />
          <nav className="app-tabs" aria-label="Live, Strategy, Portfolio, Research">
            {tabList.map(({ id, label, lamp }) => {
              if (id === 'replay') {
                return (
                  <div key={id} className={`app-tab-group ${activeTab === id ? 'active' : ''}`}>
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
                )
              }
              if (id === 'research') {
                return (
                  <div key={id} className={`app-tab-group ${activeTab === id ? 'active' : ''}`}>
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
                )
              }
              if (id === 'strategy') {
                return (
                  <div key={id} className={`app-tab-group ${activeTab === id ? 'active' : ''}`}>
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
                )
              }

              return renderTabButton(id, label, lamp)
            })}
          </nav>
        </div>
        <div className="app-header-right" ref={headerMenuRef}>
          <div className="app-header-system-lamps-wrap" ref={systemLampRef}>
            <div className="app-header-lamp-stop-group" aria-label="System status">
              <div
                className="app-header-lamp-stop-lamp-wrap"
                onMouseEnter={() => openLampPopover('monitor')}
                onMouseLeave={closeLampPopover}
              >
                <span
                  className={`lamp-icon ${(status?.monitor_lamp as LampId) ?? 'red'}`}
                  aria-hidden
                  title="Management → System"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                    <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                    <circle cx="6" cy="6" r="1" fill="currentColor" strokeWidth="0" />
                    <circle cx="6" cy="18" r="1" fill="currentColor" strokeWidth="0" />
                  </svg>
                </span>
                {lampHoverPopover === 'monitor' && (
                  <div className="app-header-lamp-popover" role="tooltip">
                    <button
                      type="button"
                      className="app-header-lamp-popover-name app-header-lamp-popover-name-link"
                      onClick={() => { openSystemInSettingsToSection('system'); setLampHoverPopover(null) }}
                      title="Go to System Status → System"
                    >
                      Management → System
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="app-header-lamp-switch"
                onClick={() => runQuickStop(postMonitorStop, 'Stop System')}
                title="Stop System"
                aria-label="Stop System"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="app-header-lamp-stop-group" aria-label="Daemon status">
              <div
                className="app-header-lamp-stop-lamp-wrap"
                onMouseEnter={() => openLampPopover('daemon')}
                onMouseLeave={closeLampPopover}
              >
                <span
                  className={`lamp-icon ${(status?.daemon_lamp as LampId) ?? 'red'}`}
                  aria-hidden
                  title="Daemon status"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
                    <path d="M8 5v14l11-7L8 5z" />
                  </svg>
                </span>
                {lampHoverPopover === 'daemon' && (
                  <div className="app-header-lamp-popover" role="tooltip">
                    <button
                      type="button"
                      className="app-header-lamp-popover-name app-header-lamp-popover-name-link"
                      onClick={() => { openSystemInSettingsToSection('daemon'); setLampHoverPopover(null) }}
                      title="Go to System Status → Daemon"
                    >
                      Daemon
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="app-header-lamp-switch"
                onClick={() => runQuickStop(postStop, 'Stop Daemon')}
                title="Stop Daemon"
                aria-label="Stop Daemon"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="app-header-lamp-stop-group" aria-label="Celery status">
              <div
                className="app-header-lamp-stop-lamp-wrap"
                onMouseEnter={() => openLampPopover('celery')}
                onMouseLeave={closeLampPopover}
              >
                <span
                  className={`lamp-icon ${celeryLamp}`}
                  title="Celery: red = broker not connected, yellow = no workers, green = broker + workers OK"
                  aria-hidden
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                </span>
                {lampHoverPopover === 'celery' && (
                  <div className="app-header-lamp-popover" role="tooltip">
                    <button
                      type="button"
                      className="app-header-lamp-popover-name app-header-lamp-popover-name-link"
                      onClick={() => { openSystemInSettingsToSection('celery'); setLampHoverPopover(null) }}
                      title="Go to System Status → Celery"
                    >
                      Celery
                    </button>
                  </div>
                )}
              </div>
              <button
                type="button"
                className="app-header-lamp-switch"
                onClick={() => runQuickStop(postCeleryStop, 'Stop Celery')}
                title="Stop Celery"
                aria-label="Stop Celery"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
              <span
                className="app-header-queue-value"
                title="Pending jobs (hover lamp for Celery)"
              >
                {workerJobPending != null ? (workerJobPending > 99 ? '99+' : String(workerJobPending)) : '—'}
              </span>
            </div>
          </div>
          {quickCtrlMsg.text ? (
            <span className={`app-header-system-msg ${quickCtrlMsg.isErr ? 'err' : ''}`}>{quickCtrlMsg.text}</span>
          ) : null}
          <button
            type="button"
            className={`app-header-icon-btn ${headerMenuOpen ? 'active' : ''} ${activeTab === 'settings' ? 'active' : ''}`}
            onClick={() => setHeaderMenuOpen((o) => !o)}
            title="Menu"
            aria-label="Open menu"
            aria-expanded={headerMenuOpen}
            aria-haspopup="menu"
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <circle cx="12" cy="12" r="1" />
              <circle cx="12" cy="5" r="1" />
              <circle cx="12" cy="19" r="1" />
            </svg>
          </button>
          {headerMenuOpen && (
            <div className="app-header-menu" role="menu" aria-label="App menu">
              <div
                className={`app-header-menu-row-system ${activeTab === 'settings' && settingsViewSection === 'system' ? 'active' : ''}`}
                role="presentation"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="app-header-menu-item app-header-menu-item-system"
                  onClick={() => { openSystemInSettings(); setHeaderMenuOpen(false) }}
                >
                  <span className={`app-header-menu-system-lamp title-inline-lamp ${systemLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </span>
                  System Status
                </button>
                <button
                  type="button"
                  className="app-header-lamp-switch app-header-menu-shutdown"
                  onClick={() => { setShutdownConfirmOpen(true); setHeaderMenuOpen(false) }}
                  disabled={shutdownAllLoading}
                  title="Shutdown entire system"
                  aria-label="Shutdown entire system"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                    <line x1="12" y1="2" x2="12" y2="12" />
                  </svg>
                </button>
              </div>
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item app-header-menu-item-massive ${activeTab === 'settings' && settingsViewSection === 'massive' ? 'active' : ''}`}
                onClick={() => {
                  setActiveTab('settings')
                  window.location.hash = `#${FEED_MASSIVE_OPTION_ID}`
                  setHeaderMenuOpen(false)
                }}
                title="Settings → Feed → Massive Option"
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                  <polyline points="22 12 18 12 15 21 9 3 6 9 2 9" />
                </svg>
                Massive Option
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
              <div className="app-header-menu-label" role="presentation">Theme</div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={theme === 'dark'}
                className={`app-header-menu-item ${theme === 'dark' ? 'active' : ''}`}
                onClick={() => { setTheme('dark'); setHeaderMenuOpen(false) }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                </svg>
                Dark
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={theme === 'light'}
                className={`app-header-menu-item ${theme === 'light' ? 'active' : ''}`}
                onClick={() => { setTheme('light'); setHeaderMenuOpen(false) }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden style={{ flexShrink: 0 }}>
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
                Light
              </button>
              <div className="app-header-menu-divider" role="separator" />
              <a
                href="/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="app-header-menu-item"
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
            </div>
          )}
        </div>
      </header>
      )}

      {!isStrategyInstanceDetailMode && (activeTab === 'live' || activeTab === 'strategy' || activeTab === 'replay' || activeTab === 'research') && (
        <DashboardStrip
          streamLamp={liveLamp}
          streamItems={streamSummaryItems}
          onStreamClick={() => setActiveTab('live')}
          openOrderCount={(status?.open_orders ?? []).length}
          onOpenOrdersClick={() => setActiveTab('live')}
          openOrdersLamp={status?.daemon_heartbeat?.daemon_alive === true ? 'green' : 'red'}
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
            />
          )}
        </>
      )}

      {activeTab === 'research' && researchView === 'risk' && (
        <ResearchRiskAnalysisPage
          onGoToScreener={() => setResearchView('screener')}
          breadcrumbLabel="Risk Model"
        />
      )}

      {activeTab === 'research' && researchView === 'screener' && (
        <MarketDataPage
          status={status}
          onGoToScreener={() => setResearchView('screener')}
          breadcrumbLabel="Screener"
        />
      )}

      {activeTab === 'research' && researchView === 'backtest' && (
        <BacktestPage
          status={status}
          onGoToScreener={() => setResearchView('screener')}
          breadcrumbLabel="Backtest"
        />
      )}

      {activeTab === 'research' && researchView === 'options' && (
        <OptionDiscoveryPage
          status={status}
          onGoToScreener={() => setResearchView('screener')}
          breadcrumbLabel="Option Discovery"
        />
      )}

      {activeTab === 'strategy' && strategyView === 'structure' && (
        <StrategyStructurePage
          status={status}
          loadStatus={loadStatus}
          breadcrumbLabel="Structure"
        />
      )}

      {activeTab === 'strategy' && strategyView === 'opportunity' && (
        <StrategyOpportunityPage
          status={status}
          loadStatus={loadStatus}
          breadcrumbLabel="Opportunity"
          urlFocusOpportunityId={urlStrategyOpportunityId}
        />
      )}

      {activeTab === 'strategy' && strategyView === 'instances' && (
        <StrategyInstancesPage
          status={status}
          loadStatus={loadStatus}
          urlStrategyInstanceId={urlStrategyInstanceId}
          onNavigateToStrategy={() => { setActiveTab('strategy'); setStrategyView('structure') }}
          breadcrumbLabel="Instances"
        />
      )}

      {activeTab === 'strategy' && strategyView === 'allocations' && (
        <StrategyAllocationPage
          status={status}
          loadStatus={loadStatus}
          breadcrumbLabel="Allocations"
        />
      )}

      {activeTab === 'strategy' && strategyView === 'gates' && (
        <GatesConfigPage
          status={status}
          loadStatus={loadStatus}
          onGoToStrategy={() => { setActiveTab('strategy'); setStrategyView('structure') }}
          breadcrumbLabel="Gates"
        />
      )}

      {activeTab === 'strategy' && strategyView === 'watchlist' && (
        <WatchlistPage status={status} />
      )}

      {activeTab === 'strategy' && strategyView === 'typeConfig' && (
        <StructureTypeConfigPage breadcrumbLabel="Option Type Config" />
      )}

      {activeTab === 'live' && (
        <LivePage
          status={status}
          onNavigateToStrategy={() => { setActiveTab('strategy'); setStrategyView('structure') }}
        />
      )}

      {activeTab === 'settings' && (
        <SettingsPage
          status={status}
          loadStatus={loadStatus}
          operations={operations}
          onNavigateToStrategy={() => { setActiveTab('strategy'); setStrategyView('structure') }}
          barsQueuePending={workerJobPending}
          barsQueueRunning={workerJobRunning}
          systemLamp={systemLamp}
          onOpenShutdownConfirm={() => setShutdownConfirmOpen(true)}
        />
      )}
    </div>
  )
}
