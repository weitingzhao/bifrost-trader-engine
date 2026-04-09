/**
 * Single source of truth for system message visibility windows (toast, IB auto-dismiss, backend TTL).
 */
import type { SystemMessage } from '../types'

/** How long a new message stays in the floating toast banner (ms). */
export const SYSTEM_MESSAGE_TOAST_VISIBLE_MS = 10_000

/** IB connection topic messages auto-dismiss from the UI after this many seconds (high-frequency). */
export const IB_CONNECTION_MSG_AUTO_DISMISS_SEC = 30

/**
 * IB Operator command results (e.g. portfolio TWS fetch) — each message lives this long in the UI
 * before auto-dismiss (matches product expectation for command feedback).
 */
export const IB_OPERATOR_COMMAND_LIFETIME_SEC = 600

/** Client-side retention aligned with backend message TTL (seconds). */
export const SYSTEM_MESSAGE_BACKEND_TTL_SEC = 3600

/** TWS fetch, Flex fetch/upload, and other IB Operator command results — 10 min UI lifecycle. */
export function isIbOperatorCommandMessage(msg: SystemMessage): boolean {
  if (msg.topic === 'ib.connection') return false
  if (msg.topic === 'portfolio.flex_executions') return true
  return msg.service === 'ib_operator'
}

export function bannerRemainingMs(occurredAtSec: number, nowMs = Date.now()): number {
  const elapsed = nowMs - Number(occurredAtSec) * 1000
  return Math.max(0, SYSTEM_MESSAGE_TOAST_VISIBLE_MS - elapsed)
}

/** Whole seconds remaining for the toast banner (ceil). */
export function bannerRemainingSecCeil(occurredAtSec: number, nowMs = Date.now()): number {
  return Math.ceil(bannerRemainingMs(occurredAtSec, nowMs) / 1000)
}

/**
 * Seconds until this message is auto-removed from the UI, if that rule applies.
 * `ib.connection` uses IB_CONNECTION_MSG_AUTO_DISMISS_SEC; other topics return null (no auto-dismiss).
 */
export function autoDismissRemainingSec(msg: SystemMessage, nowMs = Date.now()): number | null {
  if (msg.topic !== 'ib.connection') return null
  const ageSec = nowMs / 1000 - Number(msg.occurred_at || 0)
  return Math.max(0, Math.ceil(IB_CONNECTION_MSG_AUTO_DISMISS_SEC - ageSec))
}

/** Seconds until IB Operator command messages auto-dismiss (not connection status). */
export function ibOperatorCommandRemainingSec(msg: SystemMessage, nowMs = Date.now()): number | null {
  if (!isIbOperatorCommandMessage(msg)) return null
  const ageSec = nowMs / 1000 - Number(msg.occurred_at || 0)
  return Math.max(0, Math.ceil(IB_OPERATOR_COMMAND_LIFETIME_SEC - ageSec))
}

const TOAST_TOTAL_SEC = SYSTEM_MESSAGE_TOAST_VISIBLE_MS / 1000

/**
 * Compact `totalSec/remainingSec`: default window for the active rule, then seconds left.
 * - In toast window: `10/x`
 * - After toast, `ib.connection`: `30/x` until auto-dismiss
 * - After toast, IB Operator commands (`service === ib_operator`, not connection topic): `600/x`
 * - Otherwise: `-/-` (no automatic countdown)
 */
export function getMessageLifeCompact(msg: SystemMessage, nowMs = Date.now()): string {
  const occurred = Number(msg.occurred_at || 0)
  if (bannerRemainingMs(occurred, nowMs) > 0) {
    return `${TOAST_TOTAL_SEC}/${bannerRemainingSecCeil(occurred, nowMs)}`
  }
  const conn = autoDismissRemainingSec(msg, nowMs)
  if (conn !== null) {
    return `${IB_CONNECTION_MSG_AUTO_DISMISS_SEC}/${conn}`
  }
  const op = ibOperatorCommandRemainingSec(msg, nowMs)
  if (op !== null) {
    return `${IB_OPERATOR_COMMAND_LIFETIME_SEC}/${op}`
  }
  return '-/-'
}

/** Accessible description for the compact pair. */
export function getMessageLifeCompactAria(compact: string): string {
  if (compact === '-/-') return 'No automatic lifetime countdown'
  const [total, rem] = compact.split('/')
  return `${total} second window, ${rem} seconds remaining`
}

/** True while any visible message still has a countdown (banner or IB auto-dismiss). */
export function needsLifecycleCountdownTick(
  messages: SystemMessage[],
  dismissedIds: Set<string>,
  nowMs = Date.now(),
): boolean {
  for (const m of messages) {
    if (dismissedIds.has(m.message_id)) continue
    if (bannerRemainingMs(Number(m.occurred_at || 0), nowMs) > 0) return true
    const ad = autoDismissRemainingSec(m, nowMs)
    if (ad !== null && ad > 0) return true
    const op = ibOperatorCommandRemainingSec(m, nowMs)
    if (op !== null && op > 0) return true
  }
  return false
}
