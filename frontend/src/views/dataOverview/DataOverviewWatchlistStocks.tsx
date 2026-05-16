import { useCallback, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  fetchStockDayQualityDetail,
  type StockDayGapResult,
  type StockDayQualityDetailResponse,
  type WatchlistDbCoverageStockDay,
  type WatchlistDbCoverageStockMin,
  type WatchlistDbCoverageSymbolRow,
  type WatchlistDbCoverageTickerOverview,
  type WatchlistDbCoverageTickerTypes,
  type WatchlistDbCoverageTickers,
} from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  type StocksFocusDataset,
  type StocksFocusTableId,
  showStocksFocusTable,
} from './stockFocusDataset'
import { DataOverviewStockDayJobsBar } from './DataOverviewStockDayJobsBar'
import { DataOverviewStockDayQualitySheet } from './DataOverviewStockDayQualitySheet'

const EMPTY_SD: WatchlistDbCoverageStockDay = {
  has_data: false,
  stock_day_last_bar: null,
  stock_day_last_created_at: null,
}
const EMPTY_SM: WatchlistDbCoverageStockMin = { has_data: false }
const EMPTY_TK: WatchlistDbCoverageTickers = { has_data: false }
const EMPTY_TO: WatchlistDbCoverageTickerOverview = { has_data: false }
const EMPTY_TT: WatchlistDbCoverageTickerTypes = { has_data: false }

function rowSd(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageStockDay {
  return r.stock_day ?? EMPTY_SD
}
function rowSm(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageStockMin {
  return r.stock_min ?? EMPTY_SM
}
function rowTk(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageTickers {
  return r.tickers ?? EMPTY_TK
}
function rowTo(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageTickerOverview {
  return r.ticker_overview ?? EMPTY_TO
}
function rowTt(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageTickerTypes {
  return r.ticker_types ?? EMPTY_TT
}

function fmtTs(iso: string | null | undefined): string {
  if (!iso) return '—'
  if (iso.length >= 16) return iso.slice(0, 16).replace('T', ' ')
  return iso
}

function fmtAgeSeconds(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  const h = Math.floor(s / 3600)
  const d = Math.floor(h / 24)
  const hr = h % 24
  const min = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${hr}h ago`
  if (h > 0) return `${h}h ${min}m ago`
  return `${m}m ago`
}

function isoAgeSeconds(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 1000))
}

function completenessPctHealthClass(pct: number): string {
  const base = 'data-overview-wl-matrix__completeness-pct'
  if (pct >= 97) return `${base} ${base}--ok`
  if (pct >= 85) return `${base} ${base}--warn`
  return `${base} ${base}--bad`
}

type SummaryRow = { table: string; pipeline: string; coverage: string; freshness: string; health: string }

function worstAgeAcrossWatchlist(
  rows: WatchlistDbCoverageSymbolRow[],
  isoPick: (r: WatchlistDbCoverageSymbolRow) => string | null | undefined,
): string {
  let worst: number | null = null
  for (const r of rows) {
    const a = isoAgeSeconds(isoPick(r))
    if (a == null) continue
    if (worst == null || a > worst) worst = a
  }
  return worst != null ? fmtAgeSeconds(worst) : '—'
}

/** Watchlist-scoped bar tables (per-symbol matrix). */
export function buildWatchlistBarsSummaryRows(rows: WatchlistDbCoverageSymbolRow[]): SummaryRow[] {
  const n = rows.length
  if (n === 0) return []

  const withSd = rows.filter(r => rowSd(r).has_data).length
  const withSm = rows.filter(r => rowSm(r).has_data).length

  return [
    {
      table: 'stock_day',
      pipeline: 'Fundamental · daily OHLC (Massive)',
      coverage: `${withSd}/${n} symbols`,
      freshness: worstAgeAcrossWatchlist(rows, r => {
        const sd = rowSd(r)
        return sd.has_data ? sd.stock_day_last_bar ?? sd.stock_day_last_created_at : null
      }),
      health: '—',
    },
    {
      table: 'stock_min',
      pipeline: 'Fundamental · intraday OHLC (Massive)',
      coverage: `${withSm}/${n} symbols`,
      freshness: worstAgeAcrossWatchlist(rows, r => {
        const sm = rowSm(r)
        return sm.has_data ? sm.last_bar_time ?? sm.last_created_at : null
      }),
      health: '—',
    },
  ]
}

/**
 * Reference utilities — full-universe PostgreSQL tables (not watchlist-specific).
 * Coverage columns use watchlist rows as a convenience slice where per-symbol stats exist.
 */
export function buildStocksUtilitiesSummaryRows(rows: WatchlistDbCoverageSymbolRow[]): SummaryRow[] {
  const n = rows.length
  if (n === 0) return []

  const withTk = rows.filter(r => rowTk(r).has_data).length
  const withTo = rows.filter(r => rowTo(r).has_data).length
  const tt0 = rowTt(rows[0]!)
  const ttRows = tt0.dictionary_row_count
  const ttOk = tt0.has_data && ttRows != null && ttRows > 0

  return [
    {
      table: 'tickers',
      pipeline: 'Reference · universe row (Massive)',
      coverage: `${withTk}/${n} symbols (watchlist slice)`,
      freshness: worstAgeAcrossWatchlist(rows, r => {
        const tk = rowTk(r)
        return tk.has_data ? tk.tickers_updated_at ?? tk.last_updated_utc : null
      }),
      health: '—',
    },
    {
      table: 'ticker_overview',
      pipeline: 'Reference · ticker details (Massive)',
      coverage: `${withTo}/${n} symbols (watchlist slice)`,
      freshness: worstAgeAcrossWatchlist(rows, r => {
        const o = rowTo(r)
        return o.has_data ? o.overview_updated_at : null
      }),
      health: '—',
    },
    {
      table: 'ticker_types',
      pipeline: 'Reference · instrument type dictionary (global)',
      coverage: ttOk ? `${ttRows} rows (full table)` : '—',
      freshness: ttOk ? fmtAgeSeconds(isoAgeSeconds(tt0.dictionary_last_created_at)) : '—',
      health: '—',
    },
  ]
}

const FOCUS_RADIO = 'data-overview-wl-stocks-focus-dataset'

const focusLegendSrOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

export function FocusStocksChipSelector({
  value,
  onChange,
  embedded = false,
}: {
  value: StocksFocusDataset
  onChange: (v: StocksFocusDataset) => void
  embedded?: boolean
}) {
  const chip = (id: StocksFocusDataset, label: string, title: string) => (
    <label className="data-overview-focus-chips__chip" title={title}>
      <input type="radio" name={FOCUS_RADIO} checked={value === id} onChange={() => onChange(id)} />
      <span>{label}</span>
    </label>
  )

  return (
    <fieldset className="data-overview-focus-chips data-overview-focus-chips--compact">
      <legend className={embedded ? undefined : 'data-overview-focus-chips__legend'} style={embedded ? focusLegendSrOnly : undefined}>
        <span className={embedded ? undefined : 'data-overview-focus-chips__legend-text'}>
          {embedded ? (
            'Stocks — focus dataset'
          ) : (
            <>
              Focus dataset
              <InfoTooltip text="Watchlist matrix: stock_day and stock_min only. Reference utilities (tickers, ticker_overview, ticker_types) are under Utilities on Data Overview → Detail." />
            </>
          )}
        </span>
      </legend>
      <div className="data-overview-focus-chips__matrix" role="presentation">
        <span className="data-overview-focus-chips__rk" title="Fundamental — stock bars">
          FDN
        </span>
        <div className="data-overview-focus-chips__row">
          {chip('all', 'All', 'Show every column group')}
          {chip('stock_day', 'stock_day', 'Daily OHLC (Massive)')}
          {chip('stock_min', 'stock_min', 'Intraday OHLC (Massive)')}
        </div>
      </div>
    </fieldset>
  )
}

function StocksCoverageSummaryTable({
  rows,
  freshnessTooltip,
}: {
  rows: SummaryRow[]
  freshnessTooltip: string
}) {
  if (rows.length === 0) return null
  return (
    <div className="feed-massive-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Table</th>
            <th scope="col">Pipeline</th>
            <th scope="col">Coverage</th>
            <th scope="col">
              Freshness
              <InfoTooltip text={freshnessTooltip} />
            </th>
            <th scope="col">Health</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.table}>
              <td>
                <code>{row.table}</code>
              </td>
              <td style={{ fontSize: 'var(--text-caption)' }}>{row.pipeline}</td>
              <td style={{ fontSize: 'var(--text-caption)' }}>{row.coverage}</td>
              <td style={{ fontSize: 'var(--text-caption)' }}>{row.freshness}</td>
              <td style={{ fontSize: 'var(--text-caption)' }}>{row.health}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function DataOverviewWatchlistStocksSummaryTable({
  wlRows,
}: {
  wlRows: WatchlistDbCoverageSymbolRow[]
}) {
  const barRows = useMemo(() => buildWatchlistBarsSummaryRows(wlRows), [wlRows])
  const utilRows = useMemo(() => buildStocksUtilitiesSummaryRows(wlRows), [wlRows])
  return (
    <div className="data-overview-stocks-summary-split">
      <h4 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
        Watchlist bars
        <InfoTooltip text="Per-watchlist-symbol OHLC coverage (stock_day, stock_min)." />
      </h4>
      <StocksCoverageSummaryTable
        rows={barRows}
        freshnessTooltip="Worst-case age across watchlist symbols for the latest bar or row activity."
      />
      <h4
        className="page-title-with-tooltip"
        style={{ marginTop: 'var(--space-4)', marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}
      >
        Utilities
        <InfoTooltip text="PostgreSQL reference tables for the full Massive instruments universe. Coverage uses the watchlist as a convenience slice where rows are per-symbol; ticker_types is one global dictionary." />
      </h4>
      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
        Not watchlist-specific — universe-wide reference data. Slice columns show how many watchlist symbols have rows where applicable.
      </p>
      <StocksCoverageSummaryTable
        rows={utilRows}
        freshnessTooltip="Worst-case age across watchlist symbols where applicable; ticker_types uses the global dictionary’s max(created_at)."
      />
    </div>
  )
}

/** Detail page — same utilities summary as Summary, without the watchlist-bars block. */
export function DataOverviewStocksUtilitiesSection({
  wlRows,
}: {
  wlRows: WatchlistDbCoverageSymbolRow[]
}) {
  const utilRows = useMemo(() => buildStocksUtilitiesSummaryRows(wlRows), [wlRows])
  return (
    <section className="replay-section" aria-labelledby="data-overview-stocks-util-head" style={{ marginBottom: 'var(--space-4)' }}>
      <h3 id="data-overview-stocks-util-head" className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        Utilities
        <InfoTooltip text="PostgreSQL reference tables covering the full Massive stocks universe (not scoped to the watchlist). Coverage uses the watchlist as a convenience slice for per-symbol tables; ticker_types is one global dictionary." />
      </h3>
      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-3)' }}>
        tickers, ticker_overview, and ticker_types hold universe-wide reference data. Figures below use the watchlist only as a slice where per-symbol stats apply. Planned table{' '}
        <code>stock_snapshots</code> (Massive unified snapshot, GET /v3/snapshot) is not in PostgreSQL yet — see the SNP row in Watchlist coverage.
      </p>
      <StocksCoverageSummaryTable
        rows={utilRows}
        freshnessTooltip="Worst-case age across watchlist symbols where applicable; ticker_types uses the global dictionary’s max(created_at)."
      />
    </section>
  )
}

export interface DataOverviewWatchlistStocksProps {
  wlRows: WatchlistDbCoverageSymbolRow[]
  /** When false, hide the collapsible watchlist summary block (Detail page only). */
  showWatchlistSummary?: boolean
  onWatchlistRefreshRequested?: () => void
  embedFocusChips?: boolean
  focusDataset?: StocksFocusDataset
  onFocusDatasetChange?: (v: StocksFocusDataset) => void
}

export function DataOverviewWatchlistStocks({
  wlRows,
  showWatchlistSummary = true,
  onWatchlistRefreshRequested,
  embedFocusChips = true,
  focusDataset: focusDatasetProp,
  onFocusDatasetChange: onFocusDatasetChangeProp,
}: DataOverviewWatchlistStocksProps) {
  const [focusUncontrolled, setFocusUncontrolled] = useState<StocksFocusDataset>('all')
  const focusControlled = focusDatasetProp !== undefined && onFocusDatasetChangeProp !== undefined
  const focusDataset = focusControlled ? focusDatasetProp : focusUncontrolled
  const setFocusDataset = useCallback(
    (v: StocksFocusDataset) => {
      if (focusControlled) onFocusDatasetChangeProp(v)
      else setFocusUncontrolled(v)
    },
    [focusControlled, onFocusDatasetChangeProp],
  )

  // ── stock_day pool management ──────────────────────────────────────────────
  const [stockDayPool, setStockDayPool] = useState<string[]>([])

  const handleTogglePool = useCallback((symbol: string) => {
    const u = symbol.trim().toUpperCase()
    if (!u) return
    setStockDayPool(prev => prev.includes(u) ? prev.filter(s => s !== u) : [...prev, u])
  }, [])

  const handleSelectAllPool = useCallback(() => {
    const all = wlRows.map(r => r.symbol.trim().toUpperCase()).filter(Boolean)
    const seen = new Set<string>()
    setStockDayPool(all.filter(s => (seen.has(s) ? false : (seen.add(s), true))))
  }, [wlRows])

  const handleClearPool = useCallback(() => setStockDayPool([]), [])

  // ── Gap results (from JobsBar Check, used by matrix) ──────────────────────
  const [matrixGapBySymbol, setMatrixGapBySymbol] = useState<Record<string, StockDayGapResult>>({})

  // ── Quality sheet state ────────────────────────────────────────────────────
  const [qualitySheetSymbol, setQualitySheetSymbol] = useState<string | null>(null)
  const [qualitySheetData, setQualitySheetData] = useState<StockDayQualityDetailResponse | null>(null)
  const [qualitySheetLoading, setQualitySheetLoading] = useState(false)

  const handleOpenQualitySheet = useCallback(async (sym: string) => {
    setQualitySheetSymbol(sym)
    setQualitySheetData(null)
    setQualitySheetLoading(true)
    try {
      const data = await fetchStockDayQualityDetail(sym, 90)
      setQualitySheetData(data)
    } catch {
      setQualitySheetData({ ok: false, symbol: sym, latest_date: null, daily: [], error: 'fetch failed' })
    } finally {
      setQualitySheetLoading(false)
    }
  }, [])

  const show = (t: StocksFocusTableId) => showStocksFocusTable(focusDataset, t)

  return (
    <>
      {showWatchlistSummary ? (
        <details open className="replay-section data-overview-watchlist-summary" style={{ marginBottom: 'var(--space-3)' }}>
          <summary
            className="page-title-with-tooltip data-overview-watchlist-summary__summary"
            style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)', cursor: 'pointer' }}
          >
            Watchlist summary
            <InfoTooltip text="Watchlist-scoped aggregates for bars and reference utilities (max 80 optionable STK). Utilities tables are universe-wide; slice counts are for the watchlist where applicable." />
          </summary>
          <DataOverviewWatchlistStocksSummaryTable wlRows={wlRows} />
        </details>
      ) : null}

      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            One row per watchlist symbol for stock_day and stock_min only. Reference utilities (tickers, ticker_overview,
            ticker_types) are listed under Utilities on this page. Scroll horizontally; Symbol stays fixed.
          </p>
          {embedFocusChips !== false ? (
            <div style={{ marginBottom: 'var(--space-3)' }}>
              <FocusStocksChipSelector value={focusDataset} onChange={setFocusDataset} />
            </div>
          ) : null}

          <DataOverviewStockDayJobsBar
            wlRows={wlRows}
            comparePool={stockDayPool}
            onToggleComparePool={handleTogglePool}
            onSelectAllComparePool={handleSelectAllPool}
            onClearComparePool={handleClearPool}
            onWatchlistRefreshRequested={onWatchlistRefreshRequested}
            onOpenQualitySheet={sym => void handleOpenQualitySheet(sym)}
            onGapResultsUpdate={setMatrixGapBySymbol}
          />

          <div className="replay-section data-overview-wl-matrix" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="feed-massive-table-wrap">
              <table className="data-table data-overview-wl-matrix__table">
                <thead>
                  <tr>
                    <th className="data-overview-wl-matrix__sticky-col" rowSpan={2} scope="col">
                      Symbol
                    </th>
                    {show('stock_day') ? (
                      <th colSpan={7} scope="colgroup">
                        <code>stock_day</code>
                      </th>
                    ) : null}
                    {show('stock_min') ? (
                      <th colSpan={5} scope="colgroup">
                        <code>stock_min</code>
                      </th>
                    ) : null}
                  </tr>
                  <tr>
                    {show('stock_day') ? (
                      <>
                        <th scope="col">
                          Age
                          <InfoTooltip text="Time since the latest daily bar (bar_time) in stock_day (Massive source)." />
                        </th>
                        <th scope="col">
                          Completeness
                          <InfoTooltip text="First: OHLC complete %. Second: avg(volume %, VWAP %)." />
                        </th>
                        <th scope="col">Rows</th>
                        <th scope="col">Distinct dates</th>
                        <th scope="col">Last created</th>
                        <th scope="col">
                          Gap
                          <InfoTooltip text="Missing trading days vs global calendar (populated after Check)." />
                        </th>
                        <th scope="col">
                          Cov%
                          <InfoTooltip text="Coverage % vs global trading-day calendar (populated after Check)." />
                        </th>
                      </>
                    ) : null}
                    {show('stock_min') ? (
                      <>
                        <th scope="col">
                          Age
                          <InfoTooltip text="Time since the latest minute bar in stock_min (Massive source)." />
                        </th>
                        <th scope="col">
                          Completeness
                          <InfoTooltip text="First: OHLC complete %. Second: avg(volume %, VWAP %)." />
                        </th>
                        <th scope="col">Rows</th>
                        <th scope="col">Distinct periods</th>
                        <th scope="col">Last created</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {wlRows.map(r => {
                    const sd = rowSd(r)
                    const sm = rowSm(r)
                    const sdAge = sd.has_data ? isoAgeSeconds(sd.stock_day_last_bar ?? sd.stock_day_last_created_at) : null
                    const smAge = sm.has_data ? isoAgeSeconds(sm.last_bar_time ?? sm.last_created_at) : null
                    const symU = r.symbol.trim().toUpperCase()
                    const inPool = stockDayPool.includes(symU)
                    return (
                      <tr key={r.symbol} className={inPool ? 'data-overview-wl-matrix__row--pool' : undefined}>
                        <th className="data-overview-wl-matrix__sticky-col" scope="row">
                          <button
                            type="button"
                            className={`data-overview-wl-matrix__sym-btn${inPool ? ' data-overview-wl-matrix__sym-btn--on' : ''}`}
                            onClick={() => handleTogglePool(r.symbol)}
                            aria-pressed={inPool}
                            title={inPool ? 'Remove from pool' : 'Add to pool'}
                          >
                            {r.symbol}
                          </button>
                          <button
                            type="button"
                            className="data-overview-wl-matrix__sym-detail-btn"
                            onClick={() => void handleOpenQualitySheet(symU)}
                            title={`Open daily bar quality for ${r.symbol}`}
                            aria-label={`Bar quality detail for ${r.symbol}`}
                          >↗</button>
                        </th>
                        {show('stock_day') ? (
                          <>
                            <td style={{ fontSize: 'var(--text-caption)' }} title={sd.stock_day_last_bar ?? undefined}>
                              {fmtAgeSeconds(sdAge)}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {sd.has_data && sd.ohlc_complete_pct != null ? (
                                sd.optional_avg_pct != null ? (
                                  <>
                                    <span className={completenessPctHealthClass(sd.ohlc_complete_pct)}>
                                      {sd.ohlc_complete_pct}%
                                    </span>
                                    <span className="data-overview-wl-matrix__completeness-sep" aria-hidden="true">
                                      {' '}
                                      ·{' '}
                                    </span>
                                    <span className={completenessPctHealthClass(sd.optional_avg_pct)}>
                                      {sd.optional_avg_pct}%
                                    </span>
                                  </>
                                ) : (
                                  <span className={completenessPctHealthClass(sd.ohlc_complete_pct)}>
                                    {sd.ohlc_complete_pct}%
                                  </span>
                                )
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{sd.has_data && sd.row_count != null ? sd.row_count.toLocaleString() : '—'}</td>
                            <td>{sd.has_data && sd.distinct_bar_dates != null ? sd.distinct_bar_dates : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>{fmtTs(sd.stock_day_last_created_at)}</td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {(() => {
                                const g = matrixGapBySymbol[symU]
                                if (!g?.ok || g.compared_at == null) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                                const hasGap = (g.gap ?? 0) > 0
                                return (
                                  <span className={hasGap ? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--bad' : ''}>
                                    {g.gap != null ? (hasGap ? `+${g.gap.toLocaleString()}` : '0') : '—'}
                                  </span>
                                )
                              })()}
                            </td>
                            <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                              {(() => {
                                const g = matrixGapBySymbol[symU]
                                if (!g?.ok || g.compared_at == null) return <span style={{ color: 'var(--color-text-muted)' }}>—</span>
                                if (g.coverage_pct == null) return '—'
                                return (
                                  <span className={completenessPctHealthClass(g.coverage_pct)}>
                                    {g.coverage_pct}%
                                  </span>
                                )
                              })()}
                            </td>
                          </>
                        ) : null}
                        {show('stock_min') ? (
                          <>
                            <td style={{ fontSize: 'var(--text-caption)' }} title={sm.last_bar_time ?? undefined}>
                              {fmtAgeSeconds(smAge)}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {sm.has_data && sm.ohlc_complete_pct != null ? (
                                sm.optional_avg_pct != null ? (
                                  <>
                                    <span className={completenessPctHealthClass(sm.ohlc_complete_pct)}>
                                      {sm.ohlc_complete_pct}%
                                    </span>
                                    <span className="data-overview-wl-matrix__completeness-sep" aria-hidden="true">
                                      {' '}
                                      ·{' '}
                                    </span>
                                    <span className={completenessPctHealthClass(sm.optional_avg_pct)}>
                                      {sm.optional_avg_pct}%
                                    </span>
                                  </>
                                ) : (
                                  <span className={completenessPctHealthClass(sm.ohlc_complete_pct)}>
                                    {sm.ohlc_complete_pct}%
                                  </span>
                                )
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{sm.has_data && sm.row_count != null ? sm.row_count.toLocaleString() : '—'}</td>
                            <td>{sm.has_data && sm.distinct_periods != null ? sm.distinct_periods : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>{fmtTs(sm.last_created_at)}</td>
                          </>
                        ) : null}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
      <DataOverviewStockDayQualitySheet
        open={qualitySheetSymbol != null}
        onClose={() => { setQualitySheetSymbol(null); setQualitySheetData(null) }}
        symbol={qualitySheetSymbol}
        data={qualitySheetData}
        loading={qualitySheetLoading}
      />
    </>
  )
}
