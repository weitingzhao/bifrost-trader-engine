import { useCallback, useEffect, useRef, useState } from 'react'
import { DraggableModal } from '../components/DraggableModal'
import {
  fetchHealth,
  fetchPortfolioCapabilities,
  fetchTradingCapabilities,
  postPortfolioShutdown,
  postTradingShutdown,
} from '../api'
import type { OpsCapabilities } from '../api/ops/ops'
import { joinServiceBase } from '../api/shared/apiRouting'
import { API_HEALTH_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../api/shared/fetchTimeout'
import { AggregatedLogConsolePanel } from '../components/AggregatedLogConsolePanel'
import { InfoTooltip } from '../components/InfoTooltip'
import type { UnifiedLogSourceDefinition } from '../components/unifiedLogConsoleTypes'
import { useAccountUnifiedLogConsole } from '../components/useAccountUnifiedLogConsole'
import { useDeferredStart } from '../hooks/useDeferredStart'
import { portfolioServiceBase, tradingServiceBase } from './account/accountSidecarBases'
import { scheduleMsgClear, setMsg } from './status/messageUtils'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'

export interface AccountApisPageProps {
  embeddedInSettings?: boolean
}

const PROFILE_LABELS: Record<string, string> = {
  dev: 'Development',
  prod: 'Production',
}

const ACCOUNT_LOG_SOURCE_DEFINITIONS: UnifiedLogSourceDefinition[] = [
  { source: 'trading', label: 'Trading' },
  { source: 'portfolio', label: 'Portfolio' },
]

type ShutdownKey = 'trading' | 'portfolio'

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
  trading_port?: number
  portfolio_port?: number
  config_profile?: 'dev' | 'prod'
}

type SidecarApiHealth = {
  status: string
  service: string
  ts: number
  config_profile?: 'dev' | 'prod'
  port?: number
}

function accountTitleAggregateLamp(
  tradingOk: boolean | null,
  portfolioOk: boolean | null,
): 'green' | 'yellow' | 'red' | 'none' {
  const vals = [tradingOk, portfolioOk]
  if (vals.some((v) => v === null)) return 'none'
  const greens = vals.filter((v) => v === true).length
  const reds = vals.filter((v) => v === false).length
  if (greens === 2) return 'green'
  if (reds === 2) return 'red'
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

export function AccountApisPage({ embeddedInSettings }: AccountApisPageProps) {
  const [monitorHealth, setMonitorHealth] = useState<MonitorHealthLite | null>(null)
  const [tradingHealth, setTradingHealth] = useState<SidecarApiHealth | null>(null)
  const [portfolioHealth, setPortfolioHealth] = useState<SidecarApiHealth | null>(null)
  const [tradingOk, setTradingOk] = useState<boolean | null>(null)
  const [portfolioOk, setPortfolioOk] = useState<boolean | null>(null)
  const [tradingCaps, setTradingCaps] = useState<OpsCapabilities | null>(null)
  const [portfolioCaps, setPortfolioCaps] = useState<OpsCapabilities | null>(null)
  const [shutdownTrading, setShutdownTrading] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownPortfolio, setShutdownPortfolio] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownTradingMsg, setShutdownTradingMsg] = useState({ text: '', isErr: false })
  const [shutdownPortfolioMsg, setShutdownPortfolioMsg] = useState({ text: '', isErr: false })
  const tradingMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const portfolioMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  type AccountDetailTab = 'trading' | 'portfolio'
  const [detailTab, setDetailTab] = useState<AccountDetailTab>('trading')

  const deferredStart = useDeferredStart()
  const logConsole = useAccountUnifiedLogConsole({
    enabled: deferredStart,
    initialMaxLines: 50,
    initialHeightPx: 280,
  })

  const refetchAll = useCallback(() => {
    fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
      .then((h) => {
        if (!mountedRef.current) return
        setMonitorHealth({
          trading_port: h.trading_port,
          portfolio_port: h.portfolio_port,
          config_profile: h.config_profile,
        })
        const tb = tradingServiceBase({
          trading_port: h.trading_port,
          portfolio_port: h.portfolio_port,
        })
        const pb = portfolioServiceBase({
          trading_port: h.trading_port,
          portfolio_port: h.portfolio_port,
        })
        if (tb) {
          fetchSidecarHealthAtOrigin(tb)
            .then((th) => {
              if (mountedRef.current) {
                setTradingHealth(th)
                setTradingOk(true)
              }
            })
            .catch(() => {
              if (mountedRef.current) {
                setTradingHealth(null)
                setTradingOk(false)
              }
            })
          fetchTradingCapabilities(tb)
            .then((c) => {
              if (mountedRef.current && c.ok) setTradingCaps(c)
            })
            .catch(() => {
              if (mountedRef.current) setTradingCaps(null)
            })
        } else {
          setTradingHealth(null)
          setTradingOk(null)
          setTradingCaps(null)
        }
        if (pb) {
          fetchSidecarHealthAtOrigin(pb)
            .then((ph) => {
              if (mountedRef.current) {
                setPortfolioHealth(ph)
                setPortfolioOk(true)
              }
            })
            .catch(() => {
              if (mountedRef.current) {
                setPortfolioHealth(null)
                setPortfolioOk(false)
              }
            })
          fetchPortfolioCapabilities(pb)
            .then((c) => {
              if (mountedRef.current && c.ok) setPortfolioCaps(c)
            })
            .catch(() => {
              if (mountedRef.current) setPortfolioCaps(null)
            })
        } else {
          setPortfolioHealth(null)
          setPortfolioOk(null)
          setPortfolioCaps(null)
        }
      })
      .catch(() => {
        if (!mountedRef.current) return
        setMonitorHealth(null)
        const tb = tradingServiceBase(null)
        const pb = portfolioServiceBase(null)
        if (tb) {
          fetchSidecarHealthAtOrigin(tb)
            .then((th) => {
              if (mountedRef.current) {
                setTradingHealth(th)
                setTradingOk(true)
              }
            })
            .catch(() => {
              if (mountedRef.current) {
                setTradingHealth(null)
                setTradingOk(false)
              }
            })
          fetchTradingCapabilities(tb)
            .then((c) => {
              if (mountedRef.current && c.ok) setTradingCaps(c)
            })
            .catch(() => {
              if (mountedRef.current) setTradingCaps(null)
            })
        } else {
          setTradingHealth(null)
          setTradingOk(null)
          setTradingCaps(null)
        }
        if (pb) {
          fetchSidecarHealthAtOrigin(pb)
            .then((ph) => {
              if (mountedRef.current) {
                setPortfolioHealth(ph)
                setPortfolioOk(true)
              }
            })
            .catch(() => {
              if (mountedRef.current) {
                setPortfolioHealth(null)
                setPortfolioOk(false)
              }
            })
          fetchPortfolioCapabilities(pb)
            .then((c) => {
              if (mountedRef.current && c.ok) setPortfolioCaps(c)
            })
            .catch(() => {
              if (mountedRef.current) setPortfolioCaps(null)
            })
        } else {
          setPortfolioHealth(null)
          setPortfolioOk(null)
          setPortfolioCaps(null)
        }
      })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    return () => {
      if (tradingMsgClearRef.current != null) clearTimeout(tradingMsgClearRef.current)
      if (portfolioMsgClearRef.current != null) clearTimeout(portfolioMsgClearRef.current)
    }
  }, [])

  useEffect(() => {
    if (!deferredStart) return
    refetchAll()
    const t = window.setInterval(refetchAll, 15_000)
    return () => window.clearInterval(t)
  }, [deferredStart, refetchAll])

  const tradingLamp: 'green' | 'red' | 'none' = tradingOk === true ? 'green' : tradingOk === false ? 'red' : 'none'
  const portfolioLamp: 'green' | 'red' | 'none' =
    portfolioOk === true ? 'green' : portfolioOk === false ? 'red' : 'none'
  const accountTitleLamp = accountTitleAggregateLamp(tradingOk, portfolioOk)

  const mhForBase = monitorHealth
  const tradingBase = tradingServiceBase(mhForBase)
  const portfolioBase = portfolioServiceBase(mhForBase)

  const tradingEnvClass =
    tradingHealth?.config_profile == null && tradingOk === true ? 'custom' : (tradingHealth?.config_profile ?? 'unknown')
  const portfolioEnvClass =
    portfolioHealth?.config_profile == null && portfolioOk === true
      ? 'custom'
      : (portfolioHealth?.config_profile ?? 'unknown')

  const canTradingOperate = tradingCaps?.capabilities.can_operate ?? false
  const canPortfolioOperate = portfolioCaps?.capabilities.can_operate ?? false
  const tradingStopDisabled = tradingOk !== true || !canTradingOperate
  const portfolioStopDisabled = portfolioOk !== true || !canPortfolioOperate

  const tradingStopTitle =
    tradingOk !== true
      ? 'Trading API not reachable'
      : !canTradingOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Trading API process'

  const portfolioStopTitle =
    portfolioOk !== true
      ? 'Portfolio API not reachable'
      : !canPortfolioOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Portfolio API process'

  const runShutdown = async (key: ShutdownKey) => {
    const base = key === 'trading' ? tradingBase : portfolioBase
    if (!base) return
    const cfg =
      key === 'trading'
        ? {
            setConfirm: setShutdownTrading,
            setLocalMsg: setShutdownTradingMsg,
            clearRef: tradingMsgClearRef,
            refetch: () => {
              fetchSidecarHealthAtOrigin(base)
                .then((th) => {
                  if (mountedRef.current) {
                    setTradingHealth(th)
                    setTradingOk(true)
                  }
                })
                .catch(() => {
                  if (mountedRef.current) {
                    setTradingHealth(null)
                    setTradingOk(false)
                  }
                })
            },
            scriptHint: 'python scripts/run_server_trading.py',
            label: 'Trading API',
            post: () => postTradingShutdown(base),
          }
        : {
            setConfirm: setShutdownPortfolio,
            setLocalMsg: setShutdownPortfolioMsg,
            clearRef: portfolioMsgClearRef,
            refetch: () => {
              fetchSidecarHealthAtOrigin(base)
                .then((ph) => {
                  if (mountedRef.current) {
                    setPortfolioHealth(ph)
                    setPortfolioOk(true)
                  }
                })
                .catch(() => {
                  if (mountedRef.current) {
                    setPortfolioHealth(null)
                    setPortfolioOk(false)
                  }
                })
            },
            scriptHint: 'python scripts/run_server_portfolio.py',
            label: 'Portfolio API',
            post: () => postPortfolioShutdown(base),
          }

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

  const tradingDialog = (
    <DraggableModal
      open={shutdownTrading.open}
      onBackdropClick={() => {
        if (!shutdownTrading.busy) setShutdownTrading(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownTrading.busy}
      title="Shut down Trading API"
      titleId="account-trading-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownTrading(INITIAL_SHUTDOWN)}
            disabled={shutdownTrading.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('trading')}
            disabled={shutdownTrading.busy}
          >
            {shutdownTrading.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the Trading FastAPI process (run_server_trading.py). Order execution and related
        endpoints on this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownTrading.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownTrading.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  const portfolioDialog = (
    <DraggableModal
      open={shutdownPortfolio.open}
      onBackdropClick={() => {
        if (!shutdownPortfolio.busy) setShutdownPortfolio(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownPortfolio.busy}
      title="Shut down Portfolio API"
      titleId="account-portfolio-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownPortfolio(INITIAL_SHUTDOWN)}
            disabled={shutdownPortfolio.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('portfolio')}
            disabled={shutdownPortfolio.busy}
          >
            {shutdownPortfolio.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the Portfolio FastAPI process (run_server_portfolio.py). Portfolio model and
        configuration endpoints on this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownPortfolio.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownPortfolio.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  const wrapClass = embeddedInSettings
    ? 'settings-page-card massive-api-status-page massive-api-status-page--embedded architecture-apis-page'
    : 'settings-page-card massive-api-status-page architecture-apis-page'

  return (
    <div className={wrapClass}>
      {tradingDialog}
      {portfolioDialog}
      <div className="server-groups settings-page-groups">
        <section className="replay-section" aria-labelledby="account-page-head">
          <div className="architecture-page-intro">
            <h2 id="account-page-head" className="daemon-card-title page-title-with-tooltip architecture-page-title">
              <span
                className={`title-inline-lamp lamp-icon ${accountTitleLamp}`}
                title="Combined Trading and Portfolio API reachability"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="api-account" />
              </span>
              Account
              <InfoTooltip text="Trading and Portfolio FastAPI sidecars: order execution / performance data vs portfolio model analysis and position configuration. Base URLs follow the same routing rules as API Health (VITE_TRADING_API_ORIGIN, VITE_PORTFOLIO_API_ORIGIN, or GET /health ports). Stop requires an operator-scoped Ops token (same as Architecture / Celery Control)." />
            </h2>
            <p className="massive-api-doc-hint architecture-page-hint">
              Status cards refresh every 15s. Documentation links use /trading/* and /portfolio/* paths on each service
              origin.
            </p>
          </div>

          <div className="architecture-status-grid architecture-status-grid--two">
            <article className="architecture-api-card" aria-labelledby="account-card-trading">
              <div className="architecture-api-card-head">
                <h3 id="account-card-trading" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${tradingLamp}`} title="Trading API health" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </span>
                  Trading API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={tradingStopDisabled}
                  title={tradingStopTitle}
                  aria-label="Shut down Trading API"
                  onClick={() => setShutdownTrading({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownTradingMsg.text ? (
                <div className={`msg ${shutdownTradingMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>
                  {shutdownTradingMsg.text}
                </div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>
                  {tradingOk === true ? 'Running (OK)' : tradingOk === false ? 'Unreachable' : 'Checking…'}
                </strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{tradingHealth?.port != null ? String(tradingHealth.port) : '–'}</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>{tradingHealth?.service ?? '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${tradingEnvClass}`}>
                      {tradingHealth?.config_profile
                        ? PROFILE_LABELS[tradingHealth.config_profile] ?? tradingHealth.config_profile
                        : tradingOk === true
                          ? 'Custom'
                          : 'Unknown'}
                    </span>
                  </dd>
                </div>
                {tradingHealth?.ts ? (
                  <div>
                    <dt>Server time</dt>
                    <dd>{new Date(tradingHealth.ts * 1000).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
            </article>

            <article className="architecture-api-card" aria-labelledby="account-card-portfolio">
              <div className="architecture-api-card-head">
                <h3 id="account-card-portfolio" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${portfolioLamp}`} title="Portfolio API health" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </span>
                  Portfolio API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={portfolioStopDisabled}
                  title={portfolioStopTitle}
                  aria-label="Shut down Portfolio API"
                  onClick={() => setShutdownPortfolio({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownPortfolioMsg.text ? (
                <div className={`msg ${shutdownPortfolioMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>
                  {shutdownPortfolioMsg.text}
                </div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>
                  {portfolioOk === true ? 'Running (OK)' : portfolioOk === false ? 'Unreachable' : 'Checking…'}
                </strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{portfolioHealth?.port != null ? String(portfolioHealth.port) : '–'}</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>{portfolioHealth?.service ?? '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${portfolioEnvClass}`}>
                      {portfolioHealth?.config_profile
                        ? PROFILE_LABELS[portfolioHealth.config_profile] ?? portfolioHealth.config_profile
                        : portfolioOk === true
                          ? 'Custom'
                          : 'Unknown'}
                    </span>
                  </dd>
                </div>
                {portfolioHealth?.ts ? (
                  <div>
                    <dt>Server time</dt>
                    <dd>{new Date(portfolioHealth.ts * 1000).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
            </article>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="account-docs-table-head">
          <h3 id="account-docs-table-head" className="page-title-with-tooltip architecture-section-title">
            Documentation
            <InfoTooltip text="Swagger UI, ReDoc, and OpenAPI JSON for each sidecar. Paths are fixed per app: /trading/docs and /portfolio/docs." />
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
                  <th scope="row">Trading</th>
                  <td className="architecture-docs-table-base">{tradingBase || '–'}</td>
                  <td>
                    {tradingBase ? (
                      <a
                        href={`${tradingBase}/trading/docs`}
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
                    {tradingBase ? (
                      <a
                        href={`${tradingBase}/trading/redoc`}
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
                    {tradingBase ? (
                      <a
                        href={`${tradingBase}/trading/openapi.json`}
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
                  <th scope="row">Portfolio</th>
                  <td className="architecture-docs-table-base">{portfolioBase || '–'}</td>
                  <td>
                    {portfolioBase ? (
                      <a
                        href={`${portfolioBase}/portfolio/docs`}
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
                    {portfolioBase ? (
                      <a
                        href={`${portfolioBase}/portfolio/redoc`}
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
                    {portfolioBase ? (
                      <a
                        href={`${portfolioBase}/portfolio/openapi.json`}
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

        <section className="replay-section" aria-labelledby="account-log-head">
          <h3 id="account-log-head" className="page-title-with-tooltip architecture-section-title">
            Application log
            <InfoTooltip text="Monitor merges Redis console streams for Trading and Portfolio (both dev and prod keys) so logs show even when Monitor and sidecars use different config profiles. Same pattern as Ops/Docs. Use Source toggles to filter. Clear removes both dev and prod streams per API." />
          </h3>
          <AggregatedLogConsolePanel
            controller={logConsole}
            sourceDefinitions={ACCOUNT_LOG_SOURCE_DEFINITIONS}
            loadingText="Connecting…"
            errorText="Unable to load logs (Redis may be down or Monitor API not running)."
            emptyText="No log lines yet. Start Trading and Portfolio API processes (run_server_trading.py / run_server_portfolio.py)."
            infoTooltipText="Clear displayed text and truncates both Redis log streams (Trading, Portfolio)."
            resizeAriaLabel="Resize unified account console height"
            clearTitle="Clear Trading and Portfolio log streams (dev and prod Redis keys per API)"
          />
        </section>

        <section className="replay-section architecture-api-details" aria-labelledby="account-api-details-head">
          <h3 id="account-api-details-head" className="page-title-with-tooltip architecture-section-title">
            API details
            <InfoTooltip text="Summary of what each sidecar exposes. Open the Swagger links above for full paths and schemas." />
          </h3>
          <div className="architecture-detail-tabs" role="tablist" aria-label="Account API detail by service">
            <button
              type="button"
              role="tab"
              id="account-tab-trading"
              aria-selected={detailTab === 'trading'}
              aria-controls="account-detail-panel"
              tabIndex={detailTab === 'trading' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'trading' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('trading')}
            >
              Trading API
            </button>
            <button
              type="button"
              role="tab"
              id="account-tab-portfolio"
              aria-selected={detailTab === 'portfolio'}
              aria-controls="account-detail-panel"
              tabIndex={detailTab === 'portfolio' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'portfolio' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('portfolio')}
            >
              Portfolio API
            </button>
          </div>
          <div
            id="account-detail-panel"
            role="tabpanel"
            aria-labelledby={detailTab === 'trading' ? 'account-tab-trading' : 'account-tab-portfolio'}
            className="architecture-detail-tabpanel"
          >
            {detailTab === 'trading' ? (
              <>
                <h4 className="architecture-detail-subhead">Executions, performance, and cash flows</h4>
                <p className="architecture-detail-subhint">
                  Account-level trades and derived views (R-A2, performance book, Flex ingest). Uses IB operator client
                  on startup when configured.
                </p>
                <table className="massive-api-kv-table architecture-config-table">
                  <tbody>
                    <tr>
                      <td className="massive-api-kv-label">Typical routes</td>
                      <td>
                        <code>/executions</code>, performance and transaction helpers (see OpenAPI)
                      </td>
                    </tr>
                    <tr>
                      <td className="massive-api-kv-label">OpenAPI</td>
                      <td className="massive-api-kv-path architecture-detail-url-cell">
                        {tradingBase ? `${tradingBase}/trading/openapi.json` : '–'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
            ) : (
              <>
                <h4 className="architecture-detail-subhead">Model analysis and portfolio configuration</h4>
                <p className="architecture-detail-subhint">
                  Portfolio payoff / Greeks style analysis and position category CRUD (Postgres-backed writes when
                  available).
                </p>
                <table className="massive-api-kv-table architecture-config-table">
                  <tbody>
                    <tr>
                      <td className="massive-api-kv-label">Typical routes</td>
                      <td>
                        <code>/portfolio/model-analysis</code>, <code>/position-categories</code>, execution strategy
                        attribution (see OpenAPI)
                      </td>
                    </tr>
                    <tr>
                      <td className="massive-api-kv-label">OpenAPI</td>
                      <td className="massive-api-kv-path architecture-detail-url-cell">
                        {portfolioBase ? `${portfolioBase}/portfolio/openapi.json` : '–'}
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
