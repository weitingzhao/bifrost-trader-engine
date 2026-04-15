/** Shared expiration classification (matches main Option Discovery expiration table). */

export type ExpirationKind = 'all' | 'standard' | 'weeklies' | 'quarterlies'

export function parseExpirationDateParts(expiration: string): { y: number; m: number; d: number } | null {
  const s = (expiration || '').trim()
  if (!s) return null
  if (/^\d{8}$/.test(s)) {
    return {
      y: parseInt(s.slice(0, 4), 10),
      m: parseInt(s.slice(4, 6), 10) - 1,
      d: parseInt(s.slice(6, 8), 10),
    }
  }
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return null
  return {
    y: parseInt(match[1], 10),
    m: parseInt(match[2], 10) - 1,
    d: parseInt(match[3], 10),
  }
}

function getThirdFridayDay(year: number, month: number): number {
  const first = new Date(year, month, 1)
  const firstDow = first.getDay()
  const firstFriday = 1 + ((5 - firstDow + 7) % 7)
  return firstFriday + 14
}

export function classifyExpiration(expiration: string): Exclude<ExpirationKind, 'all'> {
  const parts = parseExpirationDateParts(expiration)
  if (!parts) return 'standard'
  const dt = new Date(parts.y, parts.m, parts.d)
  if (Number.isNaN(dt.getTime())) return 'standard'
  const isFriday = dt.getDay() === 5
  if (!isFriday) return 'standard'
  const thirdFriday = getThirdFridayDay(parts.y, parts.m)
  const isThirdFriday = parts.d === thirdFriday
  if (!isThirdFriday) return 'weeklies'
  const quarterMonths = [2, 5, 8, 11]
  if (quarterMonths.includes(parts.m)) return 'quarterlies'
  return 'standard'
}

export function expirationBadge(kind: Exclude<ExpirationKind, 'all'>): string {
  if (kind === 'weeklies') return 'W'
  if (kind === 'quarterlies') return 'Q'
  return ''
}

export function expirationKindLabel(kind: Exclude<ExpirationKind, 'all'>): string {
  if (kind === 'weeklies') return 'Weeklies'
  if (kind === 'quarterlies') return 'Quarterlies'
  return 'Standard'
}

export function expirationDaysFromToday(expiration: string): string {
  const parts = parseExpirationDateParts(expiration)
  if (!parts) return '—'
  const { y, m, d } = parts
  const expDate = new Date(y, m, d)
  if (Number.isNaN(expDate.getTime())) return '—'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  expDate.setHours(0, 0, 0, 0)
  const diffMs = expDate.getTime() - today.getTime()
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000))
  if (days < 0) return '—'
  return days === 1 ? '1 day' : `${days} days`
}
