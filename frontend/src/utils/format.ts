/** Shared format helpers for portfolio and other pages. */

export function fmtTs(ts: number | null | undefined): string {
  if (ts == null) return '--'
  return new Date(ts * 1000).toLocaleString()
}

export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)
}

export function fmtUsd0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

/** Elapsed since ts (Unix sec): e.g. "5m", "2h", "1d". */
export function fmtSince(ts: number | null | undefined): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const nowSec = Date.now() / 1000
  const elapsed = Math.max(0, Math.floor(nowSec - ts))
  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`
  if (elapsed < 86400) return `${Math.floor(elapsed / 3600)}h`
  return `${Math.floor(elapsed / 86400)}d`
}

/** USD with 0 decimals; placeholder '--' (e.g. for compact nav). */
export function fmtUsdCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '--'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n)
}

/** Percentage with sign: "+1.50%" / "-2.00%". */
export function fmtPctCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '--'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

/** Date from ts (Unix sec or ms if > 1e12). Optional locale e.g. 'en-CA' for YYYY-MM-DD. */
export function fmtDate(
  ts: number | string | null | undefined,
  options?: { locale?: string }
): string {
  if (ts == null) return '—'
  const sec = Number(ts)
  if (!Number.isFinite(sec)) return '—'
  const d = new Date(sec > 1e12 ? sec : sec * 1000)
  if (options?.locale) {
    return d.toLocaleDateString(options.locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** Duration in seconds to "Xd Xh Xm" / "Xh Xm" / "Xm". */
export function fmtDurationSeconds(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—'
  const total = Math.round(seconds)
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

/** X-axis label by period: Daily → short date, intraday → time or short datetime. */
export function fmtTsForPeriod(ts: number | null | undefined, period: string): string {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const d = new Date(ts * 1000)
  if (period === '1 D') {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }
  if (period === '1 min' || period === '5 mins') {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (period === '1 hour') {
    return (
      d.toLocaleDateString(undefined, { month: '2-digit', day: '2-digit' }) +
      ' ' +
      d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
    )
  }
  return d.toLocaleString()
}

/** Format time in America/Chicago. Accepts Unix sec or ms if > 1e12. */
export function fmtChicagoTime(unixSec: number | string | null | undefined): string {
  let sec: number
  if (typeof unixSec === 'string') sec = parseFloat(unixSec)
  else if (typeof unixSec === 'number') sec = unixSec
  else return '—'
  if (!Number.isFinite(sec)) return '—'
  if (sec > 1e12) sec /= 1000
  const d = new Date(sec * 1000)
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const parts = f.formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

/** PnL: treat |n| < 0.005 as 0 to avoid "-$0.00". */
export function fmtPnl(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const val = Number(n)
  if (Math.abs(val) < 0.005) return fmtUsd(0)
  return fmtUsd(val)
}

/** PnL for calendar cells: round to integer USD, 0 decimals. */
export function fmtPnlCalendar(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const val = Number(n)
  if (Math.abs(val) < 0.5) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(0)
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(val))
}

/** USD with 0 decimals after Math.round (for display consistency). */
export function fmtUsdRound0(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(Math.round(n))
}

/** Format expiry string (YYYYMMDD or YYYYMM); strips non-digits for compatibility. */
export function fmtExpiry(expiry: string | null | undefined): string {
  if (!expiry || !expiry.trim()) return '—'
  const s = String(expiry).trim().replace(/\D/g, '')
  if (s.length === 8) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  if (s.length === 6) return `${s.slice(0, 4)}-${s.slice(4, 6)}`
  return String(expiry).trim()
}

/**
 * Days from today to expiry (negative if past). Expiry: YYYYMMDD or YYYYMM (last day of month).
 * Returns null if expiry is empty or invalid.
 */
export function daysUntilExpiry(expiry: string | null | undefined): number | null {
  if (!expiry || !String(expiry).trim()) return null
  const s = String(expiry).trim().replace(/\D/g, '')
  let expiryDate: Date
  if (s.length === 8) {
    const y = parseInt(s.slice(0, 4), 10)
    const m = parseInt(s.slice(4, 6), 10) - 1
    const d = parseInt(s.slice(6, 8), 10)
    if (Number.isNaN(y) || Number.isNaN(m) || Number.isNaN(d)) return null
    expiryDate = new Date(y, m, d)
  } else if (s.length === 6) {
    const y = parseInt(s.slice(0, 4), 10)
    const m = parseInt(s.slice(4, 6), 10) // 1-12
    if (Number.isNaN(y) || Number.isNaN(m)) return null
    expiryDate = new Date(y, m, 0) // day 0 of month m = last day of month (m-1)
  } else {
    return null
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  expiryDate.setHours(0, 0, 0, 0)
  const diffMs = expiryDate.getTime() - today.getTime()
  return Math.round(diffMs / (24 * 60 * 60 * 1000))
}

/** Format trade_date (YYYY-MM-DD string from API) for display. */
export function fmtTradeDate(tradeDate: string | null | undefined): string {
  if (tradeDate == null || String(tradeDate).trim() === '') return '—'
  const s = String(tradeDate).trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`
  return s
}

export function unixToDatetimeLocal(ts: number | string | null | undefined): string {
  if (ts == null) return ''
  const n = typeof ts === 'number' ? ts : Number(ts)
  if (!Number.isFinite(n)) return ''
  const d = new Date(n * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${day}T${h}:${min}`
}

export function datetimeLocalToUnix(value: string): number {
  if (!value || !value.trim()) return Math.floor(Date.now() / 1000)
  return Math.floor(new Date(value).getTime() / 1000)
}

export function getContractLabelParts(contract_key: string): { symbol: string; rightLabel: string } {
  const parts = contract_key.split('|')
  const symbol = parts[0]?.trim() || ''
  const right = (parts[4] ?? parts[parts.length - 1] ?? '').toString().toUpperCase()
  const rightLabel = right === 'C' ? 'CALL' : right === 'P' ? 'PUT' : right || ''
  return { symbol, rightLabel }
}
