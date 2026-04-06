import { useEffect, useRef, useState } from 'react'
import { fetchHealth } from '../api'
import { getServerApiBase } from '../api/shared/apiRouting'
import { API_HEALTH_FETCH_TIMEOUT_MS } from '../api/shared/fetchTimeout'
import {
  clearServerLogs,
  fetchServerLogs,
  subscribeServerLogs,
} from '../api/monitor/logs'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useDeferredStart } from '../hooks/useDeferredStart'

export interface MonitorApiStatusPageProps {
  embeddedInSettings?: boolean
}

type MonitorHealth = Awaited<ReturnType<typeof fetchHealth>>

const PROFILE_LABELS: Record<string, string> = {
  dev: 'Development',
  prod: 'Production',
}

/** Base for Swagger/ReDoc/OpenAPI: VITE_API_BASE, else getServerApiBase(), else browser host + monitor_port from health. */
function monitorApiDocsBase(health: MonitorHealth | null): string {
  const explicit = import.meta.env.VITE_API_BASE?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getServerApiBase().replace(/\/$/, '')
  if (routed) return routed
  const mp = health?.monitor_port
  if (typeof mp === 'number' && Number.isFinite(mp) && typeof window !== 'undefined') {
    return `${window.location.protocol}//${window.location.hostname}:${mp}`
  }
  return ''
}

export function MonitorApiStatusPage({ embeddedInSettings }: MonitorApiStatusPageProps) {
  const [health, setHealth] = useState<MonitorHealth | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const deferredStart = useDeferredStart()
  const mountedRef = useRef(true)

  const serverConsole = useLogConsole({
    fetchLogs: fetchServerLogs,
    subscribeLogs: subscribeServerLogs,
    clearLogs: clearServerLogs,
    enabled: deferredStart,
  })

  useEffect(() => {
    if (!deferredStart) return
    mountedRef.current = true
    const load = () => {
      fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
        .then((h) => {
          if (mountedRef.current) {
            setHealth(h)
            setHealthOk(true)
          }
        })
        .catch(() => {
          if (mountedRef.current) {
            setHealth(null)
            setHealthOk(false)
          }
        })
    }
    load()
    const t = window.setInterval(load, 15_000)
    return () => {
      mountedRef.current = false
      window.clearInterval(t)
    }
  }, [deferredStart])

  const docsBase = monitorApiDocsBase(health)
  const docsHref = `${docsBase}/docs`
  const redocHref = `${docsBase}/redoc`
  const openapiHref = `${docsBase}/openapi.json`

  const envBadgeClass =
    health?.config_profile == null && healthOk === true
      ? 'custom'
      : (health?.config_profile ?? 'unknown')
  let profileLabel = 'Unknown'
  if (health?.config_profile) {
    profileLabel = PROFILE_LABELS[health.config_profile] ?? health.config_profile
  } else if (healthOk === true) {
    profileLabel = 'Custom'
  }

  const healthLamp: 'green' | 'red' | 'none' = healthOk === true ? 'green' : healthOk === false ? 'red' : 'none'

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'massive-api-status-page massive-api-status-page--embedded' : 'massive-api-status-page'}`}>
      <div className="server-groups settings-page-groups">

        <section className="replay-section" aria-labelledby="monitor-api-health-head">
          <div className="system-tab-panel">
            <div className="daemon-header">
              <div className="daemon-header-main daemon-header-with-lamp">
                <div>
                  <h2 id="monitor-api-health-head" className="daemon-card-title page-title-with-tooltip">
                    <span className={`title-inline-lamp lamp-icon ${healthLamp}`} title="Monitor API health" aria-hidden>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                      </svg>
                    </span>
                    Monitor API
                    <InfoTooltip text="Health is GET /health on bifrost-server (status/control FastAPI). Environment comes from merged YAML profile (config.dev.yaml → Development, config.prod.yaml → Production). Sidecar listen ports are from the same YAML server.*_port keys." />
                  </h2>
                  <div>
                    <strong>
                      Status:{' '}
                      {healthOk === true ? 'Running (OK)' : healthOk === false ? 'Unreachable' : 'Checking…'}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
            <table className="massive-api-kv-table">
              <tbody>
                <tr>
                  <td className="massive-api-kv-label">Health</td>
                  <td>
                    <span className={`title-inline-lamp lamp-icon ${healthLamp}`} aria-hidden>●</span>
                    {' '}
                    {healthOk === true ? 'Reachable' : healthOk === false ? 'Unreachable' : 'Checking…'}
                  </td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Service</td>
                  <td>{health?.service ?? '–'}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Listen port</td>
                  <td>{health?.monitor_port != null ? String(health.monitor_port) : '–'}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Environment</td>
                  <td>
                    <span className={`massive-api-env-badge massive-api-env-badge--${envBadgeClass}`}>
                      {profileLabel}
                    </span>
                  </td>
                </tr>
                {health?.ts ? (
                  <tr>
                    <td className="massive-api-kv-label">Server time</td>
                    <td>{new Date(health.ts * 1000).toLocaleString()}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="monitor-api-docs-head">
          <h3 id="monitor-api-docs-head" className="page-title-with-tooltip">
            Documentation
            <InfoTooltip text="Opens Swagger UI, ReDoc, or raw OpenAPI JSON for this Monitor process. Set VITE_API_BASE when the UI is served from a different origin than bifrost-server." />
          </h3>
          <p className="massive-api-doc-hint">
            {import.meta.env.VITE_API_BASE?.trim()
              ? `Using VITE_API_BASE: ${docsBase}`
              : `Target: ${docsBase} (routing from initApiRouting or browser host + listen port)`}
          </p>
          <div className="massive-api-doc-links">
            <a href={docsHref} target="_blank" rel="noopener noreferrer" className="massive-api-doc-link">
              <span className="massive-api-doc-link-icon">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="16" y1="13" x2="8" y2="13" />
                  <line x1="16" y1="17" x2="8" y2="17" />
                  <polyline points="10 9 9 9 8 9" />
                </svg>
              </span>
              Swagger UI
              <span className="massive-api-doc-link-ext" aria-hidden>↗</span>
            </a>
            <a href={redocHref} target="_blank" rel="noopener noreferrer" className="massive-api-doc-link">
              <span className="massive-api-doc-link-icon">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                  <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                </svg>
              </span>
              ReDoc
              <span className="massive-api-doc-link-ext" aria-hidden>↗</span>
            </a>
            <a href={openapiHref} target="_blank" rel="noopener noreferrer" className="massive-api-doc-link">
              OpenAPI JSON
              <span className="massive-api-doc-link-ext" aria-hidden>↗</span>
            </a>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="monitor-api-console-head">
          <h3 id="monitor-api-console-head" className="page-title-with-tooltip">
            Application log
            <InfoTooltip text="Real-time log from run_server.py (Redis stream bifrost:server_console), same pattern as System → Server and Docs API." />
          </h3>
          <LogConsolePanel
            controller={serverConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down or Monitor API not running)."
            emptyText="No log lines yet. Start Monitor API: python scripts/run_server.py"
            infoTooltipText="Monitor API process log (Redis Stream)."
            resizeAriaLabel="Resize Monitor console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </section>

        {health ? (
          <section className="replay-section" aria-labelledby="monitor-api-ports-head">
            <h3 id="monitor-api-ports-head" className="page-title-with-tooltip">
              Sidecar ports (from YAML)
              <InfoTooltip text="Listen ports from the same merged config as this process (server.massive_port, server.docs_port, …). Actual processes may run on other hosts when using split frontend paths." />
            </h3>
            <table className="massive-api-kv-table">
              <tbody>
                <tr>
                  <td className="massive-api-kv-label">Massive API</td>
                  <td>{String(health.massive_port ?? '–')}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Docs API</td>
                  <td>{String(health.docs_port ?? '–')}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Ops API</td>
                  <td>{String(health.ops_port ?? '–')}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Trading API</td>
                  <td>{String(health.trading_port ?? '–')}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Strategy API</td>
                  <td>{String(health.strategy_port ?? '–')}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Portfolio API</td>
                  <td>{String(health.portfolio_port ?? '–')}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Market API</td>
                  <td>{String(health.market_port ?? '–')}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Research API</td>
                  <td>{String(health.research_port ?? '–')}</td>
                </tr>
              </tbody>
            </table>
          </section>
        ) : null}

      </div>
    </div>
  )
}
