import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { fetchHealth } from '../api'
import { API_HEALTH_FETCH_TIMEOUT_MS } from '../api/shared/fetchTimeout'
import { postStop } from '../api/monitor/control'
import { postMonitorStop } from '../api/monitor/monitor'
import {
  fetchOpsWorkers,
  fetchOpsAudit,
  fetchOpsCapabilities,
  fetchQueueSummary,
  setOpsToken,
  type WorkerSummary,
  type BrokerStatus,
  type AuditEntry,
  type OpsCapabilities,
  type QueueSummaryRow,
} from '../api/ops/ops'
import {
  computeCeleryRuntimeLamp,
  supportedQueueNamesFromSummary,
} from '../utils/celeryRuntime'
import { normalizeUtilizedServices, type UtilizedServiceRow } from '../utils/utilizedServices'
import { ApiConfiguredRoutesSection } from './apiOverview/ApiConfiguredRoutesSection'

export interface DashboardPageProps {
  status?: StatusResponse | null
  loadStatus?: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
}

type LampColor = 'green' | 'yellow' | 'red' | 'none'

function fmtRelative(epochSec: number | null): string {
  if (epochSec == null) return '—'
  const delta = Date.now() / 1000 - epochSec
  if (delta < 0) return 'just now'
  if (delta < 60) return `${Math.floor(delta)}s ago`
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`
  return `${Math.floor(delta / 86400)}d ago`
}

function fmtTimestamp(epochSec: number): string {
  try {
    return new Date(epochSec * 1000).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return String(epochSec)
  }
}

type ConfirmDialogState = {
  open: boolean
  title: string
  message: string
  confirming: boolean
  action: (() => Promise<void>) | null
}

const INITIAL_CONFIRM: ConfirmDialogState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  action: null,
}

const AUDIT_PAGE_SIZES = [5, 10, 20, 50] as const
type AuditPageSize = (typeof AUDIT_PAGE_SIZES)[number]

// ── Audit helpers ────────────────────────────────────────────────────────────

function auditOutcomeBadge(outcome: string): { label: string; className: string } {
  switch (outcome) {
    case 'success': return { label: 'Success', className: 'dashboard-audit-badge--success' }
    case 'submitted': return { label: 'Submitted', className: 'dashboard-audit-badge--submitted' }
    case 'denied': return { label: 'Denied', className: 'dashboard-audit-badge--denied' }
    case 'rejected': return { label: 'Rejected', className: 'dashboard-audit-badge--rejected' }
    case 'failed': return { label: 'Failed', className: 'dashboard-audit-badge--failed' }
    case 'partial': return { label: 'Partial', className: 'dashboard-audit-badge--partial' }
    default: return { label: outcome, className: '' }
  }
}

// ── Component ────────────────────────────────────────────────────────────────

type ServiceId = 'daemon' | 'server'

interface ServiceAction {
  id: ServiceId
  label: string
  stopFn: () => Promise<{ ok?: boolean; error?: string }>
}

const SERVICE_ACTIONS: ServiceAction[] = [
  { id: 'daemon', label: 'Daemon', stopFn: postStop },
  { id: 'server', label: 'Server', stopFn: postMonitorStop },
]

export function DashboardPage({ status, loadStatus, embeddedInSettings }: DashboardPageProps) {
  const [workers, setWorkers] = useState<WorkerSummary[]>([])
  const [broker, setBroker] = useState<BrokerStatus | null>(null)
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [auditError, setAuditError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmState, setConfirmState] = useState<ConfirmDialogState>(INITIAL_CONFIRM)
  const [tick, setTick] = useState(0)
  const [auditFilter, setAuditFilter] = useState<'all' | 'success' | 'submitted' | 'denied' | 'rejected' | 'failed'>('all')
  const [auditPage, setAuditPage] = useState(1)
  const [auditPageSize, setAuditPageSize] = useState<AuditPageSize>(10)
  const [svcStopBusy, setSvcStopBusy] = useState<ServiceId | 'all' | null>(null)
  const [svcMsg, setSvcMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const svcMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [queueSummary, setQueueSummary] = useState<QueueSummaryRow[]>([])
  const [utilizedServices, setUtilizedServices] = useState<UtilizedServiceRow[]>([])

  // Auth / capabilities (audit + Ops identity)
  const [caps, setCaps] = useState<OpsCapabilities | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)

  /** Coalesce concurrent /ops/workers (Celery inspect) calls. */
  const workersRefreshPromiseRef = useRef<Promise<void> | null>(null)
  /** Coalesce Celery overview poll (workers + queue summary for Services card). */
  const celeryOverviewPromiseRef = useRef<Promise<void> | null>(null)

  const isAuthenticated = caps?.identity.authenticated ?? false
  const authRequired = caps?.auth_required ?? false
  const currentRole = caps?.identity.role ?? 'viewer'

  const loadCaps = useCallback(async () => {
    try {
      const res = await fetchOpsCapabilities()
      if (res.ok) setCaps(res)
    } catch { /* ignore */ }
  }, [])

  const refreshOpsWorkersSnapshot = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    if (workersRefreshPromiseRef.current) {
      return workersRefreshPromiseRef.current
    }
    const run = (async () => {
      try {
        const wRes = await fetchOpsWorkers({ forceRefresh: opts?.forceRefresh })
        if (wRes.ok) {
          setWorkers(wRes.workers)
          setBroker(wRes.broker)
        }
      } catch {
        /* workers snapshot optional */
      }
    })()
    const tracked = run.finally(() => {
      workersRefreshPromiseRef.current = null
    })
    workersRefreshPromiseRef.current = tracked
    return tracked
  }, [])

  /** Queue summary + Celery inspect snapshot for Services card (no worker/broker control UI here). */
  const loadCeleryOverview = useCallback(async () => {
    if (celeryOverviewPromiseRef.current) return celeryOverviewPromiseRef.current
    const run = (async () => {
      try {
        const qRes = await fetchQueueSummary().catch(() => ({
          ok: false as const,
          queues: [] as QueueSummaryRow[],
        }))
        if (qRes.ok) setQueueSummary(qRes.queues)
        else setQueueSummary([])
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load Celery overview')
      } finally {
        setLoading(false)
      }
      void refreshOpsWorkersSnapshot()
    })()
    const tracked = run.finally(() => {
      celeryOverviewPromiseRef.current = null
    })
    celeryOverviewPromiseRef.current = tracked
    return tracked
  }, [refreshOpsWorkersSnapshot])

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetchOpsAudit(500)
      if (res.ok) {
        setAuditEntries(res.entries)
        setAuditError(null)
      } else {
        setAuditError(res.error ?? 'Failed to load audit')
        setAuditEntries([])
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Audit unavailable'
      if (msg.includes('403') || msg.includes('Insufficient')) {
        setAuditError('Requires admin role to view audit log.')
      } else {
        setAuditError(msg)
      }
      setAuditEntries([])
    }
  }, [])

  useEffect(() => {
    loadCaps()
    void loadCeleryOverview()
    loadAudit()
    const t = setInterval(() => {
      void loadCeleryOverview()
      loadAudit()
    }, 5000)
    const capsTimer = setInterval(loadCaps, 30000)
    const tickTimer = setInterval(() => setTick(n => n + 1), 1000)
    return () => {
      clearInterval(t)
      clearInterval(capsTimer)
      clearInterval(tickTimer)
    }
  }, [loadCeleryOverview, loadAudit, loadCaps])

  const handleLogin = useCallback(() => {
    setOpsToken(tokenInput.trim())
    setTokenInput('')
    setAuthPanelOpen(false)
    loadCaps()
    void loadCeleryOverview()
    loadAudit()
  }, [tokenInput, loadCaps, loadCeleryOverview, loadAudit])

  const handleLogout = useCallback(() => {
    setOpsToken('')
    setAuthPanelOpen(false)
    loadCaps()
  }, [loadCaps])

  void tick

  useEffect(() => {
    return () => {
      if (svcMsgTimerRef.current) clearTimeout(svcMsgTimerRef.current)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    const loadUtilized = () => {
      fetchHealth({ timeoutMs: API_HEALTH_FETCH_TIMEOUT_MS })
        .then((h) => {
          if (!cancelled) setUtilizedServices(normalizeUtilizedServices(h.utilized_services))
        })
        .catch(() => {
          if (!cancelled) setUtilizedServices([])
        })
    }
    loadUtilized()
    const t = window.setInterval(loadUtilized, 20000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [])

  const showSvcMsg = (text: string, isErr: boolean, autoHideMs = 5000) => {
    setSvcMsg({ text, isErr })
    if (svcMsgTimerRef.current) clearTimeout(svcMsgTimerRef.current)
    svcMsgTimerRef.current = setTimeout(() => setSvcMsg({ text: '', isErr: false }), autoHideMs)
  }

  const stopService = async (svc: ServiceAction) => {
    setSvcStopBusy(svc.id)
    showSvcMsg(`Stopping ${svc.label}…`, false, 15000)
    try {
      const res = await svc.stopFn()
      if (res.ok !== false) {
        showSvcMsg(`${svc.label} stop sent.`, false)
      } else {
        showSvcMsg(`${svc.label}: ${res.error ?? 'failed'}`, true)
      }
      if (loadStatus) setTimeout(() => loadStatus(), 1500)
    } catch (e) {
      showSvcMsg(e instanceof Error ? e.message : 'Stop failed', true)
    } finally {
      setSvcStopBusy(null)
    }
  }

  const shutdownAll = async () => {
    setSvcStopBusy('all')
    const errors: string[] = []
    for (const svc of SERVICE_ACTIONS) {
      showSvcMsg(`Stopping ${svc.label}…`, false, 30000)
      try {
        const res = await svc.stopFn()
        if (res.ok === false) errors.push(`${svc.label}: ${res.error ?? 'failed'}`)
      } catch (e) {
        errors.push(`${svc.label}: ${e instanceof Error ? e.message : 'error'}`)
      }
    }
    showSvcMsg(
      errors.length === 0
        ? 'All services stopped.'
        : `Shutdown completed with errors: ${errors.join('; ')}`,
      errors.length > 0,
    )
    setSvcStopBusy(null)
    if (loadStatus) setTimeout(() => loadStatus(), 2000)
  }

  const onStopServiceClick = (svc: ServiceAction) => {
    setConfirmState({
      open: true,
      title: `Stop ${svc.label}?`,
      message: svc.id === 'server'
        ? `This will stop the ${svc.label} process. The UI will become unresponsive until it restarts.`
        : `This will stop the ${svc.label} process.`,
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        await stopService(svc)
        setConfirmState(INITIAL_CONFIRM)
      },
    })
  }

  const onShutdownAllClick = () => {
    setConfirmState({
      open: true,
      title: 'Shutdown entire system?',
      message: 'Daemon, then Server (management monitor) will be stopped in order. This cannot be undone.',
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        await shutdownAll()
        setConfirmState(INITIAL_CONFIRM)
      },
    })
  }

  const hb = status?.daemon_heartbeat
  const daemonLamp: LampColor = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  const serverLamp: LampColor = status?.monitor_lamp ? (status.monitor_lamp as LampColor) : 'red'

  const supportedCeleryQueueNames = supportedQueueNamesFromSummary(queueSummary)
  const runtimeCeleryLamp: LampColor = computeCeleryRuntimeLamp(
    broker?.connected === true,
    workers,
    supportedCeleryQueueNames,
  )
  const overallLamp: LampColor = (() => {
    const d = daemonLamp === 'none' ? 'red' : daemonLamp
    const triple: LampColor[] = [d, serverLamp, runtimeCeleryLamp]
    if (triple.some(l => l === 'red')) return 'red'
    if (triple.some(l => l === 'yellow')) return 'yellow'
    if (triple.every(l => l === 'green')) return 'green'
    return 'none'
  })()

  const filteredAudit = auditEntries.filter(e => {
    if (auditFilter === 'all') return true
    return e.outcome === auditFilter
  })

  useEffect(() => {
    setAuditPage(1)
  }, [auditFilter])

  useEffect(() => {
    const n = filteredAudit.length
    const maxPage = Math.max(1, Math.ceil(n / auditPageSize) || 1)
    if (auditPage > maxPage) setAuditPage(maxPage)
  }, [auditPage, auditPageSize, filteredAudit.length])

  const auditTotalFiltered = filteredAudit.length
  const auditTotalPages = Math.max(1, Math.ceil(auditTotalFiltered / auditPageSize) || 1)
  const auditRangeStart = auditTotalFiltered === 0 ? 0 : (auditPage - 1) * auditPageSize + 1
  const auditRangeEnd = Math.min(auditPage * auditPageSize, auditTotalFiltered)
  const paginatedAudit = filteredAudit.slice(
    (auditPage - 1) * auditPageSize,
    (auditPage - 1) * auditPageSize + auditPageSize,
  )

  const hasAuditPermission = auditError == null || (!auditError.includes('admin') && !auditError.includes('403'))

  return (
    <div className={`settings-page-card ${embeddedInSettings ? 'dashboard-page dashboard-page--embedded' : 'dashboard-page'}`}>
      {/* Confirm dialog */}
      {confirmState.open && (
        <div
          className="data-reset-modal-overlay"
          onClick={() => !confirmState.confirming && setConfirmState(INITIAL_CONFIRM)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="dashboard-confirm-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="dashboard-confirm-title">{confirmState.title}</h3>
            <p>{confirmState.message}</p>
            <div className="data-reset-modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setConfirmState(INITIAL_CONFIRM)}
                disabled={confirmState.confirming}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn-shutdown-all"
                onClick={() => confirmState.action?.()}
                disabled={confirmState.confirming}
              >
                {confirmState.confirming ? 'Executing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="settings-page-header">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title">
            <span className={`title-inline-lamp lamp-icon ${overallLamp}`} title="Services and Celery summary status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </span>
            Dashboard
            <InfoTooltip text="Stop Daemon or Server, view service and Celery summary, and browse the Ops audit log. Celery consoles and scaling live on the Celery page." />
          </h2>
          <p className="settings-page-subtitle">
            Service controls, high-level Celery status, and audit trail.
          </p>
        </div>
      </div>

      {/* ── Auth bar ── */}
      <div className="dashboard-auth-bar">
        <div className="dashboard-auth-info">
          <span className={`dashboard-auth-role dashboard-auth-role--${currentRole}`}>
            {currentRole.toUpperCase()}
          </span>
          {caps?.identity.name && caps.identity.name !== 'anonymous' && (
            <span className="dashboard-auth-name">{caps.identity.name}</span>
          )}
          {isAuthenticated && (
            <span className="dashboard-auth-badge">Authenticated</span>
          )}
          {authRequired && !isAuthenticated && (
            <span className="dashboard-auth-badge dashboard-auth-badge--warn">Token required for control actions</span>
          )}
        </div>
        <div className="dashboard-auth-actions">
          {isAuthenticated ? (
            <button type="button" className="dashboard-console-btn" onClick={handleLogout}>
              Sign out
            </button>
          ) : (
            <button
              type="button"
              className="dashboard-console-btn"
              onClick={() => setAuthPanelOpen(!authPanelOpen)}
            >
              Authenticate
            </button>
          )}
        </div>
        {authPanelOpen && !isAuthenticated && (
          <div className="dashboard-auth-panel">
            <input
              type="password"
              className="dashboard-ctrl-input"
              placeholder="Ops API token…"
              value={tokenInput}
              onChange={e => setTokenInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && tokenInput.trim()) handleLogin() }}
              autoFocus
            />
            <button
              type="button"
              className="btn-resume dashboard-btn dashboard-btn--start"
              onClick={handleLogin}
              disabled={!tokenInput.trim()}
            >
              Connect
            </button>
          </div>
        )}
      </div>

      {error ? (
        <div className="dashboard-inline-alert msg err" role="status">
          {error}. Keep previous data on screen; retrying in next poll cycle.
        </div>
      ) : null}
      <div className="dashboard-grid settings-page-groups">
          {/* ── Services Overview ──────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-services" aria-labelledby="dashboard-svc-head">
            <div className="dashboard-section-header-row">
              <h3 id="dashboard-svc-head" className="page-title-with-tooltip">
                Services
                <InfoTooltip text="Unified view of services. Stop Daemon or Server, or shut down both in order." />
              </h3>
              <div className="dashboard-svc-actions-row">
                {svcMsg.text && (
                  <span className={`settings-page-msg ${svcMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{svcMsg.text}</span>
                )}
                <button
                  type="button"
                  className="btn-shutdown-all dashboard-btn dashboard-shutdown-all-btn"
                  onClick={onShutdownAllClick}
                  disabled={!!svcStopBusy}
                  title="Shutdown Daemon then Server"
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                    <line x1="12" y1="2" x2="12" y2="12" />
                  </svg>
                  {svcStopBusy === 'all' ? 'Shutting down…' : 'Shutdown All'}
                </button>
              </div>
            </div>
            <div className="dashboard-svc-grid">
              {/* Daemon */}
              <div className="dashboard-svc-card">
                <div className="dashboard-svc-card-header">
                  <span className={`title-inline-lamp lamp-icon ${daemonLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden><path d="M8 5v14l11-7L8 5z" /></svg>
                  </span>
                  <strong>Daemon</strong>
                  <span className={`dashboard-svc-status dashboard-svc-status--${daemonLamp}`}>
                    {hb?.daemon_alive ? 'Running' : 'Stopped'}
                  </span>
                </div>
                <div className="dashboard-svc-card-meta">
                  {hb?.daemon_alive && hb?.last_ts != null && <span>Heartbeat: {fmtRelative(hb.last_ts)}</span>}
                  {hb?.ib_connected != null && <span>IB: {hb.ib_connected ? 'Connected' : 'Disconnected'}</span>}
                  {status?.trading_suspended != null && <span>Trading: {status.trading_suspended ? 'Suspended' : 'Active'}</span>}
                </div>
                <button
                  type="button"
                  className="dashboard-svc-stop-btn"
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[0])}
                  disabled={!!svcStopBusy}
                  title="Stop daemon process"
                >
                  {svcStopBusy === 'daemon' ? 'Stopping…' : 'Stop'}
                </button>
              </div>

              {/* Server */}
              <div className="dashboard-svc-card">
                <div className="dashboard-svc-card-header">
                  <span className={`title-inline-lamp lamp-icon ${serverLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
                      <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                      <circle cx="6" cy="6" r="1" fill="currentColor" strokeWidth="0" />
                      <circle cx="6" cy="18" r="1" fill="currentColor" strokeWidth="0" />
                    </svg>
                  </span>
                  <strong>Server</strong>
                  <span className={`dashboard-svc-status dashboard-svc-status--${serverLamp}`}>
                    {serverLamp === 'green' ? 'Running' : serverLamp === 'yellow' ? 'Degraded' : 'Down'}
                  </span>
                </div>
                <div className="dashboard-svc-card-meta">
                  {status?.monitor_enabled != null && <span>Monitor: {status.monitor_enabled ? 'Enabled' : 'Disabled'}</span>}
                </div>
                <button
                  type="button"
                  className="dashboard-svc-stop-btn"
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[1])}
                  disabled={!!svcStopBusy}
                  title="Stop server process"
                >
                  {svcStopBusy === 'server' ? 'Stopping…' : 'Stop'}
                </button>
              </div>

              {/* Celery */}
              <div className="dashboard-svc-card">
                <div className="dashboard-svc-card-header">
                  <span className={`title-inline-lamp lamp-icon ${runtimeCeleryLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                  </span>
                  <strong>Celery</strong>
                  <span className={`dashboard-svc-status dashboard-svc-status--${runtimeCeleryLamp}`}>
                    {runtimeCeleryLamp === 'green'
                      ? 'Ready'
                      : runtimeCeleryLamp === 'yellow'
                        ? 'Incomplete'
                        : 'Down'}
                  </span>
                </div>
                <div className="dashboard-svc-card-meta">
                  <span>Broker: {broker?.connected ? 'Connected' : 'Disconnected'}</span>
                  <span>Inspect workers: {workers.length}</span>
                  <span>
                    <a href="#settings-celery" className="dashboard-svc-card-detail-link">
                      Open Celery control
                    </a>
                  </span>
                </div>
              </div>
            </div>
          </section>

          {/* ── API configured routes (same block as Services Overview) ── */}
          <section className="replay-section dashboard-section dashboard-api-routes" aria-labelledby="dashboard-api-head">
            <div className="api-overview-api-scope api-overview-api-scope--dashboard" aria-labelledby="dashboard-api-head">
              <h3 id="dashboard-api-head" className="api-overview-scope-title page-title-with-tooltip">
                API
                <InfoTooltip text="Routing from GET /health utilized.services (same as Services Overview). Shows which stack (dev vs prod) each service key uses." />
              </h3>
              <ApiConfiguredRoutesSection
                utilizedServices={utilizedServices}
                configuredHeadingId="dashboard-configured-routes-head"
              />
            </div>
          </section>

          {/* ── Audit Trail ──────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-audit" aria-labelledby="dashboard-audit-head">
            <div className="dashboard-section-header-row">
              <h3 id="dashboard-audit-head" className="page-title-with-tooltip">
                Audit Trail
                <InfoTooltip text="Audit log of all control-plane actions. Requires admin role. Records operator, IP, action, and outcome." />
              </h3>
              {hasAuditPermission && (
                <div className="dashboard-filter-row">
                  {(['all', 'success', 'submitted', 'denied', 'rejected', 'failed'] as const).map(f => (
                    <button
                      key={f}
                      type="button"
                      className={`dashboard-filter-btn ${auditFilter === f ? 'active' : ''}`}
                      onClick={() => setAuditFilter(f)}
                    >
                      {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {loading && auditEntries.length === 0 && !auditError ? (
              <div className="dashboard-empty">Loading audit trail…</div>
            ) : auditError ? (
              <div className="dashboard-audit-permission-notice">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span>{auditError}</span>
              </div>
            ) : filteredAudit.length === 0 ? (
              <div className="dashboard-empty">
                {auditEntries.length === 0
                  ? 'No audit entries yet.'
                  : 'No entries match the current filter.'}
              </div>
            ) : (
              <>
                <div className="dashboard-audit-pagination-bar" role="navigation" aria-label="Audit log pagination">
                  <label className="dashboard-audit-page-size">
                    <span className="dashboard-audit-page-size-label">Rows per page</span>
                    <select
                      className="dashboard-ctrl-input dashboard-audit-page-size-select"
                      value={auditPageSize}
                      onChange={e => {
                        const v = Number(e.target.value) as AuditPageSize
                        setAuditPageSize(v)
                        setAuditPage(1)
                      }}
                      aria-label="Rows per page"
                    >
                      {AUDIT_PAGE_SIZES.map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </label>
                  <span className="dashboard-audit-page-info">
                    {auditTotalFiltered === 0
                      ? '0 entries'
                      : `Showing ${auditRangeStart}–${auditRangeEnd} of ${auditTotalFiltered}`}
                  </span>
                  <div className="dashboard-audit-page-nav">
                    <button
                      type="button"
                      className="dashboard-console-btn"
                      disabled={auditPage <= 1}
                      onClick={() => setAuditPage(p => Math.max(1, p - 1))}
                      aria-label="Previous page"
                    >
                      Previous
                    </button>
                    <span className="dashboard-audit-page-of" aria-live="polite">
                      Page {auditTotalFiltered === 0 ? 0 : auditPage} of {auditTotalFiltered === 0 ? 0 : auditTotalPages}
                    </span>
                    <button
                      type="button"
                      className="dashboard-console-btn"
                      disabled={auditPage >= auditTotalPages || auditTotalFiltered === 0}
                      onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))}
                      aria-label="Next page"
                    >
                      Next
                    </button>
                  </div>
                </div>
                <div className="dashboard-cmd-table-wrap">
                  <table className="table-operations dashboard-audit-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>Operator</th>
                        <th>Action</th>
                        <th>Target</th>
                        <th>Outcome</th>
                        <th>Source IP</th>
                        <th>Detail</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedAudit.map((entry, i) => {
                        const badge = auditOutcomeBadge(entry.outcome)
                        return (
                          <tr key={`${entry.timestamp}-${auditPage}-${i}`}>
                            <td>{fmtTimestamp(entry.timestamp)}</td>
                            <td>{entry.operator}</td>
                            <td>{entry.action}</td>
                            <td title={entry.target}>{entry.target}</td>
                            <td><span className={`dashboard-audit-badge ${badge.className}`}>{badge.label}</span></td>
                            <td>{entry.source_ip ?? '—'}</td>
                            <td className="dashboard-audit-detail-cell" title={entry.detail ?? ''}>{entry.detail || '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        </div>
    </div>
  )
}
