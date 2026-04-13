import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StatusResponse } from '../types'
import { InfoTooltip } from '../components/InfoTooltip'
import { AggregatedLogConsolePanel } from '../components/AggregatedLogConsolePanel'
import { useSocketServicesUnifiedLogConsole } from '../components/useSocketServicesUnifiedLogConsole'
import type { UnifiedLogSourceDefinition } from '../components/unifiedLogConsoleTypes'
import { SettingsSidebarLampGlyph } from './settings/settingsSidebarLampGlyphs'
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
import type { OpsHostEnvPill } from '../utils/opsHostEnvPill'
import {
  ingestActionBlock,
  ingestActionBlockMessage,
  normalizedPageDevProd,
  runtimeControlHostDisplay,
  socketServicesHostColumnDisplay,
  type IngestActionBlock,
} from '../utils/ingestOpsShared'
import {
  aggregateIngestRedisHealthLamp,
  ibSlotProbeUnhealthy,
  ingestRedisHealthLamp,
  ingestRedisTruthyConnected,
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

/** Colored pill badge for IB liveness probe countdown (ticks live via elapsed). */
function IbProbeBadge({ nextInS, stale }: { nextInS: number; stale: boolean }) {
  const isSoon = !stale && nextInS <= 2
  const bg = stale ? 'rgba(239,68,68,0.18)' : isSoon ? 'rgba(234,179,8,0.18)' : 'rgba(34,197,94,0.15)'
  const color = stale ? '#f87171' : isSoon ? '#fbbf24' : '#4ade80'
  const border = stale ? '1px solid rgba(239,68,68,0.35)' : isSoon ? '1px solid rgba(234,179,8,0.35)' : '1px solid rgba(34,197,94,0.3)'
  const label = stale ? 'Stale' : `~${Math.ceil(nextInS)}s`
  return (
    <span
      title={stale ? 'Probe overdue — Monitor marked ib_probe_stale; check run_ib_*.py health loop.' : `Next IB liveness probe in ~${Math.ceil(nextInS)}s`}
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '1px 8px', borderRadius: 99,
        fontSize: '0.72rem', fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.01em', lineHeight: 1.65,
        background: bg, color, border,
        verticalAlign: 'middle', marginLeft: 4,
        minWidth: stale ? undefined : 38, justifyContent: 'center',
      }}
    >
      {label}
    </span>
  )
}

/** Countdown to next main-process service heartbeat (IB Broker Services). */
function ServiceHeartbeatBadge({ nextInS }: { nextInS: number }) {
  const isSoon = nextInS <= 2
  const bg = isSoon ? 'rgba(59,130,246,0.2)' : 'rgba(148,163,184,0.2)'
  const color = isSoon ? '#93c5fd' : '#cbd5e1'
  const border = isSoon ? '1px solid rgba(59,130,246,0.45)' : '1px solid rgba(148,163,184,0.35)'
  return (
    <span
      title="Main process service heartbeat — each tick checks IB client slots; at most one reconnect attempt per tick (next attempt on the following tick if still down)."
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '1px 8px', borderRadius: 99,
        fontSize: '0.72rem', fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.01em', lineHeight: 1.65,
        background: bg, color, border,
        verticalAlign: 'middle', marginLeft: 4,
        minWidth: 38, justifyContent: 'center',
      }}
    >
      ~{Math.ceil(nextInS)}s
    </span>
  )
}

function serviceHeartbeatLiveNextS(
  svcId: string,
  status: StatusResponse | null,
  elapsed: number,
): number | null {
  const sid = svcId === 'ib_market' ? 'ib_ingestor' : svcId
  const raw =
    sid === 'ib_ingestor'
      ? status?.socket?.ib_ingestor?.next_service_heartbeat_in_s
      : sid === 'ib_account_agent'
        ? status?.socket?.ib_account_agent?.next_service_heartbeat_in_s
        : sid === 'ib_operator'
          ? status?.socket?.ib_operator?.next_service_heartbeat_in_s
          : null
  if (raw == null || !Number.isFinite(Number(raw))) return null
  return Math.max(0, Number(raw) - elapsed)
}

/** Which IB client slot(s) the service is reconnecting during the current heartbeat tick (Redis). */
function serviceHeartbeatReconnectHint(
  svcId: string,
  status: StatusResponse | null,
): string | null {
  const sid = svcId === 'ib_market' ? 'ib_ingestor' : svcId
  let raw: string | null | undefined
  if (sid === 'ib_ingestor') {
    raw = status?.socket?.ib_ingestor?.service_heartbeat_reconnect_in_progress
  } else if (sid === 'ib_account_agent') {
    raw = status?.socket?.ib_account_agent?.service_heartbeat_reconnect_in_progress
  } else if (sid === 'ib_operator') {
    raw = status?.socket?.ib_operator?.service_heartbeat_reconnect_in_progress
  } else {
    return null
  }
  if (typeof raw !== 'string') return null
  const t = raw.trim()
  return t !== '' ? t : null
}

/** Colored pill badge for Massive WS last-message age (ticks live via elapsed). */
function MassiveAgeBadge({ ageS }: { ageS: number }) {
  const isOk = ageS < 5
  const isWarn = ageS >= 5 && ageS < 30
  const bg = isOk ? 'rgba(34,197,94,0.15)' : isWarn ? 'rgba(234,179,8,0.18)' : 'rgba(239,68,68,0.18)'
  const color = isOk ? '#4ade80' : isWarn ? '#fbbf24' : '#f87171'
  const border = isOk ? '1px solid rgba(34,197,94,0.3)' : isWarn ? '1px solid rgba(234,179,8,0.35)' : '1px solid rgba(239,68,68,0.35)'
  const label = ageS < 60 ? `${Math.floor(ageS)}s ago` : ageS < 3600 ? `${Math.floor(ageS / 60)}m ago` : `${Math.floor(ageS / 3600)}h ago`
  return (
    <span
      title={`Last Massive WS message ${label}. Green < 5s, yellow < 30s, red ≥ 30s.`}
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '1px 8px', borderRadius: 99,
        fontSize: '0.72rem', fontWeight: 700,
        fontVariantNumeric: 'tabular-nums',
        letterSpacing: '0.01em', lineHeight: 1.65,
        background: bg, color, border,
        verticalAlign: 'middle',
      }}
    >
      {label}
    </span>
  )
}

/** Table row category (Engine is used only on Daemon page; Socket page never lists trading_engine). */
export type IngestCategory = 'Massive' | 'IB' | 'Engine' | 'Other'

function categoryForServiceId(id: string): IngestCategory {
  if (id === 'massive_ws') return 'Massive'
  if (id === 'ib_ingestor' || id === 'ib_market' || id === 'ib_operator' || id === 'ib_account_agent') {
    return 'IB'
  }
  if (id === 'account_sync_daemon') return 'Engine'
  return 'Other'
}

/** One IB Client ID line under Socket Services (ingest: single row; IB Operator: Host + optional Sec). */
type IbClientIdSlot = {
  label?: string
  id: number | null
  title: string
  lastIbProbeLabel?: string
  nextProbeInSec?: number | null
  ibProbeStale?: boolean
  slotConnected?: boolean | null
}

function formatLastIbProbe(ts: number | undefined | null): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '—'
  try {
    return new Date(ts * 1000).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  } catch {
    return '—'
  }
}

function enrichIbClientSlotsWithProbe(
  svcId: string,
  slots: IbClientIdSlot[],
  status: StatusResponse | null,
): IbClientIdSlot[] {
  const sid = svcId === 'ib_market' ? 'ib_ingestor' : svcId
  if (slots.length === 0) return slots
  if (sid === 'ib_ingestor') {
    const ib = status?.socket?.ib_ingestor
    if (!ib) return slots
    return slots.map(s => ({
      ...s,
      lastIbProbeLabel: formatLastIbProbe(ib.last_ib_probe_at),
      nextProbeInSec: ib.next_ib_probe_in_s ?? null,
      ibProbeStale: ib.ib_probe_stale === true,
    }))
  }
  if (sid === 'ib_account_agent') {
    const aa = status?.socket?.ib_account_agent
    if (!aa) return slots
    return slots.map(s => {
      const block = s.label === 'Sec' ? aa.secondary : aa.host
      if (!block) {
        return { ...s, lastIbProbeLabel: '—', nextProbeInSec: null, ibProbeStale: false }
      }
      return {
        ...s,
        lastIbProbeLabel: formatLastIbProbe(block.last_ib_probe_at),
        nextProbeInSec: block.next_ib_probe_in_s ?? null,
        ibProbeStale: block.ib_probe_stale === true,
      }
    })
  }
  if (sid === 'ib_operator') {
    const op = status?.socket?.ib_operator
    if (!op) return slots
    return slots.map(s => {
      const block = s.label === 'Sec' ? op.secondary : op.host
      if (!block) {
        return { ...s, lastIbProbeLabel: '—', nextProbeInSec: null, ibProbeStale: false }
      }
      return {
        ...s,
        lastIbProbeLabel: formatLastIbProbe(block.last_ib_probe_at),
        nextProbeInSec: block.next_ib_probe_in_s ?? null,
        ibProbeStale: block.ib_probe_stale === true,
      }
    })
  }
  return slots
}

/** Per-slot IB liveness: same rules as Redis ingest row lamp (stale / probe failed ⇒ not “green”). */
function ibClientIdSlotProbeUnhealthy(
  svcId: string,
  slot: IbClientIdSlot,
  status: StatusResponse | null,
): boolean {
  const sid = svcId === 'ib_market' ? 'ib_ingestor' : svcId
  if (sid === 'ib_ingestor') {
    return ibSlotProbeUnhealthy(status?.socket?.ib_ingestor)
  }
  if (sid === 'ib_account_agent') {
    const aa = status?.socket?.ib_account_agent
    const block = slot.label === 'Sec' ? aa?.secondary : aa?.host
    return ibSlotProbeUnhealthy(block)
  }
  if (sid === 'ib_operator') {
    const op = status?.socket?.ib_operator
    const block = slot.label === 'Sec' ? op?.secondary : op?.host
    return ibSlotProbeUnhealthy(block)
  }
  return false
}

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
    const ib = status?.socket?.ib_ingestor
    const run = ib?.client_id
    const conn = ib ? ingestRedisTruthyConnected(ib.connected) : null
    if (run != null && Number.isFinite(Number(run))) {
      return [
        {
          id: Number(run),
          title: 'Client ID used by the live IB ingestor connection (Monitor GET /status).',
          slotConnected: conn,
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
          slotConnected: conn,
        },
      ]
    }
    return []
  }
  if (svcId === 'ib_account_agent') {
    const aa = status?.socket?.ib_account_agent
    const slots: IbClientIdSlot[] = []
    const hostRun = aa?.host?.client_id ?? aa?.client_id
    const hostCfg = cfg?.port?.account_agent
    const hostLive =
      ingestRedisTruthyConnected(aa?.connected) || ingestRedisTruthyConnected(aa?.host?.connected)
    if (hostRun != null && Number.isFinite(Number(hostRun))) {
      slots.push({
        label: 'Host',
        id: Number(hostRun),
        title: hostLive
          ? 'Client ID for IB Account Agent Host IB API (Monitor GET /status socket.ib_account_agent.host).'
          : 'Redis reports Host client_id; green lamp requires Host API connected.',
        slotConnected: hostLive,
      })
    } else if (hostCfg != null && Number.isFinite(Number(hostCfg))) {
      slots.push({
        label: 'Host',
        id: Number(hostCfg),
        title:
          'Client ID from config (YAML ib.host.client_id.account_agent). Live Host slot not reporting an ID yet.',
        slotConnected: hostLive,
      })
    }
    const secConfigured = aa?.secondary !== undefined && aa?.secondary !== null
    const ib2Hint = cfg?.client?.secondary_host_ip != null && String(cfg.client.secondary_host_ip).trim() !== ''
    if (secConfigured || ib2Hint) {
      const secRun = aa?.secondary?.client_id
      const secCfg = cfg?.port?.account_agent_secondary
      const secApiLive = ingestRedisTruthyConnected(aa?.secondary?.connected)
      /** Sec slot lamp: green only when Secondary API is up *and* Host is up (Host is primary for this process). */
      const secSlotReady = secApiLive && hostLive
      if (secRun != null && Number.isFinite(Number(secRun))) {
        slots.push({
          label: 'Sec',
          id: Number(secRun),
          title: secSlotReady
            ? 'Client ID for IB Account Agent Secondary IB API (socket.ib_account_agent.secondary).'
            : !secApiLive
              ? 'Secondary client_id in /status while secondary_connected is false.'
              : 'Secondary IB API reports connected, but Host is not connected — slot stays not-ready until Host is up.',
          slotConnected: secSlotReady,
        })
      } else if (secCfg != null && Number.isFinite(Number(secCfg))) {
        slots.push({
          label: 'Sec',
          id: Number(secCfg),
          title: secSlotReady
            ? 'Secondary account_agent client_id from config when exposed; else YAML ib2 client_id.account_agent.'
            : !secApiLive
              ? 'Secondary account_agent client_id from config; live secondary_connected is false.'
              : 'Secondary may be up on IB, but Host is not connected — not-ready until Host is up.',
          slotConnected: secSlotReady,
        })
      } else {
        slots.push({
          label: 'Sec',
          id: null,
          title:
            'Configure ib.secondary (ip + client_id.account_agent) for a second TWS; then /status will show Secondary client_id.',
          slotConnected: null,
        })
      }
    }
    return slots
  }
  if (svcId === 'ib_operator') {
    const op = status?.socket?.ib_operator
    const slots: IbClientIdSlot[] = []
    const hostRun = op?.host?.client_id
    const hostCfg = cfg?.port?.operator_host
    const hostApiLive =
      ingestRedisTruthyConnected(op?.connected) || ingestRedisTruthyConnected(op?.host?.connected)
    if (hostRun != null && Number.isFinite(Number(hostRun))) {
      slots.push({
        label: 'Host',
        id: Number(hostRun),
        title: hostApiLive
          ? 'Client ID used by the live IB Operator Host IB API connection (Monitor GET /status socket.ib_operator.host; host_connected).'
          : 'Redis host_client_id in Monitor /status (same value as config before API login). host_client_id is always present in the health hash; green lamp requires host_connected=true (IB API), not this number alone.',
        slotConnected: hostApiLive,
      })
    } else if (hostCfg != null && Number.isFinite(Number(hostCfg))) {
      slots.push({
        label: 'Host',
        id: Number(hostCfg),
        title:
          'Client ID from config (YAML ib.host.client_id.operator) for IB Operator cmd RPC. Live Host slot not reporting an ID yet.',
        slotConnected: hostApiLive,
      })
    }
    const secConfigured =
      cfg?.port?.operator_secondary != null && Number.isFinite(Number(cfg.port.operator_secondary))
    const secSlotPresent = op?.secondary !== undefined
    if (secConfigured || secSlotPresent) {
      const secRun = op?.secondary?.client_id
      const secCfg = cfg?.port?.operator_secondary
      const secApiLive = ingestRedisTruthyConnected(op?.secondary?.connected)
      const secSlotReady = secApiLive && hostApiLive
      if (secRun != null && Number.isFinite(Number(secRun))) {
        slots.push({
          label: 'Sec',
          id: Number(secRun),
          title: secSlotReady
            ? 'Client ID used by the live IB Operator Secondary IB API connection (Monitor socket.ib_operator.secondary; secondary_connected).'
            : !secApiLive
              ? 'Redis secondary_client_id in Monitor /status while secondary_connected is false. Same as Host: client_id in the hash does not prove IB API login; lamp uses secondary_connected.'
              : 'Secondary IB API reports connected, but Host is not connected — slot stays not-ready until Host is up.',
          slotConnected: secSlotReady,
        })
      } else if (secCfg != null && Number.isFinite(Number(secCfg))) {
        slots.push({
          label: 'Sec',
          id: Number(secCfg),
          title: secSlotReady
            ? 'Client ID from config (merged YAML ib2_client_id_operator / operator_secondary) for IB Operator Secondary. Live Secondary slot not reporting an ID yet.'
            : !secApiLive
              ? 'Secondary client_id from config; live secondary_connected is false.'
              : 'Secondary may be up on IB, but Host is not connected — not-ready until Host is up.',
          slotConnected: secSlotReady,
        })
      } else {
        slots.push({
          label: 'Sec',
          id: null,
          title:
            'Secondary IB Operator slot is present in Monitor /status or expected from config, but client_id is not available yet.',
          slotConnected: null,
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
  if (sid === 'ib_account_agent') {
    const aa = status?.socket?.ib_account_agent
    return (
      aa?.connected === true
      || aa?.host?.connected === true
      || aa?.secondary?.connected === true
    )
  }
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

const SOCKET_SERVICES_LOG_SOURCES: UnifiedLogSourceDefinition[] = [
  { source: 'massive_ws', label: 'Massive WS' },
  { source: 'ib_operator', label: 'IB Operator' },
  { source: 'ib_ingestor', label: 'IB ingestor' },
  { source: 'ib_account_agent', label: 'IB Acct Agent' },
]

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
  /** Seconds elapsed since status prop was last received — used for live countdown. */
  elapsed: number
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
    elapsed,
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
  const rawButtons = ingestActionButtonsForProcessState(svc.process_active)
  // When Redis health is green the service is definitely running regardless of
  // whether Ops/systemd can probe the unit (e.g. process started manually or
  // on a remote host).  Prefer Stop in that case so the button reflects reality.
  const showStart = lamp === 'green' ? false : rawButtons.showStart
  const showStop  = lamp === 'green' ? true  : rawButtons.showStop
  const showIbClientId = ibIngestClientIdShouldShow(svc.id, category, svc.process_active, status)
  const ibClientSlots = showIbClientId
    ? enrichIbClientSlotsWithProbe(svc.id, ibIngestClientIdSlots(svc.id, category, status), status)
    : []
  const ibOpForRow = svc.id === 'ib_operator' ? status?.socket?.ib_operator : undefined
  const liveHostApiConnected =
    svc.id !== 'ib_operator'
    || ingestRedisTruthyConnected(ibOpForRow?.connected)
    || ingestRedisTruthyConnected(ibOpForRow?.host?.connected)
  const actionsDisabled = actionBlock !== 'none'
  // Massive WS: live last-message age counter
  const massive = status?.socket?.massive
  const liveMassiveMsgAgeS =
    svc.id === 'massive_ws' && massive?.last_msg_age_s != null
      ? Math.max(0, Math.floor(massive.last_msg_age_s + elapsed))
      : null
  const liveServiceHeartbeatS = category === 'IB' ? serviceHeartbeatLiveNextS(svc.id, status, elapsed) : null
  const heartbeatReconnectHint =
    category === 'IB' ? serviceHeartbeatReconnectHint(svc.id, status) : null

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
      <td className="massive-api-kv-label">
        <div style={{ fontWeight: 600 }}>{svc.label}</div>
        <div className="massive-api-doc-hint" style={{ marginTop: 3 }}>
          <code>{svc.systemd_unit}</code>
        </div>
      </td>
      <td className="massive-api-kv-label ingest-services-connection-cell">
        {category === 'IB' && liveServiceHeartbeatS != null ? (
          <div
            className="massive-api-doc-hint"
            style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}
          >
            <span style={{ margin: 0 }}>Service heartbeat</span>
            <ServiceHeartbeatBadge nextInS={liveServiceHeartbeatS} />
          </div>
        ) : null}
        {category === 'IB' && heartbeatReconnectHint ? (
          <div
            className="massive-api-doc-hint"
            style={{ marginTop: liveServiceHeartbeatS != null ? 6 : 0, maxWidth: 440 }}
            title="This client is attempting a heartbeat reconnect now (5s timeout per attempt; next try on the following heartbeat)."
          >
            Reconnecting: {heartbeatReconnectHint}
          </div>
        ) : null}
        {/* IB Broker Services: IB Client slots + liveness (separate from Service name column) */}
        {category === 'IB' && showIbClientId ? (
          <div
            className="socket-ib-client-id-wrap"
            style={{
              marginTop: liveServiceHeartbeatS != null || heartbeatReconnectHint != null ? 8 : 0,
            }}
          >
            <span className="massive-api-doc-hint">IB Client ID</span>
            {ibClientSlots.length === 0 ? (
              <span className="massive-api-doc-hint" title="Not available from Monitor /status or ib_client.">
                —
              </span>
            ) : (
              ibClientSlots.map((slot, i) => {
                const liveNextInS =
                  slot.nextProbeInSec != null && Number.isFinite(slot.nextProbeInSec)
                    ? Math.max(0, slot.nextProbeInSec - elapsed)
                    : null
                const showProbe = slot.lastIbProbeLabel != null && slot.lastIbProbeLabel !== '—'
                const probeBad =
                  slot.slotConnected != null ? ibClientIdSlotProbeUnhealthy(svc.id, slot, status) : false
                const slotLampGreen = slot.slotConnected === true && !probeBad
                const slotLampTitleWithLabel = !slot.label
                  ? ''
                  : slotLampGreen
                    ? `${slot.label} IB API connected (liveness OK)`
                    : probeBad && slot.slotConnected === true
                      ? `${slot.label}: Redis connected but liveness probe stale or failed`
                      : `${slot.label} IB API disconnected`
                const slotLampTitleNoLabel = slotLampGreen
                  ? 'IB API connected (liveness OK)'
                  : probeBad && slot.slotConnected === true
                    ? 'Redis connected but liveness probe stale or failed'
                    : 'IB API disconnected'
                return (
                  <span
                    key={`${slot.label ?? 'ingest'}-${i}`}
                    className="socket-ib-client-id-slot"
                    style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: '0.35rem' }}
                  >
                    {slot.label ? (
                      <span className="massive-api-doc-hint" style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {slot.slotConnected != null ? (
                          <span
                            className={`ib-slot-lamp ib-slot-lamp--${slotLampGreen ? 'green' : 'red'}`}
                            title={slotLampTitleWithLabel}
                          />
                        ) : null}
                        {slot.label}
                      </span>
                    ) : slot.slotConnected != null ? (
                      <span
                        className={`ib-slot-lamp ib-slot-lamp--${slotLampGreen ? 'green' : 'red'}`}
                        title={slotLampTitleNoLabel}
                      />
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
                    {showProbe ? (
                      <span
                        className="massive-api-doc-hint"
                        style={{ margin: 0, display: 'inline-flex', alignItems: 'center', gap: 4 }}
                      >
                        <span title="Last IB API liveness probe timestamp">
                          {slot.lastIbProbeLabel}
                        </span>
                        {liveNextInS !== null ? (
                          <IbProbeBadge nextInS={liveNextInS} stale={slot.ibProbeStale === true} />
                        ) : slot.ibProbeStale ? (
                          <IbProbeBadge nextInS={0} stale />
                        ) : null}
                      </span>
                    ) : null}
                  </span>
                )
              })
            )}
            {svc.id === 'ib_operator' && ibOpForRow && !liveHostApiConnected && showIbClientId ? (
              <div className="massive-api-doc-hint" style={{ marginTop: 6, maxWidth: 480 }}>
                Yellow lamp: Redis <code>host_connected</code> is false. <code>host_client_id</code> is
                unrelated (always filled from config). Hover Host / Sec badges for details.
              </div>
            ) : null}
          </div>
        ) : null}
        {category === 'IB' && !showIbClientId && liveServiceHeartbeatS == null ? (
          <span className="massive-api-doc-hint" title="Connection details when the process is up or Redis reports activity.">
            —
          </span>
        ) : null}
        {/* Massive WS: feed connection (last message) */}
        {svc.id === 'massive_ws' && massive ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span className="massive-api-doc-hint" style={{ margin: 0 }}>Last msg</span>
            {liveMassiveMsgAgeS != null ? (
              <MassiveAgeBadge ageS={liveMassiveMsgAgeS} />
            ) : (
              <span className="massive-api-doc-hint" style={{ margin: 0 }}>—</span>
            )}
            {massive.ws_reconnects != null && massive.ws_reconnects > 0 ? (
              <span className="massive-api-doc-hint" style={{ margin: 0 }}>
                · {massive.ws_reconnects} reconnects
              </span>
            ) : null}
          </div>
        ) : null}
        {svc.id === 'massive_ws' && !massive ? (
          <span className="massive-api-doc-hint">—</span>
        ) : null}
        {category !== 'IB' && svc.id !== 'massive_ws' ? (
          <span className="massive-api-doc-hint">—</span>
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

const CATEGORY_LABELS: Record<IngestCategory, string> = {
  Massive: 'Massive Options WS',
  IB: 'IB Broker Services',
  Engine: 'Strategy Trading',
  Other: 'Other',
}

export function IngestServicesTable(props: {
  rows: { svc: MarketIngestServiceRow; category: IngestCategory }[]
  status: StatusResponse | null
  /** Seconds elapsed since status was last received — drives live countdown badges. */
  elapsed: number
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
    elapsed,
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

  // Group rows by category to render section header rows
  const groups: { cat: IngestCategory; rows: { svc: MarketIngestServiceRow; category: IngestCategory }[] }[] = []
  for (const row of rows) {
    const last = groups[groups.length - 1]
    if (!last || last.cat !== row.category) {
      groups.push({ cat: row.category, rows: [row] })
    } else {
      last.rows.push(row)
    }
  }

  return (
    <table className="massive-api-kv-table ingest-services-table">
      <thead>
        <tr>
          <th style={{ width: 32 }}>Status</th>
          <th style={{ width: 80 }}>
            Host
            <InfoTooltip text="Only one of Dev or Prod may run each service against the same Redis: bifrost_ops_control_env and bifrost_ops_control_host on the meta hash record which stack and host last started it from Ops. Starting elsewhere is rejected if the lease differs or if health still shows a fresh active writer. After Stop, Ops clears those fields and rewrites health to disconnected so Status updates." />
          </th>
          <th className="massive-api-kv-label">Service</th>
          <th className="massive-api-kv-label">Connection</th>
          <th>Redis / logical</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        {groups.map(({ cat, rows: catRows }) => (
          <Fragment key={cat}>
            <tr
              style={{
                background: 'rgba(255,255,255,0.03)',
                borderTop: '1px solid rgba(255,255,255,0.07)',
              }}
            >
              <td
                colSpan={6}
                style={{
                  padding: '6px 10px',
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  letterSpacing: '0.09em',
                  textTransform: 'uppercase',
                  color: 'rgba(255,255,255,0.38)',
                  userSelect: 'none',
                }}
              >
                {CATEGORY_LABELS[cat] ?? cat}
              </td>
            </tr>
            {catRows.map(({ svc, category }) => {
              const { title: rtTitle, pill: rtPill } = runtimeControlHostDisplay(
                svc.redis_control_env,
                svc.redis_meta_key,
                svc.redis_control_host,
              )
              const block = ingestActionBlock(canOperate, disableIngestScript, pageEnv, svc.redis_control_env)
              return (
                <ServiceRow
                  key={svc.id}
                  svc={svc}
                  category={category}
                  status={status}
                  elapsed={elapsed}
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
          </Fragment>
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
  const [caps, setCaps] = useState<OpsCapabilities | null>(null)
  const [configProfile, setConfigProfile] = useState<string | null>(null)
  const [localControl, setLocalControl] = useState<string | null>(null)
  const [marketIngestScriptControl, setMarketIngestScriptControl] = useState(false)
  const [tokenInput, setTokenInput] = useState('')
  const [authPanelOpen, setAuthPanelOpen] = useState(false)
  const [confirmState, setConfirmState] = useState<ConfirmState>(INITIAL_CONFIRM)
  const [opsHealth, setOpsHealth] = useState<Awaited<ReturnType<typeof fetchOpsHealth>> | null>(null)

  // Live 1-second ticker for countdown badges and heartbeat ages.
  const [, setTick] = useState(0)
  const statusReceivedAtRef = useRef<number>(Date.now() / 1000)
  const prevStatusRef = useRef<StatusResponse | null>(null)
  useEffect(() => {
    if (status !== prevStatusRef.current) {
      prevStatusRef.current = status
      statusReceivedAtRef.current = Date.now() / 1000
    }
  })
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => (t + 1) & 0xffffff), 1000)
    return () => window.clearInterval(id)
  }, [])
  const elapsed = Math.max(0, Date.now() / 1000 - statusReceivedAtRef.current)

  const socketServicesLogConsole = useSocketServicesUnifiedLogConsole({
    initialMaxLines: 500,
    initialHeightPx: 280,
    enabled: true,
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
  const ibAccountAgent = status?.socket?.ib_account_agent
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

  const ingestServicesForTable = useMemo(
    () => services.filter(s => s.id !== 'trading_engine' && s.id !== 'account_sync_daemon'),
    [services],
  )

  const unifiedServiceRows = useMemo(() => {
    const byCat: Record<IngestCategory, MarketIngestServiceRow[]> = {
      Massive: [],
      IB: [],
      Engine: [],
      Other: [],
    }
    for (const s of ingestServicesForTable) {
      byCat[categoryForServiceId(s.id)].push(s)
    }
    const out: { svc: MarketIngestServiceRow; category: IngestCategory }[] = []
    for (const s of byCat.Massive) out.push({ svc: s, category: 'Massive' })
    for (const s of byCat.IB) out.push({ svc: s, category: 'IB' })
    for (const s of byCat.Engine) out.push({ svc: s, category: 'Engine' })
    for (const s of byCat.Other) out.push({ svc: s, category: 'Other' })
    return out
  }, [ingestServicesForTable])

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
    if (svc.id === 'ib_account_agent' && ibAccountAgent) {
      const hostUp =
        ingestRedisTruthyConnected(ibAccountAgent.connected)
        || ingestRedisTruthyConnected(ibAccountAgent.host?.connected)
      const h = hostUp ? 'Host up' : 'Host down'
      const sec = ibAccountAgent.secondary
      const secBit =
        sec != null
          ? `; Sec ${ingestRedisTruthyConnected(sec.connected) ? 'up' : 'down'}`
          : ''
      const rc = ibAccountAgent.reconnects != null ? String(ibAccountAgent.reconnects) : '—'
      const mc = ibAccountAgent.msg_count != null ? String(ibAccountAgent.msg_count) : '—'
      return `${h}${secBit}; last msg ${fmtAge(ibAccountAgent.last_msg_age_s ?? null)}; reconnects ${rc}; msgs ${mc}`
    }
    if (svc.id === 'ib_operator' && status?.socket?.ib_operator) {
      const op = status.socket.ib_operator
      const hostUp =
        ingestRedisTruthyConnected(op.connected)
        || ingestRedisTruthyConnected(op.host?.connected)
      const c = hostUp ? 'connected' : 'disconnected'
      const rc = op.reconnects != null ? String(op.reconnects) : '—'
      const mc = op.msg_count != null ? String(op.msg_count) : '—'
      return `IB Operator ${c}; last activity ${fmtAge(op.last_msg_age_s ?? null)}; reconnects ${rc}; cmds ${mc}`
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
          setConfirmState(INITIAL_CONFIRM)
          void (async () => {
            await refresh()
            await loadStatus()
          })()
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
    const isIb =
      svc.id === 'ib_operator'
      || svc.id === 'ib_ingestor'
      || svc.id === 'ib_market'
      || svc.id === 'ib_account_agent'
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
            </span>
          </h2>
          <p
            className="massive-api-doc-hint"
            style={{
              marginTop: 'var(--space-2)',
              marginBottom: 0,
              display: 'flex',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--space-2)',
            }}
          >
            <span title={hostColumn.title}>
              This Ops instance (config / executor)
              <span style={{ marginLeft: 6, display: 'inline-flex', verticalAlign: 'middle' }}>
                <OpsHostEnvPillBadge pill={hostColumn.pill} />
              </span>
            </span>
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

      <section className="replay-section" aria-label="Socket service units">
        <IngestServicesTable
          rows={unifiedServiceRows}
          status={status}
          elapsed={elapsed}
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
      </section>

      <section className="replay-section" aria-labelledby="socket-logs-heading">
        <h3 id="socket-logs-heading" className="daemon-group-title" style={{ marginBottom: 'var(--space-2)' }}>
          Logs
        </h3>
        <p className="massive-api-doc-hint" style={{ marginBottom: 'var(--space-3)' }}>
          Merged console output from all socket ingest processes (same pattern as Architecture → Application log).
          Toggle sources to filter; clear removes all four Redis streams on the Monitor host.
        </p>
        <AggregatedLogConsolePanel
          controller={socketServicesLogConsole}
          sourceDefinitions={SOCKET_SERVICES_LOG_SOURCES}
          loadingText="Connecting…"
          errorText="Unable to load logs. Check Monitor API and Redis (streams bifrost:console:ws_*)."
          emptyText="No log lines yet. Start the corresponding scripts (e.g. scripts/systemd/run_massive_ws.py, scripts/systemd/run_ib_account_agent.py)."
          infoTooltipText="Live tail: GET /api/massive-ws/logs, /api/ib-operator/logs, /api/ib-ingestor/logs, /api/ib-account-agent/logs + SSE …/stream for each. Clear deletes all four Redis console streams."
          resizeAriaLabel="Resize Socket Services log console height"
          clearTitle="Clear displayed log and all four Redis streams"
        />
      </section>
    </div>
  )
}
