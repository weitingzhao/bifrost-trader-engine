import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, RefObject } from 'react'
import {
  clearDocsLogs,
  clearMonitorLogs,
  clearOpsLogs,
  fetchDocsLogs,
  fetchMonitorLogs,
  fetchOpsLogs,
  subscribeDocsLogs,
  subscribeMonitorLogs,
  subscribeOpsLogs,
} from '../api/monitor/logs'
import type { UnifiedAggregatedLogConsoleController, UnifiedLogConsoleEntry } from './unifiedLogConsoleTypes'

export type ArchitectureLogSource = 'monitor' | 'docs' | 'ops'

export interface UseArchitectureUnifiedLogConsoleOptions {
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
  monitor: true,
  docs: true,
  ops: true,
}

export function useArchitectureUnifiedLogConsole({
  initialHeightPx = 280,
  initialMaxLines = 50,
  enabled = true,
}: UseArchitectureUnifiedLogConsoleOptions): UnifiedAggregatedLogConsoleController {
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

    const appendLine = (source: ArchitectureLogSource, line: string) => {
      if (cancelled) return
      idRef.current += 1
      setEntries((prev) => [...prev, { id: idRef.current, source, line }].slice(-limit))
    }

    const onStreamError = () => {
      if (!cancelled) {
        setLiveWarning('One or more log streams disconnected. Refresh the page to reconnect.')
      }
    }

    void Promise.allSettled([fetchMonitorLogs(limit), fetchDocsLogs(limit), fetchOpsLogs(limit)]).then(
      (results) => {
        if (cancelled) return

        const tailErrors: string[] = []
        const getLines = (idx: 0 | 1 | 2, label: string): string[] => {
          const r = results[idx]
          if (r.status === 'rejected') {
            tailErrors.push(`${label} tail: request failed`)
            return []
          }
          const v = r.value
          if (v.error) tailErrors.push(`${label} tail: ${v.error}`)
          return Array.isArray(v.lines) ? v.lines : []
        }

        const monitorLines = getLines(0, 'Monitor')
        const docsLines = getLines(1, 'Docs')
        const opsLines = getLines(2, 'Ops')

        const merged = mergeInitial(
          [
            { source: 'monitor', lines: monitorLines },
            { source: 'docs', lines: docsLines },
            { source: 'ops', lines: opsLines },
          ],
          limit,
        )

        const withIds: UnifiedLogConsoleEntry[] = merged.map((e) => {
          idRef.current += 1
          return { id: idRef.current, source: e.source, line: e.line }
        })
        setEntries(withIds)

        const allRejected = results.every((r) => r.status === 'rejected')
        if (allRejected) {
          setStatus('error')
          setErrorDetail('Could not load logs from any source. Check Monitor API and Redis.')
          return
        }

        setStatus('connected')
        if (tailErrors.length) {
          setErrorDetail(tailErrors.join('. '))
        }

        streamUnsubsRef.current.push(subscribeMonitorLogs((line) => appendLine('monitor', line), onStreamError))
        streamUnsubsRef.current.push(subscribeDocsLogs((line) => appendLine('docs', line), onStreamError))
        streamUnsubsRef.current.push(subscribeOpsLogs((line) => appendLine('ops', line), onStreamError))
      },
    )

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
    const settled = await Promise.allSettled([clearMonitorLogs(), clearDocsLogs(), clearOpsLogs()])
    const msgs: string[] = []
    const labels = ['Monitor', 'Docs', 'Ops'] as const
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
