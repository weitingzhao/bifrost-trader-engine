import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import type { IbAccountSnapshot, StatusResponse, Operation, RealtimeQuote } from './types'
import {
  fetchStatus,
  fetchOperations,
  postRefreshAccounts,
  fetchQuotes,
  subscribeQuotes,
  fetchBarsBenchmark,
  fetchBarsJobs,
} from './api'
import { StatusPage, type ConsoleSection, type OperationsSection } from './pages/StatusPage'
import { LivePage } from './pages/LivePage'
import { AccountsPage } from './pages/AccountsPage'
import { MarketDataPage } from './pages/MarketDataPage'
import { DataPage } from './pages/DataPage'
import { PositionsPage } from './pages/PositionsPage'
import { TradeHistoryPage } from './pages/TradeHistoryPage'
import type { PortfolioView } from './pages/portfolio/types'
import { PerformancePage } from './pages/PerformancePage'
import { ResearchRiskAnalysisPage } from './pages/ResearchRiskAnalysisPage'
import { SettingsPage } from './pages/SettingsPage'
import { TransferPayPage } from './pages/TransferPayPage'
import { BacktestPage } from './pages/BacktestPage'
import { WatchlistPage } from './pages/WatchlistPage'
import { MainTabIcon, SubmenuIcon, type TabId } from './components/AppNavIcons'
import logoImg from '../img/logo.png'
import { fmtPctCompact, fmtUsdCompact } from './utils/format'
import './App.css'

const THEME_KEY = 'bifrost-monitor-theme'
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

type LampId = 'green' | 'yellow' | 'red' | 'none'

interface DashboardItem {
  id: OperationsSection
  label: string
  lamp: LampId
}

type StreamTone = 'neutral' | 'positive' | 'negative'

interface StreamSummaryItem {
  label: string
  value: string
  tone: StreamTone
}

function SystemDashboard({
  items,
  onOpenSection,
  onOpenSectionWithConsole,
  streamLamp,
  streamItems,
  onStreamClick,
  workerPending,
  workerRunning,
}: {
  items: DashboardItem[]
  onOpenSection: (section: OperationsSection) => void
  onOpenSectionWithConsole?: (section: OperationsSection, consoleSection: ConsoleSection) => void
  streamLamp: LampId
  streamItems: StreamSummaryItem[]
  onStreamClick?: () => void
  workerPending?: number | null
  workerRunning?: number | null
}) {
  const tickerItems = streamItems.length > 0
    ? [...streamItems, ...streamItems]
    : [
        { label: 'Streams', value: 'No data', tone: 'neutral' as const },
        { label: 'Streams', value: 'No data', tone: 'neutral' as const },
      ]

  return (
    <section className="card dashboard-strip" aria-label="Status dashboard">
      <div className="dashboard-strip-grid">
        <div className="dashboard-system-cluster">
          <span className="dashboard-group-label">Sys</span>
          <div className="dashboard-system-chips">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="dashboard-chip"
                onClick={() => onOpenSection(item.id)}
                aria-label={`Open Status detail for ${item.label}`}
              >
                <span className={`lamp lamp-sm ${item.lamp}`} aria-hidden />
                <span className="dashboard-chip-label" aria-hidden>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="dashboard-worker-cluster" aria-label="Celery bars worker queue">
          <div className="dashboard-worker-counts">
            <button
              type="button"
              className="dashboard-worker-item dashboard-worker-item-btn"
              onClick={() => (onOpenSectionWithConsole ? onOpenSectionWithConsole('celery', 'console') : onOpenSection('celery'))}
              aria-label="Open Status and Celery Console"
            >
              <span className="dashboard-worker-label">Pending</span>
              <span className="dashboard-worker-value">{workerPending != null ? String(workerPending) : '—'}</span>
            </button>
            <button
              type="button"
              className="dashboard-worker-item dashboard-worker-item-btn"
              onClick={() => onOpenSection('celery')}
              aria-label="Open Celery detail"
            >
              <span className="dashboard-worker-label">Running</span>
              <span className="dashboard-worker-value">{workerRunning != null ? String(workerRunning) : '—'}</span>
            </button>
          </div>
        </div>

        <div className="dashboard-streams-cluster" aria-label="Market streams summary">
          <button
            type="button"
            className="dashboard-streams-inline dashboard-streams-btn"
            onClick={onStreamClick}
            aria-label="Go to Live page"
            title="Go to Live page"
          >
            <span className={`lamp lamp-sm ${streamLamp}`} aria-hidden />
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

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('system')
  const [operationsSection, setOperationsSection] = useState<OperationsSection>('daemon')
  const [consoleSection, setConsoleSection] = useState<ConsoleSection>('daemon-console')
  const [portfolioView, setPortfolioView] = useState<PortfolioView>('accounts')
  const [researchView, setResearchView] = useState<'risk' | 'screener' | 'data' | 'backtest'>('risk')
  const [theme, setTheme] = useState<ThemeId>(loadTheme)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [ibAccountIndex, setIbAccountIndex] = useState(0)
  const [accountsDisplay, setAccountsDisplay] = useState<IbAccountSnapshot[] | null>(null)
  const [ibAccountsRefreshing, setIbAccountsRefreshing] = useState(false)
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [benchmarks, setBenchmarks] = useState<Record<string, { bar_time: number; close: number; prev_close?: number | null; is_today?: boolean; is_stale?: boolean }>>({})
  /** Short feedback after account refresh (success/fail/timeout); auto-cleared after a few seconds */
  const [accountsRefreshFeedback, setAccountsRefreshFeedback] = useState<string | null>(null)
  /** Celery bars worker queue counts (polled every 3s for dashboard) */
  const [workerJobPending, setWorkerJobPending] = useState<number | null>(null)
  const [workerJobRunning, setWorkerJobRunning] = useState<number | null>(null)
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false)
  const headerMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!headerMenuOpen) return
    const onDocClick = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) setHeaderMenuOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [headerMenuOpen])

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

  useEffect(() => {
    loadStatus()
    loadOperations()
    const t1 = setInterval(loadStatus, 5000)
    const t2 = setInterval(loadOperations, 10000)
    return () => {
      clearInterval(t1)
      clearInterval(t2)
    }
  }, [loadStatus, loadOperations])

  useEffect(() => {
    const pollWorkerJobs = () => {
      Promise.all([
        fetchBarsJobs(1, 0, 'pending'),
        fetchBarsJobs(1, 0, 'running'),
      ]).then(([pendingRes, runningRes]) => {
        setWorkerJobPending(pendingRes.total)
        setWorkerJobRunning(runningRes.total)
      }).catch(() => {
        setWorkerJobPending(null)
        setWorkerJobRunning(null)
      })
    }
    pollWorkerJobs()
    const t = setInterval(pollWorkerJobs, 3000)
    return () => clearInterval(t)
  }, [])

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

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) {
          setQuotesMap(() => Object.fromEntries(res.quotes.map((q) => [q.symbol, q])))
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
  }, [])

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
  const strategyLamp: LampId = 'green'
  const systemLamp: 'green' | 'yellow' | 'red' | 'none' =
    dl === 'red' || ml === 'red'
      ? 'red'
      : dl === 'yellow' || ml === 'yellow'
        ? 'yellow'
        : dl === 'green' && ml === 'green'
          ? 'green'
          : 'none'

  const celeryLamp: LampId =
    status?.celery_broker_connected
      ? ((status?.celery_workers?.length ?? 0) > 0 ? 'green' : 'yellow')
      : 'red'
  const daemonHeartbeat = status?.daemon_heartbeat
  const watchlistSymbols = useMemo(
    () => [...new Set([...(status?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort(),
    [status?.subscribed_tickers, quotesMap],
  )
  const benchmarkSymbols = useMemo(
    () =>
      [...new Set([...watchlistSymbols, ...(status?.reference_indices?.map((r) => r.symbol) ?? [])])].sort(),
    [watchlistSymbols, status?.reference_indices],
  )
  // Market Streams: green only when daemon is alive, subscribed to ticker, and monitor can read Redis quotes
  const liveLamp: LampId =
    status?.redis_quotes_connected === true &&
    daemonHeartbeat?.daemon_alive === true &&
    daemonHeartbeat?.event_subscribe_ticker === true
      ? 'green'
      : 'red'

  const dashboardItems: DashboardItem[] = [
    {
      id: 'daemon',
      label: 'Daemon',
      lamp: (status?.daemon_lamp as LampId | undefined) ?? 'red',
    },
    {
      id: 'monitor',
      label: 'Management',
      lamp: (status?.monitor_lamp as LampId | undefined) ?? 'red',
    },
    {
      id: 'celery',
      label: 'Celery',
      lamp: celeryLamp,
    },
    {
      id: 'strategy',
      label: 'Trading Strategy',
      lamp: strategyLamp,
    },
  ]

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
      if (bench && quote && Number.isFinite(quote.last) && Number.isFinite(bench.close) && bench.close > 0) {
        changePct = ((quote.last - bench.close) / bench.close) * 100
        pnlVsBench = Number.isFinite(qty) ? (quote.last - bench.close) * qty : null
      }
      const pnlCost =
        quote && avgCost != null && Number.isFinite(quote.last) && Number.isFinite(qty) && qty !== 0
          ? (quote.last - avgCost) * qty
          : null
      return { qty, avgCost, pnlCost, pnlVsBench, changePct }
    })

    const totalDailyDollar = rows.reduce((acc, row) => acc + (row.pnlVsBench != null && Number.isFinite(row.pnlVsBench) ? row.pnlVsBench : 0), 0)
    const sumLastQty = watchlistSymbols.reduce((acc, symbol, index) => {
      const qty = Number.isFinite(rows[index]?.qty) ? rows[index].qty : 0
      const last = quotesMap[symbol]?.last != null && Number.isFinite(quotesMap[symbol].last) ? quotesMap[symbol].last : 0
      return acc + last * qty
    }, 0)
    const totalDailyDenom = sumLastQty - totalDailyDollar
    const totalDailyPct = totalDailyDenom > 0 && Number.isFinite(totalDailyDollar)
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
  }, [status?.accounts, watchlistSymbols, quotesMap, benchmarks, liveLamp])

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
    { id: 'system', label: 'Status', lamp: systemLamp },
    { id: 'live', label: 'Live', lamp: liveLamp },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'replay', label: 'Portfolio' },
    { id: 'research', label: 'Research' },
  ]

  const researchSubtabs: { id: 'risk' | 'screener' | 'data' | 'backtest'; label: string }[] = [
    { id: 'screener', label: 'Screener' },
    { id: 'risk', label: 'Risk Model' },
    { id: 'data', label: 'Data' },
    { id: 'backtest', label: 'Backtest' },
  ]

  const portfolioSubtabs: { id: PortfolioView; label: string }[] = [
    { id: 'accounts', label: 'Accounts' },
    { id: 'open', label: 'Positions' },
    { id: 'performance', label: 'Performance' },
    { id: 'ledger', label: 'Trade History' },
    { id: 'transfer', label: 'Transfer & Pay' },
  ]

  const openSystemSection = (section: OperationsSection) => {
    setActiveTab('system')
    setOperationsSection(section)
  }

  const openSystemSectionWithConsole = (section: OperationsSection, consoleSection: ConsoleSection) => {
    setActiveTab('system')
    setOperationsSection(section)
    setConsoleSection(consoleSection)
  }

  const showDashboard = activeTab !== 'system'

  const renderTabButton = (id: TabId, label: string, lamp?: 'green' | 'yellow' | 'red' | 'none') => (
    <button
      key={id}
      type="button"
      className={`app-tab ${activeTab === id ? 'active' : ''}`}
      onClick={() => setActiveTab(id)}
      aria-current={activeTab === id ? 'page' : undefined}
    >
      <MainTabIcon id={id} />
      {lamp != null && <span className={`lamp lamp-sm ${lamp}`} aria-hidden />}
      <span>{label}</span>
    </button>
  )

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <img src={logoImg} alt="Bifrost Trader" className="app-logo" />
          <nav className="app-tabs" aria-label="Status, Live, Watchlist, Portfolio, Research">
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
                      {portfolioSubtabs.map(({ id: viewId, label: viewLabel }) => (
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
                      {researchSubtabs.map(({ id: viewId, label: viewLabel }) => (
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
                  </div>
                )
              }

              return renderTabButton(id, label, lamp)
            })}
          </nav>
        </div>
        <div className="app-header-right" ref={headerMenuRef}>
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
              <button
                type="button"
                role="menuitem"
                className={`app-header-menu-item ${activeTab === 'settings' ? 'active' : ''}`}
                onClick={() => { setActiveTab('settings'); setHeaderMenuOpen(false) }}
              >
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
                Dark
              </button>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={theme === 'light'}
                className={`app-header-menu-item ${theme === 'light' ? 'active' : ''}`}
                onClick={() => { setTheme('light'); setHeaderMenuOpen(false) }}
              >
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
                Docs
              </a>
            </div>
          )}
        </div>
      </header>

      {showDashboard && (
        <SystemDashboard
          items={dashboardItems}
          onOpenSection={openSystemSection}
          onOpenSectionWithConsole={openSystemSectionWithConsole}
          streamLamp={liveLamp}
          streamItems={streamSummaryItems}
          onStreamClick={() => setActiveTab('live')}
          workerPending={workerJobPending}
          workerRunning={workerJobRunning}
        />
      )}

      {activeTab === 'system' && (
        <StatusPage
          status={status}
          operations={operations}
          loadStatus={loadStatus}
          onNavigateToSettings={() => setActiveTab('settings')}
          currentSection={operationsSection}
          onSectionChange={setOperationsSection}
          showSectionTabs={false}
          showAllSystemSections={true}
          showSystemSection={true}
          showConsoleSection={true}
          currentConsoleSection={consoleSection}
          onConsoleSectionChange={setConsoleSection}
          showConsoleTabs={true}
          consoleCardTitle="Console"
          consoleCardDescription="Consoles for each subsystem, Recent Operations, and Event Subscribe."
        />
      )}

      {activeTab === 'replay' && (
        <>
          {/* Portfolio sub-pages: each menu item → one page component (AccountsPage, PositionsPage, PerformancePage, TradeHistoryPage, TransferPayPage). */}
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

      {activeTab === 'research' && researchView === 'data' && (
        <DataPage
          status={status}
          onGoToScreener={() => setResearchView('screener')}
          breadcrumbLabel="Data"
        />
      )}

      {activeTab === 'research' && researchView === 'backtest' && (
        <BacktestPage
          status={status}
          onGoToScreener={() => setResearchView('screener')}
          breadcrumbLabel="Backtest"
        />
      )}

      {activeTab === 'live' && (
        <LivePage status={status} />
      )}

      {activeTab === 'watchlist' && (
        <WatchlistPage status={status} />
      )}

      {activeTab === 'settings' && (
        <SettingsPage status={status} loadStatus={loadStatus} />
      )}
    </div>
  )
}
