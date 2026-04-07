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
import {
  aggregateIngestRedisHealthLamp,
  ingestRedisHealthLamp,
  localControlAgentLamp,
} from '../utils/socketIngestLamp'

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
  /** Shown when start/stop/restart/reset fails (API/network); modal stays open until dismissed or retried. */
  error: string | null
  action: (() => Promise<void>) | null
}

const INITIAL_CONFIRM: ConfirmState = {
  open: false,
  title: '',
  message: '',
  confirming: false,
  error: null,
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

/** One IB Client ID line under Socket Services (ingest: single row; IB Operator: Host + optional Sec). */
type IbClientIdSlot = { label?: string; id: number | null; title: string }

/**
 * Client IDs for IB ingest rows (only called when `ibIngestClientIdShouldShow` is true).
 * ib_ingestor: live Monitor /status when present, else YAML.
 * ib_operator: Host + Secondary when configured or present in /status; prefer live socket.ib_operator.*.client_id.
 */
function ibIngestClientIdSlots(
  svcId: string,
  category: IngestCategory,
  status: StatusResponse | null,
): IbClientIdSlot[] {
  if (category !== 'IB') return []
  const cfg = status?.config?.ib_client
  if (svcId === 'ib_ingestor' || svcId === 'ib_market') {
    const run = status?.socket?.ib_ingestor?.client_id
    if (run != null && Number.isFinite(Number(run))) {
      return [
        {
          id: Number(run),
          title: 'Client ID used by the live IB ingestor connection (Monitor GET /status).',
        },
      ]
    }
    const c = cfg?.port?.ingestor
    if (c != null && Number.isFinite(Number(c))) {
      return [
        {
          id: Number(c),
          title:
            'Client ID from config (YAML ib.host.client_id.ingestor) for IB ingestor. Live connection not reporting an ID yet.',
        },
      ]
    }
    return []
  }
  if (svcId === 'ib_operator') {
    const op = status?.socket?.ib_operator
    const slots: IbClientIdSlot[] = []
    const hostRun = op?.host?.client_id
    const hostCfg = cfg?.port?.operator_host
    if (hostRun != null && Number.isFinite(Number(hostRun))) {
      slots.push({
        label: 'Host',
        id: Number(hostRun),
        title:
          'Client ID used by the live IB Operator Host connection (Monitor GET /status socket.ib_operator.host).',
      })
    } else if (hostCfg != null && Number.isFinite(Number(hostCfg))) {
      slots.push({
        label: 'Host',
        id: Number(hostCfg),
        title:
          'Client ID from config (YAML ib.host.client_id.operator) for IB Operator cmd RPC. Live Host slot not reporting an ID yet.',
      })
    }
    const secConfigured =
      cfg?.port?.operator_secondary != null && Number.isFinite(Number(cfg.port.operator_secondary))
    const secSlotPresent = op?.secondary !== undefined
    if (secConfigured || secSlotPresent) {
      const secRun = op?.secondary?.client_id
      const secCfg = cfg?.port?.operator_secondary
      if (secRun != null && Number.isFinite(Number(secRun))) {
        slots.push({
          label: 'Sec',
          id: Number(secRun),
          title:
            'Client ID used by the live IB Operator Secondary connection (Monitor GET /status socket.ib_operator.secondary).',
        })
      } else if (secCfg != null && Number.isFinite(Number(secCfg))) {
        slots.push({
          label: 'Sec',
          id: Number(secCfg),
          title:
            'Client ID from config (merged YAML ib2_client_id_operator / operator_secondary) for IB Operator Secondary. Live Secondary slot not reporting an ID yet.',
        })
      } else {
        slots.push({
          label: 'Sec',
          id: null,
          title:
            'Secondary IB Operator slot is present in Monitor /status or expected from config, but client_id is not available yet.',
        })
      }
    }
    return slots
  }
  return []
}

/** Which primary control buttons to show for the reported systemd/Ops process state. */
function ingestActionButtonsForProcessState(processActive: string): { showStart: boolean; showStop: boolean } {
  const a = (processActive || '').toLowerCase().trim()
  // Stopped, failed, or not in a running sub-state — Start only (matches backend is-active vocabulary).
  if (
    a === 'inactive'
    || a === 'dead'
    || a === 'deactivating'
    || a === 'failed'
    || a === 'maintenance'
  ) {
    return { showStart: true, showStop: false }
  }
  // Running or on the way up — Stop only.
  if (a === 'active' || a === 'activating' || a === 'reloading' || a === 'refreshing') {
    return { showStart: false, showStop: true }
  }
  // Unknown / empty / future systemd strings: Start only — never show both with Stop.
  // `systemctl start` on an already-active unit is a no-op, so this stays safe when probe fails (e.g. Prod agent).
  return { showStart: true, showStop: false }
}

/** IB Client ID is only meaningful while the service process is up (or starting); hide the block otherwise. */
function ingestProcessRunningForIbClientId(processActive: string): boolean {
  const a = (processActive || '').toLowerCase().trim()
  return a === 'active' || a === 'activating' || a === 'reloading'
}

/** Show IB Client ID when local process is up or Redis health says connected (Dev UI vs remote ingest). */
function ibIngestClientIdShouldShow(
  svcId: string,
  category: IngestCategory,
  processActive: string,
  status: StatusResponse | null,
): boolean {
  if (category !== 'IB') return false
  if (ingestProcessRunningForIbClientId(processActive)) return true
  const sid = svcId === 'ib_market' ? 'ib_ingestor' : svcId
  if (sid === 'ib_ingestor') return status?.socket?.ib_ingestor?.connected === true
  if (sid === 'ib_operator') {
    const ibOp = status?.socket?.ib_operator
    return (
      ibOp?.connected === true
      || ibOp?.host?.connected === true
      || ibOp?.secondary?.connected === true
    )
  }
  return false
}

/** Ops /health config_profile → dev|prod for cross-stack action gating (matches opsHostEnvFromConfigProfile). */
function normalizedPageDevProd(configProfile: string | null): 'dev' | 'prod' | null {
  const p = (configProfile ?? '').toLowerCase().trim()
  if (p === 'dev' || p === 'development') return 'dev'
  if (p === 'prod' || p === 'production') return 'prod'
  return null
}

/** Per-row Host: Redis lease (which stack started the service via Ops), not the browser's Ops routing. */
function runtimeControlHostDisplay(
  redisControlEnv: string | null | undefined,
  redisMetaKey: string,
): { title: string; pill: OpsHostEnvPill } {
  const r = (redisControlEnv ?? '').toLowerCase().trim()
  if (r === 'dev' || r === 'prod') {
    const pill = opsHostEnvFromConfigProfile(r)
    const keyHint = redisMetaKey ? `${redisMetaKey}` : 'ingest meta hash'
    return {
      pill,
      title: `Ops control lease in Redis (${keyHint}): last start from ${pill.ariaLabel}. Field bifrost_ops_control_env.`,
    }
  }
  return {
    pill: { shortLabel: '—', pillVariant: 'other', ariaLabel: 'Unclaimed' },
    title: redisMetaKey.trim()
      ? `No Ops control lease in Redis yet (${redisMetaKey}). Starting from Ops (Dev or Prod) writes bifrost_ops_control_env.`
      : 'No redis_meta_key for this row; cross-stack lease is not tracked.',
  }
}

type IngestActionBlock = 'none' | 'admin' | 'script' | 'remote_env'

function ingestActionBlock(
  canOperate: boolean,
  disableIngestScript: boolean,
  pageEnv: 'dev' | 'prod' | null,
  redisControlEnv: string | null | undefined,
): IngestActionBlock {
  if (!canOperate) return 'admin'
  if (disableIngestScript) return 'script'
  if (pageEnv) {
    const lease = (redisControlEnv ?? '').toLowerCase().trim()
    if (lease === 'dev' || lease === 'prod') {
      if (lease !== pageEnv) return 'remote_env'
    }
  }
  return 'none'
}

function ingestActionBlockMessage(block: IngestActionBlock): string {
  switch (block) {
    case 'admin':
      return 'Operator role required (Ops token).'
    case 'script':
      return 'Control disabled: subprocess Ops without ingest script support (upgrade Ops or use Linux systemd).'
    case 'remote_env':
      return 'Control is held by the other stack (Redis). Stop the service from that Ops host first.'
    default:
      return ''
  }
}

/** Ops /health: config profile + executor — summary for this Ops instance (sidebar / page context). */
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
  runtimeHostTitle: string
  runtimeHostPill: OpsHostEnvPill
  logicalText: string
  actionBlock: IngestActionBlock
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onReset: () => void
}) {
  const {
    svc,
    category,
    status,
    runtimeHostTitle,
    runtimeHostPill,
    logicalText,
    actionBlock,
    onStart,
    onStop,
    onRestart,
    onReset,
  } = props
  const redisHealth = ingestRedisHealthLamp(svc.id, status)
  const lamp = redisHealth.lamp
  const statusTitle = redisHealth.title
  const { showStart, showStop } = ingestActionButtonsForProcessState(svc.process_active)
  const showIbClientId = ibIngestClientIdShouldShow(svc.id, category, svc.process_active, status)
  const ibClientSlots = showIbClientId ? ibIngestClientIdSlots(svc.id, category, status) : []
  const actionsDisabled = actionBlock !== 'none'
  return (
    <tr>
      <td>
        <span className={`title-inline-lamp lamp-icon ${lamp}`} title={statusTitle} aria-label={statusTitle}>
          <span aria-hidden>●</span>
        </span>
      </td>
      <td title={runtimeHostTitle}>
        <OpsHostEnvPillBadge pill={runtimeHostPill} />
      </td>
      <td>{category}</td>
      <td className="massive-api-kv-label">
        {svc.label}
        <div className="massive-api-doc-hint" style={{ marginTop: 4 }}>
          <code>{svc.systemd_unit}</code>
        </div>
        {showIbClientId ? (
          <div className="socket-ib-client-id-wrap">
            <span className="massive-api-doc-hint">IB Client ID</span>
            {ibClientSlots.length === 0 ? (
              <span className="massive-api-doc-hint" title="Not available from Monitor /status or ib_client.">
                —
              </span>
            ) : (
              ibClientSlots.map((slot, i) => (
                <span
                  key={`${slot.label ?? 'ingest'}-${i}`}
                  className="socket-ib-client-id-slot"
                  style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem' }}
                >
                  {slot.label ? (
                    <span className="massive-api-doc-hint" style={{ margin: 0 }}>
                      {slot.label}
                    </span>
                  ) : null}
                  {slot.id != null ? (
                    <span className="socket-ib-client-id-badge" title={slot.title} aria-label={slot.title}>
                      {slot.id}
                    </span>
                  ) : (
                    <span className="massive-api-doc-hint" title={slot.title} aria-label={slot.title}>
                      —
                    </span>
                  )}
                </span>
              ))
            )}
          </div>
        ) : null}
      </td>
      <td>{logicalText}</td>
      <td>
        {!actionsDisabled ? (
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
          <span className="massive-api-doc-hint">{ingestActionBlockMessage(actionBlock)}</span>
        )}
      </td>
    </tr>
  )
}

function IngestServicesTable(props: {
  rows: { svc: MarketIngestServiceRow; category: IngestCategory }[]
  status: StatusResponse | null
  pageEnv: 'dev' | 'prod' | null
  disableIngestScript: boolean
  canOperate: boolean
  emptyHint: string
  logicalSummary: (svc: MarketIngestServiceRow) => string
  onStart: (svc: MarketIngestServiceRow) => void
  onStop: (svc: MarketIngestServiceRow) => void
  onRestart: (svc: MarketIngestServiceRow) => void
  onReset: (svc: MarketIngestServiceRow) => void
}) {
  const {
    rows,
    status,
    pageEnv,
    disableIngestScript,
    canOperate,
    emptyHint,
    logicalSummary,
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
            <InfoTooltip text="Runtime stack from Redis field bifrost_ops_control_env on the ingest meta hash (set when you start a service from Ops). Shows Dev or Prod for the stack that owns control. If it differs from this page's Ops config profile, Actions are disabled until that stack stops the service." />
          </th>
          <th>Category</th>
          <th className="massive-api-kv-label">Service</th>
          <th>Redis / logical</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ svc, category }) => {
          const { title: rtTitle, pill: rtPill } = runtimeControlHostDisplay(
            svc.redis_control_env,
            svc.redis_meta_key,
          )
          const block = ingestActionBlock(canOperate, disableIngestScript, pageEnv, svc.redis_control_env)
          return (
            <ServiceRow
              key={svc.id}
              svc={svc}
              category={category}
              status={status}
              runtimeHostTitle={rtTitle}
              runtimeHostPill={rtPill}
              logicalText={logicalSummary(svc)}
              actionBlock={block}
              onStart={() => onStart(svc)}
              onStop={() => onStop(svc)}
              onRestart={() => onRestart(svc)}
              onReset={() => onReset(svc)}
            />
          )
        })}
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
  const [caps, setCaps] = useState<OpsCapabilities | null>(null)
  const [configProfile, setConfigProfile] = useState<string | null>(null)
  const [localControl, setLocalControl] = useState<string | null>(null)
  const [marketIngestScriptControl, setMarketIngestScriptControl] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmState>(INITIAL_CONFIRM)
  const [logTab, setLogTab] = useState<SocketLogTab>('massive')
  const [opsHealth, setOpsHealth] = useState<Awaited<ReturnType<typeof fetchOpsHealth>> | null>(null)

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
      const [svcRes, capRes] = await Promise.all([
        fetchMarketIngestServices(),
        fetchOpsCapabilities(),
      ])
      if (svcRes.ok && Array.isArray(svcRes.services)) {
        setServices(svcRes.services)
        setOpsErr(svcRes.error ?? null)
      } else {
        setServices([])
        setOpsErr(svcRes.error ?? 'Failed to load services')
      }
      if (capRes.ok) setCaps(capRes)
    } catch (e) {
      setOpsErr((e as Error).message)
      setServices([])
      setCaps(null)
    }
    try {
      const healthRes = await fetchOpsHealth()
      setOpsHealth(healthRes)
      setConfigProfile(healthRes.config_profile ?? null)
      setLocalControl(healthRes.local_control ?? null)
      setMarketIngestScriptControl(healthRes.market_ingest_script_control === true)
    } catch {
      setOpsHealth(null)
      setConfigProfile(null)
      setLocalControl(null)
      setMarketIngestScriptControl(false)
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

  const massive = status?.socket?.massive
  const ibIngestor = status?.socket?.ib_ingestor
  const disableIngestActions = localControl === 'subprocess' && marketIngestScriptControl !== true

  const isAuthenticated = caps?.identity.authenticated ?? false
  const authRequired = caps?.auth_required ?? false
  const currentRole = caps?.identity.role ?? 'viewer'
  const canOperate = caps?.capabilities?.can_operate === true

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
    () => aggregateIngestRedisHealthLamp(unifiedServiceRows, status),
    [unifiedServiceRows, status],
  )

  const localAgentPanel = useMemo(() => {
    if ((opsHealth?.executor_mode ?? '').toLowerCase() !== 'agent') {
      return null
    }
    const r = opsHealth?.agent_reachable
    const lamp = localControlAgentLamp(r)
    const socketPath = (opsHealth?.agent_socket ?? '').trim()
    let detail: string
    if (r === true) {
      detail =
        'Reachable. Ingest start/stop below is delegated through this socket (systemd on the host).'
    } else if (r === false) {
      detail = opsHealth?.agent_error?.trim()
        ? opsHealth.agent_error
        : 'Unreachable — check bifrost-agent.service, socket permissions, and sudoers.'
    } else {
      detail =
        'Reachability not reported (upgrade Ops or inspect GET /ops/health). Ingest rows may show unknown until the agent answers.'
    }
    return { lamp, detail, socketPath }
  }, [opsHealth])

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
    if (svc.id === 'ib_operator' && status?.socket?.ib_operator) {
      const op = status.socket.ib_operator
      const hostUp = op.connected === true || op.host?.connected === true
      const c = hostUp ? 'connected' : 'disconnected'
      return `IB Operator ${c} (Redis ${svc.redis_meta_key})`
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
      error: null,
      action: async () => {
        setConfirmState(prev => ({ ...prev, confirming: true, error: null }))
        try {
          await fn()
          await refresh()
          await loadStatus()
          setConfirmState(INITIAL_CONFIRM)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setConfirmState(prev => ({ ...prev, confirming: false, error: msg }))
        }
      },
    })
  }

  const runControl = async (serviceId: string, action: MarketIngestAction) => {
    await controlMarketIngest(serviceId, action)
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
            {confirmState.error ? (
              <p
                className="settings-page-msg settings-page-msg--error"
                style={{ marginTop: 'var(--space-2)' }}
                role="alert"
              >
                {confirmState.error}
              </p>
            ) : null}
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
          <h2 className="settings-page-title page-title-with-tooltip" style={{ flexWrap: 'wrap', rowGap: 'var(--space-2)' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              <span
                className={`title-inline-lamp lamp-icon ${socketPageAggregate.lamp}`}
                title={socketPageAggregate.title}
                role="img"
                aria-label={socketPageAggregate.title}
              >
                <SettingsSidebarLampGlyph id="websocket" />
              </span>
              <span>Socket Services</span>
              <InfoTooltip text="Roll-up from Monitor GET /status `socket`: Massive meta; IB ingestor uses `ib_ingestor.connected`; IB Operator uses `ib_operator.connected` (Host), same green/red rule. Gray when unknown. Local systemd is Start/Stop only; not Local Control Agent health." />
            </span>
          </h2>
          <p className="settings-page-subtitle">
            Row lamps use Redis-backed health from Monitor /status (not local Ops systemd). Ops Start/Stop still targets processes on this Ops host. When executor_mode=agent, Local Control Agent is below.
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

      {localAgentPanel ? (
        <section
          className="replay-section"
          id="settings-ws-agent"
          aria-labelledby="local-control-agent-heading"
        >
          <h3
            id="local-control-agent-heading"
            className="daemon-group-title"
            style={{ marginBottom: 'var(--space-2)' }}
          >
            <span
              className={`title-inline-lamp lamp-icon ${localAgentPanel.lamp}`}
              title={localAgentPanel.detail}
              role="img"
              aria-label={localAgentPanel.detail}
            >
              <SettingsSidebarLampGlyph id="api-ops" />
            </span>
            Local Control Agent
            <InfoTooltip text="Separate systemd proxy (bifrost-agent) over a Unix socket. If red, ingest control via Ops will fail even when units exist. Does not replace ingest process status in the table below." />
          </h3>
          <p className="massive-api-doc-hint" style={{ marginBottom: 'var(--space-2)' }}>
            {localAgentPanel.detail}
          </p>
          {localAgentPanel.socketPath ? (
            <p className="massive-api-doc-hint" style={{ marginBottom: 0 }}>
              Socket:{' '}
              <code style={{ fontSize: '0.9em' }}>{localAgentPanel.socketPath}</code>
            </p>
          ) : null}
        </section>
      ) : null}

      <section className="replay-section" aria-labelledby="socket-services-heading">
        <h3 id="socket-services-heading" className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
          Ingest services
            <InfoTooltip text="Each row lamp reflects Redis health from Monitor GET /status `socket` for that service. Ops process column is for control only." />
        </h3>
        <>
          <p className="massive-api-doc-hint" style={{ marginBottom: 'var(--space-3)', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            <span title={hostColumn.title}>
              This Ops instance (config / executor)
              <span style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
                <OpsHostEnvPillBadge pill={hostColumn.pill} />
              </span>
            </span>
          </p>
          <IngestServicesTable
            rows={unifiedServiceRows}
            status={status}
            pageEnv={normalizedPageDevProd(configProfile)}
            disableIngestScript={disableIngestActions}
            emptyHint="No market ingest services in Ops config."
            logicalSummary={logicalSummary}
            canOperate={canOperate}
            onStart={svc => openServiceConfirm(svc, 'start', 'Start')}
            onStop={svc => openServiceConfirm(svc, 'stop', 'Stop')}
            onRestart={svc => openServiceConfirm(svc, 'restart', 'Restart')}
            onReset={openResetConfirm}
          />
        </>
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
                errorText="Unable to load logs. Monitor reads Redis stream bifrost:console:ws_massive_option (same key as run_massive_ws.py)."
                emptyText="No log lines yet. Start: python scripts/run_massive_ws.py"
                infoTooltipText="Live tail: GET /api/massive-ws/logs + SSE …/stream. Redis: bifrost:console:ws_massive_option."
                resizeAriaLabel="Resize Massive WebSocket console height"
                clearTitle="Clear displayed log and Redis stream"
              />
            ) : null}
            {logTab === 'ib_operator' ? (
              <LogConsolePanel
                controller={ibOperatorConsole}
                loadingText="Connecting…"
                errorText="Unable to load logs. Monitor reads Redis stream bifrost:console:ws_ib_operator (same key as run_ib_operator.py)."
                emptyText="No log lines yet. Start: python scripts/run_ib_operator.py"
                infoTooltipText="Live tail: GET /api/ib-operator/logs + SSE …/stream. Redis: bifrost:console:ws_ib_operator."
                resizeAriaLabel="Resize IB Operator console height"
                clearTitle="Clear displayed log and Redis stream"
              />
            ) : null}
            {logTab === 'ib_ingestor' ? (
              <LogConsolePanel
                controller={ibIngestorConsole}
                loadingText="Connecting…"
                errorText="Unable to load logs. Monitor reads Redis stream bifrost:console:ws_ib_ingestor (same key as run_ib_ingestor.py)."
                emptyText="No log lines yet. Start: python scripts/run_ib_ingestor.py"
                infoTooltipText="Live tail: GET /api/ib-ingestor/logs + SSE …/stream. Redis: bifrost:console:ws_ib_ingestor."
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
