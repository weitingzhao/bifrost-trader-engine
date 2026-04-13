import { Fragment } from 'react'
import type { BarCoverageItem, BarsCoverageResponse, StatusResponse } from '../../../types'
import { InfoTooltip } from '../../../components/InfoTooltip'
import { coverageCell, coverageCompact, coverageRange, coverageStatusDisplay } from '../dataCoverageUtils'

export interface DataCoveragePanelProps {
  coverage: BarCoverageItem[] | null
  coveragePolicy: BarsCoverageResponse['policy'] | null
  coverageLoading: boolean
  coverageError: string | null
  deleteSymbolError: string | null
  deletingSymbol: string | null
  backfillSymbol: string | null
  backfillMessage: string | null
  isTradingDay: boolean | null
  status: StatusResponse | null
  coverageGroups: { label: string; rows: BarCoverageItem[] }[]
  indicesRefreshLoading: boolean
  indicesRefreshMessage: string | null
  watchlistRefreshMessage: string | null
  watchlistPreviewLoading: boolean
  watchlistRefreshRunning: boolean
  backfillIsTest: boolean
  needWatchlistDryRun: boolean
  backfillApiIntervalSec: number
  onLoadCoverage: () => void
  onRefreshIndices: () => void
  onWatchlistEodRefresh: () => void
  onOpenReset: (symbol: string, isIndex: boolean) => void
  onOpenPull: (symbol: string, isIndex: boolean) => void
  onOpenBarsForSymbol: (symbol: string, period: string) => void
  onBackfillIsTestChange: (value: boolean) => void
  onNeedWatchlistDryRunChange: (value: boolean) => void
  onBackfillApiIntervalSecChange: (value: number) => void
}

export function DataCoveragePanel({
  coverage,
  coveragePolicy,
  coverageLoading,
  coverageError,
  deleteSymbolError,
  deletingSymbol,
  backfillSymbol,
  backfillMessage,
  isTradingDay,
  status,
  coverageGroups,
  indicesRefreshLoading,
  indicesRefreshMessage,
  watchlistRefreshMessage,
  watchlistPreviewLoading,
  watchlistRefreshRunning,
  backfillIsTest,
  needWatchlistDryRun,
  backfillApiIntervalSec,
  onLoadCoverage,
  onRefreshIndices,
  onWatchlistEodRefresh,
  onOpenReset,
  onOpenPull,
  onOpenBarsForSymbol,
  onBackfillIsTestChange,
  onNeedWatchlistDryRunChange,
  onBackfillApiIntervalSecChange,
}: DataCoveragePanelProps) {
  return (
    <section className="replay-section" aria-labelledby="data-coverage-head">
      <h3 id="data-coverage-head" className="page-title-with-tooltip">
        Coverage
        <InfoTooltip
          text={
            coveragePolicy
              ? `Coverage of Watchlist stocks in stock_day / stock_min by period (count and date range). Target range (current config): Daily ${coveragePolicy.daily_years}y, 1 min ${coveragePolicy.min_weeks}w, 5min ${coveragePolicy['5min_months']}mo, 1h ${coveragePolicy['1hour_months']}mo. Need backfill if status is not OK. Empty when no Watchlist stocks.`
              : 'Coverage of Watchlist stocks in stock_day / stock_min by period (count and date range). Target range from config: Daily 10y, 1 min 1w, 5min 1mo, 1h 3mo. Need backfill if status is not OK. Empty when no Watchlist stocks.'
          }
        />
      </h3>
      <div className="replay-toolbar data-backfill-options" style={{ marginBottom: '0.5rem', flexWrap: 'wrap', gap: '1rem', alignItems: 'center' }}>
        <label className="data-toggle-switch-wrap" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <span
            className="toggle-switch"
            role="switch"
            aria-checked={backfillIsTest}
            tabIndex={0}
            onClick={() => onBackfillIsTestChange(!backfillIsTest)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                onBackfillIsTestChange(!backfillIsTest)
              }
            }}
          >
            <span className="toggle-switch-track" />
            <span className={backfillIsTest ? 'toggle-switch-thumb on' : 'toggle-switch-thumb'} />
          </span>
          <span>fake IB call</span>
          <InfoTooltip text="When on, pull will not call IB (test mode: only log planned requests). Default off." />
        </label>
        <label className="data-toggle-switch-wrap" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
          <span
            className="toggle-switch"
            role="switch"
            aria-checked={needWatchlistDryRun}
            tabIndex={0}
            onClick={() => onNeedWatchlistDryRunChange(!needWatchlistDryRun)}
            onKeyDown={(e) => {
              if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault()
                onNeedWatchlistDryRunChange(!needWatchlistDryRun)
              }
            }}
          >
            <span className="toggle-switch-track" />
            <span className={needWatchlistDryRun ? 'toggle-switch-thumb on' : 'toggle-switch-thumb'} />
          </span>
          <span>Dry run</span>
          <InfoTooltip text="Default off. When off, clicking EOD Pull queues worker jobs immediately. When on, click first opens the dry-run preview; only the modal confirmation will queue jobs." />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
          <span>API interval (sec):</span>
          <input
            type="number"
            min={0}
            max={300}
            value={backfillApiIntervalSec}
            onChange={(e) => onBackfillApiIntervalSecChange(Math.max(0, Math.min(300, parseInt(e.target.value, 10) || 0)))}
            style={{ width: '4rem' }}
            aria-label="Seconds between each IB API request"
          />
          <InfoTooltip text="Wait this many seconds between each IB history request (chunk). Default 10." />
          <button type="button" className="btn btn-secondary btn-sm" disabled={coverageLoading} onClick={() => onLoadCoverage()} aria-label="Refresh coverage">
            {coverageLoading ? '…' : 'Refresh coverage'}
          </button>
        </label>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={watchlistPreviewLoading || watchlistRefreshRunning}
          onClick={() => {
            void onWatchlistEodRefresh()
          }}
          aria-label={needWatchlistDryRun ? 'Dry run end-of-day pull for all Watchlist symbols' : 'Queue end-of-day pull for all Watchlist symbols'}
          title={
            needWatchlistDryRun
              ? 'Dry run first: preview overwritten records, gap range, and IB request parameters before queueing worker jobs'
              : 'Queue worker jobs immediately for all Watchlist stocks without opening dry-run preview'
          }
        >
          {watchlistPreviewLoading ? 'Dry run…' : watchlistRefreshRunning ? 'Queuing…' : 'Pull EOD'}
        </button>
        <InfoTooltip
          text={
            needWatchlistDryRun
              ? 'Dry run is enabled. Clicking the button opens the preview first; only modal confirmation will queue jobs. EOD Pull runs once after market close: fills end gap and overrides latest bars with final close (override_days=1). Dry run is off by default.'
              : 'Dry run is disabled. Clicking the button queues jobs immediately. EOD Pull runs once after market close: fills end gap and overrides latest bars with final close (override_days=1). A message like "Queued 48 EOD refresh job(s) for 12 watchlist symbol(s). override_days=1" means 48 worker jobs were enqueued (e.g. 4 periods × 12 symbols); only the latest bar per symbol/period is overwritten with end-of-day data.'
          }
        />
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={indicesRefreshLoading || (status?.live_ui?.reference_indices?.length ?? 0) === 0}
          onClick={() => {
            void onRefreshIndices()
          }}
          aria-label="Refresh Index"
          title="Pull daily bars for reference indices from Massive/Polygon into stock_day."
        >
          {indicesRefreshLoading ? 'Refreshing…' : 'Refresh Index'}
        </button>
        <InfoTooltip text="Refresh reference indices (^GSPC, ^DJI, ^IXIC) via Massive/Polygon daily aggs. Writes source=massive." />
      </div>
      {indicesRefreshMessage && (
        <div className="replay-placeholder" role="status" style={{ marginBottom: '0.5rem' }}>
          {indicesRefreshMessage}
        </div>
      )}
      {watchlistRefreshMessage && (
        <div className="replay-placeholder" role="status" style={{ marginBottom: '0.5rem' }}>
          {watchlistRefreshMessage}
        </div>
      )}
      {coverageError && (
        <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.5rem' }}>
          {coverageError}
        </div>
      )}
      {deleteSymbolError && (
        <div className="replay-placeholder" role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.5rem' }}>
          {deleteSymbolError}
        </div>
      )}
      {coverage && coverage.length === 0 && !coverageLoading && (
        <div className="replay-placeholder">No stocks in Watchlist and no reference indices configured. Add stocks on the Watchlist tab or configure reference_indices, then refresh.</div>
      )}
      {coverage && coverage.length > 0 && (
        <>
          <div className="data-coverage-table-wrap">
            <table className="table-operations data-coverage-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th colSpan={2}>Daily</th>
                  <th colSpan={2}>1 min</th>
                  <th colSpan={2}>5 mins</th>
                  <th colSpan={2}>1 hour</th>
                  <th className="data-coverage-actions">Actions</th>
                </tr>
                <tr>
                  <th></th>
                  <th className="data-coverage-bars">Bars</th>
                  <th className="data-coverage-range">Range</th>
                  <th className="data-coverage-bars">Bars</th>
                  <th className="data-coverage-range">Range</th>
                  <th className="data-coverage-bars">Bars</th>
                  <th className="data-coverage-range">Range</th>
                  <th className="data-coverage-bars">Bars</th>
                  <th className="data-coverage-range">Range</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {coverageGroups.map((group) => (
                  <Fragment key={group.label || 'all'}>
                    {group.label ? (
                      <tr className="data-coverage-group-header-row">
                        <th colSpan={10} className="data-coverage-group-header">
                          {group.label}
                        </th>
                      </tr>
                    ) : null}
                    {group.rows.map((row) => {
                      const isIndex = status?.live_ui?.reference_indices?.some((r) => r.symbol === row.symbol)
                      const dayStatus = coverageStatusDisplay(row.stock_day.status)
                      const min1Status = coverageStatusDisplay(row.stock_min['1 min']?.status)
                      const min5Status = coverageStatusDisplay(row.stock_min['5 mins']?.status)
                      const min1hStatus = coverageStatusDisplay(row.stock_min['1 hour']?.status)
                      const isDeleting = deletingSymbol === row.symbol
                      const periodsNeedingBackfill: string[] = []
                      if (dayStatus.needBackfill) periodsNeedingBackfill.push('1 D')
                      if (min1Status.needBackfill) periodsNeedingBackfill.push('1 min')
                      if (min5Status.needBackfill) periodsNeedingBackfill.push('5 mins')
                      if (min1hStatus.needBackfill) periodsNeedingBackfill.push('1 hour')
                      const isBackfilling = backfillSymbol === row.symbol
                      const canBackfill = periodsNeedingBackfill.length > 0 && !isBackfilling && !isDeleting && !isIndex
                      const emptyPeriod = { count: 0, min_ts: null, max_ts: null }
                      const renderBarsCell = (
                        p: { count: number; min_ts: number | null; max_ts: number | null },
                        needPull: boolean,
                        period: string,
                        titleStr: string,
                      ) => (
                        <button
                          type="button"
                          className="data-coverage-bars-btn"
                          onClick={() => onOpenBarsForSymbol(row.symbol, period)}
                          title={titleStr}
                          aria-label={`Show bars ${row.symbol} ${period}`}
                        >
                          {coverageCompact(p, needPull, isTradingDay)}
                        </button>
                      )
                      return (
                        <tr key={row.symbol}>
                          <td>
                            {isIndex ? (() => {
                              const ref = status?.live_ui?.reference_indices?.find((r) => r.symbol === row.symbol)
                              const label = ref?.label || row.symbol
                              return (
                                <>
                                  <strong>{label}</strong>
                                  <span className="data-coverage-status" style={{ marginLeft: '0.35rem', color: 'var(--color-text-muted)', fontWeight: 'normal', fontSize: '0.9em' }} title="Reference index symbol">
                                    {row.symbol}
                                  </span>
                                </>
                              )
                            })() : (
                              <strong>{row.symbol}</strong>
                            )}
                          </td>
                          <td className="data-coverage-bars" title={coverageCell(row.stock_day)}>
                            {renderBarsCell(row.stock_day, dayStatus.needBackfill, '1 D', coverageCell(row.stock_day))}
                          </td>
                          <td className="data-coverage-range">{coverageRange(row.stock_day)}</td>
                          <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 min'] || emptyPeriod)}>
                            {renderBarsCell(row.stock_min['1 min'] || emptyPeriod, min1Status.needBackfill, '1 min', coverageCell(row.stock_min['1 min'] || emptyPeriod))}
                          </td>
                          <td className="data-coverage-range">{coverageRange(row.stock_min['1 min'] || emptyPeriod)}</td>
                          <td className="data-coverage-bars" title={coverageCell(row.stock_min['5 mins'] || emptyPeriod)}>
                            {renderBarsCell(row.stock_min['5 mins'] || emptyPeriod, min5Status.needBackfill, '5 mins', coverageCell(row.stock_min['5 mins'] || emptyPeriod))}
                          </td>
                          <td className="data-coverage-range">{coverageRange(row.stock_min['5 mins'] || emptyPeriod)}</td>
                          <td className="data-coverage-bars" title={coverageCell(row.stock_min['1 hour'] || emptyPeriod)}>
                            {renderBarsCell(row.stock_min['1 hour'] || emptyPeriod, min1hStatus.needBackfill, '1 hour', coverageCell(row.stock_min['1 hour'] || emptyPeriod))}
                          </td>
                          <td className="data-coverage-range">{coverageRange(row.stock_min['1 hour'] || emptyPeriod)}</td>
                          <td className="data-coverage-actions data-coverage-actions-nowrap">
                            {isIndex ? (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-reset btn-sm"
                                  disabled={isDeleting}
                                  onClick={() => onOpenReset(row.symbol, true)}
                                  title="Reset daily bars for this index"
                                  aria-label={`Reset ${row.symbol}`}
                                >
                                  {isDeleting ? '…' : 'Reset'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  disabled={indicesRefreshLoading || backfillSymbol === row.symbol}
                                  title="Pull daily bars for this index from Massive/Polygon (same range modal as Watchlist)"
                                  aria-label={`Pull ${row.symbol}`}
                                  onClick={() => onOpenPull(row.symbol, true)}
                                >
                                  {backfillSymbol === row.symbol ? (backfillMessage || 'Pulling…') : 'Pull'}
                                </button>
                              </>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className="btn btn-reset btn-sm"
                                  disabled={isDeleting}
                                  onClick={() => onOpenReset(row.symbol, false)}
                                  title="Reset all bars for this symbol (stock_day + stock_min); then you can Pull from scratch"
                                  aria-label={`Reset data for ${row.symbol}`}
                                >
                                  {isDeleting ? '…' : 'Reset'}
                                </button>
                                {periodsNeedingBackfill.length > 0 && (
                                  <button
                                    type="button"
                                    className="btn btn-secondary btn-sm"
                                    disabled={!canBackfill}
                                    title={`Queue pull for ${periodsNeedingBackfill.join(', ')}`}
                                    aria-label={`Pull ${row.symbol}`}
                                    onClick={() => onOpenPull(row.symbol, false)}
                                  >
                                    {isBackfilling ? (backfillMessage || 'Queuing…') : 'Pull'}
                                  </button>
                                )}
                              </>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
