import type { SepaReadinessCatalogEntry } from '../../api/research/dataReadiness'

export const SDP_GAP_DRAWER_PAGE = 350
/** Incremental append chunk for very large gap payloads (keeps drawer opening smooth). */
export const SDP_GAP_LAZY_APPEND_CHUNK = 500

export function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString()
}

export function fmtPct(num: number, denom: number): string {
  if (!denom) return '—'
  return ((num / denom) * 100).toFixed(1) + '%'
}

export function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const ms = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(ms / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  } catch {
    return '—'
  }
}

export function copyTextFallback(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    // ignore
  }
  document.body.removeChild(ta)
  return ok
}

/** Derive tag type from catalog object name */
export function sourceTag(entry: SepaReadinessCatalogEntry): { label: string; cls: string } {
  const obj = entry.object.toLowerCase()
  if (obj.includes('stock_readiness_daily')) return { label: 'SNAPSHOT', cls: 'sdp-source-tag--snapshot' }
  if (obj.includes('cache_stock_snapshot')) return { label: 'CACHE', cls: 'sdp-source-tag--snapshot' }
  if (obj.startsWith('public.v_') || obj.startsWith('v_')) return { label: 'VIEW', cls: 'sdp-source-tag--view' }
  return { label: 'TABLE', cls: 'sdp-source-tag--table' }
}

/** Split "public.some_table" into [schema, name] for styled display */
export function splitObject(obj: string): [string, string] {
  const dot = obj.indexOf('.')
  if (dot === -1) return ['', obj]
  return [obj.slice(0, dot + 1), obj.slice(dot + 1)]
}
