import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from 'react'
import { postTickerReferenceJob, subscribeMassiveJobEvents, type TickerReferenceJobKind } from '../../api'
import { TickerReferenceJobsSheet } from './TickerReferenceJobsSheet'
import {
  MAX_REF_JOBS_TRACKED,
  countActiveRefJobs,
  isRefJobTerminal,
  type RefJobTrackItem,
  type TrackedMassiveDbJobKind,
} from './stockReferenceJobHelpers'

function trimRefJobItems(
  items: RefJobTrackItem[],
  closers: MutableRefObject<Map<string, () => void>>,
): RefJobTrackItem[] {
  if (items.length <= MAX_REF_JOBS_TRACKED) return items
  const sorted = [...items].sort((a, b) => a.enqueuedAt - b.enqueuedAt)
  while (sorted.length > MAX_REF_JOBS_TRACKED) {
    const ev = sorted.shift()!
    closers.current.get(ev.jobId)?.()
    closers.current.delete(ev.jobId)
  }
  return sorted
}

export type MassiveRefJobSessionApi = {
  refJobItems: RefJobTrackItem[]
  jobsSheetOpen: boolean
  setJobsSheetOpen: (open: boolean) => void
  openJobsSheet: () => void
  activeJobCount: number
  /** Non-null while a ticker-reference or stock OHLC HTTP enqueue is in flight. */
  jobBusyKind: TrackedMassiveDbJobKind | null
  enqueueTickerReferenceJob: (
    kind: TickerReferenceJobKind,
    payload: Record<string, unknown>,
    priority?: string,
  ) => Promise<{ ok: boolean; error?: string; job_id?: string; deduplicated?: boolean }>
  /** Call after successful `postMassiveSync('feed_stocks_aggregate', …)` — adds row, opens sheet, subscribes to SSE. */
  trackStockOhlcSyncJob: (res: { job_id?: string; deduplicated?: boolean }) => void
  /** Wrap `postMassiveSync` so ticker reference UI is disabled while the request runs (same as Universe enqueue). */
  withStockOhlcHttp: <T,>(fn: () => Promise<T>) => Promise<T>
  handleClearCompletedJobs: () => void
  handleClearAllJobs: () => void
}

const MassiveRefJobSessionContext = createContext<MassiveRefJobSessionApi | null>(null)

export function useMassiveRefJobSession(): MassiveRefJobSessionApi {
  const v = useContext(MassiveRefJobSessionContext)
  if (!v) {
    throw new Error('useMassiveRefJobSession must be used within MassiveRefJobSessionProvider')
  }
  return v
}

export function MassiveRefJobSessionProvider({ children }: { children: ReactNode }) {
  const [refJobItems, setRefJobItems] = useState<RefJobTrackItem[]>([])
  const [jobsSheetOpen, setJobsSheetOpen] = useState(false)
  const [jobBusyKind, setJobBusyKind] = useState<TrackedMassiveDbJobKind | null>(null)

  const sseClosersRef = useRef<Map<string, () => void>>(new Map())

  useEffect(
    () => () => {
      sseClosersRef.current.forEach(close => close())
      sseClosersRef.current.clear()
    },
    [],
  )

  const startJobStream = useCallback((jid: string) => {
    if (sseClosersRef.current.has(jid)) return
    const sub = subscribeMassiveJobEvents(
      jid,
      data => {
        setRefJobItems(prev =>
          prev.map(row => {
            if (row.jobId !== jid) return row
            if (!data.ok) {
              sseClosersRef.current.delete(jid)
              return {
                ...row,
                streamError: data.error ?? 'Job stream error',
                status: 'failed',
              }
            }
            const j = data.job
            const st = (j?.status ?? '').trim() || 'running'
            const stLower = st.toLowerCase()
            if (stLower === 'done' || stLower === 'failed') {
              sseClosersRef.current.delete(jid)
            }
            return {
              ...row,
              status: st,
              job: j,
              streamError: row.streamError,
            }
          }),
        )
      },
      { timeoutSec: 86400 },
    )
    sseClosersRef.current.set(jid, sub.close)
  }, [])

  const pushJob = useCallback(
    (params: {
      jobId: string
      kind: TrackedMassiveDbJobKind
      deduplicated: boolean
      domain: RefJobTrackItem['domain']
    }) => {
      const { jobId, kind, deduplicated, domain } = params
      const now = Date.now()
      setRefJobItems(prev => {
        const idx = prev.findIndex(x => x.jobId === jobId)
        let next: RefJobTrackItem[]
        if (idx >= 0) {
          next = [...prev]
          next[idx] = {
            ...next[idx],
            kind,
            domain,
            deduplicated,
            status: deduplicated ? 'deduplicated (waiting)' : 'enqueued',
            streamError: undefined,
            job: undefined,
            enqueuedAt: next[idx].enqueuedAt,
          }
        } else {
          next = [
            ...prev,
            {
              jobId,
              kind,
              domain,
              deduplicated,
              status: deduplicated ? 'deduplicated (waiting)' : 'enqueued',
              enqueuedAt: now,
            },
          ]
        }
        return trimRefJobItems(next, sseClosersRef)
      })
      setJobsSheetOpen(true)
      startJobStream(jobId)
    },
    [startJobStream],
  )

  const enqueueTickerReferenceJob = useCallback(
    async (kind: TickerReferenceJobKind, payload: Record<string, unknown>, priority?: string) => {
      setJobBusyKind(kind)
      try {
        const res = await postTickerReferenceJob({
          kind,
          payload,
          ...(priority ? { priority } : {}),
        })
        if (!res.ok) {
          return { ok: false as const, error: res.error ?? 'Enqueue failed' }
        }
        const jid = res.job_id
        if (jid) {
          pushJob({
            jobId: jid,
            kind,
            deduplicated: Boolean(res.deduplicated),
            domain: 'tickers',
          })
        }
        return {
          ok: true as const,
          job_id: jid,
          deduplicated: res.deduplicated,
        }
      } finally {
        setJobBusyKind(null)
      }
    },
    [pushJob],
  )

  const trackStockOhlcSyncJob = useCallback(
    (res: { job_id?: string; deduplicated?: boolean }) => {
      const jid = res.job_id
      if (!jid) return
      pushJob({
        jobId: jid,
        kind: 'feed_stocks_aggregate',
        deduplicated: Boolean(res.deduplicated),
        domain: 'ohlc',
      })
    },
    [pushJob],
  )

  const withStockOhlcHttp = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    setJobBusyKind('feed_stocks_aggregate')
    try {
      return await fn()
    } finally {
      setJobBusyKind(null)
    }
  }, [])

  const handleClearCompletedJobs = useCallback(() => {
    setRefJobItems(prev => prev.filter(i => !isRefJobTerminal(i)))
  }, [])

  const handleClearAllJobs = useCallback(() => {
    sseClosersRef.current.forEach(close => close())
    sseClosersRef.current.clear()
    setRefJobItems([])
  }, [])

  const activeJobCount = useMemo(() => countActiveRefJobs(refJobItems), [refJobItems])

  const openJobsSheet = useCallback(() => setJobsSheetOpen(true), [])

  const value = useMemo<MassiveRefJobSessionApi>(
    () => ({
      refJobItems,
      jobsSheetOpen,
      setJobsSheetOpen,
      openJobsSheet,
      activeJobCount,
      jobBusyKind,
      enqueueTickerReferenceJob,
      trackStockOhlcSyncJob,
      withStockOhlcHttp,
      handleClearCompletedJobs,
      handleClearAllJobs,
    }),
    [
      refJobItems,
      jobsSheetOpen,
      openJobsSheet,
      activeJobCount,
      jobBusyKind,
      enqueueTickerReferenceJob,
      trackStockOhlcSyncJob,
      withStockOhlcHttp,
      handleClearCompletedJobs,
      handleClearAllJobs,
    ],
  )

  return (
    <MassiveRefJobSessionContext.Provider value={value}>
      {children}
      <TickerReferenceJobsSheet
        open={jobsSheetOpen}
        onClose={() => setJobsSheetOpen(false)}
        items={refJobItems}
        onClearCompleted={handleClearCompletedJobs}
        onClearAll={handleClearAllJobs}
      />
    </MassiveRefJobSessionContext.Provider>
  )
}
