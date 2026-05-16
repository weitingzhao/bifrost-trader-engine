/** Normalize option expiry to digits-only (YYYYMMDD or YYYYMM) for stable tab keys and API calls. */
export function normalizeOptionExpiryDigits(expiry: string | null | undefined): string {
  const s = String(expiry ?? '').trim().replace(/\D/g, '')
  if (s.length >= 8) return s.slice(0, 8)
  if (s.length === 6) return s
  return s
}

export function normalizeOptionRightChar(right: string | null | undefined): 'C' | 'P' {
  const u = (right ?? 'C').toString().toUpperCase()
  if (u === 'P' || u === 'PUT') return 'P'
  return 'C'
}

/** Stable key for matching K-line option tabs ↔ execution rows ↔ contract groups. */
export function klineOptionTabKey(expiry: string, strike: number, optionRight: string): string {
  const exp = normalizeOptionExpiryDigits(expiry)
  const r = normalizeOptionRightChar(optionRight)
  const k = Number(strike)
  const strikeN = Number.isFinite(k) ? k : 0
  return `${exp}|${strikeN}|${r}`
}
