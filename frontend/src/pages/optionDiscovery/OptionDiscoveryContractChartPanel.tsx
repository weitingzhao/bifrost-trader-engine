import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Bar } from '../../types'
import { fetchOptionBars } from '../../api'
import { BarsCandlestickChart } from '../data/BarsCandlestickChart'
import { InfoTooltip } from '../../components/InfoTooltip'

const OPTION_BAR_PERIODS = [
  { value: '1 D', label: 'Daily' },
  { value: '1 hour', label: '1 hour' },
  { value: '5 mins', label: '5 min' },
  { value: '1 min', label: '1 min' },
] as const

function sortBarsAsc(bars: Bar[]): Bar[] {
  return [...bars].sort((a, b) => a.time - b.time)
}

export function OptionDiscoveryContractChartPanel({
  symbol,
  expiration,
  strike,
  optionRight,
  defaultBarSource,
}: {
  symbol: string
  expiration: string
  strike: number
  optionRight: 'C' | 'P'
  defaultBarSource: 'ib' | 'massive'
}) {
  const [period, setPeriod] = useState<string>('1 D')
  const [barSource, setBarSource] = useState<'ib' | 'massive'>(defaultBarSource)
  const [bars, setBars] = useState<Bar[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setBarSource(defaultBarSource)
  }, [defaultBarSource])

  const load = useCallback(async () => {
    const sym = symbol.trim().toUpperCase()
    const exp = expiration.trim()
    if (!sym || !exp || !Number.isFinite(strike)) {
      setBars([])
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetchOptionBars({
        symbol: sym,
        expiry: exp,
        strike,
        option_right: optionRight,
        period,
        limit: 200,
        source: barSource,
      })
      const raw = res.bars ?? []
      setBars(raw)
      if (raw.length === 0) {
        const msg = (res.message || '').trim()
        setError(
          msg ||
            'No bars in the database for this contract. Run a Massive aggregates backfill (option_min / option_day) for this options ticker.',
        )
      }
    } catch (e) {
      setBars([])
      setError(e instanceof Error ? e.message : 'Failed to load option bars')
    } finally {
      setLoading(false)
    }
  }, [symbol, expiration, strike, optionRight, period, barSource])

  useEffect(() => {
    void load()
  }, [load])

  const chartBars = useMemo(() => sortBarsAsc(bars), [bars])

  return (
    <div className="od-contract-chart">
      <div className="od-contract-chart-toolbar">
        <span className="od-contract-chart-toolbar-label">Period</span>
        <div className="od-contract-chart-periods" role="group" aria-label="Bar period">
          {OPTION_BAR_PERIODS.map(p => (
            <label key={p.value} className="od-contract-chart-period-item">
              <input
                type="radio"
                name="od-opt-bar-period"
                value={p.value}
                checked={period === p.value}
                onChange={() => setPeriod(p.value)}
              />
              {p.label}
            </label>
          ))}
        </div>
        <span className="od-contract-chart-toolbar-label">Source</span>
        <select
          className="od-contract-chart-source"
          value={barSource}
          onChange={e => setBarSource(e.target.value === 'ib' ? 'ib' : 'massive')}
          aria-label="Bars data source"
        >
          <option value="massive">Massive (DB)</option>
          <option value="ib">IB (DB)</option>
        </select>
        <button
          type="button"
          className="button button-secondary button-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? 'Loading…' : 'Reload'}
        </button>
        <span className="page-title-with-tooltip" style={{ marginLeft: '0.25rem' }}>
          <InfoTooltip text="Reads stored OHLC from option_day (daily) or option_min (intraday). Populate via Massive Option feed: aggregates / custom_bars jobs writing to PostgreSQL." />
        </span>
      </div>
      {error && <p className="section-hint" role="status">{error}</p>}
      {chartBars.length > 0 && (
        <div className="data-bars-chart-container" style={{ marginTop: '0.75rem' }}>
          <div className="data-bars-chart-header">
            <span className="data-bars-chart-title">
              {symbol.trim().toUpperCase()} {optionRight === 'C' ? 'Call' : 'Put'} {strike.toFixed(2)} · {period} · {barSource} · {chartBars.length} bars
            </span>
          </div>
          <BarsCandlestickChart bars={chartBars} period={period} />
        </div>
      )}
      {!loading && chartBars.length === 0 && !error && (
        <p className="section-hint" role="status">No bars returned.</p>
      )}
    </div>
  )
}
