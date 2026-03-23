import { useEffect, useMemo, useRef, useState } from 'react'
import { InfoTooltip } from '../../../components/InfoTooltip'
import type { SseQueueMetrics, SseQueueCategory } from '../../../api/monitor'

type Lamp = 'green' | 'yellow' | 'red' | 'none'

export type SseQueueCategoryKey = 'quotes' | 'daemon_logs' | 'server_logs' | 'celery_logs'

const ALL_CATEGORY_KEYS: SseQueueCategoryKey[] = ['quotes', 'daemon_logs', 'server_logs', 'celery_logs']

function categoryLamp(cat: SseQueueCategory): Lamp {
  if (cat.connection_count === 0) return 'none'
  if (cat.max_depth >= cat.maxsize * 0.9) return 'red'
  if (cat.max_depth >= cat.maxsize * 0.5) return 'yellow'
  return 'green'
}

function overallLamp(m: SseQueueMetrics | null, visibleKeys: SseQueueCategoryKey[]): Lamp {
  if (!m) return 'none'
  const lamps = visibleKeys.map((k) => categoryLamp(m[k]))
  if (lamps.includes('red')) return 'red'
  if (lamps.includes('yellow')) return 'yellow'
  if (lamps.every((l) => l === 'none')) return 'none'
  return 'green'
}

const CATEGORIES: { key: SseQueueCategoryKey; label: string }[] = [
  { key: 'quotes', label: 'Quotes' },
  { key: 'daemon_logs', label: 'Daemon logs' },
  { key: 'server_logs', label: 'Server logs' },
  { key: 'celery_logs', label: 'Celery logs' },
]

function resolveVisibleKeys(
  categoryKeys: SseQueueCategoryKey[] | undefined,
  excludeCategories: SseQueueCategoryKey[] | undefined,
): SseQueueCategoryKey[] {
  if (categoryKeys != null && categoryKeys.length > 0) {
    const set = new Set(categoryKeys)
    return ALL_CATEGORY_KEYS.filter((k) => set.has(k))
  }
  if (excludeCategories != null && excludeCategories.length > 0) {
    const ex = new Set(excludeCategories)
    return ALL_CATEGORY_KEYS.filter((k) => !ex.has(k))
  }
  return [...ALL_CATEGORY_KEYS]
}

export interface StatusSseQueuesPanelProps {
  className?: string
  /** If set, only these stream rows are shown. Takes precedence over excludeCategories. */
  categoryKeys?: SseQueueCategoryKey[]
  /** Hide these streams (ignored when categoryKeys is set). */
  excludeCategories?: SseQueueCategoryKey[]
  /** Panel heading (default: SSE Backlogs). */
  heading?: string
}

export function StatusSseQueuesPanel({
  className,
  categoryKeys,
  excludeCategories,
  heading = 'SSE Backlogs',
}: StatusSseQueuesPanelProps) {
  const [metrics, setMetrics] = useState<SseQueueMetrics | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    let cancelled = false
    async function poll() {
      try {
        const { fetchSseQueueMetrics } = await import('../../../api/monitor')
        const m = await fetchSseQueueMetrics()
        if (!cancelled) { setMetrics(m); setError(null) }
      } catch (e) {
        if (!cancelled) setError((e as Error).message || 'Fetch failed')
      }
    }
    poll()
    timerRef.current = setInterval(poll, 2000)
    return () => { cancelled = true; if (timerRef.current) clearInterval(timerRef.current) }
  }, [])

  const visibleKeys = useMemo(
    () => resolveVisibleKeys(categoryKeys, excludeCategories),
    [categoryKeys, excludeCategories],
  )
  const lamp = overallLamp(metrics, visibleKeys)
  const categoriesRows = useMemo(
    () => CATEGORIES.filter((c) => visibleKeys.includes(c.key)),
    [visibleKeys],
  )

  return (
    <div className={className ? `system-tab-panel ${className}` : 'system-tab-panel'}>
      <div className="daemon-header">
        <div className="daemon-header-main daemon-header-with-lamp">
          <h2 className="daemon-card-title page-title-with-tooltip">
            <span className={`title-inline-lamp lamp-icon ${lamp}`} title="SSE queue backlog" aria-hidden>
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M22 12h-4l-3 9L9 3 6 12H2" />
              </svg>
            </span>
            {heading}
            <InfoTooltip text="Per-connection asyncio queue depth for quotes and log SSE streams. High values indicate a slow browser or network." />
          </h2>
        </div>
      </div>

      {error && !metrics && (
        <p className="section-hint" style={{ color: 'var(--color-error)' }}>{error}</p>
      )}

      {metrics && (
        <div className="table-scroll-x">
        <table className="table-operations" style={{ fontSize: 'var(--font-size-sm, 0.8125rem)' }}>
          <thead>
            <tr>
              <th>Stream</th>
              <th style={{ textAlign: 'right' }}>Connections</th>
              <th style={{ textAlign: 'right' }}>Max size</th>
              <th style={{ textAlign: 'right' }}>Max depth</th>
              <th style={{ textAlign: 'right' }}>Total queued</th>
              <th>Per-connection</th>
            </tr>
          </thead>
          <tbody>
            {categoriesRows.map(({ key, label }) => {
              const cat = metrics[key]
              const cLamp = categoryLamp(cat)
              return (
                <tr key={key}>
                  <td>
                    <span className={`title-inline-lamp lamp-icon ${cLamp}`} aria-hidden>
                      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M22 12h-4l-3 9L9 3 6 12H2" />
                      </svg>
                    </span>{' '}
                    {label}
                  </td>
                  <td style={{ textAlign: 'right' }}>{cat.connection_count}</td>
                  <td style={{ textAlign: 'right' }}>{cat.maxsize}</td>
                  <td style={{ textAlign: 'right' }}>{cat.max_depth}</td>
                  <td style={{ textAlign: 'right' }}>{cat.total_queued}</td>
                  <td className="sse-depths-cell">
                    {cat.depths.length === 0
                      ? '—'
                      : cat.depths.map((d, i) => (
                          <span key={i} className={`sse-depth-badge ${d >= cat.maxsize * 0.9 ? 'hot' : d >= cat.maxsize * 0.5 ? 'warm' : ''}`}>
                            {d}
                          </span>
                        ))}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      )}

      {!metrics && !error && (
        <p className="section-hint">Loading…</p>
      )}
    </div>
  )
}
