import { useEffect, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import type { FlexAccountItem } from '../types'
import {
  postIbConfig,
  postSetHeartbeatInterval,
  postFlexConfig,
  fetchMarketHolidays,
  postMarketHoliday,
  deleteMarketHoliday,
  type MarketHolidayRow,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import {
  DEFAULT_BARS_FETCH,
  DEFAULT_DAEMON,
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_HOST,
  DEFAULT_LISTENER,
  DEFAULT_PORT_TYPE,
  DEFAULT_REFRESH_EXECUTIONS,
  DEFAULT_WORKER,
  FLEX_QUERY_TYPES,
  getDefaultFlexRows,
  IB_CONNECTION_SUBSECTIONS,
  SETTINGS_SECTIONS,
  STATUS_SECTIONS,
  CONFIG_SECTIONS,
  FEED_SUBSECTIONS,
} from './settings/settingsConstants'
import { SettingsSectionIcon } from './settings/SettingsSectionIcon'
import { HeartbeatSection } from './settings/HeartbeatSection'
import { IbConnectionSection } from './settings/IbConnectionSection'
import { HolidaysSection } from './settings/HolidaysSection'
import { StatusPage } from './StatusPage'
import { DataPage } from './DataPage'
import { FeedMassiveOptionPage } from './FeedMassiveOptionPage'

export interface SettingsPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  operations?: Operation[]
  onNavigateToStrategy?: () => void
}

export function SettingsPage({ status, loadStatus, operations = [], onNavigateToStrategy }: SettingsPageProps) {
  const [msg, setMsg] = useState({ text: '', isErr: false })
  const [ibHost, setIbHost] = useState(DEFAULT_HOST)
  const [ibPortType, setIbPortType] = useState<'tws_live' | 'tws_paper' | 'gateway'>(DEFAULT_PORT_TYPE)
  const [clientIdDaemon, setClientIdDaemon] = useState(DEFAULT_DAEMON)
  const [clientIdListener, setClientIdListener] = useState(DEFAULT_LISTENER)
  const [clientIdAccount, setClientIdAccount] = useState(DEFAULT_REFRESH_EXECUTIONS)
  const [clientIdMarkets, setClientIdMarkets] = useState(DEFAULT_BARS_FETCH)
  const [clientIdWorker, setClientIdWorker] = useState(DEFAULT_WORKER)
  const [hostAccountId, setHostAccountId] = useState<string>('')
  const [streamHostAccountId, setStreamHostAccountId] = useState<string>('')
  const [streamSecondaryAccountId, setStreamSecondaryAccountId] = useState<string>('')
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
    if (c.ib_host_account_id != null) setHostAccountId(String(c.ib_host_account_id))
    if (c.stream_host_account_id != null) setStreamHostAccountId(String(c.stream_host_account_id))
    if ((c as { stream_secondary_account_id?: string }).stream_secondary_account_id != null) setStreamSecondaryAccountId(String((c as { stream_secondary_account_id?: string }).stream_secondary_account_id))
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

  // Sync sidebar active state with hash (GitHub-style: highlight current section). Map ib-* and flex-preference to settings-ib-connection. Map settings-system-* to settings-system.
  const hashToSectionId = (hash: string) => {
    const h = hash ? hash.slice(1) : ''
    if (h && (h.startsWith('ib-') || h === 'flex-preference' || h === 'settings-ib-connection')) return 'settings-ib-connection'
    if (h && h.startsWith('settings-system')) return 'settings-system'
    if (h && h.startsWith('feed-')) return 'settings-feed'
    return h || SETTINGS_SECTIONS[0].id
  }
  const [activeSectionId, setActiveSectionId] = useState<string>(() => {
    if (typeof window === 'undefined') return SETTINGS_SECTIONS[0].id
    return hashToSectionId(window.location.hash)
  })
  const [ibConnectionExpanded, setIbConnectionExpanded] = useState(true)
  const currentHash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  const activeSubId = activeSectionId === 'settings-ib-connection' && IB_CONNECTION_SUBSECTIONS.some(s => s.id === currentHash) ? currentHash : ''
  const activeFeedSubId = activeSectionId === 'settings-feed' && FEED_SUBSECTIONS.some(s => s.id === currentHash) ? currentHash : ''
  useEffect(() => {
    const onHashChange = () => setActiveSectionId(hashToSectionId(window.location.hash))
    window.addEventListener('hashchange', onHashChange)
    if (window.location.hash) setActiveSectionId(hashToSectionId(window.location.hash))
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

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
    const sec = Math.max(5, Math.min(120, Math.round(Number(heartbeatIntervalSec)) || DEFAULT_HEARTBEAT_SEC))
    const flexToSave = flexAccounts.map((a, i) => ({
      purpose: FLEX_QUERY_TYPES[i].purpose,
      query_label: FLEX_QUERY_TYPES[i].label,
      query_host_id: (a.query_host_id || '').trim(),
      query_secondary_id: (a.query_secondary_id || '').trim() || undefined,
    }))
    const [resIb, resHb, resFlex] = await Promise.all([
      postIbConfig({
        ib_host_account_id: hostAccountId.trim() || null,
        stream_host_account_id: streamHostAccountId.trim() || null,
        stream_secondary_account_id: streamSecondaryAccountId.trim() || null,
      }),
      postSetHeartbeatInterval(sec),
      postFlexConfig(flexHostToken.trim() || undefined, flexSecondaryToken.trim() || undefined, flexToSave, defaultFlexRangeDays, initFlexRangeDays),
    ])
    const ok = resIb.ok && resHb.ok && resFlex.ok
    const err = !resIb.ok ? resIb.error : !resHb.ok ? resHb.error : !resFlex.ok ? resFlex.error : undefined
    setMsg({
      text: ok
        ? 'Settings saved. IB host/port/client IDs are in config.yaml (restart processes after file changes). Account/stream IDs and heartbeat apply as before.'
        : err ?? 'Save failed',
      isErr: !ok,
    })
    if (ok) {
      setHeartbeatIntervalSec(sec)
      loadStatus()
    }
  }

  const isSystemSection = activeSectionId === 'settings-system'
  const isFeedSection = activeSectionId === 'settings-feed'
  const systemHighlightSection =
    currentHash === 'settings-system-daemon'
      ? 'daemon'
      : currentHash === 'settings-system-monitor'
        ? 'monitor'
        : currentHash === 'settings-system-celery'
          ? 'celery'
          : undefined

  return (
    <div className="settings-page">
      <nav className="settings-sidebar" aria-label="Settings sections">
        <div className="settings-sidebar-group-block" role="group" aria-label="Status and feed">
          <div className="settings-sidebar-group-label">Status</div>
          {STATUS_SECTIONS.map(({ id, label, icon }) => (
            <a
              key={id}
              href={`#${id}`}
              className={`settings-sidebar-link ${activeSectionId === id ? 'active' : ''}`}
            >
              <SettingsSectionIcon name={icon} />
              {label}
            </a>
          ))}
          <div className="settings-sidebar-inline-split" role="presentation" aria-hidden />
          <div className="settings-sidebar-group-label">Feed</div>
          {FEED_SUBSECTIONS.map((sub) => (
            <a
              key={sub.id}
              href={`#${sub.id}`}
              className={`settings-sidebar-link ${activeFeedSubId === sub.id ? 'active' : ''}`}
            >
              <SettingsSectionIcon name={sub.icon} />
              {sub.label}
            </a>
          ))}
        </div>
        <div className="settings-sidebar-group-block" role="group" aria-label="Configuration">
          <div className="settings-sidebar-group-label">Configuration</div>
          {CONFIG_SECTIONS.map(({ id, label, icon }) => {
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
                    aria-label={ibConnectionExpanded ? 'Collapse IB Configure' : 'Expand IB Configure'}
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
        </div>
      </nav>
      <div className="settings-main">
        {isSystemSection ? (
          <StatusPage
            status={status}
            operations={operations}
            loadStatus={loadStatus}
            onNavigateToStrategy={onNavigateToStrategy}
            showSectionTabs={false}
            showAllSystemSections={true}
            showSystemSection={true}
            showConsoleSection={true}
            showConsoleTabs={true}
            consoleCardTitle="Console"
            highlightSection={systemHighlightSection}
          />
        ) : isFeedSection ? (
          currentHash === 'feed-massive-option' ? (
            <FeedMassiveOptionPage
              status={status}
              onGoToFeed={() => { window.location.hash = '#feed-ib-stock' }}
              onGoToScreener={() => { window.location.hash = '#feed-ib-stock' }}
              breadcrumbLabel="Massive Option"
            />
          ) : (
            <DataPage
              status={status}
              embeddedInSettings
              onBreadcrumbParent={() => { window.location.hash = '#settings-system' }}
              breadcrumbParentLabel="Settings"
              onGoToScreener={() => { window.location.hash = '#feed-ib-stock' }}
              breadcrumbLabel="IB Stock"
            />
          )
        ) : (
        <div className="settings-page-card">
          <div className="settings-page-header">
            <div className="settings-page-title-group">
              <h2 className="settings-page-title">
                Settings
                <InfoTooltip text="Configure daemon-related parameters; written to DB and read by daemon on start or next heartbeat." />
              </h2>
              <p className="settings-page-subtitle">Configure daemon, IB connection and market calendar</p>
            </div>
            <div className="settings-page-actions">
              {msg.text && (
                <span className={`settings-page-msg ${msg.isErr ? 'msg-error' : 'msg-ok'}`}>
                  {msg.text}
                </span>
              )}
              <button type="button" className="btn-resume settings-save-btn" onClick={onSave}>
                Save settings
              </button>
            </div>
          </div>
          <div className="daemon-groups settings-page-groups">
            <HeartbeatSection
              heartbeatIntervalSec={heartbeatIntervalSec}
              setHeartbeatIntervalSec={setHeartbeatIntervalSec}
            />
            <IbConnectionSection
              ibHost={ibHost}
              ibPortType={ibPortType}
              flexHostToken={flexHostToken}
              setFlexHostToken={setFlexHostToken}
              ib2Host={ib2Host}
              ib2PortType={ib2PortType}
              flexSecondaryToken={flexSecondaryToken}
              setFlexSecondaryToken={setFlexSecondaryToken}
              hostAccountId={hostAccountId}
              setHostAccountId={setHostAccountId}
              streamHostAccountId={streamHostAccountId}
              setStreamHostAccountId={setStreamHostAccountId}
              streamSecondaryAccountId={streamSecondaryAccountId}
              setStreamSecondaryAccountId={setStreamSecondaryAccountId}
              clientIdDaemon={clientIdDaemon}
              clientIdListener={clientIdListener}
              ib2ClientIdListener={ib2ClientIdListener}
              clientIdAccount={clientIdAccount}
              ib2ClientIdAccount={ib2ClientIdAccount}
              clientIdMarkets={clientIdMarkets}
              clientIdWorker={clientIdWorker}
              defaultFlexRangeDays={defaultFlexRangeDays}
              setDefaultFlexRangeDays={setDefaultFlexRangeDays}
              initFlexRangeDays={initFlexRangeDays}
              setInitFlexRangeDays={setInitFlexRangeDays}
              flexAccounts={flexAccounts}
              setFlexAccounts={setFlexAccounts}
              activeSubId={activeSubId}
            />
            <HolidaysSection
              currentYear={currentYear}
              holidays={holidays}
              holidaysYear={holidaysYear}
              setHolidaysYear={setHolidaysYear}
              holidaysLoading={holidaysLoading}
              loadHolidays={loadHolidays}
              addDate={addDate}
              setAddDate={setAddDate}
              addLabel={addLabel}
              setAddLabel={setAddLabel}
              holidayMsg={holidayMsg}
              onAddHoliday={onAddHoliday}
              onDeleteHoliday={onDeleteHoliday}
            />
          </div>
      </div>
        )}
      </div>
    </div>
  )
}
