import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { StatusResponse, WatchlistItem } from '../types'
import {
  fetchWatchlist,
  fetchOptionExpirations,
  fetchOptionSnapshot,
  fetchBarsBenchmark,
  postWatchlist,
  fetchMassiveStatus,
  postMassiveSync,
  fetchOptionSnapshotsPg,
  pollMassiveJobUntilDone,
} from '../api'
import type { MassiveStatusResponse } from '../api'
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

/** STK symbols from Watchlist that are optionable (sec_type STK and optionable=true). */
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
      .filter(i => i.optionable === true)
      .map(i => (i.symbol || '').trim())
      .filter(Boolean)
    return [...new Set(syms)].sort()
  }, [items])
}

function fmtOptNum(v: number | null | undefined, digits = 4): string {
  if (v == null || !Number.isFinite(v)) return '—'
  return v.toFixed(digits)
}

/** Parse expiration string (YYYYMMDD or YYYY-MM-DD) and return days from today. Returns "x day" / "x days". */
function expirationDaysFromToday(expiration: string): string {
  const s = (expiration || '').trim()
  if (!s) return '—'
  let y = 0
  let m = 0
  let d = 0
  if (/^\d{8}$/.test(s)) {
    y = parseInt(s.slice(0, 4), 10)
    m = parseInt(s.slice(4, 6), 10) - 1
    d = parseInt(s.slice(6, 8), 10)
  } else {
    const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (match) {
      y = parseInt(match[1], 10)
      m = parseInt(match[2], 10) - 1
      d = parseInt(match[3], 10)
    } else {
      return '—'
    }
  }
  const expDate = new Date(y, m, d)
  if (Number.isNaN(expDate.getTime())) return '—'
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  expDate.setHours(0, 0, 0, 0)
  const diffMs = expDate.getTime() - today.getTime()
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000))
  if (days < 0) return '—'
  return days === 1 ? '1 day' : `${days} days`
}

export function OptionDiscoveryPage({
  status: _status,
  onGoToScreener,
  breadcrumbLabel = 'Option Discovery',
}: OptionDiscoveryPageProps) {
  const stkSymbols = useWatchlistStkSymbols()
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [quoteSource, setQuoteSource] = useState<'ib' | 'massive'>('ib')
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
  const [symbolDailyPrices, setSymbolDailyPrices] = useState<Record<string, number | null>>({})
  const otmCallWrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => {
        if (!cancelled) {
          setMassiveStatus(s)
          if (s.configured) setQuoteSource('massive')
        }
      })
      .catch(() => {
        if (!cancelled) setMassiveStatus(null)
      })
    return () => {
      cancelled = true
    }
  }, [])

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
    const el = otmCallWrapRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [computedStrikes, selectedSymbol])

  useEffect(() => {
    if (stkSymbols.length > 0 && !selectedSymbol.trim()) setSelectedSymbol(stkSymbols[0])
  }, [stkSymbols.join(','), selectedSymbol])

  useEffect(() => {
    if (stkSymbols.length === 0) {
      setSymbolDailyPrices({})
      return
    }
    let cancelled = false
    fetchBarsBenchmark(stkSymbols)
      .then(({ benchmarks }) => {
        if (cancelled) return
        const next: Record<string, number | null> = {}
        for (const sym of stkSymbols) {
          const b = benchmarks[sym]
          const close = b?.close != null && Number.isFinite(b.close) ? b.close : null
          next[sym] = close ?? null
        }
        setSymbolDailyPrices(next)
      })
      .catch(() => {
        if (!cancelled) setSymbolDailyPrices({})
      })
    return () => { cancelled = true }
  }, [stkSymbols.join(',')])

  const loadExpirations = useCallback(async (symbol: string, source: 'ib' | 'massive' = quoteSource) => {
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
      const provider: 'auto' | 'ib' | 'massive' =
        source === 'massive' && massiveStatus?.configured ? 'massive' : source === 'ib' ? 'ib' : 'auto'
      const res = await fetchOptionExpirations(s, provider)
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
  }, [quoteSource, massiveStatus?.configured])

  const prevQuoteSourceRef = useRef(quoteSource)

  useEffect(() => {
    setMultiSelectStrikes([])
    setStrikes([])
    setStockDayLastPrice(null)
    if (selectedSymbol.trim()) {
      setExpirations([])
      setSelectedExpiration('')
      setExpirationsError(null)
      loadExpirations(selectedSymbol)
    } else {
      setExpirations([])
      setExpirationsError(null)
      setSelectedExpiration('')
    }
  }, [selectedSymbol, loadExpirations])

  useEffect(() => {
    if (prevQuoteSourceRef.current === quoteSource) return
    prevQuoteSourceRef.current = quoteSource
    const sym = selectedSymbol.trim()
    if (sym) loadExpirations(sym, quoteSource)
  }, [quoteSource, selectedSymbol, loadExpirations])

  const loadQuotes = useCallback(async () => {
    const sym = selectedSymbol.trim()
    const exp = selectedExpiration.trim()
    if (!sym || !exp) return
    const strikesToSend = effectiveStrikes.length > 0 ? effectiveStrikes : undefined
    setSnapshotLoading(true)
    setSnapshotError(null)
    setAddWatchlistFeedback(null)
    try {
      if (quoteSource === 'ib') {
        const res = await fetchOptionSnapshot(sym, exp, strikesToSend)
        setSnapshotRows(res.rows ?? [])
        setUnderlyingPrice(res.underlying_price ?? null)
        setSnapshotError(res.error ?? null)
        return
      }
      const sync = await postMassiveSync('snapshot', { underlying: sym })
      if (!sync.ok || !sync.job_id) {
        setSnapshotError(sync.error ?? sync.message ?? 'Massive sync failed')
        setSnapshotRows([])
        setUnderlyingPrice(null)
        return
      }
      const polled = await pollMassiveJobUntilDone(sync.job_id, { maxAttempts: 120, intervalMs: 1000 })
      if (!polled.ok) {
        setSnapshotError(polled.error ?? 'Massive job failed')
        setSnapshotRows([])
        setUnderlyingPrice(null)
        return
      }
      const strikesCsv =
        strikesToSend && strikesToSend.length > 0 ? strikesToSend.map(x => String(x)).join(',') : undefined
      const sn = await fetchOptionSnapshotsPg(sym, exp, strikesCsv, 'massive')
      setSnapshotRows(sn.rows ?? [])
      setUnderlyingPrice(sn.underlying_price ?? null)
      setSnapshotError(sn.error ?? null)
    } catch (e) {
      setSnapshotError(e instanceof Error ? e.message : 'Failed to load quotes')
      setSnapshotRows([])
      setUnderlyingPrice(null)
    } finally {
      setSnapshotLoading(false)
    }
  }, [selectedSymbol, selectedExpiration, effectiveStrikes, quoteSource])

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
        <InfoTooltip text="Option Discovery: choose underlying (from Watchlist STK with Option? on) and expiration. Expirations use Massive when configured (auto), else IB. Quotes: IB live or Massive delayed snapshot sync + PostgreSQL." />
        {massiveStatus?.configured && (
          <span
            className="section-hint"
            style={{ marginLeft: '0.5rem', fontWeight: 600 }}
            title={massiveStatus.delay_notice}
          >
            Massive · 15 min delayed
          </span>
        )}
      </h2>

      <section className="replay-section option-discovery-conditions-section" aria-label="Option chain selection conditions">
        <h3 id="option-discovery-conditions-head">Option chain selection</h3>
        <div className="option-discovery-top-row">
        <section className="replay-section option-discovery-underlying" aria-label="Underlying">
          <div className="option-discovery-underlying-body">
            {stkSymbols.length === 0 ? (
              <div className="option-discovery-list-wrap option-discovery-list-empty">
                Add STK in Watchlist and turn on Option? for symbols that have options.
              </div>
            ) : (
              <div className="option-discovery-list-with-header">
                <div className="option-discovery-list-header">Underlying</div>
                <div className="option-discovery-list-wrap">
                  <table className="option-discovery-list-table" role="grid" aria-label="Underlying symbol list">
                    <thead>
                      <tr>
                        <th scope="col">Symbol</th>
                        <th scope="col">Price (daily)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stkSymbols.map(sym => (
                        <tr
                          key={sym}
                          role="button"
                          tabIndex={0}
                          className={selectedSymbol === sym ? 'option-discovery-list-row-selected' : ''}
                          onClick={() => setSelectedSymbol(sym)}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedSymbol(sym) } }}
                          aria-label={`Select ${sym}`}
                          aria-pressed={selectedSymbol === sym}
                        >
                          <td>{sym}</td>
                          <td>
                            {symbolDailyPrices[sym] != null ? fmtUsd(symbolDailyPrices[sym]!) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="replay-section option-discovery-expiration" aria-label="Expiration">
          <div className="option-discovery-expiration-body">
            {expirationsLoading ? (
              <div className="option-discovery-list-wrap option-discovery-list-empty">Loading…</div>
            ) : expirations.length === 0 ? (
              <div className="option-discovery-list-wrap option-discovery-list-empty">
                {selectedSymbol ? 'No expirations.' : 'Select symbol.'}
                {expirationsError && (
                  <span style={{ color: 'var(--color-danger)', display: 'block', marginTop: '0.25rem' }} role="alert">{expirationsError}</span>
                )}
              </div>
            ) : (
              <div className="option-discovery-list-with-header">
                <div className="option-discovery-list-header" aria-label="Expiration">Expiration</div>
                <div className="option-discovery-list-wrap">
                  <table className="option-discovery-list-table" role="grid" aria-label="Expiration list">
                    <thead>
                      <tr>
                        <th scope="col" className="option-discovery-expiration-col-date" />
                        <th scope="col" className="option-discovery-expiration-col-days">
                          Days
                          {selectedExpiration && (
                            <span className="option-discovery-expiration-days-header"> · {expirationDaysFromToday(selectedExpiration)}</span>
                          )}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {expirations.map(exp => (
                        <tr
                          key={exp}
                          role="button"
                          tabIndex={0}
                          className={selectedExpiration === exp ? 'option-discovery-list-row-selected' : ''}
                          onClick={() => setSelectedExpiration(exp)}
                          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedExpiration(exp) } }}
                          aria-label={`Select ${exp}, ${expirationDaysFromToday(exp)}`}
                          aria-pressed={selectedExpiration === exp}
                        >
                          <td className="option-discovery-expiration-col-date">{exp}</td>
                          <td className="option-discovery-expiration-days-cell">{expirationDaysFromToday(exp)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="replay-section option-discovery-strikes" aria-label="Strikes">
          <div className="option-discovery-strikes-content" style={{ flex: 1, minWidth: 0 }}>
        {computedStrikes.length > 0 && (() => {
          const spot = stockDayLastPrice ?? undefined
          const below = spot != null ? computedStrikes.filter(s => s < spot).sort((a, b) => b - a) : []
          const at = spot != null ? computedStrikes.filter(s => s === spot) : []
          const above = spot != null ? computedStrikes.filter(s => s > spot).sort((a, b) => a - b) : []
          const aboveReversed = [...above].sort((a, b) => b - a)
          const hasZones = below.length > 0 || at.length > 0 || above.length > 0
          return (
            <div className="option-discovery-list-with-header option-discovery-strikes-with-header">
              <div className="strike-ladder-layout">
              <div className="strike-ladder-col strike-ladder-col-range">
                <div className="strike-ladder-col-header">Strikes Range</div>
                <div className="strike-ladder-controls">
                <div className="strike-ladder-controls-row">
                  <label htmlFor="option-discovery-strike-count">Count</label>
                  <select
                    id="option-discovery-strike-count"
                    value={String(strikeCountOption)}
                    onChange={e => setStrikeCountOption(e.target.value === 'all' ? 'all' : (Number(e.target.value) as StrikeCountOption))}
                    aria-label="Strike count"
                  >
                    {STRIKE_COUNT_OPTIONS.map(c => (
                      <option key={String(c)} value={String(c)}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="strike-ladder-controls-row">
                  <label htmlFor="option-discovery-std-dev">Std dev</label>
                  <select
                    id="option-discovery-std-dev"
                    value={String(stdDevOption)}
                    onChange={e => setStdDevOption(e.target.value === 'custom' ? 'custom' : (Number(e.target.value) as StdDevOption))}
                    aria-label="Standard deviations"
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
                      aria-label="Custom std dev"
                    />
                  )}
                </div>
                {spot != null && (below.length > 0 || above.length > 0 || at.length > 0) && (
                  <div className="strike-ladder-controls-price">
                    Current price: {fmtUsd(spot)}
                  </div>
                )}
                <div className="strike-ladder-toolbar">
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={() => setMultiSelectStrikes([...computedStrikes])}
                    aria-label="Select all"
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="button button-secondary button-sm"
                    onClick={() => setMultiSelectStrikes([])}
                    aria-label="Clear"
                  >
                    Clear
                  </button>
                </div>
                <div className="strike-ladder-controls-summary">
                  <div>{effectiveStrikes.length} selected{multiSelectStrikes.length > 0 ? ' (custom)' : ' (preset)'}</div>
                  <div>{computedStrikes.length} in range</div>
                </div>
              </div>
              </div>
              <div className="strike-ladder-two-cols">
                <div className="strike-ladder-col">
                  <div className="strike-ladder-col-header strike-ladder-col-header-call">
                    <label className="strike-ladder-col-header-check">
                      <input
                        type="checkbox"
                        checked={aboveReversed.length + at.length > 0 && [...aboveReversed, ...at].every(s => multiSelectStrikes.includes(s))}
                        onChange={e => {
                          if (e.target.checked) setMultiSelectStrikes(prev => [...new Set([...prev, ...aboveReversed, ...at])].sort((a, b) => a - b))
                          else setMultiSelectStrikes(prev => prev.filter(x => !aboveReversed.includes(x) && !at.includes(x)))
                        }}
                        aria-label="Check all OTM Call"
                      />
                      <span>OTM Call</span>
                    </label>
                  </div>
                  <div className="strike-ladder-wrap" ref={otmCallWrapRef}>
                    <table className="strike-ladder-table" role="grid" aria-label="OTM Call strikes">
                      <thead>
                        <tr>
                          <th scope="col">Select</th>
                          <th scope="col">Strike</th>
                        </tr>
                      </thead>
                      <tbody>
                        {aboveReversed.length > 0 && aboveReversed.map(s => (
                          <tr key={s} className="strike-ladder-row-otm-call">
                            <td className="strike-ladder-cell-check">
                              <input
                                type="checkbox"
                                checked={multiSelectStrikes.includes(s)}
                                onChange={() => {
                                  if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                  else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                                }}
                                aria-label={`Select strike ${s}`}
                              />
                            </td>
                            <td className="strike-ladder-cell-strike">{s.toFixed(1)}</td>
                          </tr>
                        ))}
                        {at.length > 0 && at.map(s => (
                          <tr key={s} className="strike-ladder-row-atm">
                            <td className="strike-ladder-cell-check">
                              <input
                                type="checkbox"
                                checked={multiSelectStrikes.includes(s)}
                                onChange={() => {
                                  if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                  else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                                }}
                                aria-label={`Select strike ${s}`}
                              />
                            </td>
                            <td className="strike-ladder-cell-strike">{s.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div className="strike-ladder-col">
                  <div className="strike-ladder-col-header strike-ladder-col-header-put">
                    <label className="strike-ladder-col-header-check">
                      <input
                        type="checkbox"
                        checked={below.length > 0 && below.every(s => multiSelectStrikes.includes(s))}
                        onChange={e => {
                          if (e.target.checked) setMultiSelectStrikes(prev => [...new Set([...prev, ...below])].sort((a, b) => a - b))
                          else setMultiSelectStrikes(prev => prev.filter(x => !below.includes(x)))
                        }}
                        aria-label="Check all OTM Put"
                      />
                      <span>OTM Put</span>
                    </label>
                  </div>
                  <div className="strike-ladder-wrap">
                    <table className="strike-ladder-table" role="grid" aria-label="OTM Put strikes">
                      <thead>
                        <tr>
                          <th scope="col">Select</th>
                          <th scope="col">Strike</th>
                        </tr>
                      </thead>
                      <tbody>
                        {below.length > 0 && below.map(s => (
                          <tr key={s} className="strike-ladder-row-otm-put">
                            <td className="strike-ladder-cell-check">
                              <input
                                type="checkbox"
                                checked={multiSelectStrikes.includes(s)}
                                onChange={() => {
                                  if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                  else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                                }}
                                aria-label={`Select strike ${s}`}
                              />
                            </td>
                            <td className="strike-ladder-cell-strike">{s.toFixed(1)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              </div>
              {!hasZones && (
                <div className="strike-ladder-wrap" style={{ marginTop: '0.25rem' }}>
                  <table className="strike-ladder-table" role="grid" aria-label="Strikes">
                    <thead>
                      <tr>
                        <th scope="col">Select</th>
                        <th scope="col">Strike</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...computedStrikes].sort((a, b) => a - b).map(s => (
                        <tr key={s}>
                          <td className="strike-ladder-cell-check">
                            <input
                              type="checkbox"
                              checked={multiSelectStrikes.includes(s)}
                              onChange={() => {
                                if (multiSelectStrikes.includes(s)) setMultiSelectStrikes(prev => prev.filter(x => x !== s))
                                else setMultiSelectStrikes(prev => [...prev, s].sort((a, b) => a - b))
                              }}
                              aria-label={`Select strike ${s}`}
                            />
                          </td>
                          <td className="strike-ladder-cell-strike">{s.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )
        })()}
        {computedStrikes.length === 0 && strikes.length > 0 ? (
          <p className="section-hint strike-ladder-hint-below" style={{ marginTop: '0.35rem', marginBottom: 0 }}>Select symbol with daily data or adjust count/std dev.</p>
        ) : computedStrikes.length === 0 ? (
          <p className="section-hint strike-ladder-hint-below" style={{ marginTop: '0.35rem', marginBottom: 0 }}>Select symbol and expiration to see strikes.</p>
        ) : null}
          </div>
        </section>
        </div>
      </section>

      <section className="replay-section" aria-labelledby="option-discovery-table-head">
        <h3 id="option-discovery-table-head">
          By expiration – Option quotes
          <InfoTooltip text="IB: live quotes from TWS. Massive: enqueue sync job (REST), then read snapshots from PostgreSQL; 15 min delayed. Bid/ask may be empty outside RTH." />
        </h3>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}>
            <span className="section-hint">Quote source</span>
            <select
              value={quoteSource}
              onChange={e => setQuoteSource(e.target.value as 'ib' | 'massive')}
              aria-label="Quote source"
            >
              <option value="ib">IB (live)</option>
              <option value="massive" disabled={!massiveStatus?.configured}>
                Massive (delayed)
              </option>
            </select>
          </label>
          {quoteSource === 'massive' && massiveStatus && !massiveStatus.trades_enabled && (
            <span className="section-hint" style={{ maxWidth: '42rem' }}>
              Tape (last trades) is not available on this tier. Enable trades in Massive config for Developer.
            </span>
          )}
        </div>
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
                  {quoteSource === 'massive' && (
                    <>
                      <th>IV</th>
                      <th>Δ</th>
                      <th>Γ</th>
                      <th>Θ</th>
                      <th>ν</th>
                      <th>OI</th>
                    </>
                  )}
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
                    {quoteSource === 'massive' && (
                      <>
                        <td>{fmtOptNum(row.iv, 4)}</td>
                        <td>{fmtOptNum(row.delta, 4)}</td>
                        <td>{fmtOptNum(row.gamma, 4)}</td>
                        <td>{fmtOptNum(row.theta, 4)}</td>
                        <td>{fmtOptNum(row.vega, 4)}</td>
                        <td>{row.open_interest != null ? String(row.open_interest) : '—'}</td>
                      </>
                    )}
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
