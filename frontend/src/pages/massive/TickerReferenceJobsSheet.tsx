import { useEffect, useRef } from 'react'
import type { RefJobTrackItem } from './stockReferenceJobHelpers'
import {
  countActiveRefJobs,
  isRefJobTerminal,
  refJobKindShortLabel,
  summarizeRefJobResult,
} from './stockReferenceJobHelpers'

function statusTone(status: string): 'ok' | 'err' | 'run' {
  const s = (status || '').toLowerCase()
  if (s === 'failed') return 'err'
  if (s === 'done') return 'ok'
  return 'run'
}

export function TickerReferenceJobsSheet({
  open,
  onClose,
  items,
  onClearCompleted,
  onClearAll,
}: {
  open: boolean
  onClose: () => void
  items: RefJobTrackItem[]
  onClearCompleted: () => void
  onClearAll: () => void
}) {
  const asideRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      asideRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  const activeN = countActiveRefJobs(items)
  const hasCompleted = items.some(isRefJobTerminal)

  return (
    <div
      className="ref-jobs-sheet-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <aside
        ref={asideRef}
        className="ref-jobs-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ref-jobs-sheet-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="ref-jobs-sheet-title" className="ref-jobs-sheet-title">
            Ticker reference jobs
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <p className="ref-jobs-sheet-meta">Session-only tracking. Updates via job stream.</p>

        <div className="ref-jobs-sheet-toolbar">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={onClearCompleted}
            disabled={!hasCompleted}
          >
            Clear completed
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClearAll} disabled={items.length === 0}>
            Clear all
          </button>
        </div>

        <div className="ref-jobs-sheet-list" role="list">
          {items.length === 0 ? (
            <p className="ref-jobs-sheet-empty">Enqueue a job to see status here.</p>
          ) : (
            [...items]
              .sort((a, b) => b.enqueuedAt - a.enqueuedAt)
              .map(item => {
                const tone = statusTone(item.streamError ? 'failed' : item.status)
                return (
                  <div key={item.jobId} className="ref-jobs-sheet-row" role="listitem">
                    <div className="ref-jobs-sheet-row-head">
                      <span className="ref-jobs-sheet-kind">{refJobKindShortLabel(item.kind)}</span>
                      <span
                        className={`ref-jobs-sheet-status ref-jobs-sheet-status--${tone}`}
                        title="Job status"
                      >
                        {item.streamError ? 'failed' : item.status}
                      </span>
                      {item.deduplicated ? (
                        <span className="ref-jobs-sheet-badge" title="Merged with an existing queued job">
                          Deduplicated
                        </span>
                      ) : null}
                    </div>
                    <div className="ref-jobs-sheet-row-id">
                      <code className="ref-jobs-sheet-job-id">{item.jobId}</code>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          void navigator.clipboard?.writeText(item.jobId).catch(() => {})
                        }}
                      >
                        Copy ID
                      </button>
                    </div>
                    {item.streamError ? (
                      <p className="status-page-msg err ref-jobs-sheet-err" role="alert">
                        {item.streamError}
                      </p>
                    ) : null}
                    <p className="ref-jobs-sheet-summary">
                      <span style={{ color: 'var(--color-text-muted)' }}>Summary</span> {summarizeRefJobResult(item.job)}
                    </p>
                    {item.job?.result != null ? (
                      <details className="feed-massive-details-debug ref-jobs-sheet-details">
                        <summary>Full result JSON</summary>
                        <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '12rem' }}>
                          {typeof item.job.result === 'string'
                            ? item.job.result
                            : JSON.stringify(item.job.result, null, 2)}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                )
              })
          )}
        </div>

        <div className="ref-jobs-sheet-footer">
          <p className="ref-jobs-sheet-footer-hint">
            {activeN > 0 ? `${activeN} active` : 'No active jobs'}
            {' · '}
            <button
              type="button"
              className="ref-jobs-sheet-link"
              onClick={() => {
                window.location.hash = '#settings-celery'
              }}
            >
              Full queue: Celery
            </button>
          </p>
        </div>
      </aside>
    </div>
  )
}
