import { useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import {
  postIbConfig,
  postSetHeartbeatInterval,
  postFlexConfig,
  fetchMarketHolidays,
  postMarketHoliday,
  deleteMarketHoliday,
  fetchKeyValueConfig,
  fetchKeyValueGroups,
  postKeyValueGroup,
  patchKeyValueGroup,
  deleteKeyValueGroup,
  postKeyValueConfig,
  deleteKeyValueConfig,
  type MarketHolidayRow,
} from '../api'
import type { FlexAccountItem } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'

export interface SettingsPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT_TYPE = 'tws_paper'
const DEFAULT_DAEMON = 1
const DEFAULT_LISTENER = 2
const DEFAULT_REFRESH_EXECUTIONS = 100
const DEFAULT_BARS_FETCH = 101
const DEFAULT_WORKER = 500
const DEFAULT_HEARTBEAT_SEC = 10

const SETTINGS_SECTIONS = [
  { id: 'settings-heartbeat', label: 'Daemon App', icon: 'heartbeat' },
  { id: 'settings-ib-connection', label: 'IB Settings', icon: 'plug' },
  { id: 'settings-holidays', label: 'US market holidays', icon: 'calendar' },
  { id: 'settings-key-value', label: 'Key-Value Config', icon: 'key-value' },
] as const

const IB_CONNECTION_SUBSECTIONS = [
  { id: 'ib-primary', label: 'Host User', icon: 'user-host' },
  { id: 'ib-second', label: 'Second User', icon: 'user-second' },
  { id: 'ib-trading-account', label: 'Trading account', icon: 'user-host' },
  { id: 'ib-client-ids', label: 'Client IDs', icon: 'id' },
  { id: 'ib-flex', label: 'Flex Settings', icon: 'flex' },
] as const

/** Fixed Flex query types: one row per type, no add/remove. Each maps to a future feature. */
const FLEX_QUERY_TYPES = [
  { purpose: 'cash_transactions' as const, label: 'Cash Transactions' },
  { purpose: 'trades' as const, label: 'Trades' },
] as const

function getDefaultFlexRows(): FlexAccountItem[] {
  return FLEX_QUERY_TYPES.map(({ purpose, label }) => ({
    purpose,
    query_label: label,
    query_host_id: '',
    query_secondary_id: '',
  }))
}

function SettingsSectionIcon({ name }: { name: string }) {
  const size = 18
  const className = 'settings-sidebar-icon'
  const icons: Record<string, JSX.Element> = {
    heartbeat: (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    ),
    plug: (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" />
      </svg>
    ),
    calendar: (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect width="18" height="18" x="3" y="4" rx="2" ry="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" />
      </svg>
    ),
    'user-host': (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    'user-second': (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
    id: (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
    flex: (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M16 13H8" /><path d="M16 17H8" /><path d="M10 9H8" />
      </svg>
    ),
    'key-value': (
      <svg viewBox="0 0 24 24" width={size} height={size} className={className} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M12 2v4" /><path d="M12 18v4" /><path d="m4.93 4.93 2.83 2.83" /><path d="m16.24 16.24 2.83 2.83" /><path d="M2 12h4" /><path d="M18 12h4" /><path d="m4.93 19.07 2.83-2.83" /><path d="m16.24 7.76 2.83-2.83" /><circle cx="12" cy="12" r="3" />
      </svg>
    ),
  }
  return icons[name] ?? null
}

export function SettingsPage({ status, loadStatus }: SettingsPageProps) {
  const [msg, setMsg] = useState({ text: '', isErr: false })
  const [ibHost, setIbHost] = useState(DEFAULT_HOST)
  const [ibPortType, setIbPortType] = useState<'tws_live' | 'tws_paper' | 'gateway'>(DEFAULT_PORT_TYPE)
  const [clientIdDaemon, setClientIdDaemon] = useState(DEFAULT_DAEMON)
  const [clientIdListener, setClientIdListener] = useState(DEFAULT_LISTENER)
  const [clientIdAccount, setClientIdAccount] = useState(DEFAULT_REFRESH_EXECUTIONS)
  const [clientIdMarkets, setClientIdMarkets] = useState(DEFAULT_BARS_FETCH)
  const [clientIdWorker, setClientIdWorker] = useState(DEFAULT_WORKER)
  const [primaryAccountId, setPrimaryAccountId] = useState<string>('')
  const [ib2Host, setIb2Host] = useState<string>('')
  const [ib2PortType, setIb2PortType] = useState<'tws_live' | 'tws_paper' | 'gateway'>(DEFAULT_PORT_TYPE)
  const [ib2ClientIdListener, setIb2ClientIdListener] = useState(3)
  const [ib2ClientIdAccount, setIb2ClientIdAccount] = useState(102)
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState(DEFAULT_HEARTBEAT_SEC)
  const [ibConfigInitialized, setIbConfigInitialized] = useState(false)
  const [heartbeatInitialized, setHeartbeatInitialized] = useState(false)

  const currentYear = new Date().getFullYear()
  // US market holidays (NYSE) — default to current year to save space
  const [holidays, setHolidays] = useState<MarketHolidayRow[]>([])
  const [holidaysYear, setHolidaysYear] = useState<string>(() => String(currentYear))
  const [holidaysLoading, setHolidaysLoading] = useState(false)
  const [holidayMsg, setHolidayMsg] = useState({ text: '', isErr: false })
  const [addDate, setAddDate] = useState('')
  const [addLabel, setAddLabel] = useState('')
  const [flexHostToken, setFlexHostToken] = useState('')
  const [flexSecondaryToken, setFlexSecondaryToken] = useState('')
  const [flexAccounts, setFlexAccounts] = useState<FlexAccountItem[]>(getDefaultFlexRows)
  const [flexInitialized, setFlexInitialized] = useState(false)
  /** Default Flex Query range in days (e.g. 30). Stored in settings.flex_default_range_days. */
  const [defaultFlexRangeDays, setDefaultFlexRangeDays] = useState<number>(30)
  /** Init Flex Query range in days (e.g. 360) for initial/full pull. Stored in settings.flex_init_range_days. */
  const [initFlexRangeDays, setInitFlexRangeDays] = useState<number>(360)
  const [keyValueItems, setKeyValueItems] = useState<Array<{ key: string; value: string; description?: string | null; updated_at?: string; group_id?: number }>>([])
  const [keyValueLoading, setKeyValueLoading] = useState(false)
  const [keyValueMsg, setKeyValueMsg] = useState({ text: '', isErr: false })
  const [keyValueGroups, setKeyValueGroups] = useState<Array<{ id: number; name: string; description?: string | null; sort_order?: number }>>([])
  const [selectedGroupName, setSelectedGroupName] = useState<string | null>(null)
  const [newGroupName, setNewGroupName] = useState('')
  const [newGroupDesc, setNewGroupDesc] = useState('')
  const [editingGroupName, setEditingGroupName] = useState<string | null>(null)
  const [editGroupName, setEditGroupName] = useState('')
  const [editGroupDesc, setEditGroupDesc] = useState('')
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')
  const [editDesc, setEditDesc] = useState('')

  useEffect(() => {
    const c = status?.ib_config
    if (!c || ibConfigInitialized) return
    if (c.ib_host != null) setIbHost(c.ib_host)
    if (c.ib_port_type != null) setIbPortType(c.ib_port_type)
    if (c.ib_client_id_daemon != null) setClientIdDaemon(c.ib_client_id_daemon)
    if (c.ib_client_id_listener != null) setClientIdListener(c.ib_client_id_listener)
    if (c.ib_client_id_account != null) setClientIdAccount(c.ib_client_id_account)
    if (c.ib_client_id_markets != null) setClientIdMarkets(c.ib_client_id_markets)
    if (c.ib_client_id_worker_market != null) setClientIdWorker(c.ib_client_id_worker_market)
    if (c.ib_primary_account_id != null) setPrimaryAccountId(String(c.ib_primary_account_id))
    if (c.ib2_host != null) setIb2Host(String(c.ib2_host))
    if (c.ib2_port_type != null) setIb2PortType(c.ib2_port_type as 'tws_live' | 'tws_paper' | 'gateway')
    if (c.ib2_client_id_listener != null) setIb2ClientIdListener(c.ib2_client_id_listener)
    if (c.ib2_client_id_account != null) setIb2ClientIdAccount(c.ib2_client_id_account)
    const days = (c as { flex_default_range_days?: number }).flex_default_range_days
    if (typeof days === 'number' && Number.isFinite(days) && days >= 1) setDefaultFlexRangeDays(Math.round(days))
    const initDays = (c as { flex_init_range_days?: number }).flex_init_range_days
    if (typeof initDays === 'number' && Number.isFinite(initDays) && initDays >= 1) setInitFlexRangeDays(Math.round(initDays))
    setIbConfigInitialized(true)
  }, [status?.ib_config, ibConfigInitialized])

  useEffect(() => {
    if (!status || flexInitialized) return
    const fc = status.flex_config
    if (fc && typeof fc === 'object' && 'rows' in fc && Array.isArray(fc.rows)) {
      setFlexHostToken((fc.host_token ?? '') || '')
      setFlexSecondaryToken((fc.secondary_token ?? '') || '')
      setFlexAccounts(
        FLEX_QUERY_TYPES.map(({ purpose, label }) => {
          const row = fc.rows!.find((r: FlexAccountItem) => (r.purpose || 'cash_transactions') === purpose)
          return {
            purpose,
            query_label: row?.query_label ?? label,
            query_host_id: (row as { query_host_id?: string } | undefined)?.query_host_id ?? '',
            query_secondary_id: (row as { query_secondary_id?: string } | undefined)?.query_secondary_id ?? '',
          }
        })
      )
    } else {
      setFlexHostToken('')
      setFlexSecondaryToken('')
      setFlexAccounts(getDefaultFlexRows())
    }
    setFlexInitialized(true)
  }, [status, status?.flex_config, flexInitialized])

  const loadKeyValueItemsForGroup = async (groupName: string) => {
    setKeyValueLoading(true)
    setKeyValueMsg({ text: '', isErr: false })
    try {
      const r = await fetchKeyValueConfig({ group_name: groupName })
      if (r.ok) setKeyValueItems(r.items ?? [])
      else setKeyValueItems([])
    } catch (e) {
      setKeyValueMsg({ text: (e as Error).message, isErr: true })
      setKeyValueItems([])
    } finally {
      setKeyValueLoading(false)
    }
  }

  useEffect(() => {
    const sec = status?.daemon_heartbeat?.heartbeat_interval_sec
    if (heartbeatInitialized) return
    if (sec != null && Number.isFinite(sec)) {
      setHeartbeatIntervalSec(sec)
      setHeartbeatInitialized(true)
    }
  }, [status?.daemon_heartbeat?.heartbeat_interval_sec, heartbeatInitialized])

  const loadHolidays = async () => {
    setHolidaysLoading(true)
    setHolidayMsg({ text: '', isErr: false })
    try {
      const yearNum = holidaysYear === '' ? undefined : parseInt(holidaysYear, 10)
      const list = await fetchMarketHolidays(Number.isFinite(yearNum) ? yearNum : undefined, 'NYSE')
      setHolidays(list)
    } catch (e) {
      setHolidayMsg({ text: (e as Error).message, isErr: true })
      setHolidays([])
    } finally {
      setHolidaysLoading(false)
    }
  }

  useEffect(() => {
    loadHolidays()
  }, [holidaysYear])

  // Sync sidebar active state with hash (GitHub-style: highlight current section). Map ib-* sub-hashes to settings-ib-connection.
  const hashToSectionId = (hash: string) => {
    const h = hash ? hash.slice(1) : ''
    if (h && (h.startsWith('ib-') || h === 'settings-ib-connection')) return 'settings-ib-connection'
    return h || SETTINGS_SECTIONS[0].id
  }
  const [activeSectionId, setActiveSectionId] = useState<string>(() => {
    if (typeof window === 'undefined') return SETTINGS_SECTIONS[0].id
    return hashToSectionId(window.location.hash)
  })
  const [ibConnectionExpanded, setIbConnectionExpanded] = useState(true)
  const currentHash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  const activeSubId = activeSectionId === 'settings-ib-connection' && IB_CONNECTION_SUBSECTIONS.some(s => s.id === currentHash) ? currentHash : ''
  useEffect(() => {
    const onHashChange = () => setActiveSectionId(hashToSectionId(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    if (window.location.hash) setActiveSectionId(hashToSectionId(window.location.hash))
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    if (activeSectionId === 'settings-key-value') {
      fetchKeyValueGroups().then((r) => {
        if (r.ok) setKeyValueGroups(r.items ?? [])
      })
    }
  }, [activeSectionId])

  useEffect(() => {
    if (activeSectionId === 'settings-key-value' && selectedGroupName != null) loadKeyValueItemsForGroup(selectedGroupName)
  }, [activeSectionId, selectedGroupName])

  const onAddHoliday = async () => {
    const d = addDate.trim().slice(0, 10)
    if (!d) {
      setHolidayMsg({ text: 'Enter a date.', isErr: true })
      return
    }
    setHolidayMsg({ text: '', isErr: false })
    try {
      await postMarketHoliday({ date: d, label: addLabel.trim() || undefined, exchange: 'NYSE' })
      setAddDate('')
      setAddLabel('')
      setHolidayMsg({ text: 'Holiday added.', isErr: false })
      loadHolidays()
    } catch (e) {
      setHolidayMsg({ text: (e as Error).message, isErr: true })
    }
  }

  const onDeleteHoliday = async (dateStr: string) => {
    try {
      await deleteMarketHoliday(dateStr, 'NYSE')
      setHolidayMsg({ text: '', isErr: false })
      loadHolidays()
    } catch (e) {
      setHolidayMsg({ text: (e as Error).message, isErr: true })
    }
  }

  const onSave = async () => {
    setMsg({ text: 'Saving…', isErr: false })
    const host = ibHost.trim() || DEFAULT_HOST
    const sec = Math.max(5, Math.min(120, Math.round(Number(heartbeatIntervalSec)) || DEFAULT_HEARTBEAT_SEC))
    const flexToSave = flexAccounts.map((a, i) => ({
      purpose: FLEX_QUERY_TYPES[i].purpose,
      query_label: FLEX_QUERY_TYPES[i].label,
      query_host_id: (a.query_host_id || '').trim(),
      query_secondary_id: (a.query_secondary_id || '').trim() || undefined,
    }))
    const [resIb, resHb, resFlex] = await Promise.all([
      postIbConfig(host, ibPortType, {
        ib_client_id_daemon: clientIdDaemon,
        ib_client_id_listener: clientIdListener,
        ib_client_id_account: clientIdAccount,
        ib_client_id_markets: clientIdMarkets,
        ib_client_id_worker_market: clientIdWorker,
        ib_primary_account_id: primaryAccountId.trim() || null,
        ib2_host: ib2Host.trim() || null,
        ib2_port_type: ib2Host.trim() ? ib2PortType : null,
        ib2_client_id_listener: ib2ClientIdListener,
        ib2_client_id_account: ib2ClientIdAccount,
      }),
      postSetHeartbeatInterval(sec),
      postFlexConfig(flexHostToken.trim() || undefined, flexSecondaryToken.trim() || undefined, flexToSave, defaultFlexRangeDays, initFlexRangeDays),
    ])
    const ok = resIb.ok && resHb.ok && resFlex.ok
    const err = !resIb.ok ? resIb.error : !resHb.ok ? resHb.error : !resFlex.ok ? resFlex.error : undefined
    setMsg({
      text: ok
        ? 'Settings saved. IB connection and client_id apply on next start/use; heartbeat interval on next heartbeat.'
        : err ?? 'Save failed',
      isErr: !ok,
    })
    if (ok) {
      setHeartbeatIntervalSec(sec)
      loadStatus()
    }
  }

  return (
    <div className="settings-page">
      <nav className="settings-sidebar" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(({ id, label, icon }) => {
          if (id !== 'settings-ib-connection') {
            return (
              <a
                key={id}
                href={`#${id}`}
                className={`settings-sidebar-link ${activeSectionId === id ? 'active' : ''}`}
              >
                <SettingsSectionIcon name={icon} />
                {label}
              </a>
            )
          }
          return (
            <div key={id} className="settings-sidebar-group">
              <div className={`settings-sidebar-parent ${activeSectionId === id ? 'active' : ''}`}>
                <a href={`#${id}`} className="settings-sidebar-parent-label">
                  <SettingsSectionIcon name={icon} />
                  {label}
                </a>
                <button
                  type="button"
                  className={`settings-sidebar-chevron ${ibConnectionExpanded ? 'expanded' : ''}`}
                  onClick={() => setIbConnectionExpanded((e) => !e)}
                  aria-expanded={ibConnectionExpanded}
                  aria-controls="settings-ib-connection-subs"
                  aria-label={ibConnectionExpanded ? 'Collapse IB Settings' : 'Expand IB Settings'}
                >
                  ▼
                </button>
              </div>
              <div id="settings-ib-connection-subs" className="settings-sidebar-subs" hidden={!ibConnectionExpanded}>
                {IB_CONNECTION_SUBSECTIONS.map((sub) => (
                  <a
                    key={sub.id}
                    href={`#${sub.id}`}
                    className={`settings-sidebar-link settings-sidebar-link-sub ${activeSubId === sub.id ? 'active' : ''}`}
                  >
                    <SettingsSectionIcon name={sub.icon} />
                    {sub.label}
                  </a>
                ))}
              </div>
            </div>
          )
        })}
      </nav>
      <div className="settings-main">
        <div className="settings-page-card card">
          <div className="settings-page-header">
            <h2 className="settings-page-title">
              Settings
              <InfoTooltip text="Configure daemon-related parameters; written to DB and read by daemon on start or next heartbeat." />
            </h2>
            <div className="settings-page-actions">
              {msg.text && (
                <span className={msg.isErr ? 'msg-error' : 'msg-ok'}>
                  {msg.text}
                </span>
              )}
              <button type="button" className="btn-resume" onClick={onSave}>
                Save settings
              </button>
            </div>
          </div>
          <div className="daemon-groups settings-page-groups">
        <div className="daemon-group" id="settings-heartbeat">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Daemon App</span>
            <InfoTooltip text="Daemon heartbeat write interval (seconds); takes effect on next heartbeat." />
          </div>
          <div className="daemon-group-body">
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label>
                Heartbeat Interval (sec):
                <input
                  type="number"
                  min={5}
                  max={120}
                  value={heartbeatIntervalSec}
                  onChange={(e) => setHeartbeatIntervalSec(parseInt(e.target.value, 10) || DEFAULT_HEARTBEAT_SEC)}
                  style={{ width: '3.5rem', marginLeft: '0.25rem' }}
                />
              </label>
            </div>
          </div>
        </div>
        <div id="settings-ib-connection" className="settings-ib-connection-group">
          <h3 className="settings-ib-group-title">IB Settings</h3>
        <div className="daemon-group" id="ib-primary">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Host User</span>
            <InfoTooltip text="Primary TWS: daemon + auto-trading + market data. One TWS per machine. Flex token used for this account's Flex Queries (e.g. Cash Transactions)." />
          </div>
          <div className="daemon-group-body">
            <div className="settings-ib-user-controls">
              <label className="settings-ib-user-label">
                IP/Host:
                <input
                  type="text"
                  value={ibHost}
                  onChange={(e) => setIbHost(e.target.value)}
                  placeholder="127.0.0.1"
                  className="settings-ib-user-input"
                />
              </label>
              <label className="settings-ib-user-label">
                Port type:
                <select
                  value={ibPortType}
                  onChange={(e) => setIbPortType(e.target.value as 'tws_live' | 'tws_paper' | 'gateway')}
                  className="settings-ib-user-select"
                >
                  <option value="tws_paper">TWS Paper (7497)</option>
                  <option value="tws_live">TWS Live (7496)</option>
                  <option value="gateway">Gateway (4002)</option>
                </select>
              </label>
            </div>
            <div className="settings-ib-user-controls settings-ib-user-token-row">
              <label className="settings-ib-user-label settings-ib-user-token-label">
                Flex token:
                <input
                  type="text"
                  placeholder="IB Flex token (for this account)"
                  value={flexHostToken}
                  onChange={(e) => setFlexHostToken(e.target.value)}
                  className="settings-ib-user-token-input"
                />
              </label>
            </div>
          </div>
        </div>
        <div className="daemon-group" id="ib-second">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Second User</span>
            <InfoTooltip text="Second TWS (different machine): manual-only account. Leave empty if not used. Flex token for this account's Flex Queries." />
          </div>
          <div className="daemon-group-body">
            <div className="settings-ib-user-controls">
              <label className="settings-ib-user-label">
                IP/Host:
                <input
                  type="text"
                  value={ib2Host}
                  onChange={(e) => setIb2Host(e.target.value)}
                  placeholder="e.g. 192.168.10.31 (empty = disabled)"
                  className="settings-ib-user-input"
                />
              </label>
              <label className="settings-ib-user-label">
                Port type:
                <select
                  value={ib2PortType}
                  onChange={(e) => setIb2PortType(e.target.value as 'tws_live' | 'tws_paper' | 'gateway')}
                  className="settings-ib-user-select"
                  disabled={!ib2Host.trim()}
                >
                  <option value="tws_paper">TWS Paper (7497)</option>
                  <option value="tws_live">TWS Live (7496)</option>
                  <option value="gateway">Gateway (4002)</option>
                </select>
              </label>
            </div>
            <div className="settings-ib-user-controls settings-ib-user-token-row">
              <label className="settings-ib-user-label settings-ib-user-token-label">
                Flex token:
                <input
                  type="text"
                  placeholder="IB Flex token (second IB, empty if not used)"
                  value={flexSecondaryToken}
                  onChange={(e) => setFlexSecondaryToken(e.target.value)}
                  className="settings-ib-user-token-input"
                  disabled={!ib2Host.trim()}
                />
              </label>
            </div>
          </div>
        </div>
        <div className="daemon-group" id="ib-trading-account">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Trading account (hedging & status)</span>
            <InfoTooltip text="The single IB account used by the daemon for auto-hedging and for writing status (positions, account summary). Must be one of Host User's managed accounts. Empty = use first account from Host User's TWS." />
          </div>
          <div className="daemon-group-body">
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
              <label>
                Account ID:
                <input
                  type="text"
                  value={primaryAccountId}
                  onChange={(e) => setPrimaryAccountId(e.target.value)}
                  placeholder="e.g. U17113214 (empty = first from Host User)"
                  style={{ width: '12rem', marginLeft: '0.25rem' }}
                />
              </label>
            </div>
          </div>
        </div>
        <div className="daemon-group" id="ib-client-ids">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Client IDs</span>
            <InfoTooltip text="Per-role client IDs. Host = Host User; Secondary = Second IB (when configured). Market data is Host only—only the primary account has a data subscription; Secondary has no market data." />
          </div>
          <div className="daemon-group-body">
            <div className="flex-query-table-wrap">
              <table className="flex-query-table" aria-label="Client IDs by role and connection">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Host</th>
                    <th scope="col">Secondary</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="client-ids-group-row">
                    <td colSpan={3} className="client-ids-group-header">Daemon</td>
                  </tr>
                  <tr>
                    <td className="flex-query-cell-type">Trading</td>
                    <td className="flex-query-cell-input">
                      <input
                        type="number"
                        min={1}
                        max={32}
                        value={clientIdDaemon}
                        onChange={(e) => setClientIdDaemon(parseInt(e.target.value, 10) || DEFAULT_DAEMON)}
                        className="flex-query-input"
                        style={{ width: '4rem' }}
                        aria-label="Trading — Host"
                      />
                    </td>
                    <td className="flex-query-cell-input">—</td>
                  </tr>
                  <tr>
                    <td className="flex-query-cell-type">Listener</td>
                    <td className="flex-query-cell-input">
                      <input
                        type="number"
                        min={1}
                        max={32}
                        value={clientIdListener}
                        onChange={(e) => setClientIdListener(parseInt(e.target.value, 10) || DEFAULT_LISTENER)}
                        className="flex-query-input"
                        style={{ width: '4rem' }}
                        aria-label="Listener — Host"
                      />
                    </td>
                    <td className="flex-query-cell-input">
                      <input
                        type="number"
                        min={1}
                        max={32}
                        value={ib2ClientIdListener}
                        onChange={(e) => setIb2ClientIdListener(parseInt(e.target.value, 10) || 3)}
                        className="flex-query-input"
                        style={{ width: '4rem' }}
                        aria-label="Listener — Secondary"
                      />
                    </td>
                  </tr>
                  <tr className="client-ids-group-row">
                    <td colSpan={3} className="client-ids-group-header">Monitor</td>
                  </tr>
                  <tr>
                    <td className="flex-query-cell-type">Account</td>
                    <td className="flex-query-cell-input">
                      <input
                        type="number"
                        min={1}
                        max={32}
                        value={clientIdAccount}
                        onChange={(e) => setClientIdAccount(parseInt(e.target.value, 10) || DEFAULT_REFRESH_EXECUTIONS)}
                        className="flex-query-input"
                        style={{ width: '4rem' }}
                        aria-label="Account — Host"
                      />
                    </td>
                    <td className="flex-query-cell-input">
                      <input
                        type="number"
                        min={1}
                        max={32}
                        value={ib2ClientIdAccount}
                        onChange={(e) => setIb2ClientIdAccount(parseInt(e.target.value, 10) || 102)}
                        className="flex-query-input"
                        style={{ width: '4rem' }}
                        aria-label="Account — Secondary"
                      />
                    </td>
                  </tr>
                  <tr>
                    <td className="flex-query-cell-type">Market data</td>
                    <td className="flex-query-cell-input">
                      <input
                        type="number"
                        min={1}
                        max={32}
                        value={clientIdMarkets}
                        onChange={(e) => setClientIdMarkets(parseInt(e.target.value, 10) || DEFAULT_BARS_FETCH)}
                        className="flex-query-input"
                        style={{ width: '4rem' }}
                        aria-label="Market data — Host"
                      />
                    </td>
                    <td className="flex-query-cell-input">—</td>
                  </tr>
                  <tr className="client-ids-group-row">
                    <td colSpan={3} className="client-ids-group-header">Celery</td>
                  </tr>
                  <tr>
                    <td className="flex-query-cell-type">Market Data</td>
                    <td className="flex-query-cell-input">
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={clientIdWorker}
                        onChange={(e) => setClientIdWorker(parseInt(e.target.value, 10) || DEFAULT_WORKER)}
                        className="flex-query-input"
                        style={{ width: '4rem' }}
                        aria-label="Market Data (worker_market) — Host"
                      />
                    </td>
                    <td className="flex-query-cell-input">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
        <div className="daemon-group" id="ib-flex">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Flex Settings</span>
            <InfoTooltip text="One row per query type. Fill in Query IDs for Host and (optional) Second IB. Default Flex Query range is used when Fetch from IB (Flex) is called without a date range (e.g. from script or API). Tokens set above. See docs/FLEX_TRANSACTIONS.md." />
          </div>
          <div className="daemon-group-body">
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
              <label>
                Default Flex Query range (days):
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={defaultFlexRangeDays}
                  onChange={(e) => setDefaultFlexRangeDays(Math.max(1, Math.min(9999, Math.round(Number(e.target.value) || 30))))}
                  className="settings-flex-range-select"
                  style={{ width: '5rem', marginLeft: '0.35rem' }}
                  aria-label="Default Flex Query range in days"
                />
              </label>
              <label>
                Init Flex Query range (days):
                <input
                  type="number"
                  min={1}
                  max={9999}
                  value={initFlexRangeDays}
                  onChange={(e) => setInitFlexRangeDays(Math.max(1, Math.min(9999, Math.round(Number(e.target.value) || 360))))}
                  className="settings-flex-range-select"
                  style={{ width: '5rem', marginLeft: '0.35rem' }}
                  aria-label="Init Flex Query range in days"
                />
              </label>
              <span className="section-hint" style={{ margin: 0 }}>Default: used when no from_date/to_date is sent (from_date = yesterday − N days, to_date = yesterday). Init: for initial/full pull (e.g. 360 days).</span>
            </div>
            <div className="flex-query-table-wrap">
              <table className="flex-query-table" aria-label="Flex Query IDs by type">
                <thead>
                  <tr>
                    <th scope="col">Query type</th>
                    <th scope="col">Host</th>
                    <th scope="col">Secondary</th>
                  </tr>
                </thead>
                <tbody>
                  {FLEX_QUERY_TYPES.map(({ purpose, label }, i) => (
                    <tr key={purpose}>
                      <td className="flex-query-cell-type">{label}</td>
                      <td className="flex-query-cell-input">
                        <input
                          type="text"
                          placeholder="Query ID"
                          value={flexAccounts[i]?.query_host_id ?? ''}
                          onChange={(e) => {
                            const next = [...flexAccounts]
                            if (!next[i]) next[i] = { purpose, query_label: label, query_host_id: '', query_secondary_id: '' }
                            next[i] = { ...next[i], query_host_id: e.target.value }
                            setFlexAccounts(next)
                          }}
                          className="flex-query-input"
                          aria-label={`${label} — Host Query ID`}
                        />
                      </td>
                      <td className="flex-query-cell-input">
                        <input
                          type="text"
                          placeholder="Query ID"
                          value={flexAccounts[i]?.query_secondary_id ?? ''}
                          onChange={(e) => {
                            const next = [...flexAccounts]
                            if (!next[i]) next[i] = { purpose, query_label: label, query_host_id: '', query_secondary_id: '' }
                            next[i] = { ...next[i], query_secondary_id: e.target.value }
                            setFlexAccounts(next)
                          }}
                          className="flex-query-input"
                          aria-label={`${label} — Secondary Query ID`}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
        </div>
        <div className="daemon-group" id="settings-holidays">
          <div className="daemon-group-header">
            <span className="daemon-group-title">US market holidays (NYSE)</span>
            <InfoTooltip text="Holidays used to decide trading days (e.g. Data page yellow (end)). Add or delete as needed." />
          </div>
          <div className="daemon-group-body">
            <div className="controls settings-holidays-filters" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
              <label>
                Year:
                <select
                  value={holidaysYear}
                  onChange={(e) => setHolidaysYear(e.target.value)}
                  className="settings-holidays-input"
                  aria-label="Filter holidays by year"
                >
                  <option value="">All</option>
                  {[currentYear - 1, currentYear, currentYear + 1, currentYear + 2].map((y) => (
                    <option key={y} value={String(y)}>{y}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="btn-pause" onClick={loadHolidays} disabled={holidaysLoading}>
                Refresh
              </button>
            </div>
            <div className="settings-holidays-add-row">
              <label className="settings-holidays-add-label">
                Date
                <input
                  type="date"
                  value={addDate}
                  onChange={(e) => setAddDate(e.target.value)}
                  className="settings-holidays-input"
                  aria-label="Holiday date"
                />
              </label>
              <label className="settings-holidays-add-label">
                Label
                <input
                  type="text"
                  value={addLabel}
                  onChange={(e) => setAddLabel(e.target.value)}
                  placeholder="e.g. New Year's Day"
                  className="settings-holidays-input settings-holidays-input-text"
                  aria-label="Holiday label"
                />
              </label>
              <button type="button" className="btn-resume" onClick={onAddHoliday} disabled={holidaysLoading}>
                Add
              </button>
            </div>
            {holidayMsg.text && (
              <div className={holidayMsg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginBottom: '0.5rem' }}>
                {holidayMsg.text}
              </div>
            )}
            {holidaysLoading ? (
              <p>Loading…</p>
            ) : holidays.length === 0 ? (
              <p>No holidays in database. Add a date and label below.</p>
            ) : (
              <table className="settings-holidays-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Date</th>
                    <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Label</th>
                    <th style={{ width: '4rem' }} />
                  </tr>
                </thead>
                <tbody>
                  {holidays.map((h) => (
                    <tr key={h.holiday_date}>
                      <td style={{ padding: '0.25rem 0.5rem' }}>{h.holiday_date}</td>
                      <td style={{ padding: '0.25rem 0.5rem' }}>{h.label ?? '—'}</td>
                      <td style={{ padding: '0.25rem' }}>
                        <button type="button" className="btn-pause" onClick={() => onDeleteHoliday(h.holiday_date)} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="daemon-group" id="settings-key-value">
          <div className="daemon-group-header">
            <span className="daemon-group-title">Key-Value Config</span>
            <InfoTooltip text="Key-value options are grouped by Group. Each group can back a dropdown or option set (e.g. flex_settings for Flex default range). Add groups first, then select a group to add/edit key-value rows." />
          </div>
          <div className="daemon-group-body">
            <h4 style={{ marginTop: 0, marginBottom: '0.5rem' }}>Groups</h4>
            <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
              <input
                type="text"
                placeholder="Group name"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                className="settings-key-value-input"
                aria-label="New group name"
                style={{ width: '10rem' }}
              />
              <input
                type="text"
                placeholder="Description (optional)"
                value={newGroupDesc}
                onChange={(e) => setNewGroupDesc(e.target.value)}
                className="settings-key-value-input"
                aria-label="Group description"
                style={{ width: '14rem' }}
              />
              <button
                type="button"
                className="btn-resume"
                onClick={async () => {
                  const name = newGroupName.trim()
                  if (!name) return
                  const r = await postKeyValueGroup({ name, description: newGroupDesc.trim() || undefined })
                  if (r.ok) {
                    setNewGroupName('')
                    setNewGroupDesc('')
                    setKeyValueMsg({ text: 'Group added.', isErr: false })
                    const r2 = await fetchKeyValueGroups()
                    if (r2.ok) setKeyValueGroups(r2.items ?? [])
                  } else setKeyValueMsg({ text: r.error ?? 'Failed', isErr: true })
                }}
              >
                Add group
              </button>
              <button type="button" className="btn-pause" onClick={async () => { const r = await fetchKeyValueGroups(); if (r.ok) setKeyValueGroups(r.items ?? []) }} disabled={keyValueLoading}>
                Refresh groups
              </button>
            </div>
            {keyValueGroups.length === 0 && !keyValueLoading ? (
              <p className="section-hint">No groups yet. Add a group name above (e.g. flex_range_options).</p>
            ) : (
              <table className="settings-key-value-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem', marginBottom: '1rem' }} aria-label="Key-Value Groups">
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Name</th>
                    <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Description</th>
                    <th style={{ width: '10rem' }} />
                  </tr>
                </thead>
                <tbody>
                  {keyValueGroups.map((g) => (
                    <tr key={g.id}>
                      <td style={{ padding: '0.25rem 0.5rem', fontFamily: 'monospace' }}>
                        {editingGroupName === g.name ? (
                          <input type="text" value={editGroupName} onChange={(e) => setEditGroupName(e.target.value)} className="settings-key-value-input" style={{ width: '100%' }} aria-label="Edit group name" />
                        ) : (
                          g.name
                        )}
                      </td>
                      <td style={{ padding: '0.25rem 0.5rem' }}>
                        {editingGroupName === g.name ? (
                          <input type="text" value={editGroupDesc} onChange={(e) => setEditGroupDesc(e.target.value)} placeholder="Optional" className="settings-key-value-input" style={{ width: '100%' }} aria-label="Edit group description" />
                        ) : (
                          g.description ?? '—'
                        )}
                      </td>
                      <td style={{ padding: '0.25rem' }}>
                        {editingGroupName === g.name ? (
                          <>
                            <button type="button" className="btn-resume" onClick={async () => { const r = await patchKeyValueGroup(g.name, { name: editGroupName.trim(), description: editGroupDesc.trim() || undefined }); if (r.ok) { setEditingGroupName(null); const r2 = await fetchKeyValueGroups(); if (r2.ok) setKeyValueGroups(r2.items ?? []); if (selectedGroupName === g.name) setSelectedGroupName(editGroupName.trim() || null) } else setKeyValueMsg({ text: r.error ?? 'Failed', isErr: true }) }} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Save</button>
                            <button type="button" className="btn-pause" onClick={() => setEditingGroupName(null)} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Cancel</button>
                          </>
                        ) : (
                          <>
                            <button type="button" className="btn-resume" onClick={() => { setSelectedGroupName(g.name); loadKeyValueItemsForGroup(g.name) }} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Select</button>
                            <button type="button" className="btn-resume" onClick={() => { setEditingGroupName(g.name); setEditGroupName(g.name); setEditGroupDesc(g.description ?? '') }} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Edit</button>
                            <button type="button" className="btn-pause" onClick={async () => { if (!window.confirm(`Delete group "${g.name}" and all its key-values?`)) return; const r = await deleteKeyValueGroup(g.name); if (r.ok) { setKeyValueGroups(prev => prev.filter(x => x.name !== g.name)); if (selectedGroupName === g.name) { setSelectedGroupName(null); setKeyValueItems([]) }; setKeyValueMsg({ text: 'Group deleted.', isErr: false }) } else setKeyValueMsg({ text: r.error ?? 'Delete failed', isErr: true }) }} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {selectedGroupName != null && (
              <>
                <h4 style={{ marginBottom: '0.5rem' }}>Key-Values for group: {keyValueGroups.find(g => g.name === selectedGroupName)?.name ?? selectedGroupName}</h4>
                <div className="controls" style={{ flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                  <input type="text" placeholder="Key" value={newKey} onChange={(e) => setNewKey(e.target.value)} className="settings-key-value-input" aria-label="New key" style={{ width: '12rem' }} />
                  <input type="text" placeholder="Value" value={newValue} onChange={(e) => setNewValue(e.target.value)} className="settings-key-value-input" aria-label="New value" style={{ width: '10rem' }} />
                  <input type="text" placeholder="Description (optional)" value={newDesc} onChange={(e) => setNewDesc(e.target.value)} className="settings-key-value-input" aria-label="Description" style={{ width: '14rem' }} />
                  <button
                    type="button"
                    className="btn-resume"
                    onClick={async () => {
                      const k = newKey.trim()
                      if (!k) return
                      const r = await postKeyValueConfig({ group_name: selectedGroupName, key: k, value: newValue.trim(), description: newDesc.trim() || undefined })
                      if (r.ok) { setNewKey(''); setNewValue(''); setNewDesc(''); loadKeyValueItemsForGroup(selectedGroupName); setKeyValueMsg({ text: 'Saved.', isErr: false }) } else setKeyValueMsg({ text: r.error ?? 'Save failed', isErr: true })
                    }}
                  >
                    Add key-value
                  </button>
                  <button type="button" className="btn-pause" onClick={() => { setSelectedGroupName(null); setKeyValueItems([]) }}>Clear selection</button>
                </div>
                {keyValueMsg.text && (
                  <div className={keyValueMsg.isErr ? 'msg-error' : 'msg-ok'} style={{ marginBottom: '0.5rem' }}>{keyValueMsg.text}</div>
                )}
                {keyValueLoading ? (
                  <p>Loading…</p>
                ) : keyValueItems.length === 0 ? (
                  <p className="section-hint">No key-values in this group. Add key/value above.</p>
                ) : (
                  <table className="settings-key-value-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }} aria-label="Key-Values in group">
                    <thead>
                      <tr>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Key</th>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Value</th>
                        <th style={{ textAlign: 'left', padding: '0.25rem 0.5rem' }}>Description</th>
                        <th style={{ width: '9rem', minWidth: '9rem', textAlign: 'left', padding: '0.25rem 0.5rem' }}>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keyValueItems.map((row) => (
                        <tr key={`${selectedGroupName}-${row.key}`}>
                          <td style={{ padding: '0.25rem 0.5rem', fontFamily: 'monospace' }}>{row.key}</td>
                          <td style={{ padding: '0.25rem 0.5rem' }}>
                            {editingKey === row.key ? (
                              <input type="text" value={editValue} onChange={(e) => setEditValue(e.target.value)} className="settings-key-value-input" style={{ width: '100%', maxWidth: '14rem' }} aria-label={`Edit value for ${row.key}`} />
                            ) : (
                              <span>{row.value}</span>
                            )}
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem' }}>
                            {editingKey === row.key ? (
                              <input type="text" value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Optional" className="settings-key-value-input" style={{ width: '100%', maxWidth: '12rem' }} aria-label={`Edit description for ${row.key}`} />
                            ) : (
                              <span>{row.description ?? '—'}</span>
                            )}
                          </td>
                          <td style={{ padding: '0.25rem 0.5rem', whiteSpace: 'nowrap' }}>
                            {editingKey === row.key ? (
                              <>
                                <button type="button" className="btn-resume" onClick={async () => { const r = await postKeyValueConfig({ group_name: selectedGroupName, key: row.key, value: editValue, description: editDesc.trim() || undefined }); if (r.ok) { setEditingKey(null); loadKeyValueItemsForGroup(selectedGroupName); setKeyValueMsg({ text: 'Saved.', isErr: false }) } else setKeyValueMsg({ text: r.error ?? 'Failed', isErr: true }) }} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Save</button>
                                <button type="button" className="btn-pause" onClick={() => setEditingKey(null)} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button type="button" className="btn-resume" onClick={() => { setEditingKey(row.key); setEditValue(row.value); setEditDesc(row.description ?? '') }} style={{ marginRight: '0.25rem', padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Edit</button>
                                <button type="button" className="btn-pause" onClick={async () => { if (!window.confirm(`Delete key "${row.key}"?`)) return; const r = await deleteKeyValueConfig(row.key, selectedGroupName); if (r.ok) { loadKeyValueItemsForGroup(selectedGroupName); setKeyValueMsg({ text: 'Deleted.', isErr: false }); if (editingKey === row.key) setEditingKey(null) } else setKeyValueMsg({ text: r.error ?? 'Delete failed', isErr: true }) }} style={{ padding: '0.15rem 0.4rem', fontSize: '0.8rem' }}>Delete</button>
                              </>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </div>
        </div>
        </div>
      </div>
      </div>
    </div>
  )
}
