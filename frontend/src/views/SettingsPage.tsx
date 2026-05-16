import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { slugToDefaultHash, settingsPathFromSlug } from '@/lib/settingsSlugRouting'
import type { Operation, StatusResponse } from '../types'
import type { FlexAccountItem } from '../types'
import {
  postIbConfig,
  postSetHeartbeatInterval,
  postFlexConfig,
  fetchMassiveStatus,
  type MassiveStatusResponse,
} from '../api'
import { postAccountSyncSetHeartbeatInterval } from '../api/monitor/accountSync'
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
  COVERAGE_OVERVIEW_LEGACY_ID,
  COVERAGE_OVERVIEW_SUMMARY_ID,
  COVERAGE_OVERVIEW_DETAIL_ID,
  FEED_INTERACTIVE_BROKERS_LABEL,
} from './settings/settingsConstants'
import {
  commonHashForLegacyTiMoHash,
  isMassiveCommonFeedHash,
  isMassiveOverviewFeedHash,
} from './massive/feedMassiveCommonTabUtils'
import { isMassiveOptionFeedHash } from './massive/feedMassiveTabUtils'
import {
  isMassiveStockFeedHash,
} from './massive/feedMassiveStockTabUtils'
import { SettingsTabBar, API_TABS, COVERAGE_TABS, FEED_TABS } from './settings/SettingsTabBar'
import { HeartbeatSection } from './settings/HeartbeatSection'
import { IbConnectionSection } from './settings/IbConnectionSection'
import { DataPage } from './DataPage'
import { FeedMassiveCommonPage } from './FeedMassiveCommonPage'
import { FeedMassiveOptionPage } from './FeedMassiveOptionPage'
import { FeedMassiveOverviewPage } from './FeedMassiveOverviewPage'
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
import { DataOverviewSummaryPage } from './DataOverviewSummaryPage'
import { DataOverviewDetailPage } from './DataOverviewDetailPage'
import { OptionCoveragePage } from './OptionCoveragePage'
import { StockCoveragePage } from './StockCoveragePage'
import { MassiveStockCoveragePage } from './MassiveStockCoveragePage'
import { useDeferredStart } from '../hooks/useDeferredStart'
import type { SettingsApiHealthProbesState } from '../hooks/useSettingsApiHealthProbes'
import { fetchMarketIngestServices, type MarketIngestServiceRow } from '../api/ops/ops'
import {
  aggregateDaemonProcessesHealthFromStatus,
  aggregateIngestRedisHealthLamp,
  marketIngestServicesForSocketAggregate,
  type AggregateIngestLamp,
} from '../utils/socketIngestLamp'

const API_SETTINGS_DETAIL_HASHES = [
  'settings-api-architecture',
  'settings-api-account',
  'settings-api-research',
  'settings-api-massive',
] as const

export interface SettingsPageProps {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  operations?: Operation[]
  onNavigateToStrategy?: () => void
  onNavigateToSocket?: () => void
  onGoToScreener?: () => void
  /** Celery runtime lamp (same source as header / System aggregate). */
  celeryLamp?: 'green' | 'yellow' | 'red' | 'none'
  /** API sidebar lamps + utilized services (from App `useSettingsApiHealthProbes`, same as header shortcuts). */
  apiHealthProbes: SettingsApiHealthProbesState
  /** When set (Next `/settings/[...slug]`), sync canonical hash + active section from slug segments. */
  settingsRouteSlug?: string[] | null
}

export function SettingsPage({
  status,
  loadStatus,
  operations = [],
  onNavigateToStrategy,
  onNavigateToSocket,
  onGoToScreener,
  celeryLamp = 'none',
  apiHealthProbes,
  settingsRouteSlug = null,
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

  const hashToSectionId = (hash: string) => {
    const h = hash ? hash.slice(1) : ''
    if (h === FEED_MASSIVE_DAILY_DATA_ID) return 'settings-coverage'
    if (h && h.startsWith('coverage-')) return 'settings-coverage'
    if (h && (h.startsWith('ib-') || h === 'flex-preference' || h === 'settings-ib-connection')) return 'settings-ib-connection'
    if (h === 'settings-subscribe') return 'settings-subscribe'
    if (h === 'settings-daemon' || h === 'settings-system-daemon' || h === 'settings-system') return 'settings-daemon'
    if (h === 'settings-system-monitor' || h === 'settings-system-server') return 'settings-api'
    // Any Celery-console deep link: base hash, queue filter, Support Tasks tab, etc.
    if (h === 'settings-celery' || h === 'settings-dashboard-celery' || h.startsWith('settings-celery-')) {
      return 'settings-celery'
    }
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
    if (h && isMassiveOverviewFeedHash(`#${h}`)) return 'settings-feed'
    if (h && isMassiveCommonFeedHash(`#${h}`)) return 'settings-feed'
    if (h && isMassiveOptionFeedHash(`#${h}`)) return 'settings-feed'
    if (h && isMassiveStockFeedHash(`#${h}`)) return 'settings-feed'
    if (h && h.startsWith('feed-')) return 'settings-feed'
    return h || SETTINGS_SECTIONS[0].id
  }
  const [activeSectionId, setActiveSectionId] = useState<string>(() => {
    if (typeof window === 'undefined') return SETTINGS_SECTIONS[0].id
    if (settingsRouteSlug != null && settingsRouteSlug.length > 0) {
      return hashToSectionId(slugToDefaultHash(settingsRouteSlug))
    }
    return hashToSectionId(window.location.hash)
  })

  const settingsSlugKey = settingsRouteSlug?.join('/') ?? ''

  const [, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [, setApiAggregateLamp] = useState<'green' | 'yellow' | 'red' | 'none'>('none')
  const [, setSocketIngestLamp] = useState<AggregateIngestLamp>('none')
  const [, setSocketIngestTitle] = useState(
    'Socket ingest Redis health from Monitor GET /status `socket` (loading…)',
  )
  const [ingestServicesCache, setIngestServicesCache] = useState<MarketIngestServiceRow[]>([])
  const [ingestServicesFetchError, setIngestServicesFetchError] = useState<string | null>(null)
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return
    if (settingsRouteSlug == null || settingsRouteSlug.length === 0) return
    const hash = slugToDefaultHash(settingsRouteSlug)
    const path = settingsPathFromSlug(settingsRouteSlug)
    const nextUrl = `${path}${hash}`
    if (`${window.location.pathname}${window.location.hash}` !== nextUrl) {
      window.history.replaceState(window.history.state, '', nextUrl)
    }
    setActiveSectionId(hashToSectionId(hash))
  }, [settingsSlugKey, settingsRouteSlug])
  const deferredStart = useDeferredStart(280)
  void apiHealthProbes
  const currentHash = typeof window !== 'undefined' ? window.location.hash.slice(1) : ''
  const activeSubId = activeSectionId === 'settings-ib-connection' && IB_CONNECTION_SUBSECTIONS.some(s => s.id === currentHash) ? currentHash : ''
  const currentHashForMassive = currentHash ? `#${currentHash}` : ''
  /** Same roll-up as Daemon page title: all Ops-configured Daemon processes (Engine + Account Sync). */
  const daemonPageRows = useMemo(
    () =>
      ingestServicesCache
        .filter((s) => s.id === 'trading_engine' || s.id === 'account_sync_daemon')
        .sort((a, b) => {
          const order = ['trading_engine', 'account_sync_daemon']
          return order.indexOf(a.id) - order.indexOf(b.id)
        }),
    [ingestServicesCache],
  )
  const daemonPageLamp = useMemo(() => {
    if (ingestServicesFetchError) {
      return { lamp: 'none' as AggregateIngestLamp, title: ingestServicesFetchError }
    }
    if (daemonPageRows.length > 0) {
      return aggregateIngestRedisHealthLamp(daemonPageRows.map((svc) => ({ svc })), status)
    }
    return aggregateDaemonProcessesHealthFromStatus(status)
  }, [daemonPageRows, status, ingestServicesFetchError])
  void daemonPageLamp
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
    const ingestOnly = marketIngestServicesForSocketAggregate(ingestServicesCache)
    return aggregateIngestRedisHealthLamp(ingestOnly.map(svc => ({ svc })), status)
  }, [ingestServicesCache, ingestServicesFetchError, status])

  useEffect(() => {
    setSocketIngestLamp(socketIngestAggregate.lamp)
    setSocketIngestTitle(socketIngestAggregate.title)
  }, [socketIngestAggregate])

  useEffect(() => {
    const normalizeHash = (): string => {
      let h = window.location.hash
      const raw0 = h.startsWith('#') ? h.slice(1) : h
      const legacyCommon = commonHashForLegacyTiMoHash(raw0)
      if (legacyCommon) {
        const next = `${window.location.pathname}${window.location.search}#${legacyCommon}`
        window.history.replaceState(null, '', next)
        h = `#${legacyCommon}`
      }
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
  const isCoverageSection = activeSectionId === 'settings-coverage'
  const isFeedSection = activeSectionId === 'settings-feed'

  useLayoutEffect(() => {
    if (currentHash === COVERAGE_OVERVIEW_LEGACY_ID) {
      window.location.replace(`#${COVERAGE_OVERVIEW_SUMMARY_ID}`)
    }
  }, [currentHash])

  const handleTabClick = (hash: string) => {
    const nextUrl = `${window.location.pathname}${window.location.search}#${hash}`
    window.history.replaceState(window.history.state, '', nextUrl)
    setActiveSectionId(hashToSectionId(`#${hash}`))
  }

  /* --- dead sidebar block removed; navigation now lives in main app sidebar --- */
  /* sidebar content entirely removed — see trading-sidebar.tsx for System nav */

  return (
    <SettingsShell>
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
        <>
          <SettingsTabBar tabs={API_TABS} activeHash={currentHash || 'settings-api'} onTabClick={handleTabClick} />
          {isApiOverviewMain ? (
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
          )}
        </>
      ) : isCoverageSection ? (
        <>
          <SettingsTabBar tabs={COVERAGE_TABS} activeHash={currentHash || 'coverage-overview-summary'} onTabClick={handleTabClick} />
          {currentHash === COVERAGE_OVERVIEW_SUMMARY_ID ? (
            <DataOverviewSummaryPage status={status} />
          ) : currentHash === COVERAGE_OVERVIEW_DETAIL_ID ? (
            <DataOverviewDetailPage status={status} />
          ) : currentHash === 'coverage-stock' ? (
            <StockCoveragePage status={status} />
          ) : currentHash === 'coverage-massive-stock' ? (
            <MassiveStockCoveragePage status={status} />
          ) : (
            <OptionCoveragePage status={status} />
          )}
        </>
      ) : isFeedSection ? (
        <>
          <SettingsTabBar tabs={FEED_TABS} activeHash={currentHash || 'feed-ib-stock'} onTabClick={handleTabClick} />
          {isMassiveOverviewFeedHash(currentHashForMassive) ? (
            <FeedMassiveOverviewPage
              status={status}
              onGoToFeed={() => handleTabClick('feed-ib-stock')}
            />
          ) : isMassiveCommonFeedHash(currentHashForMassive) ? (
            <FeedMassiveCommonPage
              status={status}
              onGoToFeed={() => handleTabClick('feed-ib-stock')}
              breadcrumbLabel="Massive Common"
            />
          ) : isMassiveOptionFeedHash(currentHashForMassive) ? (
            <FeedMassiveOptionPage
              status={status}
              onGoToFeed={() => handleTabClick('feed-ib-stock')}
              onGoToScreener={onGoToScreener}
              breadcrumbLabel="Massive Option"
            />
          ) : isMassiveStockFeedHash(currentHashForMassive) ? (
            <FeedMassiveStockPage
              status={status}
              onGoToFeed={() => handleTabClick('feed-ib-stock')}
              breadcrumbLabel="Massive Stock"
            />
          ) : (
            <DataPage
              status={status}
              embeddedInSettings
              onBreadcrumbParent={() => handleTabClick('settings-heartbeat')}
              breadcrumbParentLabel="Settings"
              onGoToScreener={() => handleTabClick('feed-ib-stock')}
              breadcrumbLabel={FEED_INTERACTIVE_BROKERS_LABEL}
            />
          )}
        </>
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
          </div>
        </div>
      )}
    </SettingsShell>
  )
}
