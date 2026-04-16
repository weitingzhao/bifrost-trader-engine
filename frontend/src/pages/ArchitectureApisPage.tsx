import { useCallback, useEffect, useRef, useState } from 'react'
import { DraggableModal } from '../components/DraggableModal'
import {
  fetchDocsApiHealth,
  fetchDocsCapabilities,
  fetchHealth,
  fetchMonitorCapabilities,
  postDocsShutdown,
  postMonitorShutdown,
  type DocsApiHealthResponse,
} from '../api'
import { API_HEALTH_FETCH_TIMEOUT_MS } from '../api/shared/fetchTimeout'
import { getServerApiBase, joinServiceBase } from '../api/shared/apiRouting'
import {
  fetchOpsCapabilities,
  fetchOpsHealth,
  postOpsShutdown,
  type OpsCapabilities,
} from '../api/ops/ops'
import { AggregatedLogConsolePanel } from '../components/AggregatedLogConsolePanel'
import { InfoTooltip } from '../components/InfoTooltip'
import { useArchitectureUnifiedLogConsole } from '../components/useArchitectureUnifiedLogConsole'
import { useDeferredStart } from '../hooks/useDeferredStart'
import {
  docsApiDocsBase,
  monitorApiDocsBase,
  opsApiDocsBase,
  type MonitorHealthForBases,
  type OpsHealthForBases,
} from './architecture/architectureApiBases'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
import { scheduleMsgClear, setMsg } from './status/messageUtils'

export interface ArchitectureApisPageProps {
  embeddedInSettings?: boolean
}

const PROFILE_LABELS: Record<string, string> = {
  dev: 'Development',
  prod: 'Production',
}

type MonitorHealth = Awaited<ReturnType<typeof fetchHealth>>
type OpsHealth = Awaited<ReturnType<typeof fetchOpsHealth>>

type ShutdownKey = 'monitor' | 'docs' | 'ops'

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

function docsOpsEnvBadgeClass(
  profile: string | undefined | null,
  healthOk: boolean | null,
  configPath?: string | null,
): string {
  if (profile === 'dev' || profile === 'prod') return profile
  if (profile) return 'unknown'
  if (healthOk === true && configPath != null && configPath !== '') return 'custom'
  return 'unknown'
}

function docsOpsProfileLabel(
  profile: string | undefined | null,
  healthOk: boolean | null,
  configPath?: string | null,
): string {
  if (profile) return PROFILE_LABELS[profile] ?? profile
  if (healthOk === true && configPath != null && configPath !== '') return 'Custom'
  return 'Unknown'
}

function truncatePath(p: string, max = 42): string {
  if (p.length <= max) return p
  return `…${p.slice(-(max - 1))}`
}

/** Aggregate Monitor / Ops / Docs reachability for the page title lamp. */
function architectureTitleAggregateLamp(
  monitorOk: boolean | null,
  docsOk: boolean | null,
  opsOk: boolean | null,
): 'green' | 'yellow' | 'red' | 'none' {
  const vals = [monitorOk, docsOk, opsOk]
  if (vals.some((v) => v === null)) return 'none'
  const greens = vals.filter((v) => v === true).length
  const reds = vals.filter((v) => v === false).length
  if (greens === 3) return 'green'
  if (reds === 3) return 'red'
  return 'yellow'
}

export function ArchitectureApisPage({ embeddedInSettings }: ArchitectureApisPageProps) {
  const [monitorHealth, setMonitorHealth] = useState<MonitorHealth | null>(null)
  const [monitorOk, setMonitorOk] = useState<boolean | null>(null)
  const [docsHealth, setDocsHealth] = useState<DocsApiHealthResponse | null>(null)
  const [docsOk, setDocsOk] = useState<boolean | null>(null)
  const [opsHealth, setOpsHealth] = useState<OpsHealth | null>(null)
  const [opsOk, setOpsOk] = useState<boolean | null>(null)
  const [monitorCaps, setMonitorCaps] = useState<OpsCapabilities | null>(null)
  const [docsCaps, setDocsCaps] = useState<OpsCapabilities | null>(null)
  const [opsCaps, setOpsCaps] = useState<OpsCapabilities | null>(null)

  const [shutdownMonitor, setShutdownMonitor] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownDocs, setShutdownDocs] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownOps, setShutdownOps] = useState<ShutdownConfirmState>(INITIAL_SHUTDOWN)
  const [shutdownMonitorMsg, setShutdownMonitorMsg] = useState({ text: '', isErr: false })
  const [shutdownDocsMsg, setShutdownDocsMsg] = useState({ text: '', isErr: false })
  const [shutdownOpsMsg, setShutdownOpsMsg] = useState({ text: '', isErr: false })
  const monitorMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const docsMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const opsMsgClearRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)

  type ArchitectureDetailTab = 'monitor' | 'ops' | 'docs'
  const [detailTab, setDetailTab] = useState<ArchitectureDetailTab>('monitor')

  const deferredStart = useDeferredStart()
  const logConsole = useArchitectureUnifiedLogConsole({
    enabled: deferredStart,
    initialMaxLines: 50,
    initialHeightPx: 280,
  })

  const refetchMonitorHealth = useCallback(() => {
    fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
      .then((h) => {
        if (mountedRef.current) {
          setMonitorHealth(h)
          setMonitorOk(true)
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setMonitorHealth(null)
          setMonitorOk(false)
        }
      })
  }, [])

  const refetchDocsHealth = useCallback(() => {
    fetchDocsApiHealth()
      .then((h) => {
        if (mountedRef.current) {
          setDocsHealth(h)
          setDocsOk(true)
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setDocsHealth(null)
          setDocsOk(false)
        }
      })
  }, [])

  const refetchOpsHealth = useCallback(() => {
    fetchOpsHealth()
      .then((h) => {
        if (mountedRef.current) {
          setOpsHealth(h)
          setOpsOk(true)
        }
      })
      .catch(() => {
        if (mountedRef.current) {
          setOpsHealth(null)
          setOpsOk(false)
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
      if (monitorMsgClearRef.current != null) clearTimeout(monitorMsgClearRef.current)
      if (docsMsgClearRef.current != null) clearTimeout(docsMsgClearRef.current)
      if (opsMsgClearRef.current != null) clearTimeout(opsMsgClearRef.current)
    }
  }, [])

  useEffect(() => {
    if (!deferredStart) return
    const load = () => {
      refetchMonitorHealth()
      fetchMonitorCapabilities()
        .then((c) => {
          if (mountedRef.current && c.ok) setMonitorCaps(c)
        })
        .catch(() => {
          if (mountedRef.current) setMonitorCaps(null)
        })
      refetchDocsHealth()
      fetchDocsCapabilities()
        .then((c) => {
          if (mountedRef.current && c.ok) setDocsCaps(c)
        })
        .catch(() => {
          if (mountedRef.current) setDocsCaps(null)
        })
      refetchOpsHealth()
      fetchOpsCapabilities()
        .then((c) => {
          if (mountedRef.current && c.ok) setOpsCaps(c)
        })
        .catch(() => {
          if (mountedRef.current) setOpsCaps(null)
        })
    }
    load()
    const t = window.setInterval(load, 15_000)
    return () => window.clearInterval(t)
  }, [deferredStart, refetchMonitorHealth, refetchDocsHealth, refetchOpsHealth])

  const monitorLamp: 'green' | 'red' | 'none' = monitorOk === true ? 'green' : monitorOk === false ? 'red' : 'none'
  const docsLamp: 'green' | 'red' | 'none' = docsOk === true ? 'green' : docsOk === false ? 'red' : 'none'
  const opsLamp: 'green' | 'red' | 'none' = opsOk === true ? 'green' : opsOk === false ? 'red' : 'none'
  const architectureTitleLamp = architectureTitleAggregateLamp(monitorOk, docsOk, opsOk)

  const canMonitorOperate = monitorCaps?.capabilities.can_operate ?? false
  const canDocsOperate = docsCaps?.capabilities.can_operate ?? false
  const canOpsOperate = opsCaps?.capabilities.can_operate ?? false
  const monitorStopDisabled = monitorOk !== true || !canMonitorOperate
  const docsStopDisabled = docsOk !== true || !canDocsOperate
  const opsStopDisabled = opsOk !== true || !canOpsOperate

  const monitorStopTitle =
    monitorOk !== true
      ? 'Monitor API not reachable'
      : !canMonitorOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Monitor API process'

  const docsStopTitle =
    docsOk !== true
      ? 'Docs API not reachable'
      : !canDocsOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Docs API process'

  const opsStopTitle =
    opsOk !== true
      ? 'Ops API not reachable'
      : !canOpsOperate
        ? 'Operator role required — set an Ops token with operator or admin role'
        : 'Shut down Ops API process'

  const runShutdown = async (key: ShutdownKey) => {
    const cfg =
      key === 'monitor'
        ? {
            setConfirm: setShutdownMonitor,
            setLocalMsg: setShutdownMonitorMsg,
            clearRef: monitorMsgClearRef,
            refetch: refetchMonitorHealth,
            scriptHint: 'python scripts/run_server.py',
            label: 'Monitor API',
            post: postMonitorShutdown,
          }
        : key === 'docs'
          ? {
              setConfirm: setShutdownDocs,
              setLocalMsg: setShutdownDocsMsg,
              clearRef: docsMsgClearRef,
              refetch: refetchDocsHealth,
              scriptHint: 'python scripts/run_server_docs.py',
              label: 'Docs API',
              post: postDocsShutdown,
            }
          : {
              setConfirm: setShutdownOps,
              setLocalMsg: setShutdownOpsMsg,
              clearRef: opsMsgClearRef,
              refetch: refetchOpsHealth,
              scriptHint: 'python scripts/run_server_ops.py',
              label: 'Ops API',
              post: postOpsShutdown,
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

  const mhForBase: MonitorHealthForBases = monitorHealth
  const monitorBase = monitorApiDocsBase(mhForBase)
  const docsBase = docsApiDocsBase(docsHealth)
  const opsBase = opsApiDocsBase(opsHealth as OpsHealthForBases)

  const mainApiBase =
    getServerApiBase().replace(/\/$/, '') ||
    (typeof window !== 'undefined' ? `${window.location.protocol}//${window.location.host}` : '')

  const monitorEnvClass =
    monitorHealth?.config_profile == null && monitorOk === true
      ? 'custom'
      : (monitorHealth?.config_profile ?? 'unknown')
  const docsEnvClass = docsOpsEnvBadgeClass(docsHealth?.config_profile ?? undefined, docsOk, docsHealth?.config_path)
  const opsEnvClass = docsOpsEnvBadgeClass(opsHealth?.config_profile ?? undefined, opsOk, opsHealth?.config_path)

  const wrapClass = embeddedInSettings
    ? 'settings-page-card massive-api-status-page massive-api-status-page--embedded architecture-apis-page'
    : 'settings-page-card massive-api-status-page architecture-apis-page'

  const docsDialog = (
    <DraggableModal
      open={shutdownDocs.open}
      onBackdropClick={() => {
        if (!shutdownDocs.busy) setShutdownDocs(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownDocs.busy}
      title="Shut down Docs API"
      titleId="arch-docs-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownDocs(INITIAL_SHUTDOWN)}
            disabled={shutdownDocs.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('docs')}
            disabled={shutdownDocs.busy}
          >
            {shutdownDocs.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the Docs FastAPI process (run_server_docs.py). Merged OpenAPI docs on
        this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownDocs.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownDocs.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  const monitorDialog = (
    <DraggableModal
      open={shutdownMonitor.open}
      onBackdropClick={() => {
        if (!shutdownMonitor.busy) setShutdownMonitor(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownMonitor.busy}
      title="Shut down Monitor API"
      titleId="arch-monitor-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownMonitor(INITIAL_SHUTDOWN)}
            disabled={shutdownMonitor.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('monitor')}
            disabled={shutdownMonitor.busy}
          >
            {shutdownMonitor.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the bifrost-server process (run_server.py). The management UI, status API, and
        proxied logs on this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownMonitor.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownMonitor.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  const opsDialog = (
    <DraggableModal
      open={shutdownOps.open}
      onBackdropClick={() => {
        if (!shutdownOps.busy) setShutdownOps(INITIAL_SHUTDOWN)
      }}
      backdropLocked={shutdownOps.busy}
      title="Shut down Ops API"
      titleId="arch-ops-shutdown-title"
      overlayClassName="celery-control-confirm-overlay"
      footer={
        <div className="data-reset-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setShutdownOps(INITIAL_SHUTDOWN)}
            disabled={shutdownOps.busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn-shutdown-all"
            onClick={() => void runShutdown('ops')}
            disabled={shutdownOps.busy}
          >
            {shutdownOps.busy ? 'Executing…' : 'Confirm'}
          </button>
        </div>
      }
    >
      <p>
        This will terminate the Ops FastAPI process (run_server_ops.py). Worker control and other Ops
        endpoints on this host will be unavailable until you restart the process on the server.
      </p>
      {shutdownOps.error ? (
        <div className="msg err" role="alert" style={{ marginBottom: '0.75rem' }}>
          {shutdownOps.error}
        </div>
      ) : null}
    </DraggableModal>
  )

  return (
    <div className={wrapClass}>
      {monitorDialog}
      {opsDialog}
      {docsDialog}
      <div className="server-groups settings-page-groups">
        <section className="replay-section" aria-labelledby="arch-page-head">
          <div className="architecture-page-intro">
            <h2 id="arch-page-head" className="daemon-card-title page-title-with-tooltip architecture-page-title">
              <span
                className={`title-inline-lamp lamp-icon ${architectureTitleLamp}`}
                title="Combined Monitor, Ops, and Docs API reachability"
                aria-hidden
              >
                <SettingsSidebarLampGlyph id="api-architecture" />
              </span>
              Architecture
              <InfoTooltip text="Monitor, Ops, and Docs FastAPI processes: health, documentation links, and a unified process log (Redis streams). Stop actions require an operator-scoped Ops token (same as Celery Control)." />
            </h2>
            <p className="massive-api-doc-hint architecture-page-hint">
              Status cards refresh every 15s. Documentation links use the same base resolution as standalone API
              pages (VITE_*_ORIGIN / routing / health ports).
            </p>
          </div>

          <div className="architecture-status-grid">
            <article className="architecture-api-card" aria-labelledby="arch-card-monitor">
              <div className="architecture-api-card-head">
                <h3 id="arch-card-monitor" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${monitorLamp}`} title="Monitor API health" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </span>
                  Monitor API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={monitorStopDisabled}
                  title={monitorStopTitle}
                  aria-label="Shut down Monitor API"
                  onClick={() => setShutdownMonitor({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownMonitorMsg.text ? (
                <div className={`msg ${shutdownMonitorMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>{shutdownMonitorMsg.text}</div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>
                  {monitorOk === true ? 'Running (OK)' : monitorOk === false ? 'Unreachable' : 'Checking…'}
                </strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{monitorHealth?.monitor_port != null ? String(monitorHealth.monitor_port) : '–'}</dd>
                </div>
                <div>
                  <dt>Service</dt>
                  <dd>{monitorHealth?.service ?? '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${monitorEnvClass}`}>
                      {monitorHealth?.config_profile
                        ? PROFILE_LABELS[monitorHealth.config_profile] ?? monitorHealth.config_profile
                        : monitorOk === true
                          ? 'Custom'
                          : 'Unknown'}
                    </span>
                  </dd>
                </div>
                {monitorHealth?.ts ? (
                  <div>
                    <dt>Server time</dt>
                    <dd>{new Date(monitorHealth.ts * 1000).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
            </article>

            <article className="architecture-api-card" aria-labelledby="arch-card-ops">
              <div className="architecture-api-card-head">
                <h3 id="arch-card-ops" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${opsLamp}`} title="Ops API health" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </span>
                  Ops API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={opsStopDisabled}
                  title={opsStopTitle}
                  aria-label="Shut down Ops API"
                  onClick={() => setShutdownOps({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownOpsMsg.text ? (
                <div className={`msg ${shutdownOpsMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>{shutdownOpsMsg.text}</div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>{opsOk === true ? 'Running (OK)' : opsOk === false ? 'Unreachable' : 'Checking…'}</strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{opsHealth?.port != null ? String(opsHealth.port) : '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${opsEnvClass}`}>
                      {docsOpsProfileLabel(opsHealth?.config_profile ?? undefined, opsOk, opsHealth?.config_path)}
                    </span>
                  </dd>
                </div>
                {opsHealth?.config_path ? (
                  <div>
                    <dt>Config file</dt>
                    <dd className="architecture-api-card-path" title={opsHealth.config_path}>
                      {truncatePath(opsHealth.config_path)}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </article>

            <article className="architecture-api-card" aria-labelledby="arch-card-docs">
              <div className="architecture-api-card-head">
                <h3 id="arch-card-docs" className="architecture-api-card-title">
                  <span className={`title-inline-lamp lamp-icon ${docsLamp}`} title="Docs API health" aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                    </svg>
                  </span>
                  Docs API
                </h3>
                <button
                  type="button"
                  className="section-header-icon-btn architecture-api-card-action"
                  disabled={docsStopDisabled}
                  title={docsStopTitle}
                  aria-label="Shut down Docs API"
                  onClick={() => setShutdownDocs({ open: true, busy: false, error: null })}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {shutdownDocsMsg.text ? (
                <div className={`msg ${shutdownDocsMsg.isErr ? 'err' : 'ok'} architecture-card-msg`}>{shutdownDocsMsg.text}</div>
              ) : null}
              <p className="architecture-api-card-status">
                <strong>{docsOk === true ? 'Running (OK)' : docsOk === false ? 'Unreachable' : 'Checking…'}</strong>
              </p>
              <dl className="architecture-api-card-dl">
                <div>
                  <dt>Listen port</dt>
                  <dd>{docsHealth?.port != null ? String(docsHealth.port) : '–'}</dd>
                </div>
                <div>
                  <dt>Environment</dt>
                  <dd>
                    <span className={`massive-api-env-badge massive-api-env-badge--${docsEnvClass}`}>
                      {docsOpsProfileLabel(docsHealth?.config_profile ?? undefined, docsOk, docsHealth?.config_path)}
                    </span>
                  </dd>
                </div>
                {docsHealth?.config_path ? (
                  <div>
                    <dt>Config file</dt>
                    <dd className="architecture-api-card-path" title={docsHealth.config_path}>
                      {truncatePath(docsHealth.config_path)}
                    </dd>
                  </div>
                ) : null}
                {docsHealth?.ts ? (
                  <div>
                    <dt>Server time</dt>
                    <dd>{new Date(docsHealth.ts * 1000).toLocaleString()}</dd>
                  </div>
                ) : null}
              </dl>
            </article>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="arch-docs-table-head">
          <h3 id="arch-docs-table-head" className="page-title-with-tooltip architecture-section-title">
            Documentation
            <InfoTooltip text="Open Swagger UI, ReDoc, or OpenAPI JSON for each process. Override bases with VITE_API_BASE, VITE_DOCS_API_ORIGIN, and VITE_OPS_API_ORIGIN when the UI is served from a different origin." />
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
                  <th scope="row">Monitor</th>
                  <td className="architecture-docs-table-base">{monitorBase || '–'}</td>
                  <td>
                    {monitorBase ? (
                      <a href={`${monitorBase}/docs`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {monitorBase ? (
                      <a href={`${monitorBase}/redoc`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {monitorBase ? (
                      <a href={`${monitorBase}/openapi.json`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Ops</th>
                  <td className="architecture-docs-table-base">{opsBase || '–'}</td>
                  <td>
                    {opsBase ? (
                      <a href={`${opsBase}/ops/docs`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {opsBase ? (
                      <a href={`${opsBase}/ops/redoc`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                  <td>
                    {opsBase ? (
                      <a href={`${opsBase}/ops/openapi.json`} target="_blank" rel="noopener noreferrer" className="architecture-docs-link">
                        Open ↗
                      </a>
                    ) : (
                      '–'
                    )}
                  </td>
                </tr>
                <tr>
                  <th scope="row">Docs</th>
                  <td className="architecture-docs-table-base">{docsBase || '–'}</td>
                  <td>
                    {docsBase ? (
                      <a
                        href={`${docsBase}/research/docs/docs`}
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
                    {docsBase ? (
                      <a
                        href={`${docsBase}/research/docs/redoc`}
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
                  <td>—</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section className="replay-section" aria-labelledby="arch-console-head">
          <h3 id="arch-console-head" className="page-title-with-tooltip architecture-section-title">
            Application log
            <InfoTooltip text="Merged Redis stream logs from Monitor (bifrost:console:{profile}:api_monitor), Ops (bifrost:console:{profile}:api_ops), and Docs (bifrost:console:{profile}:api_docs). Use Source toggles to include or exclude each API (multi-select, all on by default). Clear removes all three streams." />
          </h3>
          <AggregatedLogConsolePanel
            controller={logConsole}
            loadingText="Connecting…"
            errorText="Unable to load logs (Redis may be down or Monitor API not running)."
            emptyText="No log lines yet. Start Monitor, Ops, and Docs API processes."
            infoTooltipText="Clear displayed text and truncates all three Redis log streams (Monitor, Ops, Docs)."
            resizeAriaLabel="Resize unified architecture console height"
            clearTitle="Clear all three log streams (Monitor, Ops, Docs)"
          />
        </section>

        <section className="replay-section architecture-api-details" aria-labelledby="arch-api-details-head">
          <h3 id="arch-api-details-head" className="page-title-with-tooltip architecture-section-title">
            API details
            <InfoTooltip text="Pick Monitor, Docs, or Ops to see configuration for that API: Monitor shows YAML sidecar ports from GET /health; Docs shows upstream OpenAPI URLs from Docs /health; Ops shows Main and Ops OpenAPI JSON endpoints." />
          </h3>
          <div className="architecture-detail-tabs" role="tablist" aria-label="API detail by service">
            <button
              type="button"
              role="tab"
              id="arch-tab-monitor"
              aria-selected={detailTab === 'monitor'}
              aria-controls="arch-detail-panel"
              tabIndex={detailTab === 'monitor' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'monitor' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('monitor')}
            >
              Monitor API
            </button>
            <button
              type="button"
              role="tab"
              id="arch-tab-docs"
              aria-selected={detailTab === 'docs'}
              aria-controls="arch-detail-panel"
              tabIndex={detailTab === 'docs' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'docs' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('docs')}
            >
              Docs API
            </button>
            <button
              type="button"
              role="tab"
              id="arch-tab-ops"
              aria-selected={detailTab === 'ops'}
              aria-controls="arch-detail-panel"
              tabIndex={detailTab === 'ops' ? 0 : -1}
              className={`architecture-detail-tab${detailTab === 'ops' ? ' architecture-detail-tab--active' : ''}`}
              onClick={() => setDetailTab('ops')}
            >
              Ops API
            </button>
          </div>
          <div
            id="arch-detail-panel"
            role="tabpanel"
            aria-labelledby={
              detailTab === 'monitor' ? 'arch-tab-monitor' : detailTab === 'docs' ? 'arch-tab-docs' : 'arch-tab-ops'
            }
            className="architecture-detail-tabpanel"
          >
            {detailTab === 'monitor' ? (
              <>
                <h4 className="architecture-detail-subhead">Sidecar ports (from YAML)</h4>
                <p className="architecture-detail-subhint">
                  From Monitor GET /health — listen ports declared in merged server config.
                </p>
                {monitorHealth ? (
                  <table className="massive-api-kv-table architecture-config-table">
                    <tbody>
                      <tr>
                        <td className="massive-api-kv-label">Massive API</td>
                        <td>{String(monitorHealth.massive_port ?? '–')}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Ops API</td>
                        <td>{String(monitorHealth.ops_port ?? '–')}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Docs API</td>
                        <td>{String(monitorHealth.docs_port ?? '–')}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Trading API</td>
                        <td>{String(monitorHealth.trading_port ?? '–')}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Strategy API</td>
                        <td>{String(monitorHealth.strategy_port ?? '–')}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Portfolio API</td>
                        <td>{String(monitorHealth.portfolio_port ?? '–')}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Market API</td>
                        <td>{String(monitorHealth.market_port ?? '–')}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Research API</td>
                        <td>{String(monitorHealth.research_port ?? '–')}</td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <p className="architecture-detail-empty">
                    No data yet. When Monitor API is reachable, GET /health returns YAML sidecar listen ports here.
                  </p>
                )}
              </>
            ) : null}
            {detailTab === 'ops' ? (
              <>
                <h4 className="architecture-detail-subhead">Main and Ops OpenAPI JSON</h4>
                <p className="architecture-detail-subhint">Resolved OpenAPI endpoints used by tooling.</p>
                <table className="massive-api-kv-table architecture-config-table">
                  <tbody>
                    <tr>
                      <td className="massive-api-kv-label">Main API</td>
                      <td className="massive-api-kv-path architecture-detail-url-cell">{joinServiceBase(mainApiBase, '/openapi.json')}</td>
                    </tr>
                    <tr>
                      <td className="massive-api-kv-label">Ops API</td>
                      <td className="massive-api-kv-path architecture-detail-url-cell">
                        {opsBase ? joinServiceBase(opsBase, '/ops/openapi.json') : '–'}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </>
            ) : null}
            {detailTab === 'docs' ? (
              <>
                <h4 className="architecture-detail-subhead">Upstream OpenAPI sources</h4>
                <p className="architecture-detail-subhint">URLs the Docs server uses to fetch and merge OpenAPI.</p>
                {docsHealth ? (
                  <table className="massive-api-kv-table architecture-config-table">
                    <tbody>
                      <tr>
                        <td className="massive-api-kv-label">Main API</td>
                        <td className="massive-api-kv-path architecture-detail-url-cell">{docsHealth.main_url || '–'}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Massive API</td>
                        <td className="massive-api-kv-path architecture-detail-url-cell">{docsHealth.massive_url || '–'}</td>
                      </tr>
                      <tr>
                        <td className="massive-api-kv-label">Research API</td>
                        <td className="massive-api-kv-path architecture-detail-url-cell">{docsHealth.research_url || '–'}</td>
                      </tr>
                    </tbody>
                  </table>
                ) : (
                  <p className="architecture-detail-empty">
                    No data yet. When Docs API is reachable, GET /health returns upstream OpenAPI source URLs here.
                  </p>
                )}
              </>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  )
}
