import type { Execution } from '../../../types'

/**
 * Rough capital proxy for annual %: half-turn OPT notional, floored with |net PnL| so tiny notionals
 * do not explode annualized percentages.
 */
export function estimateOptionCapitalProxyUsd(executions: Execution[], netPnlAbs?: number): number {
  let sum = 0
  for (const e of executions) {
    if ((e.sec_type ?? '').toUpperCase() !== 'OPT') continue
    const q = Math.abs(Number(e.quantity) || 0)
    const p = Number(e.price) || 0
    sum += q * p * 100
  }
  const half = sum / 2
  const n = netPnlAbs != null && Number.isFinite(netPnlAbs) ? Math.abs(netPnlAbs) : 0
  return Math.max(half, n * 2, 1)
}

/** Hold time display: elapsed calendar time from anchor (Unix sec) through now. English label for UI. */
export function formatHoldingDurationLabel(startEpochSec: number): string {
  const now = Date.now() / 1000
  const sec = Math.max(0, now - startEpochSec)
  const d = sec / 86400
  if (!Number.isFinite(d) || d < 1 / 24) return '< 1h'
  if (d < 1) return `${Math.floor(sec / 3600)}h`
  if (d < 14) return `${d.toFixed(1)} d`
  if (d < 60) {
    const w = Math.floor(d / 7)
    const days = Math.floor(d % 7)
    return w > 0 ? `${w}w ${days}d` : `${Math.floor(d)}d`
  }
  if (d < 365) {
    const w = Math.floor(d / 7)
    return `${w}w`
  }
  const y = Math.floor(d / 365.25)
  const rem = Math.floor(d - y * 365.25)
  return `${y}y ${rem}d`
}

/** Calendar days of hold time from anchor through now (floored for very short spans). Used for annualized return. */
export function holdingDaysSince(startEpochSec: number): number {
  const now = Date.now() / 1000
  return Math.max((now - startEpochSec) / 86400, 1 / 24)
}
