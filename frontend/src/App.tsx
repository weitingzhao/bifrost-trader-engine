import { useEffect, useState, useCallback } from 'react'
import type { IbAccountSnapshot, StatusResponse, Operation } from './types'
import {
  fetchStatus,
  fetchOperations,
  postRefreshAccounts,
} from './api'
import { DaemonMonitorPage } from './pages/DaemonMonitorPage'
import { IbAccountsPage } from './pages/IbAccountsPage'
import { PositionPnlPage } from './pages/PositionPnlPage'
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

type TabId = 'monitor' | 'ib' | 'replay'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('monitor')
  const [theme, setTheme] = useState<ThemeId>(loadTheme)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [operations, setOperations] = useState<Operation[]>([])
  const [apiReachable, setApiReachable] = useState<boolean>(false)
  const [ibAccountIndex, setIbAccountIndex] = useState(0)
  const [accountsDisplay, setAccountsDisplay] = useState<IbAccountSnapshot[] | null>(null)
  const [ibAccountsRefreshing, setIbAccountsRefreshing] = useState(false)

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
      setApiReachable(true)
      return j
    } catch {
      setStatus(null)
      setApiReachable(false)
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

  const onRefreshAccounts = useCallback(async () => {
    setIbAccountsRefreshing(true)
    const requestedAt = Date.now() / 1000
    try {
      await postRefreshAccounts()
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const j = await loadStatus()
        if (j?.accounts != null) setAccountsDisplay(j.accounts ? [...j.accounts] : [])
        if (j?.accounts_fetched_at != null && j.accounts_fetched_at > requestedAt) break
        await new Promise((r) => setTimeout(r, 2000))
      }
    } finally {
      setIbAccountsRefreshing(false)
    }
  }, [loadStatus])

  const j = status
  const daemonLamp = (j?.daemon_lamp as 'green' | 'yellow' | 'red') || 'none'
  const hedgeLamp = (j?.status_lamp as 'green' | 'yellow' | 'red') || 'none'
  const apiLamp = apiReachable ? 'green' : 'red'

  const tabList: { id: TabId; label: string; lamp?: 'green' | 'yellow' | 'red' | 'none' }[] = [
    { id: 'monitor', label: '守护程序', lamp: daemonLamp },
    { id: 'ib', label: 'IB 账户' },
    { id: 'replay', label: '头寸盈亏', lamp: hedgeLamp },
  ]

  return (
    <div className="app">
      <h1>Bifrost 自动交易监控</h1>
      <p className="app-subtitle">通过下方主菜单切换：守护程序 · IB 账户 · 头寸盈亏</p>
      <div className="api-status-bar">
        <div className={`lamp lamp-sm ${apiLamp}`} title="Trader API 是否可达" />
        <span className="api-status-label">Trader API: {apiReachable ? '正常' : '异常'}</span>
        <label className="theme-switch">
          <span className="api-status-label" style={{ marginRight: '0.5rem' }}>主题</span>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as ThemeId)}
            title="切换深色/明亮主题"
            className="theme-select"
          >
            <option value="dark">深色</option>
            <option value="light">明亮</option>
          </select>
        </label>
        <a href="/docs" target="_blank" rel="noopener noreferrer" className="api-docs-link">API 文档</a>
      </div>

      <nav className="app-tabs" aria-label="主菜单：在守护程序、IB 账户、头寸盈亏等页面间切换">
        <span className="app-tabs-label" aria-hidden>主菜单</span>
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

      {activeTab === 'monitor' && (
        <DaemonMonitorPage status={status} operations={operations} loadStatus={loadStatus} />
      )}

      {activeTab === 'ib' && (
        <IbAccountsPage
          status={status}
          accountsDisplay={accountsDisplay}
          ibAccountIndex={ibAccountIndex}
          setIbAccountIndex={setIbAccountIndex}
          ibAccountsRefreshing={ibAccountsRefreshing}
          onRefreshAccounts={onRefreshAccounts}
        />
      )}

      {activeTab === 'replay' && (
        <PositionPnlPage status={status} operations={operations} />
      )}
    </div>
  )
}
