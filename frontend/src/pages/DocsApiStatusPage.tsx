import { useEffect, useRef, useState } from 'react'
import {
  fetchDocsApiHealth,
  postDocsShutdown,
  type DocsApiHealthResponse,
} from '../api'
import { getDocsApiBase } from '../api/shared/apiRouting'
import {
  clearDocsLogs,
  fetchDocsLogs,
  subscribeDocsLogs,
} from '../api/monitor/logs'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useDeferredStart } from '../hooks/useDeferredStart'
import { useControlAction } from './status/useControlAction'

export interface DocsApiStatusPageProps {
  embeddedInSettings?: boolean
}

const PROFILE_LABELS: Record<string, string> = {
  dev: 'Development',
  prod: 'Production',
}

/** Base URL for Docs Swagger/ReDoc: VITE_DOCS_API_ORIGIN, else origin from utilized.services (GET /health), else same host + port from health. */
function docsApiDocsBase(health: DocsApiHealthResponse | null): string {
  const explicit = import.meta.env.VITE_DOCS_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const routed = getDocsApiBase().replace(/\/$/, '')
  if (routed) return routed
  const port = health?.port ?? 8767
  if (typeof window === 'undefined') return ''
  return `${window.location.protocol}//${window.location.hostname}:${port}`
}

export function DocsApiStatusPage({ embeddedInSettings }: DocsApiStatusPageProps) {
  const [health, setHealth] = useState<DocsApiHealthResponse | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const deferredStart = useDeferredStart()
  const mountedRef = useRef(true)
  const docsCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [docsCtrlMsg, setDocsCtrlMsg] = useState({ text: '', isErr: false })

  const refetchHealth = () => {
    fetchDocsApiHealth()
      .then(h => { if (mountedRef.current) { setHealth(h); setHealthOk(true) } })
      .catch(() => { if (mountedRef.current) { setHealth(null); setHealthOk(false) } })
  }

  const runDocsStop = useControlAction(setDocsCtrlMsg, docsCtrlMsgClearRef, {
    onSuccess: async () => {
      await new Promise(r => { window.setTimeout(r, 4000) })
      if (mountedRef.current) refetchHealth()
    },
  })

  const docsConsole = useLogConsole({
    fetchLogs: fetchDocsLogs,
    subscribeLogs: subscribeDocsLogs,
    clearLogs: clearDocsLogs,
    enabled: deferredStart,
  })

  useEffect(() => {
    if (!deferredStart) return
    mountedRef.current = true
    const load = () => {
      fetchDocsApiHealth()
        .then(h => { if (mountedRef.current) { setHealth(h); setHealthOk(true) } })
        .catch(() => { if (mountedRef.current) { setHealth(null); setHealthOk(false) } })
    }
    load()
    const t = window.setInterval(load, 15_000)
    return () => { mountedRef.current = false; window.clearInterval(t) }
  }, [deferredStart])

  useEffect(() => {
    return () => {
      if (docsCtrlMsgClearRef.current != null) clearTimeout(docsCtrlMsgClearRef.current)
    }
  }, [])

  const docsBase = docsApiDocsBase(health)
  const docsHref = `${docsBase}/research/docs/docs`
  const redocHref = `${docsBase}/research/docs/redoc`

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

        <section className="replay-section" aria-labelledby="docs-api-health-head">
          <div className="system-tab-panel">
            <div className="daemon-header">
              <div className="daemon-header-main daemon-header-with-lamp">
                <div>
                  <h2 id="docs-api-health-head" className="daemon-card-title page-title-with-tooltip">
                    <span className={`title-inline-lamp lamp-icon ${healthLamp}`} title="Docs API health" aria-hidden>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                      </svg>
                    </span>
                    Docs API
                    <InfoTooltip text="Health is GET /research/docs/health on the Docs FastAPI process (merged Main + Massive OpenAPI). Environment is derived from the loaded YAML file name: config.dev.yaml → Development, config.prod.yaml → Production; other files → Custom." />
                  </h2>
                  <div>
                    <strong>
                      Status:{' '}
                      {healthOk === true ? 'Running (OK)' : healthOk === false ? 'Unreachable' : 'Checking…'}
                    </strong>
                  </div>
                </div>
              </div>
              <div className="monitor-header-actions">
                <button
                  type="button"
                  className="section-header-icon-btn"
                  disabled={healthOk !== true}
                  title={healthOk === true ? 'Stop Docs API process' : 'Docs API not reachable'}
                  aria-label="Stop Docs API"
                  onClick={() =>
                    runDocsStop(postDocsShutdown, {
                      loading: 'Stopping Docs API…',
                      success: 'Docs API stopped. Refresh or run: python scripts/run_server_docs.py',
                    })
                  }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            {docsCtrlMsg.text ? (
              <div className={`msg ${docsCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
                {docsCtrlMsg.text}
              </div>
            ) : null}
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

        <section className="replay-section" aria-labelledby="docs-api-docs-head">
          <h3 id="docs-api-docs-head" className="page-title-with-tooltip">
            Documentation
            <InfoTooltip text="Opens Swagger UI or ReDoc against the Docs process. Default: same hostname as this app and the listen port from health. Set VITE_DOCS_API_ORIGIN in the frontend env to override (e.g. when nginx serves Docs on port 80 only)." />
          </h3>
          <p className="massive-api-doc-hint">
            {import.meta.env.VITE_DOCS_API_ORIGIN?.trim()
              ? `Using VITE_DOCS_API_ORIGIN: ${docsBase}`
              : `Target: ${docsBase} (hostname from browser + Docs listen port)`}
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
          </div>
        </section>

        <section className="replay-section" aria-labelledby="docs-api-console-head">
          <h3 id="docs-api-console-head" className="page-title-with-tooltip">
            Application log
            <InfoTooltip text="Real-time log from run_server_docs.py (Redis stream bifrost:docs_console), same pattern as System → Server." />
          </h3>
          <LogConsolePanel
            controller={docsConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down or status server not running)."
            emptyText="No log lines yet. Start Docs API: python scripts/run_server_docs.py"
            infoTooltipText="Docs API process log (Redis Stream)."
            resizeAriaLabel="Resize Docs console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </section>

        <section className="replay-section" aria-labelledby="docs-api-upstream-head">
          <h3 id="docs-api-upstream-head" className="page-title-with-tooltip">
            Upstream OpenAPI sources
            <InfoTooltip text="URLs the Docs server uses to fetch and merge OpenAPI JSON (Main, Massive, Research). Set via YAML ports or BIFROST_DOCS_MAIN_OPENAPI / BIFROST_DOCS_MASSIVE_OPENAPI / BIFROST_DOCS_RESEARCH_OPENAPI." />
          </h3>
          <table className="massive-api-kv-table">
            <tbody>
              <tr>
                <td className="massive-api-kv-label">Main API</td>
                <td className="massive-api-kv-path">{health?.main_url || '–'}</td>
              </tr>
              <tr>
                <td className="massive-api-kv-label">Massive API</td>
                <td className="massive-api-kv-path">{health?.massive_url || '–'}</td>
              </tr>
              <tr>
                <td className="massive-api-kv-label">Research API</td>
                <td className="massive-api-kv-path">{health?.research_url || '–'}</td>
              </tr>
            </tbody>
          </table>
        </section>

      </div>
    </div>
  )
}
