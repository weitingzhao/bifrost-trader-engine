import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import {
  clearPortfolioLogs,
  clearTradingLogs,
  fetchPortfolioLogs,
  fetchTradingLogs,
  subscribePortfolioLogs,
  subscribeTradingLogs,
} from '../api/monitor/logs'
import type { UnifiedAggregatedLogConsoleController, UnifiedLogConsoleEntry } from './unifiedLogConsoleTypes'

export type AccountLogSource = 'trading' | 'portfolio'

export interface UseAccountUnifiedLogConsoleOptions {
  initialHeightPx?: number
  initialMaxLines?: number
  enabled?: boolean
}

const TIME_PREFIX_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d+)?)/

function sortKeyForLine(line: string): string {
  const m = line.match(TIME_PREFIX_RE)
  return m ? m[1] : '\uFFFF'
}

function mergeInitial(
  batches: { source: string; lines: string[] }[],
  limit: number,
): { source: string; line: string }[] {
  const flat = batches.flatMap(({ source, lines }) =>
    lines.map((line) => ({
      source,
      line,
      sk: sortKeyForLine(line),
    })),
  )
  flat.sort((a, b) => {
    const c = a.sk.localeCompare(b.sk)
    if (c !== 0) return c
    return a.line.localeCompare(b.line)
  })
  return flat.slice(-limit).map(({ source, line }) => ({ source, line }))
}

const DEFAULT_SOURCES_ENABLED: Record<string, boolean> = {
  trading: true,
  portfolio: true,
}

export function useAccountUnifiedLogConsole({
  initialHeightPx = 280,
  initialMaxLines = 50,
  enabled = true,
}: UseAccountUnifiedLogConsoleOptions): UnifiedAggregatedLogConsoleController {
  const [entries, setEntries] = useState<UnifiedLogConsoleEntry[]>([])
  const [sourcesEnabled, setSourcesEnabled] = useState<Record<string, boolean>>(() => ({
    ...DEFAULT_SOURCES_ENABLED,
  }))
  const [status, setStatus] = useState<UnifiedAggregatedLogConsoleController['status']>('idle')
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [liveWarning, setLiveWarning] = useState<string | null>(null)
  const [clearError, setClearError] = useState<string | null>(null)
  const [heightPx, setHeightPx] = useState(initialHeightPx)
  const consoleRef = useRef<HTMLPreElement>(null)
  const idRef = useRef(0)
  const streamUnsubsRef = useRef<Array<() => void>>([])

  const filteredEntries = useMemo(
    () => entries.filter((e) => sourcesEnabled[e.source] !== false),
    [entries, sourcesEnabled],
  )

  const toggleLogSource = useCallback((source: string) => {
    setSourcesEnabled((prev) => {
      if (!(source in prev)) return prev
      return { ...prev, [source]: !prev[source] }
    })
  }, [])

  useEffect(() => {
    if (!enabled) {
      setStatus('idle')
      setErrorDetail(null)
      setLiveWarning(null)
      setClearError(null)
      setEntries([])
      return
    }
    let cancelled = false
    streamUnsubsRef.current.forEach((u) => {
      u()
    })
    streamUnsubsRef.current = []
    const limit = initialMaxLines
    setEntries([])
    setErrorDetail(null)
    setLiveWarning(null)
    setClearError(null)
    setStatus('connecting')
    idRef.current = 0

    const appendLine = (source: AccountLogSource, line: string) => {
      if (cancelled) return
      idRef.current += 1
      setEntries((prev) => [...prev, { id: idRef.current, source, line }].slice(-limit))
    }

    const onStreamError = () => {
      if (!cancelled) {
        setLiveWarning('One or more log streams disconnected. Refresh the page to reconnect.')
      }
    }

    void Promise.allSettled([fetchTradingLogs(limit), fetchPortfolioLogs(limit)]).then((results) => {
      if (cancelled) return

      const tailSucceeded = (
        result: PromiseSettledResult<{ lines: string[]; error?: string }>,
      ): boolean => {
        if (result.status === 'rejected') return false
        const v = result.value
        const lines = Array.isArray(v.lines) ? v.lines : []
        if (lines.length > 0) return true
        return !v.error
      }
      const anyTailOk = results.some(tailSucceeded)

      const tailErrors: string[] = []
      const getLines = (idx: 0 | 1, label: string): string[] => {
        const r = results[idx]
        if (r.status === 'rejected') {
          tailErrors.push(`${label} tail: request failed`)
          return []
        }
        const v = r.value
        if (v.error) tailErrors.push(`${label} tail: ${v.error}`)
        return Array.isArray(v.lines) ? v.lines : []
      }

      const tradingLines = getLines(0, 'Trading')
      const portfolioLines = getLines(1, 'Portfolio')

      const merged = mergeInitial(
        [
          { source: 'trading', lines: tradingLines },
          { source: 'portfolio', lines: portfolioLines },
        ],
        limit,
      )

      const withIds: UnifiedLogConsoleEntry[] = merged.map((e) => {
        idRef.current += 1
        return { id: idRef.current, source: e.source, line: e.line }
      })
      setEntries(withIds)

      if (!anyTailOk) {
        setStatus('error')
        setErrorDetail(
          tailErrors.length
            ? tailErrors.join('. ')
            : 'Could not load logs from any source. Check Monitor API and Redis.',
        )
        return
      }

      setStatus('connected')
      if (tailErrors.length) {
        setErrorDetail(tailErrors.join('. '))
      }

      streamUnsubsRef.current.push(subscribeTradingLogs((line) => appendLine('trading', line), onStreamError))
      streamUnsubsRef.current.push(subscribePortfolioLogs((line) => appendLine('portfolio', line), onStreamError))
    })

    return () => {
      cancelled = true
      streamUnsubsRef.current.forEach((u) => {
        u()
      })
      streamUnsubsRef.current = []
    }
  }, [enabled, initialMaxLines])

  useEffect(() => {
    const el = consoleRef.current
    const container = el?.parentElement
    if (container) container.scrollTop = container.scrollHeight
  }, [filteredEntries.length, entries.length])

  const selectAll = useCallback(() => {
    const pre = consoleRef.current
    if (!pre) return
    const range = document.createRange()
    range.selectNodeContents(pre)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, [])

  const clearAllStreams = useCallback(async () => {
    setClearError(null)
    const settled = await Promise.allSettled([clearTradingLogs(), clearPortfolioLogs()])
    const msgs: string[] = []
    const labels = ['Trading', 'Portfolio'] as const
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        msgs.push(`${labels[i]}: clear failed`)
      } else if (!r.value.ok) {
        msgs.push(`${labels[i]}: ${r.value.error ?? 'clear failed'}`)
      }
    })
    if (msgs.length) setClearError(msgs.join('; '))
    setEntries([])
    setErrorDetail(null)
    setLiveWarning(null)
  }, [])

  const onResizeStart = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return
      const startY = e.clientY
      const startHeight = heightPx
      const onMove = (ev: globalThis.MouseEvent) => {
        const next = Math.min(600, Math.max(120, startHeight + (ev.clientY - startY)))
        setHeightPx(next)
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'ns-resize'
      document.body.style.userSelect = 'none'
    },
    [heightPx],
  )

  return {
    entries,
    filteredEntries,
    sourcesEnabled,
    toggleLogSource,
    status,
    errorDetail,
    liveWarning,
    clearError,
    heightPx,
    consoleRef: consoleRef as RefObject<HTMLPreElement>,
    selectAll,
    clearAllStreams,
    onResizeStart,
  }
}
