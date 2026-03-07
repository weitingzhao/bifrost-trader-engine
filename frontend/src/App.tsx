import { useEffect, useState, useCallback, useMemo } from 'react'
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
import { DaemonMonitorPage, type ConsoleSection, type OperationsSection } from './pages/DaemonMonitorPage'
import { IbAccountsPage } from './pages/IbAccountsPage'
import { MarketDataPage } from './pages/MarketDataPage'
import { DataPage } from './pages/DataPage'
import { PositionPnlPage, type PortfolioView } from './pages/PositionPnlPage'
import { SettingsPage } from './pages/SettingsPage'
import { WatchlistPage } from './pages/WatchlistPage'
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

type TabId = 'system' | 'live' | 'watchlist' | 'ib' | 'replay' | 'market' | 'data' | 'settings'
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

function fmtUsdCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '--'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

function fmtPctCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '--'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function SystemDashboard({
  items,
  onOpenSection,
  onOpenSectionWithConsole,
  streamLamp,
  streamItems,
  workerPending,
  workerRunning,
}: {
  items: DashboardItem[]
  onOpenSection: (section: OperationsSection) => void
  onOpenSectionWithConsole?: (section: OperationsSection, consoleSection: ConsoleSection) => void
  streamLamp: LampId
  streamItems: StreamSummaryItem[]
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
    <section className="card dashboard-strip" aria-label="System status dashboard">
      <div className="dashboard-strip-grid">
        <div className="dashboard-system-cluster">
          <span className="dashboard-group-label">System</span>
          <div className="dashboard-system-chips">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="dashboard-chip"
                onClick={() => onOpenSection(item.id)}
                aria-label={`Open System detail for ${item.label}`}
              >
                <span className={`lamp lamp-sm ${item.lamp}`} aria-hidden />
                <span className="dashboard-chip-label" aria-hidden>{item.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="dashboard-worker-cluster" aria-label="Celery bars worker queue">
          <span className="dashboard-group-label">Worker</span>
          <div className="dashboard-worker-counts">
            <button
              type="button"
              className="dashboard-worker-item dashboard-worker-item-btn"
              onClick={() => (onOpenSectionWithConsole ? onOpenSectionWithConsole('celery', 'console') : onOpenSection('celery'))}
              aria-label="Open System and Celery Console"
            >
              <span className="dashboard-worker-label">Pending</span>
              <span className="dashboard-worker-value">{workerPending != null ? String(workerPending) : '—'}</span>
            </button>
            <button
              type="button"
              className="dashboard-worker-item dashboard-worker-item-btn"
              onClick={() => onOpenSection('celery')}
              aria-label="Open System Celery detail"
            >
              <span className="dashboard-worker-label">Running</span>
              <span className="dashboard-worker-value">{workerRunning != null ? String(workerRunning) : '—'}</span>
            </button>
          </div>
        </div>

        <div className="dashboard-streams-cluster" aria-label="Market streams summary">
          <span className="dashboard-group-label">Streams</span>
          <div className="dashboard-streams-inline">
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
          </div>
        </div>
      </div>
    </section>
  )
}

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('system')
  const [operationsSection, setOperationsSection] = useState<OperationsSection>('daemon')
  const [consoleSection, setConsoleSection] = useState<ConsoleSection>('daemon-console')
  const [portfolioView, setPortfolioView] = useState<PortfolioView>('overview')
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
  const liveLamp: LampId =
    status?.redis_quotes_connected === true && daemonHeartbeat?.event_subscribe_ticker === true
      ? 'green'
      : 'red'
  const watchlistSymbols = useMemo(
    () => [...new Set([...(status?.subscribed_tickers ?? []), ...Object.keys(quotesMap)])].sort(),
    [status?.subscribed_tickers, quotesMap],
  )

  useEffect(() => {
    if (watchlistSymbols.length === 0) {
      setBenchmarks({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(watchlistSymbols)
      .then((res) => {
        if (!cancelled) setBenchmarks(res.benchmarks ?? {})
      })
      .catch(() => {
        if (!cancelled) setBenchmarks({})
      })
    return () => {
      cancelled = true
    }
  }, [watchlistSymbols.join(',')])

  const tabList: { id: TabId; label: string; lamp?: 'green' | 'yellow' | 'red' | 'none' }[] = [
    { id: 'system', label: 'System', lamp: systemLamp },
    { id: 'live', label: 'Live', lamp: liveLamp },
    { id: 'watchlist', label: 'Watchlist' },
    { id: 'replay', label: 'Portfolio' },
    { id: 'ib', label: 'Accounts' },
    { id: 'market', label: 'Market' },
    { id: 'data', label: 'Data' },
    { id: 'settings', label: 'Settings' },
  ]

  const portfolioSubtabs: { id: PortfolioView; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'open', label: 'Open Positions' },
    { id: 'ledger', label: 'Trade Ledger' },
  ]

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

    const totalCostPnl = rows.reduce((acc, row) => acc + (row.pnlCost != null && Number.isFinite(row.pnlCost) ? row.pnlCost : 0), 0)
    const totalCost = rows.reduce((acc, row) => {
      const qty = Number.isFinite(row.qty) ? row.qty : 0
      const cost = row.avgCost != null && Number.isFinite(row.avgCost) ? row.avgCost : 0
      return acc + qty * cost
    }, 0)
    const totalPct = totalCost > 0 && Number.isFinite(totalCostPnl) ? (totalCostPnl / totalCost) * 100 : null
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

    return [
      {
        label: 'Market Streams',
        value: liveLamp === 'green' ? 'Online' : 'Offline',
        tone: liveLamp === 'green' ? 'positive' : 'negative',
      },
      {
        label: 'Total $',
        value: fmtUsdCompact(totalCostPnl),
        tone: toneForNumber(totalCostPnl),
      },
      {
        label: 'Daily $',
        value: fmtUsdCompact(totalDailyDollar),
        tone: toneForNumber(totalDailyDollar),
      },
      {
        label: 'Total %',
        value: fmtPctCompact(totalPct),
        tone: toneForNumber(totalPct),
      },
      {
        label: 'Daily %',
        value: fmtPctCompact(totalDailyPct),
        tone: toneForNumber(totalDailyPct),
      },
    ]
  }, [status?.accounts, watchlistSymbols, quotesMap, benchmarks, liveLamp])

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
      {lamp != null && <span className={`lamp lamp-sm ${lamp}`} aria-hidden />}
      <span>{label}</span>
    </button>
  )

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <h1>Bifrost Trader</h1>
          <nav className="app-tabs" aria-label="System, Live, Watchlist, Portfolio, Accounts, Market, Data, Settings">
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
        <div className="app-header-right">
          <label className="theme-switch">
            <span className="api-status-label" style={{ marginRight: '0.25rem' }}>Theme</span>
            <select
              value={theme}
              onChange={(e) => setTheme(e.target.value as ThemeId)}
              title="Switch dark/light theme"
              className="theme-select"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </label>
          <a href="/docs" target="_blank" rel="noopener noreferrer" className="api-docs-link">Docs</a>
        </div>
      </header>

      {showDashboard && (
        <SystemDashboard
          items={dashboardItems}
          onOpenSection={openSystemSection}
          onOpenSectionWithConsole={openSystemSectionWithConsole}
          streamLamp={liveLamp}
          streamItems={streamSummaryItems}
          workerPending={workerJobPending}
          workerRunning={workerJobRunning}
        />
      )}

      {activeTab === 'system' && (
        <DaemonMonitorPage
          status={status}
          operations={operations}
          loadStatus={loadStatus}
          onNavigateToSettings={() => setActiveTab('settings')}
          currentSection={operationsSection}
          onSectionChange={setOperationsSection}
          showSectionTabs={false}
          showAllSystemSections={true}
          showSystemSection={true}
          showWatchlistSection={false}
          showConsoleSection={true}
          currentConsoleSection={consoleSection}
          onConsoleSectionChange={setConsoleSection}
          showConsoleTabs={true}
          consoleCardTitle="Console"
          consoleCardDescription="这里集中放各个子系统的控制台、Recent Operations 和 Event Subscribe。"
        />
      )}

      {activeTab === 'ib' && (
        <IbAccountsPage
          status={status}
          accountsDisplay={accountsDisplay}
          ibAccountIndex={ibAccountIndex}
          setIbAccountIndex={setIbAccountIndex}
          ibAccountsRefreshing={ibAccountsRefreshing}
          onRefreshAccounts={onRefreshAccounts}
          refreshFeedback={accountsRefreshFeedback}
        />
      )}

      {activeTab === 'replay' && (
        <PositionPnlPage
          status={status}
          currentView={portfolioView}
          onViewChange={setPortfolioView}
          showViewTabs={false}
        />
      )}

      {activeTab === 'market' && (
        <MarketDataPage status={status} />
      )}

      {activeTab === 'data' && (
        <DataPage status={status} />
      )}

      {activeTab === 'live' && (
        <div className="app-page-stack">
          <DaemonMonitorPage
            status={status}
            operations={operations}
            loadStatus={loadStatus}
            showSectionTabs={false}
            showSystemSection={false}
            showWatchlistSection={true}
            showConsoleSection={false}
            watchlistCardTitle="Market Streams"
            watchlistCardDescription="这里集中显示系统正常运行过程中产生的实时行情流状态。"
          />
        </div>
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
