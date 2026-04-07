import type { DaemonHeartbeat } from '../../types'

/** Lamp for IB event subscription aggregate (ticker, positions, fills, commission). */
export function computeEventSubscribeLamp(hb: DaemonHeartbeat | null | undefined): 'green' | 'yellow' | 'red' {
  if (!hb?.daemon_alive) return 'red'
  const allOk =
    hb.event_subscribe_ticker &&
    hb.event_subscribe_positions &&
    hb.event_subscribe_fills &&
    hb.event_subscribe_commission
  const anyOk =
    hb.event_subscribe_ticker ||
    hb.event_subscribe_positions ||
    hb.event_subscribe_fills ||
    hb.event_subscribe_commission
  return allOk ? 'green' : anyOk ? 'yellow' : 'red'
}
