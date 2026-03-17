import { useCallback, useMemo, useState } from 'react'
import type { Execution, StatusResponse } from '../../types'
import { fetchExecutions } from '../../api'

export const OFF_TRACK_ACCOUNT_ID = 'Off-Track'

export interface ExecutionStrategyFilters {
  strategy_opportunity_id?: number | null
  strategy_instance_id?: number | null
}

export function useExecutions(status: StatusResponse | null, filters?: ExecutionStrategyFilters) {
  const [executions, setExecutions] = useState<Execution[]>([])

  const loadReplayData = useCallback(async () => {
    try {
      const res = await fetchExecutions(
        undefined,
        undefined,
        0,
        false,
        filters?.strategy_opportunity_id ?? undefined,
        filters?.strategy_instance_id ?? undefined,
      )
      setExecutions(res.executions ?? [])
    } catch {
      setExecutions([])
    }
  }, [filters?.strategy_opportunity_id, filters?.strategy_instance_id])

  const executionAccountOptions = useMemo(() => {
    const fromStatus = ((status?.accounts as { account_id?: string }[] | undefined) ?? [])
      .map(a => (a.account_id ?? '').trim())
      .filter(Boolean)
    const fromExec = (executions || [])
      .map(e => (e.account_id ?? '').trim())
      .filter(Boolean)
    const merged = Array.from(new Set([...fromStatus, ...fromExec]))
    merged.sort().reverse()
    if (!merged.includes(OFF_TRACK_ACCOUNT_ID)) {
      merged.push(OFF_TRACK_ACCOUNT_ID)
    }
    return merged
  }, [status?.accounts, executions])

  return { executions, loadReplayData, executionAccountOptions }
}
