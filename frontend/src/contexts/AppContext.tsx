import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import type { IbAccountSnapshot, StatusResponse, Operation, RealtimeQuote, SystemMessage } from '../types'
import {
  fetchStatus,
  fetchOperations,
  postRefreshAccounts,
  fetchQuotes,
  subscribeQuotes,
  fetchBarsBenchmark,
  fetchSystemMessages,
  subscribeSystemMessages,
} from '../api'
import { fetchOpsWorkers, fetchQueueSummary } from '../api/ops/ops'
import {
  celeryQueuePendingBadgeTotal,
  computeCeleryRuntimeLamp,
  supportedQueueNamesFromSummary,
} from '../utils/celeryRuntime'
import {
  mergeQuotesIntoSymbolMap,
  normalizeBenchmarkMap,
  type DailyBenchmark,
} from '../views/accounts/accountsUtils'
import {
  IB_CONNECTION_MSG_AUTO_DISMISS_SEC,
  IB_OPERATOR_COMMAND_LIFETIME_SEC,
  SYSTEM_MESSAGE_BACKEND_TTL_SEC,
  isIbOperatorCommandMessage,
} from '../utils/systemMessageLifecycle'

export type LampId = 'green' | 'yellow' | 'red' | 'none'

const SYSTEM_MESSAGE_BOOTSTRAP_LIMIT = 50

function mergeSystemMessages(prev: SystemMessage[], incoming: SystemMessage[]): SystemMessage[] {
  const deduped = new Map<string, SystemMessage>()
  for (const message of [...incoming, ...prev]) {
    if (!message || typeof message.message_id !== 'string' || !message.message_id) continue
    deduped.set(message.message_id, message)
  }
  const cutoff = Date.now() / 1000 - SYSTEM_MESSAGE_BACKEND_TTL_SEC
  return Array.from(deduped.values())
    .filter((m) => Number(m.occurred_at || 0) > cutoff)
    .sort((a, b) => Number(b.occurred_at || 0) - Number(a.occurred_at || 0))
}

export interface AppContextValue {
  status: StatusResponse | null
  loadStatus: () => Promise<StatusResponse | null>
  operations: Operation[]
  accountsDisplay: IbAccountSnapshot[] | null
  ibAccountIndex: number
  setIbAccountIndex: (v: number) => void
  ibAccountsRefreshing: boolean
  accountsRefreshFeedback: string | null
  onRefreshAccounts: () => Promise<void>
  quotesMap: Record<string, RealtimeQuote>
  liveLampClock: number
  benchmarks: Record<string, DailyBenchmark>
  celeryRuntimeLampOverride: LampId | null
  celeryQueuePendingTotal: number | null
  systemMessages: SystemMessage[]
  msgDismissedIds: Set<string>
  dismissMessage: (id: string) => void
  dismissAllMessages: () => void
}

const AppCtx = createContext<AppContextValue | null>(null)

export function useApp(): AppContextValue {
  const ctx = useContext(AppCtx)
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>')
  return ctx
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { data: status = null, refetch: refetchStatus } = useQuery({
    queryKey: ['monitor', 'status'],
    queryFn: async (): Promise<StatusResponse | null> => {
      try {
        return await fetchStatus()
      } catch {
        return null
      }
    },
    refetchInterval: 5000,
    staleTime: 4000,
  })

  const loadStatus = useCallback(async () => {
    const r = await refetchStatus()
    return (r.data as StatusResponse | null | undefined) ?? null
  }, [refetchStatus])

  const { data: operations = [] } = useQuery({
    queryKey: ['monitor', 'operations'],
    queryFn: async (): Promise<Operation[]> => {
      try {
        const j = await fetchOperations(20)
        return j.operations || []
      } catch {
        return []
      }
    },
    refetchInterval: 10_000,
    staleTime: 8000,
  })

  const { data: celeryAggregate } = useQuery({
    queryKey: ['ops', 'celeryRuntime'],
    queryFn: async () => {
      try {
        const [wRes, qRes] = await Promise.all([fetchOpsWorkers(), fetchQueueSummary()])
        const supported = supportedQueueNamesFromSummary(qRes.ok ? qRes.queues : [])
        const brokerOk = wRes.ok && wRes.broker?.connected === true
        const wrks = wRes.ok ? wRes.workers : []
        const lamp = computeCeleryRuntimeLamp(brokerOk, wrks, supported)
        const pendingTotal =
          qRes.ok && qRes.queues.length > 0 ? celeryQueuePendingBadgeTotal(qRes.queues) : null
        return { lamp, pendingTotal }
      } catch {
        return { lamp: null as LampId | null, pendingTotal: null as number | null }
      }
    },
    refetchInterval: 10_000,
    staleTime: 8000,
  })

  const celeryRuntimeLampOverride = celeryAggregate?.lamp ?? null
  const celeryQueuePendingTotal = celeryAggregate?.pendingTotal ?? null

  const [accountsDisplay, setAccountsDisplay] = useState<IbAccountSnapshot[] | null>(null)
  const [ibAccountIndex, setIbAccountIndex] = useState(0)
  const [ibAccountsRefreshing, setIbAccountsRefreshing] = useState(false)
  const [accountsRefreshFeedback, setAccountsRefreshFeedback] = useState<string | null>(null)
  const [quotesMap, setQuotesMap] = useState<Record<string, RealtimeQuote>>({})
  const [liveLampClock, setLiveLampClock] = useState(0)
  const [benchmarks, setBenchmarks] = useState<Record<string, DailyBenchmark>>({})
  const [systemMessages, setSystemMessages] = useState<SystemMessage[]>([])
  const [msgDismissedIds, setMsgDismissedIds] = useState<Set<string>>(() => new Set())

  const lastAccountsFetchedAtRef = useRef<number | null>(null)
  const ibAutoDismissTimersRef = useRef<Map<string, number>>(new Map())
  const ibOperatorCmdDismissTimersRef = useRef<Map<string, number>>(new Map())

  useEffect(() => {
    let cancelled = false
    fetchQuotes()
      .then((res) => {
        if (!cancelled && res.quotes?.length) {
          setQuotesMap((prev) => mergeQuotesIntoSymbolMap(prev, res.quotes!))
        }
      })
      .catch(() => {})
    const unsub = subscribeQuotes((q) => {
      setQuotesMap((prev) => mergeQuotesIntoSymbolMap(prev, [q]))
    })
    return () => { cancelled = true; unsub() }
  }, [])

  useEffect(() => {
    const id = setInterval(() => setLiveLampClock((c) => c + 1), 5000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const acc = status?.portfolio?.accounts
    if (acc != null && accountsDisplay === null) setAccountsDisplay(acc ? [...acc] : [])
  }, [status?.portfolio?.accounts, accountsDisplay])

  useEffect(() => {
    const acc = status?.portfolio?.accounts
    const fetchedAt = status?.portfolio?.accounts_fetched_at
    if (acc == null || fetchedAt == null) return
    if (accountsDisplay !== null && fetchedAt !== lastAccountsFetchedAtRef.current) {
      lastAccountsFetchedAtRef.current = fetchedAt
      setAccountsDisplay([...acc])
    } else if (accountsDisplay === null) {
      lastAccountsFetchedAtRef.current = fetchedAt
    }
  }, [status?.portfolio?.accounts, status?.portfolio?.accounts_fetched_at, accountsDisplay])

  useEffect(() => {
    const t = setInterval(() => {
      loadStatus().then((j) => {
        const a = j?.portfolio?.accounts
        setAccountsDisplay(a ? [...a] : [])
      })
    }, 60 * 60 * 1000)
    return () => clearInterval(t)
  }, [loadStatus])

  useEffect(() => {
    if (accountsRefreshFeedback == null) return
    const t = setTimeout(() => setAccountsRefreshFeedback(null), 5000)
    return () => clearTimeout(t)
  }, [accountsRefreshFeedback])

  useEffect(() => {
    let cancelled = false
    fetchSystemMessages(SYSTEM_MESSAGE_BOOTSTRAP_LIMIT)
      .then((res) => {
        if (cancelled || !Array.isArray(res.messages)) return
        if (res.messages.length > 0) {
          setSystemMessages((prev) => mergeSystemMessages(prev, res.messages))
        }
      })
      .catch(() => {})
    const unsub = subscribeSystemMessages((message) => {
      setSystemMessages((prev) => mergeSystemMessages(prev, [message]))
    })
    return () => { cancelled = true; unsub() }
  }, [])

  useEffect(() => {
    if (systemMessages.length === 0) return
    const oldestExpiry =
      Math.min(...systemMessages.map((m) => Number(m.occurred_at || 0))) * 1000 +
      SYSTEM_MESSAGE_BACKEND_TTL_SEC * 1000
    const delayMs = Math.max(5000, oldestExpiry - Date.now())
    const t = setTimeout(() => {
      const cutoff = Date.now() / 1000 - SYSTEM_MESSAGE_BACKEND_TTL_SEC
      setSystemMessages((prev) => prev.filter((m) => Number(m.occurred_at || 0) > cutoff))
    }, delayMs)
    return () => clearTimeout(t)
  }, [systemMessages])

  useEffect(() => {
    const timers = ibAutoDismissTimersRef.current
    const now = Date.now() / 1000
    for (const m of systemMessages) {
      if (m.topic !== 'ib.connection') continue
      if (timers.has(m.message_id)) continue
      const age = now - Number(m.occurred_at || 0)
      const delayMs = Math.max(0, (IB_CONNECTION_MSG_AUTO_DISMISS_SEC - age) * 1000)
      const id = m.message_id
      timers.set(id, window.setTimeout(() => {
        setMsgDismissedIds((prev) => new Set([...prev, id]))
        timers.delete(id)
      }, delayMs))
    }
    for (const [id, timer] of timers) {
      if (!systemMessages.some((m) => m.message_id === id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }
  }, [systemMessages])

  useEffect(() => {
    const timers = ibOperatorCmdDismissTimersRef.current
    const now = Date.now() / 1000
    for (const m of systemMessages) {
      if (!isIbOperatorCommandMessage(m)) continue
      if (timers.has(m.message_id)) continue
      const age = now - Number(m.occurred_at || 0)
      const delayMs = Math.max(0, (IB_OPERATOR_COMMAND_LIFETIME_SEC - age) * 1000)
      const id = m.message_id
      timers.set(id, window.setTimeout(() => {
        setMsgDismissedIds((prev) => new Set([...prev, id]))
        timers.delete(id)
      }, delayMs))
    }
    for (const [id, timer] of timers) {
      if (!systemMessages.some((msg) => msg.message_id === id)) {
        clearTimeout(timer)
        timers.delete(id)
      }
    }
  }, [systemMessages])

  /* Benchmark fetch — symbols derived from quotes + status watchlist + reference indices */
  useEffect(() => {
    const subscribed = status?.live_ui?.subscribed_tickers ?? []
    const quoteKeys = Object.keys(quotesMap)
    const watchlistSymbols = [...new Set([...subscribed, ...quoteKeys])].sort()
    const refIndices = status?.live_ui?.reference_indices?.map((r) => r.symbol) ?? []
    const benchmarkSymbols = [...new Set([...watchlistSymbols, ...refIndices])].sort()
    if (benchmarkSymbols.length === 0) { setBenchmarks({}); return }
    let cancelled = false
    fetchBarsBenchmark(benchmarkSymbols)
      .then((res) => { if (!cancelled) setBenchmarks(normalizeBenchmarkMap(res.benchmarks)) })
      .catch(() => { if (!cancelled) setBenchmarks({}) })
    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    status?.live_ui?.subscribed_tickers?.join(','),
    status?.live_ui?.reference_indices?.map(r => r.symbol).join(','),
    Object.keys(quotesMap).sort().join(','),
  ])

  const dismissMessage = useCallback((id: string) => {
    setMsgDismissedIds((prev) => new Set([...prev, id]))
  }, [])

  const dismissAllMessages = useCallback(() => {
    setMsgDismissedIds((prev) => {
      const next = new Set(prev)
      for (const m of systemMessages) next.add(m.message_id)
      return next
    })
  }, [systemMessages])

  const onRefreshAccounts = useCallback(async () => {
    setIbAccountsRefreshing(true)
    setAccountsRefreshFeedback(null)
    const requestedAt = Date.now() / 1000
    try {
      const res = await postRefreshAccounts()
      if (!res.ok) {
        setAccountsRefreshFeedback(res.error || 'Refresh request failed')
        return
      }
      let refreshed = false
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const j = await loadStatus()
        const ja = j?.portfolio?.accounts
        if (ja != null) setAccountsDisplay(ja ? [...ja] : [])
        const jf = j?.portfolio?.accounts_fetched_at
        if (jf != null && jf > requestedAt) {
          setAccountsRefreshFeedback('Refreshed')
          refreshed = true
          break
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      if (!refreshed) {
        setAccountsRefreshFeedback('Request sent; no data update detected yet. Try again later.')
      }
    } catch (e) {
      setAccountsRefreshFeedback(e instanceof Error ? e.message : 'Network or API error')
    } finally {
      setIbAccountsRefreshing(false)
    }
  }, [loadStatus])

  return (
    <AppCtx.Provider value={{
      status, loadStatus, operations,
      accountsDisplay, ibAccountIndex, setIbAccountIndex,
      ibAccountsRefreshing, accountsRefreshFeedback, onRefreshAccounts,
      quotesMap, liveLampClock, benchmarks,
      celeryRuntimeLampOverride, celeryQueuePendingTotal,
      systemMessages, msgDismissedIds, dismissMessage, dismissAllMessages,
    }}>
      {children}
    </AppCtx.Provider>
  )
}
