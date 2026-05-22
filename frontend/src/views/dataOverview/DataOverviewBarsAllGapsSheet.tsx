import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { OptionBarsContractsGapResult } from '../../api'
import type { DataOverviewOptionJobsBarHandle } from './DataOverviewOptionJobsBar'
import { DataOverviewBarsGapQueriesSheet } from './DataOverviewBarsGapQueriesSheet'
import { Button } from '@/components/ui/button'

export function DataOverviewBarsAllGapsSheet({
  open,
  onClose,
  comparePool,
  barsGapBySymbol,
  table,
  optionMinPeriod,
  fillApiRef,
}: {
  open: boolean
  onClose: () => void
  comparePool: string[]
  barsGapBySymbol: Record<string, OptionBarsContractsGapResult>
  table: 'option_day' | 'option_min'
  /** Required when table is option_min (must match Check / Fill bar period). */
  optionMinPeriod?: string
  fillApiRef: RefObject<DataOverviewOptionJobsBarHandle | null>
}) {
  const asideRef = useRef<HTMLDivElement | null>(null)
  const [localErr, setLocalErr] = useState<string | null>(null)
  const [queriesCtx, setQueriesCtx] = useState<{ sym: string; exp: string } | null>(null)

  const poolUpperSet = useMemo(
    () => new Set(comparePool.map(s => s.trim().toUpperCase()).filter(Boolean)),
    [comparePool],
  )

  const symbols = useMemo(
    () =>
      Array.from(poolUpperSet)
        .filter(s => barsGapBySymbol[s]?.ok === true)
        .sort(),
    [poolUpperSet, barsGapBySymbol],
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

  useEffect(() => {
    if (!open) setQueriesCtx(null)
  }, [open])

  const title = table === 'option_min' ? 'All option_min gaps' : 'All option_day gaps'

  const runRowFullSymbol = useCallback(
    async (symU: string) => {
      const api = fillApiRef.current
      setLocalErr(null)
      try {
        if (table === 'option_day') {
          if (!api?.enqueueOptionDayPoolRowGap) {
            setLocalErr('Jobs bar is not ready.')
            return
          }
          await api.enqueueOptionDayPoolRowGap(symU)
        } else {
          if (!api?.enqueueOptionMinPoolRowGap) {
            setLocalErr('Jobs bar is not ready.')
            return
          }
          await api.enqueueOptionMinPoolRowGap(symU)
        }
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : 'Enqueue failed')
      }
    },
    [fillApiRef, table],
  )

  const runRowOneExpiry = useCallback(
    async (symU: string, expiry: string) => {
      const api = fillApiRef.current
      const exp = expiry.trim()
      if (!exp) return
      setLocalErr(null)
      try {
        if (table === 'option_day') {
          if (!api?.enqueueOptionDayPoolRowGap) {
            setLocalErr('Jobs bar is not ready.')
            return
          }
          await api.enqueueOptionDayPoolRowGap(symU, { expiration_date: exp })
        } else {
          if (!api?.enqueueOptionMinPoolRowGap) {
            setLocalErr('Jobs bar is not ready.')
            return
          }
          await api.enqueueOptionMinPoolRowGap(symU, { expiration_date: exp })
        }
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : 'Enqueue failed')
      }
    },
    [fillApiRef, table],
  )

  const runColumnFullSymbol = useCallback(
    async (symU: string) => {
      const api = fillApiRef.current
      setLocalErr(null)
      try {
        if (table === 'option_day') {
          if (!api?.enqueueOptionDayPoolColumnFill) {
            setLocalErr('Jobs bar is not ready.')
            return
          }
          await api.enqueueOptionDayPoolColumnFill(symU)
        } else {
          if (!api?.enqueueOptionMinPoolColumnFill) {
            setLocalErr('Jobs bar is not ready.')
            return
          }
          await api.enqueueOptionMinPoolColumnFill(symU)
        }
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : 'Enqueue failed')
      }
    },
    [fillApiRef, table],
  )

  if (!open) return null

  return (
    <>
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet ref-jobs-sheet--wide data-overview-all-gaps-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-bars-all-gaps-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-bars-all-gaps-title" className="ref-jobs-sheet-title">
            {title}
          </h3>
          <Button variant="secondary" size="sm" type="button" onClick={onClose} aria-label="Close">
            Close
          </Button>
        </div>

        <p className="ref-jobs-sheet-meta">
          Local gap vs <code>option_contracts</code> (same as <strong>Check</strong>). <strong>Fill row gap (symbol)</strong> runs
          the same pool job as the toolbar for the whole underlying. <strong>Fill row gap (expiry)</strong> scopes the row-gap pool
          to one expiry. <strong>Fill column data</strong> remains symbol-wide (not expiry-scoped). For <code>option_min</code>,
          bar period must match the toolbar ({optionMinPeriod ?? '—'}).
          <br />
          <strong>Real gap</strong> = missing contracts with OI &gt; 0 in latest snapshot (actionable — system should have data).{' '}
          <strong>Illiquid</strong> = OI = 0 or no snapshot (never traded, expected absence).
        </p>

        {localErr ? (
          <p className="status-page-msg err" role="alert" style={{ margin: 'var(--space-2)' }}>
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
              Run <strong>Check</strong> for bars gaps first.
            </p>
          ) : (
            symbols.map(symU => {
              const g = barsGapBySymbol[symU]
              const ex = g?.expiries ?? []
              return (
                <article key={symU} className="data-overview-all-gaps-sheet__sym">
                  <h4 className="data-overview-all-gaps-sheet__sym-h">
                    <code>{symU}</code>
                    <Button variant="secondary" size="sm" type="button" style={{ marginLeft: 'var(--space-2)' }} onClick={() => void runRowFullSymbol(symU)}
                    >
                      Fill row gap (symbol)
                    </Button>
                    <Button variant="secondary" size="sm" type="button" style={{ marginLeft: 'var(--space-2)' }} onClick={() => void runColumnFullSymbol(symU)}
                    >
                      Fill column data (symbol)
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
                            <th scope="col">Covered</th>
                            <th scope="col">Gap</th>
                            <th scope="col">Real gap</th>
                            <th scope="col">Illiquid</th>
                            <th scope="col">Row fill</th>
                            <th scope="col">Queries</th>
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
                              <td style={{ color: (row.real_gap ?? 0) > 0 ? 'var(--color-red, #e74c3c)' : undefined }}>
                                {row.real_gap != null ? row.real_gap.toLocaleString() : '—'}
                              </td>
                              <td style={{ color: 'var(--color-muted, #888)' }}>
                                {row.illiquid != null ? row.illiquid.toLocaleString() : '—'}
                              </td>
                              <td>
                                <Button variant="secondary" size="sm" type="button" onClick={() => void runRowOneExpiry(symU, row.expiry)}
                                >
                                  Fill row gap (expiry)
                                </Button>
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="data-overview-all-gaps-sheet__queries-link"
                                  onClick={() => setQueriesCtx({ sym: symU, exp: row.expiry })}
                                >
                                  SQL &amp; API
                                </button>
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
    {queriesCtx ? (
      <DataOverviewBarsGapQueriesSheet
        open
        onClose={() => setQueriesCtx(null)}
        symbol={queriesCtx.sym}
        expiry={queriesCtx.exp}
        table={table}
        optionMinPeriod={optionMinPeriod}
      />
    ) : null}
    </>
  )
}
