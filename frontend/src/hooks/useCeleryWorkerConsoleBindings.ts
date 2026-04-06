import { useCallback, useEffect, useState } from 'react'
import type { StatusResponse } from '../types'
import { fetchCeleryLogs, subscribeCeleryLogs, clearCeleryLogs } from '../api'

/**
 * Binds Celery console API to `/status` `celery.workers` list: one Redis stream per worker nodename.
 */
export function useCeleryWorkerConsoleBindings(
  status: StatusResponse | null | undefined,
  baseEnabled: boolean,
) {
  const workers = status?.celery?.workers ?? []
  const [selectedWorkerId, setSelectedWorkerId] = useState<string | null>(null)

  useEffect(() => {
    if (workers.length === 0) {
      setSelectedWorkerId(null)
      return
    }
    setSelectedWorkerId(prev => (prev && workers.includes(prev) ? prev : workers[0]))
  }, [workers])

  const fetchLogs = useCallback(
    (tail?: number) => {
      if (!selectedWorkerId) return Promise.resolve({ lines: [] as string[] })
      return fetchCeleryLogs(selectedWorkerId, tail ?? 50)
    },
    [selectedWorkerId],
  )

  const subscribeLogs = useCallback(
    (onLine: (line: string) => void, onError?: () => void) => {
      if (!selectedWorkerId) return () => {}
      return subscribeCeleryLogs(onLine, onError, selectedWorkerId)
    },
    [selectedWorkerId],
  )

  const clearLogs = useCallback(() => {
    if (!selectedWorkerId) {
      return Promise.resolve({ ok: false as boolean, error: 'No worker selected' })
    }
    return clearCeleryLogs(selectedWorkerId)
  }, [selectedWorkerId])

  return {
    workerIds: workers,
    selectedWorkerId,
    setSelectedWorkerId,
    fetchLogs,
    subscribeLogs,
    clearLogs,
    consoleEnabled: baseEnabled && !!selectedWorkerId,
  }
}
