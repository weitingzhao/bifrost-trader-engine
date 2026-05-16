import type { Execution, StatusResponse } from '../../types'
import { isLedgerCashLikeCategory, isLedgerFixedIncomeCategory } from './ledgerStockCategoryBuckets'

/** Same key as Trade Ledger: `account_id|SYMBOL|STK|||` */
export function stkContractKey(symbol: string, accountId: string): string {
  return `${(accountId ?? '').trim()}|${(symbol ?? '').toString().trim().toUpperCase()}|STK|||`
}

export type StkLedgerBucket = 'stocks' | 'fixed_income' | 'cash_like'

/** Performance Calendar segmented control: options plus three STK buckets. */
export type PerformanceCalendarAssetTab = 'options' | StkLedgerBucket

/**
 * (account_id, contract_key) -> category name for positions (from GET /status).
 * Matches LedgerView `positionCategoryByAccountContract` construction.
 */
export function buildPositionCategoryByAccountContract(status: StatusResponse | null): Map<string, string> {
  const map = new Map<string, string>()
  const accounts = status?.portfolio?.accounts ?? []
  for (const acc of accounts) {
    const accountId = (acc.account_id ?? '').trim()
    const positions =
      (acc as { positions?: { account_id?: string; contract_key?: string; category?: string }[] }).positions ?? []
    for (const p of positions) {
      const ck = (p.contract_key ?? '').trim()
      if (accountId && ck) {
        const key = `${accountId}|${ck}`
        const name = (p as { category?: string }).category
        if (typeof name === 'string' && name.trim()) map.set(key, name.trim())
      }
    }
  }
  return map
}

/**
 * Stable string for React deps: changes only when `buildPositionCategoryByAccountContract` would change
 * (same entries as the built Map). Avoids ref churn from GET /status polling.
 */
export function serializePositionCategoryKey(status: StatusResponse | null): string {
  const map = buildPositionCategoryByAccountContract(status)
  return [...map.entries()]
    .map(([k, v]) => `${k}|${v}`)
    .sort()
    .join('\n')
}

/**
 * Trade Ledger instrument buckets for STK executions (same rules as `stkInstrumentBucketExecs` in LedgerView).
 * Non-STK executions return `null`.
 */
export function getStkLedgerBucketForExecution(
  ex: Execution,
  positionCategoryByAccountContract: Map<string, string>,
): StkLedgerBucket | null {
  if ((ex.sec_type ?? '').toUpperCase() !== 'STK') return null
  const c =
    positionCategoryByAccountContract.get(stkContractKey(ex.symbol ?? '', ex.account_id ?? '')) ?? '—'
  if (isLedgerFixedIncomeCategory(c)) return 'fixed_income'
  if (isLedgerCashLikeCategory(c)) return 'cash_like'
  return 'stocks'
}

/** Sum unrealized_pnl from GET /status STK positions whose category resolves to `bucket`. */
export function sumStkUnrealizedPnlForBucket(
  status: StatusResponse | null,
  bucket: StkLedgerBucket,
): number | null {
  if (!status?.portfolio?.accounts) return null
  let sum = 0
  let any = false
  for (const acc of status.portfolio.accounts) {
    const accountId = (acc.account_id ?? '').trim()
    const positions =
      (acc as { positions?: Array<{ secType?: string; sec_type?: string; contract_key?: string; category?: string; unrealized_pnl?: number | null }> })
        .positions ?? []
    for (const p of positions) {
      const stRaw = (p.secType ?? p.sec_type ?? '').toString().trim().toUpperCase()
      if (stRaw !== 'STK') continue
      const ck = (p.contract_key ?? '').trim()
      if (!accountId || !ck) continue
      const catRaw = p.category
      const cat = typeof catRaw === 'string' && catRaw.trim() ? catRaw.trim() : '—'
      const b = bucketFromCategoryString(cat)
      if (b !== bucket) continue
      const u = p.unrealized_pnl
      if (u != null && typeof u === 'number' && Number.isFinite(u)) {
        sum += u
        any = true
      }
    }
  }
  return any ? sum : null
}

/** Sum current STK position market value from GET /status for one bucket. Uses |market value| as base. */
export function sumStkPositionMarketValueForBucket(
  status: StatusResponse | null,
  bucket: StkLedgerBucket,
): number | null {
  if (!status?.portfolio?.accounts) return null
  let sumAbsMv = 0
  let any = false
  for (const acc of status.portfolio.accounts) {
    const accountId = (acc.account_id ?? '').trim()
    const positions =
      (acc as {
        positions?: Array<{
          secType?: string
          sec_type?: string
          contract_key?: string
          category?: string
          market_value?: number | null
          position?: number | null
          price?: number | null
        }>
      }).positions ?? []
    for (const p of positions) {
      const stRaw = (p.secType ?? p.sec_type ?? '').toString().trim().toUpperCase()
      if (stRaw !== 'STK') continue
      const ck = (p.contract_key ?? '').trim()
      if (!accountId || !ck) continue
      const catRaw = p.category
      const cat = typeof catRaw === 'string' && catRaw.trim() ? catRaw.trim() : '—'
      const b = bucketFromCategoryString(cat)
      if (b !== bucket) continue
      const mvRaw = p.market_value
      const mv =
        mvRaw != null && Number.isFinite(Number(mvRaw))
          ? Number(mvRaw)
          : (Number(p.position) || 0) * (Number(p.price) || 0)
      if (Number.isFinite(mv) && Math.abs(mv) > 0) {
        sumAbsMv += Math.abs(mv)
        any = true
      }
    }
  }
  return any ? sumAbsMv : null
}

function bucketFromCategoryString(c: string): StkLedgerBucket {
  if (isLedgerFixedIncomeCategory(c)) return 'fixed_income'
  if (isLedgerCashLikeCategory(c)) return 'cash_like'
  return 'stocks'
}
