import { useCallback, useMemo, useState } from 'react'
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
  STOCKS_FOCUS_TABLE_IDS,
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

function buildStocksSummaryRows(rows: WatchlistDbCoverageSymbolRow[]): SummaryRow[] {
  const n = rows.length
  if (n === 0) return []

  const withSd = rows.filter(r => rowSd(r).has_data).length
  const withSm = rows.filter(r => rowSm(r).has_data).length
  const withTk = rows.filter(r => rowTk(r).has_data).length
  const withTo = rows.filter(r => rowTo(r).has_data).length
  const tt0 = rowTt(rows[0]!)
  const ttRows = tt0.dictionary_row_count
  const ttOk = tt0.has_data && ttRows != null && ttRows > 0

  const worstAge = (isoPick: (r: WatchlistDbCoverageSymbolRow) => string | null | undefined) => {
    let worst: number | null = null
    for (const r of rows) {
      const a = isoAgeSeconds(isoPick(r))
      if (a == null) continue
      if (worst == null || a > worst) worst = a
    }
    return worst != null ? fmtAgeSeconds(worst) : '—'
  }

  return [
    {
      table: 'stock_day',
      pipeline: 'Fundamental · daily OHLC (Massive)',
      coverage: `${withSd}/${n} symbols`,
      freshness: worstAge(r => {
        const sd = rowSd(r)
        return sd.has_data ? sd.stock_day_last_bar ?? sd.stock_day_last_created_at : null
      }),
      health: '—',
    },
    {
      table: 'stock_min',
      pipeline: 'Fundamental · intraday OHLC (Massive)',
      coverage: `${withSm}/${n} symbols`,
      freshness: worstAge(r => {
        const sm = rowSm(r)
        return sm.has_data ? sm.last_bar_time ?? sm.last_created_at : null
      }),
      health: '—',
    },
    {
      table: 'tickers',
      pipeline: 'Fundamental · reference universe row',
      coverage: `${withTk}/${n} symbols`,
      freshness: worstAge(r => {
        const tk = rowTk(r)
        return tk.has_data ? tk.tickers_updated_at ?? tk.last_updated_utc : null
      }),
      health: '—',
    },
    {
      table: 'ticker_overview',
      pipeline: 'Fundamental · ticker details',
      coverage: `${withTo}/${n} symbols`,
      freshness: worstAge(r => {
        const o = rowTo(r)
        return o.has_data ? o.overview_updated_at : null
      }),
      health: '—',
    },
    {
      table: 'ticker_types',
      pipeline: 'Fundamental · instrument type dictionary (global)',
      coverage: ttOk ? `${ttRows} rows` : '—',
      freshness: ttOk ? fmtAgeSeconds(isoAgeSeconds(tt0.dictionary_last_created_at)) : '—',
      health: ttOk ? '—' : '—',
    },
  ]
}

const FOCUS_RADIO = 'data-overview-wl-stocks-focus-dataset'

function FocusStocksChipSelector({
  value,
  onChange,
}: {
  value: StocksFocusDataset
  onChange: (v: StocksFocusDataset) => void
}) {
  const chip = (id: StocksFocusDataset, label: string, title: string) => (
    <label className="data-overview-focus-chips__chip" title={title}>
      <input type="radio" name={FOCUS_RADIO} checked={value === id} onChange={() => onChange(id)} />
      <span>{label}</span>
    </label>
  )

  return (
    <fieldset className="data-overview-focus-chips data-overview-focus-chips--compact">
      <legend className="data-overview-focus-chips__legend">
        <span className="data-overview-focus-chips__legend-text">
          Focus dataset
          <InfoTooltip text="Fundamental (FDN) stock reference and bars only. Staging/report layers are not wired here yet. ticker_types is a single global dictionary (GET /v3/reference/tickers/types); formerly ticker_instrument_types." />
        </span>
      </legend>
      <div className="data-overview-focus-chips__matrix" role="presentation">
        <span className="data-overview-focus-chips__rk" title="Quick scope">
          Quick
        </span>
        <div className="data-overview-focus-chips__row data-overview-focus-chips__row--quick">
          {chip('all', 'All', 'Show every column group')}
          {chip('fundamental', 'Fundamental', 'stock_day, stock_min, tickers, ticker_overview, ticker_types')}
        </div>
        <span className="data-overview-focus-chips__rk" title="Fundamental tables">
          Fdn
        </span>
        <div className="data-overview-focus-chips__row">
          {STOCKS_FOCUS_TABLE_IDS.map(id => (
            <label key={id} className="data-overview-focus-chips__chip" title={id}>
              <input type="radio" name={FOCUS_RADIO} checked={value === id} onChange={() => onChange(id)} />
              <span>
                <code>{id}</code>
              </span>
            </label>
          ))}
        </div>
      </div>
    </fieldset>
  )
}

export function DataOverviewWatchlistStocksSummaryTable({
  wlRows,
}: {
  wlRows: WatchlistDbCoverageSymbolRow[]
}) {
  const summaryRows = useMemo(() => buildStocksSummaryRows(wlRows), [wlRows])
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
              <InfoTooltip text="Worst-case age across watchlist symbols where applicable; ticker_types uses the dictionary’s max(created_at)." />
            </th>
            <th scope="col">Health</th>
          </tr>
        </thead>
        <tbody>
          {summaryRows.map(row => (
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

export interface DataOverviewWatchlistStocksProps {
  wlRows: WatchlistDbCoverageSymbolRow[]
  /** When false, hide the collapsible watchlist summary block (Detail page only). */
  showWatchlistSummary?: boolean
  onWatchlistRefreshRequested?: () => void
}

export function DataOverviewWatchlistStocks({
  wlRows,
  showWatchlistSummary = true,
  onWatchlistRefreshRequested,
}: DataOverviewWatchlistStocksProps) {
  const [focusDataset, setFocusDataset] = useState<StocksFocusDataset>('all')

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
            <InfoTooltip text="Watchlist-scoped aggregates (max 80 optionable STK). ticker_types is one global table — coverage shows total dictionary rows." />
          </summary>
          <DataOverviewWatchlistStocksSummaryTable wlRows={wlRows} />
        </details>
      ) : null}

      <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            One row per watchlist symbol. Fundamental datasets only (no staging/report). Scroll horizontally; Symbol stays
            fixed.
          </p>
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <FocusStocksChipSelector value={focusDataset} onChange={setFocusDataset} />
          </div>

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
                    {show('tickers') ? (
                      <th colSpan={4} scope="colgroup">
                        <code>tickers</code>
                      </th>
                    ) : null}
                    {show('ticker_overview') ? (
                      <th colSpan={2} scope="colgroup">
                        <code>ticker_overview</code>
                      </th>
                    ) : null}
                    {show('ticker_types') ? (
                      <th colSpan={2} scope="colgroup">
                        <code title="Global instrument-type dictionary (GET /v3/reference/tickers/types). Former name: ticker_instrument_types.">
                          ticker_types
                        </code>
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
                    {show('tickers') ? (
                      <>
                        <th scope="col">Present</th>
                        <th scope="col">tickers_id</th>
                        <th scope="col">PG updated</th>
                        <th scope="col">API last_updated</th>
                      </>
                    ) : null}
                    {show('ticker_overview') ? (
                      <>
                        <th scope="col">Present</th>
                        <th scope="col">
                          Overview updated
                          <InfoTooltip text="ticker_overview.overview_updated_at (no separate created_at column in PostgreSQL)." />
                        </th>
                      </>
                    ) : null}
                    {show('ticker_types') ? (
                      <>
                        <th scope="col">
                          Dictionary rows
                          <InfoTooltip text="Total rows in the global ticker_types table — same value on every symbol row." />
                        </th>
                        <th scope="col">Last refresh</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {wlRows.map(r => {
                    const sd = rowSd(r)
                    const sm = rowSm(r)
                    const tk = rowTk(r)
                    const to = rowTo(r)
                    const tt = rowTt(r)
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
                        {show('tickers') ? (
                          <>
                            <td>{tk.has_data ? 'Yes' : '—'}</td>
                            <td>{tk.has_data && tk.tickers_id != null ? tk.tickers_id : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>{fmtTs(tk.tickers_updated_at)}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>{fmtTs(tk.last_updated_utc)}</td>
                          </>
                        ) : null}
                        {show('ticker_overview') ? (
                          <>
                            <td>{to.has_data ? 'Yes' : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>{fmtTs(to.overview_updated_at)}</td>
                          </>
                        ) : null}
                        {show('ticker_types') ? (
                          <>
                            <td>{tt.has_data && tt.dictionary_row_count != null ? tt.dictionary_row_count.toLocaleString() : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>{fmtTs(tt.dictionary_last_created_at)}</td>
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
