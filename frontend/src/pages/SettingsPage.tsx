import { useEffect, useMemo, useState } from 'react'
import type { Operation, StatusResponse } from '../types'
import type { FlexAccountItem } from '../types'
import {
  postIbConfig,
  postSetHeartbeatInterval,
  postFlexConfig,
  fetchMarketHolidays,
  postMarketHoliday,
  deleteMarketHoliday,
  fetchMassiveStatus,
  type MarketHolidayRow,
  type MassiveStatusResponse,
} from '../api'
import { postAccountSyncSetHeartbeatInterval } from '../api/monitor/accountSync'
import { utilizedEnvFor } from '../utils/utilizedServices'
import { ingestRedisHealthLamp } from '../utils/socketIngestLamp'
import { InfoTooltip } from '../components/InfoTooltip'
import {
  DEFAULT_IB_OPERATOR,
  DEFAULT_DAEMON,
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_HOST,
  DEFAULT_LISTENER,
  DEFAULT_PORT_TYPE,
  DEFAULT_WORKER,
  DEFAULT_IB_INGESTOR,
  DEFAULT_IB_ACCOUNT_AGENT,
  DEFAULT_IB_ACCOUNT_AGENT_SECONDARY,
  FLEX_QUERY_TYPES,
  getDefaultFlexRows,
  IB_CONNECTION_SUBSECTIONS,
  SETTINGS_SECTIONS,
  CONFIG_SECTIONS,
  COVERAGE_SUBSECTIONS,
  FEED_MASSIVE_OPTION_ID,
  FEED_MASSIVE_STOCK_ID,
  FEED_SUBSECTIONS,
} from './settings/settingsConstants'
import { CAPABILITY_GROUP_LABELS, CAPABILITY_GROUP_ORDER, type CapabilityGroup } from './massiveFeedChecklistRows'
import { feedMassiveSvcAnchorId } from './massive/feedMassiveAnchors'
import { isMassiveOptionFeedHash, parseFeedMassiveTabFromHash } from './massive/feedMassiveTabUtils'
import { isMassiveStockFeedHash, parseFeedMassiveStockTabFromHash } from './massive/feedMassiveStockTabUtils'
import { feedMassiveStockSvcAnchorId } from './massive/feedMassiveStockTabUtils'
import {
  effectiveChecklistProjectStatus as stockEffectiveStatus,
  groupedStockChecklistRows,
  shortServiceLabel as stockShortServiceLabel,
  tierOkForRow as stockTierOkForRow,
  tradesOkForRow as stockTradesOkForRow,
} from './massive/massiveStockChecklistStatus'
import {
  effectiveChecklistProjectStatus,
  groupedChecklistRows,
  shortServiceLabel,
  tierOkForRow,
  tradesOkForRow,
} from './massive/massiveChecklistStatus'
import { SettingsSectionIcon } from './settings/SettingsSectionIcon'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
import { HeartbeatSection } from './settings/HeartbeatSection'
import { IbConnectionSection } from './settings/IbConnectionSection'
import { HolidaysSection } from './settings/HolidaysSection'
import { DataPage } from './DataPage'
import { FeedMassiveOptionPage } from './FeedMassiveOptionPage'
import { FeedMassiveStockPage } from './FeedMassiveStockPage'
import { DaemonStatusPage } from './DaemonStatusPage'
import { IbEventSubscribePage } from './IbEventSubscribePage'
import { MassiveApiStatusPage } from './MassiveApiStatusPage'
import { ArchitectureApisPage } from './ArchitectureApisPage'
import { AccountApisPage } from './AccountApisPage'
import { ResearchApisPage } from './ResearchApisPage'
import { CeleryControlPage } from './CeleryControlPage'
import { MarketIngestOpsPage } from './MarketIngestOpsPage'
import { ApiHealthOverviewPage, computeApiHealthAggregateLamp } from './ApiHealthOverviewPage'
import { SettingsShell } from './settings/SettingsShell'
import { FEED_MASSIVE_DAILY_DATA_ID } from './massive/feedMassiveTabUtils'
import { OptionCoveragePage } from './OptionCoveragePage'
import { StockCoveragePage } from './StockCoveragePage'
import { useDeferredStart } from '../hooks/useDeferredStart'
import type { SettingsApiHealthProbesState } from '../hooks/useSettingsApiHealthProbes'
import { fetchMarketIngestServices, type MarketIngestServiceRow } from '../api/ops/ops'
import { aggregateIngestRedisHealthLamp, type AggregateIngestLamp } from '../utils/socketIngestLamp'

const API_SETTINGS_DETAIL_HASHES = [
  'settings-api-architecture',
  'settings-api-account',
  'settings-api-research',
  'settings-api-massive',
] as const

/** Stack indicator from GET /health utilized_services (YAML). */
function SettingsSidebarServiceEnvBadge({ stack }: { stack: 'prod' | 'dev' | null }) {
  if (stack == null) return null
  const label = stack === 'prod' ? 'Production stack' : 'Development stack'
  return (
    <span
      className={`settings-sidebar-service-env-badge settings-sidebar-service-env-badge--${stack}`}
      title={`${label} (from utilized.services in server config)`}
      aria-label={label}
    >
      <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden>
        {stack === 'prod' ? (
          <circle cx="6" cy="6" r="4" fill="currentColor" />
        ) : (
          <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
        )}
      </svg>
    </span>
  )
}

export interface SettingsPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  operations?: Operation[]
  onNavigateToStrategy?: () => void
  onNavigateToSocket?: () => void
  /** Celery runtime lamp (same source as header / System aggregate). */
  celeryLamp?: 'green' | 'yellow' | 'red' | 'none'
  /** API sidebar lamps + utilized services (from App `useSettingsApiHealthProbes`, same as header shortcuts). */
  apiHealthProbes: SettingsApiHealthProbesState
}

export function SettingsPage({
  status,
  loadStatus,
  operations = [],
  onNavigateToStrategy,
  onNavigateToSocket,
  celeryLamp = 'none',
  apiHealthProbes,
}: SettingsPageProps) {
  const [msg, setMsg] = useState({ text: '', isErr: false })
  const [ibHost, setIbHost] = useState(DEFAULT_HOST)
  const [ibPortType, setIbPortType] = useState<'tws_live' | 'tws_paper' | 'gateway'>(DEFAULT_PORT_TYPE)
  const [clientIdDaemon, setClientIdDaemon] = useState(DEFAULT_DAEMON)
  const [clientIdListener, setClientIdListener] = useState(DEFAULT_LISTENER)
  const [clientIdOperator, setClientIdOperator] = useState(DEFAULT_IB_OPERATOR)
  const [clientIdWorker, setClientIdWorker] = useState(DEFAULT_WORKER)
  const [clientIdIbIngestor, setClientIdIbIngestor] = useState(DEFAULT_IB_INGESTOR)
  const [clientIdAccountAgent, setClientIdAccountAgent] = useState(DEFAULT_IB_ACCOUNT_AGENT)
  const [ib2ClientIdAccountAgent, setIb2ClientIdAccountAgent] = useState(DEFAULT_IB_ACCOUNT_AGENT_SECONDARY)
  const [hostAccountId, setHostAccountId] = useState<string>('')
  const [streamHostAccountId, setStreamHostAccountId] = useState<string>('')
  const [streamSecondaryAccountId, setStreamSecondaryAccountId] = useState<string>('')
  const [ib2Host, setIb2Host] = useState<string>('')
  const [ib2PortType, setIb2PortType] = useState<'tws_live' | 'tws_paper' | 'gateway'>(DEFAULT_PORT_TYPE)
  const [ib2ClientIdListener, setIb2ClientIdListener] = useState(3)
  const [ib2ClientIdOperator, setIb2ClientIdOperator] = useState(102)
  const [heartbeatIntervalSec, setHeartbeatIntervalSec] = useState(DEFAULT_HEARTBEAT_SEC)
  const [accountSyncIntervalSec, setAccountSyncIntervalSec] = useState(5)
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
    const c = status?.config?.ib_client
    if (!c || ibConfigInitialized) return
    const cl = c.client
    if (cl?.host_ip != null) setIbHost(cl.host_ip)
    if (cl?.host_port_type != null) setIbPortType(cl.host_port_type)
    const pid = c.port
    const acc = c.account
    if (pid?.trading != null) setClientIdDaemon(pid.trading)
    if (pid?.listener_host != null) setClientIdListener(pid.listener_host)
    if (pid?.operator_host != null) setClientIdOperator(pid.operator_host)
    if (pid?.market_data_worker != null) setClientIdWorker(pid.market_data_worker)
    if (pid?.ingestor != null) setClientIdIbIngestor(pid.ingestor)
    if (pid?.account_agent != null) setClientIdAccountAgent(pid.account_agent)
    if (pid?.account_agent_secondary != null) setIb2ClientIdAccountAgent(pid.account_agent_secondary)
    if (acc?.trading != null) setHostAccountId(String(acc.trading))
    if (acc?.event_host != null) setStreamHostAccountId(String(acc.event_host))
    if (acc?.event_secondary != null) setStreamSecondaryAccountId(String(acc.event_secondary))
    if (cl?.secondary_host_ip != null) setIb2Host(String(cl.secondary_host_ip))
    if (cl?.secondary_port_type != null) setIb2PortType(cl.secondary_port_type as 'tws_live' | 'tws_paper' | 'gateway')
    if (pid?.listener_secondary != null) setIb2ClientIdListener(pid.listener_secondary)
    if (pid?.operator_secondary != null) setIb2ClientIdOperator(pid.operator_secondary)
    setIbConfigInitialized(true)
  }, [status?.config?.ib_client, ibConfigInitialized])

  useEffect(() => {
    if (!status || flexInitialized) return
    const fc = status.config?.ib_flex
    const days = fc?.default_range_days
    if (typeof days === 'number' && Number.isFinite(days) && days >= 1) setDefaultFlexRangeDays(Math.round(days))
    const initDays = fc?.init_range_days
    if (typeof initDays === 'number' && Number.isFinite(initDays) && initDays >= 1) setInitFlexRangeDays(Math.round(initDays))
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
  }, [status, status?.config?.ib_flex, flexInitialized])

  useEffect(() => {
    const sec = status?.daemon?.heartbeat?.heartbeat_interval_sec
    if (heartbeatInitialized) return
    if (sec != null && Number.isFinite(sec)) {
      setHeartbeatIntervalSec(sec)
      setHeartbeatInitialized(true)
    }
  }, [status?.daemon?.heartbeat?.heartbeat_interval_sec, heartbeatInitialized])

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

  const hashToSectionId = (hash: string) => {
    const h = hash ? hash.slice(1) : ''
    if (h === FEED_MASSIVE_DAILY_DATA_ID) return 'settings-coverage'
    if (h && h.startsWith('coverage-')) return 'settings-coverage'
    if (h && (h.startsWith('ib-') || h === 'flex-preference' || h === 'settings-ib-connection')) return 'settings-ib-connection'
    if (h === 'settings-subscribe') return 'settings-subscribe'
    if (h === 'settings-daemon' || h === 'settings-system-daemon' || h === 'settings-system') return 'settings-daemon'
    if (h === 'settings-system-monitor' || h === 'settings-system-server') return 'settings-api'
    if (h === 'settings-celery' || h === 'settings-dashboard-celery') return 'settings-celery'
    if (
      h === 'settings-market-ingest' ||
      h === 'settings-ib-connector' ||
      h === 'settings-ws-connector' ||
      h === 'settings-ws-agent'
    ) {
      return 'settings-ws-connector'
    }
    if (h === 'settings-services-overview') return 'settings-api'
    if (h && h.startsWith('settings-api')) return 'settings-api'
    if (h === 'feed-celery' || h === 'settings-system-celery') return 'settings-celery'
    if (h && isMassiveOptionFeedHash(`#${h}`)) return 'settings-feed'
    if (h && isMassiveStockFeedHash(`#${h}`)) return 'settings-feed'
    if (h && h.startsWith('feed-')) return 'settings-feed'
    return h || SETTINGS_SECTIONS[0].id
  }
  const [activeSectionId, setActiveSectionId] = useState<string>(() => {
    if (typeof window === 'undefined') return SETTINGS_SECTIONS[0].id
    return hashToSectionId(window.location.hash)
  })
  const [ibConnectionExpanded, setIbConnectionExpanded] = useState(true)
  const [massiveOptionExpanded, setMassiveOptionExpanded] = useState(false)
  const [massiveStockExpanded, setMassiveStockExpanded] = useState(false)
  const [massiveStockCapGroupExpanded, setMassiveStockCapGroupExpanded] = useState<Record<CapabilityGroup, boolean>>(() =>
    CAPABILITY_GROUP_ORDER.reduce(
      (acc, g) => { acc[g] = false; return acc },
      {} as Record<CapabilityGroup, boolean>,
    ),
  )
  const [massiveCapGroupExpanded, setMassiveCapGroupExpanded] = useState<Record<CapabilityGroup, boolean>>(() =>
    CAPABILITY_GROUP_ORDER.reduce(
      (acc, g) => {
        acc[g] = false
        return acc
      },
      {} as Record<CapabilityGroup, boolean>,
    ),
  )
  const [apiExpanded, setApiExpanded] = useState(true)
  const [appExpanded, setAppExpanded] = useState(true)
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [apiAggregateLamp, setApiAggregateLamp] = useState<'green' | 'yellow' | 'red' | 'none'>('none')
  const [socketIngestLamp, setSocketIngestLamp] = useState<AggregateIngestLamp>('none')
  const [socketIngestTitle, setSocketIngestTitle] = useState(
    'Socket ingest Redis health from Monitor GET /status `socket` (loading…)',
  )
  const [ingestServicesCache, setIngestServicesCache] = useState<MarketIngestServiceRow[]>([])
  const [ingestServicesFetchError, setIngestServicesFetchError] = useState<string | null>(null)
  const deferredStart = useDeferredStart(280)
  const {
    utilizedServices,
    architectureApiLamp,
    accountApiLamp,
    researchApiLamp,
    massiveApiLamp,
  } = apiHealthProbes
  const currentHash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  const activeSubId = activeSectionId === 'settings-ib-connection' && IB_CONNECTION_SUBSECTIONS.some(s => s.id === currentHash) ? currentHash : ''
  const activeIbStockFeed = activeSectionId === 'settings-feed' && currentHash === 'feed-ib-stock'
  const isMassiveOptionFeedActive = activeSectionId === 'settings-feed' && isMassiveOptionFeedHash(currentHash)
  const isMassiveStockFeedActive = activeSectionId === 'settings-feed' && isMassiveStockFeedHash(currentHash)
  /** Same as Daemon page title lamp: trading_engine Redis/heartbeat via GET /status (DaemonEngineOpsSection). */
  const daemonPageLamp = useMemo(() => ingestRedisHealthLamp('trading_engine', status), [status])
  const daemonLamp = daemonPageLamp.lamp
  const subscribeLamp: 'none' = 'none'
  const isSubscribeSection = activeSectionId === 'settings-subscribe'
  const isDaemonSection = activeSectionId === 'settings-daemon'
  const isApiSection = activeSectionId === 'settings-api'
  const isApiDetailSubPage =
    isApiSection && API_SETTINGS_DETAIL_HASHES.includes(currentHash as (typeof API_SETTINGS_DETAIL_HASHES)[number])
  const isApiOverviewMain = isApiSection && !isApiDetailSubPage
  const isApiArchitectureActive = isApiSection && currentHash === 'settings-api-architecture'
  const isApiAccountActive = isApiSection && currentHash === 'settings-api-account'
  const isApiResearchActive = isApiSection && currentHash === 'settings-api-research'
  const isApiMassiveActive = isApiSection && currentHash === 'settings-api-massive'
  const massiveStackEnv = utilizedEnvFor(utilizedServices, 'massive')

  useEffect(() => {
    if (!deferredStart) return
    let cancelled = false
    const load = () => {
      fetchMassiveStatus()
        .then(s => { if (!cancelled) setMassiveStatus(s) })
        .catch(() => { if (!cancelled) setMassiveStatus(null) })
      computeApiHealthAggregateLamp()
        .then((l) => {
          if (!cancelled) setApiAggregateLamp(l)
        })
        .catch(() => {
          if (!cancelled) setApiAggregateLamp('none')
        })
      fetchMarketIngestServices()
        .then(res => {
          if (cancelled) return
          if (res.ok && Array.isArray(res.services)) {
            setIngestServicesCache(res.services)
            setIngestServicesFetchError(null)
          } else {
            setIngestServicesCache([])
            setIngestServicesFetchError(
              res.error
                ? `Could not load ingest services: ${res.error}`
                : 'Could not load ingest services from Ops.',
            )
          }
        })
        .catch(() => {
          if (!cancelled) {
            setIngestServicesCache([])
            setIngestServicesFetchError('Could not load ingest services from Ops.')
          }
        })
    }
    load()
    const t = window.setInterval(load, 20000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [deferredStart])

  const socketIngestAggregate = useMemo(() => {
    if (ingestServicesFetchError) {
      return { lamp: 'none' as AggregateIngestLamp, title: ingestServicesFetchError }
    }
    const ingestOnly = ingestServicesCache.filter(s => s.id !== 'trading_engine')
    return aggregateIngestRedisHealthLamp(ingestOnly.map(svc => ({ svc })), status)
  }, [ingestServicesCache, ingestServicesFetchError, status])

  useEffect(() => {
    setSocketIngestLamp(socketIngestAggregate.lamp)
    setSocketIngestTitle(socketIngestAggregate.title)
  }, [socketIngestAggregate])

  const appAggregateLamp = useMemo((): 'green' | 'yellow' | 'red' | 'none' => {
    const socketRank =
      socketIngestLamp === 'red'
        ? 3
        : socketIngestLamp === 'yellow' || socketIngestLamp === 'gray'
          ? 2
          : socketIngestLamp === 'green'
            ? 1
            : 0
    const dRank =
      daemonLamp === 'red' ? 3 : daemonLamp === 'yellow' || daemonLamp === 'gray' ? 2 : 1
    const cRank =
      celeryLamp === 'red' ? 3 : celeryLamp === 'yellow' ? 2 : celeryLamp === 'green' ? 1 : 0
    const w = Math.max(socketRank, dRank, cRank)
    if (w === 3) return 'red'
    if (w === 2) return 'yellow'
    if (w === 1) return 'green'
    return 'none'
  }, [socketIngestLamp, daemonLamp, celeryLamp])

  useEffect(() => {
    const fromTab = parseFeedMassiveTabFromHash(`#${currentHash}`)
    setMassiveCapGroupExpanded(prev => {
      let next: Record<CapabilityGroup, boolean> | null = null
      const ensureOpen = (g: CapabilityGroup) => {
        if (!prev[g]) {
          if (!next) next = { ...prev }
          next[g] = true
        }
      }
      for (const { group, rows: groupRows } of groupedChecklistRows()) {
        const active = groupRows.some(row => {
          const anchor = feedMassiveSvcAnchorId(row.id)
          return currentHash === anchor || fromTab === row.id
        })
        if (active) ensureOpen(group)
      }
      return next ?? prev
    })
  }, [currentHash])

  useEffect(() => {
    const normalizeHash = (): string => {
      let h = window.location.hash
      if (
        h === '#feed-celery' ||
        h === '#settings-system-celery' ||
        h === '#settings-dashboard-celery' ||
        h === '#settings-dashboard' ||
        h.startsWith('#settings-dashboard-')
      ) {
        const next = `${window.location.pathname}${window.location.search}#settings-celery`
        window.history.replaceState(null, '', next)
        h = '#settings-celery'
      }
      if (h === '#settings-services-overview') {
        const next = `${window.location.pathname}${window.location.search}#settings-api`
        window.history.replaceState(null, '', next)
        h = '#settings-api'
      }
      if (
        h === '#settings-api-monitor' ||
        h === '#settings-api-docs' ||
        h === '#settings-api-ops'
      ) {
        const next = `${window.location.pathname}${window.location.search}#settings-api-architecture`
        window.history.replaceState(null, '', next)
        h = '#settings-api-architecture'
      }
      if (h === '#settings-system-server') {
        const next = `${window.location.pathname}${window.location.search}#settings-api-architecture`
        window.history.replaceState(null, '', next)
        h = '#settings-api-architecture'
      }
      if (h === '#settings-system-monitor') {
        const next = `${window.location.pathname}${window.location.search}#settings-api-architecture`
        window.history.replaceState(null, '', next)
        h = '#settings-api-architecture'
      }
      if (h === '#settings-api-health' || h === '#settings-api-overview') {
        const next = `${window.location.pathname}${window.location.search}#settings-api`
        window.history.replaceState(null, '', next)
        h = '#settings-api'
      }
      if (h === '#settings-system' || h === '#settings-system-daemon') {
        const next = `${window.location.pathname}${window.location.search}#settings-daemon`
        window.history.replaceState(null, '', next)
        h = '#settings-daemon'
      }
      return h
    }
    const syncFromHash = () => {
      const h = normalizeHash()
      setActiveSectionId(hashToSectionId(h))
    }
    window.addEventListener('hashchange', syncFromHash)
    syncFromHash()
    return () => window.removeEventListener('hashchange', syncFromHash)
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
    const asSec = Math.max(2, Math.min(60, Number(accountSyncIntervalSec) || 5))
    const [resIb, resHb, resFlex, resAs] = await Promise.all([
      postIbConfig({
        ib_host_account_id: hostAccountId.trim() || null,
        stream_host_account_id: streamHostAccountId.trim() || null,
        stream_secondary_account_id: streamSecondaryAccountId.trim() || null,
      }),
      postSetHeartbeatInterval(sec),
      postFlexConfig(flexHostToken.trim() || undefined, flexSecondaryToken.trim() || undefined, flexToSave, defaultFlexRangeDays, initFlexRangeDays),
      postAccountSyncSetHeartbeatInterval(asSec),
    ])
    const ok = resIb.ok && resHb.ok && resFlex.ok && resAs.ok
    const err = !resIb.ok ? resIb.error : !resHb.ok ? resHb.error : !resFlex.ok ? resFlex.error : !resAs.ok ? resAs.error : undefined
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


  const isCeleryControlSection = activeSectionId === 'settings-celery'
  const isWsConnectorSection = activeSectionId === 'settings-ws-connector'
  const isAppSection = isWsConnectorSection || isDaemonSection || isCeleryControlSection
  const isCoverageSection = activeSectionId === 'settings-coverage'
  const isFeedSection = activeSectionId === 'settings-feed'

  const sidebarContent = (
    <>
      <div className="settings-sidebar-group-block" role="group" aria-label="Status and feed">
        <div className="settings-sidebar-group-label">Status</div>
        <div className="settings-sidebar-group">
          <div className={`settings-sidebar-parent ${isApiSection ? 'active' : ''}`}>
            <a href="#settings-api" className="settings-sidebar-parent-label">
              <span
                className={`title-inline-lamp lamp-icon ${apiAggregateLamp === 'none' ? 'none' : apiAggregateLamp}`}
                title="API health: Architecture (Monitor, Ops, Docs) must be up; other FastAPIs drive yellow if any fail."
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="api" />
              </span>
              API
            </a>
            <button
              type="button"
              className={`settings-sidebar-chevron ${apiExpanded ? 'expanded' : ''}`}
              onClick={() => setApiExpanded(e => !e)}
              aria-expanded={apiExpanded}
              aria-controls="settings-api-subs"
              aria-label={apiExpanded ? 'Collapse API section' : 'Expand API section'}
            >
              ▼
            </button>
          </div>
          <div id="settings-api-subs" className="settings-sidebar-subs" hidden={!apiExpanded}>
            <a
              href="#settings-api-architecture"
              className={`settings-sidebar-link settings-sidebar-link-sub ${isApiArchitectureActive ? 'active' : ''}`}
            >
              <span
                className={`title-inline-lamp lamp-icon ${architectureApiLamp}`}
                title="Monitor, Docs, and Ops API health"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="api-architecture" />
              </span>
              Architecture
            </a>
            <a
              href="#settings-api-account"
              className={`settings-sidebar-link settings-sidebar-link-sub ${isApiAccountActive ? 'active' : ''}`}
            >
              <span
                className={`title-inline-lamp lamp-icon ${accountApiLamp === 'none' ? 'none' : accountApiLamp}`}
                title="Trading and Portfolio API health"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="api-account" />
              </span>
              Account
            </a>
            <a
              href="#settings-api-research"
              className={`settings-sidebar-link settings-sidebar-link-sub ${isApiResearchActive ? 'active' : ''}`}
            >
              <span
                className={`title-inline-lamp lamp-icon ${researchApiLamp === 'none' ? 'none' : researchApiLamp}`}
                title="Research, Strategy, and Market API health"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="api-research" />
              </span>
              Research
            </a>
            <a
              href="#settings-api-massive"
              className={`settings-sidebar-link settings-sidebar-link-sub ${isApiMassiveActive ? 'active' : ''}`}
            >
              <span className={`title-inline-lamp lamp-icon ${massiveApiLamp}`} title="Massive API health" aria-hidden>
                <SettingsSidebarLampGlyph id="api-massive" />
              </span>
              Massive
              <SettingsSidebarServiceEnvBadge stack={massiveStackEnv} />
            </a>
          </div>
        </div>
        <a
          href="#settings-subscribe"
          className={`settings-sidebar-link ${isSubscribeSection ? 'active' : ''}`}
        >
          <span
            className={`title-inline-lamp lamp-icon ${subscribeLamp}`}
            title="IB Event Subscribe: Redis Ingestor and Account Agent stream health; daemon ticker release"
            aria-hidden
          >
            <SettingsSidebarLampGlyph id="event-subscribe" />
          </span>
          Subscribe
        </a>
        <div className="settings-sidebar-group">
          <div className={`settings-sidebar-parent ${isAppSection ? 'active' : ''}`}>
            <a href="#settings-ws-connector" className="settings-sidebar-parent-label">
              <span
                className={`title-inline-lamp lamp-icon ${appAggregateLamp === 'none' ? 'none' : appAggregateLamp}`}
                title="Worst of Socket ingest, Daemon, and Celery runtime lamps"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="system" />
              </span>
              App
            </a>
            <button
              type="button"
              className={`settings-sidebar-chevron ${appExpanded ? 'expanded' : ''}`}
              onClick={() => setAppExpanded(e => !e)}
              aria-expanded={appExpanded}
              aria-controls="settings-app-subs"
              aria-label={appExpanded ? 'Collapse App section' : 'Expand App section'}
            >
              ▼
            </button>
          </div>
          <div id="settings-app-subs" className="settings-sidebar-subs" hidden={!appExpanded}>
            <a
              href="#settings-ws-connector"
              className={`settings-sidebar-link settings-sidebar-link-sub ${isWsConnectorSection ? 'active' : ''}`}
            >
              <span
                className={`title-inline-lamp lamp-icon ${socketIngestLamp === 'none' ? 'none' : socketIngestLamp}`}
                title={socketIngestTitle}
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="websocket" />
              </span>
              Socket
            </a>
            <a
              href="#settings-daemon"
              className={`settings-sidebar-link settings-sidebar-link-sub ${isDaemonSection ? 'active' : ''}`}
            >
              <span
                className={`title-inline-lamp lamp-icon ${daemonLamp}`}
                title={daemonPageLamp.title}
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="daemon" />
              </span>
              Daemon
            </a>
            <a
              href="#settings-celery"
              className={`settings-sidebar-link settings-sidebar-link-sub ${isCeleryControlSection ? 'active' : ''}`}
            >
              <span
                className={`title-inline-lamp lamp-icon ${celeryLamp === 'none' ? 'none' : celeryLamp}`}
                title="Celery workers (broker + inspect)"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="celery" />
              </span>
              Celery
            </a>
          </div>
        </div>
        <div className="settings-sidebar-inline-split" role="presentation" aria-hidden />
        <div className="settings-sidebar-group-label">Data Coverage</div>
        {COVERAGE_SUBSECTIONS.map((sub) => (
          <a
            key={sub.id}
            href={`#${sub.id}`}
            className={`settings-sidebar-link ${isCoverageSection && (currentHash === sub.id || (sub.id === 'coverage-option' && currentHash === FEED_MASSIVE_DAILY_DATA_ID))
                ? 'active'
                : ''
              }`}
          >
            <SettingsSectionIcon name={sub.icon} />
            {sub.label}
          </a>
        ))}
        <div className="settings-sidebar-inline-split" role="presentation" aria-hidden />
        <div className="settings-sidebar-group-label">Feed</div>
        {FEED_SUBSECTIONS.map((sub) => (
          <a
            key={sub.id}
            href={`#${sub.id}`}
            className={`settings-sidebar-link ${activeIbStockFeed ? 'active' : ''}`}
          >
            <SettingsSectionIcon name={sub.icon} />
            {sub.label}
          </a>
        ))}
        <div className="settings-sidebar-group">
          <div className={`settings-sidebar-parent ${isMassiveOptionFeedActive ? 'active' : ''}`}>
            <a href={`#${FEED_MASSIVE_OPTION_ID}`} className="settings-sidebar-parent-label">
              <SettingsSectionIcon name="feed-massive" />
              Massive Option
            </a>
            <button
              type="button"
              className={`settings-sidebar-chevron ${massiveOptionExpanded ? 'expanded' : ''}`}
              onClick={() => setMassiveOptionExpanded(e => !e)}
              aria-expanded={massiveOptionExpanded}
              aria-controls="settings-feed-massive-subs"
              aria-label={massiveOptionExpanded ? 'Collapse Massive Option capabilities' : 'Expand Massive Option capabilities'}
            >
              ▼
            </button>
          </div>
          <div id="settings-feed-massive-subs" className="settings-sidebar-subs" hidden={!massiveOptionExpanded}>
            {groupedChecklistRows().map(({ group, rows: groupRows }) => {
              const capGroupOpen = massiveCapGroupExpanded[group]
              const fromTab = parseFeedMassiveTabFromHash(`#${currentHash}`)
              const groupHasActive = groupRows.some(row => {
                const anchor = feedMassiveSvcAnchorId(row.id)
                return currentHash === anchor || fromTab === row.id
              })
              return (
                <div key={group} className="settings-sidebar-massive-group">
                  <div
                    className={`settings-sidebar-massive-cap-group-head${groupHasActive ? ' settings-sidebar-massive-cap-group-head--active' : ''
                      }`}
                  >
                    <button
                      type="button"
                      className="settings-sidebar-massive-cap-group-toggle"
                      aria-expanded={capGroupOpen}
                      aria-controls={`settings-massive-cap-group-${group}`}
                      id={`settings-massive-cap-group-head-${group}`}
                      onClick={() =>
                        setMassiveCapGroupExpanded(prev => ({ ...prev, [group]: !prev[group] }))
                      }
                    >
                      <span
                        className={`settings-sidebar-chevron settings-sidebar-massive-cap-group-chevron ${capGroupOpen ? 'expanded' : ''
                          }`}
                        aria-hidden
                      >
                        ▼
                      </span>
                      <span className="settings-sidebar-massive-cap-group-title">
                        {CAPABILITY_GROUP_LABELS[group]}
                      </span>
                    </button>
                  </div>
                  <div
                    id={`settings-massive-cap-group-${group}`}
                    className="settings-sidebar-massive-cap-group-subs"
                    hidden={!capGroupOpen}
                    role="group"
                    aria-labelledby={`settings-massive-cap-group-head-${group}`}
                  >
                    {groupRows.map(row => {
                      const configured = Boolean(massiveStatus?.configured)
                      const tierOk = tierOkForRow(row, massiveStatus, configured)
                      const tradesOk = tradesOkForRow(row, massiveStatus)
                      const eff = effectiveChecklistProjectStatus(row, configured, tierOk, tradesOk)
                      const isTierLimited = eff === 'not-on-tier'
                      const anchor = feedMassiveSvcAnchorId(row.id)
                      const childActive = currentHash === anchor || fromTab === row.id
                      return (
                        <a
                          key={row.id}
                          href={`#${anchor}`}
                          className={`settings-sidebar-link settings-sidebar-link-sub settings-sidebar-link-massive-cap ${childActive ? 'active' : ''}`}
                        >
                          <span
                            className={`title-inline-lamp lamp-icon ${isTierLimited ? 'tier' : 'none'}`}
                            title={isTierLimited ? 'Not available on current plan tier' : undefined}
                            aria-hidden
                          >
                            <SettingsSidebarLampGlyph id={row.id} />
                          </span>
                          <span className="settings-sidebar-massive-cap-label">{shortServiceLabel(row)}</span>
                        </a>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
        <div className="settings-sidebar-group">
          <div className={`settings-sidebar-parent ${isMassiveStockFeedActive ? 'active' : ''}`}>
            <a href={`#${FEED_MASSIVE_STOCK_ID}`} className="settings-sidebar-parent-label">
              <SettingsSectionIcon name="feed-massive-stock" />
              Massive Stock
            </a>
            <button
              type="button"
              className={`settings-sidebar-chevron ${massiveStockExpanded ? 'expanded' : ''}`}
              onClick={() => setMassiveStockExpanded(e => !e)}
              aria-expanded={massiveStockExpanded}
              aria-controls="settings-feed-massive-stock-subs"
              aria-label={massiveStockExpanded ? 'Collapse Massive Stock capabilities' : 'Expand Massive Stock capabilities'}
            >
              ▼
            </button>
          </div>
          <div id="settings-feed-massive-stock-subs" className="settings-sidebar-subs" hidden={!massiveStockExpanded}>
            {groupedStockChecklistRows().map(({ group, rows: groupRows }) => {
              const capGroupOpen = massiveStockCapGroupExpanded[group]
              const fromTab = parseFeedMassiveStockTabFromHash(`#${currentHash}`)
              const groupHasActive = groupRows.some(row => {
                const anchor = feedMassiveStockSvcAnchorId(row.id)
                return currentHash === anchor || fromTab === row.id
              })
              return (
                <div key={group} className="settings-sidebar-massive-group">
                  <div
                    className={`settings-sidebar-massive-cap-group-head${groupHasActive ? ' settings-sidebar-massive-cap-group-head--active' : ''
                      }`}
                  >
                    <button
                      type="button"
                      className="settings-sidebar-massive-cap-group-toggle"
                      aria-expanded={capGroupOpen}
                      aria-controls={`settings-massive-stock-cap-group-${group}`}
                      id={`settings-massive-stock-cap-group-head-${group}`}
                      onClick={() =>
                        setMassiveStockCapGroupExpanded(prev => ({ ...prev, [group]: !prev[group] }))
                      }
                    >
                      <span
                        className={`settings-sidebar-chevron settings-sidebar-massive-cap-group-chevron ${capGroupOpen ? 'expanded' : ''
                          }`}
                        aria-hidden
                      >
                        ▼
                      </span>
                      <span className="settings-sidebar-massive-cap-group-title">
                        {CAPABILITY_GROUP_LABELS[group]}
                      </span>
                    </button>
                  </div>
                  <div
                    id={`settings-massive-stock-cap-group-${group}`}
                    className="settings-sidebar-massive-cap-group-subs"
                    hidden={!capGroupOpen}
                    role="group"
                    aria-labelledby={`settings-massive-stock-cap-group-head-${group}`}
                  >
                    {groupRows.map(row => {
                      const configured = Boolean(massiveStatus?.configured)
                      const tierOk = stockTierOkForRow(row, massiveStatus, configured)
                      const tradesOk = stockTradesOkForRow(row, massiveStatus)
                      const eff = stockEffectiveStatus(row, configured, tierOk, tradesOk)
                      const isTierLimited = eff === 'not-on-tier'
                      const anchor = feedMassiveStockSvcAnchorId(row.id)
                      const childActive = currentHash === anchor || fromTab === row.id
                      return (
                        <a
                          key={row.id}
                          href={`#${anchor}`}
                          className={`settings-sidebar-link settings-sidebar-link-sub settings-sidebar-link-massive-cap ${childActive ? 'active' : ''}`}
                        >
                          <span
                            className={`title-inline-lamp lamp-icon ${isTierLimited ? 'tier' : 'none'}`}
                            title={isTierLimited ? 'Not available on current plan tier' : undefined}
                            aria-hidden
                          >
                            <SettingsSidebarLampGlyph id={row.id} />
                          </span>
                          <span className="settings-sidebar-massive-cap-label">{stockShortServiceLabel(row)}</span>
                        </a>
                      )
                    })}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
      <div className="settings-sidebar-group-block" role="group" aria-label="Settings">
        <div className="settings-sidebar-group-label">Settings</div>
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
    </>
  )

  return (
    <SettingsShell sidebar={sidebarContent}>
      {isDaemonSection ? (
        <DaemonStatusPage
          status={status}
          loadStatus={loadStatus}
          operations={operations}
          onNavigateToStrategy={onNavigateToStrategy}
          onNavigateToSocket={onNavigateToSocket}
          embeddedInSettings
        />
      ) : isSubscribeSection ? (
        <IbEventSubscribePage embeddedInSettings status={status} loadStatus={loadStatus} />
      ) : isCeleryControlSection ? (
        <CeleryControlPage embeddedInSettings celeryLamp={celeryLamp} />
      ) : isWsConnectorSection ? (
        <MarketIngestOpsPage embeddedInSettings status={status} loadStatus={loadStatus} />
      ) : isApiSection ? (
        isApiOverviewMain ? (
          <ApiHealthOverviewPage embeddedInSettings />
        ) : isApiArchitectureActive ? (
          <ArchitectureApisPage embeddedInSettings />
        ) : isApiAccountActive ? (
          <AccountApisPage embeddedInSettings />
        ) : isApiResearchActive ? (
          <ResearchApisPage embeddedInSettings />
        ) : isApiMassiveActive ? (
          <MassiveApiStatusPage embeddedInSettings />
        ) : (
          <ApiHealthOverviewPage embeddedInSettings />
        )
      ) : isCoverageSection ? (
        currentHash === 'coverage-stock' ? (
          <StockCoveragePage status={status} />
        ) : (
          <OptionCoveragePage status={status} />
        )
      ) : isFeedSection ? (
        isMassiveOptionFeedHash(currentHash) ? (
          <FeedMassiveOptionPage
            status={status}
            onGoToFeed={() => { window.location.hash = '#feed-ib-stock' }}
            onGoToScreener={() => { window.location.hash = '#feed-ib-stock' }}
            breadcrumbLabel="Massive Option"
          />
        ) : isMassiveStockFeedHash(currentHash) ? (
          <FeedMassiveStockPage
            status={status}
            onGoToFeed={() => { window.location.hash = '#feed-ib-stock' }}
            breadcrumbLabel="Massive Stock"
          />
        ) : (
          <DataPage
            status={status}
            embeddedInSettings
            onBreadcrumbParent={() => { window.location.hash = '#settings-heartbeat' }}
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
              accountSyncIntervalSec={accountSyncIntervalSec}
              setAccountSyncIntervalSec={setAccountSyncIntervalSec}
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
              clientIdOperator={clientIdOperator}
              ib2ClientIdOperator={ib2ClientIdOperator}
              clientIdIbIngestor={clientIdIbIngestor}
              clientIdAccountAgent={clientIdAccountAgent}
              ib2ClientIdAccountAgent={ib2ClientIdAccountAgent}
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
    </SettingsShell>
  )
}
