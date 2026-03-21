import type { Execution } from '../types'
import { getContractLabelParts } from './format'

/** Collect unique expiry months as `YYYY-MM` from execution rows (OPT expiry). */
export function collectExpiryMonthKeys(execs: Execution[]): string[] {
  const set = new Set<string>()
  for (const e of execs) {
    const ex = (e.expiry || '').trim().replace(/-/g, '')
    if (ex.length >= 6) {
      const yymm = ex.slice(0, 6)
      set.add(`${yymm.slice(0, 4)}-${yymm.slice(4, 6)}`)
    }
  }
  return Array.from(set).sort().reverse()
}

/** Rolling window when the feed has no expiry rows yet. */
export function fallbackExpiryMonthKeys(monthsBack = 6, monthsForward = 24): string[] {
  const out: string[] = []
  const now = new Date()
  for (let i = -monthsBack; i <= monthsForward; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1)
    const y = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    out.push(`${y}-${mm}`)
  }
  return out.sort().reverse()
}

/** Display `YYYY-MM` as e.g. Mar 2026 */
export function formatExpiryMonthKey(key: string): string {
  const m = key.trim().match(/^(\d{4})-(\d{2})$/)
  if (!m) return key
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1)
  if (Number.isNaN(d.getTime())) return key
  return d.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}

/** Unique underlying symbols (uppercase) from `symbol` and `contract_key`. */
export function collectUnderlyingSymbols(execs: Execution[]): string[] {
  const set = new Set<string>()
  for (const e of execs) {
    const direct = (e.symbol || '').trim()
    if (direct) {
      const first = direct.split(/\s+/)[0]?.trim()
      if (first) set.add(first.toUpperCase())
    }
    const ck = (e.contract_key ?? '').trim()
    if (ck) {
      const s = getContractLabelParts(ck).symbol.trim().toUpperCase()
      if (s) set.add(s)
    }
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b))
}
