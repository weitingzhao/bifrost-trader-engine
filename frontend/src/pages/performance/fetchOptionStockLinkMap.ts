import type { Execution, OptionStockLinkSummary } from '../../types'
import { postOptionStockLinksQuery } from '../../api'

/** Bulk-load option–stock link summaries for all OPT rows in `execs` (same batches as Trade Ledger). */
export async function fetchOptionStockLinkMapForExecutions(
  execs: Execution[],
): Promise<Record<number, OptionStockLinkSummary>> {
  const opt = execs.filter((e) => (e.sec_type ?? '').toUpperCase() === 'OPT')
  const byAccount = new Map<string, number[]>()
  for (const e of opt) {
    const id = e.account_executions_id
    const acc = (e.account_id ?? '').trim()
    if (id == null || !acc) continue
    if (!byAccount.has(acc)) byAccount.set(acc, [])
    byAccount.get(acc)!.push(id)
  }
  const batches = Array.from(byAccount.entries()).map(([account_id, option_account_executions_ids]) => ({
    account_id,
    option_account_executions_ids,
  }))
  if (batches.length === 0) return {}
  try {
    const res = await postOptionStockLinksQuery({ batches })
    const raw = res.by_option_id ?? {}
    const next: Record<number, OptionStockLinkSummary> = {}
    for (const [k, v] of Object.entries(raw)) {
      const num = Number(k)
      if (!Number.isFinite(num)) continue
      const summary = v as OptionStockLinkSummary
      next[num] = {
        links: summary.links ?? [],
        slippage_total: summary.slippage_total ?? null,
      }
    }
    return next
  } catch {
    return {}
  }
}
