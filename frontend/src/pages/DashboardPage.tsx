import { useCallback, useEffect, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { postStop } from '../api/control'
import { postMonitorStop, postCeleryStop } from '../api/monitor'
import {
  fetchOpsWorkers,
  fetchOpsCommands,
  submitOpsCommand,
  pollOpsCommand,
  fetchOpsAudit,
  fetchOpsCapabilities,
  updateWorkerQueues,
  scaleWorker,
  fetchWorkerInstances,
  fetchWorkerProfiles,
  fetchBrokerStatusExtended,
  controlBroker,
  workerConsoleUrl,
  brokerConsoleUrl,
  setOpsToken,
  type WorkerSummary,
  type BrokerStatus,
  type CommandRecord,
  type CommandAction,
  type AuditEntry,
  type SystemdInstance,
  type ExtendedBrokerStatus,
  type BrokerAction,
  type OpsCapabilities,
  type WorkerProfileInfo,
} from '../api/ops'

export interface DashboardPageProps {
  status?: StatusResponse | null
  loadStatus?: () => Promise<StatusResponse | null>
  embeddedInSettings?: boolean
}

type LampColor = 'green' | 'yellow' | 'red' | 'none'

function workerLamp(status: string): LampColor {
  if (status === 'running_healthy') return 'green'
  if (status === 'running_degraded' || status === 'starting' || status === 'stopping') return 'yellow'
  if (status === 'stopped' || status === 'failed') return 'red'
  return 'none'
}

function workerStatusLabel(status: string): string {
  const map: Record<string, string> = {
    running_healthy: 'Healthy',
    running_degraded: 'Degraded',
    starting: 'Starting',
    stopping: 'Stopping',
    stopped: 'Stopped',
    failed: 'Failed',
    unknown: 'Unknown',
  }
  return map[status] ?? status
}

function commandStatusBadge(status: string): { label: string; className: string } {
  const map: Record<string, { label: string; className: string }> = {
    queued: { label: 'Queued', className: 'dashboard-cmd-badge--queued' },
    running: { label: 'Running', className: 'dashboard-cmd-badge--running' },
    succeeded: { label: 'Succeeded', className: 'dashboard-cmd-badge--succeeded' },
    failed: { label: 'Failed', className: 'dashboard-cmd-badge--failed' },
    timeout: { label: 'Timeout', className: 'dashboard-cmd-badge--timeout' },
  }
  return map[status] ?? { label: status, className: '' }
}

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

// \u2500\u2500 Log Console (SSE) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function LogConsole({ url, maxLines = 500 }: { url: string; maxLines?: number }) {
  const [lines, setLines] = useState<string[]>([])
  const [connected, setConnected] = useState(false)
  const [paused, setPaused] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const esRef = useRef<EventSource | null>(null)
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    if (!url) return
    const es = new EventSource(url)
    esRef.current = es
    es.onopen = () => setConnected(true)
    es.onmessage = (ev) => {
      setLines(prev => {
        const next = [...prev, ev.data]
        return next.length > maxLines ? next.slice(next.length - maxLines) : next
      })
    }
    es.onerror = () => setConnected(false)
    return () => { es.close(); esRef.current = null }
  }, [url, maxLines])

  useEffect(() => {
    if (!paused && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines, paused])

  return (
    <div className="dashboard-console">
      <div className="dashboard-console-toolbar">
        <span className={`dashboard-console-status ${connected ? 'connected' : 'disconnected'}`}>
          {connected ? 'Live' : 'Disconnected'}
        </span>
        <span className="dashboard-console-line-count">{lines.length} lines</span>
        <button
          type="button"
          className={`dashboard-console-btn ${paused ? 'active' : ''}`}
          onClick={() => setPaused(p => !p)}
          title={paused ? 'Resume auto-scroll' : 'Pause auto-scroll'}
        >
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          type="button"
          className="dashboard-console-btn"
          onClick={() => setLines([])}
          title="Clear console"
        >
          Clear
        </button>
      </div>
      <pre className="dashboard-console-output">
        {lines.length === 0 ? (
          <span className="dashboard-console-placeholder">Waiting for log output…</span>
        ) : (
          lines.map((l, i) => <span key={i} className="dashboard-console-line">{l}{'\n'}</span>)
        )}
        <div ref={bottomRef} />
      </pre>
    </div>
  )
}

// ── Component ────────────────────────────────────────────────────────────────

type ServiceId = 'daemon' | 'server' | 'celery'

interface ServiceAction {
  id: ServiceId
  label: string
  stopFn: () => Promise<{ ok?: boolean; error?: string }>
}

const SERVICE_ACTIONS: ServiceAction[] = [
  { id: 'celery', label: 'Celery', stopFn: postCeleryStop },
  { id: 'daemon', label: 'Daemon', stopFn: postStop },
  { id: 'server', label: 'Server', stopFn: postMonitorStop },
]

export function DashboardPage({ status, loadStatus, embeddedInSettings }: DashboardPageProps) {
  const [workers, setWorkers] = useState<WorkerSummary[]>([])
  const [broker, setBroker] = useState<BrokerStatus | null>(null)
  const [commands, setCommands] = useState<CommandRecord[]>([])
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([])
  const [auditError, setAuditError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedWorker, setSelectedWorker] = useState<string>('')
  const [reason, setReason] = useState('')
  const [inflightCmd, setInflightCmd] = useState<string | null>(null)
  const [ctrlMsg, setCtrlMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const [confirmState, setConfirmState] = useState<ConfirmDialogState>(INITIAL_CONFIRM)
  const [expandedCmdId, setExpandedCmdId] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [cmdFilter, setCmdFilter] = useState<'all' | CommandAction | 'failed'>('all')
  const [auditFilter, setAuditFilter] = useState<'all' | 'success' | 'submitted' | 'denied' | 'rejected' | 'failed'>('all')
  const [svcStopBusy, setSvcStopBusy] = useState<ServiceId | 'all' | null>(null)
  const [svcMsg, setSvcMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })
  const pollCancelRef = useRef(false)
  const ctrlMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const svcMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Queue binding
  const [queueAddInput, setQueueAddInput] = useState('')
  const [queueBusy, setQueueBusy] = useState(false)
  const [queueMsg, setQueueMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })

  // Worker scaling
  const [instances, setInstances] = useState<SystemdInstance[]>([])
  const [workerProfiles, setWorkerProfiles] = useState<WorkerProfileInfo[]>([])
  const [scaleWorkerType, setScaleWorkerType] = useState('')
  const [scaleBusy, setScaleBusy] = useState(false)
  const [scaleMsg, setScaleMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })

  // Broker control
  const [extBroker, setExtBroker] = useState<ExtendedBrokerStatus | null>(null)
  const [brokerBusy, setBrokerBusy] = useState(false)
  const [brokerMsg, setBrokerMsg] = useState<{ text: string; isErr: boolean }>({ text: '', isErr: false })

  // Console panel
  type ConsoleTarget = 'none' | 'broker' | string
  const [consoleTarget, setConsoleTarget] = useState<ConsoleTarget>('none')
  const [consoleUrl, setConsoleUrl] = useState('')

  // Auth / capabilities
  const [caps, setCaps] = useState<OpsCapabilities | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)

  const canOperate = caps?.capabilities.can_operate ?? false
  const canAdmin = caps?.capabilities.can_admin ?? false
  const isAuthenticated = caps?.identity.authenticated ?? false
  const authRequired = caps?.auth_required ?? false
  const currentRole = caps?.identity.role ?? 'viewer'

  const loadCaps = useCallback(async () => {
    try {
      const res = await fetchOpsCapabilities()
      if (res.ok) setCaps(res)
    } catch { /* ignore */ }
  }, [])

  const loadAll = useCallback(async () => {
    try {
      const [wRes, cRes, iRes, bRes, pRes] = await Promise.all([
        fetchOpsWorkers(),
        fetchOpsCommands(30),
        fetchWorkerInstances().catch(() => ({ ok: false, instances: [] as SystemdInstance[], count: 0 })),
        fetchBrokerStatusExtended().catch(() => null),
        fetchWorkerProfiles().catch(() => ({ ok: false, profiles: [] as WorkerProfileInfo[], count: 0 })),
      ])
      if (wRes.ok) {
        setWorkers(wRes.workers)
        setBroker(wRes.broker)
        if (!selectedWorker && wRes.workers.length > 0) {
          setSelectedWorker(wRes.workers[0].worker_id)
        }
      }
      if (cRes.ok) setCommands(cRes.commands)
      if (iRes.ok) setInstances(iRes.instances)
      if (bRes?.ok) setExtBroker(bRes.broker)
      if (pRes.ok && pRes.profiles.length > 0) {
        setWorkerProfiles(pRes.profiles)
        setScaleWorkerType(prev => prev || pRes.profiles[0].key)
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard data')
    } finally {
      setLoading(false)
    }
  }, [selectedWorker])

  const loadAudit = useCallback(async () => {
    try {
      const res = await fetchOpsAudit(50)
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
    loadAll()
    loadAudit()
    const t = setInterval(() => {
      loadAll()
      loadAudit()
    }, 5000)
    const capsTimer = setInterval(loadCaps, 30000)
    const tickTimer = setInterval(() => setTick(n => n + 1), 1000)
    return () => {
      clearInterval(t)
      clearInterval(capsTimer)
      clearInterval(tickTimer)
    }
  }, [loadAll, loadAudit, loadCaps])

  const handleLogin = useCallback(() => {
    setOpsToken(tokenInput.trim())
    setTokenInput('')
    setAuthPanelOpen(false)
    loadCaps()
    loadAll()
    loadAudit()
  }, [tokenInput, loadCaps, loadAll, loadAudit])

  const handleLogout = useCallback(() => {
    setOpsToken('')
    setAuthPanelOpen(false)
    loadCaps()
  }, [loadCaps])

  void tick

  useEffect(() => {
    return () => {
      pollCancelRef.current = true
      if (ctrlMsgTimerRef.current) clearTimeout(ctrlMsgTimerRef.current)
      if (svcMsgTimerRef.current) clearTimeout(svcMsgTimerRef.current)
    }
  }, [])

  const showCtrlMsg = (text: string, isErr: boolean, autoHideMs = 5000) => {
    setCtrlMsg({ text, isErr })
    if (ctrlMsgTimerRef.current) clearTimeout(ctrlMsgTimerRef.current)
    ctrlMsgTimerRef.current = setTimeout(() => setCtrlMsg({ text: '', isErr: false }), autoHideMs)
  }

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
      message: 'Celery, then Daemon, then Server will be stopped in order. This cannot be undone.',
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        await shutdownAll()
        setConfirmState(INITIAL_CONFIRM)
      },
    })
  }

  const executeCommand = async (action: CommandAction) => {
    if (!selectedWorker) {
      showCtrlMsg('Select a worker first.', true)
      return
    }
    setInflightCmd(action)
    showCtrlMsg(`Sending ${action} command…`, false, 30000)
    pollCancelRef.current = false
    try {
      const res = await submitOpsCommand({
        action,
        target_id: selectedWorker,
        reason: reason.trim() || undefined,
      })
      if (!res.ok) {
        showCtrlMsg(res.error ?? `${action} failed`, true)
        setInflightCmd(null)
        return
      }
      const cmdId = res.command?.command_id
      if (!cmdId) {
        showCtrlMsg('Command submitted but no ID returned.', true)
        setInflightCmd(null)
        return
      }
      showCtrlMsg(`Command accepted, tracking…`, false, 60000)
      try {
        const final = await pollOpsCommand(cmdId, { intervalMs: 1500, timeoutMs: 45000 })
        if (pollCancelRef.current) return
        if (final.status === 'succeeded') {
          showCtrlMsg(`${action} succeeded.`, false)
        } else {
          showCtrlMsg(`${action} ${final.status}: ${final.error ?? 'unknown error'}`, true)
        }
      } catch {
        if (!pollCancelRef.current) showCtrlMsg('Command sent; poll timed out — check status.', true)
      }
      await loadAll()
      await loadAudit()
      setReason('')
    } catch (e) {
      showCtrlMsg(e instanceof Error ? e.message : 'Network error', true)
    } finally {
      setInflightCmd(null)
    }
  }

  const onActionClick = (action: CommandAction) => {
    if (action === 'start') {
      executeCommand(action)
      return
    }
    setConfirmState({
      open: true,
      title: action === 'stop' ? 'Stop worker?' : 'Restart worker?',
      message:
        action === 'stop'
          ? `This will stop worker "${selectedWorker}". Running tasks will be interrupted.`
          : `This will restart worker "${selectedWorker}". There will be brief downtime.`,
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        await executeCommand(action)
        setConfirmState(INITIAL_CONFIRM)
      },
    })
  }

  // ── Queue binding handlers ──────────────────────────────────────────────
  const onAddQueue = async () => {
    const q = queueAddInput.trim()
    if (!q || !selectedWorker) return
    setQueueBusy(true)
    try {
      const res = await updateWorkerQueues(selectedWorker, { add: [q] })
      if (res.ok) {
        setQueueMsg({ text: `Added queue "${q}"`, isErr: false })
        setQueueAddInput('')
        await loadAll()
      } else {
        setQueueMsg({ text: res.error ?? 'Failed', isErr: true })
      }
    } catch (e) {
      setQueueMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setQueueBusy(false)
    }
  }

  const onRemoveQueue = async (q: string) => {
    if (!selectedWorker) return
    setQueueBusy(true)
    try {
      const res = await updateWorkerQueues(selectedWorker, { remove: [q] })
      if (res.ok) {
        setQueueMsg({ text: `Removed queue "${q}"`, isErr: false })
        await loadAll()
      } else {
        setQueueMsg({ text: res.error ?? 'Failed', isErr: true })
      }
    } catch (e) {
      setQueueMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setQueueBusy(false)
    }
  }

  // ── Scaling handlers ──────────────────────────────────────────────────
  const onScaleRemove = async (instanceId: string) => {
    setConfirmState({
      open: true,
      title: `Remove worker instance ${instanceId}?`,
      message: `This will stop bifrost-celery-worker@${instanceId}.service via systemd.`,
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        setScaleBusy(true)
        try {
          openConsole(instanceId)
          const res = await scaleWorker({ action: 'remove', instance_id: instanceId })
          setScaleMsg({ text: res.ok ? `Instance ${instanceId} removed` : (res.error ?? 'Failed'), isErr: !res.ok })
          await loadAll()
        } catch (e) {
          setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
        } finally {
          setScaleBusy(false)
          setConfirmState(INITIAL_CONFIRM)
        }
      },
    })
  }

  const onScaleAdd = async () => {
    if (!scaleWorkerType) {
      setScaleMsg({ text: 'Select a worker type', isErr: true })
      return
    }
    setScaleBusy(true)
    try {
      const res = await scaleWorker({ action: 'add', worker_type: scaleWorkerType })
      if (res.ok) {
        const iid = res.instance_id ?? res.unit ?? scaleWorkerType
        openConsole(iid)
        setScaleMsg({ text: `Instance ${iid} started (${scaleWorkerType})`, isErr: false })
        await loadAll()
      } else {
        setScaleMsg({ text: res.error ?? 'Failed', isErr: true })
      }
    } catch (e) {
      setScaleMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setScaleBusy(false)
    }
  }

  // ── Broker control handlers ───────────────────────────────────────────
  const onBrokerAction = async (action: BrokerAction) => {
    if (action === 'stop') {
      setConfirmState({
        open: true,
        title: 'Stop Redis broker?',
        message: 'Stopping the broker will disconnect all workers and halt task processing.',
        confirming: false,
        action: async () => {
          setConfirmState(prev => ({ ...prev, confirming: true }))
          setBrokerBusy(true)
          try {
            const res = await controlBroker(action)
            setBrokerMsg({ text: res.ok ? 'Broker stopped' : (res.error ?? 'Failed'), isErr: !res.ok })
            await loadAll()
          } catch (e) {
            setBrokerMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
          } finally {
            setBrokerBusy(false)
            setConfirmState(INITIAL_CONFIRM)
          }
        },
      })
      return
    }
    setBrokerBusy(true)
    try {
      const res = await controlBroker(action)
      setBrokerMsg({ text: res.ok ? `Broker ${action} sent` : (res.error ?? 'Failed'), isErr: !res.ok })
      await loadAll()
    } catch (e) {
      setBrokerMsg({ text: e instanceof Error ? e.message : 'Error', isErr: true })
    } finally {
      setBrokerBusy(false)
    }
  }

  // ── Console handlers ──────────────────────────────────────────────────
  const openConsole = (target: ConsoleTarget) => {
    if (target === consoleTarget) {
      setConsoleTarget('none')
      setConsoleUrl('')
      return
    }
    setConsoleTarget(target)
    if (target === 'broker') {
      setConsoleUrl(brokerConsoleUrl())
    } else if (target !== 'none') {
      setConsoleUrl(workerConsoleUrl(target))
    }
  }

  const selectedWorkerObj = workers.find(w => w.worker_id === selectedWorker)

  const hb = status?.daemon_heartbeat
  const daemonLamp: LampColor = hb ? (hb.daemon_alive ? 'green' : 'red') : 'none'
  const serverLamp: LampColor = status?.monitor_lamp ? (status.monitor_lamp as LampColor) : 'red'
  const celeryStatusLamp: LampColor =
    status?.celery_broker_connected && (status?.celery_workers?.length ?? 0) > 0 ? 'green' : 'red'

  const brokerLamp: LampColor = broker?.connected ? 'green' : 'red'
  const overallLamp: LampColor = (() => {
    if (!broker?.connected) return 'red'
    if (workers.length === 0) return 'red'
    const hasRed = workers.some(w => workerLamp(w.status) === 'red')
    const hasYellow = workers.some(w => workerLamp(w.status) === 'yellow')
    if (hasRed) return 'red'
    if (hasYellow) return 'yellow'
    return 'green'
  })()

  const filteredCommands = commands.filter(c => {
    if (cmdFilter === 'all') return true
    if (cmdFilter === 'failed') return c.status === 'failed' || c.status === 'timeout'
    return c.action === cmdFilter
  })

  const filteredAudit = auditEntries.filter(e => {
    if (auditFilter === 'all') return true
    return e.outcome === auditFilter
  })

  const hasAuditPermission = auditError == null || (!auditError.includes('admin') && !auditError.includes('403'))
  const showInitialSkeleton = loading && workers.length === 0 && commands.length === 0

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
            <span className={`title-inline-lamp lamp-icon ${overallLamp}`} title="Dashboard overall status" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="3" y="3" width="7" height="7" rx="1" />
                <rect x="14" y="3" width="7" height="7" rx="1" />
                <rect x="3" y="14" width="7" height="7" rx="1" />
                <rect x="14" y="14" width="7" height="7" rx="1" />
              </svg>
            </span>
            Dashboard
            <InfoTooltip text="Celery worker control plane. Start, stop, restart workers and track command history with audit trail." />
          </h2>
          <p className="settings-page-subtitle">
            Worker control, runtime snapshot, command history, and audit trail.
          </p>
        </div>
        {ctrlMsg.text && (
          <span className={`settings-page-msg ${ctrlMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{ctrlMsg.text}</span>
        )}
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
          {/* ── Control Bar ──────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-control-bar" aria-labelledby="dashboard-ctrl-head">
            <h3 id="dashboard-ctrl-head" className="page-title-with-tooltip">
              Control
              <InfoTooltip text="Select a target worker, choose an action, and optionally provide a reason. Stop and Restart require confirmation." />
            </h3>
            <div className="dashboard-ctrl-row">
              <label className="dashboard-ctrl-label">
                Target
                <select
                  className="dashboard-ctrl-select"
                  value={selectedWorker}
                  onChange={e => setSelectedWorker(e.target.value)}
                  disabled={!!inflightCmd || showInitialSkeleton}
                >
                  {showInitialSkeleton && <option value="">Loading workers…</option>}
                  {!showInitialSkeleton && workers.length === 0 && <option value="">No workers found</option>}
                  {workers.map(w => (
                    <option key={w.worker_id} value={w.worker_id}>
                      {w.worker_id} ({workerStatusLabel(w.status)})
                    </option>
                  ))}
                </select>
              </label>
              <label className="dashboard-ctrl-label dashboard-ctrl-reason-label">
                Reason
                <input
                  type="text"
                  className="dashboard-ctrl-input"
                  placeholder="Optional reason…"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                  disabled={!!inflightCmd || showInitialSkeleton}
                  maxLength={200}
                />
              </label>
            </div>
            <div className="dashboard-ctrl-actions">
              <button
                type="button"
                className="btn-resume dashboard-btn dashboard-btn--start"
                onClick={() => onActionClick('start')}
                disabled={!!inflightCmd || !selectedWorker || showInitialSkeleton || !canOperate}
                title={canOperate ? 'Start the selected worker via systemd' : 'Requires operator role'}
              >
                {inflightCmd === 'start' ? 'Starting…' : 'Start'}
              </button>
              <button
                type="button"
                className="btn-resume dashboard-btn dashboard-btn--restart"
                onClick={() => onActionClick('restart')}
                disabled={!!inflightCmd || !selectedWorker || showInitialSkeleton || !canOperate}
                title={canOperate ? 'Stop then start the selected worker' : 'Requires operator role'}
              >
                {inflightCmd === 'restart' ? 'Restarting…' : 'Restart'}
              </button>
              <button
                type="button"
                className="btn-shutdown-all dashboard-btn dashboard-btn--stop"
                onClick={() => onActionClick('stop')}
                disabled={!!inflightCmd || !selectedWorker || showInitialSkeleton || !canOperate}
                title={canOperate ? 'Stop the selected worker' : 'Requires operator role'}
              >
                {inflightCmd === 'stop' ? 'Stopping…' : 'Stop'}
              </button>
            </div>
          </section>

          {/* ── Services Overview (P3) ──────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-services" aria-labelledby="dashboard-svc-head">
            <div className="dashboard-section-header-row">
              <h3 id="dashboard-svc-head" className="page-title-with-tooltip">
                Services
                <InfoTooltip text="Unified view of all Bifrost services. Stop individual services or shut down the entire system in order (Celery → Daemon → Server)." />
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
                  title="Shutdown entire system (Celery → Daemon → Server)"
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
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[1])}
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
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[2])}
                  disabled={!!svcStopBusy}
                  title="Stop server process"
                >
                  {svcStopBusy === 'server' ? 'Stopping…' : 'Stop'}
                </button>
              </div>

              {/* Celery */}
              <div className="dashboard-svc-card">
                <div className="dashboard-svc-card-header">
                  <span className={`title-inline-lamp lamp-icon ${celeryStatusLamp}`} aria-hidden>
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                    </svg>
                  </span>
                  <strong>Celery</strong>
                  <span className={`dashboard-svc-status dashboard-svc-status--${celeryStatusLamp}`}>
                    {celeryStatusLamp === 'green' ? 'Running' : 'Down'}
                  </span>
                </div>
                <div className="dashboard-svc-card-meta">
                  <span>Broker: {status?.celery_broker_connected ? 'Connected' : 'Disconnected'}</span>
                  <span>Workers: {status?.celery_workers?.length ?? 0}</span>
                </div>
                <button
                  type="button"
                  className="dashboard-svc-stop-btn"
                  onClick={() => onStopServiceClick(SERVICE_ACTIONS[0])}
                  disabled={!!svcStopBusy}
                  title="Stop Celery worker"
                >
                  {svcStopBusy === 'celery' ? 'Stopping…' : 'Stop'}
                </button>
              </div>
            </div>
          </section>

          {/* ── Runtime Snapshot ──────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-snapshot" aria-labelledby="dashboard-snapshot-head">
            <h3 id="dashboard-snapshot-head" className="page-title-with-tooltip">
              Runtime Snapshot
              <InfoTooltip text="Live broker and worker status. Polled every 5 seconds from Ops API." />
            </h3>

            {/* Broker */}
            <div className="dashboard-broker-card">
              <div className="dashboard-broker-header">
                <span className={`title-inline-lamp lamp-icon ${brokerLamp}`} aria-hidden>●</span>
                <strong>Broker</strong>
                <span className="dashboard-broker-status">
                  {broker?.connected ? 'Connected' : 'Disconnected'}
                </span>
              </div>
              {broker && (
                <div className="dashboard-broker-details">
                  <span title="Masked broker URL">{broker.url_masked}</span>
                  {broker.used_memory_human && <span>Memory: {broker.used_memory_human}</span>}
                  {broker.connected_clients != null && <span>Clients: {broker.connected_clients}</span>}
                  {broker.queues && Object.keys(broker.queues).length > 0 && (
                    <span>
                      Queues:{' '}
                      {Object.entries(broker.queues)
                        .map(([q, n]) => `${q}(${n})`)
                        .join(', ')}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Workers */}
            {showInitialSkeleton ? (
              <div className="dashboard-empty">Loading broker and worker snapshot…</div>
            ) : workers.length === 0 ? (
              <div className="dashboard-empty">
                No workers detected. Start a Celery worker: <code>python scripts/run_celery.py</code>
              </div>
            ) : (
              <div className="dashboard-workers-grid">
                {workers.map(w => {
                  const lamp = workerLamp(w.status)
                  return (
                    <div
                      key={w.worker_id}
                      className={`dashboard-worker-card ${selectedWorker === w.worker_id ? 'dashboard-worker-card--selected' : ''}`}
                      onClick={() => setSelectedWorker(w.worker_id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setSelectedWorker(w.worker_id) }}
                    >
                      <div className="dashboard-worker-header">
                        <span className={`title-inline-lamp lamp-icon ${lamp}`} aria-hidden>●</span>
                        <span className="dashboard-worker-id" title={w.worker_id}>{w.worker_id}</span>
                        <span className={`dashboard-worker-status dashboard-worker-status--${lamp}`}>
                          {workerStatusLabel(w.status)}
                        </span>
                      </div>
                      <div className="dashboard-worker-meta">
                        <span>Queues: {w.queues.length > 0 ? w.queues.join(', ') : '—'}</span>
                        <span>Concurrency: {w.concurrency}</span>
                        <span>Active: {w.active_tasks} / Reserved: {w.reserved_tasks}</span>
                        <span>Heartbeat: {fmtRelative(w.last_heartbeat)}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </section>

          {/* ── Queue Binding ──────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-queue-config" aria-labelledby="dashboard-queue-head">
            <h3 id="dashboard-queue-head" className="page-title-with-tooltip">
              Queue Configuration
              <InfoTooltip text="Add or remove queue consumers on the selected worker. Changes take effect immediately via Celery control." />
            </h3>
            {queueMsg.text && (
              <span className={`settings-page-msg ${queueMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{queueMsg.text}</span>
            )}
            {selectedWorkerObj ? (
              <>
                <div className="dashboard-queue-current">
                  <span className="dashboard-queue-label">Active queues on <strong>{selectedWorker}</strong>:</span>
                  <div className="dashboard-queue-tags">
                    {selectedWorkerObj.queues.length > 0 ? selectedWorkerObj.queues.map(q => (
                      <span key={q} className="dashboard-queue-tag">
                        {q}
                        <button
                          type="button"
                          className="dashboard-queue-tag-remove"
                          onClick={() => onRemoveQueue(q)}
                          disabled={queueBusy || !canOperate}
                          title={canOperate ? `Remove queue "${q}"` : 'Requires operator role'}
                          aria-label={`Remove queue ${q}`}
                        >
                          &times;
                        </button>
                      </span>
                    )) : <span className="dashboard-empty-inline">No queues bound</span>}
                  </div>
                </div>
                <div className="dashboard-queue-add-row">
                  <input
                    type="text"
                    className="dashboard-ctrl-input"
                    placeholder="Queue name…"
                    value={queueAddInput}
                    onChange={e => setQueueAddInput(e.target.value)}
                    disabled={queueBusy}
                    onKeyDown={e => { if (e.key === 'Enter') onAddQueue() }}
                    maxLength={100}
                  />
                  <button
                    type="button"
                    className="btn-resume dashboard-btn dashboard-btn--start"
                    onClick={onAddQueue}
                    disabled={queueBusy || !queueAddInput.trim() || !canOperate}
                  >
                    {queueBusy ? 'Updating…' : 'Add Queue'}
                  </button>
                </div>
              </>
            ) : (
              <div className="dashboard-empty">Select a worker to configure queues.</div>
            )}
          </section>

          {/* ── Worker Scaling ─────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-scaling" aria-labelledby="dashboard-scale-head">
            <h3 id="dashboard-scale-head" className="page-title-with-tooltip">
              Worker Instances
              <InfoTooltip text="Select a worker type and click Add — the system assigns a unique instance ID automatically." />
            </h3>
            {scaleMsg.text && (
              <span className={`settings-page-msg ${scaleMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{scaleMsg.text}</span>
            )}
            {instances.length > 0 && (
              <div className="dashboard-instances-list">
                {instances.map(inst => (
                  <div key={inst.unit} className="dashboard-instance-row">
                    <span className={`dashboard-instance-lamp ${inst.active === 'active' ? 'green' : 'red'}`}>●</span>
                    <span className="dashboard-instance-unit">{inst.unit}</span>
                    <span className="dashboard-instance-sub">{inst.sub}</span>
                    <button
                      type="button"
                      className="dashboard-svc-stop-btn"
                      onClick={() => {
                        const match = inst.unit.match(/@([^.]+)\.service/)
                        if (match) onScaleRemove(match[1])
                      }}
                      disabled={scaleBusy || !canOperate}
                      title={canOperate ? `Stop and remove ${inst.unit}` : 'Requires operator role'}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="dashboard-scale-add-row">
              <select
                className="dashboard-ctrl-input"
                value={scaleWorkerType}
                onChange={e => setScaleWorkerType(e.target.value)}
                disabled={scaleBusy || workerProfiles.length === 0}
              >
                {workerProfiles.length === 0 && <option value="">No profiles</option>}
                {workerProfiles.map(p => (
                  <option key={p.key} value={p.key}>
                    {p.label} ({p.queues.join(', ')})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-resume dashboard-btn dashboard-btn--start"
                onClick={onScaleAdd}
                disabled={scaleBusy || !scaleWorkerType || !canOperate}
              >
                {scaleBusy ? 'Working…' : 'Add Instance'}
              </button>
            </div>
          </section>

          {/* ── Broker Control ─────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-broker-ctrl" aria-labelledby="dashboard-broker-ctrl-head">
            <h3 id="dashboard-broker-ctrl-head" className="page-title-with-tooltip">
              Broker Control
              <InfoTooltip text="Start, stop, or restart the Redis broker. Only available when Redis is locally managed via systemd." />
            </h3>
            {brokerMsg.text && (
              <span className={`settings-page-msg ${brokerMsg.isErr ? 'msg-error' : 'msg-ok'}`}>{brokerMsg.text}</span>
            )}
            {extBroker ? (
              <div className="dashboard-broker-ctrl-body">
                <div className="dashboard-broker-ctrl-info">
                  <span>Connected: <strong>{extBroker.connected ? 'Yes' : 'No'}</strong></span>
                  <span>Locally managed: <strong>{extBroker.locally_managed ? 'Yes' : 'No'}</strong></span>
                  {extBroker.used_memory_human && <span>Memory: {extBroker.used_memory_human}</span>}
                  {extBroker.connected_clients != null && <span>Clients: {extBroker.connected_clients}</span>}
                </div>
                {extBroker.locally_managed ? (
                  <div className="dashboard-broker-ctrl-actions">
                    <button
                      type="button"
                      className="btn-resume dashboard-btn dashboard-btn--start"
                      onClick={() => onBrokerAction('start')}
                      disabled={brokerBusy || !canAdmin}
                    >
                      Start
                    </button>
                    <button
                      type="button"
                      className="btn-resume dashboard-btn dashboard-btn--restart"
                      onClick={() => onBrokerAction('restart')}
                      disabled={brokerBusy || !canAdmin}
                    >
                      Restart
                    </button>
                    <button
                      type="button"
                      className="btn-shutdown-all dashboard-btn dashboard-btn--stop"
                      onClick={() => onBrokerAction('stop')}
                      disabled={brokerBusy || !canAdmin}
                    >
                      Stop
                    </button>
                  </div>
                ) : (
                  <div className="dashboard-empty">Redis is externally managed — control buttons disabled.</div>
                )}
              </div>
            ) : (
              <div className="dashboard-empty">Loading broker status…</div>
            )}
          </section>

          {/* ── Console Monitor ────────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-console-section" aria-labelledby="dashboard-console-head">
            <h3 id="dashboard-console-head" className="page-title-with-tooltip">
              Console
              <InfoTooltip text="Live log output from systemd journal (journalctl -f). Select a worker or broker to stream." />
            </h3>
            <div className="dashboard-console-selector">
              <button
                type="button"
                className={`dashboard-filter-btn ${consoleTarget === 'broker' ? 'active' : ''}`}
                onClick={() => openConsole('broker')}
              >
                Broker (Redis)
              </button>
              {workers.map(w => (
                <button
                  key={w.worker_id}
                  type="button"
                  className={`dashboard-filter-btn ${consoleTarget === w.worker_id ? 'active' : ''}`}
                  onClick={() => openConsole(w.worker_id)}
                >
                  {w.worker_id}
                </button>
              ))}
            </div>
            {consoleTarget !== 'none' && consoleUrl ? (
              <LogConsole url={consoleUrl} />
            ) : (
              <div className="dashboard-empty">Select a target above to open a live console stream.</div>
            )}
          </section>

          {/* ── Command Timeline ──────────────────────────────── */}
          <section className="replay-section dashboard-section dashboard-commands" aria-labelledby="dashboard-cmd-head">
            <div className="dashboard-section-header-row">
              <h3 id="dashboard-cmd-head" className="page-title-with-tooltip">
                Command History
                <InfoTooltip text="Recent control commands sent via Ops API. Click a row to expand result/error details." />
              </h3>
              <div className="dashboard-filter-row">
                {(['all', 'start', 'stop', 'restart', 'failed'] as const).map(f => (
                  <button
                    key={f}
                    type="button"
                    className={`dashboard-filter-btn ${cmdFilter === f ? 'active' : ''}`}
                    onClick={() => setCmdFilter(f)}
                  >
                    {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            {showInitialSkeleton ? (
              <div className="dashboard-empty">Loading command history…</div>
            ) : filteredCommands.length === 0 ? (
              <div className="dashboard-empty">
                {commands.length === 0
                  ? 'No commands yet. Use the control bar above to send your first command.'
                  : 'No commands match the current filter.'}
              </div>
            ) : (
              <div className="dashboard-cmd-table-wrap">
                <table className="table-operations dashboard-cmd-table">
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>Action</th>
                      <th>Target</th>
                      <th>Status</th>
                      <th>Operator</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredCommands.map(c => {
                      const badge = commandStatusBadge(c.status)
                      const isExpanded = expandedCmdId === c.command_id
                      return (
                        <tr key={c.command_id} className="dashboard-cmd-row-group">
                          <td colSpan={6} style={{ padding: 0 }}>
                            <div
                              className={`dashboard-cmd-row ${isExpanded ? 'dashboard-cmd-row--expanded' : ''}`}
                              onClick={() => setExpandedCmdId(isExpanded ? null : c.command_id)}
                              role="button"
                              tabIndex={0}
                              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setExpandedCmdId(isExpanded ? null : c.command_id) }}
                            >
                              <span className="dashboard-cmd-cell dashboard-cmd-cell--time">{fmtTimestamp(c.created_at)}</span>
                              <span className="dashboard-cmd-cell dashboard-cmd-cell--action">{c.action}</span>
                              <span className="dashboard-cmd-cell dashboard-cmd-cell--target" title={c.target_id}>{c.target_id}</span>
                              <span className={`dashboard-cmd-cell dashboard-cmd-badge ${badge.className}`}>{badge.label}</span>
                              <span className="dashboard-cmd-cell dashboard-cmd-cell--operator">{c.operator ?? '—'}</span>
                              <span className="dashboard-cmd-cell dashboard-cmd-cell--reason" title={c.reason ?? ''}>{c.reason || '—'}</span>
                            </div>
                            {isExpanded && (
                              <div className="dashboard-cmd-detail">
                                <div className="dashboard-cmd-detail-row">
                                  <span className="dashboard-cmd-detail-label">Command ID</span>
                                  <code>{c.command_id}</code>
                                </div>
                                <div className="dashboard-cmd-detail-row">
                                  <span className="dashboard-cmd-detail-label">Updated</span>
                                  <span>{fmtTimestamp(c.updated_at)}</span>
                                </div>
                                {c.idempotency_key && (
                                  <div className="dashboard-cmd-detail-row">
                                    <span className="dashboard-cmd-detail-label">Idempotency key</span>
                                    <code>{c.idempotency_key}</code>
                                  </div>
                                )}
                                {c.error && (
                                  <div className="dashboard-cmd-detail-row dashboard-cmd-detail-row--error">
                                    <span className="dashboard-cmd-detail-label">Error</span>
                                    <span className="msg err">{c.error}</span>
                                  </div>
                                )}
                                {c.result && (
                                  <div className="dashboard-cmd-detail-row">
                                    <span className="dashboard-cmd-detail-label">Result</span>
                                    <pre className="dashboard-cmd-detail-json">{JSON.stringify(c.result, null, 2)}</pre>
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ── Audit Trail (P2) ──────────────────────────────── */}
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
            {showInitialSkeleton && !auditError ? (
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
                    {filteredAudit.map((entry, i) => {
                      const badge = auditOutcomeBadge(entry.outcome)
                      return (
                        <tr key={`${entry.timestamp}-${i}`}>
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
            )}
          </section>
        </div>
    </div>
  )
}
