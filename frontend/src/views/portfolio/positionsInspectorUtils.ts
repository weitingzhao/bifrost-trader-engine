import type { LivePositionRow } from './types'

/** First non-OPT (stock) row matching symbol + account in the live snapshot list. */
export function findLiveStockRowForAccount(
  stocks: LivePositionRow[],
  symbol: string,
  accountId: string,
): LivePositionRow | null {
  const sym = (symbol ?? '').trim().toUpperCase()
  const acct = (accountId ?? '').trim()
  if (!sym || !acct) return null
  for (const s of stocks) {
    if ((s.secType ?? '').toUpperCase() === 'OPT') continue
    if ((s.symbol ?? '').trim().toUpperCase() !== sym) continue
    if ((s.account_id ?? '').trim() !== acct) continue
    return s
  }
  return null
}
