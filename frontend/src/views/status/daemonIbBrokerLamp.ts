import type { DaemonHeartbeat, StatusResponse } from '../../types'
import { computeAccountSyncLamp } from '../../utils/livePageLamps'
import { ingestRedisHealthLamp, type IngestLamp } from '../../utils/socketIngestLamp'

export type DaemonPanelLamp = 'green' | 'yellow' | 'red' | 'none'

function mapIngestToPanel(lamp: IngestLamp): 'green' | 'yellow' | 'red' {
  if (lamp === 'gray') return 'yellow'
  return lamp
}

/**
 * IB broker card roll-up: socket.ib_operator + ib_ingestor + ib_account_agent only.
 */
export function computeIbBrokerGroupLamp(
  status: StatusResponse | null,
  hb: DaemonHeartbeat | null | undefined,
): { lamp: DaemonPanelLamp; title: string } {
  if (!hb?.daemon_alive) {
    return { lamp: 'none', title: 'Daemon not running; broker services shown when daemon is up.' }
  }

  const op = ingestRedisHealthLamp('ib_operator', status)
  const ing = ingestRedisHealthLamp('ib_ingestor', status)
  const aa = ingestRedisHealthLamp('ib_account_agent', status)

  const opT = mapIngestToPanel(op.lamp)
  const ingT = mapIngestToPanel(ing.lamp)
  const aaT = mapIngestToPanel(aa.lamp)
  const tiers: ('green' | 'yellow' | 'red')[] = [opT, ingT, aaT]

  if (tiers.every(t => t === 'green')) {
    return {
      lamp: 'green',
      title: 'IB Operator, Ingestor, and Account Agent all report healthy.',
    }
  }
  if (tiers.some(t => t === 'red')) {
    const parts: string[] = []
    if (opT === 'red') parts.push(op.title)
    if (ingT === 'red') parts.push(ing.title)
    if (aaT === 'red') parts.push(aa.title)
    return {
      lamp: 'red',
      title: parts.join(' · ') || 'One or more broker path services report unhealthy.',
    }
  }
  const parts: string[] = []
  if (opT !== 'green') parts.push(op.title)
  if (ingT !== 'green') parts.push(ing.title)
  if (aaT !== 'green') parts.push(aa.title)
  return {
    lamp: 'yellow',
    title: parts.join(' · ') || 'Some broker path services are degraded or unknown.',
  }
}

/** Map ingest lamp to daemon row lamp (no gray in UI — same as group roll-up). */
export function ingestLampToBrokerRowLamp(lamp: IngestLamp): 'green' | 'yellow' | 'red' {
  return lamp === 'gray' ? 'yellow' : lamp
}

/** Map Account Sync Daemon heartbeat lamp to IB broker row (no gray in table). */
export function accountSyncLampToBrokerRowLamp(
  lamp: 'green' | 'yellow' | 'red' | 'gray',
): 'green' | 'yellow' | 'red' {
  return lamp === 'gray' ? 'yellow' : lamp
}

/**
 * IB account card for Account Sync Daemon: socket IB Account Agent + PostgreSQL sync heartbeat.
 * Mirrors Strategy Trading Daemon IB broker group roll-up (subset of services).
 */
export function computeAccountSyncIbGroupLamp(
  status: StatusResponse | null,
): { lamp: DaemonPanelLamp; title: string } {
  if (!status) {
    return { lamp: 'none', title: 'Monitor GET /status not loaded.' }
  }
  const aa = ingestRedisHealthLamp('ib_account_agent', status)
  const sync = computeAccountSyncLamp(status)

  const aaT = mapIngestToPanel(aa.lamp)
  const syncT = accountSyncLampToBrokerRowLamp(sync.lamp)

  const tiers: ('green' | 'yellow' | 'red')[] = [aaT, syncT]
  if (tiers.every(t => t === 'green')) {
    return {
      lamp: 'green',
      title: 'IB Account Agent and PostgreSQL account sync both healthy.',
    }
  }
  if (tiers.some(t => t === 'red')) {
    const parts: string[] = []
    if (aaT === 'red') parts.push(aa.title)
    if (syncT === 'red') parts.push(sync.title)
    return {
      lamp: 'red',
      title: parts.join(' · ') || 'Account sync path unhealthy.',
    }
  }
  const parts: string[] = []
  if (aaT !== 'green') parts.push(aa.title)
  if (syncT !== 'green') parts.push(sync.title)
  return {
    lamp: 'yellow',
    title: parts.join(' · ') || 'Account sync path degraded or unknown.',
  }
}
