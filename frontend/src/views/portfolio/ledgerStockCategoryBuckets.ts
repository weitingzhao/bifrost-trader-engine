/**
 * Portfolio position category (IB / app) → Trade ledger STK buckets.
 * Matching is case-insensitive on substring / common aliases.
 */

export function isLedgerFixedIncomeCategory(category: string): boolean {
  const n = category.trim().toLowerCase()
  if (!n || n === '—') return false
  return n.includes('fixed income') || n.includes('fix income')
}

export function isLedgerCashLikeCategory(category: string): boolean {
  const n = category.trim().toLowerCase()
  if (!n || n === '—') return false
  if (isLedgerFixedIncomeCategory(category)) return false
  return (
    n.includes('cash like') ||
    n.includes('cash-like') ||
    n.includes('cash equivalent') ||
    n.includes('money market')
  )
}
