import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { postOptionBarsContractsGapBatch } from '../../api'
import type {
  OptionBarsContractsGapResult,
  OptionContractsReferenceGapResult,
  OptionSnapshotsContractsGapResult,
  WatchlistDbCoverageExpirationCache,
  WatchlistDbCoverageOiDaily,
  WatchlistDbCoverageOptionBars,
  WatchlistDbCoverageOptionContracts,
  WatchlistDbCoverageOptionSnapshots,
  WatchlistDbCoverageReportDaily,
  WatchlistDbCoverageSnapshotsWithUd,
  WatchlistDbCoverageSymbolRow,
} from '../../api'
import { InfoTooltip } from '../../components/InfoTooltip'
import { DataOverviewAllGapsSheet } from './DataOverviewAllGapsSheet'
import { DataOverviewBarsAllGapsSheet } from './DataOverviewBarsAllGapsSheet'
import { DataOverviewSnapshotAllGapsSheet } from './DataOverviewSnapshotAllGapsSheet'
import { DataOverviewBarQualitySheet } from './DataOverviewBarQualitySheet'
import { DataOverviewGapExplainSheet } from './DataOverviewGapExplainSheet'
import { DataOverviewSnapshotQualitySheet } from './DataOverviewSnapshotQualitySheet'
import { DataOverviewOptionJobsBar, type DataOverviewOptionJobsBarHandle } from './DataOverviewOptionJobsBar'
import {
  OPTIONS_FOCUS_TABLE_IDS,
  type OptionsFocusDataset,
  type OptionsFocusTableId,
  showFocusTable,
} from './optionFocusDataset'
import {
  DEFAULT_OPTION_MIN_PERIOD,
  type OptionMinIntradayPeriodValue,
} from '../../utils/optionBarPeriods'

const EMPTY_BARS: WatchlistDbCoverageOptionBars = {
  has_data: false,
  row_count: null,
  last_bar_time: null,
  last_created_at: null,
  ohlc_complete_pct: null,
  volume_pct: null,
  vwap_pct: null,
  optional_avg_pct: null,
  distinct_expirations: null,
  distinct_contracts: null,
}

const EMPTY_SUV: WatchlistDbCoverageSnapshotsWithUd = {
  has_data: false,
  row_count: null,
  last_snapshot_ts: null,
  last_created_at: null,
}

const EMPTY_OEC: WatchlistDbCoverageExpirationCache = {
  has_data: false,
  row_count: null,
  last_updated_at: null,
}

const EMPTY_OI: WatchlistDbCoverageOiDaily = {
  has_data: false,
  row_count: null,
  last_trade_date: null,
  last_created_at: null,
}

const EMPTY_MP: WatchlistDbCoverageReportDaily = {
  has_data: false,
  row_count: null,
  last_trade_date: null,
  last_created_at: null,
}

function rowOptionDay(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageOptionBars {
  return r.option_day ?? EMPTY_BARS
}
function rowOptionMin(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageOptionBars {
  return r.option_min ?? EMPTY_BARS
}
function rowSuv(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageSnapshotsWithUd {
  return r.option_snapshots_with_underlying_day ?? EMPTY_SUV
}
function rowOec(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageExpirationCache {
  return r.option_expiration_cache ?? EMPTY_OEC
}
function rowOid(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageOiDaily {
  return r.option_open_interest_daily ?? EMPTY_OI
}
function rowMp(r: WatchlistDbCoverageSymbolRow): WatchlistDbCoverageReportDaily {
  return r.report_option_max_pain_daily ?? EMPTY_MP
}

export type OptionsSubTab = 'summary' | 'by_symbol'

export type { OptionsFocusDataset, OptionsFocusTableId }
export { OPTIONS_FOCUS_TABLE_IDS }

const SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000

function fmtTs(iso: string | null): string {
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

function isoAgeSeconds(iso: string | null): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 1000))
}

function snapshotStale(ts: string | null): boolean {
  if (!ts) return false
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return false
  return Date.now() - t > SNAPSHOT_STALE_MS
}

type RefGapLike = OptionContractsReferenceGapResult | OptionSnapshotsContractsGapResult | OptionBarsContractsGapResult

function formatMassiveRefCell(g: RefGapLike | undefined): string {
  if (!g?.ok || g.massive_total == null) return '—'
  return g.massive_total.toLocaleString()
}

function formatGapCell(g: RefGapLike | undefined): string {
  if (!g?.ok || g.gap == null) return '—'
  const n = g.gap
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString()
}

function gapCellHighlightClass(g: RefGapLike | undefined): string {
  if (!g?.ok || g.gap == null) return ''
  return g.gap === 0
    ? 'data-overview-wl-matrix__gapnum data-overview-wl-matrix__gapnum--ok'
    : 'data-overview-wl-matrix__gapnum data-overview-wl-matrix__gapnum--warn'
}

function covPctCellHighlightClass(g: RefGapLike | undefined): string {
  if (!g?.ok || g.coverage_pct == null) return ''
  return g.coverage_pct === 100
    ? 'data-overview-wl-matrix__covpct data-overview-wl-matrix__covpct--ok'
    : 'data-overview-wl-matrix__covpct data-overview-wl-matrix__covpct--warn'
}

function formatCovPctCell(g: RefGapLike | undefined): string {
  if (!g?.ok || g.coverage_pct == null) return '—'
  return `${g.coverage_pct}%`
}

function formatMismatchCount(hasData: boolean, count: number | null | undefined): string {
  if (!hasData || count == null) return '—'
  return count.toLocaleString()
}

function mismatchHighlightClass(hasData: boolean, count: number | null | undefined): string {
  if (!hasData || count == null) return ''
  return count === 0
    ? 'data-overview-wl-matrix__gapnum data-overview-wl-matrix__gapnum--ok'
    : 'data-overview-wl-matrix__gapnum data-overview-wl-matrix__gapnum--warn'
}

function formatStaleSnapshotRows(hasData: boolean, count: number | null | undefined): string {
  if (!hasData || count == null) return '—'
  return count.toLocaleString()
}

/** Reference/identity and nullable segments: higher % = healthier (same bands as All gaps nullable fill). */
function completenessPctHealthClass(pct: number): string {
  const base = 'data-overview-wl-matrix__completeness-pct'
  if (pct >= 97) return `${base} ${base}--ok`
  if (pct >= 85) return `${base} ${base}--warn`
  return `${base} ${base}--bad`
}

const FOCUS_DATASET_RADIO_NAME = 'data-overview-wl-focus-dataset'

function isCodeDatasetChip(v: OptionsFocusDataset): boolean {
  return v !== 'all' && v !== 'fundamental' && v !== 'staging' && v !== 'report'
}

/** PostgreSQL object class for per-dataset chips (quick scopes have no DB object). */
function dbObjectKind(v: OptionsFocusDataset): 'table' | 'view' | null {
  if (v === 'all' || v === 'fundamental' || v === 'staging' || v === 'report') return null
  return v === 'option_snapshots_with_underlying_day' ? 'view' : 'table'
}

function IconDbTable({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="18" height="16" rx="1.5" />
      <path d="M3 9h18M3 14h18" />
    </svg>
  )
}

/** Stacked planes — SQL VIEW over base tables. */
function IconDbView({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="5" width="14" height="12" rx="1" opacity="0.4" />
      <rect x="6" y="7" width="14" height="12" rx="1" />
    </svg>
  )
}

/** Inline segmented chips (native radios) — no dropdown. */
function FocusDatasetChipSelector({
  value,
  onChange,
}: {
  value: OptionsFocusDataset
  onChange: (v: OptionsFocusDataset) => void
}) {
  const chip = (v: OptionsFocusDataset, label: string, title?: string) => {
    const kind = dbObjectKind(v)
    const tip =
      kind === 'view' && title
        ? `${title} — SQL view`
        : kind === 'table' && title
          ? `${title} — table`
          : title
    return (
      <label
        key={v}
        className="data-overview-focus-chips__chip-wrap"
        title={tip}
      >
        <input
          type="radio"
          name={FOCUS_DATASET_RADIO_NAME}
          value={v}
          checked={value === v}
          onChange={() => onChange(v)}
        />
        <span
          className={`data-overview-focus-chips__chip${isCodeDatasetChip(v) ? ' data-overview-focus-chips__chip--code' : ''}`}
        >
          {kind === 'table' ? (
            <IconDbTable className="data-overview-focus-chips__icon data-overview-focus-chips__icon--table" />
          ) : null}
          {kind === 'view' ? (
            <IconDbView className="data-overview-focus-chips__icon data-overview-focus-chips__icon--view" />
          ) : null}
          <span className="data-overview-focus-chips__chip-label">{label}</span>
        </span>
      </label>
    )
  }

  return (
    <fieldset className="data-overview-focus-chips data-overview-focus-chips--compact">
      <legend className="data-overview-focus-chips__legend">
        <span className="data-overview-focus-chips__legend-text">
          Focus dataset
          <InfoTooltip text="Choose which column groups appear in the matrix. Quick row selects whole layers; named chips pick one dataset. Table and view icons match PostgreSQL: only option_snapshots_with_underlying_day is a SQL VIEW; others are tables." />
        </span>
      </legend>

      <div className="data-overview-focus-chips__matrix" role="presentation">
        <span className="data-overview-focus-chips__rk" title="Quick scope — whole layers">
          Quick
        </span>
        <div className="data-overview-focus-chips__row data-overview-focus-chips__row--quick">
          {chip('all', 'All', 'Show every column group')}
          {chip('fundamental', 'Fundamental', 'Contracts, snapshots, day & minute bars')}
          {chip('staging', 'Staging', 'Underlying join, expirations, open interest')}
          {chip('report', 'Report', 'ATM IV and max pain rollups')}
        </div>

        <span className="data-overview-focus-chips__rk" title="Fundamental tables">
          Fdn
        </span>
        <div className="data-overview-focus-chips__row">
          {chip('option_contracts', 'option_contracts', 'Reference / contract definitions')}
          {chip('option_snapshots', 'option_snapshots', 'Chain & intraday greeks')}
          {chip('option_day', 'option_day', 'Daily option bars')}
          {chip('option_min', 'option_min', 'Minute option bars')}
        </div>

        <span className="data-overview-focus-chips__rk" title="Staging — tables plus one SQL view">
          Stg
        </span>
        <div className="data-overview-focus-chips__row">
          {chip(
            'option_snapshots_with_underlying_day',
            'option_snapshots_with_underlying_day',
            'View joined to underlying stock_day',
          )}
          {chip('option_expiration_cache', 'option_expiration_cache', 'Expiration cache rows')}
          {chip('option_open_interest_daily', 'option_open_interest_daily', 'EOD open interest')}
        </div>

        <span className="data-overview-focus-chips__rk" title="Report tables">
          Rpt
        </span>
        <div className="data-overview-focus-chips__row">
          {chip('report_option_atm_iv_daily', 'report_option_atm_iv_daily', 'ATM implied volatility')}
          {chip('report_option_max_pain_daily', 'report_option_max_pain_daily', 'Max pain by expiry')}
        </div>
      </div>
    </fieldset>
  )
}

interface SummaryRow {
  table: string
  pipeline: string
  coverage: string
  freshness: string
  health: string
}

function maxWorst(
  current: number | null,
  candidate: number | null,
): number | null {
  if (candidate == null) return current
  if (current == null) return candidate
  return Math.max(current, candidate)
}

function buildSummaryRows(rows: WatchlistDbCoverageSymbolRow[]): SummaryRow[] {
  const n = rows.length
  if (n === 0) return []

  let sumContractRows = 0
  let sumMismatch = 0
  let maxContractAge: number | null = null
  let symbolsWithContracts = 0

  let snapWithData = 0
  let maxSnapAge: number | null = null
  let staleSnap = 0

  let atmWithData = 0
  let maxAtmAge: number | null = null

  let odWith = 0
  let maxOdAge: number | null = null
  let omWith = 0
  let maxOmAge: number | null = null
  let suvWith = 0
  let maxSuvAge: number | null = null
  let oecWith = 0
  let maxOecAge: number | null = null
  let oidWith = 0
  let maxOidAge: number | null = null
  let mpWith = 0
  let maxMpAge: number | null = null

  for (const r of rows) {
    const oc = r.option_contracts
    if (oc.has_data && oc.row_count != null) {
      sumContractRows += oc.row_count
      symbolsWithContracts++
      if (oc.mapping_mismatch_count != null) sumMismatch += oc.mapping_mismatch_count
      if (oc.age_seconds != null) {
        maxContractAge = maxWorst(maxContractAge, oc.age_seconds)
      }
    }

    if (r.option_snapshots.has_data && r.option_snapshots.snapshots_last_ts) {
      snapWithData++
      const a = isoAgeSeconds(r.option_snapshots.snapshots_last_ts)
      maxSnapAge = maxWorst(maxSnapAge, a)
      if (snapshotStale(r.option_snapshots.snapshots_last_ts)) staleSnap++
    }

    if (r.report_option_atm_iv_daily.has_data && r.report_option_atm_iv_daily.atm_iv_last_created_at) {
      atmWithData++
      const a = isoAgeSeconds(r.report_option_atm_iv_daily.atm_iv_last_created_at)
      maxAtmAge = maxWorst(maxAtmAge, a)
    }

    const od = rowOptionDay(r)
    const om = rowOptionMin(r)
    const suv = rowSuv(r)
    const oec = rowOec(r)
    const oid = rowOid(r)
    const mp = rowMp(r)
    if (od.has_data) {
      odWith++
      const a = isoAgeSeconds(od.last_created_at ?? od.last_bar_time)
      maxOdAge = maxWorst(maxOdAge, a)
    }
    if (om.has_data) {
      omWith++
      const a = isoAgeSeconds(om.last_created_at ?? om.last_bar_time)
      maxOmAge = maxWorst(maxOmAge, a)
    }
    if (suv.has_data) {
      suvWith++
      const a = isoAgeSeconds(suv.last_created_at ?? suv.last_snapshot_ts)
      maxSuvAge = maxWorst(maxSuvAge, a)
    }
    if (oec.has_data && oec.last_updated_at) {
      oecWith++
      const a = isoAgeSeconds(oec.last_updated_at)
      maxOecAge = maxWorst(maxOecAge, a)
    }
    if (oid.has_data) {
      oidWith++
      const a = isoAgeSeconds(oid.last_created_at ?? oid.last_trade_date)
      maxOidAge = maxWorst(maxOidAge, a)
    }
    if (mp.has_data) {
      mpWith++
      const a = isoAgeSeconds(mp.last_created_at ?? mp.last_trade_date)
      maxMpAge = maxWorst(maxMpAge, a)
    }
  }

  const contractCoverage = symbolsWithContracts > 0 ? `${sumContractRows.toLocaleString()} rows · ${symbolsWithContracts}/${n} symbols` : '—'
  const contractFresh = maxContractAge != null ? `Worst ${fmtAgeSeconds(maxContractAge)}` : '—'
  const contractHealth = symbolsWithContracts > 0 ? (sumMismatch > 0 ? `${sumMismatch.toLocaleString()} mapping mismatch(es)` : 'None') : '—'

  const snapCoverage = `${snapWithData}/${n} symbols`
  const snapFresh = maxSnapAge != null ? `Worst ${fmtAgeSeconds(maxSnapAge)}` : '—'
  const snapHealth = snapWithData > 0 ? (staleSnap > 0 ? `${staleSnap} snapshot(s) older than 24h` : 'OK') : '—'

  const atmCoverage = `${atmWithData}/${n} symbols`
  const atmFresh = maxAtmAge != null ? `Worst ${fmtAgeSeconds(maxAtmAge)}` : '—'

  const odCoverage = `${odWith}/${n} symbols`
  const odFresh = maxOdAge != null ? `Worst ${fmtAgeSeconds(maxOdAge)}` : '—'
  const omCoverage = `${omWith}/${n} symbols`
  const omFresh = maxOmAge != null ? `Worst ${fmtAgeSeconds(maxOmAge)}` : '—'
  const suvCoverage = `${suvWith}/${n} symbols`
  const suvFresh = maxSuvAge != null ? `Worst ${fmtAgeSeconds(maxSuvAge)}` : '—'
  const oecCoverage = `${oecWith}/${n} symbols`
  const oecFresh = maxOecAge != null ? `Worst ${fmtAgeSeconds(maxOecAge)}` : '—'
  const oidCoverage = `${oidWith}/${n} symbols`
  const oidFresh = maxOidAge != null ? `Worst ${fmtAgeSeconds(maxOidAge)}` : '—'
  const mpCoverage = `${mpWith}/${n} symbols`
  const mpFresh = maxMpAge != null ? `Worst ${fmtAgeSeconds(maxMpAge)}` : '—'

  return [
    {
      table: 'option_contracts',
      pipeline: 'Fundamental · reference',
      coverage: contractCoverage,
      freshness: contractFresh,
      health: contractHealth,
    },
    {
      table: 'option_snapshots',
      pipeline: 'Fundamental · chain / intraday',
      coverage: snapCoverage,
      freshness: snapFresh,
      health: snapHealth,
    },
    {
      table: 'option_day',
      pipeline: 'Fundamental · bars',
      coverage: odCoverage,
      freshness: odFresh,
      health: '—',
    },
    {
      table: 'option_min',
      pipeline: 'Fundamental · bars',
      coverage: omCoverage,
      freshness: omFresh,
      health: '—',
    },
    {
      table: 'option_snapshots_with_underlying_day',
      pipeline: 'Staging · view',
      coverage: suvCoverage,
      freshness: suvFresh,
      health: '—',
    },
    {
      table: 'option_expiration_cache',
      pipeline: 'Staging · cache',
      coverage: oecCoverage,
      freshness: oecFresh,
      health: '—',
    },
    {
      table: 'option_open_interest_daily',
      pipeline: 'Staging · EOD OI',
      coverage: oidCoverage,
      freshness: oidFresh,
      health: '—',
    },
    {
      table: 'report_option_atm_iv_daily',
      pipeline: 'Report · derived',
      coverage: atmCoverage,
      freshness: atmFresh,
      health: '—',
    },
    {
      table: 'report_option_max_pain_daily',
      pipeline: 'Report · derived',
      coverage: mpCoverage,
      freshness: mpFresh,
      health: '—',
    },
  ]
}

export interface DataOverviewWatchlistOptionsProps {
  wlRows: WatchlistDbCoverageSymbolRow[]
  subTab: OptionsSubTab
  onSubTabChange: (t: OptionsSubTab) => void
  /** After Massive option jobs complete, or when the user refreshes from the jobs sheet — reload watchlist coverage. */
  onWatchlistRefreshRequested?: () => void | Promise<void>
  /** Per-symbol GET /research/massive/option-contracts-reference-gap results after Compare. */
  refGapBySymbol?: Record<string, OptionContractsReferenceGapResult>
  onCompareMassiveReference?: (
    symbols: string[],
    progress?: {
      onSymbolStart?: (symbol: string) => void
      onSymbolDone?: (symbol: string, result: OptionContractsReferenceGapResult) => void
      onSymbolError?: (symbol: string, message: string) => void
    },
    options?: { maxExpiries?: number },
  ) => void | Promise<void>
  refGapLoading?: boolean
  refGapError?: string | null
  /** Per-symbol GET option-snapshots-contracts-gap after Check (option_snapshots focus). */
  snapshotGapBySymbol?: Record<string, OptionSnapshotsContractsGapResult>
  onCompareSnapshotGap?: (
    symbols: string[],
    progress?: {
      onSymbolStart?: (symbol: string) => void
      onSymbolDone?: (symbol: string, result: OptionSnapshotsContractsGapResult) => void
      onSymbolError?: (symbol: string, message: string) => void
    },
  ) => void | Promise<void>
  snapshotGapLoading?: boolean
  snapshotGapError?: string | null
  /** option_contracts focus: symbols selected via Symbol column (toggle). */
  comparePool?: string[]
  onToggleComparePool?: (symbol: string) => void
  onSelectAllComparePool?: () => void
  onClearComparePool?: () => void
  jobsSheetOpen: boolean
  onJobsSheetOpenChange: (open: boolean) => void
}

export function DataOverviewWatchlistOptions({
  wlRows,
  subTab,
  onSubTabChange,
  onWatchlistRefreshRequested,
  refGapBySymbol = {},
  onCompareMassiveReference,
  refGapLoading = false,
  refGapError = null,
  snapshotGapBySymbol = {},
  onCompareSnapshotGap,
  snapshotGapLoading = false,
  snapshotGapError = null,
  comparePool = [],
  onToggleComparePool,
  onSelectAllComparePool,
  onClearComparePool,
  jobsSheetOpen,
  onJobsSheetOpenChange,
}: DataOverviewWatchlistOptionsProps) {
  const summaryRows = buildSummaryRows(wlRows)
  const [focusDataset, setFocusDataset] = useState<OptionsFocusDataset>('all')
  const prevFocusRef = useRef<OptionsFocusDataset>(focusDataset)
  const jobsBarRef = useRef<DataOverviewOptionJobsBarHandle | null>(null)
  const [allGapsSheetMode, setAllGapsSheetMode] = useState<
    null | 'contracts' | 'snapshots' | 'bars_day' | 'bars_min'
  >(null)
  const [gapExplainSheetOpen, setGapExplainSheetOpen] = useState(false)
  const [snapshotQualitySymbol, setSnapshotQualitySymbol] = useState<string | null>(null)

  /** Bars gap (option_day / option_min) — local state, no external prop required. */
  const [barsGapBySymbol, setBarsGapBySymbol] = useState<Record<string, OptionBarsContractsGapResult>>({})
  const [barsGapLoading, setBarsGapLoading] = useState(false)
  const [barsGapError, setBarsGapError] = useState<string | null>(null)

  /** Detail sheet for bar-quality breakdown. */
  const [barQualitySymbol, setBarQualitySymbol] = useState<string | null>(null)
  const [barQualityTable, setBarQualityTable] = useState<'option_day' | 'option_min'>('option_day')
  const [optionMinPeriod, setOptionMinPeriod] = useState<OptionMinIntradayPeriodValue>(DEFAULT_OPTION_MIN_PERIOD)

  const BARS_DATASETS = useMemo(() => new Set<OptionsFocusDataset>(['option_day', 'option_min']), [])

  const handleCompareBarsGap = useCallback(async (
    symbols: string[],
    progress?: {
      onSymbolStart?: (s: string) => void
      onSymbolDone?: (s: string, r: OptionBarsContractsGapResult) => void
      onSymbolError?: (s: string, msg: string) => void
    },
  ) => {
    const table = (focusDataset === 'option_min' ? 'option_min' : 'option_day') as 'option_day' | 'option_min'
    const period = focusDataset === 'option_min' ? optionMinPeriod : undefined
    setBarsGapLoading(true)
    setBarsGapError(null)
    try {
      for (const sym of symbols) {
        progress?.onSymbolStart?.(sym)
        try {
          const res = await postOptionBarsContractsGapBatch([sym], table, period)
          const r: OptionBarsContractsGapResult = res.results?.[sym] ?? { ok: false, error: 'No result' }
          setBarsGapBySymbol(prev => ({ ...prev, [sym]: r }))
          progress?.onSymbolDone?.(sym, r)
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          setBarsGapBySymbol(prev => ({ ...prev, [sym]: { ok: false, error: msg } }))
          progress?.onSymbolError?.(sym, msg)
        }
      }
    } finally {
      setBarsGapLoading(false)
    }
  }, [focusDataset, optionMinPeriod])

  useEffect(() => {
    const prev = prevFocusRef.current
    const prevBars = BARS_DATASETS.has(prev)
    const curBars = BARS_DATASETS.has(focusDataset)
    if (
      (prev === 'option_contracts' && focusDataset !== 'option_contracts') ||
      (prev === 'option_snapshots' && focusDataset !== 'option_snapshots') ||
      (prevBars && !curBars)
    ) {
      onClearComparePool?.()
    }
    // Reset bars gap state when changing between option_day and option_min
    if (prevBars && curBars && prev !== focusDataset) {
      setBarsGapBySymbol({})
    }
    prevFocusRef.current = focusDataset
  }, [focusDataset, onClearComparePool, BARS_DATASETS])

  useEffect(() => {
    if (
      focusDataset !== 'option_contracts' &&
      focusDataset !== 'option_snapshots' &&
      focusDataset !== 'option_day' &&
      focusDataset !== 'option_min'
    ) {
      setAllGapsSheetMode(null)
      setGapExplainSheetOpen(false)
    }
  }, [focusDataset])

  useEffect(() => {
    if (subTab !== 'by_symbol') {
      onJobsSheetOpenChange(false)
      setAllGapsSheetMode(null)
      setGapExplainSheetOpen(false)
    }
  }, [subTab, onJobsSheetOpenChange])

  const show = (t: OptionsFocusTableId) => showFocusTable(focusDataset, t)

  const optionContractsBySymbol = useMemo(() => {
    const m: Record<string, WatchlistDbCoverageOptionContracts> = {}
    for (const r of wlRows) {
      m[r.symbol.trim().toUpperCase()] = r.option_contracts
    }
    return m
  }, [wlRows])

  const optionDayBySymbol = useMemo(() => {
    const m: Record<string, WatchlistDbCoverageOptionBars> = {}
    for (const r of wlRows) {
      const od = r.option_day
      if (od) m[r.symbol.trim().toUpperCase()] = od
    }
    return m
  }, [wlRows])

  const optionSnapshotsBySymbol = useMemo(() => {
    const m: Record<string, WatchlistDbCoverageOptionSnapshots> = {}
    for (const r of wlRows) {
      m[r.symbol.trim().toUpperCase()] = r.option_snapshots
    }
    return m
  }, [wlRows])

  return (
    <>
      <div className="feed-massive-agg-tabs-wrap" style={{ marginBottom: 'var(--space-3)' }}>
        <div className="feed-massive-agg-tabs" role="tablist" aria-label="Watchlist Options view">
          <button
            type="button"
            role="tab"
            id="data-overview-wl-opt-sub-summary"
            className={`feed-massive-agg-tab${subTab === 'summary' ? ' feed-massive-agg-tab--active' : ''}`}
            aria-selected={subTab === 'summary'}
            tabIndex={subTab === 'summary' ? 0 : -1}
            onClick={() => onSubTabChange('summary')}
          >
            Summary
          </button>
          <button
            type="button"
            role="tab"
            id="data-overview-wl-opt-sub-bysymbol"
            className={`feed-massive-agg-tab${subTab === 'by_symbol' ? ' feed-massive-agg-tab--active' : ''}`}
            aria-selected={subTab === 'by_symbol'}
            tabIndex={subTab === 'by_symbol' ? 0 : -1}
            onClick={() => onSubTabChange('by_symbol')}
          >
            By symbol
          </button>
        </div>
      </div>

      {subTab === 'summary' ? (
        <div className="replay-section" style={{ marginBottom: 'var(--space-3)' }}>
          <h4 className="page-title-with-tooltip" style={{ marginBottom: 'var(--space-2)', fontSize: 'var(--text-body)' }}>
            Option datasets (watchlist summary)
            <InfoTooltip text="Watchlist-scoped aggregates across symbols (max 80). Freshness shows the worst (stalest) symbol per table. Compare with Global PostgreSQL coverage for whole-database distinct counts." />
          </h4>
          <div className="feed-massive-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Table</th>
                  <th scope="col">Pipeline</th>
                  <th scope="col">Coverage</th>
                  <th scope="col">
                    Freshness
                    <InfoTooltip text="Worst-case age across watchlist symbols for this table. option_contracts uses server age_seconds; others use parsed timestamps from the API." />
                  </th>
                  <th scope="col">Health</th>
                </tr>
              </thead>
              <tbody>
                {summaryRows.map(row => (
                  <tr key={row.table}>
                    <td><code>{row.table}</code></td>
                    <td style={{ fontSize: 'var(--text-caption)' }}>{row.pipeline}</td>
                    <td style={{ fontSize: 'var(--text-caption)' }}>{row.coverage}</td>
                    <td style={{ fontSize: 'var(--text-caption)' }}>{row.freshness}</td>
                    <td style={{ fontSize: 'var(--text-caption)' }}>{row.health}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <p style={{ fontSize: 'var(--text-caption)', color: 'var(--color-text-muted)', marginBottom: 'var(--space-2)' }}>
            One sheet per symbol: grouped columns for each dataset. Scroll horizontally to see all columns; the Symbol column stays fixed.
          </p>
          <div style={{ marginBottom: 'var(--space-3)' }}>
            <FocusDatasetChipSelector value={focusDataset} onChange={setFocusDataset} />
          </div>

          <DataOverviewOptionJobsBar
            ref={jobsBarRef}
            focusDataset={focusDataset}
            wlSymbols={wlRows.map(r => r.symbol)}
            symbolsWithOptionContractsData={wlRows.filter(r => r.option_contracts.has_data).map(r => r.symbol)}
            onWatchlistRefreshRequested={onWatchlistRefreshRequested}
            refGapBySymbol={refGapBySymbol}
            onCompareMassiveReference={onCompareMassiveReference}
            refGapLoading={refGapLoading}
            refGapError={refGapError}
            snapshotGapBySymbol={snapshotGapBySymbol}
            onCompareSnapshotGap={onCompareSnapshotGap}
            snapshotGapLoading={snapshotGapLoading}
            snapshotGapError={snapshotGapError}
            barsGapBySymbol={barsGapBySymbol}
            onCompareBarsGap={handleCompareBarsGap}
            barsGapLoading={barsGapLoading}
            barsGapError={barsGapError}
            comparePool={comparePool}
            optionContractsBySymbol={optionContractsBySymbol}
            optionDayBySymbol={optionDayBySymbol}
            optionSnapshotsBySymbol={optionSnapshotsBySymbol}
            onSelectAllComparePool={onSelectAllComparePool}
            onClearComparePool={onClearComparePool}
            jobsSheetOpen={jobsSheetOpen}
            onJobsSheetOpenChange={onJobsSheetOpenChange}
            onOpenAllGapsSheet={
              focusDataset === 'option_contracts'
                ? () => setAllGapsSheetMode('contracts')
                : focusDataset === 'option_snapshots'
                  ? () => setAllGapsSheetMode('snapshots')
                  : focusDataset === 'option_day'
                    ? () => setAllGapsSheetMode('bars_day')
                    : focusDataset === 'option_min'
                      ? () => setAllGapsSheetMode('bars_min')
                      : undefined
            }
            onOpenGapExplainSheet={
              focusDataset === 'option_contracts' ||
              focusDataset === 'option_snapshots' ||
              focusDataset === 'option_day' ||
              focusDataset === 'option_min'
                ? () => setGapExplainSheetOpen(true)
                : undefined
            }
            optionMinPeriod={optionMinPeriod}
            onOptionMinPeriodChange={(p: string) =>
              setOptionMinPeriod(p as OptionMinIntradayPeriodValue)
            }
          />

          <DataOverviewGapExplainSheet
            open={gapExplainSheetOpen}
            onClose={() => setGapExplainSheetOpen(false)}
            variant={
              focusDataset === 'option_snapshots'
                ? 'snapshots'
                : focusDataset === 'option_day'
                  ? 'option_day_bars'
                  : focusDataset === 'option_min'
                    ? 'option_min_bars'
                    : 'contracts'
            }
          />

          <DataOverviewAllGapsSheet
            open={allGapsSheetMode === 'contracts'}
            onClose={() => setAllGapsSheetMode(null)}
            wlRows={wlRows}
            comparePool={comparePool}
            refGapBySymbol={refGapBySymbol}
            fillApiRef={jobsBarRef}
          />

          <DataOverviewSnapshotAllGapsSheet
            open={allGapsSheetMode === 'snapshots'}
            onClose={() => setAllGapsSheetMode(null)}
            comparePool={comparePool}
            snapshotGapBySymbol={snapshotGapBySymbol}
            fillApiRef={jobsBarRef}
          />

          <DataOverviewBarsAllGapsSheet
            open={allGapsSheetMode === 'bars_day' || allGapsSheetMode === 'bars_min'}
            onClose={() => setAllGapsSheetMode(null)}
            comparePool={comparePool}
            barsGapBySymbol={barsGapBySymbol}
            table={allGapsSheetMode === 'bars_min' ? 'option_min' : 'option_day'}
            optionMinPeriod={optionMinPeriod}
            fillApiRef={jobsBarRef}
          />

          <DataOverviewSnapshotQualitySheet
            open={snapshotQualitySymbol !== null}
            onClose={() => setSnapshotQualitySymbol(null)}
            symbol={snapshotQualitySymbol}
          />

          <DataOverviewBarQualitySheet
            open={barQualitySymbol !== null}
            onClose={() => setBarQualitySymbol(null)}
            symbol={barQualitySymbol}
            table={barQualityTable}
          />

          <div className="replay-section data-overview-wl-matrix" style={{ marginBottom: 'var(--space-3)' }}>
            <div className="feed-massive-table-wrap">
              <table className="data-table data-overview-wl-matrix__table">
                <thead>
                  <tr>
                    <th className="data-overview-wl-matrix__sticky-col" rowSpan={2} scope="col">Symbol</th>
                    {show('option_contracts') ? (
                      <th colSpan={8} scope="colgroup"><code>option_contracts</code></th>
                    ) : null}
                    {show('option_snapshots') ? (
                      <th colSpan={7} scope="colgroup"><code>option_snapshots</code></th>
                    ) : null}
                    {show('option_day') ? (
                      <th colSpan={7} scope="colgroup"><code>option_day</code></th>
                    ) : null}
                    {show('option_min') ? (
                      <th colSpan={7} scope="colgroup"><code>option_min</code></th>
                    ) : null}
                    {show('option_snapshots_with_underlying_day') ? (
                      <th colSpan={3} scope="colgroup"><code>option_snapshots_with_underlying_day</code></th>
                    ) : null}
                    {show('option_expiration_cache') ? (
                      <th colSpan={2} scope="colgroup"><code>option_expiration_cache</code></th>
                    ) : null}
                    {show('option_open_interest_daily') ? (
                      <th colSpan={3} scope="colgroup"><code>option_open_interest_daily</code></th>
                    ) : null}
                    {show('report_option_atm_iv_daily') ? (
                      <th colSpan={2} scope="colgroup"><code>report_option_atm_iv_daily</code></th>
                    ) : null}
                    {show('report_option_max_pain_daily') ? (
                      <th colSpan={3} scope="colgroup"><code>report_option_max_pain_daily</code></th>
                    ) : null}
                  </tr>
                  <tr>
                    {show('option_contracts') ? (
                      <>
                        <th scope="col">
                          Age since last row
                          <InfoTooltip text="Based on max(created_at) in option_contracts — time since the most recently inserted contract row." />
                        </th>
                        <th scope="col">
                          Last Check
                          <InfoTooltip text="Time since the last option_contracts sync run for this symbol (from job_ticker_reference_state). Updates every time the contracts service runs, even when no new rows are inserted." />
                        </th>
                        <th scope="col">
                          Completeness
                          <InfoTooltip text="First: avg(ticker %, identity %). Identity in API = non-empty symbol, expiry, option_right; contract_key, strike, option_right are NOT NULL in DB. Second: avg nullable data fill (exercise_style, shares_per_contract). Each % is colored by health (≥97% green, 85–96.9% amber, &lt;85% red). See All gaps for column groups." />
                        </th>
                        <th scope="col">Rows</th>
                        <th scope="col">
                          Ref
                          <InfoTooltip text="Massive GET /v3/reference/options/contracts — paginated count per PG expiry, summed. Run Compare to Massive in the bar above. Does not discover expiries that exist only on the API." />
                        </th>
                        <th scope="col">
                          Gap
                          <InfoTooltip text="Pair ref_gap / mismatch. Left: Σ (Massive reference count − PG rows matched by contract_key) after Check. Right: PG rows with massive_option_ticker but contract_key missing symbol substring. Green when 0, red when non-zero." />
                        </th>
                        <th scope="col">
                          Cov%
                          <InfoTooltip text="100 × (PG rows whose contract_key appears in the Massive reference list) ÷ Massive reference row total. Never above 100% because only matched PG rows are counted." />
                        </th>
                        <th scope="col">Expiries / strikes</th>
                      </>
                    ) : null}
                    {show('option_snapshots') ? (
                      <>
                        <th scope="col">
                          Age since last snapshot
                          <InfoTooltip text="Based on max(snapshot_ts) over latest row per contract_key (Massive source). Same semantics as snapshot_ts in coverage APIs." />
                        </th>
                        <th scope="col">
                          Completeness
                          <InfoTooltip text="First: avg(IV %, full greeks %). Full greeks = all of delta, gamma, theta, vega on latest row per contract. Second: avg of full greeks % and open interest % (nullable-style fields). ≥97% green, 85–96.9% amber, &lt;85% red." />
                        </th>
                        <th scope="col">Rows</th>
                        <th scope="col">
                          Ref
                          <InfoTooltip text="After Check: summed Ref from Massive GET /v3/snapshot/options/{underlying} intersected with option_contracts.contract_key per expiry. Run Check in the bar above." />
                        </th>
                        <th scope="col">
                          Gap
                          <InfoTooltip text="Pair snapshot gap / stale. Left: Ref − PG distinct contract_keys with option_snapshots after Check. Right: latest rows older than 24h (per contract)." />
                        </th>
                        <th scope="col">
                          Cov%
                          <InfoTooltip text="100 × PG matched ÷ Ref for the chain snapshot comparison. Never above 100% for this definition." />
                        </th>
                        <th scope="col">
                          OC exp / stk
                          <InfoTooltip text="Distinct expiries and strikes in option_contracts for this symbol (reference shape)." />
                        </th>
                      </>
                    ) : null}
                    {show('option_day') ? (
                      <>
                        <th scope="col">
                          Age
                          <InfoTooltip text="Time since most recent bar in option_day (Massive source)." />
                        </th>
                        <th scope="col">
                          Completeness
                          <InfoTooltip text="First: OHLC complete % (all four non-null). Second: avg(volume %, VWAP %). ≥97% green, 85–96.9% amber, &lt;85% red." />
                        </th>
                        <th scope="col">Rows</th>
                        <th scope="col">
                          Ref
                          <InfoTooltip text="After Check: distinct (expiry, strike, right) combinations in option_contracts for this symbol (reference shape). Run Check in the bar above." />
                        </th>
                        <th scope="col">
                          Gap
                          <InfoTooltip text="Ref − covered. Covered = option_day has ≥1 bar for that (expiry, strike, right) key. Green when 0." />
                        </th>
                        <th scope="col">
                          Cov%
                          <InfoTooltip text="100 × covered ÷ Ref after Check. Never above 100% for this definition." />
                        </th>
                        <th scope="col">
                          Exp / Contracts
                          <InfoTooltip text="Distinct expiries / distinct (expiry, strike, right) keys in option_day for this symbol." />
                        </th>
                      </>
                    ) : null}
                    {show('option_min') ? (
                      <>
                        <th scope="col">
                          Age
                          <InfoTooltip text="Time since most recent bar in option_min (Massive source)." />
                        </th>
                        <th scope="col">
                          Completeness
                          <InfoTooltip text="First: OHLC complete % (all four non-null). Second: avg(volume %, VWAP %). ≥97% green, 85–96.9% amber, &lt;85% red." />
                        </th>
                        <th scope="col">Rows</th>
                        <th scope="col">
                          Ref
                          <InfoTooltip text="After Check: distinct (expiry, strike, right) combinations in option_contracts for this symbol (reference shape). Run Check in the bar above." />
                        </th>
                        <th scope="col">
                          Gap
                          <InfoTooltip text="Ref − covered. Covered = option_min has ≥1 bar for that (expiry, strike, right) key. Green when 0." />
                        </th>
                        <th scope="col">
                          Cov%
                          <InfoTooltip text="100 × covered ÷ Ref after Check. Never above 100% for this definition." />
                        </th>
                        <th scope="col">
                          Exp / Contracts
                          <InfoTooltip text="Distinct expiries / distinct (expiry, strike, right) keys in option_min for this symbol." />
                        </th>
                      </>
                    ) : null}
                    {show('option_snapshots_with_underlying_day') ? (
                      <>
                        <th scope="col">Rows</th>
                        <th scope="col">Last snapshot</th>
                        <th scope="col">Last created</th>
                      </>
                    ) : null}
                    {show('option_expiration_cache') ? (
                      <>
                        <th scope="col">Rows</th>
                        <th scope="col">Last updated</th>
                      </>
                    ) : null}
                    {show('option_open_interest_daily') ? (
                      <>
                        <th scope="col">Rows</th>
                        <th scope="col">Last trade date</th>
                        <th scope="col">Last created</th>
                      </>
                    ) : null}
                    {show('report_option_atm_iv_daily') ? (
                      <>
                        <th scope="col">Last trade date</th>
                        <th scope="col">Last created</th>
                      </>
                    ) : null}
                    {show('report_option_max_pain_daily') ? (
                      <>
                        <th scope="col">Rows</th>
                        <th scope="col">Last trade date</th>
                        <th scope="col">Last created</th>
                      </>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {wlRows.map(r => {
                    const oc = r.option_contracts
                    const od = rowOptionDay(r)
                    const om = rowOptionMin(r)
                    const suv = rowSuv(r)
                    const oec = rowOec(r)
                    const oid = rowOid(r)
                    const mp = rowMp(r)
                    const ticker = oc.ticker_pct
                    const ident = oc.identity_pct
                    const dataAvgPct =
                      oc.optional_data_fill_avg_pct ??
                      (oc.exercise_style_pct != null && oc.shares_per_contract_pct != null
                        ? Math.round(((oc.exercise_style_pct + oc.shares_per_contract_pct) / 2) * 10) / 10
                        : null)
                    /** Single merged % for identity+reference (avg of ticker and id); second segment = nullable data avg. No text labels in cell. */
                    const refMergedPct =
                      oc.has_data && ticker != null && ident != null
                        ? Math.round(((ticker + ident) / 2) * 10) / 10
                        : null
                    const completenessTitle =
                      oc.has_data && refMergedPct != null
                        ? `First ${refMergedPct}%: avg(ticker, identity). Identity columns include contract_key, symbol, expiry, strike, option_right (DB NOT NULL). Second ${dataAvgPct != null ? `${dataAvgPct}%` : '—'}: nullable data (exercise_style, shares_per_contract). Column groups: All gaps (once).`
                        : undefined
                    const st = r.option_snapshots.snapshots_last_ts
                    const symU = r.symbol.trim().toUpperCase()
                    const refG = refGapBySymbol[symU]
                    const snapG = snapshotGapBySymbol[symU]
                    const os = r.option_snapshots
                    const ivp = os.iv_pct
                    const fgp = os.full_greeks_pct
                    const snapRefMerged =
                      os.has_data && ivp != null && fgp != null
                        ? Math.round(((ivp + fgp) / 2) * 10) / 10
                        : null
                    const snapDataAvg = os.optional_data_fill_avg_pct ?? null
                    const snapCompletenessTitle =
                      os.has_data && snapRefMerged != null
                        ? `First ${snapRefMerged}%: avg(IV, full greeks). Second ${snapDataAvg != null ? `${snapDataAvg}%` : '—'}: avg(full greeks %, OI %) on latest per contract.`
                        : undefined
                    const inPool = comparePool.includes(symU)
                    const isPoolableDataset =
                      focusDataset === 'option_contracts' ||
                      focusDataset === 'option_snapshots' ||
                      focusDataset === 'option_day' ||
                      focusDataset === 'option_min'
                    const symToggle =
                      isPoolableDataset && onToggleComparePool ? (
                        <>
                          <button
                            type="button"
                            className={`data-overview-wl-matrix__sym-btn${inPool ? ' data-overview-wl-matrix__sym-btn--on' : ''}`}
                            onClick={() => onToggleComparePool(r.symbol)}
                            aria-pressed={inPool}
                            title={inPool ? 'Remove from compare pool' : 'Add to compare pool'}
                          >
                            {r.symbol}
                          </button>
                          {focusDataset === 'option_snapshots' ? (
                            <button
                              type="button"
                              className="data-overview-wl-matrix__sym-detail-btn"
                              onClick={() => setSnapshotQualitySymbol(r.symbol)}
                              title="Open snapshot quality detail"
                              aria-label={`Snapshot quality detail for ${r.symbol}`}
                            >
                              ↗
                            </button>
                          ) : null}
                          {(focusDataset === 'option_day' ||
                            focusDataset === 'option_min' ||
                            focusDataset === 'option_contracts') ? (
                            <button
                              type="button"
                              className="data-overview-wl-matrix__sym-detail-btn"
                              onClick={() => {
                                if (focusDataset === 'option_contracts') {
                                  setBarQualityTable('option_day')
                                } else {
                                  setBarQualityTable(focusDataset)
                                }
                                setBarQualitySymbol(r.symbol)
                              }}
                              title={
                                focusDataset === 'option_contracts'
                                  ? 'Open bar quality detail (option_day daily bars)'
                                  : 'Open bar quality detail'
                              }
                              aria-label={
                                focusDataset === 'option_contracts'
                                  ? `Bar quality for ${r.symbol} (option_day)`
                                  : `Bar quality detail for ${r.symbol}`
                              }
                            >
                              ↗
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <strong>{r.symbol}</strong>
                      )
                    return (
                      <tr
                        key={r.symbol}
                        className={
                          inPool && isPoolableDataset
                            ? 'data-overview-wl-matrix__row--pool'
                            : undefined
                        }
                      >
                        <th className="data-overview-wl-matrix__sticky-col" scope="row">{symToggle}</th>
                        {show('option_contracts') ? (
                          <>
                            <td
                              style={{ fontSize: 'var(--text-caption)' }}
                              title={oc.newest_created_at ? `newest_created_at: ${oc.newest_created_at}` : undefined}
                            >
                              {fmtAgeSeconds(oc.age_seconds)}
                            </td>
                            <td
                              style={{ fontSize: 'var(--text-caption)' }}
                              title={oc.last_check_at ? `last_check_at: ${oc.last_check_at}` : 'No check recorded yet'}
                            >
                              {fmtAgeSeconds(oc.last_check_age_seconds)}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }} title={completenessTitle}>
                              {oc.has_data && refMergedPct != null ? (
                                dataAvgPct != null ? (
                                  <>
                                    <span className={completenessPctHealthClass(refMergedPct)}>
                                      {refMergedPct}%
                                    </span>
                                    <span className="data-overview-wl-matrix__completeness-sep" aria-hidden="true">
                                      {' '}
                                      ·{' '}
                                    </span>
                                    <span className={completenessPctHealthClass(dataAvgPct)}>{dataAvgPct}%</span>
                                  </>
                                ) : (
                                  <span className={completenessPctHealthClass(refMergedPct)}>{refMergedPct}%</span>
                                )
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{oc.has_data && oc.row_count != null ? oc.row_count : '—'}</td>
                            <td className="data-overview-wl-matrix__refcell">
                              {formatMassiveRefCell(refG)}
                            </td>
                            <td
                              className="data-overview-wl-matrix__refcell"
                              title="Reference gap / mapping mismatch (after Check for left value)"
                            >
                              <span className="data-overview-wl-matrix__gap-mm">
                                <span className={gapCellHighlightClass(refG)}>{formatGapCell(refG)}</span>
                                <span className="data-overview-wl-matrix__gap-mm__sep" aria-hidden="true">
                                  /
                                </span>
                                <span className={mismatchHighlightClass(oc.has_data, oc.mapping_mismatch_count)}>
                                  {formatMismatchCount(oc.has_data, oc.mapping_mismatch_count)}
                                </span>
                              </span>
                            </td>
                            <td className="data-overview-wl-matrix__refcell">
                              <span className={covPctCellHighlightClass(refG)}>{formatCovPctCell(refG)}</span>
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {oc.has_data && oc.distinct_expirations != null && oc.distinct_strikes != null
                                ? `${oc.distinct_expirations} / ${oc.distinct_strikes}`
                                : '—'}
                            </td>
                          </>
                        ) : null}
                        {show('option_snapshots') ? (
                          <>
                            <td
                              style={{ fontSize: 'var(--text-caption)' }}
                              title={os.snapshots_last_ts ? `snapshot_ts max: ${os.snapshots_last_ts}` : undefined}
                            >
                              {fmtAgeSeconds(os.age_seconds ?? (st ? isoAgeSeconds(st) : null))}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }} title={snapCompletenessTitle}>
                              {os.has_data && snapRefMerged != null ? (
                                snapDataAvg != null ? (
                                  <>
                                    <span className={completenessPctHealthClass(snapRefMerged)}>
                                      {snapRefMerged}%
                                    </span>
                                    <span className="data-overview-wl-matrix__completeness-sep" aria-hidden="true">
                                      {' '}
                                      ·{' '}
                                    </span>
                                    <span className={completenessPctHealthClass(snapDataAvg)}>{snapDataAvg}%</span>
                                  </>
                                ) : (
                                  <span className={completenessPctHealthClass(snapRefMerged)}>{snapRefMerged}%</span>
                                )
                              ) : (
                                '—'
                              )}
                            </td>
                            <td>{os.has_data && os.row_count != null ? os.row_count : '—'}</td>
                            <td className="data-overview-wl-matrix__refcell">{formatMassiveRefCell(snapG)}</td>
                            <td
                              className="data-overview-wl-matrix__refcell"
                              title="Snapshot gap / stale rows (after Check for left value)"
                            >
                              <span className="data-overview-wl-matrix__gap-mm">
                                <span className={gapCellHighlightClass(snapG)}>{formatGapCell(snapG)}</span>
                                <span className="data-overview-wl-matrix__gap-mm__sep" aria-hidden="true">
                                  /
                                </span>
                                <span className={mismatchHighlightClass(os.has_data, os.stale_snapshot_rows)}>
                                  {formatStaleSnapshotRows(os.has_data, os.stale_snapshot_rows)}
                                </span>
                              </span>
                            </td>
                            <td className="data-overview-wl-matrix__refcell">
                              <span className={covPctCellHighlightClass(snapG)}>{formatCovPctCell(snapG)}</span>
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {oc.has_data && oc.distinct_expirations != null && oc.distinct_strikes != null
                                ? `${oc.distinct_expirations} / ${oc.distinct_strikes}`
                                : '—'}
                            </td>
                          </>
                        ) : null}
                        {show('option_day') ? (() => {
                          const odBarsGap = barsGapBySymbol[symU]
                          const odAge = od.has_data ? isoAgeSeconds(od.last_bar_time ?? od.last_created_at) : null
                          const odOhlc = od.ohlc_complete_pct
                          const odOptAvg = od.optional_avg_pct
                          return (
                            <>
                              <td style={{ fontSize: 'var(--text-caption)' }}
                                title={od.last_bar_time ? `last_bar_time: ${od.last_bar_time}` : undefined}
                              >
                                {fmtAgeSeconds(odAge)}
                              </td>
                              <td style={{ fontSize: 'var(--text-caption)' }}>
                                {od.has_data && odOhlc != null ? (
                                  odOptAvg != null ? (
                                    <>
                                      <span className={completenessPctHealthClass(odOhlc)}>{odOhlc}%</span>
                                      <span className="data-overview-wl-matrix__completeness-sep" aria-hidden="true"> · </span>
                                      <span className={completenessPctHealthClass(odOptAvg)}>{odOptAvg}%</span>
                                    </>
                                  ) : (
                                    <span className={completenessPctHealthClass(odOhlc)}>{odOhlc}%</span>
                                  )
                                ) : '—'}
                              </td>
                              <td>{od.has_data && od.row_count != null ? od.row_count.toLocaleString() : '—'}</td>
                              <td className="data-overview-wl-matrix__refcell">{formatMassiveRefCell(odBarsGap)}</td>
                              <td className="data-overview-wl-matrix__refcell">
                                <span className={gapCellHighlightClass(odBarsGap)}>{formatGapCell(odBarsGap)}</span>
                              </td>
                              <td className="data-overview-wl-matrix__refcell">
                                <span className={covPctCellHighlightClass(odBarsGap)}>{formatCovPctCell(odBarsGap)}</span>
                              </td>
                              <td style={{ fontSize: 'var(--text-caption)' }}>
                                {od.has_data && od.distinct_expirations != null && od.distinct_contracts != null
                                  ? `${od.distinct_expirations} / ${od.distinct_contracts.toLocaleString()}`
                                  : '—'}
                              </td>
                            </>
                          )
                        })() : null}
                        {show('option_min') ? (() => {
                          const omBarsGap = barsGapBySymbol[symU]
                          const omAge = om.has_data ? isoAgeSeconds(om.last_bar_time ?? om.last_created_at) : null
                          const omOhlc = om.ohlc_complete_pct
                          const omOptAvg = om.optional_avg_pct
                          return (
                            <>
                              <td style={{ fontSize: 'var(--text-caption)' }}
                                title={om.last_bar_time ? `last_bar_time: ${om.last_bar_time}` : undefined}
                              >
                                {fmtAgeSeconds(omAge)}
                              </td>
                              <td style={{ fontSize: 'var(--text-caption)' }}>
                                {om.has_data && omOhlc != null ? (
                                  omOptAvg != null ? (
                                    <>
                                      <span className={completenessPctHealthClass(omOhlc)}>{omOhlc}%</span>
                                      <span className="data-overview-wl-matrix__completeness-sep" aria-hidden="true"> · </span>
                                      <span className={completenessPctHealthClass(omOptAvg)}>{omOptAvg}%</span>
                                    </>
                                  ) : (
                                    <span className={completenessPctHealthClass(omOhlc)}>{omOhlc}%</span>
                                  )
                                ) : '—'}
                              </td>
                              <td>{om.has_data && om.row_count != null ? om.row_count.toLocaleString() : '—'}</td>
                              <td className="data-overview-wl-matrix__refcell">{formatMassiveRefCell(omBarsGap)}</td>
                              <td className="data-overview-wl-matrix__refcell">
                                <span className={gapCellHighlightClass(omBarsGap)}>{formatGapCell(omBarsGap)}</span>
                              </td>
                              <td className="data-overview-wl-matrix__refcell">
                                <span className={covPctCellHighlightClass(omBarsGap)}>{formatCovPctCell(omBarsGap)}</span>
                              </td>
                              <td style={{ fontSize: 'var(--text-caption)' }}>
                                {om.has_data && om.distinct_expirations != null && om.distinct_contracts != null
                                  ? `${om.distinct_expirations} / ${om.distinct_contracts.toLocaleString()}`
                                  : '—'}
                              </td>
                            </>
                          )
                        })() : null}
                        {show('option_snapshots_with_underlying_day') ? (
                          <>
                            <td>
                              {suv.has_data && suv.row_count != null ? suv.row_count : '—'}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {suv.has_data ? fmtTs(suv.last_snapshot_ts) : '—'}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {suv.has_data ? fmtTs(suv.last_created_at) : '—'}
                            </td>
                          </>
                        ) : null}
                        {show('option_expiration_cache') ? (
                          <>
                            <td>{oec.has_data && oec.row_count != null ? oec.row_count : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {oec.has_data ? fmtTs(oec.last_updated_at) : '—'}
                            </td>
                          </>
                        ) : null}
                        {show('option_open_interest_daily') ? (
                          <>
                            <td>{oid.has_data && oid.row_count != null ? oid.row_count : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {oid.has_data ? fmtTs(oid.last_trade_date) : '—'}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {oid.has_data ? fmtTs(oid.last_created_at) : '—'}
                            </td>
                          </>
                        ) : null}
                        {show('report_option_atm_iv_daily') ? (
                          <>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {r.report_option_atm_iv_daily.has_data
                                ? fmtTs(r.report_option_atm_iv_daily.atm_iv_last_trade_date)
                                : '—'}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {r.report_option_atm_iv_daily.has_data
                                ? fmtTs(r.report_option_atm_iv_daily.atm_iv_last_created_at)
                                : '—'}
                            </td>
                          </>
                        ) : null}
                        {show('report_option_max_pain_daily') ? (
                          <>
                            <td>{mp.has_data && mp.row_count != null ? mp.row_count : '—'}</td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {mp.has_data ? fmtTs(mp.last_trade_date) : '—'}
                            </td>
                            <td style={{ fontSize: 'var(--text-caption)' }}>
                              {mp.has_data ? fmtTs(mp.last_created_at) : '—'}
                            </td>
                          </>
                        ) : null}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  )
}
