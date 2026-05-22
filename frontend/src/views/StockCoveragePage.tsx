import { rl } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
import type { StatusResponse } from '../types'
import { PageSection } from '@/components/shared/page-section'
import { Button } from '@/components/ui/button'
import { DraggableModal } from '../components/DraggableModal'
import { SettingsCoverageTitle } from './settings/SettingsCoverageTitle'
import { useBarsCoverage } from './data/useBarsCoverage'
import { DataCoveragePanel } from './data/panels'
import { fmtDurationSeconds, fmtTs } from '../utils/format'
import type { WatchlistEodRefreshPreviewItem } from '../api'
import { ALL_BAR_PERIOD_VALUES, BAR_PERIODS } from './data/constants'

interface StockCoveragePageProps {
  status: StatusResponse | null
}

export function StockCoveragePage({ status }: StockCoveragePageProps) {
  const cov = useBarsCoverage(status)

  return (
    <PageSection className="market-data-page market-data-page--settings-embed">
      <SettingsCoverageTitle
        groupLabel="Stock"
        groupHash="#coverage-stock"
        pageTitle="IB Live (Redis)"
        infoText="IB-backed coverage of Watchlist stocks and reference indices by bar period. Includes backfill controls for end-of-day pulls and index refresh. For delayed Massive stock reference data, use Data Coverage → Stock → Massive Delay (DB)."
      />

      <DataCoveragePanel
        coverage={cov.coverage}
        coveragePolicy={cov.coveragePolicy}
        coverageLoading={cov.coverageLoading}
        coverageError={cov.coverageError}
        deleteSymbolError={cov.deleteSymbolError}
        deletingSymbol={cov.deletingSymbol}
        backfillSymbol={cov.backfillSymbol}
        backfillMessage={cov.backfillMessage}
        isTradingDay={cov.isTradingDay}
        status={status}
        coverageGroups={cov.coverageGroups}
        indicesRefreshLoading={cov.indicesRefreshLoading}
        indicesRefreshMessage={cov.indicesRefreshMessage}
        watchlistRefreshMessage={cov.watchlistRefreshMessage}
        watchlistPreviewLoading={cov.watchlistPreviewLoading}
        watchlistRefreshRunning={cov.watchlistRefreshRunning}
        backfillIsTest={cov.backfillIsTest}
        needWatchlistDryRun={cov.needWatchlistDryRun}
        backfillApiIntervalSec={cov.backfillApiIntervalSec}
        onLoadCoverage={cov.loadCoverage}
        onRefreshIndices={cov.handleRefreshIndices}
        onWatchlistEodRefresh={cov.handleWatchlistEodRefreshClick}
        onOpenReset={cov.handleOpenReset}
        onOpenPull={cov.handleOpenPull}
        onOpenBarsForSymbol={cov.openBarsForSymbol}
        onBackfillIsTestChange={cov.setBackfillIsTest}
        onNeedWatchlistDryRunChange={cov.setNeedWatchlistDryRun}
        onBackfillApiIntervalSecChange={cov.setBackfillApiIntervalSec}
      />

      {/* Watchlist EOD Refresh dry-run preview modal */}
      <DraggableModal
        open={cov.watchlistRefreshPreview != null}
        onBackdropClick={() => {
          if (!cov.watchlistRefreshRunning) cov.setWatchlistRefreshPreview(null)
        }}
        backdropLocked={cov.watchlistRefreshRunning}
        title="Dry run: EOD Pull"
        titleId="eod-dry-run-title"
        maxWidth="min(1100px, 92vw)"
        panelStyle={{ width: '92vw', maxHeight: '85vh' }}
        footer={
          <div className={w9.dataResetModalActions}>
            <Button
              type="button"
              variant="secondary"
              disabled={cov.watchlistRefreshRunning}
              onClick={() => cov.setWatchlistRefreshPreview(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={
                cov.watchlistRefreshRunning ||
                cov.watchlistRefreshPreview?.ready_to_enqueue === false ||
                (cov.watchlistRefreshPreview?.items || []).length === 0
              }
              onClick={() => {
                void cov.confirmWatchlistEodRefresh()
              }}
            >
              {cov.watchlistRefreshRunning ? 'Queuing…' : 'Confirm and Queue'}
            </Button>
          </div>
        }
      >
        {cov.watchlistRefreshPreview != null && (
          <>
            <p>Review overwrite records, gap range, and IB request chunks before queueing worker jobs.</p>
            <div className={rl.placeholder} role="status" style={{ marginBottom: '0.75rem' }}>
              {(cov.watchlistRefreshPreview.message || 'Dry run ready') +
                ` Symbols: ${cov.watchlistRefreshPreview.symbols_count ?? 0}, jobs if confirmed: ${cov.watchlistRefreshPreview.queued_jobs_if_confirmed ?? 0}, override_days: ${cov.watchlistRefreshPreview.override_days ?? 1}, API interval: ${cov.watchlistRefreshPreview.api_interval_sec ?? cov.backfillApiIntervalSec}s, mode: ${cov.backfillIsTest ? 'test' : 'live'}.`}
            </div>
            {cov.watchlistRefreshPreview.ready_to_enqueue === false && (
              <div className={rl.placeholder} role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.75rem' }}>
                Monitor is currently stopped, so this preview cannot be confirmed into worker jobs until monitor is available again.
              </div>
            )}
            {(cov.watchlistRefreshPreview.failures || []).length > 0 && (
              <div className={rl.placeholder} role="alert" style={{ color: 'var(--danger, #c00)', marginBottom: '0.75rem' }}>
                Preview failures: {(cov.watchlistRefreshPreview.failures || []).map(f => `${f.symbol} ${f.period}: ${f.error}`).join(' | ')}
              </div>
            )}
            {(cov.watchlistRefreshPreview.items || []).length === 0 ? (
              <div className={rl.placeholder}>No preview items.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {(cov.watchlistRefreshPreview.items || []).map((item: WatchlistEodRefreshPreviewItem, index) => (
                  <details key={`${item.symbol}-${item.period}-${index}`} style={{ border: '1px solid var(--color-border)', borderRadius: '8px', padding: '0.75rem', background: 'var(--color-surface)' }}>
                    <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                      {item.symbol} · {item.period} · overwrite {(item.override_records?.count ?? 0).toLocaleString()} · IB chunks {(item.ib_request_plan?.length ?? 0).toLocaleString()}
                    </summary>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))', gap: '0.5rem', marginTop: '0.75rem' }}>
                      <div><strong>Latest stored:</strong> {fmtTs(item.latest_ts)}</div>
                      <div><strong>Fetch window:</strong> {fmtTs(item.fetch_start_ts)} ~ {fmtTs(item.fetch_end_ts)}</div>
                      <div><strong>Gap to fill:</strong> {item.gap_to_fill?.has_gap ? `${fmtTs(item.gap_to_fill?.start_ts)} ~ ${fmtTs(item.gap_to_fill?.end_ts)}` : '—'}</div>
                      <div><strong>Gap span:</strong> {fmtDurationSeconds(item.gap_to_fill?.span_seconds)}</div>
                    </div>
                    <div style={{ marginTop: '0.75rem' }}>
                      <strong>Records expected to be overwritten</strong>
                      {item.override_records && item.override_records.count > 0 ? (
                        <div style={{ marginTop: '0.4rem', maxHeight: '10rem', overflow: 'auto', border: '1px solid var(--color-border)', borderRadius: '6px', padding: '0.5rem', background: 'var(--color-bg)' }}>
                          {item.override_records.times.map((ts, tsIndex) => (
                            <div key={`override-${tsIndex}`}>{fmtTs(ts)}</div>
                          ))}
                        </div>
                      ) : (
                        <div className={rl.syncHint} style={{ marginTop: '0.4rem' }}>No existing bars in the override window.</div>
                      )}
                    </div>
                    <div style={{ marginTop: '0.75rem' }}>
                      <strong>IB request plan</strong>
                      {item.ib_request_plan && item.ib_request_plan.length > 0 ? (
                        <div style={{ overflowX: 'auto', marginTop: '0.4rem' }}>
                          <table className={w9.tableOperations}>
                            <thead><tr><th>#</th><th>barSizeSetting</th><th>durationStr</th><th>endDateTime</th><th>Segment</th></tr></thead>
                            <tbody>
                              {item.ib_request_plan.map((req, reqIndex) => (
                                <tr key={`req-${reqIndex}`}><td>{reqIndex + 1}</td><td>{req.barSizeSetting}</td><td>{req.durationStr}</td><td>{req.endDateTime}</td><td>{fmtTs(req.seg_start_ts)} ~ {fmtTs(req.seg_end_ts)}</td></tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className={rl.syncHint} style={{ marginTop: '0.4rem' }}>No IB request would be needed for this item.</div>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </>
        )}
      </DraggableModal>

      {/* Reset confirmation modal */}
      <DraggableModal
        open={cov.resetConfirmSymbol != null}
        onBackdropClick={() => {
          cov.setResetConfirmSymbol(null)
          cov.setResetConfirmIsIndex(false)
        }}
        title={cov.resetConfirmIsIndex ? 'Reset index data' : 'Reset data'}
        titleId="reset-modal-title"
        footer={
          <div className={w9.dataResetModalActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                cov.setResetConfirmSymbol(null)
                cov.setResetConfirmIsIndex(false)
              }}
            >
              No
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={!cov.resetConfirmIsIndex && cov.resetPeriods.length === 0}
              onClick={() => {
                void cov.handleConfirmReset()
              }}
            >
              Yes
            </Button>
          </div>
        }
      >
        {cov.resetConfirmIsIndex ? (
          <p>Clear daily bars for this index only (cannot be undone).</p>
        ) : (
          <>
            <p>Select periods to clear (cannot be undone):</p>
            <div className={w9.dataResetPeriods}>
              {BAR_PERIODS.map(({ value, label }) => (
                <label key={value} className={w9.dataResetPeriodCheck}>
                  <input
                    type="checkbox"
                    checked={cov.resetPeriods.includes(value)}
                    onChange={e => {
                      if (e.target.checked) cov.setResetPeriods(p => [...p, value])
                      else cov.setResetPeriods(p => p.filter(x => x !== value))
                    }}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          </>
        )}
      </DraggableModal>

      {/* Pull range modal */}
      <DraggableModal
        open={cov.pullModalSymbol != null}
        onBackdropClick={() => {
          cov.setPullModalSymbol(null)
          cov.setPullModalIsIndex(false)
        }}
        title={cov.pullModalIsIndex ? 'Pull index (Massive/Polygon)' : 'Time range for backfill'}
        titleId="pull-range-modal-title"
        panelClassName="data-pull-range-modal"
        maxWidth="min(420px, calc(100vw - 24px))"
        footer={
          <div className={w9.dataResetModalActions}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                cov.setPullModalSymbol(null)
                cov.setPullModalIsIndex(false)
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={cov.pullRangeMode === null || (!cov.pullModalIsIndex && cov.pullSelectedPeriods.length === 0)}
              onClick={() => {
                void cov.handleConfirmPull()
              }}
            >
              Confirm
            </Button>
          </div>
        }
      >
        {cov.pullModalSymbol != null && (
          <>
            <p className={w9.dataPullRangeDesc}>
              {cov.pullModalIsIndex
                ? `Choose how many days to fetch for ${cov.pullModalSymbol}. Index data is daily only (Massive/Polygon).`
                : `Choose how much history to fetch for ${cov.pullModalSymbol}.`}
            </p>
            <div className={w9.dataPullRangeOptions}>
              {(['max', 'min', 'custom'] as const).map(mode => {
                const labels = {
                  max: 'Maximum — use history_backfill config',
                  min: 'Minimum — Daily 30d; 1min 1h; 5min 1d; 1h 1w',
                  custom: 'Custom — set your own span',
                }
                return (
                  <label key={mode} className={w9.dataPullRangeOption}>
                    <input type="radio" name="pullRange" checked={cov.pullRangeMode === mode} onChange={() => cov.setPullRangeMode(mode)} />
                    <span>
                      <strong>{mode.charAt(0).toUpperCase() + mode.slice(1)}</strong> — {labels[mode].split(' — ')[1]}
                    </span>
                  </label>
                )
              })}
            </div>
            {cov.pullRangeMode === 'custom' && (
              <div className={w9.dataPullRangeCustom}>
                <label className={w9.dataPullRangeCustomRow}>
                  <span>Daily (days):</span>
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={cov.pullCustomDailyDays}
                    onChange={e => cov.setPullCustomDailyDays(Math.max(1, Number(e.target.value) || 1))}
                  />
                </label>
                {!cov.pullModalIsIndex && (
                  <>
                    <label className={w9.dataPullRangeCustomRow}>
                      <span>1 min (hours):</span>
                      <input
                        type="number"
                        min={1}
                        max={8760}
                        value={cov.pullCustom1minHours}
                        onChange={e => cov.setPullCustom1minHours(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                    <label className={w9.dataPullRangeCustomRow}>
                      <span>5 mins (days):</span>
                      <input
                        type="number"
                        min={1}
                        max={3650}
                        value={cov.pullCustom5minDays}
                        onChange={e => cov.setPullCustom5minDays(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                    <label className={w9.dataPullRangeCustomRow}>
                      <span>1 hour (days):</span>
                      <input
                        type="number"
                        min={1}
                        max={3650}
                        value={cov.pullCustom1hourDays}
                        onChange={e => cov.setPullCustom1hourDays(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            {!cov.pullModalIsIndex && (
              <div className={w9.dataPullRangePeriods}>
                <span className={w9.dataPullRangePeriodsLabel}>Periods to pull:</span>
                <label className={w9.dataPullRangePeriodCheck}>
                  <input
                    type="checkbox"
                    checked={cov.pullSelectedPeriods.length === 4}
                    onChange={e => cov.setPullSelectedPeriods(e.target.checked ? [...ALL_BAR_PERIOD_VALUES] : [])}
                  />
                  <span>All</span>
                </label>
                {ALL_BAR_PERIOD_VALUES.map(period => (
                  <label key={period} className={w9.dataPullRangePeriodCheck}>
                    <input
                      type="checkbox"
                      checked={cov.pullSelectedPeriods.includes(period)}
                      onChange={e => {
                        if (e.target.checked) cov.setPullSelectedPeriods(p => [...p, period])
                        else cov.setPullSelectedPeriods(p => p.filter(x => x !== period))
                      }}
                    />
                    <span>{BAR_PERIODS.find(p => p.value === period)?.label ?? period}</span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}
      </DraggableModal>
    </PageSection>
  )
}
