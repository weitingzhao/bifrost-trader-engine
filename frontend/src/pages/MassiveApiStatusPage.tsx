import { useEffect, useRef, useState } from 'react'
import {
  fetchMassiveApiHealth,
  fetchMassiveStatus,
  postMassiveShutdown,
  type MassiveApiHealthResponse,
  type MassiveStatusResponse,
} from '../api'
import {
  clearMassiveLogs,
  fetchMassiveLogs,
  subscribeMassiveLogs,
} from '../api/logs'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { useControlAction } from './status/useControlAction'

export interface MassiveApiStatusPageProps {
  embeddedInSettings?: boolean
}

const PROFILE_LABELS: Record<string, string> = {
  dev: 'Development',
  prod: 'Production',
}

const TIER_LABELS: Record<string, string> = {
  starter: 'Starter (free)',
  developer: 'Developer',
  advanced: 'Advanced',
  business: 'Business',
}

/** Base URL for Massive Swagger/ReDoc: optional VITE_MASSIVE_API_ORIGIN, else same host + port from health (not UI origin — fixes wrong port when dev server proxies API). */
function massiveApiDocsBase(health: MassiveApiHealthResponse | null): string {
  const explicit = import.meta.env.VITE_MASSIVE_API_ORIGIN?.trim()
  if (explicit) return explicit.replace(/\/$/, '')
  const port = health?.port ?? 8766
  if (typeof window === 'undefined') return ''
  return `${window.location.protocol}//${window.location.hostname}:${port}`
}

export function MassiveApiStatusPage({ embeddedInSettings }: MassiveApiStatusPageProps) {
  const [health, setHealth] = useState<MassiveApiHealthResponse | null>(null)
  const [healthOk, setHealthOk] = useState<boolean | null>(null)
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [massiveCtrlMsg, setMassiveCtrlMsg] = useState({ text: '', isErr: false })
  const mountedRef = useRef(true)
  const massiveCtrlMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refetchHealth = () => {
    fetchMassiveApiHealth()
      .then(h => { if (mountedRef.current) { setHealth(h); setHealthOk(true) } })
      .catch(() => { if (mountedRef.current) { setHealth(null); setHealthOk(false) } })
  }

  const runMassiveStop = useControlAction(setMassiveCtrlMsg, massiveCtrlMsgClearRef, {
    onSuccess: async () => {
      await new Promise(r => { window.setTimeout(r, 4000) })
      if (mountedRef.current) refetchHealth()
    },
  })

  const massiveConsole = useLogConsole({
    fetchLogs: fetchMassiveLogs,
    subscribeLogs: subscribeMassiveLogs,
    clearLogs: clearMassiveLogs,
  })

  useEffect(() => {
    mountedRef.current = true
    const load = () => {
      fetchMassiveApiHealth()
        .then(h => { if (mountedRef.current) { setHealth(h); setHealthOk(true) } })
        .catch(() => { if (mountedRef.current) { setHealth(null); setHealthOk(false) } })
      fetchMassiveStatus()
        .then(s => { if (mountedRef.current) setMassiveStatus(s) })
        .catch(() => { if (mountedRef.current) setMassiveStatus(null) })
    }
    load()
    const t = window.setInterval(load, 15_000)
    return () => { mountedRef.current = false; window.clearInterval(t) }
  }, [])

  useEffect(() => {
    return () => {
      if (massiveCtrlMsgClearRef.current != null) clearTimeout(massiveCtrlMsgClearRef.current)
    }
  }, [])

  const docsBase = massiveApiDocsBase(health)
  const docsHref = `${docsBase}/research/massive/docs`
  const redocHref = `${docsBase}/research/massive/redoc`

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

        <section className="replay-section" aria-labelledby="massive-api-health-head">
          <div className="system-tab-panel">
            <div className="daemon-header">
              <div className="daemon-header-main daemon-header-with-lamp">
                <div>
                  <h2 id="massive-api-health-head" className="daemon-card-title page-title-with-tooltip">
                    <span className={`title-inline-lamp lamp-icon ${healthLamp}`} title="Massive API health" aria-hidden>
                      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                      </svg>
                    </span>
                    Massive API
                    <InfoTooltip text="Health is GET /research/massive/health on the Massive FastAPI process. Environment is derived from the loaded YAML file name: config.dev.yaml → Development, config.prod.yaml → Production; other files → Custom." />
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
                  title={healthOk === true ? 'Stop Massive API process' : 'Massive API not reachable'}
                  aria-label="Stop Massive API"
                  onClick={() =>
                    runMassiveStop(postMassiveShutdown, {
                      loading: 'Stopping Massive API…',
                      success: 'Massive API stopped. Refresh or run: python scripts/run_server_massive.py',
                    })
                  }
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>
            {massiveCtrlMsg.text ? (
              <div className={`msg ${massiveCtrlMsg.isErr ? 'err' : 'ok'}`} style={{ marginTop: '0.5rem' }}>
                {massiveCtrlMsg.text}
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

        <section className="replay-section" aria-labelledby="massive-api-docs-head">
          <h3 id="massive-api-docs-head" className="page-title-with-tooltip">
            Documentation
            <InfoTooltip text="Opens Swagger UI or ReDoc against the Massive process. Default: same hostname as this app and the listen port from health. Set VITE_MASSIVE_API_ORIGIN in the frontend env to override (e.g. when nginx serves Massive on port 80 only)." />
          </h3>
          <p className="massive-api-doc-hint">
            {import.meta.env.VITE_MASSIVE_API_ORIGIN?.trim()
              ? `Using VITE_MASSIVE_API_ORIGIN: ${docsBase}`
              : `Target: ${docsBase} (hostname from browser + Massive listen port)`}
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

        <section className="replay-section" aria-labelledby="massive-api-console-head">
          <h3 id="massive-api-console-head" className="page-title-with-tooltip">
            Application log
            <InfoTooltip text="Real-time log from run_server_massive.py (Redis stream bifrost:massive_console), same pattern as System → Server." />
          </h3>
          <LogConsolePanel
            controller={massiveConsole}
            loadingText="Connecting…"
            errorText="Unable to load (Redis may be down or status server not running)."
            emptyText="No log lines yet. Start Massive API: python scripts/run_server_massive.py"
            infoTooltipText="Massive API process log (Redis Stream)."
            resizeAriaLabel="Resize Massive console height"
            clearTitle="Clear displayed log and Redis stream"
          />
        </section>

        <section className="replay-section" aria-labelledby="massive-api-polygon-head">
          <h3 id="massive-api-polygon-head" className="page-title-with-tooltip">
            Polygon data source
            <InfoTooltip text="Configuration status of the Polygon.io market data provider." />
          </h3>
          <table className="massive-api-kv-table">
            <tbody>
              <tr>
                <td className="massive-api-kv-label">Configured</td>
                <td>{massiveStatus ? (massiveStatus.configured ? 'Yes' : 'No') : '–'}</td>
              </tr>
              <tr>
                <td className="massive-api-kv-label">Tier</td>
                <td>{massiveStatus ? (TIER_LABELS[massiveStatus.tier] ?? massiveStatus.tier) : '–'}</td>
              </tr>
              <tr>
                <td className="massive-api-kv-label">Trades enabled</td>
                <td>{massiveStatus ? (massiveStatus.trades_enabled ? 'Yes' : 'No') : '–'}</td>
              </tr>
              {massiveStatus?.delay_notice ? (
                <tr>
                  <td className="massive-api-kv-label">Delay notice</td>
                  <td>{massiveStatus.delay_notice}</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>

      </div>
    </div>
  )
}
