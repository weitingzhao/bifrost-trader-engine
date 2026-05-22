import { InfoTooltip } from '../../components/InfoTooltip'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { celeryQueueHash } from '../../utils/celeryQueueDeepLink'
import { feedMassiveStockTickersSubHash } from './feedMassiveStockTabUtils'
import {
  DEFAULT_TICKER_REF_MISSING_LIMIT,
  DEFAULT_TICKER_REF_SEARCH_LIMIT,
  MAX_TICKER_REF_MISSING_LIMIT,
  REF_CATALOG_PG_LABELS,
  type OverviewEnqueueMode,
  type RelatedEnqueueMode,
  refJobKindShortLabel,
  isFeedStocksTickersRelatedRefKind,
  isFeedStocksTickersOverviewRefKind,
  isFeedStocksTickersReferenceUniverseRefKind,
  isFeedStocksTickersTypesRefKind,
  type RefTickerCatalogRow,
  type TrackedMassiveDbJobKind,
} from './stockReferenceJobHelpers'

const RELATED_SCOPE_BUBBLES: ReadonlyArray<{
  value: RelatedEnqueueMode
  label: string
  title: string
}> = [
  {
    value: 'missing',
    label: 'Missing only',
    title: 'Tickers with no ticker_related_tickers rows for from_tickers_id.',
  },
  {
    value: 'stale',
    label: 'Missing or stale',
    title: 'No related rows, or latest fetched_at older than stale hours.',
  },
  {
    value: 'symbols',
    label: 'Listed symbols',
    title: 'Only symbols in the enqueue field below.',
  },
  {
    value: 'all',
    label: 'All tickers',
    title: 'Re-fetch related peers for every row in tickers.',
  },
]

const OVERVIEW_SCOPE_BUBBLES: ReadonlyArray<{
  value: OverviewEnqueueMode
  label: string
  title: string
}> = [
  {
    value: 'missing',
    label: 'Missing only',
    title: 'Tickers with no ticker_overview row (gap vs public.tickers).',
  },
  {
    value: 'stale',
    label: 'Missing or stale',
    title: 'No overview, null overview_updated_at, or older than stale hours.',
  },
  {
    value: 'symbols',
    label: 'Listed symbols',
    title: 'Only symbols in the enqueue field below.',
  },
  {
    value: 'all',
    label: 'All tickers',
    title: 'Refresh overview for every row in tickers (full pass).',
  },
]

function CatalogEnqueueIcon({ busy }: { busy: boolean }) {
  if (busy) {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path
          d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <path d="M5 7h10M5 12h10M5 17h7" />
      <path d="M18 9v6M15 12h6" />
    </svg>
  )
}

function renderTableNameList(tables: readonly string[]) {
  return tables.map((t, i) => (
    <span key={t}>
      {i > 0 ? <span className="ref-jobs-catalog-table-sep"> · </span> : null}
      <code className="ref-jobs-catalog-code ref-jobs-catalog-table-name">{t}</code>
    </span>
  ))
}

export interface TickerOverviewCoverageCounts {
  total_tickers: number
  missing: number
  filled: number
}

export interface RefJobDetailPanelProps {
  catalogRow: RefTickerCatalogRow
  disabledForJobs: boolean
  busyVerify: boolean
  jobBusyKind: TrackedMassiveDbJobKind | null
  overviewEnqueueMode: OverviewEnqueueMode
  setOverviewEnqueueMode: (m: OverviewEnqueueMode) => void
  overviewStaleHours: number
  setOverviewStaleHours: (n: number) => void
  relatedEnqueueMode: RelatedEnqueueMode
  setRelatedEnqueueMode: (m: RelatedEnqueueMode) => void
  relatedStaleHours: number
  setRelatedStaleHours: (n: number) => void
  refJobSymbols: string
  setRefJobSymbols: (s: string) => void
  refJobSymbolsErr: string | null
  onEnqueue: () => void
  searchQuery: string
  setSearchQuery: (s: string) => void
  searchLimit: number
  setSearchLimit: (n: number) => void
  overviewSymbol: string
  setOverviewSymbol: (s: string) => void
  relatedSymbol: string
  setRelatedSymbol: (s: string) => void
  onVerifySearch: () => void
  onVerifyOverviewMerged: () => void
  onVerifyOverviewMissingFirst: () => void
  onVerifyOverviewMissingMore: () => void
  overviewMissingLimit: number
  setOverviewMissingLimit: (n: number) => void
  missingOverviewHasMore: boolean
  missingOverviewLoadedCount: number
  onVerifyRelatedDb: () => void
  onVerifyInstrumentTypes: () => void
  overviewCoverage: TickerOverviewCoverageCounts | null
  overviewCoverageLoading: boolean
  overviewVerifyKind: 'merged' | 'missing' | null
  overviewMissingVerifyAppend: boolean
  relatedCoverage: TickerOverviewCoverageCounts | null
  relatedCoverageLoading: boolean
  relatedListPageLimit: number
  setRelatedListPageLimit: (n: number) => void
  onVerifyRelatedMissingFirst: () => void
  onVerifyRelatedMissingMore: () => void
  onVerifyRelatedFilledFirst: () => void
  onVerifyRelatedFilledMore: () => void
  missingRelatedHasMore: boolean
  missingRelatedLoadedCount: number
  filledRelatedHasMore: boolean
  filledRelatedLoadedCount: number
  relatedVerifyKind: 'symbol' | 'missing' | 'filled' | null
  relatedMissingVerifyAppend: boolean
  relatedFilledVerifyAppend: boolean
  universeRowCount: number | null
  universeRowCountLoading: boolean
  tickerTypesRowCount: number | null
  tickerTypesRowCountLoading: boolean
}

export function RefJobDetailPanel({
  catalogRow,
  disabledForJobs,
  busyVerify,
  jobBusyKind,
  overviewEnqueueMode,
  setOverviewEnqueueMode,
  overviewStaleHours,
  setOverviewStaleHours,
  relatedEnqueueMode,
  setRelatedEnqueueMode,
  relatedStaleHours,
  setRelatedStaleHours,
  refJobSymbols,
  setRefJobSymbols,
  refJobSymbolsErr,
  onEnqueue,
  searchQuery,
  setSearchQuery,
  searchLimit,
  setSearchLimit,
  overviewSymbol,
  setOverviewSymbol,
  relatedSymbol,
  setRelatedSymbol,
  onVerifySearch,
  onVerifyOverviewMerged,
  onVerifyOverviewMissingFirst,
  onVerifyOverviewMissingMore,
  overviewMissingLimit,
  setOverviewMissingLimit,
  missingOverviewHasMore,
  missingOverviewLoadedCount,
  onVerifyRelatedDb,
  onVerifyInstrumentTypes,
  overviewCoverage,
  overviewCoverageLoading,
  overviewVerifyKind,
  overviewMissingVerifyAppend,
  relatedCoverage,
  relatedCoverageLoading,
  relatedListPageLimit,
  setRelatedListPageLimit,
  onVerifyRelatedMissingFirst,
  onVerifyRelatedMissingMore,
  onVerifyRelatedFilledFirst,
  onVerifyRelatedFilledMore,
  missingRelatedHasMore,
  missingRelatedLoadedCount,
  filledRelatedHasMore,
  filledRelatedLoadedCount,
  relatedVerifyKind,
  relatedMissingVerifyAppend,
  relatedFilledVerifyAppend,
  universeRowCount,
  universeRowCountLoading,
  tickerTypesRowCount,
  tickerTypesRowCountLoading,
}: RefJobDetailPanelProps) {
  const kind = catalogRow.kind
  const jobLabel = refJobKindShortLabel(kind)
  const enqueueBusy = jobBusyKind === kind
  const disabledEnqueue = disabledForJobs || enqueueBusy

  return (
    <div className="ref-jobs-md-panel" id="ref-job-detail-panel" role="tabpanel">
      <div className="ref-jobs-md-meta">
        <div className="ref-jobs-md-meta-row">
          <span className="ref-jobs-md-meta-label">Job</span>
          <span>
            <strong>{jobLabel}</strong>
            <InfoTooltip text={catalogRow.hint} />
          </span>
        </div>
        <div className="ref-jobs-md-meta-row">
          <span className="ref-jobs-md-meta-label">REST</span>
          <a
            href={feedMassiveStockTickersSubHash(catalogRow.tickersSubTab)}
            className="ref-jobs-catalog-api-link"
            title="Open Massive Stock → Tickers (matching REST tab)"
          >
            {catalogRow.restEndpointShort}
          </a>
        </div>
        <div className="ref-jobs-md-meta-row">
          <span className="ref-jobs-md-meta-label">Queue</span>
          <a href={celeryQueueHash(catalogRow.queueNote)} className="ref-jobs-catalog-queue-link" title="Open Celery queue">
            <code className="ref-jobs-catalog-code">{catalogRow.queueNote}</code>
          </a>
        </div>
        <div className="ref-jobs-md-meta-row">
          <span className="ref-jobs-md-meta-label">{REF_CATALOG_PG_LABELS.business}</span>
          <span>{renderTableNameList(catalogRow.businessTables)}</span>
        </div>
        <div className="ref-jobs-md-meta-row">
          <span className="ref-jobs-md-meta-label">{REF_CATALOG_PG_LABELS.job}</span>
          <span>
            {catalogRow.jobTables.length > 0 ? renderTableNameList(catalogRow.jobTables) : <span className="ref-jobs-catalog-pg-empty">—</span>}
          </span>
        </div>
      </div>

      <h4 className="ref-jobs-md-section-title">Enqueue</h4>
      <div className="ref-jobs-md-enqueue-row">
        <div className="ref-jobs-md-enqueue-fields">
          {isFeedStocksTickersReferenceUniverseRefKind(kind) ? (
            <div>
              <p className="ref-jobs-md-enqueue-hint">Full pagination sync (1000 rows/page) until cursor ends. No extra fields.</p>
              <div className={w9.refOverviewCoverageStrip} style={{ marginTop: 'var(--space-2)' }} aria-live="polite">
                {universeRowCountLoading ? (
                  <span className={w9.refOverviewCoverageMuted}>Loading row count…</span>
                ) : universeRowCount != null ? (
                  <span className="ref-refdb-stat-highlight" title="Rows in public.tickers">
                    <strong>{universeRowCount.toLocaleString()}</strong>
                    <span className={w9.refOverviewCoverageTotal}> tickers in </span>
                    <code>tickers</code>
                  </span>
                ) : (
                  <span className={w9.refOverviewCoverageMuted}>Row count unavailable</span>
                )}
              </div>
            </div>
          ) : null}
          {isFeedStocksTickersTypesRefKind(kind) ? (
            <div>
              <p className="ref-jobs-md-enqueue-hint">Replaces all rows in ticker_types from the API. No extra fields.</p>
              <div className={w9.refOverviewCoverageStrip} style={{ marginTop: 'var(--space-2)' }} aria-live="polite">
                {tickerTypesRowCountLoading ? (
                  <span className={w9.refOverviewCoverageMuted}>Loading row count…</span>
                ) : tickerTypesRowCount != null ? (
                  <span className="ref-refdb-stat-highlight" title="Rows in public.ticker_types">
                    <strong>{tickerTypesRowCount.toLocaleString()}</strong>
                    <span className={w9.refOverviewCoverageTotal}> instrument types in </span>
                    <code>ticker_types</code>
                  </span>
                ) : (
                  <span className={w9.refOverviewCoverageMuted}>Row count unavailable</span>
                )}
              </div>
            </div>
          ) : null}

          {isFeedStocksTickersOverviewRefKind(kind) ? (
            <div className="feed-massive-refdb-overview-scope">
              <div className="feed-massive-field" style={{ display: 'block' }}>
                <div className="form-label" id="ref-overview-scope-label-panel">
                  Overview job scope
                </div>
                <div
                  className="ref-overview-scope-bubbles"
                  role="radiogroup"
                  aria-labelledby="ref-overview-scope-label-panel"
                  aria-describedby="ref-overview-scope-hint-panel"
                >
                  {OVERVIEW_SCOPE_BUBBLES.map(opt => {
                    const active = overviewEnqueueMode === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabledEnqueue}
                        title={opt.title}
                        className={`ref-overview-scope-bubble${active ? ' ref-overview-scope-bubble--active' : ''}`}
                        onClick={() => {
                          setOverviewEnqueueMode(opt.value)
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <p id="ref-overview-scope-hint-panel" className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
                Compares <code>public.tickers</code> to <code>public.ticker_overview</code>.
              </p>
              <div className={w9.refOverviewCoverageStrip} aria-live="polite">
                {overviewCoverageLoading ? (
                  <span className={w9.refOverviewCoverageMuted}>Loading coverage counts…</span>
                ) : overviewCoverage ? (
                  <>
                    <span className="ref-overview-coverage-missing" title="Tickers with no row in ticker_overview">
                      <strong>{overviewCoverage.missing.toLocaleString()}</strong> missing
                    </span>
                    <span className={w9.refOverviewCoverageSep} aria-hidden>
                      ·
                    </span>
                    <span className="ref-overview-coverage-filled" title="Tickers with a ticker_overview row">
                      <strong>{overviewCoverage.filled.toLocaleString()}</strong> filled
                    </span>
                    <span className={w9.refOverviewCoverageSep} aria-hidden>
                      ·
                    </span>
                    <span className={w9.refOverviewCoverageTotal}>
                      {overviewCoverage.total_tickers.toLocaleString()} in <code>tickers</code>
                    </span>
                  </>
                ) : (
                  <span className={w9.refOverviewCoverageMuted}>Coverage counts unavailable</span>
                )}
              </div>
              {overviewEnqueueMode === 'stale' ? (
                <label className="feed-massive-field" style={{ display: 'block', marginTop: 'var(--space-2)' }}>
                  <span className="form-label">Stale after (hours)</span>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    step={1}
                    value={overviewStaleHours}
                    disabled={disabledEnqueue}
                    onChange={e => {
                      const n = parseInt(e.target.value, 10)
                      setOverviewStaleHours(Number.isFinite(n) && n >= 1 ? n : 720)
                    }}
                    aria-label="Hours before ticker_overview is considered stale"
                    style={{ maxWidth: '8rem' }}
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          {isFeedStocksTickersRelatedRefKind(kind) ? (
            <div className="feed-massive-refdb-overview-scope" style={{ marginTop: 'var(--space-2)' }}>
              <div className="feed-massive-field" style={{ display: 'block' }}>
                <div className="form-label" id="ref-related-scope-label-panel">
                  Related job scope
                </div>
                <div
                  className="ref-overview-scope-bubbles"
                  role="radiogroup"
                  aria-labelledby="ref-related-scope-label-panel"
                  aria-describedby="ref-related-scope-hint-panel"
                >
                  {RELATED_SCOPE_BUBBLES.map(opt => {
                    const active = relatedEnqueueMode === opt.value
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        disabled={disabledEnqueue}
                        title={opt.title}
                        className={`ref-overview-scope-bubble${active ? ' ref-overview-scope-bubble--active' : ''}`}
                        onClick={() => {
                          setRelatedEnqueueMode(opt.value)
                        }}
                      >
                        {opt.label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <p id="ref-related-scope-hint-panel" className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-1)', marginBottom: 'var(--space-1)' }}>
                Compares <code>public.tickers</code> to <code>public.ticker_related_tickers</code> (
                <code>from_tickers_id</code>). Stale uses <code>MAX(fetched_at)</code> per ticker.
              </p>
              <div className={w9.refOverviewCoverageStrip} aria-live="polite">
                {relatedCoverageLoading ? (
                  <span className={w9.refOverviewCoverageMuted}>Loading coverage counts…</span>
                ) : relatedCoverage ? (
                  <>
                    <span className="ref-overview-coverage-missing" title="No related rows stored for this ticker">
                      <strong>{relatedCoverage.missing.toLocaleString()}</strong> missing
                    </span>
                    <span className={w9.refOverviewCoverageSep} aria-hidden>
                      ·
                    </span>
                    <span className="ref-overview-coverage-filled" title="At least one related peer row stored">
                      <strong>{relatedCoverage.filled.toLocaleString()}</strong> filled
                    </span>
                    <span className={w9.refOverviewCoverageSep} aria-hidden>
                      ·
                    </span>
                    <span className={w9.refOverviewCoverageTotal}>
                      {relatedCoverage.total_tickers.toLocaleString()} in <code>tickers</code>
                    </span>
                  </>
                ) : (
                  <span className={w9.refOverviewCoverageMuted}>Coverage counts unavailable</span>
                )}
              </div>
              {relatedEnqueueMode === 'stale' ? (
                <label className="feed-massive-field" style={{ display: 'block', marginTop: 'var(--space-2)' }}>
                  <span className="form-label">Stale after (hours)</span>
                  <input
                    className="form-input"
                    type="number"
                    min={1}
                    step={1}
                    value={relatedStaleHours}
                    disabled={disabledEnqueue}
                    onChange={e => {
                      const n = parseInt(e.target.value, 10)
                      setRelatedStaleHours(Number.isFinite(n) && n >= 1 ? n : 720)
                    }}
                    aria-label="Hours before related data is considered stale"
                    style={{ maxWidth: '8rem' }}
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          {(isFeedStocksTickersOverviewRefKind(kind) && overviewEnqueueMode === 'symbols') ||
          (isFeedStocksTickersRelatedRefKind(kind) && relatedEnqueueMode === 'symbols') ? (
            <label
              className="feed-massive-field"
              style={{
                display: 'block',
                marginTop:
                  isFeedStocksTickersOverviewRefKind(kind) || isFeedStocksTickersRelatedRefKind(kind)
                    ? 'var(--space-2)'
                    : 0,
              }}
            >
              <span className="form-label">Symbols (comma or space separated)</span>
              <input
                className="form-input"
                value={refJobSymbols}
                onChange={e => setRefJobSymbols(e.target.value)}
                disabled={disabledEnqueue}
                placeholder="AAPL, MSFT, GOOGL"
                autoComplete="off"
                aria-invalid={refJobSymbolsErr != null}
                aria-describedby={refJobSymbolsErr ? 'ref-job-symbols-err-panel' : undefined}
              />
              {refJobSymbolsErr ? (
                <p id="ref-job-symbols-err-panel" className={cn(w9.statusPageMsg, 'err')} role="alert" style={{ marginTop: 'var(--space-1)' }}>
                  {refJobSymbolsErr}
                </p>
              ) : null}
            </label>
          ) : null}
        </div>
        <div className="ref-jobs-md-enqueue-actions">
          <Button
            type="button"
            size="sm"
            className="ref-jobs-md-enqueue-btn"
            disabled={disabledEnqueue}
            aria-busy={enqueueBusy}
            onClick={onEnqueue}
          >
            <CatalogEnqueueIcon busy={enqueueBusy} />
            <span>{enqueueBusy ? 'Enqueueing…' : `Enqueue ${jobLabel}`}</span>
          </Button>
        </div>
      </div>

      <h4 className="ref-jobs-md-section-title" style={{ marginTop: 'var(--space-3)' }}>
        Verify (PostgreSQL)
      </h4>

      {isFeedStocksTickersReferenceUniverseRefKind(kind) ? (
        <>
          <label className="feed-massive-field" style={{ display: 'block' }}>
            <span className="form-label">Search query</span>
            <input
              className="form-input"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              disabled={busyVerify}
              placeholder="AAPL or Apple"
              autoComplete="off"
            />
          </label>
          <label className="feed-massive-field" style={{ display: 'block', marginTop: 'var(--space-2)' }}>
            <span className="form-label">Result limit</span>
            <input
              className="form-input"
              type="number"
              min={1}
              max={100}
              step={1}
              value={searchLimit}
              onChange={e => {
                const v = parseInt(e.target.value, 10)
                setSearchLimit(Number.isFinite(v) ? v : DEFAULT_TICKER_REF_SEARCH_LIMIT)
              }}
              disabled={busyVerify}
              aria-label="Search result row limit"
              style={{ maxWidth: '8rem' }}
            />
          </label>
          <div className="ref-jobs-md-actions">
            <Button type="button" variant="secondary" disabled={busyVerify} onClick={onVerifySearch}>
              {busyVerify ? 'Loading…' : 'Search (DB)'}
            </Button>
          </div>
        </>
      ) : null}

      {isFeedStocksTickersTypesRefKind(kind) ? (
        <div className="ref-jobs-md-actions">
          <Button type="button" variant="secondary" disabled={busyVerify} onClick={onVerifyInstrumentTypes}>
            {busyVerify ? 'Loading…' : 'Instrument types (DB)'}
          </Button>
        </div>
      ) : null}

      {isFeedStocksTickersOverviewRefKind(kind) ? (
        <>
          <label className="feed-massive-field" style={{ display: 'block' }}>
            <span className="form-label">Symbol (merged ticker + overview row)</span>
            <input
              className="form-input"
              value={overviewSymbol}
              onChange={e => setOverviewSymbol(e.target.value)}
              disabled={busyVerify}
              placeholder="AAPL"
              autoComplete="off"
            />
          </label>
          <div className="ref-jobs-md-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busyVerify}
              aria-busy={busyVerify && overviewVerifyKind === 'merged'}
              onClick={onVerifyOverviewMerged}
            >
              {busyVerify && overviewVerifyKind === 'merged' ? 'Loading…' : 'Load merged row (DB)'}
            </Button>
          </div>

          <label className="feed-massive-field" style={{ display: 'block', marginTop: 'var(--space-3)' }}>
            <span className="form-label">Missing overview — page size</span>
            <input
              className="form-input"
              type="number"
              min={1}
              max={MAX_TICKER_REF_MISSING_LIMIT}
              step={1}
              value={overviewMissingLimit}
              onChange={e => {
                const v = parseInt(e.target.value, 10)
                if (Number.isFinite(v)) setOverviewMissingLimit(v)
              }}
              disabled={busyVerify}
              aria-label="Number of tickers to load per request for missing overview list"
              style={{ maxWidth: '8rem' }}
            />
          </label>
          <p className="feed-massive-agg-sub-doc" style={{ marginTop: 'var(--space-1)', marginBottom: 0 }}>
            Lists symbols present in <code>tickers</code> with no <code>ticker_overview</code> row (ordered A–Z). Default
            page size {DEFAULT_TICKER_REF_MISSING_LIMIT}.
          </p>
          <div className="ref-jobs-md-actions" style={{ marginTop: 'var(--space-2)' }}>
            <Button
              type="button"
              variant="secondary"
              disabled={busyVerify}
              aria-busy={busyVerify && overviewVerifyKind === 'missing' && !overviewMissingVerifyAppend}
              onClick={onVerifyOverviewMissingFirst}
            >
              {busyVerify && overviewVerifyKind === 'missing' && !overviewMissingVerifyAppend
                ? 'Loading…'
                : 'Load missing tickers (DB)'}
            </Button>
            {missingOverviewHasMore && missingOverviewLoadedCount > 0 ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busyVerify}
                aria-busy={busyVerify && overviewVerifyKind === 'missing' && overviewMissingVerifyAppend}
                onClick={onVerifyOverviewMissingMore}
              >
                {busyVerify && overviewVerifyKind === 'missing' && overviewMissingVerifyAppend
                  ? 'Loading…'
                  : 'Load more'}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      {isFeedStocksTickersRelatedRefKind(kind) ? (
        <>
          <label className="feed-massive-field" style={{ display: 'block' }}>
            <span className="form-label">Symbol (single-ticker related rows)</span>
            <input
              className="form-input"
              value={relatedSymbol}
              onChange={e => setRelatedSymbol(e.target.value)}
              disabled={busyVerify}
              placeholder="AAPL"
              autoComplete="off"
            />
          </label>
          <div className="ref-jobs-md-actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busyVerify}
              aria-busy={busyVerify && relatedVerifyKind === 'symbol'}
              onClick={onVerifyRelatedDb}
            >
              {busyVerify && relatedVerifyKind === 'symbol' ? 'Loading…' : 'Load related (DB)'}
            </Button>
          </div>

          <label className="feed-massive-field" style={{ display: 'block', marginTop: 'var(--space-3)' }}>
            <span className="form-label">Page size</span>
            <input
              className="form-input"
              type="number"
              min={1}
              max={MAX_TICKER_REF_MISSING_LIMIT}
              step={1}
              value={relatedListPageLimit}
              onChange={e => {
                const v = parseInt(e.target.value, 10)
                if (Number.isFinite(v)) setRelatedListPageLimit(v)
              }}
              disabled={busyVerify}
              aria-label="Page size for missing and filled related ticker lists"
              style={{ maxWidth: '8rem' }}
            />
          </label>
          <div className="ref-jobs-md-actions" style={{ marginTop: 'var(--space-2)' }}>
            <Button
              type="button"
              variant="secondary"
              disabled={busyVerify}
              aria-busy={busyVerify && relatedVerifyKind === 'missing' && !relatedMissingVerifyAppend}
              onClick={onVerifyRelatedMissingFirst}
            >
              {busyVerify && relatedVerifyKind === 'missing' && !relatedMissingVerifyAppend
                ? 'Loading…'
                : 'Load missing tickers (DB)'}
            </Button>
            {missingRelatedHasMore && missingRelatedLoadedCount > 0 ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busyVerify}
                aria-busy={busyVerify && relatedVerifyKind === 'missing' && relatedMissingVerifyAppend}
                onClick={onVerifyRelatedMissingMore}
              >
                {busyVerify && relatedVerifyKind === 'missing' && relatedMissingVerifyAppend
                  ? 'Loading…'
                  : 'Load more (missing)'}
              </Button>
            ) : null}
          </div>
          <div className="ref-jobs-md-actions" style={{ marginTop: 'var(--space-2)' }}>
            <Button
              type="button"
              variant="secondary"
              disabled={busyVerify}
              aria-busy={busyVerify && relatedVerifyKind === 'filled' && !relatedFilledVerifyAppend}
              onClick={onVerifyRelatedFilledFirst}
            >
              {busyVerify && relatedVerifyKind === 'filled' && !relatedFilledVerifyAppend
                ? 'Loading…'
                : 'Load filled tickers (DB)'}
            </Button>
            {filledRelatedHasMore && filledRelatedLoadedCount > 0 ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busyVerify}
                aria-busy={busyVerify && relatedVerifyKind === 'filled' && relatedFilledVerifyAppend}
                onClick={onVerifyRelatedFilledMore}
              >
                {busyVerify && relatedVerifyKind === 'filled' && relatedFilledVerifyAppend
                  ? 'Loading…'
                  : 'Load more (filled)'}
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  )
}
