import { useEffect, useRef } from 'react'
import type { RefJobTrackItem } from './stockReferenceJobHelpers'
import {
  countActiveRefJobs,
  formatRefJobIdShort,
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

function formatEnqueueTime(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' })
  } catch {
    return '—'
  }
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
  const sorted = [...items].sort((a, b) => b.enqueuedAt - a.enqueuedAt)

  return (
    <div
      className="ref-jobs-sheet-backdrop"
      role="presentation"
      onClick={onClose}
    >
      <aside
        ref={asideRef}
        className="ref-jobs-sheet ref-jobs-sheet--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ref-jobs-sheet-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="ref-jobs-sheet-title" className="ref-jobs-sheet-title">
            PostgreSQL sync jobs
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

        <div className="ref-jobs-sheet-table-wrap">
          {sorted.length === 0 ? (
            <p className="ref-jobs-sheet-empty">Enqueue a job to see status here.</p>
          ) : (
            <table className="ref-jobs-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Kind</th>
                  <th scope="col">Status</th>
                  <th scope="col">Dedup</th>
                  <th scope="col">Job ID</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(item => {
                  const tone = statusTone(item.streamError ? 'failed' : item.status)
                  const statusLabel = item.streamError ? 'failed' : item.status
                  return (
                    <tr key={item.jobId} className="ref-jobs-table-row">
                      <td className="ref-jobs-table-time">{formatEnqueueTime(item.enqueuedAt)}</td>
                      <td className="ref-jobs-table-kind">{refJobKindShortLabel(item.kind)}</td>
                      <td>
                        <span
                          className={`ref-jobs-sheet-status ref-jobs-sheet-status--${tone}`}
                          title="Job status"
                        >
                          {statusLabel}
                        </span>
                        {item.streamError ? (
                          <p className="ref-jobs-table-stream-err" role="alert">
                            {item.streamError}
                          </p>
                        ) : null}
                      </td>
                      <td className="ref-jobs-table-dedup">{item.deduplicated ? 'Yes' : '—'}</td>
                      <td className="ref-jobs-table-id-cell">
                        <code className="ref-jobs-table-job-id" title={item.jobId}>
                          {formatRefJobIdShort(item.jobId)}
                        </code>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm ref-jobs-table-copy"
                          onClick={() => {
                            void navigator.clipboard?.writeText(item.jobId).catch(() => {})
                          }}
                        >
                          Copy
                        </button>
                      </td>
                      <td className="ref-jobs-table-summary">{summarizeRefJobResult(item.job)}</td>
                      <td className="ref-jobs-table-details-cell">
                        {item.job?.result != null ? (
                          <details className="feed-massive-details-debug ref-jobs-sheet-details">
                            <summary>JSON</summary>
                            <pre className="feed-massive-pre-json" tabIndex={0} style={{ maxHeight: '10rem' }}>
                              {typeof item.job.result === 'string'
                                ? item.job.result
                                : JSON.stringify(item.job.result, null, 2)}
                            </pre>
                          </details>
                        ) : (
                          <span className="ref-jobs-table-dash">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
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
