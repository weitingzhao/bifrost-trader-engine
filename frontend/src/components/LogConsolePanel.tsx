import { useEffect, useRef, useState } from 'react'
import type { MouseEvent, ReactNode, RefObject } from 'react'
import { InfoTooltip } from './InfoTooltip'

type ConsoleStatus = 'idle' | 'connecting' | 'connected' | 'error'

type FetchLogsFn = (tail?: number) => Promise<{ lines: string[]; error?: string }>
type SubscribeLogsFn = (onLine: (line: string) => void, onError?: () => void) => () => void
type ClearLogsFn = () => Promise<{ ok: boolean; error?: string }>

export interface UseLogConsoleOptions {
  fetchLogs: FetchLogsFn
  subscribeLogs: SubscribeLogsFn
  clearLogs: ClearLogsFn
  initialHeightPx?: number
  initialMaxLines?: number
}

export interface LogConsoleController {
  lines: string[]
  status: ConsoleStatus
  heightPx: number
  consoleRef: RefObject<HTMLPreElement>
  selectAll: () => void
  clear: () => Promise<void>
  onResizeStart: (e: MouseEvent<HTMLDivElement>) => void
}

export interface LogConsolePanelProps {
  controller: LogConsoleController
  loadingText: string
  errorText: string
  emptyText: string
  infoTooltipText: string
  resizeAriaLabel: string
  clearTitle: string
  emptyStatus?: ReactNode
}

function parseConsoleLogLine(line: string): { level: 'error' | 'warning' | 'info' | 'debug' | 'default'; timePart: string | null; body: string } {
  const timeMatch = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:,\d+)?)\s+/)
  const timePart = timeMatch ? timeMatch[1] : null
  const body = timePart ? line.slice(timePart.length) : line
  if (/\[ERROR\]/i.test(line)) return { level: 'error', timePart, body }
  if (/\[WARN(ING)?\]/i.test(line)) return { level: 'warning', timePart, body }
  if (/\[INFO\]/i.test(line)) return { level: 'info', timePart, body }
  if (/\[DEBUG\]/i.test(line)) return { level: 'debug', timePart, body }
  return { level: 'default', timePart, body }
}

function renderConsoleLines(lines: string[]) {
  return lines.map((line, i) => {
    const { level, timePart, body } = parseConsoleLogLine(line)
    return (
      <span key={i} className={`celery-log-line celery-log--${level}`}>
        {i > 0 ? '\n' : null}
        {timePart != null ? <span className="celery-log-time">{timePart}</span> : null}
        {timePart != null ? ' ' : null}
        <span className="celery-log-body">{body || line}</span>
      </span>
    )
  })
}

export function useLogConsole({
  fetchLogs,
  subscribeLogs,
  clearLogs,
  initialHeightPx = 260,
  initialMaxLines = 50,
}: UseLogConsoleOptions): LogConsoleController {
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState<ConsoleStatus>('idle')
  const [heightPx, setHeightPx] = useState(initialHeightPx)
  const consoleRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let unsub: (() => void) | null = null
    let cancelled = false
    const limit = initialMaxLines
    setStatus('connecting')
    fetchLogs(limit)
      .then((res) => {
        if (cancelled) return
        const fetchedLines = res.lines ?? []
        const trimmed = fetchedLines.length > limit ? fetchedLines.slice(-limit) : fetchedLines
        setLines(trimmed)
        setStatus(res.error ? 'error' : 'connected')
        if (!res.error) {
          const nextUnsub = subscribeLogs(
            (line) => {
              if (cancelled) return
              setLines((prev) => [...prev, line].slice(-limit))
            },
            () => {
              if (!cancelled) setStatus('error')
            },
          )
          if (cancelled) {
            nextUnsub()
            return
          }
          unsub = nextUnsub
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('error')
      })
    return () => {
      cancelled = true
      if (unsub) unsub()
    }
  }, [fetchLogs, initialMaxLines, subscribeLogs])

  useEffect(() => {
    const el = consoleRef.current
    const container = el?.parentElement
    if (container) container.scrollTop = container.scrollHeight
  }, [lines.length])

  const selectAll = () => {
    const pre = consoleRef.current
    if (!pre) return
    const range = document.createRange()
    range.selectNodeContents(pre)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  const clear = async () => {
    await clearLogs()
    setLines([])
  }

  const onResizeStart = (e: MouseEvent<HTMLDivElement>) => {
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
  }

  return {
    lines,
    status,
    heightPx,
    consoleRef,
    selectAll,
    clear,
    onResizeStart,
  }
}

export function LogConsolePanel({
  controller,
  loadingText,
  errorText,
  emptyText,
  infoTooltipText,
  resizeAriaLabel,
  clearTitle,
  emptyStatus = null,
}: LogConsolePanelProps) {
  const { lines, status, heightPx, consoleRef, selectAll, clear, onResizeStart } = controller

  return (
    <div className="celery-console-wrap">
      <div
        className="celery-console-terminal"
        role="log"
        aria-live="polite"
        style={{ height: heightPx, minHeight: 120, maxHeight: 600 }}
      >
        <pre ref={consoleRef}>
          {status === 'connecting' && lines.length === 0
            ? loadingText
            : status === 'error'
              ? errorText
              : lines.length === 0
                ? emptyText
                : renderConsoleLines(lines)}
        </pre>
      </div>
      <div
        className="celery-console-resize-handle"
        role="separator"
        aria-label={resizeAriaLabel}
        onMouseDown={onResizeStart}
        title="Drag to resize height"
      />
      <div className="section-hint celery-console-status-line">
        <div className="celery-console-status-indicator">
          {status !== 'idle' && status !== 'connecting' ? (
            <span style={{ color: status === 'connected' ? 'var(--color-lamp-green)' : 'var(--color-lamp-red)', fontWeight: 600 }}>
              {status === 'connected' ? '● Live' : '● Disconnected'}
            </span>
          ) : emptyStatus}
        </div>
        <div className="celery-console-actions">
          <button
            type="button"
            className="btn-celery-console-clear"
            onClick={selectAll}
            title="Select all log text for copying"
          >
            Select All
          </button>
          <button
            type="button"
            className="btn-celery-console-clear"
            onClick={() => { void clear() }}
            title={clearTitle}
          >
            Clear
          </button>
          <InfoTooltip text={infoTooltipText} />
        </div>
      </div>
    </div>
  )
}
