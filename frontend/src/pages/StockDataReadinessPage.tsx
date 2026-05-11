import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { SectionPageTitle } from '../components/SectionPageTitle'
import {
  fetchSepaReadinessSummary,
  fetchSepaPriceGaps,
  fetchSepaIncomeStatementsGaps,
  fetchSepaBalanceSheetsGaps,
  fetchSepaCashFlowsGaps,
  fetchSepaRatiosGaps,
  fetchSepaShortInterestGaps,
  fetchSepaShortVolumeGaps,
  postSepaGroupedHistoryBackfill,
  postSepaReadinessSnapshot,
  postSepaStockUnifiedSnapshot,
  postSepaPriceGapBackfill,
  postSepaSyncHolidays,
  postSepaFundamentalsBackfill,
  postSepaIncomeStatementsBackfill,
  postSepaBalanceSheetsBackfill,
  postSepaCashFlowsBackfill,
  postSepaRatiosBackfill,
  postSepaShortInterestBackfill,
  postSepaShortVolumeBackfill,
  postSepaGapAck,
  fetchSepaCriteriaStats,
  fetchSepaDataInventory,
  type SepaGapAckDataType,
  type SepaReadinessCatalogEntry,
  type SepaReadinessSummaryResponse,
  type SepaPriceGapItem,
  type SepaSnapshotByTypeRow,
  type SepaSyncHolidaysResponse,
  type SepaFinGapRow,
  type SepaFinancialsGapsResponse,
  type SepaFinancialsBackfillResponse,
  type SepaCriteriaStats,
  type SepaDataInventoryStats,
} from '../api/research/dataReadiness'
import { fetchQueueSummary, type QueueSummaryRow } from '../api/ops/ops'
import { formatQueueLabel } from '../utils/celeryQueueLabels'
import {
  MassiveRefJobSessionProvider,
  useMassiveRefJobSession,
} from './massive/MassiveRefJobSessionContext'

export interface StockDataReadinessPageProps {
  onBreadcrumbResearch?: () => void
  breadcrumbLabel?: string
  onOpenCelerySettings?: () => void
  onOpenFeedMassiveStock?: () => void
  onOpenDataCoverageSummary?: () => void
}

function fmt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—'
  return n.toLocaleString()
}

function fmtPct(num: number, denom: number): string {
  if (!denom) return '—'
  return ((num / denom) * 100).toFixed(1) + '%'
}

function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  try {
    const ms = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(ms / 60_000)
    if (mins < 1) return 'just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    return `${Math.floor(hrs / 24)}d ago`
  } catch {
    return '—'
  }
}

/** Table rows rendered at once in gap drawers (full list stays in memory; DOM stays small). */
const SDP_GAP_DRAWER_PAGE = 350
/** Incremental append chunk for very large gap payloads (keeps drawer opening smooth). */
const SDP_GAP_LAZY_APPEND_CHUNK = 500

function copyTextFallback(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0'
  document.body.appendChild(ta)
  ta.focus()
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    // ignore
  }
  document.body.removeChild(ta)
  return ok
}

/** Derive tag type from catalog object name */
function sourceTag(entry: SepaReadinessCatalogEntry): { label: string; cls: string } {
  const obj = entry.object.toLowerCase()
  if (obj.includes('stock_readiness_daily')) return { label: 'SNAPSHOT', cls: 'sdp-source-tag--snapshot' }
  if (obj.includes('cache_stock_snapshot')) return { label: 'CACHE', cls: 'sdp-source-tag--snapshot' }
  if (obj.startsWith('public.v_') || obj.startsWith('v_')) return { label: 'VIEW', cls: 'sdp-source-tag--view' }
  return { label: 'TABLE', cls: 'sdp-source-tag--table' }
}

/** Split "public.some_table" into [schema, name] for styled display */
function splitObject(obj: string): [string, string] {
  const dot = obj.indexOf('.')
  if (dot === -1) return ['', obj]
  return [obj.slice(0, dot + 1), obj.slice(dot + 1)]
}

// ── Snapshot by-type breakdown (Step 2) ─────────────────────────────────────

function SnapshotByTypeBreakdown({ rows }: { rows: SepaSnapshotByTypeRow[] | null }) {
  if (rows == null) return null
  if (rows.length === 0) {
    return (
      <div className="sdp-step-aside-empty">
        No instrument-type breakdown yet — refresh once to populate{' '}
        <code>cache_stock_snapshot</code>.
      </div>
    )
  }
  const totalSnap = rows.reduce((s, r) => s + (r.snapshot_row_count || 0), 0)
  const totalUni = rows.reduce((s, r) => s + (r.universe_ticker_count || 0), 0)
  return (
    <div className="sdp-step-aside">
      <div className="sdp-step-aside-title">
        Instrument types in <code>cache_stock_snapshot</code>{' '}
        <span className="sdp-step-aside-meta">
          {rows.length} types · {fmt(totalSnap)} snapshot rows · {fmt(totalUni)} universe tickers
        </span>
      </div>
      <div className="sdp-step-aside-table-scroll">
        <table className="sdp-snap-by-type-table">
          <thead>
            <tr>
              <th className="sdp-snap-by-type-code">Code</th>
              <th>Description</th>
              <th className="sdp-snap-by-type-num">Snapshot rows</th>
              <th className="sdp-snap-by-type-num">Universe tickers</th>
              <th className="sdp-snap-by-type-num">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const coverage =
                r.universe_ticker_count > 0
                  ? (r.snapshot_row_count / r.universe_ticker_count) * 100
                  : null
              const lowCoverage = coverage != null && coverage < 90
              return (
                <tr key={r.code}>
                  <td className="sdp-snap-by-type-code">
                    <code>{r.code}</code>
                  </td>
                  <td>{r.description ?? <span className="sdp-step-aside-dim">—</span>}</td>
                  <td className="sdp-snap-by-type-num">{fmt(r.snapshot_row_count)}</td>
                  <td className="sdp-snap-by-type-num sdp-step-aside-dim">
                    {fmt(r.universe_ticker_count)}
                  </td>
                  <td
                    className={`sdp-snap-by-type-num${lowCoverage ? ' sdp-snap-by-type-low' : ''}`}
                  >
                    {coverage == null ? '—' : `${coverage.toFixed(1)}%`}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Check Strip ──────────────────────────────────────────────────────────────

type CheckStatus = 'ok' | 'warn' | 'error' | 'loading' | 'unknown' | 'void'

/** Runbook tab / step id (10-step fundamentals pipeline). */
type SepaRunStep = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10

function gapCountCheckStatus(summaryLoading: boolean, n: number | null | undefined): CheckStatus {
  if (summaryLoading) return 'loading'
  if (n == null) return 'unknown'
  if (n === 0) return 'ok'
  if (n < 500) return 'warn'
  return 'error'
}

/**
 * Status based on actionable_gap_count (= total − acked baseline).
 * When source_void=true and actionable=0 → gray void.
 * When source_void=true but actionable>0 → warn/error (new gaps beyond baseline).
 */
function gapCountCheckStatusWithVoid(
  summaryLoading: boolean,
  actionable: number | null | undefined,
  isVoid: boolean | undefined,
): CheckStatus {
  if (summaryLoading) return 'loading'
  if (isVoid) {
    if (actionable == null || actionable === 0) return 'void'
    if (actionable < 500) return 'warn'
    return 'error'
  }
  return gapCountCheckStatus(summaryLoading, actionable)
}

/** Worst child status for a runbook stage header. void is treated as ok for error-elevation. */
function foldStageStatus(statuses: CheckStatus[]): CheckStatus {
  if (statuses.length === 0) return 'unknown'
  if (statuses.some((x) => x === 'loading')) return 'loading'
  if (statuses.some((x) => x === 'error')) return 'error'
  if (statuses.some((x) => x === 'warn')) return 'warn'
  if (statuses.every((x) => x === 'ok' || x === 'void')) return statuses.every((x) => x === 'ok') ? 'ok' : 'void'
  if (statuses.some((x) => x === 'ok' || x === 'void')) return 'warn'
  return 'unknown'
}

type RunbookStageId = 'baseline' | 'financials' | 'market' | 'publish'

type DataSupportLevel = 'supported' | 'partial' | 'not_supported' | 'unknown'

interface InstrumentTypeSupportRow {
  code: string
  description: string
  incomeStatements: DataSupportLevel
  balanceSheets: DataSupportLevel
  cashFlows: DataSupportLevel
  ratios: DataSupportLevel
  note?: string
}

const INSTRUMENT_TYPE_DATA_SUPPORT_ROWS: InstrumentTypeSupportRow[] = [
  {
    code: 'CS',
    description: 'Common Stock',
    incomeStatements: 'supported',
    balanceSheets: 'supported',
    cashFlows: 'supported',
    ratios: 'supported',
  },
  {
    code: 'ADRC',
    description: 'American Depository Receipt Common',
    incomeStatements: 'supported',
    balanceSheets: 'supported',
    cashFlows: 'supported',
    ratios: 'supported',
  },
  {
    code: 'PFD',
    description: 'Preferred Stock',
    incomeStatements: 'partial',
    balanceSheets: 'partial',
    cashFlows: 'partial',
    ratios: 'partial',
    note: 'Coverage may vary by issuer and filing frequency.',
  },
  {
    code: 'ETF',
    description: 'Exchange Traded Fund',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Commonly sparse/absent in Massive financial statements coverage.',
  },
  {
    code: 'ETS',
    description: 'Single-security ETF',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Commonly sparse/absent in Massive financial statements coverage.',
  },
  {
    code: 'ETV',
    description: 'Exchange Traded Vehicle',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Commonly sparse/absent in Massive financial statements coverage.',
  },
  {
    code: 'ETN',
    description: 'Exchange Traded Note',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Debt note product; issuer-level statements usually not exposed per ticker.',
  },
  {
    code: 'FUND',
    description: 'Fund',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Commonly sparse/absent in Massive financial statements coverage.',
  },
  {
    code: 'UNIT',
    description: 'Unit',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Commonly sparse/absent in Massive financial statements coverage.',
  },
  {
    code: 'RIGHT',
    description: 'Rights',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Derivative security; company statements usually not represented.',
  },
  {
    code: 'WARRANT',
    description: 'Warrant',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Derivative security; company statements usually not represented.',
  },
  {
    code: 'SP',
    description: 'Structured Product',
    incomeStatements: 'not_supported',
    balanceSheets: 'not_supported',
    cashFlows: 'not_supported',
    ratios: 'not_supported',
    note: 'Commonly sparse/absent in Massive financial statements coverage.',
  },
]

/** Instrument types with Supported / Partial Massive coverage for financial-statement gaps (Steps 4–7). */
const FIN_STMT_GAP_INSTRUMENT_CODES = INSTRUMENT_TYPE_DATA_SUPPORT_ROWS.filter(
  (r) => r.incomeStatements === 'supported' || r.incomeStatements === 'partial',
).map((r) => r.code)

function supportBadge(level: DataSupportLevel): { text: string; cls: string } {
  if (level === 'supported') return { text: 'Supported', cls: 'sdp-status-pill sdp-status-pill--ok sdp-support-pill sdp-support-pill--ok' }
  if (level === 'partial') return { text: 'Partial', cls: 'sdp-status-pill sdp-status-pill--warn sdp-support-pill sdp-support-pill--partial' }
  if (level === 'not_supported') return { text: 'Not supported', cls: 'sdp-status-pill sdp-status-pill--err sdp-support-pill sdp-support-pill--no' }
  return { text: 'Unknown', cls: 'sdp-status-pill sdp-support-pill sdp-support-pill--unknown' }
}

const RUNBOOK_STAGE_LAYOUT: ReadonlyArray<{
  id: RunbookStageId
  title: string
  blurb: string
  stepIds: readonly SepaRunStep[]
}> = [
  {
    id: 'baseline',
    title: 'Universe & price baseline',
    blurb: 'Universe, unified snapshot, stock_day bars',
    stepIds: [1, 2, 3],
  },
  {
    id: 'financials',
    title: 'Financial statements',
    blurb: 'Income, balance sheet, cash flow, ratios → PostgreSQL',
    stepIds: [4, 5, 6, 7],
  },
  {
    id: 'market',
    title: 'Short market data',
    blurb: 'Short interest & short volume',
    stepIds: [8, 9],
  },
  {
    id: 'publish',
    title: 'Evaluate & publish',
    blurb: 'Evaluate fundamentals + materialize readiness snapshot',
    stepIds: [10],
  },
]

/** All run book step IDs — one readiness summary fetch covers every step. */
const ALL_SEPA_RUNBOOK_STEP_IDS: readonly SepaRunStep[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

interface InventoryEntry {
  table: string
  column: string
  category: string
  indicator: string
}

const DATA_INVENTORY_METADATA: InventoryEntry[] = [
  { table: 'stock_income_statements', column: 'gross_profit',             category: 'Fund Quality',  indicator: 'Gross Margin = gross_profit / revenue' },
  { table: 'stock_income_statements', column: 'operating_income',         category: 'Fund Quality',  indicator: 'Operating Margin = operating_income / revenue' },
  { table: 'stock_income_statements', column: 'ebitda',                   category: 'Fund Quality',  indicator: 'EBITDA Margin — cash flow proxy' },
  { table: 'stock_income_statements', column: 'diluted_earnings_per_share', category: 'Fund Quality', indicator: 'Diluted EPS — share dilution view' },
  { table: 'stock_balance_sheets',    column: 'total_equity',             category: 'Balance Sheet', indicator: 'Book Value per Share; base for P/B' },
  { table: 'stock_balance_sheets',    column: 'long_term_debt_and_capital_lease_obligations', category: 'Balance Sheet', indicator: 'Long-term leverage ratio (Debt/Equity)' },
  { table: 'stock_balance_sheets',    column: 'cash_and_equivalents',     category: 'Balance Sheet', indicator: 'Cash per Share — financial fortress filter' },
  { table: 'stock_balance_sheets',    column: 'total_current_assets',     category: 'Balance Sheet', indicator: 'Current Ratio = current_assets / current_liabilities' },
  { table: 'stock_cash_flows',        column: 'net_cash_from_operating_activities', category: 'Cash Flow', indicator: 'FCF = Operating CF − CapEx; FCF Margin' },
  { table: 'stock_cash_flows',        column: 'purchase_of_property_plant_and_equipment', category: 'Cash Flow', indicator: 'Capital expenditure (CapEx) intensity' },
  { table: 'stock_ratios',            column: 'return_on_equity',         category: 'Quality',       indicator: 'ROE ≥ 15% — Minervini profitability criterion' },
  { table: 'stock_ratios',            column: 'return_on_assets',         category: 'Quality',       indicator: 'ROA — asset efficiency filter' },
  { table: 'stock_ratios',            column: 'debt_to_equity',           category: 'Quality',       indicator: 'D/E < 1.5 — leverage risk filter' },
  { table: 'stock_ratios',            column: 'price_to_earnings',        category: 'Valuation',     indicator: 'P/E filter (e.g. < 50 avoids over-hyped stocks)' },
  { table: 'stock_ratios',            column: 'price_to_sales',           category: 'Valuation',     indicator: 'P/S — useful when earnings are negative' },
  { table: 'stock_ratios',            column: 'price_to_book',            category: 'Valuation',     indicator: 'P/B < threshold for value/growth balance' },
  { table: 'stock_ratios',            column: 'market_cap',               category: 'Quality',       indicator: 'Market Cap ≥ $1B — institutional liquidity floor' },
  { table: 'stock_ratios',            column: 'free_cash_flow',           category: 'Cash Flow',     indicator: 'FCF directly from ratios endpoint' },
  { table: 'stock_short_interest',    column: 'short_interest',           category: 'Short Pressure', indicator: 'Short interest as % of float' },
  { table: 'stock_short_interest',    column: 'days_to_cover',            category: 'Short Pressure', indicator: 'Days-to-cover < 10 — avoid squeeze risk' },
  { table: 'stock_short_volume',      column: 'short_volume_ratio',       category: 'Short Pressure', indicator: 'Short volume ratio — directional pressure signal' },
  { table: 'stock_short_volume',      column: 'total_volume',             category: 'Short Pressure', indicator: 'Total FINRA volume — liquidity confirmation' },
]

function StepCheckStrip({
  hasChecked = true,
  loading,
  status,
  primary,
  primaryLabel,
  secondary,
  gap,
  gapUnit,
  target,
  note,
}: {
  hasChecked?: boolean
  loading: boolean
  status: CheckStatus
  primary?: string | null
  primaryLabel?: string
  secondary?: string | null
  gap?: number | null
  gapUnit?: string
  target?: string
  note?: string | null
}) {
  if (!hasChecked) {
    return (
      <div className="sdp-check-strip sdp-check-strip--notchecked">
        <div className="sdp-check-row">
          <span className="sdp-check-dot sdp-check-dot--unknown" />
          <span className="sdp-check-text sdp-check-text--dim">Use Check in the run book header to verify</span>
        </div>
      </div>
    )
  }
  if (loading) {
    return (
      <div className="sdp-check-strip sdp-check-strip--loading">
        <span className="sdp-check-dot sdp-check-dot--loading" />
        <span className="sdp-check-text sdp-check-text--dim">Checking…</span>
      </div>
    )
  }
  return (
    <div className={`sdp-check-strip sdp-check-strip--${status}`}>
      <div className="sdp-check-row">
        <span className={`sdp-check-dot sdp-check-dot--${status}`} />
        <span className="sdp-check-primary">
          {primary ?? '—'}
          {primaryLabel && <span className="sdp-check-primary-label">{primaryLabel}</span>}
        </span>
        {secondary && <span className="sdp-check-secondary">{secondary}</span>}
        {gap != null && gap > 0 && status === 'void' && (
          <span className="sdp-check-gap sdp-check-gap--void">
            Source N/A · {fmt(gap)} {gapUnit}
          </span>
        )}
        {gap != null && gap > 0 && status !== 'void' && (
          <span className={`sdp-check-gap ${status === 'error' ? 'sdp-check-gap--error' : 'sdp-check-gap--warn'}`}>
            Gap: {fmt(gap)} {gapUnit}
          </span>
        )}
        {gap === 0 && (
          <span className="sdp-check-gap sdp-check-gap--ok">No gap</span>
        )}
      </div>
      {(target || note) && (
        <div className="sdp-check-meta">
          {target && <span className="sdp-check-target">Target: {target}</span>}
          {note && <span className="sdp-check-note">{note}</span>}
        </div>
      )}
    </div>
  )
}

// ── Data Source Card ──────────────────────────────────────────────────────────

function DataSourceCard({
  entry,
  variant,
}: {
  entry: SepaReadinessCatalogEntry
  variant: 'raw' | 'computed'
}) {
  const tag = sourceTag(entry)
  const [schema, name] = splitObject(entry.object)
  const isComputed = variant === 'computed'
  const hasViewQuery = Boolean(entry.view_query)
  const [sqlCopied, setSqlCopied] = useState(false)

  const handleCopyViewSql = async (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const text = entry.view_query?.trim()
    if (!text) return
    let ok = false
    try {
      await navigator.clipboard.writeText(text)
      ok = true
    } catch {
      ok = copyTextFallback(text)
    }
    if (ok) {
      setSqlCopied(true)
      setTimeout(() => setSqlCopied(false), 2000)
    }
  }

  return (
    <div className={`sdp-source-card sdp-source-card--${variant}`}>
      <div className={`sdp-source-accent sdp-source-accent--${variant}`} />
      <div className="sdp-source-inner">
        <div className="sdp-source-header">
          <div className="sdp-source-object">
            {schema && <span className="sdp-source-schema">{schema}</span>}
            {name}
          </div>
          <div className="sdp-source-tag-wrap">
            {isComputed && (
              <span
                className={`sdp-source-sql-badge${hasViewQuery ? '' : ' sdp-source-sql-badge--off'}`}
                aria-label={hasViewQuery ? 'View SQL available' : 'SQL unavailable for this object'}
              >
                {hasViewQuery ? 'SQL' : 'NO SQL'}
              </span>
            )}
            <span className={`sdp-source-tag ${tag.cls}`}>{tag.label}</span>
          </div>
        </div>
        {isComputed && (
          <div className="sdp-source-sql-popover" role="note" aria-label="View definition">
            <div className="sdp-source-sql-popover-head">
              <div className="sdp-source-sql-popover-title">
                {hasViewQuery ? 'View SQL (live from PostgreSQL)' : 'No view SQL available'}
              </div>
              {hasViewQuery && (
                <button
                  type="button"
                  className={`sdp-source-sql-copy-btn${sqlCopied ? ' sdp-source-sql-copy-btn--ok' : ''}`}
                  onClick={(e) => void handleCopyViewSql(e)}
                  aria-label="Copy view SQL to clipboard"
                >
                  {sqlCopied ? 'Copied' : 'Copy'}
                </button>
              )}
            </div>
            {hasViewQuery ? (
              <pre className="sdp-source-sql-code">{entry.view_query}</pre>
            ) : (
              <div className="sdp-source-sql-empty">
                This object is not a PostgreSQL view (or view definition is unavailable with current DB permissions).
              </div>
            )}
          </div>
        )}

        <div className="sdp-source-role">{entry.role}</div>

        {entry.typical_ingest && (
          <div className="sdp-source-meta">
            <span className="sdp-source-meta-key">Typical ingest</span>
            <span className="sdp-source-meta-val">{entry.typical_ingest}</span>
          </div>
        )}

        {entry.depends_on && entry.depends_on.length > 0 && (
          <div className="sdp-source-meta">
            <span className="sdp-source-meta-key">Depends on</span>
            <div className="sdp-source-depends">
              {entry.depends_on.map((d) => (
                <span key={d} className="sdp-dep-chip">{d}</span>
              ))}
            </div>
          </div>
        )}

        <div className="sdp-dps-section">
          <div className="sdp-dps-header">Supported data points</div>
          <div className="sdp-dps-list">
            {entry.data_points.map((dp) => (
              <span key={dp} className="sdp-dp">{dp}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── SEPA Screening Criteria Checklist ─────────────────────────────────────────

interface SepaCriterionDef {
  id: string
  criteria: string
  condition: string
  explain: string
  dataSource: string
  dataFields: string[]
  minBars?: number
}

const SEPA_TECHNICAL_CRITERIA: SepaCriterionDef[] = [
  {
    id: 'avg_volume',
    criteria: 'Average Volume',
    condition: '50 SMA > 100K',
    explain: 'Decent liquidity',
    dataSource: 'stock_day',
    dataFields: ['volume'],
    minBars: 50,
  },
  {
    id: 'crs',
    criteria: 'CRS',
    condition: '≥ 70',
    explain: 'Solid Relative Strength',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 252,
  },
  {
    id: 'close_vs_low52w',
    criteria: 'Close vs 52W Low',
    condition: 'close ≥ low52Weeks × 1.3',
    explain: 'Current close at least 30% higher than 52-week low',
    dataSource: 'stock_day',
    dataFields: ['close', 'low'],
    minBars: 252,
  },
  {
    id: 'high_vs_high52w',
    criteria: 'High vs 52W High',
    condition: 'high ≥ high52Weeks × 0.75',
    explain: 'Current high within 25% of 52-week high',
    dataSource: 'stock_day',
    dataFields: ['high'],
    minBars: 252,
  },
  {
    id: 'sma50_above_sma150',
    criteria: 'SMA(50) vs SMA(150)',
    condition: 'SMA(50) above SMA(150)',
    explain: 'Short-term trend positive',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 150,
  },
  {
    id: 'sma50_above_sma200',
    criteria: 'SMA(50) vs SMA(200)',
    condition: 'SMA(50) above SMA(200)',
    explain: 'Short-term trend positive',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 200,
  },
  {
    id: 'sma150_above_sma200',
    criteria: 'SMA(150) vs SMA(200)',
    condition: 'SMA(150) above SMA(200)',
    explain: 'Medium-term trend positive',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 200,
  },
  {
    id: 'sma200_rising',
    criteria: 'SMA(200) Rising',
    condition: 'SMA(200) trending up',
    explain: 'Long-term trend bullish',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 220,
  },
  {
    id: 'price_above_sma50',
    criteria: 'Price vs SMA(50)',
    condition: 'Price above SMA(50)',
    explain: 'Short-term price trend up',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 50,
  },
  {
    id: 'price_above_sma150',
    criteria: 'Price vs SMA(150)',
    condition: 'Price above SMA(150)',
    explain: 'Medium-term price trend up',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 150,
  },
  {
    id: 'price_above_sma200',
    criteria: 'Price vs SMA(200)',
    condition: 'Price above SMA(200)',
    explain: 'Long-term price trend up',
    dataSource: 'stock_day',
    dataFields: ['close'],
    minBars: 200,
  },
]

const SEPA_FUNDAMENTAL_CRITERIA: SepaCriterionDef[] = [
  {
    id: 'eps_q2q',
    criteria: 'EPS Growth Q2Q',
    condition: '≥ 25%',
    explain: 'Decent earnings growth Q2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (quarterly)'],
  },
  {
    id: 'revenue_q2q',
    criteria: 'Revenue Growth Q2Q',
    condition: '≥ 25%',
    explain: 'Decent revenue growth Q2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (quarterly)'],
  },
  {
    id: 'eps_acc_2q',
    criteria: 'EPS Acceleration',
    condition: 'EPS acc. 2 Qs',
    explain: 'Decent earnings growth acceleration last 2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (≥3 quarters)'],
  },
  {
    id: 'revenue_acc_2q',
    criteria: 'Revenue Acceleration',
    condition: 'Revenue acc. 2 Qs',
    explain: 'Decent revenue growth acceleration last 2Q',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (≥3 quarters)'],
  },
  {
    id: 'eps_3y',
    criteria: 'EPS Growth 3Y',
    condition: '≥ 15%',
    explain: 'Decent earnings growth long-term',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (annual, ≥3 years)'],
  },
  {
    id: 'revenue_3y',
    criteria: 'Revenue Growth 3Y',
    condition: '≥ 15%',
    explain: 'Decent revenue growth long-term',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (annual, ≥3 years)'],
  },
  {
    id: 'eps_acc_fy',
    criteria: 'EPS Acceleration FY',
    condition: 'EPS acc. last FY',
    explain: 'Decent earnings growth acceleration last year',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['EPS (annual, ≥2 years)'],
  },
  {
    id: 'revenue_acc_fy',
    criteria: 'Revenue Acceleration FY',
    condition: 'Revenue acc. last FY',
    explain: 'Decent revenue growth acceleration last year',
    dataSource: 'research_sepa_fundamentals_cache',
    dataFields: ['Revenue (annual, ≥2 years)'],
  },
]

type CriterionStatus = 'supported' | 'partial' | 'missing' | 'unknown'

function deriveCriterionStatus(
  criterion: SepaCriterionDef,
  summary: SepaReadinessSummaryResponse | null,
): { status: CriterionStatus; note: string } {
  if (!summary?.ok) return { status: 'unknown', note: 'Summary not loaded' }

  if (criterion.dataSource === 'stock_day') {
    const live = summary.price_readiness_live
    const total = live?.total_symbols ?? 0
    const ready = live?.price_ready ?? 0
    if (total === 0) return { status: 'missing', note: 'No stock_day data' }
    if (ready === 0) return { status: 'missing', note: 'No symbols price_ready' }
    const pct = (ready / total) * 100
    if (pct >= 90) return { status: 'supported', note: `${ready.toLocaleString()} / ${total.toLocaleString()} price_ready` }
    return { status: 'partial', note: `${pct.toFixed(1)}% price_ready (${ready.toLocaleString()} / ${total.toLocaleString()})` }
  }

  if (criterion.dataSource === 'research_sepa_fundamentals_cache') {
    if (summary.fund_cache_view_exists === false) return { status: 'missing', note: 'Fund cache view not created' }
    const valid = summary.fund_cache_valid_count
    if (valid == null) return { status: 'unknown', note: 'Fund cache count unavailable' }
    if (valid === 0) return { status: 'missing', note: 'No valid fund cache rows' }
    const universe = summary.universe_count ?? 0
    if (universe > 0) {
      const pct = (valid / universe) * 100
      if (pct >= 50) return { status: 'supported', note: `${valid.toLocaleString()} symbols cached` }
      return { status: 'partial', note: `${valid.toLocaleString()} / ${universe.toLocaleString()} cached (${pct.toFixed(1)}%)` }
    }
    return { status: 'supported', note: `${valid.toLocaleString()} symbols cached` }
  }

  return { status: 'unknown', note: '' }
}

function criterionStatusDot(status: CriterionStatus): string {
  switch (status) {
    case 'supported': return 'sdp-crit-dot--ok'
    case 'partial': return 'sdp-crit-dot--warn'
    case 'missing': return 'sdp-crit-dot--error'
    default: return 'sdp-crit-dot--unknown'
  }
}

function criterionStatusLabel(status: CriterionStatus): string {
  switch (status) {
    case 'supported': return 'Supported'
    case 'partial': return 'Partial'
    case 'missing': return 'Missing'
    default: return 'Unknown'
  }
}

function SepaScreeningChecklist({ summary }: { summary: SepaReadinessSummaryResponse | null }) {
  const [activeTab, setActiveTab] = useState<'technical' | 'fundamental'>('technical')
  const techStatuses = SEPA_TECHNICAL_CRITERIA.map((c) => ({
    ...c,
    ...deriveCriterionStatus(c, summary),
  }))
  const fundStatuses = SEPA_FUNDAMENTAL_CRITERIA.map((c) => ({
    ...c,
    ...deriveCriterionStatus(c, summary),
  }))

  const techOk = techStatuses.filter((c) => c.status === 'supported').length
  const fundOk = fundStatuses.filter((c) => c.status === 'supported').length
  const techTotal = techStatuses.length
  const fundTotal = fundStatuses.length
  const allOk = techOk + fundOk
  const allTotal = techTotal + fundTotal

  const overallStatus: CriterionStatus =
    allOk === allTotal ? 'supported' : allOk === 0 ? 'missing' : 'partial'

  return (
    <div className="sdp-criteria-section">
      <div className="sdp-criteria-header">
        <div className="sdp-criteria-header-left">
          <span className="sdp-criteria-title">SEPA Screening Criteria Checklist</span>
          <span className={`sdp-criteria-overall sdp-criteria-overall--${overallStatus}`}>
            {allOk} / {allTotal} supported
          </span>
        </div>
      </div>

      <div className="sdp-criteria-tabs" role="tablist" aria-label="SEPA checklist groups">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'technical'}
          className={`sdp-criteria-tab${activeTab === 'technical' ? ' sdp-criteria-tab--active' : ''}`}
          onClick={() => setActiveTab('technical')}
        >
          TECHNICAL <span className="sdp-criteria-tab-count">{techOk}/{techTotal}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'fundamental'}
          className={`sdp-criteria-tab${activeTab === 'fundamental' ? ' sdp-criteria-tab--active' : ''}`}
          onClick={() => setActiveTab('fundamental')}
        >
          FUNDAMENTAL <span className="sdp-criteria-tab-count">{fundOk}/{fundTotal}</span>
        </button>
      </div>

      <div className="sdp-criteria-groups">
        {activeTab === 'technical' && <div className="sdp-criteria-group">
          <div className="sdp-criteria-group-head">
            <span className="sdp-criteria-group-badge sdp-criteria-group-badge--tech">TECHNICAL</span>
            <span className="sdp-criteria-group-label">Price / Volume / Trend</span>
            <span className="sdp-criteria-group-count">{techOk} / {techTotal}</span>
          </div>
          <div className="sdp-criteria-group-sub">
            Data source: <code>stock_day</code> daily OHLCV bars (≥200 trading days)
          </div>
          <table className="sdp-criteria-table">
            <thead>
              <tr>
                <th className="sdp-crit-col-status" />
                <th>Criteria</th>
                <th>Condition</th>
                <th>Explain</th>
                <th className="sdp-crit-col-fields">Required fields</th>
                <th className="sdp-crit-col-status-label">Status</th>
              </tr>
            </thead>
            <tbody>
              {techStatuses.map((c) => (
                <tr key={c.id} className={`sdp-crit-row sdp-crit-row--${c.status}`}>
                  <td className="sdp-crit-col-status">
                    <span className={`sdp-crit-dot ${criterionStatusDot(c.status)}`} />
                  </td>
                  <td className="sdp-crit-name">{c.criteria}</td>
                  <td className="sdp-crit-condition"><code>{c.condition}</code></td>
                  <td className="sdp-crit-explain">{c.explain}</td>
                  <td className="sdp-crit-col-fields">
                    <span className="sdp-crit-fields">
                      {c.dataFields.map((f) => (
                        <span key={f} className="sdp-crit-field-chip">{f}</span>
                      ))}
                      {c.minBars != null && (
                        <span className="sdp-crit-field-chip sdp-crit-field-chip--bars">≥{c.minBars}d</span>
                      )}
                    </span>
                  </td>
                  <td className="sdp-crit-col-status-label">
                    <span className={`sdp-crit-status-pill sdp-crit-status-pill--${c.status}`}>
                      {criterionStatusLabel(c.status)}
                    </span>
                    {c.note && <span className="sdp-crit-note">{c.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}

        {activeTab === 'fundamental' && <div className="sdp-criteria-group">
          <div className="sdp-criteria-group-head">
            <span className="sdp-criteria-group-badge sdp-criteria-group-badge--fund">FUNDAMENTAL</span>
            <span className="sdp-criteria-group-label">EPS / Revenue Growth & Acceleration</span>
            <span className="sdp-criteria-group-count">{fundOk} / {fundTotal}</span>
          </div>
          <div className="sdp-criteria-group-sub">
            Data source: <code>stock_readiness_daily.fundamental_eval</code> (evaluated from <code>stock_income_statements</code> by Phase 1)
          </div>
          <table className="sdp-criteria-table">
            <thead>
              <tr>
                <th className="sdp-crit-col-status" />
                <th>Criteria</th>
                <th>Condition</th>
                <th>Explain</th>
                <th className="sdp-crit-col-fields">Required fields</th>
                <th className="sdp-crit-col-status-label">Status</th>
              </tr>
            </thead>
            <tbody>
              {fundStatuses.map((c) => (
                <tr key={c.id} className={`sdp-crit-row sdp-crit-row--${c.status}`}>
                  <td className="sdp-crit-col-status">
                    <span className={`sdp-crit-dot ${criterionStatusDot(c.status)}`} />
                  </td>
                  <td className="sdp-crit-name">{c.criteria}</td>
                  <td className="sdp-crit-condition"><code>{c.condition}</code></td>
                  <td className="sdp-crit-explain">{c.explain}</td>
                  <td className="sdp-crit-col-fields">
                    <span className="sdp-crit-fields">
                      {c.dataFields.map((f) => (
                        <span key={f} className="sdp-crit-field-chip">{f}</span>
                      ))}
                    </span>
                  </td>
                  <td className="sdp-crit-col-status-label">
                    <span className={`sdp-crit-status-pill sdp-crit-status-pill--${c.status}`}>
                      {criterionStatusLabel(c.status)}
                    </span>
                    {c.note && <span className="sdp-crit-note">{c.note}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>}
      </div>
    </div>
  )
}

// ── Catalog Tabs ──────────────────────────────────────────────────────────────

const CATALOG_TABS = [
  {
    key: 'raw' as const,
    label: 'RAW',
    title: 'Raw data sources',
    description:
      'Tables populated by ingest jobs or writer services. These are the authoritative inputs consumed by readiness views and snapshot logic.',
  },
  {
    key: 'computed' as const,
    label: 'COMPUTED',
    title: 'Computed readiness layers',
    description:
      'Views and snapshot tables derived from raw sources. The KPI metrics below read from this layer. Each entry lists its raw-source dependencies.',
  },
]

function CatalogTabs({ catalog }: { catalog: { raw_sources?: SepaReadinessCatalogEntry[]; computed_layers?: SepaReadinessCatalogEntry[] } }) {
  const [activeTab, setActiveTab] = useState<'raw' | 'computed'>('raw')

  const entries = activeTab === 'raw' ? catalog.raw_sources : catalog.computed_layers
  const meta = CATALOG_TABS.find((t) => t.key === activeTab)!

  return (
    <div className="sdp-catalog-block">
      <div className="sdp-catalog-tabs" role="tablist" aria-label="Data catalog">
        {CATALOG_TABS.map((tab) => {
          const count = (tab.key === 'raw' ? catalog.raw_sources : catalog.computed_layers)?.length ?? 0
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.key}
              className={`sdp-catalog-tab sdp-catalog-tab--${tab.key}${activeTab === tab.key ? ' sdp-catalog-tab--active' : ''}`}
              onClick={() => setActiveTab(tab.key)}
            >
              <span className={`sdp-catalog-badge sdp-catalog-badge--${tab.key}`}>{tab.label}</span>
              <span className="sdp-catalog-tab-title">{tab.title}</span>
              {count > 0 && <span className="sdp-catalog-tab-count">{count}</span>}
            </button>
          )
        })}
      </div>
      <p className="sdp-catalog-desc">{meta.description}</p>
      <div className="sdp-catalog-grid">
        {entries?.map((e) => (
          <DataSourceCard key={e.id} entry={e} variant={activeTab} />
        ))}
      </div>
    </div>
  )
}

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

interface GapsDrawerProps {
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

function GapsDrawer({
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

type FinancialGapsColumnPreset = 'income' | 'statement' | 'short_dated'

type FinDrawerKind = 'income' | 'balance' | 'cash' | 'ratios' | 'sint' | 'svol'
type FinBackfillJobKind =
  | 'feed_stocks_income_statements'
  | 'feed_stocks_balance_sheets'
  | 'feed_stocks_cash_flows'
  | 'feed_stocks_ratios'
  | 'feed_stocks_short_interest'
  | 'feed_stocks_short_volume'

function finDrawerTitleForKind(kind: FinDrawerKind): string {
  switch (kind) {
    case 'income':
      return 'Income statements'
    case 'balance':
      return 'Balance sheets'
    case 'cash':
      return 'Cash flow statements'
    case 'ratios':
      return 'Ratios'
    case 'sint':
      return 'Short interest'
    case 'svol':
      return 'Short volume'
  }
}

function finDrawerColumnPresetForKind(kind: FinDrawerKind): FinancialGapsColumnPreset {
  if (kind === 'income') return 'income'
  if (kind === 'sint' || kind === 'svol') return 'short_dated'
  return 'statement'
}

function finBackfillJobKindForDrawer(kind: FinDrawerKind): FinBackfillJobKind {
  switch (kind) {
    case 'income':
      return 'feed_stocks_income_statements'
    case 'balance':
      return 'feed_stocks_balance_sheets'
    case 'cash':
      return 'feed_stocks_cash_flows'
    case 'ratios':
      return 'feed_stocks_ratios'
    case 'sint':
      return 'feed_stocks_short_interest'
    case 'svol':
      return 'feed_stocks_short_volume'
  }
}

interface FinancialGapsDrawerProps {
  open: boolean
  title: string
  columnPreset: FinancialGapsColumnPreset
  onClose: () => void
  fetchGaps: () => Promise<SepaFinancialsGapsResponse>
  onBackfillAll: () => void
  backfillBusy: boolean
  backfillMsg: string | null
  backfillOk: boolean | null
  onBackfillSelected: (syms: string[]) => void
  backfillSelectedBusy: boolean
  backfillSelectedMsg: string | null
  backfillSelectedOk: boolean | null
}

function FinancialGapsDrawer(props: FinancialGapsDrawerProps) {
  const {
    open,
    title,
    columnPreset,
    onClose,
    fetchGaps,
    onBackfillAll,
    backfillBusy,
    backfillMsg,
    backfillOk,
    onBackfillSelected,
    backfillSelectedBusy,
    backfillSelectedMsg,
    backfillSelectedOk,
  } = props

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<SepaFinGapRow[]>([])
  const [totalGapCount, setTotalGapCount] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [selectedSymbols, setSelectedSymbols] = useState<Set<string>>(new Set())
  const [visibleLimit, setVisibleLimit] = useState(SDP_GAP_DRAWER_PAGE)
  const [lazyAppending, setLazyAppending] = useState(false)
  const lazyAppendTimerRef = useRef<number | null>(null)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    if (lazyAppendTimerRef.current != null) {
      window.clearTimeout(lazyAppendTimerRef.current)
      lazyAppendTimerRef.current = null
    }
    setVisibleLimit(SDP_GAP_DRAWER_PAGE)
    setLoading(true)
    setError(null)
    setSelectedSymbols(new Set())
    setLazyAppending(false)
    void fetchGaps().then((r) => {
      if (cancelled) return
      setLoading(false)
      if (!r.ok) {
        setError(r.error ?? 'Failed to load gaps')
        setItems([])
        setTotalGapCount(null)
        setLazyAppending(false)
        return
      }
      const g = Array.isArray(r.gaps) ? r.gaps : []
      const firstChunk = g.slice(0, SDP_GAP_LAZY_APPEND_CHUNK)
      setItems(firstChunk)
      setTotalGapCount(typeof r.total_gap_count === 'number' ? r.total_gap_count : g.length)
      if (g.length <= SDP_GAP_LAZY_APPEND_CHUNK) {
        setLazyAppending(false)
        return
      }
      setLazyAppending(true)
      const appendRemaining = (offset: number) => {
        if (cancelled) return
        const nextOffset = offset + SDP_GAP_LAZY_APPEND_CHUNK
        setItems((prev) => prev.concat(g.slice(offset, nextOffset)))
        if (nextOffset < g.length) {
          lazyAppendTimerRef.current = window.setTimeout(() => appendRemaining(nextOffset), 0)
          return
        }
        setLazyAppending(false)
        lazyAppendTimerRef.current = null
      }
      lazyAppendTimerRef.current = window.setTimeout(
        () => appendRemaining(SDP_GAP_LAZY_APPEND_CHUNK),
        0,
      )
    })
    return () => {
      cancelled = true
      if (lazyAppendTimerRef.current != null) {
        window.clearTimeout(lazyAppendTimerRef.current)
        lazyAppendTimerRef.current = null
      }
    }
  }, [open, fetchGaps])

  const filtered = items.filter((it) => {
    const s = q.trim().toUpperCase()
    if (!s) return true
    return it.symbol.toUpperCase().includes(s)
  })

  const visibleFiltered = filtered.slice(0, visibleLimit)

  const toggleSymbol = (sym: string) => {
    setSelectedSymbols((prev) => {
      const n = new Set(prev)
      if (n.has(sym)) n.delete(sym)
      else n.add(sym)
      return n
    })
  }

  const toggleAllFiltered = () => {
    const allSel = visibleFiltered.every((it) => selectedSymbols.has(it.symbol))
    setSelectedSymbols((prev) => {
      const n = new Set(prev)
      if (allSel) {
        for (const it of visibleFiltered) n.delete(it.symbol)
      } else {
        for (const it of visibleFiltered) n.add(it.symbol)
      }
      return n
    })
  }

  const someFilteredSelected = visibleFiltered.some((it) => selectedSymbols.has(it.symbol))
  const allFilteredSelected =
    visibleFiltered.length > 0 && visibleFiltered.every((it) => selectedSymbols.has(it.symbol))

  const copyReport = async () => {
    const lines = filtered.map((it) => {
      const qr = it.quarterly_rows ?? '—'
      const ar = it.annual_rows ?? '—'
      const qd = it.quarterly_max_period_end ?? '—'
      const ad = it.annual_max_period_end ?? '—'
      const gr = it.gap_reason ?? '—'
      if (columnPreset === 'income') {
        return `${it.symbol}\t${qr}\t${ar}\t${qd}\t${ad}\t${gr}`
      }
      if (columnPreset === 'statement') {
        return `${it.symbol}\t${qr}\t${gr}`
      }
      return `${it.symbol}\t${qr}\t${ad}\t${gr}`
    })
    const header =
      columnPreset === 'income'
        ? 'symbol\tquarterly_rows\tannual_rows\tquarterly_max_period_end\tannual_max_period_end\tgap_reason'
        : columnPreset === 'statement'
        ? 'symbol\tquarterly_rows\tgap_reason'
        : 'symbol\trows\tmax_date\tgap_reason'
    const text = [header, ...lines].join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopyError(true)
      setTimeout(() => setCopyError(false), 2500)
    }
  }

  if (!open) return null

  return (
    <>
      <div className="sdp-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="sdp-drawer sdp-drawer--wide sdp-drawer--open" role="dialog" aria-modal="true" aria-label={`${title} gaps`}>
        <div className="sdp-drawer-header">
          <div className="sdp-drawer-title">
            <span className="sdp-drawer-title-icon">⚠</span>
            {title} gaps
            {totalGapCount != null && <span className="sdp-drawer-badge">{totalGapCount.toLocaleString()}</span>}
          </div>
          <button type="button" className="sdp-drawer-close" onClick={onClose} aria-label="Close gap panel">×</button>
        </div>

        <div className="sdp-drawer-sub">
          Per-symbol financial statement gaps for selected step.
        </div>

        <div className="sdp-drawer-actions">
          <button type="button" className="sdp-btn-primary" disabled={backfillBusy} onClick={onBackfillAll}>
            {backfillBusy ? 'Enqueueing…' : 'Backfill all gaps'}
          </button>
          <button
            type="button"
            className="sdp-btn-backfill-selected"
            disabled={backfillSelectedBusy || selectedSymbols.size === 0}
            onClick={() => onBackfillSelected(Array.from(selectedSymbols))}
          >
            {backfillSelectedBusy ? 'Enqueueing…' : `Backfill selected (${selectedSymbols.size})`}
          </button>
          <button
            type="button"
            className={`sdp-btn-copy-llm${copied ? ' sdp-btn-copy-llm--ok' : copyError ? ' sdp-btn-copy-llm--err' : ''}`}
            onClick={() => void copyReport()}
            disabled={loading || filtered.length === 0}
            title="Copy gap report to clipboard"
          >
            {copied ? '✓ Copied' : copyError ? '⚠ Copy failed' : 'Copy report'}
          </button>
        </div>

        {(backfillMsg || backfillSelectedMsg) && (
          <div className="sdp-feedback" style={{ margin: '0 var(--space-4) var(--space-2)' }}>
            {backfillMsg && (
              <div className={backfillOk === false ? 'sdp-msg--err' : 'sdp-msg--ok'}>
                {backfillMsg}
              </div>
            )}
            {backfillSelectedMsg && (
              <div className={backfillSelectedOk === false ? 'sdp-msg--err' : 'sdp-msg--ok'}>
                {backfillSelectedMsg}
              </div>
            )}
          </div>
        )}

        <div className="sdp-drawer-search">
          <input
            type="text"
            className="sdp-drawer-search-input"
            placeholder="Filter by symbol…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter gap symbols"
          />
          {q && (
            <button type="button" className="sdp-drawer-search-clear" onClick={() => setQ('')} aria-label="Clear filter">×</button>
          )}
          {!loading && !error && (
            <span className="sdp-drawer-search-count">
              {filtered.length.toLocaleString()} / {(totalGapCount ?? items.length).toLocaleString()}
            </span>
          )}
        </div>

        <div className="sdp-drawer-body">
          {loading && <div className="sdp-drawer-loading">Loading…</div>}
          {!loading && error && <div className="sdp-drawer-error">{error}</div>}
          {!loading && !error && filtered.length === 0 && (
            <div className="sdp-drawer-empty">No gaps match the filter.</div>
          )}
          {!loading && !error && filtered.length > 0 && (
            <table className="sdp-gap-table">
              <thead>
                <tr>
                  <th className="sdp-gap-col-check">
                    <input
                      type="checkbox"
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
                  {columnPreset === 'income' && (
                    <>
                      <th>Q rows</th>
                      <th>A rows</th>
                      <th>Q max period_end</th>
                      <th>A max period_end</th>
                    </>
                  )}
                  {columnPreset === 'statement' && <th>Q rows</th>}
                  {columnPreset === 'short_dated' && (
                    <>
                      <th>Rows</th>
                      <th>Max date</th>
                    </>
                  )}
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
                      {columnPreset === 'income' && (
                        <>
                          <td>{it.quarterly_rows ?? '—'}</td>
                          <td>{it.annual_rows ?? '—'}</td>
                          <td className="sdp-gap-date">{it.quarterly_max_period_end ?? '—'}</td>
                          <td className="sdp-gap-date">{it.annual_max_period_end ?? '—'}</td>
                        </>
                      )}
                      {columnPreset === 'statement' && <td>{it.quarterly_rows ?? '—'}</td>}
                      {columnPreset === 'short_dated' && (
                        <>
                          <td>{it.quarterly_rows ?? '—'}</td>
                          <td className="sdp-gap-date">{it.annual_max_period_end ?? '—'}</td>
                        </>
                      )}
                      <td className="sdp-gap-reason">{it.gap_reason ?? '—'}</td>
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
        {!loading && !error && lazyAppending && (
          <div className="sdp-drawer-truncated">
            Loading remaining symbols… {items.length.toLocaleString()}
            {totalGapCount != null ? ` / ${totalGapCount.toLocaleString()}` : ''}
          </div>
        )}
      </aside>
    </>
  )
}

// ── Step ok helper ────────────────────────────────────────────────────────────

function finGapOk(n: number | null | undefined): boolean {
  return n != null && n === 0
}

// ── Fundamental SQL explanation constants ─────────────────────────────────────

const FUND_SQL_AGGREGATION = `-- Aggregation query behind the Fundamental percentages
-- Table: public.stock_readiness_daily  (as_of_date = CURRENT_DATE)
WITH snapshot AS (
    SELECT
        (fundamental_eval->>'fundamental_pass')::boolean  AS fund_pass,
        (fundamental_eval->>'insufficient_data')::boolean AS no_data,
        fundamental_eval
    FROM public.stock_readiness_daily
    WHERE as_of_date = CURRENT_DATE
      AND included_in_universe = true
      AND fundamental_eval IS NOT NULL
),
per_sym AS (
    SELECT
        fund_pass,
        no_data,
        (fundamental_eval->'conditions' @> '[{"id":"eps_q2q_ge_25pct","pass":true}]'::jsonb) AS cond_eps_q2q,
        (fundamental_eval->'conditions' @> '[{"id":"rev_q2q_ge_25pct","pass":true}]'::jsonb) AS cond_rev_q2q,
        (fundamental_eval->'conditions' @> '[{"id":"eps_acc_2q","pass":true}]'::jsonb)       AS cond_eps_acc_2q,
        (fundamental_eval->'conditions' @> '[{"id":"rev_acc_2q","pass":true}]'::jsonb)       AS cond_rev_acc_2q,
        (fundamental_eval->'conditions' @> '[{"id":"eps_3y_ge_15pct","pass":true}]'::jsonb)  AS cond_eps_3y,
        (fundamental_eval->'conditions' @> '[{"id":"rev_3y_ge_15pct","pass":true}]'::jsonb)  AS cond_rev_3y,
        (fundamental_eval->'conditions' @> '[{"id":"eps_acc_fy","pass":true}]'::jsonb)       AS cond_eps_acc_fy,
        (fundamental_eval->'conditions' @> '[{"id":"rev_acc_fy","pass":true}]'::jsonb)       AS cond_rev_acc_fy
    FROM snapshot
)
SELECT
    count(*)                                                           AS evaluated,
    count(*) FILTER (WHERE fund_pass)                                  AS fund_pass_count,
    count(*) FILTER (WHERE no_data)                                    AS no_data_count,
    count(*) FILTER (WHERE cond_eps_q2q)                               AS eps_q2q_pass,
    count(*) FILTER (WHERE NOT cond_eps_q2q  AND NOT no_data)          AS eps_q2q_fail,
    count(*) FILTER (WHERE cond_rev_q2q)                               AS rev_q2q_pass,
    count(*) FILTER (WHERE NOT cond_rev_q2q  AND NOT no_data)          AS rev_q2q_fail,
    count(*) FILTER (WHERE cond_eps_acc_2q)                            AS eps_acc_2q_pass,
    count(*) FILTER (WHERE NOT cond_eps_acc_2q AND NOT no_data)        AS eps_acc_2q_fail,
    count(*) FILTER (WHERE cond_rev_acc_2q)                            AS rev_acc_2q_pass,
    count(*) FILTER (WHERE NOT cond_rev_acc_2q AND NOT no_data)        AS rev_acc_2q_fail,
    count(*) FILTER (WHERE cond_eps_3y)                                AS eps_3y_pass,
    count(*) FILTER (WHERE NOT cond_eps_3y   AND NOT no_data)          AS eps_3y_fail,
    count(*) FILTER (WHERE cond_rev_3y)                                AS rev_3y_pass,
    count(*) FILTER (WHERE NOT cond_rev_3y   AND NOT no_data)          AS rev_3y_fail,
    count(*) FILTER (WHERE cond_eps_acc_fy)                            AS eps_acc_fy_pass,
    count(*) FILTER (WHERE NOT cond_eps_acc_fy AND NOT no_data)        AS eps_acc_fy_fail,
    count(*) FILTER (WHERE cond_rev_acc_fy)                            AS rev_acc_fy_pass,
    count(*) FILTER (WHERE NOT cond_rev_acc_fy AND NOT no_data)        AS rev_acc_fy_fail
FROM per_sym;`

const FUND_SQL_SYMBOL = `-- Per-symbol drill-down (replace 'AAPL' with the symbol to inspect)
SELECT
    symbol,
    fundamental_pass,
    fundamental_pass_count,
    fundamental_insufficient,
    fund_cache_expire_at,
    jsonb_pretty(fundamental_eval) AS eval_detail
FROM public.stock_readiness_daily
WHERE as_of_date = CURRENT_DATE
  AND symbol = 'AAPL';`

// ── Per-condition calculation details ─────────────────────────────────────────

interface CondDetail {
  table: string
  column: string
  period: string
  formula: string
  dataReq: string
  sql: string
}

const COND_DETAIL: Record<string, CondDetail> = {
  eps_q2q_ge_25pct: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'quarterly'",
    formula:
      'growth = (EPS_Q_current − EPS_same_Q_prior_year) / |EPS_same_Q_prior_year|\nPass when growth ≥ 0.25 (25%)\nSkips quarter if prior-year EPS is zero or negative',
    dataReq: 'At least one pair of matching quarters across two consecutive years (e.g. Q3-2024 vs Q3-2023)',
    sql: `-- EPS QoQ ≥ 25%  —  replace 'AAPL' with any symbol
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 10
),
latest AS (
  SELECT * FROM q
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 1
)
SELECT
  l.fiscal_year            AS cur_year,
  l.fiscal_quarter         AS quarter,
  l.eps                    AS current_eps,
  p.eps                    AS prior_year_eps,
  ROUND(((l.eps - p.eps) / NULLIF(ABS(p.eps), 0))::numeric, 4)  AS yoy_growth,
  ((l.eps - p.eps) / NULLIF(ABS(p.eps), 0) >= 0.25)             AS passes
FROM latest l
JOIN q p
  ON p.fiscal_year = l.fiscal_year - 1
 AND p.fiscal_quarter = l.fiscal_quarter;`,
  },

  rev_q2q_ge_25pct: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'quarterly'",
    formula:
      'growth = (Rev_Q_current − Rev_same_Q_prior_year) / |Rev_same_Q_prior_year|\nPass when growth ≥ 0.25 (25%)',
    dataReq: 'At least one pair of matching quarters across two consecutive years',
    sql: `-- Revenue QoQ ≥ 25%  —  replace 'AAPL' with any symbol
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 10
),
latest AS (
  SELECT * FROM q
  ORDER BY fiscal_year DESC, fiscal_quarter DESC
  LIMIT 1
)
SELECT
  l.fiscal_year            AS cur_year,
  l.fiscal_quarter         AS quarter,
  l.rev                    AS current_rev,
  p.rev                    AS prior_year_rev,
  ROUND(((l.rev - p.rev) / NULLIF(ABS(p.rev), 0))::numeric, 4)  AS yoy_growth,
  ((l.rev - p.rev) / NULLIF(ABS(p.rev), 0) >= 0.25)             AS passes
FROM latest l
JOIN q p
  ON p.fiscal_year = l.fiscal_year - 1
 AND p.fiscal_quarter = l.fiscal_quarter;`,
  },

  eps_acc_2q: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'quarterly'",
    formula:
      'Computes YoY growth for the 3 most recent quarters (same Q vs prior year)\nPass when growth[Q-2] < growth[Q-1] < growth[Q0]  (strictly accelerating)',
    dataReq: 'At least 3 quarterly YoY growth data points (requires data for Q-2 through Q0 plus same quarters one year prior)',
    sql: `-- EPS Accelerating (2Q)  —  replace 'AAPL' with any symbol
-- Shows 3 consecutive quarterly YoY growth rates (oldest → newest)
-- Passes when every row's yoy_growth > the previous row's yoy_growth
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
),
growth AS (
  SELECT
    c.fiscal_year,
    c.fiscal_quarter,
    ROUND(((c.eps - p.eps) / NULLIF(ABS(p.eps), 0))::numeric, 4) AS yoy_growth
  FROM q c
  JOIN q p
    ON p.fiscal_year = c.fiscal_year - 1
   AND p.fiscal_quarter = c.fiscal_quarter
  WHERE p.eps <> 0
  ORDER BY c.fiscal_year DESC, c.fiscal_quarter DESC
  LIMIT 3
)
SELECT fiscal_year, fiscal_quarter, yoy_growth
FROM growth
ORDER BY fiscal_year, fiscal_quarter;
-- passes = TRUE when row1.yoy_growth < row2.yoy_growth < row3.yoy_growth`,
  },

  rev_acc_2q: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'quarterly'",
    formula:
      'Same logic as EPS Accelerating (2Q) but uses revenues column\nPass when Rev_YoY_growth[Q-2] < Rev_YoY_growth[Q-1] < Rev_YoY_growth[Q0]',
    dataReq: 'At least 3 quarterly YoY growth data points for revenue',
    sql: `-- Revenue Accelerating (2Q)  —  replace 'AAPL' with any symbol
WITH q AS (
  SELECT fiscal_year, fiscal_quarter,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'quarterly'
),
growth AS (
  SELECT
    c.fiscal_year,
    c.fiscal_quarter,
    ROUND(((c.rev - p.rev) / NULLIF(ABS(p.rev), 0))::numeric, 4) AS yoy_growth
  FROM q c
  JOIN q p
    ON p.fiscal_year = c.fiscal_year - 1
   AND p.fiscal_quarter = c.fiscal_quarter
  WHERE p.rev <> 0
  ORDER BY c.fiscal_year DESC, c.fiscal_quarter DESC
  LIMIT 3
)
SELECT fiscal_year, fiscal_quarter, yoy_growth
FROM growth
ORDER BY fiscal_year, fiscal_quarter;
-- passes = TRUE when row1.yoy_growth < row2.yoy_growth < row3.yoy_growth`,
  },

  eps_3y_ge_15pct: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'annual'",
    formula:
      'CAGR = (EPS_latest_year / EPS_3_years_ago)^(1/3) − 1\nPass when CAGR ≥ 0.15 (15%)\nSkips if EPS_3_years_ago ≤ 0 or EPS_latest ≤ 0',
    dataReq: 'Minimum 4 annual rows (spans 3 full fiscal years)',
    sql: `-- EPS 3-Year CAGR ≥ 15%  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
)
SELECT
  MAX(CASE WHEN rn = 1 THEN fiscal_year END)  AS latest_year,
  MAX(CASE WHEN rn = 4 THEN fiscal_year END)  AS base_year,
  MAX(CASE WHEN rn = 1 THEN eps END)          AS latest_eps,
  MAX(CASE WHEN rn = 4 THEN eps END)          AS base_eps,
  ROUND((
    POWER(
      MAX(CASE WHEN rn = 1 THEN eps END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN eps END), 0),
      1.0/3
    ) - 1
  )::numeric, 4)                              AS cagr_3y,
  (
    POWER(
      MAX(CASE WHEN rn = 1 THEN eps END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN eps END), 0),
      1.0/3
    ) - 1 >= 0.15
  )                                           AS passes
FROM ranked;`,
  },

  rev_3y_ge_15pct: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'annual'",
    formula:
      'CAGR = (Rev_latest_year / Rev_3_years_ago)^(1/3) − 1\nPass when CAGR ≥ 0.15 (15%)',
    dataReq: 'Minimum 4 annual rows (spans 3 full fiscal years)',
    sql: `-- Revenue 3-Year CAGR ≥ 15%  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
)
SELECT
  MAX(CASE WHEN rn = 1 THEN fiscal_year END)  AS latest_year,
  MAX(CASE WHEN rn = 4 THEN fiscal_year END)  AS base_year,
  MAX(CASE WHEN rn = 1 THEN rev END)          AS latest_rev,
  MAX(CASE WHEN rn = 4 THEN rev END)          AS base_rev,
  ROUND((
    POWER(
      MAX(CASE WHEN rn = 1 THEN rev END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN rev END), 0),
      1.0/3
    ) - 1
  )::numeric, 4)                              AS cagr_3y,
  (
    POWER(
      MAX(CASE WHEN rn = 1 THEN rev END) /
      NULLIF(MAX(CASE WHEN rn = 4 THEN rev END), 0),
      1.0/3
    ) - 1 >= 0.15
  )                                           AS passes
FROM ranked;`,
  },

  eps_acc_fy: {
    table: 'stock_income_statements',
    column: 'basic_earnings_per_share',
    period: "timeframe = 'annual'",
    formula:
      'g_latest = EPS_FY0 / EPS_FY1 − 1  (latest year YoY)\ng_prior  = EPS_FY1 / EPS_FY2 − 1  (prior year YoY)\nPass when g_latest > g_prior',
    dataReq: 'Minimum 4 annual rows (needs FY0, FY1, FY2 for two growth rates)',
    sql: `-- EPS Accelerating (FY)  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         basic_earnings_per_share AS eps
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
),
vals AS (
  SELECT
    MAX(CASE WHEN rn = 1 THEN eps END) AS v0,   -- latest fiscal year
    MAX(CASE WHEN rn = 2 THEN eps END) AS v1,   -- 1 year ago
    MAX(CASE WHEN rn = 3 THEN eps END) AS v2    -- 2 years ago
  FROM ranked
)
SELECT
  v0, v1, v2,
  ROUND((v0 / NULLIF(v1, 0) - 1)::numeric, 4)  AS g_latest,
  ROUND((v1 / NULLIF(v2, 0) - 1)::numeric, 4)  AS g_prior,
  ((v0 / NULLIF(v1, 0) - 1) > (v1 / NULLIF(v2, 0) - 1)) AS passes
FROM vals;`,
  },

  rev_acc_fy: {
    table: 'stock_income_statements',
    column: 'revenues',
    period: "timeframe = 'annual'",
    formula:
      'g_latest = Rev_FY0 / Rev_FY1 − 1  (latest year YoY)\ng_prior  = Rev_FY1 / Rev_FY2 − 1  (prior year YoY)\nPass when g_latest > g_prior',
    dataReq: 'Minimum 4 annual rows (needs FY0, FY1, FY2 for two growth rates)',
    sql: `-- Revenue Accelerating (FY)  —  replace 'AAPL' with any symbol
WITH annual AS (
  SELECT fiscal_year,
         revenues AS rev
  FROM public.stock_income_statements
  WHERE symbol = 'AAPL'
    AND source = 'massive'
    AND timeframe = 'annual'
  ORDER BY fiscal_year DESC
  LIMIT 4
),
ranked AS (
  SELECT *, ROW_NUMBER() OVER (ORDER BY fiscal_year DESC) AS rn
  FROM annual
),
vals AS (
  SELECT
    MAX(CASE WHEN rn = 1 THEN rev END) AS v0,   -- latest fiscal year
    MAX(CASE WHEN rn = 2 THEN rev END) AS v1,   -- 1 year ago
    MAX(CASE WHEN rn = 3 THEN rev END) AS v2    -- 2 years ago
  FROM ranked
)
SELECT
  v0, v1, v2,
  ROUND((v0 / NULLIF(v1, 0) - 1)::numeric, 4)  AS g_latest,
  ROUND((v1 / NULLIF(v2, 0) - 1)::numeric, 4)  AS g_prior,
  ((v0 / NULLIF(v1, 0) - 1) > (v1 / NULLIF(v2, 0) - 1)) AS passes
FROM vals;`,
  },
}

// ── Inner Page ────────────────────────────────────────────────────────────────

/** Inner page: consumes MassiveRefJobSessionContext for job tracking. */
function StockDataReadinessPageInner({
  onBreadcrumbResearch,
  breadcrumbLabel = 'Stock Data Readiness',
  onOpenCelerySettings,
  onOpenFeedMassiveStock,
  onOpenDataCoverageSummary,
}: StockDataReadinessPageProps) {
  const refJobSession = useMassiveRefJobSession()

  const [summary, setSummary] = useState<SepaReadinessSummaryResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(false)
  const [summaryErr, setSummaryErr] = useState<string | null>(null)
  const summaryLoadedAtRef = useRef<string | null>(null)
  const [activeRunStep, setActiveRunStep] = useState<SepaRunStep>(1)

  const [snapshotMsg, setSnapshotMsg] = useState<string | null>(null)
  const [snapshotOk, setSnapshotOk] = useState<boolean | null>(null)

  const [unifiedSnapBusy, setUnifiedSnapBusy] = useState(false)
  const [unifiedSnapMsg, setUnifiedSnapMsg] = useState<string | null>(null)
  const [unifiedSnapOk, setUnifiedSnapOk] = useState<boolean | null>(null)

  const [universeErr, setUniverseErr] = useState<string | null>(null)

  const [holidaysSyncBusy, setHolidaysSyncBusy] = useState(false)
  const [holidaysSyncMsg, setHolidaysSyncMsg] = useState<string | null>(null)
  const [holidaysSyncOk, setHolidaysSyncOk] = useState<boolean | null>(null)
  const [holidaysSyncResult, setHolidaysSyncResult] = useState<SepaSyncHolidaysResponse | null>(null)

  const [groupedHistoryBusy, setGroupedHistoryBusy] = useState(false)
  const [groupedHistoryMsg, setGroupedHistoryMsg] = useState<string | null>(null)
  const [groupedHistoryOk, setGroupedHistoryOk] = useState<boolean | null>(null)

  const [priceGapBusy, setPriceGapBusy] = useState(false)
  const [priceGapMsg, setPriceGapMsg] = useState<string | null>(null)
  const [priceGapOk, setPriceGapOk] = useState<boolean | null>(null)

  const [fixGapsBusy, setFixGapsBusy] = useState(false)
  const [fixGapsMsg, setFixGapsMsg] = useState<string | null>(null)
  const [fixGapsOk, setFixGapsOk] = useState<boolean | null>(null)

  const [fundBackfillMsg, setFundBackfillMsg] = useState<string | null>(null)
  const [fundBackfillOk, setFundBackfillOk] = useState<boolean | null>(null)

  const [selectedGapBusy, setSelectedGapBusy] = useState(false)
  const [selectedGapMsg, setSelectedGapMsg] = useState<string | null>(null)
  const [selectedGapOk, setSelectedGapOk] = useState<boolean | null>(null)

  const [checkedSteps, setCheckedSteps] = useState<Set<number>>(new Set())

  const [gapsDrawerOpen, setGapsDrawerOpen] = useState(false)
  const [dataSupportChecked, setDataSupportChecked] = useState(false)
  const dataSupportSectionRef = useRef<HTMLDivElement | null>(null)
  const [activeInfoTab, setActiveInfoTab] = useState<'checklist' | 'database' | 'reference' | 'metrics'>('metrics')
  const [collapsedResultStages, setCollapsedResultStages] = useState<Set<RunbookStageId>>(
    () => new Set(RUNBOOK_STAGE_LAYOUT.map((s) => s.id)),
  )

  const [finDrawerKind, setFinDrawerKind] = useState<FinDrawerKind | null>(null)
  const [finAllBusy, setFinAllBusy] = useState(false)
  const [finAllMsg, setFinAllMsg] = useState<string | null>(null)
  const [finAllOk, setFinAllOk] = useState<boolean | null>(null)
  const [finSelBusy, setFinSelBusy] = useState(false)
  const [finSelMsg, setFinSelMsg] = useState<string | null>(null)
  const [finSelOk, setFinSelOk] = useState<boolean | null>(null)

  const [queues, setQueues] = useState<QueueSummaryRow[]>([])
  const [queuesErr, setQueuesErr] = useState<string | null>(null)
  const [queuesLoading, setQueuesLoading] = useState(false)

  const [voidAckBusy, setVoidAckBusy] = useState<SepaGapAckDataType | null>(null)
  const [voidAckMsg, setVoidAckMsg] = useState<string | null>(null)

  // Step 13 — SEPA Criteria Stats
  const [criteriaStats, setCriteriaStats] = useState<SepaCriteriaStats | null>(null)
  const [criteriaLoading, setCriteriaLoading] = useState(false)
  const [criteriaErr, setCriteriaErr] = useState<string | null>(null)
  const [showFundSql, setShowFundSql] = useState(false)
  const [copiedSql, setCopiedSql] = useState<'agg' | 'sym' | null>(null)
  const [expandedCondId, setExpandedCondId] = useState<string | null>(null)
  const [copiedCondId, setCopiedCondId] = useState<string | null>(null)
  // Step 13 — Data Inventory
  const [inventoryStats, setInventoryStats] = useState<SepaDataInventoryStats | null>(null)
  const [inventoryLoading, setInventoryLoading] = useState(false)
  const [inventoryErr, setInventoryErr] = useState<string | null>(null)

  // Combined evaluate & publish (Step 10)
  const [evalPublishBusy, setEvalPublishBusy] = useState(false)
  const [evalPublishPhase, setEvalPublishPhase] = useState<'idle' | 'backfill' | 'snapshot'>('idle')

  const loadCriteriaStats = useCallback(async () => {
    setCriteriaLoading(true)
    setCriteriaErr(null)
    try {
      const res = await fetchSepaCriteriaStats()
      if (!res.ok) { setCriteriaErr(res.error ?? 'Failed'); return }
      setCriteriaStats(res)
    } catch (e) {
      setCriteriaErr(e instanceof Error ? e.message : 'Network error')
    } finally {
      setCriteriaLoading(false)
    }
  }, [])

  // Auto-load criteria stats when snapshot first becomes populated
  const snapshotPopulated = summary?.snapshot_populated ?? false
  useEffect(() => {
    if (snapshotPopulated && criteriaStats == null && !criteriaLoading) {
      void loadCriteriaStats()
    }
  }, [snapshotPopulated]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadInventoryStats = useCallback(async () => {
    setInventoryLoading(true)
    setInventoryErr(null)
    try {
      const res = await fetchSepaDataInventory()
      if (!res.ok) { setInventoryErr(res.error ?? 'Failed'); return }
      setInventoryStats(res)
    } catch (e) {
      setInventoryErr(e instanceof Error ? e.message : 'Network error')
    } finally {
      setInventoryLoading(false)
    }
  }, [])

  const loadSummary = useCallback(async (): Promise<SepaReadinessSummaryResponse | null> => {
    setSummaryLoading(true)
    setSummaryErr(null)
    try {
      const res = await fetchSepaReadinessSummary()
      console.log('[Summary] raw response:', JSON.stringify(res).slice(0, 400))
      setSummary(res)
      summaryLoadedAtRef.current = new Date().toISOString()
      if (!res.ok) setSummaryErr(res.error ?? `Research API returned ok:false (no detail) — see console`)
      return res
    } catch (e) {
      setSummaryErr(e instanceof Error ? e.message : `Unexpected error: ${String(e)}`)
      setSummary(null)
      return null
    } finally {
      setSummaryLoading(false)
    }
  }, [])

  const loadQueues = useCallback(async () => {
    setQueuesLoading(true)
    setQueuesErr(null)
    try {
      const res = await fetchQueueSummary()
      if (!res.ok) {
        setQueuesErr(res.error ?? 'Queue summary unavailable (Ops token or broker).')
        setQueues([])
        return
      }
      setQueues(res.queues ?? [])
    } catch (e) {
      setQueuesErr(e instanceof Error ? e.message : 'Queue summary failed')
      setQueues([])
    } finally {
      setQueuesLoading(false)
    }
  }, [])

  const handleRunbookReadinessCheck = useCallback(async () => {
    const res = await loadSummary()
    void loadQueues()
    if (res !== null) {
      setCheckedSteps(new Set<number>(ALL_SEPA_RUNBOOK_STEP_IDS))
    }
  }, [loadSummary, loadQueues])

  const handleReload = useCallback(() => {
    void handleRunbookReadinessCheck()
  }, [handleRunbookReadinessCheck])

  const handleToggleVoid = useCallback(
    async (dataType: SepaGapAckDataType, isVoid: boolean, gapCount: number) => {
      if (voidAckBusy) return
      setVoidAckBusy(dataType)
      setVoidAckMsg(null)
      try {
        const res = await postSepaGapAck(dataType, isVoid, gapCount)
        if (!res.ok) {
          setVoidAckMsg(res.error ?? 'Failed to save')
        } else {
          void loadSummary()
        }
      } catch (e) {
        setVoidAckMsg(e instanceof Error ? e.message : 'Failed to save')
      } finally {
        setVoidAckBusy(null)
      }
    },
    [voidAckBusy, loadSummary],
  )

  const runUnifiedStockSnapshot = async () => {
    setUnifiedSnapBusy(true)
    setUnifiedSnapMsg(null)
    setUnifiedSnapOk(null)
    try {
      const res = await postSepaStockUnifiedSnapshot()
      if (!res.ok) {
        setUnifiedSnapMsg(res.error ?? 'Unified snapshot refresh failed')
        setUnifiedSnapOk(false)
        return
      }
      const parts = [
        res.message,
        `symbols_total=${fmt(res.symbols_total)} chunks=${fmt(res.chunks)} rows_upserted=${fmt(res.rows_upserted)} elapsed=${fmt(res.elapsed_ms)}ms`,
      ]
      if (res.errors && res.errors.length > 0) {
        parts.push(`errors: ${res.errors.slice(0, 3).join(' · ')}`)
      }
      setUnifiedSnapMsg(parts.filter(Boolean).join(' — '))
      setUnifiedSnapOk(true)
      await loadSummary()
    } catch (e) {
      setUnifiedSnapMsg(e instanceof Error ? e.message : 'Unified snapshot refresh failed')
      setUnifiedSnapOk(false)
    } finally {
      setUnifiedSnapBusy(false)
    }
  }

  const runHolidaysSync = useCallback(async (): Promise<SepaSyncHolidaysResponse> => {
    setHolidaysSyncBusy(true)
    setHolidaysSyncMsg(null)
    setHolidaysSyncOk(null)
    try {
      const res = await postSepaSyncHolidays()
      setHolidaysSyncResult(res)
      if (!res.ok) {
        setHolidaysSyncMsg(res.error ?? 'Holidays sync failed')
        setHolidaysSyncOk(false)
        return res
      }
      const fetched = res.fetched ?? 0
      const inserted = res.inserted ?? 0
      const updated = res.updated ?? 0
      const skipped = res.skipped ?? 0
      setHolidaysSyncMsg(
        `Holidays synced — fetched ${fmt(fetched)}, inserted ${fmt(inserted)}, updated ${fmt(updated)}` +
          (skipped > 0 ? `, skipped ${fmt(skipped)}` : ''),
      )
      setHolidaysSyncOk(true)
      return res
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Holidays sync failed'
      setHolidaysSyncMsg(msg)
      setHolidaysSyncOk(false)
      return { ok: false, error: msg }
    } finally {
      setHolidaysSyncBusy(false)
    }
  }, [])

  const runUniverseEnqueue = async () => {
    setUniverseErr(null)
    const [tickerRes, holidaysRes] = await Promise.all([
      refJobSession.enqueueTickerReferenceJob(
        'feed_stocks_tickers_reference_universe',
        { full_universe: true, limit: 1000, sort: 'ticker', order: 'asc' },
        'high',
      ),
      runHolidaysSync(),
    ])
    const tickerErr = !tickerRes.ok ? (tickerRes.error ?? 'Ticker enqueue failed') : null
    const holidayErr = !holidaysRes.ok ? (holidaysRes.error ?? 'Holidays sync failed') : null
    const combined = [
      tickerErr ? `Tickers: ${tickerErr}` : null,
      holidayErr ? `Holidays: ${holidayErr}` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    if (combined) setUniverseErr(combined)
  }

  const runGroupedHistoryBackfill = async () => {
    setGroupedHistoryBusy(true)
    setGroupedHistoryMsg(null)
    setGroupedHistoryOk(null)
    try {
      const res = await postSepaGroupedHistoryBackfill(420)
      if (!res.ok) {
        setGroupedHistoryMsg(res.error ?? 'Backfill failed')
        setGroupedHistoryOk(false)
        return
      }
      if (res.message) {
        setGroupedHistoryMsg(res.message)
        setGroupedHistoryOk(true)
        return
      }
      const queued = res.dates_queued ?? 0
      const checked = res.checked_dates ?? 0
      setGroupedHistoryMsg(
        queued === 0
          ? `All ${fmt(checked)} trading days already covered (≥1,000 symbols/day).`
          : `Queued ${fmt(queued)} jobs (of ${fmt(checked)} trading days). Each job = 1 API call → 5,000+ symbols.`,
      )
      setGroupedHistoryOk(true)
      if (res.job_ids && res.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: res.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setGroupedHistoryMsg(e instanceof Error ? e.message : 'Backfill failed')
      setGroupedHistoryOk(false)
    } finally {
      setGroupedHistoryBusy(false)
    }
  }

  const runPriceGapBackfill = async () => {
    setPriceGapBusy(true)
    setPriceGapMsg(null)
    setPriceGapOk(null)
    try {
      const res = await postSepaPriceGapBackfill()
      if (!res.ok) {
        setPriceGapMsg(res.error ?? 'Backfill failed')
        setPriceGapOk(false)
        return
      }
      if (res.message) {
        setPriceGapMsg(res.message)
        setPriceGapOk(true)
        return
      }
      const gapCount = res.gap_count ?? 0
      const chunks = res.chunks ?? 0
      setPriceGapMsg(`Dispatched ${fmt(chunks)} tasks covering ${fmt(gapCount)} gap symbols.`)
      setPriceGapOk(true)
      // Track first job and open Jobs sheet
      if (res.job_ids && res.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: res.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setPriceGapMsg(e instanceof Error ? e.message : 'Backfill failed')
      setPriceGapOk(false)
    } finally {
      setPriceGapBusy(false)
    }
  }

  const runPriceGapBackfillSelected = async (symbols: string[]) => {
    setSelectedGapBusy(true)
    setSelectedGapMsg(null)
    setSelectedGapOk(null)
    try {
      const res = await postSepaPriceGapBackfill(symbols)
      if (!res.ok) {
        setSelectedGapMsg(res.error ?? 'Backfill failed')
        setSelectedGapOk(false)
        return
      }
      if (res.message) {
        setSelectedGapMsg(res.message)
        setSelectedGapOk(true)
        return
      }
      const gapCount = res.gap_count ?? 0
      const chunks = res.chunks ?? 0
      setSelectedGapMsg(`Dispatched ${fmt(chunks)} tasks for ${fmt(gapCount)} selected symbols.`)
      setSelectedGapOk(true)
      if (res.job_ids && res.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: res.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setSelectedGapMsg(e instanceof Error ? e.message : 'Backfill failed')
      setSelectedGapOk(false)
    } finally {
      setSelectedGapBusy(false)
    }
  }

  const runFixGaps = async () => {
    setFixGapsBusy(true)
    setFixGapsMsg(null)
    setFixGapsOk(null)
    try {
      const backfill = await postSepaPriceGapBackfill()
      if (!backfill.ok) {
        setFixGapsMsg(backfill.error ?? 'Backfill failed')
        setFixGapsOk(false)
        return
      }
      const gapCount = backfill.gap_count ?? 0
      const chunks = backfill.chunks ?? 0
      if (gapCount === 0) {
        // No gaps — just refresh snapshot
        const snap = await postSepaReadinessSnapshot()
        if (!snap.ok) {
          setFixGapsMsg(snap.error ?? 'Snapshot refresh failed')
          setFixGapsOk(false)
          return
        }
        setFixGapsMsg(`No gaps found. Snapshot refreshed: ${fmt(snap.rows_affected)} rows.`)
        setFixGapsOk(true)
        await loadSummary()
        return
      }
      setFixGapsMsg(
        `Dispatched ${fmt(chunks)} backfill tasks for ${fmt(gapCount)} symbols. Re-run snapshot after bars complete.`,
      )
      setFixGapsOk(true)
      if (backfill.job_ids && backfill.job_ids.length > 0) {
        refJobSession.trackStockOhlcSyncJob({ job_id: backfill.job_ids[0] })
      } else {
        refJobSession.openJobsSheet()
      }
    } catch (e) {
      setFixGapsMsg(e instanceof Error ? e.message : 'Fix gaps failed')
      setFixGapsOk(false)
    } finally {
      setFixGapsBusy(false)
    }
  }

  const runEvaluateAndPublish = async () => {
    setEvalPublishBusy(true)
    setEvalPublishPhase('backfill')
    setFundBackfillMsg(null)
    setFundBackfillOk(null)
    setSnapshotMsg(null)
    setSnapshotOk(null)
    try {
      // Phase 1: Evaluate fundamentals
      const fundRes = await postSepaFundamentalsBackfill({ max_workers: 4, rate_limit_rps: 4.0 })
      if (!fundRes.ok) {
        setFundBackfillMsg(fundRes.error ?? 'Fundamentals backfill failed')
        setFundBackfillOk(false)
        return
      }
      setFundBackfillMsg(
        fundRes.gap_count === 0
          ? (fundRes.message ?? 'All symbols already have valid fundamentals cache.')
          : (fundRes.message ?? `Phase4 job submitted for ${fmt(fundRes.gap_count)} symbols.`),
      )
      setFundBackfillOk(true)

      // Phase 2: Refresh snapshot
      setEvalPublishPhase('snapshot')
      const snapRes = await postSepaReadinessSnapshot()
      if (!snapRes.ok) {
        setSnapshotMsg(snapRes.error ?? 'Snapshot failed')
        setSnapshotOk(false)
        return
      }
      setSnapshotMsg(`rows_affected=${fmt(snapRes.rows_affected)}  elapsed=${fmt(snapRes.elapsed_ms)}ms`)
      setSnapshotOk(true)
      await loadSummary()
      void loadCriteriaStats()
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Evaluate & publish failed'
      setSnapshotMsg(msg)
      setSnapshotOk(false)
    } finally {
      setEvalPublishBusy(false)
      setEvalPublishPhase('idle')
    }
  }

  const finPostForKind = (
    kind: FinDrawerKind,
  ): ((symbols?: string[]) => Promise<SepaFinancialsBackfillResponse>) | null => {
    switch (kind) {
      case 'income':
        return postSepaIncomeStatementsBackfill
      case 'balance':
        return postSepaBalanceSheetsBackfill
      case 'cash':
        return postSepaCashFlowsBackfill
      case 'ratios':
        return postSepaRatiosBackfill
      case 'sint':
        return postSepaShortInterestBackfill
      case 'svol':
        return postSepaShortVolumeBackfill
      default:
        return null
    }
  }

  const runFinBackfillAllForKind = async (kind: FinDrawerKind) => {
    const post = finPostForKind(kind)
    if (!post) return
    setFinAllBusy(true)
    setFinAllMsg(null)
    setFinAllOk(null)
    setFinSelMsg(null)
    setFinSelOk(null)
    try {
      const res = await post()
      if (!res.ok) {
        setFinAllMsg(res.error ?? 'Backfill failed')
        setFinAllOk(false)
        return
      }
      if (res.message) {
        setFinAllMsg(res.message)
        setFinAllOk(true)
        await loadSummary()
        return
      }
      const gapCount = res.gap_count ?? 0
      const chunks = res.chunks ?? 0
      if (gapCount === 0) {
        setFinAllMsg('No gaps — coverage meets thresholds.')
        setFinAllOk(true)
        await loadSummary()
        return
      }
      setFinAllMsg(`Dispatched ${fmt(chunks)} tasks covering ${fmt(gapCount)} gap symbols.`)
      setFinAllOk(true)
      if (res.job_ids && res.job_ids.length > 0) {
        const trackedKind = finBackfillJobKindForDrawer(kind)
        for (const jid of res.job_ids) {
          refJobSession.trackMassiveDbJob({
            job_id: jid,
            kind: trackedKind,
            domain: 'financials',
          })
        }
      } else {
        refJobSession.openJobsSheet()
      }
      await loadSummary()
    } catch (e) {
      setFinAllMsg(e instanceof Error ? e.message : 'Backfill failed')
      setFinAllOk(false)
    } finally {
      setFinAllBusy(false)
    }
  }

  const runFinBackfillAll = async () => {
    if (!finDrawerKind) return
    await runFinBackfillAllForKind(finDrawerKind)
  }

  const runFinBackfillSelected = async (symbols: string[]) => {
    if (!finDrawerKind || symbols.length === 0) return
    const post = finPostForKind(finDrawerKind)
    if (!post) return
    setFinSelBusy(true)
    setFinSelMsg(null)
    setFinSelOk(null)
    try {
      const res = await post(symbols)
      if (!res.ok) {
        setFinSelMsg(res.error ?? 'Backfill failed')
        setFinSelOk(false)
        return
      }
      if (res.message) {
        setFinSelMsg(res.message)
        setFinSelOk(true)
        await loadSummary()
        return
      }
      const gapCount = res.gap_count ?? 0
      const chunks = res.chunks ?? 0
      setFinSelMsg(`Dispatched ${fmt(chunks)} tasks for ${fmt(gapCount)} selected symbols.`)
      setFinSelOk(true)
      if (res.job_ids && res.job_ids.length > 0) {
        const trackedKind = finBackfillJobKindForDrawer(finDrawerKind)
        for (const jid of res.job_ids) {
          refJobSession.trackMassiveDbJob({
            job_id: jid,
            kind: trackedKind,
            domain: 'financials',
          })
        }
      } else {
        refJobSession.openJobsSheet()
      }
      await loadSummary()
    } catch (e) {
      setFinSelMsg(e instanceof Error ? e.message : 'Backfill failed')
      setFinSelOk(false)
    } finally {
      setFinSelBusy(false)
    }
  }

  const finDrawerFetch = useCallback((): Promise<SepaFinancialsGapsResponse> => {
    switch (finDrawerKind) {
      case 'income':
        return fetchSepaIncomeStatementsGaps()
      case 'balance':
        return fetchSepaBalanceSheetsGaps()
      case 'cash':
        return fetchSepaCashFlowsGaps()
      case 'ratios':
        return fetchSepaRatiosGaps()
      case 'sint':
        return fetchSepaShortInterestGaps()
      case 'svol':
        return fetchSepaShortVolumeGaps()
      default:
        return Promise.resolve({ ok: false, error: 'No drawer' })
    }
  }, [finDrawerKind])

  const universeBusy = refJobSession.jobBusyKind === 'feed_stocks_tickers_reference_universe'
  const anyJobBusy = refJobSession.jobBusyKind != null
  const activeJobCount = refJobSession.activeJobCount

  const live = summary?.price_readiness_live
  const snap = summary?.snapshot_today
  const snapshotEmpty = summary?.snapshot_populated === false

  // Step check statuses
  const universeCount = summary?.universe_count ?? 0
  const tickersActive = summary?.tickers_active_count ?? 0
  const priceReady = live?.price_ready ?? 0
  const totalSymbols = live?.total_symbols ?? 0
  const vendorFillGap = summary?.stock_day_vendor_fill_gap_count
  const priceGap =
    vendorFillGap != null
      ? vendorFillGap
      : totalSymbols > 0
        ? totalSymbols - priceReady
        : null
  const notesCount = (summary?.notes_breakdown ?? []).reduce((s, r) => s + r.count, 0)

  const step1Status: CheckStatus = summaryLoading
    ? 'loading'
    : universeCount > 5000
    ? 'ok'
    : universeCount > 100
    ? 'warn'
    : summary
    ? 'error'
    : 'unknown'

  const holidaysSummary = summary?.holidays_summary
  const holidaysTotal = holidaysSummary?.total ?? 0
  const holidaysMassive = holidaysSummary?.massive_count ?? 0
  const holidaysSeed = holidaysSummary?.seed_count ?? 0
  const holidaysEarlyClose = holidaysSummary?.early_close_count ?? 0
  const holidaysLastSync = holidaysSummary?.last_massive_sync ?? null
  const holidaysLatest = holidaysSummary?.latest_date ?? null
  const holidaysEarliest = holidaysSummary?.earliest_date ?? null
  const holidaysStatus: CheckStatus = summaryLoading
    ? 'loading'
    : holidaysTotal >= 100
    ? 'ok'
    : holidaysTotal > 0
    ? 'warn'
    : summary
    ? 'error'
    : 'unknown'

  const unifiedSnapRows = summary?.stock_unified_snapshot_row_count
  const unifiedSnapStatus: CheckStatus = summaryLoading
    ? 'loading'
    : unifiedSnapRows != null && unifiedSnapRows > 0
    ? 'ok'
    : summary && universeCount > 0
    ? 'warn'
    : 'unknown'

  const barStepStatus: CheckStatus = summaryLoading
    ? 'loading'
    : priceGap === 0
    ? 'ok'
    : priceGap != null && priceGap < 500
    ? 'warn'
    : priceGap != null
    ? 'error'
    : 'unknown'

  const matSnapshotStepStatus: CheckStatus = summaryLoading
    ? 'loading'
    : summary?.snapshot_populated === true
    ? 'ok'
    : summary
    ? 'error'
    : 'unknown'

  const incomeGap = summary?.income_statements_gap_count
  const balanceGap = summary?.balance_sheets_gap_count
  const cashGap = summary?.cash_flows_gap_count
  const ratiosGap = summary?.ratios_gap_count
  const shortIntGap = summary?.short_interest_gap_count
  const shortVolGap = summary?.short_volume_gap_count

  const incomeActionable = summary?.income_statements_actionable_gap_count
  const balanceActionable = summary?.balance_sheets_actionable_gap_count
  const cashActionable = summary?.cash_flows_actionable_gap_count
  const ratiosActionable = summary?.ratios_actionable_gap_count
  const shortIntActionable = summary?.short_interest_actionable_gap_count
  const shortVolActionable = summary?.short_volume_actionable_gap_count

  const incomeAcked = summary?.income_statements_acked_gap_count
  const balanceAcked = summary?.balance_sheets_acked_gap_count
  const cashAcked = summary?.cash_flows_acked_gap_count
  const ratiosAcked = summary?.ratios_acked_gap_count
  const shortIntAcked = summary?.short_interest_acked_gap_count
  const shortVolAcked = summary?.short_volume_acked_gap_count

  const incomeFinStatus = gapCountCheckStatusWithVoid(summaryLoading, incomeActionable, summary?.income_statements_source_void)
  const balanceFinStatus = gapCountCheckStatusWithVoid(summaryLoading, balanceActionable, summary?.balance_sheets_source_void)
  const cashFinStatus = gapCountCheckStatusWithVoid(summaryLoading, cashActionable, summary?.cash_flows_source_void)
  const ratiosFinStatus = gapCountCheckStatusWithVoid(summaryLoading, ratiosActionable, summary?.ratios_source_void)
  const shortIntFinStatus = gapCountCheckStatusWithVoid(summaryLoading, shortIntActionable, summary?.short_interest_source_void)
  const shortVolFinStatus = gapCountCheckStatusWithVoid(summaryLoading, shortVolActionable, summary?.short_volume_source_void)

  const reviewStepStatus: CheckStatus = summaryLoading
    ? 'loading'
    : notesCount === 0 && summary?.snapshot_populated
    ? 'ok'
    : notesCount > 0
    ? (notesCount > 500 ? 'error' : 'warn')
    : 'unknown'

  const step1Done = universeCount > 0
  const unifiedSnapDone = (unifiedSnapRows ?? 0) > 0
  const barStepDone = (live?.total_symbols ?? 0) > 0
  const matSnapshotStepDone = summary?.snapshot_populated === true

  const fundCacheValid = summary?.fund_cache_valid_count ?? 0
  const fundCacheViewExists = summary?.fund_cache_view_exists
  const fundStepStatus: CheckStatus = summaryLoading
    ? 'loading'
    : fundCacheViewExists === false
    ? 'error'
    : fundCacheValid > 0 && universeCount > 0 && (fundCacheValid / universeCount) >= 0.5
    ? 'ok'
    : fundCacheValid > 0
    ? 'warn'
    : summary
    ? 'error'
    : 'unknown'
  const fundStepDone = fundCacheValid > 0

  const runbookSteps: Array<{
    id: SepaRunStep
    title: string
    short: string
    status: CheckStatus
    done: boolean
    metric: string
  }> = [
    {
      id: 1,
      title: 'Universe + holidays',
      short: 'Reference data',
      status: step1Status === 'ok' && holidaysStatus === 'ok'
        ? 'ok'
        : step1Status === 'error' || holidaysStatus === 'error'
        ? 'error'
        : step1Status === 'loading' || holidaysStatus === 'loading'
        ? 'loading'
        : step1Status === 'warn' || holidaysStatus === 'warn'
        ? 'warn'
        : 'unknown',
      done: step1Done && holidaysTotal > 0,
      metric: `${fmt(universeCount)} symbols`,
    },
    {
      id: 2,
      title: 'Unified snapshots',
      short: 'Massive baseline',
      status: unifiedSnapStatus,
      done: unifiedSnapDone,
      metric: unifiedSnapRows != null ? `${fmt(unifiedSnapRows)} rows` : 'not loaded',
    },
    {
      id: 3,
      title: 'Stock day bars',
      short: 'Daily fill',
      status: barStepStatus,
      done: barStepStatus === 'ok',
      metric: priceGap != null ? `${fmt(priceGap)} gaps` : 'unchecked',
    },
    {
      id: 4,
      title: 'Income statements',
      short: 'PG ingest',
      status: incomeFinStatus,
      done: finGapOk(incomeGap) || (incomeFinStatus === 'void' && (incomeActionable ?? 0) === 0),
      metric: incomeFinStatus === 'void'
        ? ((incomeActionable ?? 0) > 0 ? `${fmt(incomeActionable)} / ${fmt(incomeAcked)} acked` : `N/A (${fmt(incomeAcked)} acked)`)
        : incomeGap != null ? `${fmt(incomeGap)} gaps` : '—',
    },
    {
      id: 5,
      title: 'Balance sheets',
      short: 'PG ingest',
      status: balanceFinStatus,
      done: finGapOk(balanceGap) || (balanceFinStatus === 'void' && (balanceActionable ?? 0) === 0),
      metric: balanceFinStatus === 'void'
        ? ((balanceActionable ?? 0) > 0 ? `${fmt(balanceActionable)} / ${fmt(balanceAcked)} acked` : `N/A (${fmt(balanceAcked)} acked)`)
        : balanceGap != null ? `${fmt(balanceGap)} gaps` : '—',
    },
    {
      id: 6,
      title: 'Cash flows',
      short: 'PG ingest',
      status: cashFinStatus,
      done: finGapOk(cashGap) || (cashFinStatus === 'void' && (cashActionable ?? 0) === 0),
      metric: cashFinStatus === 'void'
        ? ((cashActionable ?? 0) > 0 ? `${fmt(cashActionable)} / ${fmt(cashAcked)} acked` : `N/A (${fmt(cashAcked)} acked)`)
        : cashGap != null ? `${fmt(cashGap)} gaps` : '—',
    },
    {
      id: 7,
      title: 'Ratios',
      short: 'PG ingest',
      status: ratiosFinStatus,
      done: finGapOk(ratiosGap) || (ratiosFinStatus === 'void' && (ratiosActionable ?? 0) === 0),
      metric: ratiosFinStatus === 'void'
        ? ((ratiosActionable ?? 0) > 0 ? `${fmt(ratiosActionable)} / ${fmt(ratiosAcked)} acked` : `N/A (${fmt(ratiosAcked)} acked)`)
        : ratiosGap != null ? `${fmt(ratiosGap)} gaps` : '—',
    },
    {
      id: 8,
      title: 'Short interest',
      short: 'PG ingest',
      status: shortIntFinStatus,
      done: finGapOk(shortIntGap) || (shortIntFinStatus === 'void' && (shortIntActionable ?? 0) === 0),
      metric: shortIntFinStatus === 'void'
        ? ((shortIntActionable ?? 0) > 0 ? `${fmt(shortIntActionable)} / ${fmt(shortIntAcked)} acked` : `N/A (${fmt(shortIntAcked)} acked)`)
        : shortIntGap != null ? `${fmt(shortIntGap)} gaps` : '—',
    },
    {
      id: 9,
      title: 'Short volume',
      short: 'PG ingest',
      status: shortVolFinStatus,
      done: finGapOk(shortVolGap) || (shortVolFinStatus === 'void' && (shortVolActionable ?? 0) === 0),
      metric: shortVolFinStatus === 'void'
        ? ((shortVolActionable ?? 0) > 0 ? `${fmt(shortVolActionable)} / ${fmt(shortVolAcked)} acked` : `N/A (${fmt(shortVolAcked)} acked)`)
        : shortVolGap != null ? `${fmt(shortVolGap)} gaps` : '—',
    },
    {
      id: 10,
      title: 'Evaluate & publish',
      short: 'Fund + Snapshot',
      status: (
        (fundStepStatus === 'error' || matSnapshotStepStatus === 'error') ? 'error'
        : (fundStepStatus === 'loading' || matSnapshotStepStatus === 'loading') ? 'loading'
        : (fundStepStatus === 'warn' || (matSnapshotStepStatus as string) === 'warn') ? 'warn'
        : (fundStepStatus === 'ok' && matSnapshotStepStatus === 'ok') ? 'ok'
        : 'unknown'
      ) as CheckStatus,
      done: fundStepDone && matSnapshotStepDone,
      metric: matSnapshotStepDone
        ? `${fmt(snap?.rows_total)} rows · ${fmt(fundCacheValid)} cached`
        : fundCacheValid > 0 ? `${fmt(fundCacheValid)} cached` : 'not run',
    },
  ]

  const runbookStages = RUNBOOK_STAGE_LAYOUT.map((meta) => {
    const steps = meta.stepIds
      .map((id) => runbookSteps.find((s) => s.id === id))
      .filter((s): s is (typeof runbookSteps)[number] => s != null)
    const stageStatus = foldStageStatus(steps.map((s) => s.status))
    const doneCount = steps.filter((s) => s.done).length
    const containsActive = steps.some((s) => s.id === activeRunStep)
    return {
      ...meta,
      steps,
      stageStatus,
      doneCount,
      stageDone: doneCount === steps.length && steps.length > 0,
      containsActive,
    }
  })

  const snapshotByTypeRows = summary?.stock_unified_snapshot_by_type ?? []
  const snapshotByTypeMap = new Map(snapshotByTypeRows.map((r) => [r.code, r]))
  const fundamentalsByTypeRows = summary?.fundamentals_symbol_count_by_type ?? []
  const fundamentalsByTypeMap = new Map(fundamentalsByTypeRows.map((r) => [r.code, r]))
  const knownCodes = new Set(INSTRUMENT_TYPE_DATA_SUPPORT_ROWS.map((r) => r.code))
  const extraSnapshotRows = snapshotByTypeRows
    .filter((r) => !knownCodes.has(r.code))
    .map((r) => ({
      code: r.code,
      description: r.description ?? '—',
      incomeStatements: 'unknown' as DataSupportLevel,
      balanceSheets: 'unknown' as DataSupportLevel,
      cashFlows: 'unknown' as DataSupportLevel,
      ratios: 'unknown' as DataSupportLevel,
      note: 'Observed in unified snapshot; support matrix not yet classified.',
    }))
  const supportRows = [...INSTRUMENT_TYPE_DATA_SUPPORT_ROWS, ...extraSnapshotRows]

  return (
    <div className="card process-section sepa-data-ready-page wl2">
      <div className="research-page-head">
        <SectionPageTitle
          menu="Research"
          pageTitle={breadcrumbLabel}
          onMenuClick={onBreadcrumbResearch}
          menuNavigateAriaLabel="Go to Research home"
          infoText="Validate PostgreSQL ticker universe and stock_day coverage before full-market SEPA Phase4 runs."
          style={{ margin: 0 }}
        />
      </div>

      {/* ── Step Actions Panel ─────────────────────────────────────────── */}
      <div className="sdp-actions-card">
        <div className="sdp-runbook-actions-head">
          <div className="sdp-actions-title">Run book</div>
          <button
            type="button"
            className="sdp-btn-check sdp-btn-check--sky"
            onClick={() => void handleRunbookReadinessCheck()}
            disabled={summaryLoading}
            title="Refresh readiness summary for all run book steps"
          >
            {summaryLoading ? 'Checking…' : 'Check Data Coverage'}
          </button>
        </div>

        <div className="sdp-runbook-layout">
        <div className="sdp-runbook-main">
        <div className="sdp-runbook-stageflow" role="region" aria-label="Stock Data Readiness run book">
          {runbookStages.map((stage, stageIdx) => (
            <div
              key={stage.id}
              className={[
                'sdp-runbook-stage',
                stage.containsActive ? 'sdp-runbook-stage--open' : '',
                stage.stageDone ? 'sdp-runbook-stage--done' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <div className={`sdp-runbook-stage-head sdp-runbook-stage-head--${stage.stageStatus}`}>
                <div className="sdp-runbook-stage-head-top">
                  <span className="sdp-runbook-stage-kicker">Stage {stageIdx + 1}</span>
                  <span className={`sdp-check-dot sdp-check-dot--${stage.stageStatus}`} aria-hidden="true" />
                </div>
                <div className="sdp-runbook-stage-title">{stage.title}</div>
                <div className="sdp-runbook-stage-blurb">{stage.blurb}</div>
                <div className="sdp-runbook-stage-progress" aria-label={`${stage.doneCount} of ${stage.steps.length} steps complete`}>
                  {stage.doneCount}/{stage.steps.length} complete
                </div>
              </div>
              <div className="sdp-runbook-stage-steps" role="tablist" aria-label={`${stage.title} steps`}>
                {stage.steps.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="tab"
                    aria-selected={activeRunStep === s.id}
                    aria-controls={`sepa-runbook-step-${s.id}`}
                    className={[
                      'sdp-runbook-tab',
                      'sdp-runbook-tab--nested',
                      activeRunStep === s.id ? 'sdp-runbook-tab--active' : '',
                      s.done ? 'sdp-runbook-tab--done' : '',
                      `sdp-runbook-tab--${s.status}`,
                    ].filter(Boolean).join(' ')}
                    onClick={() => setActiveRunStep(s.id)}
                  >
                    <span className="sdp-runbook-tab-index">{s.id}</span>
                    <span className="sdp-runbook-tab-text">
                      <span className="sdp-runbook-tab-title">{s.title}</span>
                      <span className="sdp-runbook-tab-sub">{s.short} · {s.metric}</span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="sdp-step-list sdp-step-list--panel">

          {/* Step 1 — Tickers Universe + Market Holidays */}
          <div
            id="sepa-runbook-step-1"
            role="tabpanel"
            className={`sdp-step ${step1Done ? 'sdp-step--done' : ''} ${activeRunStep === 1 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">1</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Sync All Tickers + Market Holidays into{' '}
                <code>public.tickers</code> &amp; <code>public.reference_us_holidays</code>
              </div>

              <div className="sdp-step-twin-grid">
                {/* Tickers track */}
                <div className="sdp-step-twin-card">
                  <div className="sdp-step-twin-title">
                    <span className="sdp-step-twin-tag sdp-step-twin-tag--tickers">TICKERS</span>
                    <code>public.tickers</code>
                  </div>
                  <p className="sdp-step-desc">
                    Reference universe from Massive REST{' '}
                    <code>/v3/reference/tickers</code>. Celery queue{' '}
                    <code>stocks_massive</code>.
                  </p>
                </div>

                {/* Holidays track */}
                <div className="sdp-step-twin-card">
                  <div className="sdp-step-twin-title">
                    <span className="sdp-step-twin-tag sdp-step-twin-tag--holidays">HOLIDAYS</span>
                    <code>public.reference_us_holidays</code>
                  </div>
                  <p className="sdp-step-desc">
                    Seeds NYSE/NASDAQ federal closures 2020-2027, then pulls{' '}
                    <code>/v1/marketstatus/upcoming</code> for early-close timing.
                    Used by K-line gap detection to skip closed days.
                  </p>
                </div>
              </div>

              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runUniverseEnqueue()}
                  disabled={anyJobBusy || holidaysSyncBusy}
                  title="Enqueue ticker universe sync (Celery) and run Massive holidays sync in parallel"
                >
                  {universeBusy
                    ? 'Enqueueing tickers…'
                    : holidaysSyncBusy
                    ? 'Syncing both…'
                    : 'Sync tickers + holidays'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-secondary"
                  onClick={() => void runHolidaysSync()}
                  disabled={holidaysSyncBusy}
                  title="Pull NYSE/NASDAQ holidays from Massive REST + apply embedded seed"
                >
                  {holidaysSyncBusy ? 'Syncing…' : 'Holidays only'}
                </button>
                {activeJobCount > 0 && (
                  <span className="ref-jobs-active-pill" aria-live="polite">
                    {activeJobCount} active
                  </span>
                )}
                <button
                  type="button"
                  className="sdp-btn-secondary"
                  onClick={() => refJobSession.openJobsSheet()}
                >
                  Jobs
                </button>
                {onOpenCelerySettings && (
                  <button type="button" className="sdp-btn-ghost" onClick={onOpenCelerySettings}>
                    Celery settings
                  </button>
                )}
              </div>
              {holidaysSyncMsg != null && (
                <div className={`sdp-feedback sdp-msg--${holidaysSyncOk ? 'ok' : 'err'}`}>
                  {holidaysSyncMsg}
                  {holidaysSyncResult?.total_in_table != null && holidaysSyncOk && (
                    <span className="sdp-check-secondary" style={{ marginLeft: 'var(--space-2)' }}>
                      total in table: {fmt(holidaysSyncResult.total_in_table)}
                    </span>
                  )}
                  {holidaysSyncResult?.massive_error && holidaysSyncOk && (
                    <span className="sdp-check-secondary" style={{ marginLeft: 'var(--space-2)', color: 'var(--color-warn)' }}>
                      Massive: {holidaysSyncResult.massive_error}
                    </span>
                  )}
                  {holidaysSyncResult?.synced_at && holidaysSyncOk && (
                    <span className="sdp-check-secondary" style={{ marginLeft: 'var(--space-2)' }}>
                      at {new Date(holidaysSyncResult.synced_at).toLocaleString()}
                    </span>
                  )}
                </div>
              )}
              {universeErr != null && (
                <div className="sdp-feedback sdp-msg--err">{universeErr}</div>
              )}
            </div>
          </div>

          {/* Step 2 — Massive unified stock snapshot baseline (before stock_day backfill) */}
          <div
            id="sepa-runbook-step-2"
            role="tabpanel"
            className={`sdp-step ${unifiedSnapDone ? 'sdp-step--done' : ''} ${activeRunStep === 2 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">2</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Refresh <code>public.cache_stock_snapshot</code> (Massive <code>GET /v3/snapshot</code>, stocks)
              </div>
              <p className="sdp-step-desc">
                Batches all <code>v_us_equity_universe</code> symbols via <code>ticker.any_of</code> (≤250 per
                request). Flattens Massive <code>session</code>, <code>last_minute</code>, and optional{' '}
                <code>last_trade</code> / <code>last_quote</code> into scalar columns (no jsonb) for SQL joins.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runUnifiedStockSnapshot()}
                  disabled={unifiedSnapBusy || anyJobBusy}
                >
                  {unifiedSnapBusy ? 'Refreshing…' : 'Refresh unified snapshots'}
                </button>
              </div>
              {unifiedSnapMsg != null && (
                <div className={`sdp-feedback sdp-msg--${unifiedSnapOk ? 'ok' : 'err'}`}>{unifiedSnapMsg}</div>
              )}

              <SnapshotByTypeBreakdown rows={summary?.stock_unified_snapshot_by_type ?? null} />
            </div>
          </div>

          {/* Step 3 — Stock Day Bars */}
          <div
            id="sepa-runbook-step-3"
            role="tabpanel"
            className={`sdp-step ${barStepDone ? 'sdp-step--done' : ''} ${activeRunStep === 3 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">3</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">Backfill <code>public.stock_day</code> bars</div>

              {/* Daily maintenance explanation */}
              <div className="sdp-maintenance-box">
                <div className="sdp-maintenance-box-title">Daily maintenance strategy</div>
                <div className="sdp-maintenance-row">
                  <span className="sdp-maintenance-badge sdp-maintenance-badge--auto">AUTO</span>
                  <span className="sdp-maintenance-text">
                    Beat task <code>massive-sepa-universe-grouped-daily</code> runs nightly at 22:00 UTC —
                    one <strong>Grouped Daily Bars</strong> API call covers all 5,000+ US stocks for today's date
                    (vs. 5,000+ calls for per-symbol approach).
                  </span>
                </div>
                <div className="sdp-maintenance-row">
                  <span className="sdp-maintenance-badge sdp-maintenance-badge--manual">MANUAL</span>
                  <span className="sdp-maintenance-text">
                    <em>Backfill 420d History</em> below queues one job per missing trading date.
                    Each job = 1 API call → OHLCV for all US stocks on that date.
                    Efficient initial setup: ~420 API calls total.
                  </span>
                </div>
              </div>

              <p className="sdp-step-desc">
                Celery <code>feed_stocks_aggregate</code> writes <code>source=massive</code> rows. The readiness summary
                gap count uses <code>cache_stock_snapshot.last_minute_updated</code> (America/New_York date) vs{' '}
                <code>max(stock_day.bar_time)</code>;                 any snapshot-based check requires non-null <code>session_close</code> — if it is empty, that symbol is
                skipped for Step 3 gaps (no <code>stock_day</code> comparison and no readiness fallback), regardless of
                whether daily bars exist. After a calendar gap, the latest daily <code>stock_day.close</code> must differ
                from <code>session_close</code> (beyond a tiny absolute tolerance) to count as a vendor gap — matching
                closes mean the vendor snapshot already aligns with the last ingested bar.{' '}
                <code>tickers.instrument_type = WARRANT</code> symbols are excluded. Symbols with **no**{' '}
                <code>cache_stock_snapshot</code> row are never gaps. If a snapshot row has <code>session_close</code>{' '}
                but <code>last_minute_updated</code> is missing, the UI falls back to <code>NOT price_ready</code> on the
                readiness view.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runGroupedHistoryBackfill()}
                  disabled={groupedHistoryBusy}
                >
                  {groupedHistoryBusy ? 'Queuing jobs…' : 'Backfill 420d History (Grouped Daily)'}
                </button>
                <button
                  type="button"
                  className="sdp-btn-secondary"
                  onClick={() => refJobSession.openJobsSheet()}
                >
                  Jobs
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${barStepStatus === 'ok' ? ' sdp-btn-gaps--ok' : priceGap != null && priceGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => setGapsDrawerOpen(true)}
                  disabled={barStepStatus === 'ok' || !checkedSteps.has(3)}
                  title="View per-symbol gap details and LLM-ready report"
                >
                  {barStepStatus === 'ok'
                    ? '✓ All price_ready'
                    : priceGap != null && priceGap > 0
                    ? `Gaps (${fmt(priceGap)}) →`
                    : 'View gaps →'}
                </button>
                {onOpenFeedMassiveStock && (
                  <button type="button" className="sdp-btn-ghost" onClick={onOpenFeedMassiveStock}>
                    Open Feed Massive Stock →
                  </button>
                )}
              </div>
              {groupedHistoryMsg != null && (
                <div className={`sdp-feedback sdp-msg--${groupedHistoryOk ? 'ok' : 'err'}`}>{groupedHistoryMsg}</div>
              )}
              {priceGapMsg != null && (
                <div className={`sdp-feedback sdp-msg--${priceGapOk ? 'ok' : 'err'}`}>{priceGapMsg}</div>
              )}
            </div>
          </div>

          {/* Step 4 — Income statements */}
          <div
            id="sepa-runbook-step-4"
            role="tabpanel"
            className={`sdp-step ${finGapOk(incomeGap) ? 'sdp-step--done' : 'sdp-step--active'} ${activeRunStep === 4 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">4</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Ingest <code>stock_income_statements</code>
              </div>
              <p className="sdp-step-desc">
                Massive <code>GET /stocks/financials/v1/income-statements</code> → PostgreSQL. Quarterly + annual rows
                power Step 10 fundamentals evaluation when present. Gap checks/backfill scope: instrument types with
                Supported or Partial coverage in Instrument Type Data Support (<code>{FIN_STMT_GAP_INSTRUMENT_CODES.join(', ')}</code>).
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runFinBackfillAllForKind('income')}
                  disabled={finAllBusy}
                >
                  {finAllBusy ? 'Enqueueing…' : 'Backfill all gaps'}
                </button>
                <button type="button" className="sdp-btn-secondary" onClick={() => refJobSession.openJobsSheet()}>
                  Jobs
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${incomeFinStatus === 'ok' ? ' sdp-btn-gaps--ok' : (incomeFinStatus === 'void' && (incomeActionable ?? 0) === 0) ? ' sdp-btn-gaps--void' : incomeGap != null && incomeGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => {
                    setFinDrawerKind('income')
                    setFinAllMsg(null)
                    setFinSelMsg(null)
                  }}
                  disabled={incomeFinStatus === 'ok' || (incomeFinStatus === 'void' && (incomeActionable ?? 0) === 0) || !checkedSteps.has(4)}
                  title="View per-symbol gap details"
                >
                  {incomeFinStatus === 'ok'
                    ? '✓ No gaps'
                    : incomeFinStatus === 'void' && (incomeActionable ?? 0) === 0
                    ? `Source N/A (${fmt(incomeAcked)} acked)`
                    : incomeFinStatus === 'void' && (incomeActionable ?? 0) > 0
                    ? `${fmt(incomeActionable)} actionable →`
                    : incomeGap != null && incomeGap > 0
                    ? `Gaps (${fmt(incomeGap)}) →`
                    : 'View gaps →'}
                </button>
                <button
                  type="button"
                  className={`sdp-btn-void-toggle${summary?.income_statements_source_void ? ' sdp-btn-void-toggle--active' : ''}`}
                  onClick={() => void handleToggleVoid('income_statements', !summary?.income_statements_source_void, incomeGap ?? 0)}
                  disabled={voidAckBusy === 'income_statements'}
                  title={summary?.income_statements_source_void ? 'Unmark: source actually provides this data' : `Mark as Source N/A: acknowledge ${fmt(incomeGap)} gaps as Massive data void baseline`}
                >
                  {voidAckBusy === 'income_statements' ? '…' : summary?.income_statements_source_void ? 'Unmark N/A' : 'Source N/A'}
                </button>
                {summary?.income_statements_source_void && (incomeActionable ?? 0) > 0 && (
                  <button
                    type="button"
                    className="sdp-btn-reack"
                    onClick={() => void handleToggleVoid('income_statements', true, incomeGap ?? 0)}
                    disabled={voidAckBusy === 'income_statements'}
                    title={`Update baseline to current ${fmt(incomeGap)} gaps (was ${fmt(incomeAcked)})`}
                  >
                    {voidAckBusy === 'income_statements' ? '…' : `Re-ack (${fmt(incomeActionable)} new)`}
                  </button>
                )}
              </div>
              {voidAckMsg && voidAckBusy === null && (
                <p className="sdp-step-hint sdp-text-danger">{voidAckMsg}</p>
              )}
              <p className="sdp-step-hint sdp-text-dim">
                {summary?.income_statements_source_void && (incomeActionable ?? 0) === 0
                  ? <>Source N/A · <strong>{fmt(incomeAcked)}</strong> gaps acknowledged as Massive data void (baseline). New gaps above baseline will appear here.</>
                  : summary?.income_statements_source_void && (incomeActionable ?? 0) > 0
                  ? <><strong className="sdp-text-warn">{fmt(incomeActionable)} actionable</strong> gaps above {fmt(incomeAcked)}-gap baseline · click <strong>Re-ack</strong> to update baseline or <strong>Gaps</strong> to review.</>
                  : <>Open <strong>Gaps</strong> for per-symbol details, copy report, or backfill selected symbols.</>
                }
              </p>
            </div>
          </div>

          {/* Step 5 — Balance sheets */}
          <div
            id="sepa-runbook-step-5"
            role="tabpanel"
            className={`sdp-step ${finGapOk(balanceGap) ? 'sdp-step--done' : ''} ${activeRunStep === 5 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">5</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Ingest <code>stock_balance_sheets</code>
              </div>
              <p className="sdp-step-desc">
                <code>GET /stocks/financials/v1/balance-sheets</code> — quarterly coverage and total_assets fill rate.
                Same Supported/Partial gap scope as Step 4: <code>{FIN_STMT_GAP_INSTRUMENT_CODES.join(', ')}</code>.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runFinBackfillAllForKind('balance')}
                  disabled={finAllBusy}
                >
                  {finAllBusy ? 'Enqueueing…' : 'Backfill all gaps'}
                </button>
                <button type="button" className="sdp-btn-secondary" onClick={() => refJobSession.openJobsSheet()}>
                  Jobs
                </button>
                <button
                  type="button"
                  className="sdp-btn-ghost"
                  onClick={() => {
                    setDataSupportChecked(true)
                    dataSupportSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }}
                  title="Jump to Instrument Type Data Support section"
                >
                  Data Support ↓
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${balanceFinStatus === 'ok' ? ' sdp-btn-gaps--ok' : (balanceFinStatus === 'void' && (balanceActionable ?? 0) === 0) ? ' sdp-btn-gaps--void' : balanceGap != null && balanceGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => {
                    setFinDrawerKind('balance')
                    setFinAllMsg(null)
                    setFinSelMsg(null)
                  }}
                  disabled={balanceFinStatus === 'ok' || (balanceFinStatus === 'void' && (balanceActionable ?? 0) === 0) || !checkedSteps.has(5)}
                >
                  {balanceFinStatus === 'ok' ? '✓ No gaps'
                    : balanceFinStatus === 'void' && (balanceActionable ?? 0) === 0 ? `Source N/A (${fmt(balanceAcked)} acked)`
                    : balanceFinStatus === 'void' && (balanceActionable ?? 0) > 0 ? `${fmt(balanceActionable)} actionable →`
                    : `Gaps (${fmt(balanceGap)}) →`}
                </button>
                <button
                  type="button"
                  className={`sdp-btn-void-toggle${summary?.balance_sheets_source_void ? ' sdp-btn-void-toggle--active' : ''}`}
                  onClick={() => void handleToggleVoid('balance_sheets', !summary?.balance_sheets_source_void, balanceGap ?? 0)}
                  disabled={voidAckBusy === 'balance_sheets'}
                  title={summary?.balance_sheets_source_void ? 'Unmark: source actually provides this data' : `Mark as Source N/A: acknowledge ${fmt(balanceGap)} gaps as baseline`}
                >
                  {voidAckBusy === 'balance_sheets' ? '…' : summary?.balance_sheets_source_void ? 'Unmark N/A' : 'Source N/A'}
                </button>
                {summary?.balance_sheets_source_void && (balanceActionable ?? 0) > 0 && (
                  <button
                    type="button"
                    className="sdp-btn-reack"
                    onClick={() => void handleToggleVoid('balance_sheets', true, balanceGap ?? 0)}
                    disabled={voidAckBusy === 'balance_sheets'}
                    title={`Update baseline to ${fmt(balanceGap)} (was ${fmt(balanceAcked)})`}
                  >
                    {voidAckBusy === 'balance_sheets' ? '…' : `Re-ack (${fmt(balanceActionable)} new)`}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Step 6 — Cash flows */}
          <div
            id="sepa-runbook-step-6"
            role="tabpanel"
            className={`sdp-step ${finGapOk(cashGap) ? 'sdp-step--done' : ''} ${activeRunStep === 6 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">6</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Ingest <code>stock_cash_flows</code>
              </div>
              <p className="sdp-step-desc">
                <code>GET /stocks/financials/v1/cash-flow-statements</code> — operating cash flow coverage. Same Supported/Partial gap
                scope as Step 4: <code>{FIN_STMT_GAP_INSTRUMENT_CODES.join(', ')}</code>.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runFinBackfillAllForKind('cash')}
                  disabled={finAllBusy}
                >
                  {finAllBusy ? 'Enqueueing…' : 'Backfill all gaps'}
                </button>
                <button type="button" className="sdp-btn-secondary" onClick={() => refJobSession.openJobsSheet()}>
                  Jobs
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${cashFinStatus === 'ok' ? ' sdp-btn-gaps--ok' : (cashFinStatus === 'void' && (cashActionable ?? 0) === 0) ? ' sdp-btn-gaps--void' : cashGap != null && cashGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => {
                    setFinDrawerKind('cash')
                    setFinAllMsg(null)
                    setFinSelMsg(null)
                  }}
                  disabled={cashFinStatus === 'ok' || (cashFinStatus === 'void' && (cashActionable ?? 0) === 0) || !checkedSteps.has(6)}
                >
                  {cashFinStatus === 'ok'
                    ? '✓ No gaps'
                    : cashFinStatus === 'void' && (cashActionable ?? 0) === 0 ? `Source N/A (${fmt(cashAcked)} acked)`
                    : cashFinStatus === 'void' && (cashActionable ?? 0) > 0 ? `${fmt(cashActionable)} actionable →`
                    : `Gaps (${fmt(cashGap)}) →`}
                </button>
                <button
                  type="button"
                  className={`sdp-btn-void-toggle${summary?.cash_flows_source_void ? ' sdp-btn-void-toggle--active' : ''}`}
                  onClick={() => void handleToggleVoid('cash_flows', !summary?.cash_flows_source_void, cashGap ?? 0)}
                  disabled={voidAckBusy === 'cash_flows'}
                  title={summary?.cash_flows_source_void ? 'Unmark: source actually provides this data' : `Mark as Source N/A: acknowledge ${fmt(cashGap)} gaps as baseline`}
                >
                  {voidAckBusy === 'cash_flows' ? '…' : summary?.cash_flows_source_void ? 'Unmark N/A' : 'Source N/A'}
                </button>
                {summary?.cash_flows_source_void && (cashActionable ?? 0) > 0 && (
                  <button
                    type="button"
                    className="sdp-btn-reack"
                    onClick={() => void handleToggleVoid('cash_flows', true, cashGap ?? 0)}
                    disabled={voidAckBusy === 'cash_flows'}
                    title={`Update baseline to ${fmt(cashGap)} (was ${fmt(cashAcked)})`}
                  >
                    {voidAckBusy === 'cash_flows' ? '…' : `Re-ack (${fmt(cashActionable)} new)`}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Step 7 — Ratios */}
          <div
            id="sepa-runbook-step-7"
            role="tabpanel"
            className={`sdp-step ${finGapOk(ratiosGap) ? 'sdp-step--done' : ''} ${activeRunStep === 7 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">7</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Ingest <code>stock_ratios</code>
              </div>
              <p className="sdp-step-desc">
                <code>GET /stocks/financials/v1/ratios</code> stores TTM ratio rows keyed by{' '}
                <code>date</code> (trading day). Legacy <code>/vX/reference/financials</code> ratio math is not written here.
                Supported/Partial gap scope as Step 4: <code>{FIN_STMT_GAP_INSTRUMENT_CODES.join(', ')}</code>.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runFinBackfillAllForKind('ratios')}
                  disabled={finAllBusy}
                >
                  {finAllBusy ? 'Enqueueing…' : 'Backfill all gaps'}
                </button>
                <button type="button" className="sdp-btn-secondary" onClick={() => refJobSession.openJobsSheet()}>
                  Jobs
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${ratiosFinStatus === 'ok' ? ' sdp-btn-gaps--ok' : (ratiosFinStatus === 'void' && (ratiosActionable ?? 0) === 0) ? ' sdp-btn-gaps--void' : ratiosGap != null && ratiosGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => {
                    setFinDrawerKind('ratios')
                    setFinAllMsg(null)
                    setFinSelMsg(null)
                  }}
                  disabled={ratiosFinStatus === 'ok' || (ratiosFinStatus === 'void' && (ratiosActionable ?? 0) === 0) || !checkedSteps.has(7)}
                >
                  {ratiosFinStatus === 'ok'
                    ? '✓ No gaps'
                    : ratiosFinStatus === 'void' && (ratiosActionable ?? 0) === 0 ? `Source N/A (${fmt(ratiosAcked)} acked)`
                    : ratiosFinStatus === 'void' && (ratiosActionable ?? 0) > 0 ? `${fmt(ratiosActionable)} actionable →`
                    : `Gaps (${fmt(ratiosGap)}) →`}
                </button>
                <button
                  type="button"
                  className={`sdp-btn-void-toggle${summary?.ratios_source_void ? ' sdp-btn-void-toggle--active' : ''}`}
                  onClick={() => void handleToggleVoid('ratios', !summary?.ratios_source_void, ratiosGap ?? 0)}
                  disabled={voidAckBusy === 'ratios'}
                  title={summary?.ratios_source_void ? 'Unmark: source actually provides this data' : `Mark as Source N/A: acknowledge ${fmt(ratiosGap)} gaps as baseline`}
                >
                  {voidAckBusy === 'ratios' ? '…' : summary?.ratios_source_void ? 'Unmark N/A' : 'Source N/A'}
                </button>
                {summary?.ratios_source_void && (ratiosActionable ?? 0) > 0 && (
                  <button
                    type="button"
                    className="sdp-btn-reack"
                    onClick={() => void handleToggleVoid('ratios', true, ratiosGap ?? 0)}
                    disabled={voidAckBusy === 'ratios'}
                    title={`Update baseline to ${fmt(ratiosGap)} (was ${fmt(ratiosAcked)})`}
                  >
                    {voidAckBusy === 'ratios' ? '…' : `Re-ack (${fmt(ratiosActionable)} new)`}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Step 8 — Short interest */}
          <div
            id="sepa-runbook-step-8"
            role="tabpanel"
            className={`sdp-step ${finGapOk(shortIntGap) ? 'sdp-step--done' : ''} ${activeRunStep === 8 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">8</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Ingest <code>stock_short_interest</code>
              </div>
              <p className="sdp-step-desc">
                <code>GET /stocks/v1/short-interest</code> — recent settlement dates per symbol.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runFinBackfillAllForKind('sint')}
                  disabled={finAllBusy}
                >
                  {finAllBusy ? 'Enqueueing…' : 'Backfill all gaps'}
                </button>
                <button type="button" className="sdp-btn-secondary" onClick={() => refJobSession.openJobsSheet()}>
                  Jobs
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${shortIntFinStatus === 'ok' ? ' sdp-btn-gaps--ok' : (shortIntFinStatus === 'void' && (shortIntActionable ?? 0) === 0) ? ' sdp-btn-gaps--void' : shortIntGap != null && shortIntGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => {
                    setFinDrawerKind('sint')
                    setFinAllMsg(null)
                    setFinSelMsg(null)
                  }}
                  disabled={shortIntFinStatus === 'ok' || (shortIntFinStatus === 'void' && (shortIntActionable ?? 0) === 0) || !checkedSteps.has(8)}
                >
                  {shortIntFinStatus === 'ok'
                    ? '✓ No gaps'
                    : shortIntFinStatus === 'void' && (shortIntActionable ?? 0) === 0 ? `Source N/A (${fmt(shortIntAcked)} acked)`
                    : shortIntFinStatus === 'void' && (shortIntActionable ?? 0) > 0 ? `${fmt(shortIntActionable)} actionable →`
                    : `Gaps (${fmt(shortIntGap)}) →`}
                </button>
                <button
                  type="button"
                  className={`sdp-btn-void-toggle${summary?.short_interest_source_void ? ' sdp-btn-void-toggle--active' : ''}`}
                  onClick={() => void handleToggleVoid('short_interest', !summary?.short_interest_source_void, shortIntGap ?? 0)}
                  disabled={voidAckBusy === 'short_interest'}
                  title={summary?.short_interest_source_void ? 'Unmark: source actually provides this data' : `Mark as Source N/A: acknowledge ${fmt(shortIntGap)} gaps as baseline`}
                >
                  {voidAckBusy === 'short_interest' ? '…' : summary?.short_interest_source_void ? 'Unmark N/A' : 'Source N/A'}
                </button>
                {summary?.short_interest_source_void && (shortIntActionable ?? 0) > 0 && (
                  <button
                    type="button"
                    className="sdp-btn-reack"
                    onClick={() => void handleToggleVoid('short_interest', true, shortIntGap ?? 0)}
                    disabled={voidAckBusy === 'short_interest'}
                    title={`Update baseline to ${fmt(shortIntGap)} (was ${fmt(shortIntAcked)})`}
                  >
                    {voidAckBusy === 'short_interest' ? '…' : `Re-ack (${fmt(shortIntActionable)} new)`}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Step 9 — Short volume */}
          <div
            id="sepa-runbook-step-9"
            role="tabpanel"
            className={`sdp-step ${finGapOk(shortVolGap) ? 'sdp-step--done' : ''} ${activeRunStep === 9 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">9</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">
                Ingest <code>stock_short_volume</code>
              </div>
              <p className="sdp-step-desc">
                <code>GET /stocks/v1/short-volume</code> — recent trade dates and short volume ratio.
              </p>
              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runFinBackfillAllForKind('svol')}
                  disabled={finAllBusy}
                >
                  {finAllBusy ? 'Enqueueing…' : 'Backfill all gaps'}
                </button>
                <button type="button" className="sdp-btn-secondary" onClick={() => refJobSession.openJobsSheet()}>
                  Jobs
                </button>
                <button
                  type="button"
                  className={`sdp-btn-gaps${shortVolFinStatus === 'ok' ? ' sdp-btn-gaps--ok' : (shortVolFinStatus === 'void' && (shortVolActionable ?? 0) === 0) ? ' sdp-btn-gaps--void' : shortVolGap != null && shortVolGap > 0 ? ' sdp-btn-gaps--warn' : ''}`}
                  onClick={() => {
                    setFinDrawerKind('svol')
                    setFinAllMsg(null)
                    setFinSelMsg(null)
                  }}
                  disabled={shortVolFinStatus === 'ok' || (shortVolFinStatus === 'void' && (shortVolActionable ?? 0) === 0) || !checkedSteps.has(9)}
                >
                  {shortVolFinStatus === 'ok'
                    ? '✓ No gaps'
                    : shortVolFinStatus === 'void' && (shortVolActionable ?? 0) === 0 ? `Source N/A (${fmt(shortVolAcked)} acked)`
                    : shortVolFinStatus === 'void' && (shortVolActionable ?? 0) > 0 ? `${fmt(shortVolActionable)} actionable →`
                    : `Gaps (${fmt(shortVolGap)}) →`}
                </button>
                <button
                  type="button"
                  className={`sdp-btn-void-toggle${summary?.short_volume_source_void ? ' sdp-btn-void-toggle--active' : ''}`}
                  onClick={() => void handleToggleVoid('short_volume', !summary?.short_volume_source_void, shortVolGap ?? 0)}
                  disabled={voidAckBusy === 'short_volume'}
                  title={summary?.short_volume_source_void ? 'Unmark: source actually provides this data' : `Mark as Source N/A: acknowledge ${fmt(shortVolGap)} gaps as baseline`}
                >
                  {voidAckBusy === 'short_volume' ? '…' : summary?.short_volume_source_void ? 'Unmark N/A' : 'Source N/A'}
                </button>
                {summary?.short_volume_source_void && (shortVolActionable ?? 0) > 0 && (
                  <button
                    type="button"
                    className="sdp-btn-reack"
                    onClick={() => void handleToggleVoid('short_volume', true, shortVolGap ?? 0)}
                    disabled={voidAckBusy === 'short_volume'}
                    title={`Update baseline to ${fmt(shortVolGap)} (was ${fmt(shortVolAcked)})`}
                  >
                    {voidAckBusy === 'short_volume' ? '…' : `Re-ack (${fmt(shortVolActionable)} new)`}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Step 10 — Evaluate fundamentals & publish readiness snapshot */}
          <div
            id="sepa-runbook-step-10"
            role="tabpanel"
            className={`sdp-step ${fundStepDone && matSnapshotStepDone ? 'sdp-step--done' : ''} ${activeRunStep === 10 ? 'sdp-step--panel-active' : 'sdp-step--panel-hidden'}`}
          >
            <div className="sdp-step-num">10</div>
            <div className="sdp-step-body">
              <div className="sdp-step-label">Evaluate fundamentals &amp; refresh readiness snapshot</div>
              <p className="sdp-step-desc">
                Phase 1 evaluates 8 SEPA conditions from local income data → writes directly to <code>stock_readiness_daily</code> (fundamental columns).
                Phase 2 materializes the full <code>stock_readiness_daily</code> snapshot (bar coverage, financial coverage) while preserving Phase 1 fundamental results.
                Run both together after completing Steps 1–9.
              </p>

              <div className="sdp-maintenance-box">
                <div className="sdp-maintenance-box-title">Conditions evaluated (Phase 1)</div>
                <div className="sdp-maintenance-row">
                  <span className="sdp-maintenance-badge sdp-maintenance-badge--auto">Q2Q</span>
                  <span className="sdp-maintenance-text">
                    EPS growth ≥25%, Revenue growth ≥25%, EPS acceleration 2Q, Revenue acceleration 2Q
                  </span>
                </div>
                <div className="sdp-maintenance-row">
                  <span className="sdp-maintenance-badge sdp-maintenance-badge--manual">3Y/FY</span>
                  <span className="sdp-maintenance-text">
                    EPS CAGR 3Y ≥15%, Revenue CAGR 3Y ≥15%, EPS acc. last FY, Revenue acc. last FY
                  </span>
                </div>
              </div>

              <div className="sdp-step-actions">
                <button
                  type="button"
                  className="sdp-btn-primary"
                  onClick={() => void runEvaluateAndPublish()}
                  disabled={evalPublishBusy || universeCount === 0}
                  title={universeCount === 0 ? 'Run Step 1 first to populate the universe' : undefined}
                >
                  {evalPublishBusy
                    ? (evalPublishPhase === 'backfill' ? '(1/2) Evaluating fundamentals…' : '(2/2) Refreshing snapshot…')
                    : 'Evaluate & Refresh Snapshot'}
                </button>
              </div>
              {fundBackfillMsg != null && (
                <div className={`sdp-feedback sdp-msg--${fundBackfillOk ? 'ok' : 'err'}`}>
                  <span className="sdp-check-secondary">Phase 1: </span>{fundBackfillMsg}
                </div>
              )}
              {snapshotMsg != null && (
                <div className={`sdp-feedback sdp-msg--${snapshotOk ? 'ok' : 'err'}`}>
                  <span className="sdp-check-secondary">Phase 2: </span>{snapshotMsg}
                </div>
              )}
            </div>
          </div>


          {(finAllMsg || finSelMsg) && (
            <div
              className={`sdp-feedback sdp-fin-runbook-msg sdp-msg--${
                finAllOk === false || finSelOk === false ? 'err' : 'ok'
              }`}
            >
              {[finAllMsg, finSelMsg].filter(Boolean).join(' · ')}
            </div>
          )}

        </div>

        {/* Quick nav + reload */}
        <div className="sdp-quick-nav">
          <button
            type="button"
            className="sdp-btn-ghost"
            onClick={handleReload}
            disabled={summaryLoading}
          >
            {summaryLoading ? 'Reloading…' : '↻ Reload all'}
          </button>
          {refJobSession.refJobItems.length > 0 && (
            <button
              type="button"
              className="sdp-btn-secondary"
              onClick={() => refJobSession.openJobsSheet()}
            >
              {activeJobCount > 0 && (
                <span className="ref-jobs-active-pill" aria-live="polite" style={{ marginRight: '0.35rem' }}>
                  {activeJobCount}
                </span>
              )}
              View Jobs
            </button>
          )}
          {summaryErr && (
            <span className="sdp-msg--err" style={{ fontSize: 'var(--text-caption)' }}>{summaryErr}</span>
          )}
        </div>
        </div>{/* /sdp-runbook-main */}

        {/* ── Check Results Panel ──────────────────────────────────────────── */}
        <div className="sdp-runbook-results">
          <div className="sdp-results-header">
            <span className="sdp-results-title">Check Results</span>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)' }}>
              <button
                type="button"
                className="sdp-results-reset-btn"
                onClick={() => setCollapsedResultStages(new Set())}
              >
                Expand all
              </button>
              <button
                type="button"
                className="sdp-results-reset-btn"
                onClick={() => setCollapsedResultStages(new Set(RUNBOOK_STAGE_LAYOUT.map((s) => s.id)))}
              >
                Collapse all
              </button>
              {checkedSteps.size > 0 && (
                <button
                  type="button"
                  className="sdp-results-reset-btn"
                  onClick={() => setCheckedSteps(new Set())}
                >
                  Reset
                </button>
              )}
            </div>
          </div>
          <div className="sdp-results-list sdp-results-list--staged">
            {runbookStages.map((stage) => (
              <div key={stage.id} className="sdp-results-stage">
                <button
                  type="button"
                  className="sdp-results-stage-head sdp-results-stage-toggle"
                  onClick={() =>
                    setCollapsedResultStages((prev) => {
                      const next = new Set(prev)
                      if (next.has(stage.id)) next.delete(stage.id)
                      else next.add(stage.id)
                      return next
                    })
                  }
                  aria-expanded={!collapsedResultStages.has(stage.id)}
                >
                  <span className={`sdp-check-dot sdp-check-dot--${stage.stageStatus}`} aria-hidden="true" />
                  <span className="sdp-results-stage-title">{stage.title}</span>
                  <span className="sdp-results-stage-count" aria-label={`${stage.doneCount} of ${stage.steps.length} steps complete`}>
                    {stage.doneCount}/{stage.steps.length}
                  </span>
                  <span className="sdp-results-stage-chevron" aria-hidden="true">
                    {collapsedResultStages.has(stage.id) ? '▸' : '▾'}
                  </span>
                </button>
                {!collapsedResultStages.has(stage.id) && <div className="sdp-results-stage-entries">
                  {stage.steps.map((s) => {
                    const isChecked = checkedSteps.has(s.id)
                    const isLoading = summaryLoading
                    return (
                <div
                  key={s.id}
                  className={`sdp-result-entry${isChecked ? ' sdp-result-entry--checked' : ''}`}
                >
                  <div className="sdp-result-entry-heading">
                    <span className={`sdp-result-entry-num${isChecked ? ` sdp-result-num--${s.status}` : ''}`}>
                      {s.id}
                    </span>
                    <span className="sdp-result-entry-name">{s.title}</span>
                    {isLoading && (
                      <span className="sdp-check-dot sdp-check-dot--loading" style={{ marginLeft: 'auto', flexShrink: 0 }} />
                    )}
                    {isChecked && !isLoading && (
                      <span className={`sdp-check-dot sdp-check-dot--${s.status}`} style={{ marginLeft: 'auto', flexShrink: 0 }} />
                    )}
                  </div>
                  {isLoading ? (
                    <div className="sdp-result-idle">Checking…</div>
                  ) : !isChecked ? (
                    <div className="sdp-result-idle">Use Check in the run book header above</div>
                  ) : (
                    <div className="sdp-result-content">
                      {s.id === 1 && (
                        <>
                          <StepCheckStrip
                            hasChecked
                            loading={false}
                            status={step1Status}
                            primary={`${fmt(universeCount)} equity universe`}
                            primaryLabel=" · v_us_equity_universe"
                            secondary={tickersActive > 0 ? `${fmt(tickersActive)} active US stocks in DB` : null}
                            gap={universeCount < 100 ? universeCount : null}
                            gapUnit="tickers"
                            target="≥ 5,000 active US equity symbols"
                            note={summary?.tickers_last_synced_at ? `Last synced ${fmtRelativeTime(summary.tickers_last_synced_at)}` : summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                          />
                          <StepCheckStrip
                            hasChecked
                            loading={false}
                            status={holidaysStatus}
                            primary={holidaysTotal > 0 ? `${fmt(holidaysTotal)} holidays · ${fmt(holidaysMassive)} from Massive · ${fmt(holidaysSeed)} seeded` : 'No holidays loaded'}
                            primaryLabel=" · all exchanges"
                            secondary={holidaysEarlyClose > 0 ? `${fmt(holidaysEarlyClose)} early-close days` : null}
                            target="Seed 2020-2027 + Massive upcoming (~12 months)"
                            note={holidaysLastSync ? `Massive sync ${fmtRelativeTime(holidaysLastSync)}${holidaysEarliest && holidaysLatest ? ` · ${holidaysEarliest} → ${holidaysLatest}` : ''}` : summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                          />
                        </>
                      )}
                      {s.id === 2 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={unifiedSnapStatus}
                          primary={unifiedSnapRows != null && unifiedSnapRows > 0 ? `${fmt(unifiedSnapRows)} symbols cached` : 'No unified snapshot rows yet'}
                          primaryLabel=" · cache_stock_snapshot"
                          secondary={summary?.stock_unified_snapshot_last_fetched_at ? `Last fetch ${fmtRelativeTime(summary.stock_unified_snapshot_last_fetched_at)}` : null}
                          target="Run once after Step 1 before heavy stock_day backfill"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 3 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={barStepStatus}
                          primary={totalSymbols > 0 ? `${fmt(priceReady)} / ${fmt(totalSymbols)} price_ready (${fmtPct(priceReady, totalSymbols)})` : null}
                          primaryLabel=" · cache vs stock_day + readiness fallback"
                          gap={priceGap}
                          gapUnit="symbols need daily fill"
                          target="Vendor NY date from Step 2 cache ≤ last massive daily bar"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 4 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={incomeFinStatus}
                          primary={incomeFinStatus === 'void' ? `Source N/A — ${fmt(incomeGap)} symbols acknowledged as Massive data void` : incomeGap != null ? `${fmt(incomeGap)} symbols with income statement gaps` : 'Gap count not loaded'}
                          primaryLabel=" · stock_income_statements"
                          gap={incomeGap != null && incomeGap > 0 ? incomeGap : null}
                          gapUnit="symbols"
                          target="Zero gaps vs universe thresholds (quarterly + annual + EPS/revenue fill)"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 5 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={balanceFinStatus}
                          primary={balanceFinStatus === 'void' ? `Source N/A — ${fmt(balanceGap)} symbols acknowledged as Massive data void` : balanceGap != null ? `${fmt(balanceGap)} balance sheet gaps` : 'Gap count not loaded'}
                          primaryLabel=" · stock_balance_sheets"
                          gap={balanceGap != null && balanceGap > 0 ? balanceGap : null}
                          gapUnit="symbols"
                          target="Zero gaps (quarterly rows + total_assets fill rate)"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 6 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={cashFinStatus}
                          primary={cashFinStatus === 'void' ? `Source N/A — ${fmt(cashGap)} symbols acknowledged as Massive data void` : cashGap != null ? `${fmt(cashGap)} cash flow gaps` : 'Gap count not loaded'}
                          primaryLabel=" · stock_cash_flows"
                          gap={cashGap != null && cashGap > 0 ? cashGap : null}
                          gapUnit="symbols"
                          target="Zero gaps (operating CF non-null ratio)"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 7 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={ratiosFinStatus}
                          primary={ratiosFinStatus === 'void' ? `Source N/A — ${fmt(ratiosGap)} symbols acknowledged as Massive data void` : ratiosGap != null ? `${fmt(ratiosGap)} ratios gaps` : 'Gap count not loaded'}
                          primaryLabel=" · stock_ratios"
                          gap={ratiosGap != null && ratiosGap > 0 ? ratiosGap : null}
                          gapUnit="symbols"
                          target="Zero gaps (quarterly row count)"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 8 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={shortIntFinStatus}
                          primary={shortIntFinStatus === 'void' ? `Source N/A — ${fmt(shortIntGap)} symbols acknowledged as Massive data void` : shortIntGap != null ? `${fmt(shortIntGap)} short interest gaps` : 'Gap count not loaded'}
                          primaryLabel=" · stock_short_interest"
                          gap={shortIntGap != null && shortIntGap > 0 ? shortIntGap : null}
                          gapUnit="symbols"
                          target="Recent settlement coverage"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 9 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={shortVolFinStatus}
                          primary={shortVolFinStatus === 'void' ? `Source N/A — ${fmt(shortVolGap)} symbols acknowledged as Massive data void` : shortVolGap != null ? `${fmt(shortVolGap)} short volume gaps` : 'Gap count not loaded'}
                          primaryLabel=" · stock_short_volume"
                          gap={shortVolGap != null && shortVolGap > 0 ? shortVolGap : null}
                          gapUnit="symbols"
                          target="Recent trade rows + max trade date"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                      {s.id === 10 && (
                        <StepCheckStrip
                          hasChecked
                          loading={false}
                          status={fundStepDone && matSnapshotStepDone ? 'ok'
                            : fundStepDone || matSnapshotStepDone ? 'warn'
                            : fundStepStatus === 'error' || matSnapshotStepStatus === 'error' ? 'error'
                            : 'unknown'}
                          primary={matSnapshotStepDone
                            ? `${fmt(snap?.price_ready)} / ${fmt(snap?.included_in_universe)} price_ready · ${fmt(fundCacheValid)} fund cache`
                            : fundCacheValid > 0
                            ? `${fmt(fundCacheValid)} symbols evaluated — snapshot not yet refreshed`
                            : 'Not run — click Evaluate & Refresh Snapshot'}
                          primaryLabel=" · stock_readiness_daily"
                          gap={matSnapshotStepDone && summary?.snapshot_populated ? (snap?.included_in_universe ?? 0) - (snap?.price_ready ?? 0) : null}
                          gapUnit="symbols not price_ready"
                          target="Snapshot populated today · ≥50% fund cache coverage"
                          note={summaryLoadedAtRef.current ? `Checked ${fmtRelativeTime(summaryLoadedAtRef.current)}` : null}
                        />
                      )}
                    </div>
                  )}
                </div>
              )
                  })}
                </div>}
              </div>
            ))}
          </div>
        </div>{/* /sdp-runbook-results */}
        </div>{/* /sdp-runbook-layout */}
      </div>

      {/* ── Readiness Status ─────────────────────────────────────────────── */}
      <div className="card sdp-readiness-status-card">
        <div className="sdp-readiness-status-header">
          <span className="sdp-readiness-status-title">Readiness Status</span>
          {summary?.snapshot_populated && snap != null && (
            <span className="sdp-check-secondary">
              {fmt(snap.rows_total)} symbols · {fmt(snap.price_ready)} price_ready
              {snap.rows_total != null && snap.price_ready != null
                ? ` (${Math.round((snap.price_ready / snap.rows_total) * 100)}%)`
                : ''}
            </span>
          )}
          <div className="sdp-readiness-status-actions">
            <button
              type="button"
              className="sdp-btn-secondary"
              onClick={() => void loadCriteriaStats()}
              disabled={criteriaLoading || !summary?.snapshot_populated}
              title={!summary?.snapshot_populated ? 'Run Step 10 first to generate a snapshot' : 'Recompute criteria stats from today\'s snapshot'}
            >
              {criteriaLoading ? 'Computing…' : 'Refresh Criteria'}
            </button>
            {criteriaStats?.computed_at && (
              <span className="sdp-check-secondary">
                Last: {new Date(criteriaStats.computed_at).toLocaleTimeString()}
              </span>
            )}
          </div>
        </div>

        {!summary?.snapshot_populated && (
          <p className="sdp-step-desc sdp-text-dim" style={{ marginTop: 'var(--space-3)' }}>
            No snapshot for today yet. Run <strong>Step 10 → Evaluate &amp; Refresh Snapshot</strong> to populate.
          </p>
        )}

        {summary?.snapshot_populated && (
          <>
            {/* ── Snapshot Health ────────────────────────────────────── */}
            <div className="sdp-readiness-health">
              <div className="sdp-readiness-health-row">
                <span className={`sdp-check-dot sdp-check-dot--${reviewStepStatus}`} />
                <span>
                  {notesCount === 0
                    ? 'All universe symbols are price_ready'
                    : `${fmt(notesCount)} universe symbols not price_ready`}
                  {summary?.fund_cache_view_exists && (
                    <span className="sdp-check-secondary">
                      {' · '}{fmt(summary?.fund_cache_valid_count ?? null)} fund cache valid
                    </span>
                  )}
                </span>
                <div className="sdp-readiness-health-btns">
                  <button
                    type="button"
                    className="sdp-btn-primary"
                    onClick={() => void runFixGaps()}
                    disabled={fixGapsBusy}
                  >
                    {fixGapsBusy ? 'Fixing…' : 'Fix Gaps'}
                  </button>
                  <button
                    type="button"
                    className="sdp-btn-secondary"
                    onClick={() => refJobSession.openJobsSheet()}
                  >
                    View Jobs
                  </button>
                  {onOpenDataCoverageSummary && (
                    <button type="button" className="sdp-btn-ghost" onClick={onOpenDataCoverageSummary}>
                      Data Coverage →
                    </button>
                  )}
                </div>
              </div>
              {fixGapsMsg != null && (
                <div className={`sdp-feedback sdp-msg--${fixGapsOk ? 'ok' : 'err'}`}>{fixGapsMsg}</div>
              )}
              {(summary?.notes_breakdown ?? []).length > 0 && notesCount > 0 && (
                <div className="sdp-eval-failure-reasons" style={{ marginTop: 'var(--space-2)' }}>
                  <span className="sdp-check-secondary">Not price_ready by reason:&nbsp;</span>
                  {(summary?.notes_breakdown ?? []).map((nb) => (
                    <span key={nb.notes ?? 'null'} className="sdp-eval-dist-chip sdp-eval-dist-chip--warn">
                      {nb.notes ?? '(unknown)'} — {fmt(nb.count)}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* ── Criteria Stats ─────────────────────────────────────── */}
            {criteriaErr && <p className="sdp-feedback sdp-msg--err" style={{ marginTop: 'var(--space-3)' }}>{criteriaErr}</p>}
            {criteriaLoading && !criteriaStats && (
              <p className="sdp-step-desc sdp-text-dim" style={{ marginTop: 'var(--space-3)' }}>Computing criteria stats…</p>
            )}
            {criteriaStats != null && (
              <div className="sdp-eval-body" style={{ marginTop: 'var(--space-4)' }}>
                {/* Fundamental */}
                <div className="sdp-eval-section">
                  <div className="sdp-eval-section-head">
                    <strong>Fundamental</strong>
                    <span className="sdp-check-secondary">
                      Evaluated {fmt(criteriaStats.fundamental.cached_count)} / {fmt(criteriaStats.universe_count)}
                      &nbsp;·&nbsp;
                      <span className={criteriaStats.fundamental.fund_pass_count > 0 ? 'sdp-text-ok' : 'sdp-text-dim'}>
                        Pass all 8: {fmt(criteriaStats.fundamental.fund_pass_count)}
                        {' '}({criteriaStats.fundamental.cached_count > 0 ? Math.round(criteriaStats.fundamental.fund_pass_count / criteriaStats.fundamental.cached_count * 100) : 0}%)
                      </span>
                      &nbsp;·&nbsp;
                      <span className="sdp-text-dim">No data: {fmt(criteriaStats.fundamental.no_data_count)}</span>
                    </span>
                    <button
                      type="button"
                      className={`sdp-sql-toggle${showFundSql ? ' sdp-sql-toggle--active' : ''}`}
                      onClick={() => setShowFundSql(v => !v)}
                      title="Show calculation logic and SQL query"
                    >
                      SQL {showFundSql ? '▴' : '▾'}
                    </button>
                  </div>
                  <div className="sdp-criteria-rows">
                    {criteriaStats.fundamental.conditions.map((cond) => {
                      const denominator = cond.pass + cond.fail
                      const pct = denominator > 0 ? Math.round(cond.pass / denominator * 100) : 0
                      const barColor = pct >= 30 ? 'sdp-criteria-bar-fill--ok' : pct >= 15 ? 'sdp-criteria-bar-fill--warn' : 'sdp-criteria-bar-fill--error'
                      const isExpanded = expandedCondId === cond.id
                      const detail = COND_DETAIL[cond.id]
                      return (
                        <div key={cond.id}>
                          <div className="sdp-criteria-row">
                            <span className="sdp-criteria-label" title={cond.id}>{cond.label}</span>
                            <div className="sdp-criteria-bar">
                              <div className={`sdp-criteria-bar-fill ${barColor}`} style={{ width: `${pct}%` }} />
                            </div>
                            <span className="sdp-criteria-stat">
                              {fmt(cond.pass)} / {fmt(denominator)}
                              <span className="sdp-check-secondary"> ({pct}%)</span>
                            </span>
                            {detail && (
                              <button
                                type="button"
                                className={`sdp-cond-info-btn${isExpanded ? ' sdp-cond-info-btn--active' : ''}`}
                                onClick={() => setExpandedCondId(isExpanded ? null : cond.id)}
                                title={isExpanded ? 'Hide calculation logic' : 'Show calculation logic & SQL'}
                              >
                                ⓘ
                              </button>
                            )}
                          </div>
                          {isExpanded && detail && (
                            <div className="sdp-cond-detail">
                              <div className="sdp-cond-detail-meta">
                                <div className="sdp-cond-detail-row">
                                  <span className="sdp-cond-detail-key">Table</span>
                                  <code className="sdp-cond-detail-val">{detail.table}</code>
                                </div>
                                <div className="sdp-cond-detail-row">
                                  <span className="sdp-cond-detail-key">Column</span>
                                  <code className="sdp-cond-detail-val">{detail.column}</code>
                                </div>
                                <div className="sdp-cond-detail-row">
                                  <span className="sdp-cond-detail-key">Period filter</span>
                                  <code className="sdp-cond-detail-val">{detail.period}</code>
                                </div>
                                <div className="sdp-cond-detail-row">
                                  <span className="sdp-cond-detail-key">Data required</span>
                                  <span className="sdp-cond-detail-val sdp-check-secondary">{detail.dataReq}</span>
                                </div>
                                <div className="sdp-cond-detail-row sdp-cond-detail-row--formula">
                                  <span className="sdp-cond-detail-key">Formula</span>
                                  <pre className="sdp-cond-detail-formula">{detail.formula}</pre>
                                </div>
                              </div>
                              <div className="sdp-cond-sql-block">
                                <div className="sdp-sql-block-head">
                                  <span className="sdp-sql-block-title">{cond.id}.sql</span>
                                  <button
                                    type="button"
                                    className={`sdp-sql-copy-btn${copiedCondId === cond.id ? ' sdp-sql-copy-btn--copied' : ''}`}
                                    onClick={() => {
                                      void navigator.clipboard.writeText(detail.sql)
                                      setCopiedCondId(cond.id)
                                      setTimeout(() => setCopiedCondId(null), 2000)
                                    }}
                                  >
                                    {copiedCondId === cond.id ? '✓ Copied' : 'Copy'}
                                  </button>
                                </div>
                                <pre className="sdp-sql-code">{detail.sql}</pre>
                              </div>
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* SQL Explanation Panel */}
                  {showFundSql && (
                    <div className="sdp-sql-panel">
                      <div className="sdp-sql-legend">
                        <div className="sdp-sql-legend-title">Calculation Logic</div>
                        <div className="sdp-sql-legend-row">
                          <span className="sdp-sql-legend-label">Evaluated X / Y</span>
                          <span className="sdp-sql-legend-formula">{`numerator  = count(*) WHERE fundamental_eval IS NOT NULL AND included_in_universe\ndenominator = count(*) FROM v_us_equity_universe`}</span>
                        </div>
                        <div className="sdp-sql-legend-row">
                          <span className="sdp-sql-legend-label">Pass all 8: N (Z%)</span>
                          <span className="sdp-sql-legend-formula">{`numerator  = count(*) WHERE fundamental_pass = true\ndenominator = evaluated count (not full universe)`}</span>
                        </div>
                        <div className="sdp-sql-legend-row">
                          <span className="sdp-sql-legend-label">Per-condition bar N / M (P%)</span>
                          <span className="sdp-sql-legend-formula">{`numerator  = count(*) WHERE conditions @> [{id, pass:true}]\ndenominator = pass + fail  (no_data symbols excluded from both)`}</span>
                        </div>
                      </div>

                      <div className="sdp-sql-block">
                        <div className="sdp-sql-block-head">
                          <span className="sdp-sql-block-title">aggregation.sql — what the API runs</span>
                          <button
                            type="button"
                            className={`sdp-sql-copy-btn${copiedSql === 'agg' ? ' sdp-sql-copy-btn--copied' : ''}`}
                            onClick={() => {
                              void navigator.clipboard.writeText(FUND_SQL_AGGREGATION)
                              setCopiedSql('agg')
                              setTimeout(() => setCopiedSql(null), 2000)
                            }}
                          >
                            {copiedSql === 'agg' ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                        <pre className="sdp-sql-code">{FUND_SQL_AGGREGATION}</pre>
                      </div>

                      <div className="sdp-sql-block">
                        <div className="sdp-sql-block-head">
                          <span className="sdp-sql-block-title">per_symbol.sql — inspect one ticker</span>
                          <button
                            type="button"
                            className={`sdp-sql-copy-btn${copiedSql === 'sym' ? ' sdp-sql-copy-btn--copied' : ''}`}
                            onClick={() => {
                              void navigator.clipboard.writeText(FUND_SQL_SYMBOL)
                              setCopiedSql('sym')
                              setTimeout(() => setCopiedSql(null), 2000)
                            }}
                          >
                            {copiedSql === 'sym' ? '✓ Copied' : 'Copy'}
                          </button>
                        </div>
                        <pre className="sdp-sql-code">{FUND_SQL_SYMBOL}</pre>
                      </div>
                    </div>
                  )}
                </div>

                {/* Technical */}
                <div className="sdp-eval-section">
                  <div className="sdp-eval-section-head">
                    <strong>Technical</strong>
                    <span className="sdp-check-secondary">
                      price_ready: {fmt(criteriaStats.technical.price_ready_count)} / {fmt(criteriaStats.universe_count)}
                      {' '}({criteriaStats.universe_count > 0 ? Math.round(criteriaStats.technical.price_ready_count / criteriaStats.universe_count * 100) : 0}%)
                      &nbsp;·&nbsp;fund_cache today: {fmt(criteriaStats.technical.fund_cached_count)}
                    </span>
                  </div>
                  <div className="sdp-eval-bar-dist">
                    {[
                      { label: '≥252 bars', value: criteriaStats.technical.bars_ge_252 },
                      { label: '≥240 bars', value: criteriaStats.technical.bars_ge_240 },
                      { label: '≥200 bars', value: criteriaStats.technical.bars_ge_200 },
                      { label: '<200 bars', value: criteriaStats.technical.bars_lt_200 },
                      { label: 'no bars',   value: criteriaStats.technical.no_bars },
                    ].map(({ label, value }) => (
                      <span key={label} className="sdp-eval-dist-chip">
                        <span className="sdp-check-secondary">{label}:</span> {fmt(value)}
                      </span>
                    ))}
                  </div>
                  {criteriaStats.technical.failure_reasons.length > 0 && (
                    <div className="sdp-eval-failure-reasons">
                      <span className="sdp-check-secondary">Not price_ready:&nbsp;</span>
                      {criteriaStats.technical.failure_reasons.map((fr) => (
                        <span key={fr.notes ?? 'null'} className="sdp-eval-dist-chip sdp-eval-dist-chip--warn">
                          {fr.notes ?? '(unknown)'} — {fmt(fr.cnt)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Combined summary */}
                <div className="sdp-eval-combined">
                  <span className="sdp-eval-combined-label">price_ready + fund_cache today:</span>
                  <strong>{fmt(criteriaStats.technical.both_ready)}</strong>
                  <span className="sdp-check-secondary">
                    {' '}/ {fmt(criteriaStats.universe_count)}
                    {' '}({criteriaStats.universe_count > 0 ? Math.round(criteriaStats.technical.both_ready / criteriaStats.universe_count * 100) : 0}%)
                  </span>
                  <span className="sdp-eval-combined-sep">·</span>
                  <span className="sdp-eval-combined-label">Fund pass + price_ready:</span>
                  <strong className="sdp-text-ok">{fmt(criteriaStats.fundamental.fund_pass_count)}</strong>
                  <span className="sdp-check-secondary">
                    {' '}({criteriaStats.universe_count > 0 ? Math.round(criteriaStats.fundamental.fund_pass_count / criteriaStats.universe_count * 100) : 0}% of universe)
                  </span>
                </div>
              </div>
            )}

            {/* ── Data Inventory ─────────────────────────────────────── */}
            <div className="sdp-eval-panel" style={{ marginTop: 'var(--space-4)' }}>
              <div className="sdp-eval-panel-head">
                <span className="sdp-eval-panel-title">Data Inventory</span>
                <div className="sdp-step-actions" style={{ marginTop: 0 }}>
                  <button
                    type="button"
                    className="sdp-btn-secondary"
                    onClick={() => void loadInventoryStats()}
                    disabled={inventoryLoading}
                  >
                    {inventoryLoading ? 'Loading…' : inventoryStats != null ? 'Refresh' : 'Load Inventory'}
                  </button>
                </div>
              </div>
              <p className="sdp-step-hint sdp-text-dim">
                Columns already collected but not yet used as SEPA filter criteria.
                Fill% = universe symbols with non-null values.
              </p>
              {inventoryErr && <p className="sdp-feedback sdp-msg--err">{inventoryErr}</p>}
              {inventoryStats != null && (
                <table className="sdp-inventory-table">
                  <thead>
                    <tr>
                      <th>Table</th>
                      <th>Column</th>
                      <th>Fill%</th>
                      <th>Category</th>
                      <th>Potential Indicator</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DATA_INVENTORY_METADATA.map((entry) => {
                      const filledCount = inventoryStats.tables[entry.table]?.[entry.column] ?? 0
                      const pct = inventoryStats.universe_count > 0
                        ? Math.round(filledCount / inventoryStats.universe_count * 100)
                        : 0
                      const categoryClass = entry.category === 'Valuation' ? 'sdp-inventory-category--valuation'
                        : entry.category === 'Quality' ? 'sdp-inventory-category--quality'
                        : entry.category.includes('Cash') ? 'sdp-inventory-category--cashflow'
                        : entry.category === 'Short Pressure' ? 'sdp-inventory-category--short'
                        : ''
                      return (
                        <tr key={`${entry.table}/${entry.column}`}>
                          <td className="sdp-inventory-table-name">{entry.table}</td>
                          <td><code>{entry.column}</code></td>
                          <td>
                            <div className="sdp-inventory-fill-wrap">
                              <div className="sdp-inventory-fill-bar">
                                <div
                                  className="sdp-inventory-fill-bar-inner"
                                  style={{ width: `${pct}%`, background: pct >= 70 ? 'var(--color-success)' : pct >= 40 ? 'var(--color-warning, #fb923c)' : 'var(--color-danger)' }}
                                />
                              </div>
                              <span className="sdp-inventory-fill-pct">{pct}%</span>
                            </div>
                          </td>
                          <td><span className={`sdp-inventory-category ${categoryClass}`}>{entry.category}</span></td>
                          <td className="sdp-inventory-indicator">{entry.indicator}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>

      <div className="sdp-info-tabs" role="tablist" aria-label="SEPA data insights">
        <button
          type="button"
          role="tab"
          aria-selected={activeInfoTab === 'metrics'}
          className={`sdp-info-tab${activeInfoTab === 'metrics' ? ' sdp-info-tab--active' : ''}`}
          onClick={() => setActiveInfoTab('metrics')}
        >
          Readiness Metrics
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeInfoTab === 'checklist'}
          className={`sdp-info-tab${activeInfoTab === 'checklist' ? ' sdp-info-tab--active' : ''}`}
          onClick={() => setActiveInfoTab('checklist')}
        >
          Screening Checklist
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeInfoTab === 'database'}
          className={`sdp-info-tab${activeInfoTab === 'database' ? ' sdp-info-tab--active' : ''}`}
          onClick={() => setActiveInfoTab('database')}
        >
          Database (Raw / Computed)
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeInfoTab === 'reference'}
          className={`sdp-info-tab${activeInfoTab === 'reference' ? ' sdp-info-tab--active' : ''}`}
          onClick={() => setActiveInfoTab('reference')}
        >
          Reference
        </button>
      </div>

      {activeInfoTab === 'checklist' && <SepaScreeningChecklist summary={summary} />}

      {activeInfoTab === 'database' && (
        <>
          {summary?.data_catalog ? (
            <CatalogTabs catalog={summary.data_catalog} />
          ) : (
            summaryLoading ? (
              <div className="sdp-catalog-loading">
                {[0, 1, 2, 3].map((i) => <div key={i} className="sdp-skeleton-card" />)}
              </div>
            ) : (
              summary?.ok === true && (
                <div className="sdp-info-banner">
                  Data catalog not returned. Deploy a backend that includes <code>data_catalog</code> on{' '}
                  <code>/readiness/summary</code>, then reload summary.
                </div>
              )
            )
          )}
        </>
      )}

      {activeInfoTab === 'metrics' && (
        <>
      <div className="sdp-section-divider">
        <span className="sdp-section-divider-label">Readiness metrics</span>
        <div className="sdp-section-divider-line" />
      </div>

      {snapshotEmpty && (
        <div className="sdp-warn-banner">
          ⚠ Snapshot table is empty for today — run Step 11 (Refresh snapshot) to populate it.
        </div>
      )}

      <div className="sdp-metrics-strip">
        <div className="sdp-metric">
          <div className="sdp-metric-label">Universe</div>
          <div className="sdp-metric-value">{fmt(summary?.universe_count)}</div>
          <div className="sdp-metric-sub">v_us_equity_universe</div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Unified snapshot rows</div>
          <div className="sdp-metric-value">{fmt(summary?.stock_unified_snapshot_row_count ?? null)}</div>
          <div className="sdp-metric-sub">
            cache_stock_snapshot
            {summary?.stock_unified_snapshot_last_fetched_at
              ? ` · ${fmtRelativeTime(summary.stock_unified_snapshot_last_fetched_at)}`
              : ''}
          </div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Daily fill gaps (Step 3)</div>
          <div
            className={`sdp-metric-value ${
              vendorFillGap != null && vendorFillGap === 0 ? 'sdp-metric-value--accent' : ''
            }`}
          >
            {fmt(vendorFillGap)}
          </div>
          <div className="sdp-metric-sub">cache.last_minute_updated (NY) vs max(stock_day)</div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Price ready (live)</div>
          <div className="sdp-metric-value sdp-metric-value--accent">
            {fmt(live?.price_ready)}
          </div>
          <div className="sdp-metric-sub">
            of {fmt(live?.total_symbols)} symbols · v_sepa_symbol_price_readiness
          </div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Snapshot — price ready</div>
          <div className={`sdp-metric-value ${snap?.price_ready ? 'sdp-metric-value--accent' : ''}`}>
            {fmt(snap?.price_ready)}
          </div>
          <div className="sdp-metric-sub">
            of {fmt(snap?.included_in_universe)} included · {fmt(snap?.rows_total)} total rows
          </div>
        </div>

        <div className="sdp-metric">
          <div className="sdp-metric-label">Fund cache valid</div>
          <div className={`sdp-metric-value ${summary?.fund_cache_view_exists === false ? '' : ''}`}>
            {summary?.fund_cache_view_exists === false
              ? 'View not created'
              : fmt(summary?.fund_cache_valid_count ?? null)}
          </div>
          <div className="sdp-metric-sub">v_sepa_symbol_fund_cache_readiness (optional)</div>
        </div>
      </div>

      <div className="sdp-section-card" id="sepa-balance-data-support" ref={dataSupportSectionRef}>
        <div className="sdp-section-card-header">
          <span className="sdp-section-card-title">Instrument Type Data Support</span>
          <button
            type="button"
            className="sdp-btn-ghost"
            onClick={() => setDataSupportChecked(true)}
          >
            {dataSupportChecked ? 'Checked' : 'Check Coverage'}
          </button>
        </div>
        <p className="sdp-step-desc" style={{ marginTop: 0 }}>
          Coverage matrix for statements + snapshot footprint by instrument type. Steps 4–7 count gaps only for Supported or Partial
          types here (<code>{FIN_STMT_GAP_INSTRUMENT_CODES.join(', ')}</code>); fully Not supported instrument types do not inflate gap
          counts. Under each statement column, <strong>distinct symbols</strong> counts join{' '}
          <code>tickers</code> on <code>symbol</code> (active US <code>stocks</code>, <code>source=massive</code> rows in{' '}
          <code>stock_*</code> tables).
        </p>
        {!dataSupportChecked ? (
          <div className="sdp-step-aside-empty">
            Click <strong>Check Coverage</strong> to load the instrument-type support matrix.
          </div>
        ) : (
          <div className="table-scroll-x">
            <table className="sdp-table sdp-table--compact">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Description</th>
                  <th scope="col">
                    Income
                    <span className="sdp-th-stacked-sub">distinct symbols</span>
                  </th>
                  <th scope="col">
                    Balance
                    <span className="sdp-th-stacked-sub">distinct symbols</span>
                  </th>
                  <th scope="col">
                    Cash flow
                    <span className="sdp-th-stacked-sub">distinct symbols</span>
                  </th>
                  <th scope="col">
                    Ratios
                    <span className="sdp-th-stacked-sub">distinct symbols</span>
                  </th>
                  <th>Snapshot rows</th>
                  <th>Universe tickers</th>
                  <th>Coverage</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {supportRows.map((row) => {
                  const income = supportBadge(row.incomeStatements)
                  const balance = supportBadge(row.balanceSheets)
                  const cash = supportBadge(row.cashFlows)
                  const ratios = supportBadge(row.ratios)
                  const fc = fundamentalsByTypeMap.get(row.code)
                  const incN = fc?.income_statement_symbols
                  const balN = fc?.balance_sheet_symbols
                  const cfN = fc?.cash_flow_symbols
                  const rtN = fc?.ratio_symbols
                  const snap = snapshotByTypeMap.get(row.code)
                  const snapRows = snap?.snapshot_row_count ?? 0
                  const uniRows = snap?.universe_ticker_count ?? 0
                  const coveragePct = uniRows > 0 ? (snapRows / uniRows) * 100 : null
                  const coverageCls =
                    coveragePct == null
                      ? 'sdp-coverage-bar-fill--unknown'
                      : coveragePct >= 90
                      ? 'sdp-coverage-bar-fill--high'
                      : coveragePct >= 60
                      ? 'sdp-coverage-bar-fill--mid'
                      : 'sdp-coverage-bar-fill--low'
                  return (
                    <tr key={row.code}>
                      <td><code>{row.code}</code></td>
                      <td>{row.description}</td>
                      <td>
                        <div className="sdp-support-fund-cell">
                          <span className={income.cls}>{income.text}</span>
                          {typeof incN === 'number' ? (
                            <span className="sdp-support-fund-cell__amount">{fmt(incN)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="sdp-support-fund-cell">
                          <span className={balance.cls}>{balance.text}</span>
                          {typeof balN === 'number' ? (
                            <span className="sdp-support-fund-cell__amount">{fmt(balN)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="sdp-support-fund-cell">
                          <span className={cash.cls}>{cash.text}</span>
                          {typeof cfN === 'number' ? (
                            <span className="sdp-support-fund-cell__amount">{fmt(cfN)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className="sdp-support-fund-cell">
                          <span className={ratios.cls}>{ratios.text}</span>
                          {typeof rtN === 'number' ? (
                            <span className="sdp-support-fund-cell__amount">{fmt(rtN)}</span>
                          ) : null}
                        </div>
                      </td>
                      <td>{fmt(snapRows)}</td>
                      <td>{fmt(uniRows)}</td>
                      <td>
                        {coveragePct == null ? (
                          <span className="sdp-coverage-na">—</span>
                        ) : (
                          <div className="sdp-coverage-cell">
                            <div className="sdp-coverage-bar">
                              <span
                                className={`sdp-coverage-bar-fill ${coverageCls}`}
                                style={{ width: `${Math.max(0, Math.min(100, coveragePct))}%` }}
                              />
                            </div>
                            <span className="sdp-coverage-pct">{coveragePct.toFixed(1)}%</span>
                          </div>
                        )}
                      </td>
                      <td>{row.note ?? '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
        </>
      )}

      {activeInfoTab === 'reference' && (
        <>
      {/* ── Notes breakdown ───────────────────────────────────────────────── */}

      <div className="sdp-section-card">
        <div className="sdp-section-card-header">
          <span className="sdp-section-card-title">Notes breakdown</span>
          <button
            type="button"
            className="sdp-btn-ghost"
            onClick={() => void loadSummary()}
            disabled={summaryLoading}
          >
            Refresh
          </button>
        </div>
        <div style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-dim)', marginBottom: 'var(--space-3)' }}>
          Symbols included in universe, not price-ready, today
        </div>
        <div className="table-scroll-x">
          <table className="sdp-table">
            <thead>
              <tr>
                <th>Notes</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {(summary?.notes_breakdown?.length ?? 0) > 0 ? (
                summary!.notes_breakdown!.map((row) => (
                  <tr key={row.notes}>
                    <td><code>{row.notes}</code></td>
                    <td>{row.count}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={2} className="sdp-table-empty">
                    {summaryLoading ? 'Loading…' : 'No rows — snapshot empty or all symbols are price-ready.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Celery queues ─────────────────────────────────────────────────── */}

      <div className="sdp-section-card">
        <div className="sdp-section-card-header">
          <span className="sdp-section-card-title">Celery broker queues</span>
          <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
            {onOpenCelerySettings && (
              <button type="button" className="sdp-btn-ghost" onClick={onOpenCelerySettings}>
                Open Settings → Celery
              </button>
            )}
            <button
              type="button"
              className="sdp-btn-ghost"
              onClick={() => void loadQueues()}
              disabled={queuesLoading}
            >
              {queuesLoading ? 'Loading…' : 'Reload'}
            </button>
          </div>
        </div>
        {queuesErr && (
          <div className="sdp-msg--info" style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-caption)' }}>
            {queuesErr}
          </div>
        )}
        <div className="table-scroll-x">
          <table className="sdp-table">
            <thead>
              <tr>
                <th>Queue</th>
                <th>Pending</th>
                <th>Running</th>
              </tr>
            </thead>
            <tbody>
              {queues.length > 0 ? (
                queues.map((q) => (
                  <tr key={q.name}>
                    <td>{q.display_name?.trim() || formatQueueLabel(q.name)}</td>
                    <td>{fmt(q.pending_broker)}</td>
                    <td>{fmt(q.running_celery)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="sdp-table-empty">
                    {queuesLoading ? 'Loading…' : 'No queue data.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
        </>
      )}

      {finDrawerKind != null && (
        <FinancialGapsDrawer
          key={finDrawerKind}
          open
          title={finDrawerTitleForKind(finDrawerKind)}
          columnPreset={finDrawerColumnPresetForKind(finDrawerKind)}
          onClose={() => {
            setFinDrawerKind(null)
            setFinAllMsg(null)
            setFinSelMsg(null)
          }}
          fetchGaps={finDrawerFetch}
          onBackfillAll={() => void runFinBackfillAll()}
          backfillBusy={finAllBusy}
          backfillMsg={finAllMsg}
          backfillOk={finAllOk}
          onBackfillSelected={(syms) => void runFinBackfillSelected(syms)}
          backfillSelectedBusy={finSelBusy}
          backfillSelectedMsg={finSelMsg}
          backfillSelectedOk={finSelOk}
        />
      )}

      {/* ── Gaps Drawer ───────────────────────────────────────────────────── */}
      <GapsDrawer
        open={gapsDrawerOpen}
        onClose={() => setGapsDrawerOpen(false)}
        priceGap={priceGap}
        onRunBackfill={() => void runPriceGapBackfill()}
        backfillBusy={priceGapBusy}
        backfillMsg={priceGapMsg}
        backfillOk={priceGapOk}
        onRunBackfillSelected={(syms) => void runPriceGapBackfillSelected(syms)}
        backfillSelectedBusy={selectedGapBusy}
        backfillSelectedMsg={selectedGapMsg}
        backfillSelectedOk={selectedGapOk}
      />
    </div>
  )
}

/** Public export: wraps inner page with MassiveRefJobSessionProvider so TickerReferenceJobsSheet is available. */
export function StockDataReadinessPage(props: StockDataReadinessPageProps) {
  return (
    <MassiveRefJobSessionProvider>
      <StockDataReadinessPageInner {...props} />
    </MassiveRefJobSessionProvider>
  )
}
