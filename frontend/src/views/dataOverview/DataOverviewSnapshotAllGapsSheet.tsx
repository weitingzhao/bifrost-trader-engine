import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import type { OptionSnapshotsContractsGapResult } from '../../api'
import type { DataOverviewOptionJobsBarHandle } from './DataOverviewOptionJobsBar'
import { Button } from '@/components/ui/button'

export function DataOverviewSnapshotAllGapsSheet({
  open,
  onClose,
  comparePool,
  snapshotGapBySymbol,
  fillApiRef,
}: {
  open: boolean
  onClose: () => void
  comparePool: string[]
  snapshotGapBySymbol: Record<string, OptionSnapshotsContractsGapResult>
  fillApiRef: RefObject<DataOverviewOptionJobsBarHandle | null>
}) {
  const asideRef = useRef<HTMLDivElement | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)

  const poolUpperSet = useMemo(
    () => new Set(comparePool.map(s => s.trim().toUpperCase()).filter(Boolean)),
    [comparePool],
  )

  const symbols = useMemo(
    () =>
      Array.from(poolUpperSet)
        .filter(s => snapshotGapBySymbol[s]?.ok === true)
        .sort(),
    [poolUpperSet, snapshotGapBySymbol],
  )

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
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  const runChainExpiry = useCallback(
    async (symU: string, expiration_date: string) => {
      const api = fillApiRef.current
      if (!api?.enqueueChainSnapshot) {
        setLocalErr('Jobs bar is not ready.')
        return
      }
      setLocalErr(null)
      try {
        await api.enqueueChainSnapshot(symU, { expiration_date })
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : 'Enqueue failed')
      }
    },
    [fillApiRef],
  )

  const runSnapshotColumn = useCallback(
    async (symU: string) => {
      const api = fillApiRef.current
      if (!api?.enqueueOptionSnapshotsContractColumnFill) {
        setLocalErr('Jobs bar is not ready.')
        return
      }
      setLocalErr(null)
      try {
        await api.enqueueOptionSnapshotsContractColumnFill(symU)
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : 'Enqueue failed')
      }
    },
    [fillApiRef],
  )

  if (!open) return null

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet ref-jobs-sheet--wide data-overview-all-gaps-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-snapshot-all-gaps-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-snapshot-all-gaps-title" className="ref-jobs-sheet-title">
            All snapshot gaps
          </h3>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>

        <p className="ref-jobs-sheet-meta">
          Compare pool symbols only. Per expiry: <strong>Ref</strong> = Massive chain snapshot contracts intersected with{' '}
          <code>option_contracts</code>; <strong>PG</strong> = distinct keys with an <code>option_snapshots</code> row. Use{' '}
          <strong>Fill row gap</strong> to enqueue a chain snapshot scoped to that expiry. Use <strong>Fill column data</strong>{' '}
          for per-contract API refresh when IV / Greeks / OI columns are incomplete (watchlist health).
        </p>

        {localErr ? (
          <p className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ margin: 'var(--space-2)' }}>
            {localErr}
          </p>
        ) : null}

        <div className="data-overview-all-gaps-sheet__body">
          {poolUpperSet.size === 0 ? (
            <p className="data-overview-all-gaps-sheet__empty-pool" role="status">
              No symbols in the compare pool.
            </p>
          ) : symbols.length === 0 ? (
            <p className="data-overview-all-gaps-sheet__empty-pool" role="status">
              Run <strong>Check</strong> for snapshot gaps first.
            </p>
          ) : (
            symbols.map(symU => {
              const g = snapshotGapBySymbol[symU]
              const ex = g?.expiries ?? []
              return (
                <article key={symU} className="data-overview-all-gaps-sheet__sym">
                  <h4 className="data-overview-all-gaps-sheet__sym-h">
                    <code>{symU}</code>
                    <Button variant="secondary" size="sm" type="button" style={{ marginLeft: 'var(--space-2)' }} title="Per-contract column refresh for incomplete IV / Greeks / OI (capped per job)." onClick={() => void runSnapshotColumn(symU)}
                    >
                      Fill column data
                    </Button>
                  </h4>
                  {ex.length === 0 ? (
                    <p className="data-overview-gap-sheet__muted">No per-expiry rows.</p>
                  ) : (
                    <div className="feed-massive-table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th scope="col">Expiry</th>
                            <th scope="col">Ref</th>
                            <th scope="col">PG</th>
                            <th scope="col">Gap</th>
                            <th scope="col">Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ex.map(row => (
                            <tr key={row.expiry}>
                              <td>
                                <code>{row.expiry}</code>
                              </td>
                              <td>{row.massive_count?.toLocaleString() ?? '—'}</td>
                              <td>{row.pg_count?.toLocaleString() ?? '—'}</td>
                              <td>{row.gap?.toLocaleString() ?? '—'}</td>
                              <td>
                                {row.gap != null && row.gap > 0 ? (
                                  <Button variant="secondary" size="sm" type="button" onClick={() => void runChainExpiry(symU, row.expiry)}
                                  >
                                    Fill row gap
                                  </Button>
                                ) : (
                                  <span className="data-overview-gap-sheet__muted">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </article>
              )
            })
          )}
        </div>
      </aside>
    </div>
  )
}
