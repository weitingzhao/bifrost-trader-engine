import { useEffect, useRef, useState } from 'react'
import { getOpsApiBase, getServerApiBase, joinServiceBase } from '../api/shared/apiRouting'
import { fetchOpsHealth } from '../api/ops/ops'
import {
  clearOpsLogs,
  fetchOpsLogs,
  subscribeOpsLogs,
} from '../api/monitor/logs'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useDeferredStart } from '../hooks/useDeferredStart'

export interface OpsApiStatusPageProps {
  embeddedInSettings?: boolean
}

const PROFILE_LABELS: Record<string, string> = {
  dev: 'Development',
  prod: 'Production',
}

function opsApiDocsBase(health: Awaited<ReturnType<typeof fetchOpsHealth>> | null): string {
  const explicit = import.meta.env.VITE_OPS_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getOpsApiBase().replace(/\/$/, '')
  if (routed) return routed
  const port = health?.port ?? 8768
  if (typeof window === 'undefined') return ''
  return `${window.location.protocol}//${window.location.hostname}:${port}`
}

export function OpsApiStatusPage({ embeddedInSettings }: OpsApiStatusPageProps) {
  const [health, setHealth] = useState<Awaited<ReturnType<typeof fetchOpsHealth>> | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const mountedRef = useRef(true)
  const deferredStart = useDeferredStart()
  const opsConsole = useLogConsole({
    fetchLogs: fetchOpsLogs,
    subscribeLogs: subscribeOpsLogs,
    clearLogs: clearOpsLogs,
    enabled: deferredStart,
  })

  useEffect(() => {
    mountedRef.current = true
    const load = () => {
      fetchOpsHealth()
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
  }, [])

  const docsBase = opsApiDocsBase(health)
  const docsHref = `${docsBase}/ops/docs`
  const redocHref = `${docsBase}/ops/redoc`
  const openapiHref = `${docsBase}/ops/openapi.json`
  const mainApiBase = getServerApiBase().replace(/\/$/, '') || (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '')
  const opsApiBase = docsBase

  const envBadgeClass =
    health?.config_profile == null && healthOk === true && health?.config_path
      ? 'custom'
      : (health?.config_profile ?? 'unknown')
  let profileLabel = 'Unknown'
  if (health?.config_profile) {
    profileLabel = PROFILE_LABELS[health.config_profile] ?? health.config_profile
  } else if (healthOk === true && health?.config_path) {
    profileLabel = 'Custom'
  }
  const healthLamp: 'green' | 'red' | 'none' = healthOk === true ? 'green' : healthOk === false ? 'red' : 'none'

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'massive-api-status-page massive-api-status-page--embedded' : 'massive-api-status-page'}`}>
      <div className="server-groups settings-page-groups">
        <section className="replay-section" aria-labelledby="ops-api-health-head">
          <div className="system-tab-panel">
            <div className="daemon-header">
              <div className="daemon-header-main daemon-header-with-lamp">
                <div>
                  <h2 id="ops-api-health-head" className="daemon-card-title page-title-with-tooltip">
                    <span className={`title-inline-lamp lamp-icon ${healthLamp}`} title="Ops API health" aria-hidden>●</span>
                    Ops API
                    <InfoTooltip text="Health is GET /ops/health on the Ops FastAPI process. Environment is derived from loaded YAML profile (dev/prod/custom)." />
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
                  <td className="massive-api-kv-label">Listen port</td>
                  <td>{health?.port != null ? String(health.port) : '–'}</td>
                </tr>
                <tr>
                  <td className="massive-api-kv-label">Environment</td>
                  <td>
                    <span className={`massive-api-env-badge massive-api-env-badge--${envBadgeClass}`}>
                      {profileLabel}
                    </span>
                  </td>
                </tr>
                {health?.config_path ? (
                  <tr>
                    <td className="massive-api-kv-label">Config file</td>
                    <td className="massive-api-kv-path">{health.config_path}</td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="ops-api-docs-head">
          <h3 id="ops-api-docs-head" className="page-title-with-tooltip">
            Documentation
            <InfoTooltip text="Open Swagger/ReDoc for Ops API. You can override base origin using VITE_OPS_API_ORIGIN." />
          </h3>
          <p className="massive-api-doc-hint">
            {import.meta.env.VITE_OPS_API_ORIGIN?.trim()
              ? `Using VITE_OPS_API_ORIGIN: ${docsBase}`
              : `Target: ${docsBase} (hostname from browser + Ops listen port)`}
          </p>
          <div className="massive-api-doc-links">
            <a href={docsHref} target="_blank" rel="noopener noreferrer" className="massive-api-doc-link">
              Swagger UI
              <span className="massive-api-doc-link-ext" aria-hidden>↗</span>
            </a>
            <a href={redocHref} target="_blank" rel="noopener noreferrer" className="massive-api-doc-link">
              ReDoc
              <span className="massive-api-doc-link-ext" aria-hidden>↗</span>
            </a>
            <a href={openapiHref} target="_blank" rel="noopener noreferrer" className="massive-api-doc-link">
              OpenAPI JSON
              <span className="massive-api-doc-link-ext" aria-hidden>↗</span>
            </a>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="ops-api-console-head">
          <h3 id="ops-api-console-head" className="page-title-with-tooltip">
            Application log
            <InfoTooltip text="Real-time log from run_server_ops.py (Redis stream bifrost:ops_console), same pattern as Docs/Massive." />
          </h3>
          <LogConsolePanel
            controller={opsConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down or status server not running)."
            emptyText="No log lines yet. Start Ops API: python scripts/run_server_ops.py"
            infoTooltipText="Ops API process log (Redis Stream)."
            resizeAriaLabel="Resize Ops console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </section>

        <section className="replay-section" aria-labelledby="ops-api-sources-head">
          <h3 id="ops-api-sources-head" className="page-title-with-tooltip">
            API sources
            <InfoTooltip text="Source endpoints used by UI for Main API and Ops API docs/health." />
          </h3>
          <table className="massive-api-kv-table">
            <tbody>
              <tr>
                <td className="massive-api-kv-label">Main API</td>
                <td className="massive-api-kv-path">{joinServiceBase(mainApiBase, '/openapi.json')}</td>
              </tr>
              <tr>
                <td className="massive-api-kv-label">Ops API</td>
                <td className="massive-api-kv-path">{joinServiceBase(opsApiBase, '/ops/openapi.json')}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  )
}
