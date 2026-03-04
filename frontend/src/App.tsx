import { useEffect, useState, useCallback } from 'react'
import type { IbAccountSnapshot, StatusResponse, Operation } from './types'
import {
  fetchStatus,
  fetchOperations,
  postRefreshAccounts,
} from './api'
import { DaemonMonitorPage } from './pages/DaemonMonitorPage'
import { IbAccountsPage } from './pages/IbAccountsPage'
import { MarketDataPage } from './pages/MarketDataPage'
import { PositionPnlPage } from './pages/PositionPnlPage'
import { SettingsPage } from './pages/SettingsPage'
import { WishlistPage } from './pages/WishlistPage'
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

type TabId = 'monitor' | 'ib' | 'replay' | 'market' | 'wishlist' | 'settings'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('monitor')
  const [theme, setTheme] = useState<ThemeId>(loadTheme)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [ibAccountIndex, setIbAccountIndex] = useState(0)
  const [accountsDisplay, setAccountsDisplay] = useState<IbAccountSnapshot[] | null>(null)
  const [ibAccountsRefreshing, setIbAccountsRefreshing] = useState(false)
  /** Short feedback after account refresh (success/fail/timeout); auto-cleared after a few seconds */
  const [accountsRefreshFeedback, setAccountsRefreshFeedback] = useState<string | null>(null)

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
      setStatus(null)
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
  const sl = (j?.status_lamp as 'green' | 'yellow' | 'red') || 'red'
  const systemLamp: 'green' | 'yellow' | 'red' | 'none' =
    dl === 'red' || ml === 'red' || sl === 'red'
      ? 'red'
      : dl === 'yellow' || ml === 'yellow' || sl === 'yellow'
        ? 'yellow'
        : dl === 'green' && ml === 'green' && sl === 'green'
          ? 'green'
          : 'none'

  const tabList: { id: TabId; label: string; lamp?: 'green' | 'yellow' | 'red' | 'none' }[] = [
    { id: 'monitor', label: 'System', lamp: systemLamp },
    { id: 'ib', label: 'Accounts' },
    { id: 'replay', label: 'Positions' },
    { id: 'market', label: 'Market' },
    { id: 'wishlist', label: 'Wishlist' },
    { id: 'settings', label: 'Settings' },
  ]

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-header-left">
          <h1>Bifrost Trader</h1>
          <nav className="app-tabs" aria-label="System, Accounts, Positions, Market, Wishlist, Settings">
            {tabList.map(({ id, label, lamp }) => (
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
            ))}
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

      {activeTab === 'monitor' && (
        <DaemonMonitorPage
          status={status}
          operations={operations}
          loadStatus={loadStatus}
          onNavigateToSettings={() => setActiveTab('settings')}
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
        <PositionPnlPage status={status} operations={operations} />
      )}

      {activeTab === 'market' && (
        <MarketDataPage status={status} />
      )}

      {activeTab === 'wishlist' && (
        <WishlistPage status={status} />
      )}

      {activeTab === 'settings' && (
        <SettingsPage status={status} loadStatus={loadStatus} />
      )}
    </div>
  )
}
