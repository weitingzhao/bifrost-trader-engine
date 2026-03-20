import { useCallback, useMemo, useState } from 'react'
import type { Execution, StatusResponse } from '../../types'
import { fetchExecutions } from '../../api'

export const OFF_TRACK_ACCOUNT_ID = 'Off-Track'

export interface ExecutionStrategyFilters {
  strategy_opportunity_id?: number | null
  strategy_instance_id?: number | null
}

/**
 * @param loadBookForLedger When true (Trade ledger / LedgerView): load `performance_book`
 *   (`account_executions_final`) in parallel with the canonical GET /executions feed. Options
 *   (Contracts + Orphans) use the book feed only; Stocks use the canonical feed.
 * @param positionsSplitFeeds When true (Positions page): load `performance_book`, `tws_raw`, and in parallel
 *   the canonical `account_executions` view (for “contract exists in unified ledger” checks). `executions`
 *   remains final + tws concatenation for account pickers.
 */
export function useExecutions(
  status: StatusResponse | null,
  filters?: ExecutionStrategyFilters,
  loadBookForLedger = false,
  positionsSplitFeeds = false,
) {
  const [executions, setExecutions] = useState<Execution[]>([])
  const [executionsBook, setExecutionsBook] = useState<Execution[]>([])
  const [executionsFinal, setExecutionsFinal] = useState<Execution[]>([])
  const [executionsTws, setExecutionsTws] = useState<Execution[]>([])
  const [executionsCanonical, setExecutionsCanonical] = useState<Execution[]>([])

  const loadReplayData = useCallback(async () => {
    try {
      if (positionsSplitFeeds) {
        const [final, tws, canonical] = await Promise.all([
          fetchExecutions(
            undefined,
            undefined,
            0,
            false,
            filters?.strategy_opportunity_id ?? undefined,
            filters?.strategy_instance_id ?? undefined,
            'performance_book',
          ),
          fetchExecutions(
            undefined,
            undefined,
            0,
            false,
            filters?.strategy_opportunity_id ?? undefined,
            filters?.strategy_instance_id ?? undefined,
            'tws_raw',
          ),
          fetchExecutions(
            undefined,
            undefined,
            0,
            false,
            filters?.strategy_opportunity_id ?? undefined,
            filters?.strategy_instance_id ?? undefined,
          ),
        ])
        const f = final.executions ?? []
        const t = tws.executions ?? []
        setExecutionsFinal(f)
        setExecutionsTws(t)
        setExecutionsCanonical(canonical.executions ?? [])
        setExecutions([...f, ...t])
        setExecutionsBook([])
      } else if (loadBookForLedger) {
        const [full, book] = await Promise.all([
          fetchExecutions(
            undefined,
            undefined,
            0,
            false,
            filters?.strategy_opportunity_id ?? undefined,
            filters?.strategy_instance_id ?? undefined,
          ),
          fetchExecutions(
            undefined,
            undefined,
            0,
            false,
            filters?.strategy_opportunity_id ?? undefined,
            filters?.strategy_instance_id ?? undefined,
            'performance_book',
          ),
        ])
        setExecutions(full.executions ?? [])
        setExecutionsBook(book.executions ?? [])
        setExecutionsFinal([])
        setExecutionsTws([])
        setExecutionsCanonical([])
      } else {
        const res = await fetchExecutions(
          undefined,
          undefined,
          0,
          false,
          filters?.strategy_opportunity_id ?? undefined,
          filters?.strategy_instance_id ?? undefined,
        )
        setExecutions(res.executions ?? [])
        setExecutionsBook([])
        setExecutionsFinal([])
        setExecutionsTws([])
        setExecutionsCanonical([])
      }
    } catch {
      setExecutions([])
      setExecutionsBook([])
      setExecutionsFinal([])
      setExecutionsTws([])
      setExecutionsCanonical([])
    }
  }, [filters?.strategy_opportunity_id, filters?.strategy_instance_id, loadBookForLedger, positionsSplitFeeds])

  const executionAccountOptions = useMemo(() => {
    const fromStatus = ((status?.accounts as { account_id?: string }[] | undefined) ?? [])
      .map(a => (a.account_id ?? '').trim())
      .filter(Boolean)
    const fromExec = (executions || [])
      .map(e => (e.account_id ?? '').trim())
      .filter(Boolean)
    const fromBook = (executionsBook || [])
      .map(e => (e.account_id ?? '').trim())
      .filter(Boolean)
    const merged = Array.from(new Set([...fromStatus, ...fromExec, ...fromBook]))
    merged.sort().reverse()
    if (!merged.includes(OFF_TRACK_ACCOUNT_ID)) {
      merged.push(OFF_TRACK_ACCOUNT_ID)
    }
    return merged
  }, [status?.accounts, executions, executionsBook])

  return {
    executions,
    executionsBook,
    executionsFinal,
    executionsTws,
    executionsCanonical,
    loadReplayData,
    executionAccountOptions,
  }
}
