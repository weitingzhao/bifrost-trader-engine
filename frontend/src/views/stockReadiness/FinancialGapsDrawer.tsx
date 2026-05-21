import { useEffect, useRef, useState } from 'react'
import type {
  SepaFinGapRow,
  SepaFinancialsGapsResponse,
} from '../../api/research/dataReadiness'
import { SDP_GAP_DRAWER_PAGE, SDP_GAP_LAZY_APPEND_CHUNK } from './stockReadinessUtils'

// ── Financial Gaps Drawer ─────────────────────────────────────────────────────

export type FinancialGapsColumnPreset = 'income' | 'statement' | 'short_dated'

export type FinDrawerKind = 'income' | 'balance' | 'cash' | 'ratios' | 'sint' | 'svol'
export type FinBackfillJobKind =
  | 'feed_stocks_income_statements'
  | 'feed_stocks_balance_sheets'
  | 'feed_stocks_cash_flows'
  | 'feed_stocks_ratios'
  | 'feed_stocks_short_interest'
  | 'feed_stocks_short_volume'

export function finDrawerTitleForKind(kind: FinDrawerKind): string {
  switch (kind) {
    case 'income':
      return 'Income statements'
    case 'balance':
      return 'Balance sheets'
    case 'cash':
      return 'Cash flow statements'
    case 'ratios':
      return 'Ratios'
    case 'sint':
      return 'Short interest'
    case 'svol':
      return 'Short volume'
  }
}

export function finDrawerColumnPresetForKind(kind: FinDrawerKind): FinancialGapsColumnPreset {
  if (kind === 'income') return 'income'
  if (kind === 'sint' || kind === 'svol') return 'short_dated'
  return 'statement'
}

export function finBackfillJobKindForDrawer(kind: FinDrawerKind): FinBackfillJobKind {
  switch (kind) {
    case 'income':
      return 'feed_stocks_income_statements'
    case 'balance':
      return 'feed_stocks_balance_sheets'
    case 'cash':
      return 'feed_stocks_cash_flows'
    case 'ratios':
      return 'feed_stocks_ratios'
    case 'sint':
      return 'feed_stocks_short_interest'
    case 'svol':
      return 'feed_stocks_short_volume'
  }
}

export interface FinancialGapsDrawerProps {
  open: boolean
  title: string
  columnPreset: FinancialGapsColumnPreset
  onClose: () => void
  fetchGaps: () => Promise<SepaFinancialsGapsResponse>
  onBackfillAll: () => void
  backfillBusy: boolean
  backfillMsg: string | null
  backfillOk: boolean | null
  onBackfillSelected: (syms: string[]) => void
  backfillSelectedBusy: boolean
  backfillSelectedMsg: string | null
  backfillSelectedOk: boolean | null
}

export function FinancialGapsDrawer(props: FinancialGapsDrawerProps) {
  const {
    open,
    title,
    columnPreset,
    onClose,
    fetchGaps,
    onBackfillAll,
    backfillBusy,
    backfillMsg,
    backfillOk,
    onBackfillSelected,
    backfillSelectedBusy,
    backfillSelectedMsg,
    backfillSelectedOk,
  } = props

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<SepaFinGapRow[]>([])
  const [totalGapCount, setTotalGapCount] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set())
  const [visibleLimit, setVisibleLimit] = useState(SDP_GAP_DRAWER_PAGE)
  const [lazyAppending, setLazyAppending] = useState(false)
  const lazyAppendTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    if (lazyAppendTimerRef.current != null) {
      window.clearTimeout(lazyAppendTimerRef.current)
      lazyAppendTimerRef.current = null
    }
    setVisibleLimit(SDP_GAP_DRAWER_PAGE)
    setLoading(true)
    setError(null)
    setSelectedSymbols(new Set())
    setLazyAppending(false)
    void fetchGaps().then((r) => {
      if (cancelled) return
      setLoading(false)
      if (!r.ok) {
        setError(r.error ?? 'Failed to load gaps')
        setItems([])
        setTotalGapCount(null)
        setLazyAppending(false)
        return
      }
      const g = Array.isArray(r.gaps) ? r.gaps : []
      const firstChunk = g.slice(0, SDP_GAP_LAZY_APPEND_CHUNK)
      setItems(firstChunk)
      setTotalGapCount(typeof r.total_gap_count === 'number' ? r.total_gap_count : g.length)
      if (g.length <= SDP_GAP_LAZY_APPEND_CHUNK) {
        setLazyAppending(false)
        return
      }
      setLazyAppending(true)
      const appendRemaining = (offset: number) => {
        if (cancelled) return
        const nextOffset = offset + SDP_GAP_LAZY_APPEND_CHUNK
        setItems((prev) => prev.concat(g.slice(offset, nextOffset)))
        if (nextOffset < g.length) {
          lazyAppendTimerRef.current = window.setTimeout(() => appendRemaining(nextOffset), 0)
          return
        }
        setLazyAppending(false)
        lazyAppendTimerRef.current = null
      }
      lazyAppendTimerRef.current = window.setTimeout(
        () => appendRemaining(SDP_GAP_LAZY_APPEND_CHUNK),
        0,
      )
    })
    return () => {
      cancelled = true
      if (lazyAppendTimerRef.current != null) {
        window.clearTimeout(lazyAppendTimerRef.current)
        lazyAppendTimerRef.current = null
      }
    }
  }, [open, fetchGaps])

  const filtered = items.filter((it) => {
    const s = q.trim().toUpperCase()
    if (!s) return true
    return it.symbol.toUpperCase().includes(s)
  })

  const visibleFiltered = filtered.slice(0, visibleLimit)

  const toggleSymbol = (sym: string) => {
    setSelectedSymbols((prev) => {
      const n = new Set(prev)
      if (n.has(sym)) n.delete(sym)
      else n.add(sym)
      return n
    })
  }

  const toggleAllFiltered = () => {
    const allSel = visibleFiltered.every((it) => selectedSymbols.has(it.symbol))
    setSelectedSymbols((prev) => {
      const n = new Set(prev)
      if (allSel) {
        for (const it of visibleFiltered) n.delete(it.symbol)
      } else {
        for (const it of visibleFiltered) n.add(it.symbol)
      }
      return n
    })
  }

  const someFilteredSelected = visibleFiltered.some((it) => selectedSymbols.has(it.symbol))
  const allFilteredSelected =
    visibleFiltered.length > 0 && visibleFiltered.every((it) => selectedSymbols.has(it.symbol))

  const copyReport = async () => {
    const lines = filtered.map((it) => {
      const qr = it.quarterly_rows ?? '—'
      const ar = it.annual_rows ?? '—'
      const qd = it.quarterly_max_period_end ?? '—'
      const ad = it.annual_max_period_end ?? '—'
      const gr = it.gap_reason ?? '—'
      if (columnPreset === 'income') {
        return `${it.symbol}\t${qr}\t${ar}\t${qd}\t${ad}\t${gr}`
      }
      if (columnPreset === 'statement') {
        return `${it.symbol}\t${qr}\t${gr}`
      }
      return `${it.symbol}\t${qr}\t${ad}\t${gr}`
    })
    const header =
      columnPreset === 'income'
        ? 'symbol\tquarterly_rows\tannual_rows\tquarterly_max_period_end\tannual_max_period_end\tgap_reason'
        : columnPreset === 'statement'
        ? 'symbol\tquarterly_rows\tgap_reason'
        : 'symbol\trows\tmax_date\tgap_reason'
    const text = [header, ...lines].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError(true)
      setTimeout(() => setCopyError(false), 2500)
    }
  }

  if (!open) return null

  return (
    <>
      <div className="sdp-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="sdp-drawer sdp-drawer--wide sdp-drawer--open" role="dialog" aria-modal="true" aria-label={`${title} gaps`}>
        <div className="sdp-drawer-header">
          <div className="sdp-drawer-title">
            <span className="sdp-drawer-title-icon">⚠</span>
            {title} gaps
            {totalGapCount != null && <span className="sdp-drawer-badge">{totalGapCount.toLocaleString()}</span>}
          </div>
          <button type="button" className="sdp-drawer-close" onClick={onClose} aria-label="Close gap panel">×</button>
        </div>

        <div className="sdp-drawer-sub">
          Per-symbol financial statement gaps for selected step.
        </div>

        <div className="sdp-drawer-actions">
          <button type="button" className="sdp-btn-primary" disabled={backfillBusy} onClick={onBackfillAll}>
            {backfillBusy ? 'Enqueueing…' : 'Backfill all gaps'}
          </button>
          <button
            type="button"
            className="sdp-btn-backfill-selected"
            disabled={backfillSelectedBusy || selectedSymbols.size === 0}
            onClick={() => onBackfillSelected(Array.from(selectedSymbols))}
          >
            {backfillSelectedBusy ? 'Enqueueing…' : `Backfill selected (${selectedSymbols.size})`}
          </button>
          <button
            type="button"
            className={`sdp-btn-copy-llm${copied ? ' sdp-btn-copy-llm--ok' : copyError ? ' sdp-btn-copy-llm--err' : ''}`}
            onClick={() => void copyReport()}
            disabled={loading || filtered.length === 0}
            title="Copy gap report to clipboard"
          >
            {copied ? '✓ Copied' : copyError ? '⚠ Copy failed' : 'Copy report'}
          </button>
        </div>

        {(backfillMsg || backfillSelectedMsg) && (
          <div className="sdp-feedback" style={{ margin: '0 var(--space-4) var(--space-2)' }}>
            {backfillMsg && (
              <div className={backfillOk === false ? 'sdp-msg--err' : 'sdp-msg--ok'}>
                {backfillMsg}
              </div>
            )}
            {backfillSelectedMsg && (
              <div className={backfillSelectedOk === false ? 'sdp-msg--err' : 'sdp-msg--ok'}>
                {backfillSelectedMsg}
              </div>
            )}
          </div>
        )}

        <div className="sdp-drawer-search">
          <input
            type="text"
            className="sdp-drawer-search-input"
            placeholder="Filter by symbol…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter gap symbols"
          />
          {q && (
            <button type="button" className="sdp-drawer-search-clear" onClick={() => setQ('')} aria-label="Clear filter">×</button>
          )}
          {!loading && !error && (
            <span className="sdp-drawer-search-count">
              {filtered.length.toLocaleString()} / {(totalGapCount ?? items.length).toLocaleString()}
            </span>
          )}
        </div>

        <div className="sdp-drawer-body">
          {loading && <div className="sdp-drawer-loading">Loading…</div>}
          {!loading && error && <div className="sdp-drawer-error">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="sdp-drawer-empty">No gaps match the filter.</div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <table className="sdp-gap-table">
              <thead>
                <tr>
                  <th className="sdp-gap-col-check">
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      ref={(el) => {
                        if (el) el.indeterminate = someFilteredSelected && !allFilteredSelected
                      }}
                      onChange={toggleAllFiltered}
                      aria-label={
                        filtered.length > visibleLimit
                          ? `Select all visible symbols (first ${visibleLimit.toLocaleString()} of ${filtered.length.toLocaleString()} filtered)`
                          : 'Select all filtered symbols'
                      }
                    />
                  </th>
                  <th>Symbol</th>
                  {columnPreset === 'income' && (
                    <>
                      <th>Q rows</th>
                      <th>A rows</th>
                      <th>Q max period_end</th>
                      <th>A max period_end</th>
                    </>
                  )}
                  {columnPreset === 'statement' && <th>Q rows</th>}
                  {columnPreset === 'short_dated' && (
                    <>
                      <th>Rows</th>
                      <th>Max date</th>
                    </>
                  )}
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {visibleFiltered.map((it) => {
                  const checked = selectedSymbols.has(it.symbol)
                  return (
                    <tr
                      key={it.symbol}
                      className={checked ? 'sdp-gap-row--selected' : ''}
                      onClick={() => toggleSymbol(it.symbol)}
                    >
                      <td className="sdp-gap-col-check" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="sdp-gap-checkbox"
                          checked={checked}
                          onChange={() => toggleSymbol(it.symbol)}
                          aria-label={`Select ${it.symbol}`}
                        />
                      </td>
                      <td className="sdp-gap-symbol">{it.symbol}</td>
                      {columnPreset === 'income' && (
                        <>
                          <td>{it.quarterly_rows ?? '—'}</td>
                          <td>{it.annual_rows ?? '—'}</td>
                          <td className="sdp-gap-date">{it.quarterly_max_period_end ?? '—'}</td>
                          <td className="sdp-gap-date">{it.annual_max_period_end ?? '—'}</td>
                        </>
                      )}
                      {columnPreset === 'statement' && <td>{it.quarterly_rows ?? '—'}</td>}
                      {columnPreset === 'short_dated' && (
                        <>
                          <td>{it.quarterly_rows ?? '—'}</td>
                          <td className="sdp-gap-date">{it.annual_max_period_end ?? '—'}</td>
                        </>
                      )}
                      <td className="sdp-gap-reason">{it.gap_reason ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {!loading && !error && filtered.length > visibleLimit && (
          <div className="sdp-drawer-truncated sdp-drawer-truncated--actions">
            <span>
              Showing {visibleFiltered.length.toLocaleString()} of {filtered.length.toLocaleString()} filtered rows
              {totalGapCount != null && totalGapCount > items.length
                ? ` (${items.length.toLocaleString()} loaded of ${totalGapCount.toLocaleString()} total gaps)`
                : ''}
              .
            </span>
            <button
              type="button"
              className="sdp-btn-secondary sdp-gap-show-more"
              onClick={() => setVisibleLimit((n) => n + SDP_GAP_DRAWER_PAGE)}
            >
              Show more ({Math.min(SDP_GAP_DRAWER_PAGE, filtered.length - visibleLimit).toLocaleString()})
            </button>
          </div>
        )}

        {!loading && !error && totalGapCount != null && totalGapCount > items.length && filtered.length <= visibleLimit && (
          <div className="sdp-drawer-truncated">
            Showing first {items.length.toLocaleString()} of {totalGapCount.toLocaleString()} symbols.
          </div>
        )}
        {!loading && !error && lazyAppending && (
          <div className="sdp-drawer-truncated">
            Loading remaining symbols… {items.length.toLocaleString()}
            {totalGapCount != null ? ` / ${totalGapCount.toLocaleString()}` : ''}
          </div>
        )}
      </aside>
    </>
  )
}

// ── Step ok helper ────────────────────────────────────────────────────────────

export function finGapOk(n: number | null | undefined): boolean {
  return n != null && n === 0
}
