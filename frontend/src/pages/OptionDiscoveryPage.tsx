import { useCallback, useEffect, useMemo, useState } from 'react'
import type { StatusResponse, WatchlistItem } from '../types'
import { fetchWatchlist, fetchOptionExpirations, fetchOptionSnapshot, postWatchlist } from '../api'
import type { OptionSnapshotRow } from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { fmtUsd } from '../utils/format'

const STRIKE_COUNT_OPTIONS = [4, 6, 8, 19, 30, 'all'] as const
type StrikeCountOption = (typeof STRIKE_COUNT_OPTIONS)[number]

const STD_DEV_OPTIONS = [1, 1.5, 2, 2.5, 'custom'] as const
type StdDevOption = (typeof STD_DEV_OPTIONS)[number]

/** Preset strikes: count (or all), half below and half above spot. Std dev filters range (spot ± stdDev * 0.1 * spot). */
function computeStrikesFromPreset(
  allStrikes: number[],
  spot: number | null,
  strikeCount: StrikeCountOption,
  stdDevValue: number,
): number[] {
  if (allStrikes.length === 0) return []
  const sorted = [...allStrikes].sort((a, b) => a - b)
  if (spot == null || spot <= 0) {
    const n = strikeCount === 'all' ? sorted.length : Math.min(Number(strikeCount), sorted.length)
    return sorted.slice(0, n)
  }
  const halfWidth = stdDevValue * 0.1 * spot
  const inRange = sorted.filter(s => s >= spot - halfWidth && s <= spot + halfWidth)
  if (strikeCount === 'all') return inRange
  const n = Math.min(Number(strikeCount), inRange.length)
  const half = Math.floor(n / 2)
  const below = inRange.filter(s => s < spot).sort((a, b) => (spot - a) - (spot - b)).slice(0, half)
  const above = inRange.filter(s => s > spot).sort((a, b) => (a - spot) - (b - spot)).slice(0, n - half)
  const at = inRange.filter(s => s === spot)
  return [...new Set([...below, ...at, ...above])].sort((a, b) => a - b)
}

interface OptionDiscoveryPageProps {
  status: StatusResponse | null
  onGoToScreener?: () => void
  breadcrumbLabel?: string
}

/** STK symbols from Watchlist (sec_type STK or null/empty). */
function useWatchlistStkSymbols(): string[] {
  const [items, setItems] = useState<WatchlistItem[]>([])
  useEffect(() => {
    let cancelled = false
    fetchWatchlist()
      .then(res => { if (!cancelled) setItems(res.items || []) })
      .catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [])
  return useMemo(() => {
    const syms = items
      .filter(i => (i.sec_type || '').trim().toUpperCase() !== 'OPT')
      .map(i => (i.symbol || '').trim())
      .filter(Boolean)
    return [...new Set(syms)].sort()
  }, [items])
}

export function OptionDiscoveryPage({
  status: _status,
  onGoToScreener,
  breadcrumbLabel = 'Option Discovery',
}: OptionDiscoveryPageProps) {
  const stkSymbols = useWatchlistStkSymbols()
  const [selectedSymbol, setSelectedSymbol] = useState('')
  const [expirations, setExpirations] = useState<string[]>([])
  const [strikes, setStrikes] = useState<number[]>([])
  const [stockDayLastPrice, setStockDayLastPrice] = useState<number | null>(null)
  const [expirationsError, setExpirationsError] = useState<string | null>(null)
  const [selectedExpiration, setSelectedExpiration] = useState('')
  const [expirationsLoading, setExpirationsLoading] = useState(false)
  const [snapshotRows, setSnapshotRows] = useState<OptionSnapshotRow[]>([])
  const [snapshotLoading, setSnapshotLoading] = useState(false)
  const [snapshotError, setSnapshotError] = useState<string | null>(null)
  const [underlyingPrice, setUnderlyingPrice] = useState<number | null>(null)
  const [addWatchlistFeedback, setAddWatchlistFeedback] = useState<string | null>(null)
  const [strikeCountOption, setStrikeCountOption] = useState<StrikeCountOption>(30)
  const [stdDevOption, setStdDevOption] = useState<StdDevOption>(2)
  const [customStdDev, setCustomStdDev] = useState<string>('2')
  const [multiSelectStrikes, setMultiSelectStrikes] = useState<number[]>([])

  const stdDevValue = useMemo(() => {
    if (stdDevOption === 'custom') {
      const v = parseFloat(customStdDev)
      return Number.isFinite(v) && v > 0 ? v : 2
    }
    return Number(stdDevOption)
  }, [stdDevOption, customStdDev])

  const computedStrikes = useMemo(
    () =>
      computeStrikesFromPreset(strikes, stockDayLastPrice, strikeCountOption, stdDevValue),
    [strikes, stockDayLastPrice, strikeCountOption, stdDevValue],
  )

  const effectiveStrikes = useMemo(() => {
    if (multiSelectStrikes.length > 0) return multiSelectStrikes
    return computedStrikes
  }, [multiSelectStrikes, computedStrikes])

  useEffect(() => {
    if (stkSymbols.length > 0 && !selectedSymbol.trim()) setSelectedSymbol(stkSymbols[0])
  }, [stkSymbols.join(','), selectedSymbol])

  const loadExpirations = useCallback(async (symbol: string) => {
    const s = (symbol || '').trim()
    if (!s) {
      setExpirations([])
      setStrikes([])
      setStockDayLastPrice(null)
      setExpirationsError(null)
      setSelectedExpiration('')
      return
    }
    setExpirationsLoading(true)
    setExpirationsError(null)
    try {
      const res = await fetchOptionExpirations(s)
      setExpirations(res.expirations || [])
      setStrikes(res.strikes ?? [])
      setStockDayLastPrice(res.last_price ?? null)
      setExpirationsError(res.error ?? null)
      setSelectedExpiration(
        (res.expirations && res.expirations.length > 0 ? res.expirations[0] : '') || ''
      )
    } catch {
      setExpirations([])
      setStrikes([])
      setStockDayLastPrice(null)
      setExpirationsError('Failed to load expirations')
      setSelectedExpiration('')
    } finally {
      setExpirationsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedSymbol.trim()) loadExpirations(selectedSymbol)
    else {
      setExpirations([])
      setStrikes([])
      setStockDayLastPrice(null)
      setMultiSelectStrikes([])
      setExpirationsError(null)
      setSelectedExpiration('')
    }
  }, [selectedSymbol, loadExpirations])

  const loadQuotes = useCallback(async () => {
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (!sym || !exp) return
    setSnapshotLoading(true)
    setSnapshotError(null)
    setAddWatchlistFeedback(null)
    try {
      const res = await fetchOptionSnapshot(sym, exp, effectiveStrikes.length > 0 ? effectiveStrikes : undefined)
      setSnapshotRows(res.rows ?? [])
      setUnderlyingPrice(res.underlying_price ?? null)
      setSnapshotError(res.error ?? null)
    } catch (e) {
      setSnapshotError(e instanceof Error ? e.message : 'Failed to load quotes')
      setSnapshotRows([])
      setUnderlyingPrice(null)
    } finally {
      setSnapshotLoading(false)
    }
  }, [selectedSymbol, selectedExpiration, effectiveStrikes])

  const handleAddToWatchlist = useCallback(
    async (row: OptionSnapshotRow) => {
      const sym = selectedSymbol.trim()
      const exp = selectedExpiration.trim()
      if (!sym || !exp) return
      const contract_key = `${sym}|OPT|${exp}|${row.strike}|${row.right}`
      setAddWatchlistFeedback(null)
      const res = await postWatchlist({
        contract_key,
        symbol: sym,
        sec_type: 'OPT',
        expiry: exp,
        strike: row.strike,
        option_right: row.right,
        source: 'option_discovery',
      })
      if (res.ok) setAddWatchlistFeedback(contract_key)
      else setAddWatchlistFeedback(res.error ?? 'Add failed')
    },
    [selectedSymbol, selectedExpiration],
  )

  const canLoadQuotes = selectedSymbol.trim() !== '' && selectedExpiration.trim() !== '' && !snapshotLoading

  return (
    <div className="card process-section">
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        {onGoToScreener ? (
          <>
            <button
              type="button"
              className="page-title-breadcrumb-link"
              onClick={onGoToScreener}
              aria-label="Go to Screener"
            >
              Research
            </button>
            {' / '}
            {breadcrumbLabel}
            {' '}
          </>
        ) : (
          <>{breadcrumbLabel}{' '}</>
        )}
        <InfoTooltip text="Option Discovery: choose underlying (from Watchlist STK) and expiration; expirations and strikes from IB. Next: option quotes and IV by expiration." />
      </h2>

      <section className="replay-section" aria-labelledby="option-discovery-symbol-head">
        <h3 id="option-discovery-symbol-head">Underlying</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          <label htmlFor="option-discovery-symbol" className="replay-bar-symbol-label">
            Symbol
          </label>
          <select
            id="option-discovery-symbol"
            value={selectedSymbol}
            onChange={e => setSelectedSymbol(e.target.value)}
            aria-label="Select underlying symbol"
            style={{ minWidth: '8rem' }}
          >
            <option value="">—</option>
            {stkSymbols.map(sym => (
              <option key={sym} value={sym}>{sym}</option>
            ))}
          </select>
          {selectedSymbol.trim() && (
            <span className="section-hint" role="status">
              {stockDayLastPrice != null
                ? `Current price: ${fmtUsd(stockDayLastPrice)} (daily)`
                : 'Current price: — (no daily data)'}
            </span>
          )}
          {stkSymbols.length === 0 && (
            <span className="section-hint">Add symbols in Watchlist (STK) to see options.</span>
          )}
        </div>
      </section>

      <section className="replay-section" aria-labelledby="option-discovery-expiry-head">
        <h3 id="option-discovery-expiry-head">Expiration</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
          {expirationsLoading ? (
            <span className="section-hint">Loading…</span>
          ) : expirations.length === 0 ? (
            <>
              <span className="section-hint">
                {selectedSymbol ? 'No expirations.' : 'Select a symbol first.'}
              </span>
              {expirationsError && (
                <span className="section-hint" style={{ color: 'var(--color-danger, #c00)' }} role="alert">
                  {expirationsError}
                </span>
              )}
            </>
          ) : (
            <>
              <select
                id="option-discovery-expiry"
                value={selectedExpiration}
                onChange={e => setSelectedExpiration(e.target.value)}
                aria-label="Select expiration"
                style={{ minWidth: '10rem' }}
              >
                <option value="">—</option>
                {expirations.map(exp => (
                  <option key={exp} value={exp}>{exp}</option>
                ))}
              </select>
              {expirationsError && (
                <span className="section-hint" style={{ color: 'var(--color-danger, #c00)' }} role="alert">
                  {expirationsError}
                </span>
              )}
            </>
          )}
        </div>
      </section>

      <section className="replay-section" aria-labelledby="option-discovery-strikes-head">
        <h3 id="option-discovery-strikes-head">Strikes</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem 1.5rem', marginBottom: '0.75rem' }}>
          <label htmlFor="option-discovery-strike-count" className="replay-bar-symbol-label">
            Count
          </label>
          <select
            id="option-discovery-strike-count"
            value={String(strikeCountOption)}
            onChange={e => setStrikeCountOption(e.target.value === 'all' ? 'all' : (Number(e.target.value) as StrikeCountOption))}
            aria-label="Strike count (4, 6, 8, 19, 30, or all)"
            style={{ minWidth: '5rem' }}
          >
            {STRIKE_COUNT_OPTIONS.map(c => (
              <option key={String(c)} value={String(c)}>{c}</option>
            ))}
          </select>
          <label htmlFor="option-discovery-std-dev" className="replay-bar-symbol-label" style={{ marginLeft: '0.5rem' }}>
            Std deviations
          </label>
          <select
            id="option-discovery-std-dev"
            value={String(stdDevOption)}
            onChange={e => setStdDevOption(e.target.value === 'custom' ? 'custom' : (Number(e.target.value) as StdDevOption))}
            aria-label="Standard deviations range"
            style={{ minWidth: '5rem' }}
          >
            {STD_DEV_OPTIONS.map(d => (
              <option key={String(d)} value={String(d)}>{d}</option>
            ))}
          </select>
          {stdDevOption === 'custom' && (
            <input
              type="number"
              min={0.1}
              step={0.1}
              value={customStdDev}
              onChange={e => setCustomStdDev(e.target.value)}
              aria-label="Custom standard deviation value"
              style={{ width: '4rem' }}
            />
          )}
        </div>
        <p className="section-hint" style={{ marginTop: '0.25rem', marginBottom: '0.5rem' }}>
          {computedStrikes.length > 0
            ? `Using ${effectiveStrikes.length} strike(s)${multiSelectStrikes.length > 0 ? ' (custom selection)' : ' (preset: half above / half below current price)'}. `
            : strikes.length > 0
              ? 'Select symbol with daily data for strike range, or adjust count/std dev.'
              : 'Select symbol and expiration to see strikes.'}
          {computedStrikes.length > 0 && (
            <> Range: {computedStrikes.length} strike(s) around current price.</>
          )}
        </p>
        {computedStrikes.length > 0 && (
          <div style={{ marginTop: '0.5rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
              <span className="section-hint">Multi-select (½ count below / ½ count above current price):</span>
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => setMultiSelectStrikes([...computedStrikes])}
                aria-label="Select all strikes in range"
              >
                Select all
              </button>
              <button
                type="button"
                className="button button-secondary button-sm"
                onClick={() => setMultiSelectStrikes([])}
                aria-label="Clear selection (use preset)"
              >
                Clear
              </button>
            </div>
            <div
              style={{
                maxHeight: '10rem',
                overflowY: 'auto',
                border: '1px solid var(--color-border, #ccc)',
                borderRadius: '4px',
                padding: '0.35rem',
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.25rem',
              }}
              role="group"
              aria-label="Strike multi-select"
            >
              {computedStrikes.map(s => {
                const selected = multiSelectStrikes.includes(s)
                return (
                  <label key={s} style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => {
                        if (selected) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                        else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                      }}
                      aria-label={`Strike ${s}`}
                    />
                    <span style={{ marginLeft: '0.25rem' }}>{s.toFixed(1)}</span>
                  </label>
                )
              })}
            </div>
          </div>
        )}
      </section>

      <section className="replay-section" aria-labelledby="option-discovery-table-head">
        <h3 id="option-discovery-table-head">By expiration – Option quotes</h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginTop: '0.5rem', marginBottom: '1rem' }}>
          <button
            type="button"
            className="button button-primary"
            onClick={() => void loadQuotes()}
            disabled={!canLoadQuotes}
            aria-label="Load option quotes for selected symbol and expiration"
          >
            {snapshotLoading ? 'Loading…' : 'Load quotes'}
          </button>
          {underlyingPrice != null && (
            <span className="section-hint">Underlying: {fmtUsd(underlyingPrice)}</span>
          )}
          {addWatchlistFeedback != null && (
            <span className="section-hint" role="status">
              {addWatchlistFeedback.includes('|') ? 'Added to Watchlist.' : addWatchlistFeedback}
            </span>
          )}
        </div>
        {snapshotLoading && (
          <p className="section-hint">Fetching option quotes (may take ~10s)…</p>
        )}
        {snapshotError != null && !snapshotLoading && (
          <p className="section-hint" style={{ color: 'var(--color-danger, #c00)' }} role="alert">
            {snapshotError}
          </p>
        )}
        {snapshotRows.length > 0 && !snapshotLoading && (
          <div className="table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="data-table" aria-label="Option quotes by strike and type">
              <thead>
                <tr>
                  <th>Strike</th>
                  <th>Type</th>
                  <th>Bid</th>
                  <th>Ask</th>
                  <th>Last</th>
                  <th>Mid</th>
                  <th aria-label="Add to Watchlist" />
                </tr>
              </thead>
              <tbody>
                {snapshotRows.map((row, idx) => (
                  <tr key={`${row.strike}-${row.right}-${idx}`}>
                    <td>{row.strike.toFixed(2)}</td>
                    <td>{row.right === 'C' ? 'Call' : 'Put'}</td>
                    <td>{row.bid != null ? fmtUsd(row.bid) : '—'}</td>
                    <td>{row.ask != null ? fmtUsd(row.ask) : '—'}</td>
                    <td>{row.last != null ? fmtUsd(row.last) : '—'}</td>
                    <td>{row.mid != null ? fmtUsd(row.mid) : '—'}</td>
                    <td>
                      <button
                        type="button"
                        className="button button-secondary button-sm"
                        onClick={() => handleAddToWatchlist(row)}
                        aria-label={`Add ${row.right === 'C' ? 'Call' : 'Put'} ${row.strike} to Watchlist`}
                      >
                        Add to Watchlist
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {snapshotRows.length === 0 && !snapshotLoading && !snapshotError && (
          <p className="section-hint">Select symbol and expiration, then click Load quotes.</p>
        )}
      </section>
    </div>
  )
}
