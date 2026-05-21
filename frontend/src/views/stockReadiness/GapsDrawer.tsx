import { useEffect, useRef, useState } from 'react'
import {
  fetchSepaPriceGaps,
  type SepaPriceGapItem,
} from '../../api/research/dataReadiness'
import { copyTextFallback, SDP_GAP_DRAWER_PAGE } from './stockReadinessUtils'

// ── Gaps Drawer ───────────────────────────────────────────────────────────────

function buildLlmText(items: SepaPriceGapItem[], totalGapCount: number, checkedAt: string): string {
  const ts = checkedAt ? new Date(checkedAt).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—'

  // Reason breakdown (server-computed reason per symbol)
  const reasonCounts: Record<string, number> = {}
  for (const item of items) {
    const key = item.reason || 'unknown'
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1
  }
  const reasonLines = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `  ${n.toLocaleString().padStart(6)}  ${r}`)
    .join('\n')

  // Compact fixed-width table — cap at 200 rows to keep LLM context manageable
  const SHOW = 200
  const sample = items.slice(0, SHOW)
  const fmtPx = (x: number | null | undefined) =>
    x == null || Number.isNaN(x) ? '—' : String(Math.round(x * 10000) / 10000)
  const colW = {
    sym: Math.max(6, ...sample.map(r => r.symbol.length)),
    bars: 4,
    vnd: 10,
    mx: 10,
    l420: 10,
    csd: 10,
    ssn: 10,
  }
  const hdr = [
    'SYMBOL'.padEnd(colW.sym),
    'BARS'.padStart(colW.bars),
    'VENDOR_NY'.padEnd(colW.vnd),
    'MAX_DAILY'.padEnd(colW.mx),
    'LAST420'.padEnd(colW.l420),
    'DAY_CLOSE'.padEnd(colW.csd),
    'SESS_CLOSE'.padEnd(colW.ssn),
    'REASON',
  ].join('  ')
  const sep = '-'.repeat(hdr.length)
  const rows = sample.map(it =>
    [
      it.symbol.padEnd(colW.sym),
      String(it.bar_rows).padStart(colW.bars),
      (it.vendor_day ?? '—').padEnd(colW.vnd),
      (it.last_bar_max_date ?? '—').padEnd(colW.mx),
      (it.last_bar_date ?? '—').padEnd(colW.l420),
      fmtPx(it.last_stock_day_close).padEnd(colW.csd),
      fmtPx(it.session_close).padEnd(colW.ssn),
      it.reason,
    ].join('  ')
  ).join('\n')
  const truncNote = totalGapCount > SHOW
    ? `\n... ${(totalGapCount - SHOW).toLocaleString()} more symbols not shown (total ${totalGapCount.toLocaleString()})`
    : ''

  return `\
==================================================
SEPA Price Gap Report
==================================================
Checked at  : ${ts}
Source      : public.v_us_equity_universe
              LEFT JOIN public.cache_stock_snapshot (last_minute_updated → NY date)
              LEFT JOIN max(public.stock_day.bar_time) per symbol, source=massive
              LEFT JOIN public.v_sepa_symbol_price_readiness (fallback)
Filter      : require cache row + non-null session_close; (vendor date gap + close mismatch) OR (no last_minute_updated AND NOT price_ready); exclude WARRANT
Total gaps  : ${totalGapCount.toLocaleString()} symbols
Returned    : ${items.length.toLocaleString()} symbols
Note        : LAST420 = last bar in 420d window; MAX_DAILY = all-time max bar date; CLOSE = latest daily close vs cache.session_close

BREAKDOWN BY REASON
--------------------------------------------------
${reasonLines}

TOP ${Math.min(SHOW, items.length)} SYMBOLS (vendor gaps first, then bar_rows asc)
--------------------------------------------------
${hdr}
${sep}
${rows}${truncNote}
==================================================`
}

export interface GapsDrawerProps {
  open: boolean
  onClose: () => void
  priceGap: number | null
  onRunBackfill: () => void
  backfillBusy: boolean
  backfillMsg: string | null
  backfillOk: boolean | null
  onRunBackfillSelected: (symbols: string[]) => void
  backfillSelectedBusy: boolean
  backfillSelectedMsg: string | null
  backfillSelectedOk: boolean | null
}

export function GapsDrawer({
  open,
  onClose,
  priceGap,
  onRunBackfill,
  backfillBusy,
  backfillMsg,
  backfillOk,
  onRunBackfillSelected,
  backfillSelectedBusy,
  backfillSelectedMsg,
  backfillSelectedOk,
}: GapsDrawerProps) {
  const [items, setItems] = useState<SepaPriceGapItem[]>([])
  const [totalGapCount, setTotalGapCount] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set())
  const [visibleLimit, setVisibleLimit] = useState(SDP_GAP_DRAWER_PAGE)
  const checkedAtRef = useRef<string>('')

  useEffect(() => {
    if (!open) return
    setVisibleLimit(SDP_GAP_DRAWER_PAGE)
    setLoading(true)
    setError(null)
    setSelectedSymbols(new Set())
    checkedAtRef.current = new Date().toISOString()
    fetchSepaPriceGaps()
      .then((res) => {
        if (!res.ok) {
          setError(res.error ?? 'Failed to load gap data')
          return
        }
        setItems(res.items ?? [])
        setTotalGapCount(res.total_gap_count ?? null)
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Request failed'))
      .finally(() => setLoading(false))
  }, [open])

  const filtered = searchQ.trim()
    ? items.filter((it) => it.symbol.toLowerCase().includes(searchQ.trim().toLowerCase()))
    : items

  const visibleFiltered = filtered.slice(0, visibleLimit)

  const allFilteredSelected =
    visibleFiltered.length > 0 && visibleFiltered.every((it) => selectedSymbols.has(it.symbol))
  const someFilteredSelected = visibleFiltered.some((it) => selectedSymbols.has(it.symbol))

  const toggleSymbol = (symbol: string) => {
    setSelectedSymbols((prev) => {
      const next = new Set(prev)
      if (next.has(symbol)) next.delete(symbol)
      else next.add(symbol)
      return next
    })
  }

  const toggleAllFiltered = () => {
    setSelectedSymbols((prev) => {
      const next = new Set(prev)
      if (allFilteredSelected) {
        visibleFiltered.forEach((it) => next.delete(it.symbol))
      } else {
        visibleFiltered.forEach((it) => next.add(it.symbol))
      }
      return next
    })
  }

  const handleBackfillSelected = () => {
    const syms = Array.from(selectedSymbols)
    if (syms.length === 0) return
    onRunBackfillSelected(syms)
  }

  const handleCopyLlm = async () => {
    const text = buildLlmText(items, totalGapCount ?? items.length, checkedAtRef.current)
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      ok = copyTextFallback(text)
    }
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } else {
      setCopyError(true)
      setTimeout(() => setCopyError(false), 3000)
    }
  }

  const reasonCounts: Record<string, number> = {}
  for (const item of items) {
    const key = item.bar_rows === 0 || item.last_bar_date === null
      ? 'no bars in 420d window'
      : item.bar_rows < 240
      ? 'insufficient bars'
      : item.null_close_rows > 0 || item.null_volume_rows > 0
      ? 'null data'
      : 'stale last bar'
    reasonCounts[key] = (reasonCounts[key] ?? 0) + 1
  }

  return (
    <>
      {open && <div className="sdp-drawer-backdrop" onClick={onClose} aria-hidden />}
      <aside className={`sdp-drawer${open ? ' sdp-drawer--open' : ''}`} aria-label="Price gap details" role="complementary">
        <div className="sdp-drawer-header">
          <div className="sdp-drawer-title">
            <span className="sdp-drawer-title-icon">⚠</span>
            Per-symbol gaps
            {totalGapCount != null && (
              <span className="sdp-drawer-badge">{totalGapCount.toLocaleString()}</span>
            )}
          </div>
          <button type="button" className="sdp-drawer-close" onClick={onClose} aria-label="Close gap panel">×</button>
        </div>

        <div className="sdp-drawer-sub">
          Symbols in <code>v_us_equity_universe</code> where <code>price_ready = false</code>
        </div>

        {/* Reason breakdown pills */}
        {!loading && !error && Object.keys(reasonCounts).length > 0 && (
          <div className="sdp-drawer-reasons">
            {Object.entries(reasonCounts)
              .sort((a, b) => b[1] - a[1])
              .map(([reason, count]) => (
                <span key={reason} className="sdp-gap-reason-pill">
                  <span className="sdp-gap-reason-count">{count}</span>
                  <span className="sdp-gap-reason-label">{reason}</span>
                </span>
              ))}
          </div>
        )}

        {/* Actions */}
        <div className="sdp-drawer-actions">
          <button
            type="button"
            className="sdp-btn-primary"
            onClick={onRunBackfill}
            disabled={backfillBusy || backfillSelectedBusy || priceGap === 0}
            title="Backfill all gap symbols (bulk)"
          >
            {backfillBusy ? 'Dispatching…' : 'Backfill all gaps'}
          </button>
          {selectedSymbols.size > 0 && (
            <button
              type="button"
              className="sdp-btn-backfill-selected"
              onClick={handleBackfillSelected}
              disabled={backfillSelectedBusy || backfillBusy}
              title={`Backfill ${selectedSymbols.size} selected symbol${selectedSymbols.size === 1 ? '' : 's'}`}
            >
              {backfillSelectedBusy
                ? 'Dispatching…'
                : `Backfill selected (${selectedSymbols.size.toLocaleString()})`}
            </button>
          )}
          <button
            type="button"
            className={`sdp-btn-copy-llm${copied ? ' sdp-btn-copy-llm--ok' : copyError ? ' sdp-btn-copy-llm--err' : ''}`}
            onClick={() => void handleCopyLlm()}
            disabled={loading || items.length === 0}
            title="Copy LLM-readable gap report to clipboard"
          >
            {copied ? '✓ Copied' : copyError ? '⚠ Copy failed' : 'Copy LLM report'}
          </button>
        </div>
        {backfillMsg && (
          <div className={`sdp-feedback sdp-msg--${backfillOk ? 'ok' : 'err'}`} style={{ margin: '0 var(--space-4) var(--space-2)' }}>
            {backfillMsg}
          </div>
        )}
        {backfillSelectedMsg && (
          <div className={`sdp-feedback sdp-msg--${backfillSelectedOk ? 'ok' : 'err'}`} style={{ margin: '0 var(--space-4) var(--space-2)' }}>
            {backfillSelectedMsg}
          </div>
        )}

        {/* Search */}
        <div className="sdp-drawer-search">
          <input
            type="text"
            className="sdp-drawer-search-input"
            placeholder="Filter by symbol…"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            aria-label="Filter gap symbols"
          />
          {searchQ && (
            <button type="button" className="sdp-drawer-search-clear" onClick={() => setSearchQ('')} aria-label="Clear filter">×</button>
          )}
          {!loading && !error && (
            <span className="sdp-drawer-search-count">
              {filtered.length.toLocaleString()} / {(totalGapCount ?? items.length).toLocaleString()}
            </span>
          )}
        </div>

        {/* Body */}
        <div className="sdp-drawer-body">
          {loading && (
            <div className="sdp-drawer-loading">
              <span className="sdp-check-dot sdp-check-dot--loading" />
              Loading gap data…
            </div>
          )}
          {error && !loading && (
            <div className="sdp-drawer-error">{error}</div>
          )}
          {!loading && !error && filtered.length === 0 && (
            <div className="sdp-drawer-empty">
              {searchQ
                ? 'No symbols match the filter.'
                : 'No gap symbols — every universe symbol either has no cache row, passes vendor/date/close checks, or readiness fallback is clear.'}
            </div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <table className="sdp-gap-table">
              <thead>
                <tr>
                  <th className="sdp-gap-col-check">
                    <input
                      type="checkbox"
                      className="sdp-gap-checkbox"
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
                  <th>Bars</th>
                  <th>Vendor NY</th>
                  <th>Max daily</th>
                  <th>Last bar (420d)</th>
                  <th>Day close</th>
                  <th>Session close</th>
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
                      <td className={`sdp-gap-bars${it.bar_rows < 240 ? ' sdp-gap-bars--low' : ''}`}>{it.bar_rows}</td>
                      <td className="sdp-gap-date">{it.vendor_day ?? '—'}</td>
                      <td className="sdp-gap-date">{it.last_bar_max_date ?? '—'}</td>
                      <td className="sdp-gap-date">{it.last_bar_date ?? '—'}</td>
                      <td className="sdp-gap-date">
                        {it.last_stock_day_close != null && Number.isFinite(it.last_stock_day_close)
                          ? String(Math.round(it.last_stock_day_close * 10000) / 10000)
                          : '—'}
                      </td>
                      <td className="sdp-gap-date">
                        {it.session_close != null && Number.isFinite(it.session_close)
                          ? String(Math.round(it.session_close * 10000) / 10000)
                          : '—'}
                      </td>
                      <td className="sdp-gap-reason">{it.reason}</td>
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
      </aside>
    </>
  )
}
