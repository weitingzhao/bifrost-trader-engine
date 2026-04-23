import { InfoTooltip } from './InfoTooltip'
import { parseConsoleLogLine } from './LogConsolePanel'
import type { UnifiedAggregatedLogConsoleController, UnifiedLogSourceDefinition } from './unifiedLogConsoleTypes'

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

const DEFAULT_ARCHITECTURE_SOURCE_DEFINITIONS: UnifiedLogSourceDefinition[] = [
  { source: 'monitor', label: 'Monitor' },
  { source: 'ops', label: 'Ops' },
  { source: 'docs', label: 'Docs' },
]

function sourceLabel(definitions: UnifiedLogSourceDefinition[], source: string): string {
  return definitions.find((d) => d.source === source)?.label ?? source
}

function renderAggregatedLines(
  items: { id: number; source: string; line: string }[],
  definitions: UnifiedLogSourceDefinition[],
) {
  return items.map((item, i) => {
    const { level, timePart, body } = parseConsoleLogLine(item.line)
    return (
      <span key={`${item.source}-${item.id}-${i}`} className={`celery-log-line celery-log--${level}`}>
        {i > 0 ? '\n' : null}
        <span className={`architecture-log-source-tag architecture-log-source--${item.source}`} data-source={item.source}>
          [{sourceLabel(definitions, item.source)}]
        </span>
        {timePart != null ? (
          <>
            {' '}
            <span className="celery-log-time">{timePart}</span>
          </>
        ) : null}
        {timePart != null ? ' ' : ' '}
        <span className="celery-log-body">{body || item.line}</span>
      </span>
    )
  })
}

export interface AggregatedLogConsolePanelProps {
  controller: UnifiedAggregatedLogConsoleController
  loadingText: string
  errorText: string
  emptyText: string
  infoTooltipText: string
  resizeAriaLabel: string
  clearTitle: string
  /** When omitted, uses Monitor / Ops / Docs (Architecture page). */
  sourceDefinitions?: UnifiedLogSourceDefinition[]
}

export function AggregatedLogConsolePanel({
  controller,
  loadingText,
  errorText,
  emptyText,
  infoTooltipText,
  resizeAriaLabel,
  clearTitle,
  sourceDefinitions = DEFAULT_ARCHITECTURE_SOURCE_DEFINITIONS,
}: AggregatedLogConsolePanelProps) {
  const {
    filteredEntries,
    sourcesEnabled,
    toggleLogSource,
    status,
    errorDetail,
    liveWarning,
    clearError,
    heightPx,
    consoleRef,
    selectAll,
    clearAllStreams,
    onResizeStart,
  } = controller

  return (
    <div className="celery-console-wrap architecture-unified-console">
      <div className="architecture-console-filter-row">
        <span className="architecture-console-filter-label" id="architecture-log-source-label">
          Sources
        </span>
        <div className="architecture-source-bubbles" role="group" aria-labelledby="architecture-log-source-label">
          {sourceDefinitions.map(({ source, label }) => {
            const on = sourcesEnabled[source] !== false
            return (
              <button
                key={source}
                type="button"
                className={`architecture-source-bubble${on ? ' architecture-source-bubble--active' : ' architecture-source-bubble--off'}`}
                aria-pressed={on}
                aria-label={on ? `${label} API logs shown — click to hide` : `${label} API logs hidden — click to show`}
                onClick={() => toggleLogSource(source)}
              >
                {label}
              </button>
            )
          })}
        </div>
      </div>
      <div
        className="celery-console-terminal"
        role="log"
        aria-live="polite"
        style={{ height: heightPx, minHeight: 120, maxHeight: 600 }}
      >
        <pre ref={consoleRef}>
          {status === 'connecting' && filteredEntries.length === 0
            ? loadingText
            : status === 'error' && filteredEntries.length === 0
              ? `${errorText}${errorDetail ? `\n\n${errorDetail}` : ''}`
              : status === 'error' && filteredEntries.length > 0
                ? (
                    <>
                      {renderAggregatedLines(filteredEntries, sourceDefinitions)}
                      {'\n\n'}
                      <span className="celery-log-line celery-log--error">
                        {errorText}
                        {errorDetail ? ` ${errorDetail}` : ''}
                      </span>
                    </>
                  )
                : filteredEntries.length === 0
                  ? emptyText
                  : renderAggregatedLines(filteredEntries, sourceDefinitions)}
        </pre>
      </div>
      <div
        className="celery-console-resize-handle"
        role="separator"
        aria-label={resizeAriaLabel}
        onMouseDown={onResizeStart}
        title="Drag to resize height"
      />
      <div className="section-hint celery-console-status-line architecture-console-status-line">
        <div className="celery-console-status-indicator architecture-console-status-messages">
          {status !== 'idle' && status !== 'connecting' ? (
            <span
              style={{
                color: status === 'connected' ? 'var(--color-lamp-green)' : 'var(--color-lamp-red)',
                fontWeight: 600,
              }}
            >
              {status === 'connected' ? '● Live' : '● Disconnected'}
            </span>
          ) : null}
          {status === 'connected' && errorDetail ? (
            <span className="architecture-console-fetch-hint" role="status">
              {errorDetail}
            </span>
          ) : null}
          {liveWarning ? (
            <span className="architecture-console-warning" role="status">
              {liveWarning}
            </span>
          ) : null}
          {clearError ? (
            <span className="architecture-console-clear-err" role="alert">
              {clearError}
            </span>
          ) : null}
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
              void clearAllStreams()
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
