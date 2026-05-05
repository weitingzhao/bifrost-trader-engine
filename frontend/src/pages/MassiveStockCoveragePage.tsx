import { useCallback, useEffect, useState } from 'react'
import type { BarCoverageItem, StatusResponse } from '../types'
import {
  fetchBarsCoverage,
  fetchMassiveStatus,
  fetchMarketHolidays,
  postMarketHoliday,
  deleteMarketHoliday,
  type MassiveStatusResponse,
  type MarketHolidayRow,
} from '../api'
import { InfoTooltip } from '../components/InfoTooltip'
import { MassiveDelayDbRefJobsBar } from './massive/MassiveDelayDbRefJobsBar'
import { MassiveRefJobSessionProvider } from './massive/MassiveRefJobSessionContext'
import { MassiveStockOhlcDbEnqueueBlock } from './massive/MassiveStockOhlcDbEnqueueBlock'
import { MassiveTickerReferenceDbSection } from './massive/MassiveTickerReferenceDbSection'
import { HolidaysSection } from './settings/HolidaysSection'

interface MassiveStockCoveragePageProps {
  status: StatusResponse | null
}

/** Data Coverage → Stock → Massive Delay (DB): reference tools and navigation. */
type MassiveDelayDbMainTab = 'tickers' | 'aggregate_bars' | 'market_operations'

export function MassiveStockCoveragePage({ status }: MassiveStockCoveragePageProps) {
  const [massiveStatus, setMassiveStatus] = useState<MassiveStatusResponse | null>(null)
  const [coverage, setCoverage] = useState<BarCoverageItem[] | null>(null)
  const [coverageLoading, setCoverageLoading] = useState(false)
  const [coverageError, setCoverageError] = useState<string | null>(null)
  const [delayDbMainTab, setDelayDbMainTab] = useState<MassiveDelayDbMainTab>('tickers')

  const currentYear = new Date().getFullYear()
  const [holidays, setHolidays] = useState<MarketHolidayRow[]>([])
  const [holidaysYear, setHolidaysYear] = useState<string>(() => String(new Date().getFullYear()))
  const [holidaysLoading, setHolidaysLoading] = useState(false)
  const [holidayMsg, setHolidayMsg] = useState({ text: '', isErr: false })
  const [addDate, setAddDate] = useState('')
  const [addLabel, setAddLabel] = useState('')

  useEffect(() => {
    let cancelled = false
    fetchMassiveStatus()
      .then(s => { if (!cancelled) setMassiveStatus(s) })
      .catch(() => { if (!cancelled) setMassiveStatus(null) })
    return () => { cancelled = true }
  }, [])

  const loadCoverage = useCallback(async () => {
    setCoverageLoading(true)
    setCoverageError(null)
    try {
      const res = await fetchBarsCoverage()
      setCoverage(res.coverage || [])
    } catch (e) {
      setCoverageError(e instanceof Error ? e.message : 'Load failed')
      setCoverage([])
    } finally {
      setCoverageLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadCoverage()
  }, [loadCoverage])

  const loadHolidays = useCallback(async () => {
    setHolidaysLoading(true)
    setHolidayMsg({ text: '', isErr: false })
    try {
      const yearNum = holidaysYear === '' ? undefined : parseInt(holidaysYear, 10)
      const list = await fetchMarketHolidays(Number.isFinite(yearNum) ? yearNum : undefined, 'NYSE')
      setHolidays(list)
    } catch (e) {
      setHolidayMsg({ text: (e as Error).message, isErr: true })
      setHolidays([])
    } finally {
      setHolidaysLoading(false)
    }
  }, [holidaysYear])

  useEffect(() => {
    if (delayDbMainTab === 'market_operations') void loadHolidays()
  }, [delayDbMainTab, loadHolidays])

  const onAddHoliday = useCallback(async () => {
    const d = addDate.trim().slice(0, 10)
    if (!d) { setHolidayMsg({ text: 'Enter a date.', isErr: true }); return }
    setHolidayMsg({ text: '', isErr: false })
    try {
      await postMarketHoliday({ date: d, label: addLabel.trim() || undefined, exchange: 'NYSE' })
      setAddDate('')
      setAddLabel('')
      setHolidayMsg({ text: 'Holiday added.', isErr: false })
      void loadHolidays()
    } catch (e) {
      setHolidayMsg({ text: (e as Error).message, isErr: true })
    }
  }, [addDate, addLabel, loadHolidays])

  const onDeleteHoliday = useCallback(async (dateStr: string) => {
    try {
      await deleteMarketHoliday(dateStr, 'NYSE')
      setHolidayMsg({ text: '', isErr: false })
      void loadHolidays()
    } catch (e) {
      setHolidayMsg({ text: (e as Error).message, isErr: true })
    }
  }, [loadHolidays])

  const configured = Boolean(massiveStatus?.configured)

  return (
    <div className="card process-section market-data-page market-data-page--settings-embed">
      <h2 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)' }}>
        <button
          type="button"
          className="page-title-breadcrumb-link"
          onClick={() => { window.location.hash = '#settings-heartbeat' }}
          aria-label="Go to Settings"
        >
          Settings
        </button>
        {' / '}
        <button
          type="button"
          className="page-title-breadcrumb-link"
          onClick={() => { window.location.hash = '#coverage-stock' }}
          aria-label="Go to Stock coverage (IB Live)"
        >
          Stock
        </button>
        {' / '}
        Massive Delay (DB)
        <InfoTooltip text="Massive (Polygon) stocks: REST and synced reference data are delayed per vendor plan (~15 minutes). For realtime watchlist history and EOD bar pulls, use Data Coverage → Stock → IB Live (Redis)." />
        {configured && (
          <span className="feed-massive-delay-pill" title={massiveStatus?.delay_notice} style={{ marginLeft: 'var(--space-2)' }}>
            Delayed feed
          </span>
        )}
      </h2>

      <section className="replay-section" aria-label="Massive stocks overview">
        <div style={{ marginBottom: 'var(--space-4)', display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { window.location.hash = '#coverage-stock' }}
          >
            IB Live (Redis)
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => { window.location.hash = '#feed-massive-stock' }}
          >
            Massive Stock (API checklist)
          </button>
        </div>
      </section>

      {!configured ? (
        <p className="status-page-msg err" role="alert" style={{ marginBottom: 'var(--space-3)' }}>
          Massive API key not configured. Set massive credentials in server config. Celery enqueue and REST checklist require a configured key.
        </p>
      ) : null}

      <section className="replay-section" aria-labelledby="massive-stock-coverage-refdb-title">
        <MassiveRefJobSessionProvider>
          <div className="massive-delay-ref-heading">
            <h3 id="massive-stock-coverage-refdb-title" className="page-title-with-tooltip massive-delay-ref-heading-title">
              Reference (PostgreSQL)
              <InfoTooltip text="All reference sync and verification is coordinated through Jobs: ticker_reference_* tasks and feed_stocks_aggregate on stocks_massive / stocks_massive_high." />
            </h3>
            <MassiveDelayDbRefJobsBar />
          </div>
          <div className="feed-massive-option-page" style={{ marginTop: 'var(--space-3)' }}>
            <div className="feed-massive-agg-tabs-wrap massive-delay-db-main-tabs">
              <div className="feed-massive-agg-tabs" role="tablist" aria-label="Massive Delay DB sections">
                <button
                  type="button"
                  role="tab"
                  id="massive-delay-db-tab-tickers"
                  className={`feed-massive-agg-tab${delayDbMainTab === 'tickers' ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={delayDbMainTab === 'tickers'}
                  tabIndex={delayDbMainTab === 'tickers' ? 0 : -1}
                  onClick={() => setDelayDbMainTab('tickers')}
                >
                  Tickers
                </button>
                <button
                  type="button"
                  role="tab"
                  id="massive-delay-db-tab-aggregate-bars"
                  className={`feed-massive-agg-tab${delayDbMainTab === 'aggregate_bars' ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={delayDbMainTab === 'aggregate_bars'}
                  tabIndex={delayDbMainTab === 'aggregate_bars' ? 0 : -1}
                  onClick={() => setDelayDbMainTab('aggregate_bars')}
                >
                  Aggregate Bars (OHLC)
                </button>
                <button
                  type="button"
                  role="tab"
                  id="massive-delay-db-tab-market-operations"
                  className={`feed-massive-agg-tab${delayDbMainTab === 'market_operations' ? ' feed-massive-agg-tab--active' : ''}`}
                  aria-selected={delayDbMainTab === 'market_operations'}
                  tabIndex={delayDbMainTab === 'market_operations' ? 0 : -1}
                  onClick={() => setDelayDbMainTab('market_operations')}
                >
                  Market Operations
                </button>
              </div>
              <div className="feed-massive-agg-tab-panels">
                {delayDbMainTab === 'tickers' ? (
                  <div
                    className="feed-massive-agg-tab-panel"
                    role="tabpanel"
                    id="massive-delay-db-panel-tickers"
                    aria-labelledby="massive-delay-db-tab-tickers"
                  >
                    <MassiveTickerReferenceDbSection
                      panelId="massive-stock-coverage-refdb"
                      ariaLabelledBy="massive-delay-db-tab-tickers"
                      showJobsToolbar={false}
                      rootRole="region"
                    />
                  </div>
                ) : delayDbMainTab === 'aggregate_bars' ? (
                  <div
                    className="feed-massive-agg-tab-panel"
                    role="tabpanel"
                    id="massive-delay-db-panel-aggregate-bars"
                    aria-labelledby="massive-delay-db-tab-aggregate-bars"
                  >
                    <MassiveStockOhlcDbEnqueueBlock
                      configured={configured}
                      status={status}
                      coverage={coverage}
                      coverageLoading={coverageLoading}
                      coverageError={coverageError}
                      onRefreshCoverage={loadCoverage}
                      dailyFullBackfillYears={massiveStatus?.daily_full_backfill_years ?? 5}
                    />
                  </div>
                ) : (
                  <div
                    className="feed-massive-agg-tab-panel"
                    role="tabpanel"
                    id="massive-delay-db-panel-market-operations"
                    aria-labelledby="massive-delay-db-tab-market-operations"
                  >
                    <HolidaysSection
                      currentYear={currentYear}
                      holidays={holidays}
                      holidaysYear={holidaysYear}
                      setHolidaysYear={setHolidaysYear}
                      holidaysLoading={holidaysLoading}
                      loadHolidays={loadHolidays}
                      addDate={addDate}
                      setAddDate={setAddDate}
                      addLabel={addLabel}
                      setAddLabel={setAddLabel}
                      holidayMsg={holidayMsg}
                      onAddHoliday={onAddHoliday}
                      onDeleteHoliday={onDeleteHoliday}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </MassiveRefJobSessionProvider>
      </section>
    </div>
  )
}
