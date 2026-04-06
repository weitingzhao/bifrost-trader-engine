import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { LogConsolePanel, useLogConsole } from '../components/LogConsolePanel'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
import {
  fetchMassiveWsLogs,
  subscribeMassiveWsLogs,
  clearMassiveWsLogs,
  fetchIbOperatorLogs,
  subscribeIbOperatorLogs,
  clearIbOperatorLogs,
  fetchIbIngestorLogs,
  subscribeIbIngestorLogs,
  clearIbIngestorLogs,
} from '../api/monitor/logs'
import {
  fetchOpsCapabilities,
  fetchOpsHealth,
  fetchMarketIngestServices,
  controlMarketIngest,
  setOpsToken,
  type MarketIngestServiceRow,
  type MarketIngestAction,
  type OpsCapabilities,
} from '../api/ops/ops'
import { OpsHostEnvPillBadge } from '../components/OpsHostEnvPillBadge'
import { opsHostEnvFromConfigProfile, type OpsHostEnvPill } from '../utils/opsHostEnvPill'
import { aggregateIngestServicesLamp, ingestProcessLamp } from '../utils/socketIngestLamp'

export interface MarketIngestOpsPageProps {
  embeddedInSettings?: boolean
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
}

type ConfirmState = {
  open: boolean
  title: string
  message: string
  confirming: boolean
  action: (() => Promise<void>) | null
}

const INITIAL_CONFIRM: ConfirmState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  action: null,
}

function fmtAge(s: number | null | undefined): string {
  if (s == null || Number.isNaN(s)) return '—'
  if (s < 60) return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

type IngestCategory = 'Massive' | 'IB' | 'Other'

function categoryForServiceId(id: string): IngestCategory {
  if (id === 'massive_ws') return 'Massive'
  if (id === 'ib_ingestor' || id === 'ib_market' || id === 'ib_operator') return 'IB'
  return 'Other'
}

/** Client ID for IB ingest rows: live connection for ib_ingestor when present, else YAML; ib_operator from YAML. */
function ibIngestClientIdDisplay(
  svcId: string,
  category: IngestCategory,
  status: StatusResponse | null,
): { id: number; title: string } | null {
  if (category !== 'IB') return null
  const cfg = status?.ib_config
  if (svcId === 'ib_ingestor' || svcId === 'ib_market') {
    const run = status?.ib_ingestor?.client_id
    if (run != null && Number.isFinite(Number(run))) {
      return {
        id: Number(run),
        title: 'Client ID used by the live IB ingestor connection (Monitor GET /status).',
      }
    }
    const c = cfg?.ib_client_id_ib_ingestor
    if (c != null && Number.isFinite(Number(c))) {
      return {
        id: Number(c),
        title:
          'Client ID from config (YAML ib.host.client_id.ingestor) for IB ingestor. Live connection not reporting an ID yet.',
      }
    }
    return null
  }
  if (svcId === 'ib_operator') {
    const c = cfg?.ib_client_id_operator
    if (c != null && Number.isFinite(Number(c))) {
      return {
        id: Number(c),
        title: 'Client ID from config (YAML ib.host.client_id.operator) for IB Operator cmd RPC.',
      }
    }
    return null
  }
  return null
}

/** English explanation for hover (raw status from Ops included where helpful). */
function ingestProcessStatusExplanation(active: string): string {
  const a = (active || '').toLowerCase().trim()
  const raw = (active || '').trim()
  switch (a) {
    case 'active':
      return 'Active — the ingest service process is running.'
    case 'inactive':
      return 'Inactive — the ingest service process is not running.'
    case 'failed':
      return 'Failed — the systemd unit has failed.'
    case 'dead':
      return 'Dead — the systemd unit is dead.'
    case 'activating':
      return 'Activating — the service is starting.'
    case 'deactivating':
      return 'Deactivating — the service is stopping.'
    case 'reloading':
      return 'Reloading — the service is reloading its configuration.'
    case 'unknown':
      return 'Unknown — Ops could not determine process state (check executor / systemctl).'
    case '':
      return 'Unknown — no status has been reported yet.'
    default:
      return raw ? `Other — reported state: ${raw}.` : 'Other — non-standard or unrecognized state.'
  }
}

/** Which primary control buttons to show for the reported systemd/Ops process state. */
function ingestActionButtonsForProcessState(processActive: string): { showStart: boolean; showStop: boolean } {
  const a = (processActive || '').toLowerCase().trim()
  if (a === 'inactive' || a === 'dead' || a === 'deactivating') {
    return { showStart: true, showStop: false }
  }
  if (a === 'active' || a === 'activating' || a === 'reloading') {
    return { showStart: false, showStop: true }
  }
  return { showStart: true, showStop: true }
}

/** Ops /health: config profile + executor — same Host cell for every service (this Ops instance). */
function socketServicesHostColumnDisplay(opts: {
  configProfile: string | null
  localControl: string | null
  marketIngestScriptControl: boolean
}): { title: string; pill: OpsHostEnvPill } {
  const pill = opsHostEnvFromConfigProfile(opts.configProfile)
  const bits: string[] = []
  if (pill.pillVariant === 'dev') {
    bits.push('Ops config profile: dev (config.dev.yaml overlay).')
  } else if (pill.pillVariant === 'prod') {
    bits.push('Ops config profile: prod (config.prod.yaml overlay).')
  } else {
    bits.push('Ops config profile not inferred (custom path or base config.yaml only).')
  }
  if (opts.marketIngestScriptControl) {
    bits.push('Ingest control: local scripts on this Ops host (typical Mac dev).')
  } else if (opts.localControl === 'subprocess') {
    bits.push('Subprocess executor without market ingest script control.')
  } else {
    bits.push('Ingest control: systemd on this Ops host (typical Linux prod).')
  }
  return { title: bits.join(' '), pill }
}

type SocketLogTab = 'massive' | 'ib_operator' | 'ib_ingestor'

const INGEST_ACTION_SVG_PROPS = {
  viewBox: '0 0 24 24',
  width: 16,
  height: 16,
  fill: 'none' as const,
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
}

function ServiceRow(props: {
  svc: MarketIngestServiceRow
  category: IngestCategory
  status: StatusResponse | null
  hostTitle: string
  hostPill: OpsHostEnvPill
  logicalText: string
  canAdmin: boolean
  disableIngestActions: boolean
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onReset: () => void
}) {
  const {
    svc,
    category,
    status,
    hostTitle,
    hostPill,
    logicalText,
    canAdmin,
    disableIngestActions,
    onStart,
    onStop,
    onRestart,
    onReset,
  } = props
  const lamp = ingestProcessLamp(svc.process_active)
  const statusTitle = ingestProcessStatusExplanation(svc.process_active)
  const { showStart, showStop } = ingestActionButtonsForProcessState(svc.process_active)
  const ibClient = ibIngestClientIdDisplay(svc.id, category, status)
  return (
    <tr>
      <td>
        <span className={`title-inline-lamp lamp-icon ${lamp}`} title={statusTitle} aria-label={statusTitle}>
          <span aria-hidden>●</span>
        </span>
      </td>
      <td title={hostTitle}>
        <OpsHostEnvPillBadge pill={hostPill} />
      </td>
      <td>{category}</td>
      <td className="massive-api-kv-label">
        {svc.label}
        <div className="massive-api-doc-hint" style={{ marginTop: 4 }}>
          <code>{svc.systemd_unit}</code>
        </div>
        {category === 'IB' ? (
          <div className="socket-ib-client-id-wrap">
            <span className="massive-api-doc-hint">IB Client ID</span>
            {ibClient ? (
              <span className="socket-ib-client-id-badge" title={ibClient.title} aria-label={ibClient.title}>
                {ibClient.id}
              </span>
            ) : (
              <span className="massive-api-doc-hint" title="Not available from Monitor /status or ib_config.">
                —
              </span>
            )}
          </div>
        ) : null}
      </td>
      <td>{logicalText}</td>
      <td>
        {canAdmin && !disableIngestActions ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)', alignItems: 'center' }}>
            {showStart ? (
              <button
                type="button"
                className="btn btn-icon-small btn-icon-success"
                onClick={onStart}
                title={`Start "${svc.label}" — bring the ingest process online.`}
                aria-label={`Start ${svc.label}: bring the ingest process online.`}
              >
                <svg {...INGEST_ACTION_SVG_PROPS}>
                  <path d="M8 5v14l11-7L8 5z" />
                </svg>
              </button>
            ) : null}
            {showStop ? (
              <button
                type="button"
                className="btn btn-icon-small btn-icon-danger"
                onClick={onStop}
                title={`Stop "${svc.label}" — stop the ingest process.`}
                aria-label={`Stop ${svc.label}: stop the ingest process.`}
              >
                <svg {...INGEST_ACTION_SVG_PROPS}>
                  <rect x="6" y="6" width="12" height="12" rx="1" />
                </svg>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-icon-small"
              onClick={onRestart}
              title={`Restart "${svc.label}" — restart with a brief disconnect.`}
              aria-label={`Restart ${svc.label}: restart with a brief disconnect.`}
            >
              <svg {...INGEST_ACTION_SVG_PROPS}>
                <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
                <path d="M21 3v5h-5" />
                <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
                <path d="M3 21v-5h5" />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-icon-small"
              onClick={onReset}
              title={`Reset "${svc.label}" — restart and release resources (IB services disconnect TWS clients first).`}
              aria-label={`Reset ${svc.label}: restart and release resources; IB services disconnect TWS clients first.`}
            >
              <svg {...INGEST_ACTION_SVG_PROPS}>
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
          </div>
        ) : (
          <span className="massive-api-doc-hint">
            {disableIngestActions
              ? 'Control disabled: subprocess Ops without ingest script support (upgrade Ops or use Linux systemd).'
              : 'Admin role required (Ops token).'}
          </span>
        )}
      </td>
    </tr>
  )
}

function IngestServicesTable(props: {
  rows: { svc: MarketIngestServiceRow; category: IngestCategory }[]
  status: StatusResponse | null
  hostTitle: string
  hostPill: OpsHostEnvPill
  emptyHint: string
  logicalSummary: (svc: MarketIngestServiceRow) => string
  canAdmin: boolean
  disableIngestActions: boolean
  onStart: (svc: MarketIngestServiceRow) => void
  onStop: (svc: MarketIngestServiceRow) => void
  onRestart: (svc: MarketIngestServiceRow) => void
  onReset: (svc: MarketIngestServiceRow) => void
}) {
  const {
    rows,
    status,
    hostTitle,
    hostPill,
    emptyHint,
    logicalSummary,
    canAdmin,
    disableIngestActions,
    onStart,
    onStop,
    onRestart,
    onReset,
  } = props
  if (rows.length === 0) {
    return <p className="massive-api-doc-hint">{emptyHint}</p>
  }
  return (
    <table className="massive-api-kv-table">
      <thead>
        <tr>
          <th>Status</th>
          <th>
            Host
            <InfoTooltip text="Environment for this Ops instance (config profile from Ops /health). Same for all rows; switch Ops routing in app settings to target another host." />
          </th>
          <th>Category</th>
          <th className="massive-api-kv-label">Service</th>
          <th>Redis / logical</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ svc, category }) => (
          <ServiceRow
            key={svc.id}
            svc={svc}
            category={category}
            status={status}
            hostTitle={hostTitle}
            hostPill={hostPill}
            logicalText={logicalSummary(svc)}
            canAdmin={canAdmin}
            disableIngestActions={disableIngestActions}
            onStart={() => onStart(svc)}
            onStop={() => onStop(svc)}
            onRestart={() => onRestart(svc)}
            onReset={() => onReset(svc)}
          />
        ))}
      </tbody>
    </table>
  )
}

export function MarketIngestOpsPage({
  embeddedInSettings,
  status,
  loadStatus,
}: MarketIngestOpsPageProps) {
  const [services, setServices] = useState<MarketIngestServiceRow[]>([])
  const [opsErr, setOpsErr] = useState<string | null>(null)
  const [canAdmin, setCanAdmin] = useState(false)
  const [caps, setCaps] = useState<OpsCapabilities | null>(null)
  const [configProfile, setConfigProfile] = useState<string | null>(null)
  const [localControl, setLocalControl] = useState<string | null>(null)
  const [marketIngestScriptControl, setMarketIngestScriptControl] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmState>(INITIAL_CONFIRM)
  const [logTab, setLogTab] = useState<SocketLogTab>('massive')

  const fetchLogs = useCallback((tail?: number) => fetchMassiveWsLogs(tail ?? 80), [])
  const subscribeLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) => subscribeMassiveWsLogs(onLine, onError),
    [],
  )
  const clearLogs = useCallback(() => clearMassiveWsLogs(), [])
  const wsConsole = useLogConsole({
    fetchLogs,
    subscribeLogs,
    clearLogs,
    initialMaxLines: 500,
    enabled: logTab === 'massive',
  })

  const fetchIbLogs = useCallback((tail?: number) => fetchIbIngestorLogs(tail ?? 80), [])
  const subscribeIbLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) => subscribeIbIngestorLogs(onLine, onError),
    [],
  )
  const clearIbLogs = useCallback(() => clearIbIngestorLogs(), [])
  const ibIngestorConsole = useLogConsole({
    fetchLogs: fetchIbLogs,
    subscribeLogs: subscribeIbLogs,
    clearLogs: clearIbLogs,
    initialMaxLines: 500,
    enabled: logTab === 'ib_ingestor',
  })

  const fetchIbOpLogs = useCallback((tail?: number) => fetchIbOperatorLogs(tail ?? 80), [])
  const subscribeIbOpLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) => subscribeIbOperatorLogs(onLine, onError),
    [],
  )
  const clearIbOpLogs = useCallback(() => clearIbOperatorLogs(), [])
  const ibOperatorConsole = useLogConsole({
    fetchLogs: fetchIbOpLogs,
    subscribeLogs: subscribeIbOpLogs,
    clearLogs: clearIbOpLogs,
    initialMaxLines: 500,
    enabled: logTab === 'ib_operator',
  })

  const refresh = useCallback(async () => {
    try {
      const [svcRes, capRes, healthRes] = await Promise.all([
        fetchMarketIngestServices(),
        fetchOpsCapabilities(),
        fetchOpsHealth(),
      ])
      if (svcRes.ok && Array.isArray(svcRes.services)) {
        setServices(svcRes.services)
        setOpsErr(svcRes.error ?? null)
      } else {
        setServices([])
        setOpsErr(svcRes.error ?? 'Failed to load services')
      }
      if (capRes.ok) setCaps(capRes)
      setCanAdmin(capRes.capabilities?.can_admin === true)
      setConfigProfile(healthRes.config_profile ?? null)
      setLocalControl(healthRes.local_control ?? null)
      setMarketIngestScriptControl(healthRes.market_ingest_script_control === true)
    } catch (e) {
      setOpsErr((e as Error).message)
      setServices([])
      setMarketIngestScriptControl(false)
      setConfigProfile(null)
    }
  }, [])

  const handleLogin = useCallback(() => {
    setOpsToken(tokenInput.trim())
    setTokenInput('')
    setAuthPanelOpen(false)
    void refresh()
  }, [tokenInput, refresh])

  const handleLogout = useCallback(() => {
    setOpsToken('')
    setAuthPanelOpen(false)
    void refresh()
  }, [refresh])

  useEffect(() => {
    void refresh()
    const t = window.setInterval(() => void refresh(), 8000)
    return () => window.clearInterval(t)
  }, [refresh])

  const massive = status?.massive
  const ibIngestor = status?.ib_ingestor
  const disableIngestActions = localControl === 'subprocess' && marketIngestScriptControl !== true

  const isAuthenticated = caps?.identity.authenticated ?? false
  const authRequired = caps?.auth_required ?? false
  const currentRole = caps?.identity.role ?? 'viewer'

  const hostColumn = useMemo(
    () =>
      socketServicesHostColumnDisplay({
        configProfile,
        localControl,
        marketIngestScriptControl,
      }),
    [configProfile, localControl, marketIngestScriptControl],
  )

  const unifiedServiceRows = useMemo(() => {
    const byCat: Record<IngestCategory, MarketIngestServiceRow[]> = {
      Massive: [],
      IB: [],
      Other: [],
    }
    for (const s of services) {
      byCat[categoryForServiceId(s.id)].push(s)
    }
    const out: { svc: MarketIngestServiceRow; category: IngestCategory }[] = []
    for (const s of byCat.Massive) out.push({ svc: s, category: 'Massive' })
    for (const s of byCat.IB) out.push({ svc: s, category: 'IB' })
    for (const s of byCat.Other) out.push({ svc: s, category: 'Other' })
    return out
  }, [services])

  const socketPageAggregate = useMemo(
    () => aggregateIngestServicesLamp(unifiedServiceRows),
    [unifiedServiceRows],
  )

  const logicalSummary = (svc: MarketIngestServiceRow): string => {
    if (svc.id === 'massive_ws' && massive) {
      const ws = massive.ws_connected ? 'connected' : 'disconnected'
      const rc = massive.ws_reconnects != null ? String(massive.ws_reconnects) : '—'
      return `WS ${ws}; last msg ${fmtAge(massive.last_msg_age_s ?? null)}; reconnects ${rc}`
    }
    if ((svc.id === 'ib_ingestor' || svc.id === 'ib_market') && ibIngestor) {
      const c = ibIngestor.connected ? 'connected' : 'disconnected'
      const rc = ibIngestor.reconnects != null ? String(ibIngestor.reconnects) : '—'
      const mc = ibIngestor.msg_count != null ? String(ibIngestor.msg_count) : '—'
      return `IB ${c}; last msg ${fmtAge(ibIngestor.last_msg_age_s ?? null)}; reconnects ${rc}; msgs ${mc}`
    }
    if (svc.id === 'ib_operator') {
      return `Operator health Redis key: ${svc.redis_meta_key}`
    }
    if (svc.redis_meta_key) return `Meta: ${svc.redis_meta_key}`
    return '—'
  }

  const openConfirm = (title: string, message: string, fn: () => Promise<void>) => {
    setConfirmState({
      open: true,
      title,
      message,
      confirming: false,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true }))
        try {
          await fn()
          await refresh()
          await loadStatus()
        } finally {
          setConfirmState(INITIAL_CONFIRM)
        }
      },
    })
  }

  const runControl = async (serviceId: string, action: MarketIngestAction) => {
    const r = await controlMarketIngest(serviceId, action)
    if (!r.ok) {
      throw new Error(r.error ?? 'Control request failed')
    }
  }

  const openServiceConfirm = (svc: MarketIngestServiceRow, action: Exclude<MarketIngestAction, 'reset'>, verb: string) => {
    const messages: Record<Exclude<MarketIngestAction, 'reset'>, string> = {
      start: `Start ${svc.label}? Quotes may resume after the process connects.`,
      stop: `Stop ${svc.label}? Redis quotes for this feed may go stale until restarted.`,
      restart: `Restart ${svc.label}? There will be a short disconnect.`,
    }
    openConfirm(`${verb} service`, messages[action], () => runControl(svc.id, action))
  }

  const openResetConfirm = (svc: MarketIngestServiceRow) => {
    const isIb = svc.id === 'ib_operator' || svc.id === 'ib_ingestor' || svc.id === 'ib_market'
    const message = isIb
      ? `Reset ${svc.label}? This will restart the service and disconnect IB clients (TWS).`
      : `Reset ${svc.label}? This restarts the ingest process (same end state as Restart).`
    openConfirm('Reset service', message, () => runControl(svc.id, 'reset'))
  }

  const cardClass = embeddedInSettings
    ? 'settings-page-card dashboard-page dashboard-page--embedded'
    : 'settings-page-card dashboard-page'

  return (
    <div id="settings-ws-connector" className={cardClass}>
      {confirmState.open ? (
        <div
          className="data-reset-modal-overlay"
          onClick={() => {
            if (!confirmState.confirming) setConfirmState(INITIAL_CONFIRM)
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="ws-connector-confirm-title"
        >
          <div className="data-reset-modal" onClick={e => e.stopPropagation()}>
            <h3 id="ws-connector-confirm-title">{confirmState.title}</h3>
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
      ) : null}

      <div className="settings-page-header settings-page-header--celery">
        <div className="settings-page-title-group">
          <h2 className="settings-page-title page-title-with-tooltip">
            <span
              className={`title-inline-lamp lamp-icon ${socketPageAggregate.lamp}`}
              title={socketPageAggregate.title}
              role="img"
              aria-label={socketPageAggregate.title}
            >
              <SettingsSidebarLampGlyph id="websocket" />
            </span>
            Socket Services
            <InfoTooltip text="Massive (Polygon) WebSocket ingest and IB ingestor. Status from Monitor /status and Redis; control via Ops API (admin)." />
          </h2>
          <p className="settings-page-subtitle">
            Logical health from Monitor /status; process state from Ops. Feeds write to Redis.
          </p>
        </div>
        <div className="dashboard-auth-bar dashboard-auth-bar--celery-header">
          <div className="dashboard-auth-info">
            <span className={`dashboard-auth-role dashboard-auth-role--${currentRole}`}>
              {currentRole.toUpperCase()}
            </span>
            {caps?.identity.name && caps.identity.name !== 'anonymous' && (
              <span className="dashboard-auth-name">{caps.identity.name}</span>
            )}
            {isAuthenticated && <span className="dashboard-auth-badge">Authenticated</span>}
            {authRequired && !isAuthenticated && (
              <span className="dashboard-auth-badge dashboard-auth-badge--warn">Token required for control</span>
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
            <div className="dashboard-auth-panel dashboard-auth-panel--celery-header">
              <input
                type="password"
                className="dashboard-ctrl-input"
                placeholder="Ops API token…"
                value={tokenInput}
                onChange={e => setTokenInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && tokenInput.trim()) handleLogin()
                }}
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
      </div>

      {opsErr ? (
        <p className="settings-page-msg settings-page-msg--error" role="alert">
          {opsErr}
        </p>
      ) : null}

      <section className="replay-section" aria-labelledby="socket-services-heading">
        <h3 id="socket-services-heading" className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
          Services
        </h3>
        {!opsErr ? (
          <IngestServicesTable
            rows={unifiedServiceRows}
            status={status}
            hostTitle={hostColumn.title}
            hostPill={hostColumn.pill}
            emptyHint="No market ingest services in Ops config."
            logicalSummary={logicalSummary}
            canAdmin={canAdmin}
            disableIngestActions={disableIngestActions}
            onStart={svc => openServiceConfirm(svc, 'start', 'Start')}
            onStop={svc => openServiceConfirm(svc, 'stop', 'Stop')}
            onRestart={svc => openServiceConfirm(svc, 'restart', 'Restart')}
            onReset={openResetConfirm}
          />
        ) : null}
      </section>

      <section className="replay-section" aria-labelledby="socket-logs-heading">
        <h3 id="socket-logs-heading" className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
          Logs
        </h3>
        <div className="system-tabs-wrapper" style={{ padding: 0 }}>
          <div className="system-tabs system-tabs-one-row" role="tablist" aria-label="Ingest log consoles">
            <button
              type="button"
              role="tab"
              id="tab-socket-log-massive"
              aria-selected={logTab === 'massive'}
              aria-controls="panel-socket-logs"
              className={`system-tab ${logTab === 'massive' ? 'active' : ''}`}
              onClick={() => setLogTab('massive')}
            >
              Massive WebSocket
            </button>
            <button
              type="button"
              role="tab"
              id="tab-socket-log-ib-operator"
              aria-selected={logTab === 'ib_operator'}
              aria-controls="panel-socket-logs"
              className={`system-tab ${logTab === 'ib_operator' ? 'active' : ''}`}
              onClick={() => setLogTab('ib_operator')}
            >
              IB Operator
            </button>
            <button
              type="button"
              role="tab"
              id="tab-socket-log-ib-ingestor"
              aria-selected={logTab === 'ib_ingestor'}
              aria-controls="panel-socket-logs"
              className={`system-tab ${logTab === 'ib_ingestor' ? 'active' : ''}`}
              onClick={() => setLogTab('ib_ingestor')}
            >
              IB ingestor
            </button>
          </div>
          <div
            id="panel-socket-logs"
            className="system-tab-panel system-tab-content"
            role="tabpanel"
            aria-labelledby={
              logTab === 'massive'
                ? 'tab-socket-log-massive'
                : logTab === 'ib_operator'
                  ? 'tab-socket-log-ib-operator'
                  : 'tab-socket-log-ib-ingestor'
            }
            style={{ marginTop: 0, paddingTop: 'var(--space-3)' }}
          >
            {logTab === 'massive' ? (
              <LogConsolePanel
                controller={wsConsole}
                loadingText="Connecting…"
                errorText="Unable to load (Redis may be down or Monitor not running)."
                emptyText="No log lines yet. Start: python scripts/run_massive_ws.py"
                infoTooltipText="Socket — Massive WebSocket ingest (bifrost:massive_ws_console)."
                resizeAriaLabel="Resize Massive WebSocket console height"
                clearTitle="Clear displayed log and Redis stream"
              />
            ) : null}
            {logTab === 'ib_operator' ? (
              <LogConsolePanel
                controller={ibOperatorConsole}
                loadingText="Connecting…"
                errorText="Unable to load (Redis may be down or Monitor not running)."
                emptyText="No log lines yet. Start: python scripts/run_ib_operator.py"
                infoTooltipText="Socket — IB Operator cmd RPC only (ib:operator:console). Separate from IB ingestor."
                resizeAriaLabel="Resize IB Operator console height"
                clearTitle="Clear displayed log and Redis stream"
              />
            ) : null}
            {logTab === 'ib_ingestor' ? (
              <LogConsolePanel
                controller={ibIngestorConsole}
                loadingText="Connecting…"
                errorText="Unable to load (Redis may be down or Monitor not running)."
                emptyText="No log lines yet. Start: python scripts/run_ib_ingestor.py"
                infoTooltipText="Socket — IB ingestor only (bifrost:ib_ingestor_console). Not IB Operator."
                resizeAriaLabel="Resize IB ingestor console height"
                clearTitle="Clear displayed log and Redis stream"
              />
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}
