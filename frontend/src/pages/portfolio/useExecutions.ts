import { useCallback, useMemo, useState } from 'react'
import type { Execution, StatusResponse } from '../../types'
import { fetchExecutions } from '../../api'

export const OFF_TRACK_ACCOUNT_ID = 'Off-Track'

export function useExecutions(status: StatusResponse | null) {
  const [executions, setExecutions] = useState<Execution[]>([])

  const loadReplayData = useCallback(async () => {
    try {
      const res = await fetchExecutions(undefined, undefined, 0)
      setExecutions(res.executions ?? [])
    } catch {
      setExecutions([])
    }
  }, [])

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
