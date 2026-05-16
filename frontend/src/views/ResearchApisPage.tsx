import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DraggableModal } from '../components/DraggableModal'
import { fetchHealth } from '../api'
import {
  fetchMarketCapabilities,
  fetchResearchCapabilities,
  fetchStrategyCapabilities,
  postMarketShutdown,
  postResearchShutdown,
  postStrategyShutdown,
} from '../api/research/researchSidecarControl'
import type { OpsCapabilities } from '../api/ops/ops'
import { joinServiceBase } from '../api/shared/apiRouting'
import { API_HEALTH_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../api/shared/fetchTimeout'
import { AggregatedLogConsolePanel } from '../components/AggregatedLogConsolePanel'
import { InfoTooltip } from '../components/InfoTooltip'
import type { UnifiedLogSourceDefinition } from '../components/unifiedLogConsoleTypes'
import { useResearchUnifiedLogConsole } from '../components/useResearchUnifiedLogConsole'
import { useDeferredStart } from '../hooks/useDeferredStart'
import {
  marketServiceBase,
  researchServiceBase,
  strategyServiceBase,
} from './research/researchApiBases'
import { scheduleMsgClear, setMsg } from './status/messageUtils'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'

export interface ResearchApisPageProps {
  embeddedInSettings?: boolean
}

const PROFILE_LABELS: Record<string, string> = {
  dev: 'Development',
  prod: 'Production',
}

const RESEARCH_LOG_SOURCE_DEFINITIONS: UnifiedLogSourceDefinition[] = [
  { source: 'research', label: 'Research' },
  { source: 'strategy', label: 'Strategy' },
  { source: 'market', label: 'Market' },
]

type ShutdownKey = 'research' | 'strategy' | 'market'

type ShutdownConfirmState = {
  open: boolean
  busy: boolean
  error: string | null
}

const INITIAL_SHUTDOWN: ShutdownConfirmState = {
  open: false,
  busy: false,
  error: null,
}

type MonitorHealthLite = {
  research_port?: number
  strategy_port?: number
  market_port?: number
  config_profile?: 'dev' | 'prod'
}

type SidecarApiHealth = {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod'
  port?: number
}

function researchTitleAggregateLamp(
  researchOk: boolean | null,
  strategyOk: boolean | null,
  marketOk: boolean | null,
): 'green' | 'yellow' | 'red' | 'none' {
  const vals = [researchOk, strategyOk, marketOk]
  if (vals.some((v) => v === null)) return 'none'
  const greens = vals.filter((v) => v === true).length
  const reds = vals.filter((v) => v === false).length
  if (greens === 3) return 'green'
  if (reds === 3) return 'red'
  return 'yellow'
}

async function fetchSidecarHealthAtOrigin(origin: string): Promise<SidecarApiHealth> {
  const base = origin.replace(/\/$/, '')
  const url = joinServiceBase(base, '/health')
  const r = await fetchWithTimeout(url, { credentials: 'omit' }, API_HEALTH_FETCH_TIMEOUT_MS)
  if (!r.ok) throw new Error(`Health ${r.status}`)
  const j = (await r.json()) as Record<string, unknown>
  const profile = j.config_profile
  return {
    status: String(j.status ?? 'unknown'),
    service: String(j.service ?? 'unknown'),
    ts: typeof j.ts === 'number' ? j.ts : 0,
    config_profile: profile === 'dev' || profile === 'prod' ? profile : undefined,
    port: typeof j.port === 'number' && Number.isFinite(j.port) ? j.port : undefined,
  }
}

export function ResearchApisPage({ embeddedInSettings }: ResearchApisPageProps) {
  const [monitorHealth, setMonitorHealth] = useState<MonitorHealthLite | null>(null)
  const [researchHealth, setResearchHealth] = useState<SidecarApiHealth | null>(null)
  const [strategyHealth, setStrategyHealth] = useState<SidecarApiHealth | null>(null)
  const [marketHealth, setMarketHealth] = useState<SidecarApiHealth | null>(null)
  const [researchOk, setResearchOk] = useState<boolean | null>(null)
  const [strategyOk, setStrategyOk] = useState<boolean | null>(null)
  const [marketOk, setMarketOk] = useState<boolean | null>(null)
  const [researchCaps, setResearchCaps] = useState<OpsCapabilities | null>(null)
  const [strategyCaps, setStrategyCaps] = useState<OpsCapabilities | null>(null)
  const [marketCaps, setMarketCaps] = useState<OpsCapabilities | null>(null)

  const [shutdownResearch, setShutdownResearch] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownStrategy, setShutdownStrategy] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownMarket, setShutdownMarket] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownResearchMsg, setShutdownResearchMsg] = useState({ text: '', isErr: false })
  const [shutdownStrategyMsg, setShutdownStrategyMsg] = useState({ text: '', isErr: false })
  const [shutdownMarketMsg, setShutdownMarketMsg] = useState({ text: '', isErr: false })
  const researchMsgClearRef = useRef<number | null>(null)
  const strategyMsgClearRef = useRef<number | null>(null)
  const marketMsgClearRef = useRef<number | null>(null)
  const mountedRef = useRef(true)

  type ResearchDetailTab = 'research' | 'strategy' | 'market'
  const [detailTab, setDetailTab] = useState<ResearchDetailTab>('research')

  const deferredStart = useDeferredStart()
  const logConsole = useResearchUnifiedLogConsole({
    enabled: deferredStart,
    initialMaxLines: 50,
    initialHeightPx: 280,
  })

  const probeTriplet = useCallback((mh: MonitorHealthLite | null) => {
    const rb = researchServiceBase(mh)
    const sb = strategyServiceBase(mh)
    const mb = marketServiceBase(mh)

    if (rb) {
      fetchSidecarHealthAtOrigin(rb)
        .then((h) => {
          if (mountedRef.current) {
            setResearchHealth(h)
            setResearchOk(true)
          }
        })
        .catch(() => {
          if (mountedRef.current) {
            setResearchHealth(null)
            setResearchOk(false)
          }
        })
      fetchResearchCapabilities(rb)
        .then((c) => {
          if (mountedRef.current && c.ok) setResearchCaps(c)
        })
        .catch(() => {
          if (mountedRef.current) setResearchCaps(null)
        })
    } else {
      setResearchHealth(null)
      setResearchOk(null)
      setResearchCaps(null)
    }

    if (sb) {
      fetchSidecarHealthAtOrigin(sb)
        .then((h) => {
          if (mountedRef.current) {
            setStrategyHealth(h)
            setStrategyOk(true)
          }
        })
        .catch(() => {
          if (mountedRef.current) {
            setStrategyHealth(null)
            setStrategyOk(false)
          }
        })
      fetchStrategyCapabilities(sb)
        .then((c) => {
          if (mountedRef.current && c.ok) setStrategyCaps(c)
        })
        .catch(() => {
          if (mountedRef.current) setStrategyCaps(null)
        })
    } else {
      setStrategyHealth(null)
      setStrategyOk(null)
      setStrategyCaps(null)
    }

    if (mb) {
      fetchSidecarHealthAtOrigin(mb)
        .then((h) => {
          if (mountedRef.current) {
            setMarketHealth(h)
            setMarketOk(true)
          }
        })
        .catch(() => {
          if (mountedRef.current) {
            setMarketHealth(null)
            setMarketOk(false)
          }
        })
      fetchMarketCapabilities(mb)
        .then((c) => {
          if (mountedRef.current && c.ok) setMarketCaps(c)
        })
        .catch(() => {
          if (mountedRef.current) setMarketCaps(null)
        })
    } else {
      setMarketHealth(null)
      setMarketOk(null)
      setMarketCaps(null)
    }
  }, [])

  const refetchAll = useCallback(() => {
    fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
      .then((h) => {
        if (!mountedRef.current) return
        const mh: MonitorHealthLite = {
          research_port: h.research_port,
          strategy_port: h.strategy_port,
          market_port: h.market_port,
          config_profile: h.config_profile,
        }
        setMonitorHealth(mh)
        probeTriplet(mh)
      })
      .catch(() => {
        if (!mountedRef.current) return
        setMonitorHealth(null)
        probeTriplet(null)
      })
  }, [probeTriplet])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    return () => {
      if (researchMsgClearRef.current != null) clearTimeout(researchMsgClearRef.current)
      if (strategyMsgClearRef.current != null) clearTimeout(strategyMsgClearRef.current)
      if (marketMsgClearRef.current != null) clearTimeout(marketMsgClearRef.current)
    }
  }, [])

  useEffect(() => {
    if (!deferredStart) return
    refetchAll()
    const t = window.setInterval(refetchAll, 15_000)
    return () => window.clearInterval(t)
  }, [deferredStart, refetchAll])

  const researchLamp: 'green' | 'red' | 'none' = researchOk === true ? 'green' : researchOk === false ? 'red' : 'none'
  const strategyLamp: 'green' | 'red' | 'none' = strategyOk === true ? 'green' : strategyOk === false ? 'red' : 'none'
  const marketLamp: 'green' | 'red' | 'none' = marketOk === true ? 'green' : marketOk === false ? 'red' : 'none'
  const researchTitleLamp = researchTitleAggregateLamp(researchOk, strategyOk, marketOk)

  const mhForBase = monitorHealth
  const researchBase = researchServiceBase(mhForBase)
  const strategyBase = strategyServiceBase(mhForBase)
  const marketBase = marketServiceBase(mhForBase)

  const researchEnvClass =
    researchHealth?.config_profile == null && researchOk === true
      ? 'custom'
      : (researchHealth?.config_profile ?? 'unknown')
  const strategyEnvClass =
    strategyHealth?.config_profile == null && strategyOk === true
      ? 'custom'
      : (strategyHealth?.config_profile ?? 'unknown')
  const marketEnvClass =
    marketHealth?.config_profile == null && marketOk === true ? 'custom' : (marketHealth?.config_profile ?? 'unknown')

  const canResearchOperate = researchCaps?.capabilities.can_operate ?? false
  const canStrategyOperate = strategyCaps?.capabilities.can_operate ?? false
  const canMarketOperate = marketCaps?.capabilities.can_operate ?? false

  const researchStopDisabled = researchOk !== true || !canResearchOperate
  const strategyStopDisabled = strategyOk !== true || !canStrategyOperate
  const marketStopDisabled = marketOk !== true || !canMarketOperate

  const researchStopTitle =
    researchOk !== true
      ? 'Research API not reachable'
      : !canResearchOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Research API process'

  const strategyStopTitle =
    strategyOk !== true
      ? 'Strategy API not reachable'
      : !canStrategyOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Strategy API process'

  const marketStopTitle =
    marketOk !== true
      ? 'Market API not reachable'
      : !canMarketOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Market API process'

  const runShutdown = async (key: ShutdownKey) => {
    const base =
      key === 'research' ? researchBase : key === 'strategy' ? strategyBase : marketBase
    if (!base) return

    const configs: Record<
      ShutdownKey,
      {
        setConfirm: Dispatch<SetStateAction<ShutdownConfirmState>>
        setLocalMsg: Dispatch<SetStateAction<{ text: string; isErr: boolean }>>
        clearRef: MutableRefObject<number | null>
        refetch: () => void
        scriptHint: string
        label: string
        post: () => Promise<{ ok: boolean; error?: string }>
      }
    > = {
      research: {
        setConfirm: setShutdownResearch,
        setLocalMsg: setShutdownResearchMsg,
        clearRef: researchMsgClearRef,
        refetch: () => {
          fetchSidecarHealthAtOrigin(base)
            .then((h) => {
              if (mountedRef.current) {
                setResearchHealth(h)
                setResearchOk(true)
              }
            })
            .catch(() => {
              if (mountedRef.current) {
                setResearchHealth(null)
                setResearchOk(false)
              }
            })
        },
        scriptHint: 'python scripts/run_server_research.py',
        label: 'Research API',
        post: () => postResearchShutdown(base),
      },
      strategy: {
        setConfirm: setShutdownStrategy,
        setLocalMsg: setShutdownStrategyMsg,
        clearRef: strategyMsgClearRef,
        refetch: () => {
          fetchSidecarHealthAtOrigin(base)
            .then((h) => {
              if (mountedRef.current) {
                setStrategyHealth(h)
                setStrategyOk(true)
              }
            })
            .catch(() => {
              if (mountedRef.current) {
                setStrategyHealth(null)
                setStrategyOk(false)
              }
            })
        },
        scriptHint: 'python scripts/run_server_strategy.py',
        label: 'Strategy API',
        post: () => postStrategyShutdown(base),
      },
      market: {
        setConfirm: setShutdownMarket,
        setLocalMsg: setShutdownMarketMsg,
        clearRef: marketMsgClearRef,
        refetch: () => {
          fetchSidecarHealthAtOrigin(base)
            .then((h) => {
              if (mountedRef.current) {
                setMarketHealth(h)
                setMarketOk(true)
              }
            })
            .catch(() => {
              if (mountedRef.current) {
                setMarketHealth(null)
                setMarketOk(false)
              }
            })
        },
        scriptHint: 'python scripts/run_server_market.py',
        label: 'Market API',
        post: () => postMarketShutdown(base),
      },
    }

    const cfg = configs[key]
    cfg.setConfirm((s) => ({ ...s, busy: true, error: null }))
    const res = await cfg.post()
    if (res.ok) {
      cfg.setConfirm(INITIAL_SHUTDOWN)
      setMsg(
        cfg.setLocalMsg,
        `${cfg.label} stop requested. Refresh this page or run: ${cfg.scriptHint}`,
        false,
      )
      scheduleMsgClear(cfg.setLocalMsg, cfg.clearRef)
      await new Promise((r) => {
        window.setTimeout(r, 4000)
      })
      if (mountedRef.current) cfg.refetch()
    } else {
      cfg.setConfirm((s) => ({
        ...s,
        busy: false,
        error: res.error?.trim() || 'Shut down failed',
      }))
    }
  }

  const researchDialog = (
    <DraggableModal
      open={shutdownResearch.open}
      onBackdropClick={() => {
        if (!shutdownResearch.busy) setShutdownResearch(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownResearch.busy}
      title="Shut down Research API"
      titleId="research-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownResearch(INITIAL_SHUTDOWN)}
            disabled={shutdownResearch.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('research')}
            disabled={shutdownResearch.busy}
          >
            {shutdownResearch.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the Research FastAPI process (run_server_research.py). Option discovery and max pain
        endpoints on this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownResearch.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownResearch.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  const strategyDialog = (
    <DraggableModal
      open={shutdownStrategy.open}
      onBackdropClick={() => {
        if (!shutdownStrategy.busy) setShutdownStrategy(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownStrategy.busy}
      title="Shut down Strategy API"
      titleId="strategy-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownStrategy(INITIAL_SHUTDOWN)}
            disabled={shutdownStrategy.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('strategy')}
            disabled={shutdownStrategy.busy}
          >
            {shutdownStrategy.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the Strategy FastAPI process (run_server_strategy.py). Strategy structures, instances,
        and related endpoints on this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownStrategy.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownStrategy.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  const marketDialog = (
    <DraggableModal
      open={shutdownMarket.open}
      onBackdropClick={() => {
        if (!shutdownMarket.busy) setShutdownMarket(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownMarket.busy}
      title="Shut down Market API"
      titleId="market-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownMarket(INITIAL_SHUTDOWN)}
            disabled={shutdownMarket.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('market')}
            disabled={shutdownMarket.busy}
          >
            {shutdownMarket.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the Market FastAPI process (run_server_market.py). Quotes, bars, and watchlist
        endpoints on this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownMarket.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownMarket.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  const wrapClass = embeddedInSettings
    ? 'settings-page-card massive-api-status-page massive-api-status-page--embedded architecture-apis-page'
    : 'settings-page-card massive-api-status-page architecture-apis-page'

  const lampSvg = (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
    </svg>
  )

  return (
    <div className={wrapClass}>
      {researchDialog}
      {strategyDialog}
      {marketDialog}
      <div className="server-groups settings-page-groups">
        <section className="replay-section" aria-labelledby="research-page-head">
          <div className="architecture-page-intro">
            <h2 id="research-page-head" className="daemon-card-title page-title-with-tooltip architecture-page-title">
              <span
                className={`title-inline-lamp lamp-icon ${researchTitleLamp}`}
                title="Combined Research, Strategy, and Market API reachability"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="api-research" />
              </span>
              Research
              <InfoTooltip text="Research, Strategy, and Market FastAPI sidecars: option discovery / max pain, strategy instances and structures, and market quotes / watchlist. Base URLs follow API Health routing (VITE_RESEARCH_API_ORIGIN, VITE_STRATEGY_API_ORIGIN, VITE_MARKET_API_ORIGIN, or GET /health ports). Stop requires an operator-scoped Ops token (same as Account / Architecture)." />
            </h2>
            <p className="massive-api-doc-hint architecture-page-hint">
              Status cards refresh every 15s. Research uses root /docs; Strategy and Market use /strategy/* and /market/*
              paths on each service origin.
            </p>
          </div>

          <div className="architecture-status-grid">
            <article className="architecture-api-card" aria-labelledby="research-card-research">
              <div className="architecture-api-card-head">
                <h3 id="research-card-research" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${researchLamp}`} title="Research API health" aria-hidden>
                    {lampSvg}
                  </span>
                  Research API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={researchStopDisabled}
                  title={researchStopTitle}
                  aria-label="Shut down Research API"
                  onClick={() => setShutdownResearch({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownResearchMsg.text ? (
                <div className={`msg ${shutdownResearchMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>
                  {shutdownResearchMsg.text}
                </div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>
                  {researchOk === true ? 'Running (OK)' : researchOk === false ? 'Unreachable' : 'Checking…'}
                </strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{researchHealth?.port != null ? String(researchHealth.port) : '–'}</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>{researchHealth?.service ?? '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${researchEnvClass}`}>
                      {researchHealth?.config_profile
                        ? PROFILE_LABELS[researchHealth.config_profile] ?? researchHealth.config_profile
                        : researchOk === true
                          ? 'Custom'
                          : 'Unknown'}
                    </span>
                  </dd>
                </div>
                {researchHealth?.ts ? (
                  <div>
                    <dt>Server time</dt>
                    <dd>{new Date(researchHealth.ts * 1000).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
            </article>

            <article className="architecture-api-card" aria-labelledby="research-card-strategy">
              <div className="architecture-api-card-head">
                <h3 id="research-card-strategy" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${strategyLamp}`} title="Strategy API health" aria-hidden>
                    {lampSvg}
                  </span>
                  Strategy API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={strategyStopDisabled}
                  title={strategyStopTitle}
                  aria-label="Shut down Strategy API"
                  onClick={() => setShutdownStrategy({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownStrategyMsg.text ? (
                <div className={`msg ${shutdownStrategyMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>
                  {shutdownStrategyMsg.text}
                </div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>
                  {strategyOk === true ? 'Running (OK)' : strategyOk === false ? 'Unreachable' : 'Checking…'}
                </strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{strategyHealth?.port != null ? String(strategyHealth.port) : '–'}</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>{strategyHealth?.service ?? '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${strategyEnvClass}`}>
                      {strategyHealth?.config_profile
                        ? PROFILE_LABELS[strategyHealth.config_profile] ?? strategyHealth.config_profile
                        : strategyOk === true
                          ? 'Custom'
                          : 'Unknown'}
                    </span>
                  </dd>
                </div>
                {strategyHealth?.ts ? (
                  <div>
                    <dt>Server time</dt>
                    <dd>{new Date(strategyHealth.ts * 1000).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
            </article>

            <article className="architecture-api-card" aria-labelledby="research-card-market">
              <div className="architecture-api-card-head">
                <h3 id="research-card-market" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${marketLamp}`} title="Market API health" aria-hidden>
                    {lampSvg}
                  </span>
                  Market API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={marketStopDisabled}
                  title={marketStopTitle}
                  aria-label="Shut down Market API"
                  onClick={() => setShutdownMarket({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownMarketMsg.text ? (
                <div className={`msg ${shutdownMarketMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>
                  {shutdownMarketMsg.text}
                </div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>{marketOk === true ? 'Running (OK)' : marketOk === false ? 'Unreachable' : 'Checking…'}</strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{marketHealth?.port != null ? String(marketHealth.port) : '–'}</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>{marketHealth?.service ?? '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${marketEnvClass}`}>
                      {marketHealth?.config_profile
                        ? PROFILE_LABELS[marketHealth.config_profile] ?? marketHealth.config_profile
                        : marketOk === true
                          ? 'Custom'
                          : 'Unknown'}
                    </span>
                  </dd>
                </div>
                {marketHealth?.ts ? (
                  <div>
                    <dt>Server time</dt>
                    <dd>{new Date(marketHealth.ts * 1000).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
            </article>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="research-docs-table-head">
          <h3 id="research-docs-table-head" className="page-title-with-tooltip architecture-section-title">
            Documentation
            <InfoTooltip text="Swagger UI, ReDoc, and OpenAPI JSON for each sidecar. Research uses root /docs; Strategy and Market use prefixed paths." />
          </h3>
          <div className="architecture-docs-table-wrap">
            <table className="architecture-docs-table">
              <thead>
                <tr>
                  <th scope="col">API</th>
                  <th scope="col">Base URL</th>
                  <th scope="col">Swagger UI</th>
                  <th scope="col">ReDoc</th>
                  <th scope="col">OpenAPI JSON</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Research</th>
                  <td className="architecture-docs-table-base">{researchBase || '–'}</td>
                  <td>
                    {researchBase ? (
                      <a href={`${researchBase}/docs`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {researchBase ? (
                      <a href={`${researchBase}/redoc`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {researchBase ? (
                      <a href={`${researchBase}/openapi.json`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Strategy</th>
                  <td className="architecture-docs-table-base">{strategyBase || '–'}</td>
                  <td>
                    {strategyBase ? (
                      <a
                        href={`${strategyBase}/strategy/docs`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="architecture-docs-link"
                      >
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {strategyBase ? (
                      <a
                        href={`${strategyBase}/strategy/redoc`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="architecture-docs-link"
                      >
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {strategyBase ? (
                      <a
                        href={`${strategyBase}/strategy/openapi.json`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="architecture-docs-link"
                      >
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Market</th>
                  <td className="architecture-docs-table-base">{marketBase || '–'}</td>
                  <td>
                    {marketBase ? (
                      <a
                        href={`${marketBase}/market/docs`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="architecture-docs-link"
                      >
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {marketBase ? (
                      <a
                        href={`${marketBase}/market/redoc`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="architecture-docs-link"
                      >
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {marketBase ? (
                      <a
                        href={`${marketBase}/market/openapi.json`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="architecture-docs-link"
                      >
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="research-log-head">
          <h3 id="research-log-head" className="page-title-with-tooltip architecture-section-title">
            Application log
            <InfoTooltip text="Monitor merges Redis console streams for Research, Strategy, and Market (both dev and prod keys) so logs show even when Monitor and sidecars use different config profiles. Use Source toggles to filter. Clear removes both dev and prod streams per API." />
          </h3>
          <AggregatedLogConsolePanel
            controller={logConsole}
            sourceDefinitions={RESEARCH_LOG_SOURCE_DEFINITIONS}
            loadingText="Connecting…"
            errorText="Unable to load logs (Redis may be down or Monitor API not running)."
            emptyText="No log lines yet. Start Research, Strategy, and Market API processes (run_server_*.py)."
            infoTooltipText="Clear displayed text and truncates both Redis log streams (Research, Strategy, Market)."
            resizeAriaLabel="Resize unified research console height"
            clearTitle="Clear Research, Strategy, and Market log streams (dev and prod Redis keys per API)"
          />
        </section>

        <section className="replay-section architecture-api-details" aria-labelledby="research-api-details-head">
          <h3 id="research-api-details-head" className="page-title-with-tooltip architecture-section-title">
            API details
            <InfoTooltip text="Summary of what each sidecar exposes. Open the Swagger links above for full paths and schemas." />
          </h3>
          <div className="architecture-detail-tabs" role="tablist" aria-label="Research API detail by service">
            <button
              type="button"
              role="tab"
              id="research-tab-research"
              aria-selected={detailTab === 'research'}
              aria-controls="research-detail-panel"
              tabIndex={detailTab === 'research' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'research' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('research')}
            >
              Research API
            </button>
            <button
              type="button"
              role="tab"
              id="research-tab-strategy"
              aria-selected={detailTab === 'strategy'}
              aria-controls="research-detail-panel"
              tabIndex={detailTab === 'strategy' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'strategy' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('strategy')}
            >
              Strategy API
            </button>
            <button
              type="button"
              role="tab"
              id="research-tab-market"
              aria-selected={detailTab === 'market'}
              aria-controls="research-detail-panel"
              tabIndex={detailTab === 'market' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'market' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('market')}
            >
              Market API
            </button>
          </div>
          <div
            id="research-detail-panel"
            role="tabpanel"
            aria-labelledby={
              detailTab === 'research'
                ? 'research-tab-research'
                : detailTab === 'strategy'
                  ? 'research-tab-strategy'
                  : 'research-tab-market'
            }
            className="architecture-detail-tabpanel"
          >
            {detailTab === 'research' ? (
              <>
                <h4 className="architecture-detail-subhead">Option discovery and max pain</h4>
                <p className="architecture-detail-subhint">
                  IB-backed option chains, snapshots, and max pain compute endpoints. Uses IB operator client on
                  startup when configured.
                </p>
                <table className="massive-api-kv-table architecture-config-table">
                  <tbody>
                    <tr>
                      <td className="massive-api-kv-label">Typical routes</td>
                      <td>
                        <code>/research/option-snapshot</code>, <code>/research/max-pain/compute</code> (see OpenAPI)
                      </td>
                    </tr>
                    <tr>
                      <td className="massive-api-kv-label">OpenAPI</td>
                      <td className="massive-api-kv-path architecture-detail-url-cell">
                        {researchBase ? `${researchBase}/openapi.json` : '–'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
            ) : detailTab === 'strategy' ? (
              <>
                <h4 className="architecture-detail-subhead">Structures, instances, allocations</h4>
                <p className="architecture-detail-subhint">
                  Strategy templates, scoring, opportunity views, and instance CRUD (Postgres-backed when available).
                </p>
                <table className="massive-api-kv-table architecture-config-table">
                  <tbody>
                    <tr>
                      <td className="massive-api-kv-label">Typical routes</td>
                      <td>
                        <code>/strategy/*</code> REST resources (see OpenAPI)
                      </td>
                    </tr>
                    <tr>
                      <td className="massive-api-kv-label">OpenAPI</td>
                      <td className="massive-api-kv-path architecture-detail-url-cell">
                        {strategyBase ? `${strategyBase}/strategy/openapi.json` : '–'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
            ) : (
              <>
                <h4 className="architecture-detail-subhead">Bars, quotes, watchlist</h4>
                <p className="architecture-detail-subhint">
                  Market data and SSE quote streams; Redis subscriber when configured. IB operator client on startup
                  when configured.
                </p>
                <table className="massive-api-kv-table architecture-config-table">
                  <tbody>
                    <tr>
                      <td className="massive-api-kv-label">Typical routes</td>
                      <td>
                        <code>/market/*</code> bars, quotes, watchlist (see OpenAPI)
                      </td>
                    </tr>
                    <tr>
                      <td className="massive-api-kv-label">OpenAPI</td>
                      <td className="massive-api-kv-path architecture-detail-url-cell">
                        {marketBase ? `${marketBase}/market/openapi.json` : '–'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
