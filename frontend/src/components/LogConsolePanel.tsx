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
  enabled?: boolean
}

export interface LogConsoleController {
  lines: string[]
  status: ConsoleStatus
  /** Set when status is error (API message or network failure). */
  errorDetail: string | null
  heightPx: number
  consoleRef: RefObject<HTMLPreElement | null>
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

const CONSOLE_ICON_PX = 15
const CONSOLE_ICON_STROKE = 1.5

function LogConsoleSelectAllIcon() {
  return (
    <svg
      width={CONSOLE_ICON_PX}
      height={CONSOLE_ICON_PX}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CONSOLE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3 6h.01M3 12h.01M3 18h.01" />
    </svg>
  )
}

function LogConsoleClearIcon() {
  return (
    <svg
      width={CONSOLE_ICON_PX}
      height={CONSOLE_ICON_PX}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={CONSOLE_ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
      <line x1="10" x2="10" y1="11" y2="17" />
      <line x1="14" x2="14" y1="11" y2="17" />
    </svg>
  )
}

export function parseConsoleLogLine(line: string): { level: 'error' | 'warning' | 'info' | 'debug' | 'default'; timePart: string | null; body: string } {
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
  enabled = true,
}: UseLogConsoleOptions): LogConsoleController {
  const [lines, setLines] = useState<string[]>([])
  const [status, setStatus] = useState<ConsoleStatus>('idle')
  const [errorDetail, setErrorDetail] = useState<string | null>(null)
  const [heightPx, setHeightPx] = useState(initialHeightPx)
  const consoleRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    if (!enabled) {
      setStatus('idle')
      setErrorDetail(null)
      setLines([])
      return
    }
    let unsub: (() => void) | null = null
    let cancelled = false
    const limit = initialMaxLines
    setLines([])
    setErrorDetail(null)
    setStatus('connecting')
    fetchLogs(limit)
      .then((res) => {
        if (cancelled) return
        const fetchedLines = res.lines ?? []
        const trimmed = fetchedLines.length > limit ? fetchedLines.slice(-limit) : fetchedLines
        setLines(trimmed)
        if (res.error) {
          setErrorDetail(res.error)
          setStatus('error')
          return
        }
        setStatus('connected')
        const nextUnsub = subscribeLogs(
          (line) => {
            if (cancelled) return
            setLines((prev) => [...prev, line].slice(-limit))
          },
          () => {
            if (!cancelled) {
              setStatus('error')
              setErrorDetail('Live stream disconnected (retry by switching tab or refreshing).')
            }
          },
        )
        if (cancelled) {
          nextUnsub()
          return
        }
        unsub = nextUnsub
      })
      .catch(() => {
        if (!cancelled) {
          setStatus('error')
          setErrorDetail('Request failed (network or CORS). Check Monitor is reachable.')
        }
      })
    return () => {
      cancelled = true
      if (unsub) unsub()
    }
  }, [enabled, fetchLogs, initialMaxLines, subscribeLogs])

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
    setErrorDetail(null)
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
    errorDetail,
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
  const { lines, status, errorDetail, heightPx, consoleRef, selectAll, clear, onResizeStart } = controller

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
            : status === 'error' && lines.length === 0
              ? `${errorText}${errorDetail ? `\n\n${errorDetail}` : ''}`
              : status === 'error' && lines.length > 0
                ? (
                    <>
                      {renderConsoleLines(lines)}
                      {'\n\n'}
                      <span className="celery-log-line celery-log--error">
                        {errorText}
                        {errorDetail ? ` ${errorDetail}` : ''}
                      </span>
                    </>
                  )
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
            className="celery-queue-icon-btn celery-queue-icon-btn--refresh"
            onClick={selectAll}
            title="Select all log text for copying"
            aria-label="Select all log text for copying"
          >
            <LogConsoleSelectAllIcon />
          </button>
          <button
            type="button"
            className="celery-queue-icon-btn celery-queue-icon-btn--delete"
            onClick={() => {
              void clear()
            }}
            title={clearTitle}
            aria-label={clearTitle}
          >
            <LogConsoleClearIcon />
          </button>
          <InfoTooltip text={infoTooltipText} />
        </div>
      </div>
    </div>
  )
}
