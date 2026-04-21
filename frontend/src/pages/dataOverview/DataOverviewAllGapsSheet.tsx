import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RefObject } from 'react'
import type {
  OptionContractsReferenceGapExpiryRow,
  OptionContractsReferenceGapResult,
  WatchlistDbCoverageOptionContracts,
  WatchlistDbCoverageSymbolRow,
} from '../../api'
import type {
  DataOverviewOptionJobsBarHandle,
  NullableOptionContractsColumnCode,
} from './DataOverviewOptionJobsBar'

/** Stateful fill-button for symbols with no option_contracts data. */
function FillReferenceButton({
  symU,
  fillApiRef,
}: {
  symU: string
  fillApiRef: RefObject<DataOverviewOptionJobsBarHandle | null>
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const handleFill = useCallback(async () => {
    const api = fillApiRef.current
    if (!api) { setErr('Jobs bar not ready.'); return }
    setBusy(true); setErr(null); setDone(false)
    try {
      await api.enqueueReferenceUpsert(symU)
      setDone(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Enqueue failed')
    } finally {
      setBusy(false)
    }
  }, [fillApiRef, symU])

  return (
    <div className="data-overview-gap-sheet__fill-cta">
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        disabled={busy || done}
        title="Enqueue reference contracts upsert for this symbol (row-level; same as Fill row gap in the bar)."
        onClick={() => void handleFill()}
      >
        {busy ? 'Enqueueing…' : done ? 'Enqueued ✓' : 'Fill row gap'}
      </button>
      {err ? <span className="data-overview-gap-sheet__err" role="alert">{err}</span> : null}
      {done ? (
        <span className="data-overview-gap-sheet__muted" style={{ fontSize: 'var(--text-caption)' }}>
          {' '}Job queued — watchlist refreshes automatically when done.
        </span>
      ) : null}
    </div>
  )
}

function delayMs(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms)
  })
}

/** Shown once at top of All gaps — column taxonomy only (no per-symbol %). */
function AllGapsOptionContractsColumnGuide() {
  return (
    <section className="data-overview-all-gaps-sheet__guide" aria-label="option_contracts column groups">
      <h4 className="data-overview-all-gaps-sheet__guide-title">option_contracts column groups</h4>
      <dl className="data-overview-all-gaps-sheet__guide-dl">
        <div className="data-overview-all-gaps-sheet__guide-item data-overview-all-gaps-sheet__guide-item--identity">
          <dt>Identity (natural key)</dt>
          <dd>
            <code>contract_key</code>, <code>symbol</code>, <code>expiry</code>, <code>strike</code>, <code>option_right</code>{' '}
            — NOT NULL per row; together define the contract.
          </dd>
        </div>
        <div className="data-overview-all-gaps-sheet__guide-item data-overview-all-gaps-sheet__guide-item--pk">
          <dt>Primary key</dt>
          <dd>
            <code>option_contracts_id</code> (surrogate PK)
          </dd>
        </div>
        <div className="data-overview-all-gaps-sheet__guide-item data-overview-all-gaps-sheet__guide-item--vendor">
          <dt>Reference / vendor</dt>
          <dd>
            <code>massive_option_ticker</code> (optional). Matrix <strong>Column comp · ID</strong> averages ticker % with the
            identity check below.
          </dd>
        </div>
        <div className="data-overview-all-gaps-sheet__guide-item data-overview-all-gaps-sheet__guide-item--coverage">
          <dt>Identity check (coverage API)</dt>
          <dd>
            <code>identity</code> % counts rows with non-empty <code>symbol</code>, <code>expiry</code>,{' '}
            <code>option_right</code>. With NOT NULL constraints, <code>contract_key</code> and <code>strike</code> are always
            set when a row exists.
          </dd>
        </div>
        <div className="data-overview-all-gaps-sheet__guide-item data-overview-all-gaps-sheet__guide-item--nullable">
          <dt>Nullable data</dt>
          <dd>
            <code>exercise_style</code>, <code>shares_per_contract</code>. Per-symbol NULL % table below uses the watchlist
            coverage scan (same as the matrix).
          </dd>
        </div>
        <div className="data-overview-all-gaps-sheet__guide-item data-overview-all-gaps-sheet__guide-item--audit">
          <dt>Audit</dt>
          <dd>
            <code>created_at</code>
          </dd>
        </div>
      </dl>
      <p className="data-overview-all-gaps-sheet__guide-note">
        Each symbol (compare pool only): <strong>nullable column NULL %</strong> lists only columns below the healthy fill band
        (same scan as the matrix), then <strong>reference row gap</strong> (per expiry with gap ≠ 0 only).
      </p>
    </section>
  )
}

function classifyReferenceGapExpiries(
  expiries: OptionContractsReferenceGapExpiryRow[],
): {
  behind: OptionContractsReferenceGapExpiryRow[]
  ahead: OptionContractsReferenceGapExpiryRow[]
} {
  const behind: OptionContractsReferenceGapExpiryRow[] = []
  const ahead: OptionContractsReferenceGapExpiryRow[] = []
  for (const e of expiries) {
    if (e.gap > 0) behind.push(e)
    else if (e.gap < 0) ahead.push(e)
  }
  return { behind, ahead }
}

function fmtPct1(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${v}%`
}

/** Complement of fill % (1 decimal), for NULL / empty share. */
function nullOrEmptyPct(fillPct: number | null | undefined): number | null {
  if (fillPct == null) return null
  return Math.round((100 - fillPct) * 10) / 10
}

function estRowsFromPct(rowCount: number, pctNull: number | null): string {
  if (rowCount <= 0 || pctNull == null) return '—'
  return Math.round((rowCount * pctNull) / 100).toLocaleString()
}

/** Same healthy band as the matrix / toolbar column fill (≥97% ok). */
const NULLABLE_FILL_HEALTH_MIN = 97

/** Column needs attention: unknown fill or below healthy threshold. */
function nullableColumnFillHasIssue(fill: number | null | undefined): boolean {
  if (fill == null) return true
  return fill < NULLABLE_FILL_HEALTH_MIN
}

/** True when matrix C gap &gt; 0: SQL NULL row counts on monitored nullable columns (sum shown in matrix). */
function optionContractsHasSqlNullCavity(oc: WatchlistDbCoverageOptionContracts): boolean {
  return (oc.column_gap_count ?? 0) > 0
}

/**
 * Matches NullableColumnNullStatsBlock: true when that block renders (including no-data CTA),
 * false when it returns null (all column fills healthy and no SQL NULL cavities).
 */
function nullableCoverageSectionShouldRender(oc: WatchlistDbCoverageOptionContracts): boolean {
  if (!oc.has_data) return true
  if (optionContractsHasSqlNullCavity(oc)) return true
  const rows = [
    { fill: oc.ticker_pct },
    { fill: oc.exercise_style_pct },
    { fill: oc.shares_per_contract_pct },
  ]
  const optionalAvgIssue =
    oc.optional_data_fill_avg_pct != null && oc.optional_data_fill_avg_pct < NULLABLE_FILL_HEALTH_MIN
  let displayRows = rows.filter(r => nullableColumnFillHasIssue(r.fill))
  if (displayRows.length === 0 && optionalAvgIssue) {
    displayRows = rows
  }
  return displayRows.length > 0
}

/**
 * True when ReferenceGapSymbolBlock should render: run Check, errors, no expiries row, or any expiry with gap ≠ 0.
 * False when Compare succeeded and every expiry is in sync (gap 0) — nothing actionable to show.
 */
function referenceGapSectionShouldRender(refG: OptionContractsReferenceGapResult | undefined): boolean {
  if (refG == null) return true
  if (!refG.ok) return true
  const expiries = refG.expiries ?? []
  if (expiries.length === 0) return true
  const { behind, ahead } = classifyReferenceGapExpiries(expiries)
  return behind.length > 0 || ahead.length > 0
}

/** Higher non-empty / non-NULL % is better. */
function nullableFillMetricClass(fill: number | null): string {
  if (fill == null) return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--na'
  if (fill >= NULLABLE_FILL_HEALTH_MIN) return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--ok'
  if (fill >= 85) return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--warn'
  return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--bad'
}

/** Lower NULL-or-empty % is better (same semantics for est. NULL rows). */
function nullableNullShareMetricClass(nullPct: number | null): string {
  if (nullPct == null) return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--na'
  if (nullPct <= 3) return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--ok'
  if (nullPct <= 12) return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--warn'
  return 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--bad'
}

const NULLABLE_COLUMN_CODES: readonly NullableOptionContractsColumnCode[] = [
  'massive_option_ticker',
  'exercise_style',
  'shares_per_contract',
]

function isNullableColumnCode(code: string): code is NullableOptionContractsColumnCode {
  return (NULLABLE_COLUMN_CODES as readonly string[]).includes(code)
}

/** Per-symbol nullable / optional columns: non-null vs NULL (or empty) share from watchlist-db-coverage. */
function NullableColumnNullStatsBlock({
  oc,
  symU,
  fillApiRef,
}: {
  oc: WatchlistDbCoverageOptionContracts
  symU?: string
  fillApiRef?: RefObject<DataOverviewOptionJobsBarHandle | null>
}) {
  const [busyCol, setBusyCol] = useState<string | null>(null)
  const [colErr, setColErr] = useState<string | null>(null)

  const handleFillColumn = useCallback(
    async (code: string) => {
      if (!symU || !isNullableColumnCode(code)) return
      if (!fillApiRef?.current?.enqueueNullableColumnFill) {
        setColErr('Jobs bar is not ready.')
        return
      }
      setBusyCol(code)
      setColErr(null)
      try {
        await fillApiRef.current.enqueueNullableColumnFill(symU, code)
      } catch (e) {
        setColErr(e instanceof Error ? e.message : 'Enqueue failed')
      } finally {
        setBusyCol(null)
      }
    },
    [fillApiRef, symU],
  )

  if (!oc.has_data) {
    return (
      <section className="data-overview-gap-sheet__sec" aria-label="Nullable column null statistics">
        <h5 className="data-overview-gap-sheet__sec-title data-overview-gap-sheet__sec-title--sub">
          Nullable / optional column NULL share
        </h5>
        <p className="data-overview-gap-sheet__muted">
          No option_contracts rows for this symbol — sync reference data first.
        </p>
        {symU && fillApiRef ? (
          <FillReferenceButton symU={symU} fillApiRef={fillApiRef} />
        ) : null}
      </section>
    )
  }

  const n = oc.row_count ?? 0
  const rows: { code: string; fill: number | null }[] = [
    { code: 'massive_option_ticker', fill: oc.ticker_pct },
    { code: 'exercise_style', fill: oc.exercise_style_pct },
    { code: 'shares_per_contract', fill: oc.shares_per_contract_pct },
  ]
  const optionalAvgIssue =
    oc.optional_data_fill_avg_pct != null &&
    oc.optional_data_fill_avg_pct < NULLABLE_FILL_HEALTH_MIN

  const esSqlNull = oc.exercise_style_null_row_count ?? 0
  const spcSqlNull = oc.shares_per_contract_null_row_count ?? 0

  let displayRows = rows.filter(r => {
    if (nullableColumnFillHasIssue(r.fill)) return true
    if (r.code === 'exercise_style' && esSqlNull > 0) return true
    if (r.code === 'shares_per_contract' && spcSqlNull > 0) return true
    return false
  })
  if (displayRows.length === 0 && optionalAvgIssue) {
    displayRows = rows
  }
  if (displayRows.length === 0) {
    return null
  }

  const usedOptionalAvgFallback =
    optionalAvgIssue && rows.every(r => !nullableColumnFillHasIssue(r.fill))

  const usedSqlNullOnlyFallback =
    (esSqlNull > 0 || spcSqlNull > 0) &&
    rows.every(r => !nullableColumnFillHasIssue(r.fill)) &&
    !optionalAvgIssue

  return (
    <section className="data-overview-gap-sheet__sec" aria-label="Nullable column null statistics">
      <h5 className="data-overview-gap-sheet__sec-title data-overview-gap-sheet__sec-title--sub">
        Nullable / optional column NULL share
      </h5>
      {usedOptionalAvgFallback ? (
        <p className="data-overview-gap-sheet__note" role="note">
          Optional data average is below 97% while per-column fills look healthy — showing all columns for review.
        </p>
      ) : null}
      {usedSqlNullOnlyFallback ? (
        <p className="data-overview-gap-sheet__note" role="note">
          Matrix <strong>C gap</strong> counts SQL <code>NULL</code> cells (sum of NULL rows on{' '}
          <code>exercise_style</code> and <code>shares_per_contract</code>). Per-column fill % can still be ≥97% if many rows
          use empty strings instead of NULL — use <strong>Fill column</strong> to backfill from the contract detail API.
        </p>
      ) : null}
      <p className="data-overview-gap-sheet__nullable-lead">
        Same scan as the matrix (watchlist coverage). <code>massive_option_ticker</code> uses non-empty share; others use
        non-NULL share for %. For <code>exercise_style</code> / <code>shares_per_contract</code>, <strong>Est. NULL rows</strong>{' '}
        uses exact SQL <code>NULL</code> counts from the server when available (same as matrix C gap split). Otherwise est. = row
        count × NULL %. Row: ticker uses the reference list API (same as Fill row gap). Column: <code>exercise_style</code> and{' '}
        <code>shares_per_contract</code> use the contract detail API where <code>massive_option_ticker</code> is set (cap 5000
        contracts per job).
      </p>
      <p className="data-overview-gap-sheet__nullable-meta">
        <strong>{n.toLocaleString()}</strong> rows in <code>option_contracts</code>
        {oc.optional_data_fill_avg_pct != null ? (
          <>
            {' '}
            · optional data avg fill <strong>{fmtPct1(oc.optional_data_fill_avg_pct)}</strong>
          </>
        ) : null}
      </p>
      {colErr ? (
        <p className="data-overview-gap-sheet__err" role="alert">
          {colErr}
        </p>
      ) : null}
      <table className="data-overview-gap-sheet__tbl data-overview-gap-sheet__tbl--compact">
        <thead>
          <tr>
            <th scope="col">Column</th>
            <th scope="col">Non-empty / non-NULL</th>
            <th scope="col">{`NULL or empty`}</th>
            <th scope="col">Est. NULL rows</th>
            <th scope="col">Column fill</th>
          </tr>
        </thead>
        <tbody>
          {displayRows.map(r => {
            const nullP = nullOrEmptyPct(r.fill)
            const exactSqlNull =
              r.code === 'exercise_style'
                ? oc.exercise_style_null_row_count
                : r.code === 'shares_per_contract'
                  ? oc.shares_per_contract_null_row_count
                  : null
            const estText =
              r.code === 'exercise_style' || r.code === 'shares_per_contract'
                ? exactSqlNull != null && exactSqlNull > 0
                  ? exactSqlNull.toLocaleString()
                  : estRowsFromPct(n, nullP)
                : estRowsFromPct(n, nullP)
            const fillTitle =
              'Non-empty / non-NULL share: ≥97% healthy, 85–96.9% review, <85% attention.'
            const nullTitle =
              'NULL or empty share: ≤3% healthy, 3.1–12% review, >12% attention. Est. NULL rows use the same scale.'
            return (
              <tr key={r.code}>
                <td>
                  <code>{r.code}</code>
                </td>
                <td>
                  <span className={nullableFillMetricClass(r.fill)} title={fillTitle}>
                    {fmtPct1(r.fill)}
                  </span>
                </td>
                <td>
                  <span className={nullableNullShareMetricClass(nullP)} title={nullTitle}>
                    {nullP == null ? '—' : `${nullP}%`}
                  </span>
                </td>
                <td>
                  <span
                    className={
                      n > 0 && nullP != null
                        ? nullableNullShareMetricClass(nullP)
                        : 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--na'
                    }
                    title={nullTitle}
                  >
                    {estText}
                  </span>
                </td>
                <td>
                  {fillApiRef && symU ? (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm data-overview-gap-sheet__col-fill-btn"
                      disabled={busyCol != null}
                      title={
                        r.code === 'massive_option_ticker'
                          ? 'Row-level: reference list upsert to fill Polygon option tickers (same as Fill row gap).'
                          : 'Column-level: detail-API backfill for this field (requires massive_option_ticker on each row).'
                      }
                      onClick={() => void handleFillColumn(r.code)}
                    >
                      {busyCol === r.code
                        ? 'Enqueueing…'
                        : r.code === 'massive_option_ticker'
                          ? 'Fill row'
                          : 'Fill column'}
                    </button>
                  ) : (
                    <span className="data-overview-gap-sheet__metric--na">—</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="data-overview-gap-sheet__nullable-legend" role="note">
        Colors: <span className="data-overview-gap-sheet__metric data-overview-gap-sheet__metric--ok">healthy</span>,{' '}
        <span className="data-overview-gap-sheet__metric data-overview-gap-sheet__metric--warn">review</span>,{' '}
        <span className="data-overview-gap-sheet__metric data-overview-gap-sheet__metric--bad">attention</span> — for fill
        % (higher better) and NULL share / est. rows (lower better). Hover a value for thresholds.
      </p>
    </section>
  )
}

function ReferenceGapSymbolBlock({
  symU,
  refG,
  fillApiRef,
}: {
  symU: string
  refG: OptionContractsReferenceGapResult | undefined
  fillApiRef: RefObject<DataOverviewOptionJobsBarHandle | null>
}) {
  const [rowBusy, setRowBusy] = useState<string | null>(null)
  const [sectionBusy, setSectionBusy] = useState(false)
  const [localErr, setLocalErr] = useState<string | null>(null)

  const runFill = useCallback(
    async (expiration_date: string) => {
      const api = fillApiRef.current
      if (!api) {
        setLocalErr('Jobs bar is not ready.')
        return
      }
      setLocalErr(null)
      setRowBusy(expiration_date)
      try {
        await api.enqueueReferenceUpsert(symU, { expiration_date })
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : 'Enqueue failed')
      } finally {
        setRowBusy(null)
      }
    },
    [fillApiRef, symU],
  )

  const runFillBehindSection = useCallback(
    async (rows: OptionContractsReferenceGapExpiryRow[]) => {
      const api = fillApiRef.current
      if (!api) {
        setLocalErr('Jobs bar is not ready.')
        return
      }
      if (rows.length === 0) return
      setLocalErr(null)
      setSectionBusy(true)
      try {
        for (let i = 0; i < rows.length; i++) {
          await api.enqueueReferenceUpsert(symU, { expiration_date: rows[i]!.expiry })
          if (i < rows.length - 1) await delayMs(75)
        }
      } catch (e) {
        setLocalErr(e instanceof Error ? e.message : 'Enqueue failed')
      } finally {
        setSectionBusy(false)
      }
    },
    [fillApiRef, symU],
  )

  if (refG?.ok === true && !referenceGapSectionShouldRender(refG)) {
    return null
  }

  const expiryTable = (
    rows: OptionContractsReferenceGapExpiryRow[],
    opts: { showFill?: boolean },
  ) => (
    <table className="data-overview-gap-sheet__tbl">
      <thead>
        <tr>
          <th scope="col">Expiry</th>
          <th scope="col" title="PostgreSQL rows matched to the Massive reference list (same contract_key)">
            PG (matched)
          </th>
          <th scope="col">Ref</th>
          <th scope="col">Gap</th>
          {opts.showFill ? (
            <th scope="col" title="Reference upsert scoped to one expiry (row-level gap)">
              Row gap
            </th>
          ) : null}
        </tr>
      </thead>
      <tbody>
        {rows.map(e => (
          <tr key={e.expiry}>
            <td>
              <code>{e.expiry}</code>
              {e.truncated ? (
                <span className="data-overview-gap-sheet__trunc" title="List truncated on server">
                  {' '}
                  *
                </span>
              ) : null}
            </td>
            <td>{e.pg_count.toLocaleString()}</td>
            <td>{e.massive_count.toLocaleString()}</td>
            <td>
              <span
                className={
                  e.gap === 0
                    ? 'data-overview-wl-matrix__gapnum data-overview-wl-matrix__gapnum--ok'
                    : 'data-overview-wl-matrix__gapnum data-overview-wl-matrix__gapnum--warn'
                }
              >
                {e.gap > 0 ? `+${e.gap.toLocaleString()}` : e.gap.toLocaleString()}
              </span>
            </td>
            {opts.showFill ? (
              <td>
                {e.gap > 0 ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={rowBusy != null || sectionBusy}
                    title="Fill row gap for this expiry (reference upsert with expiration_date)."
                    onClick={() => void runFill(e.expiry)}
                  >
                    {rowBusy === e.expiry ? 'Enqueueing…' : 'Fill row gap'}
                  </button>
                ) : (
                  <span className="data-overview-gap-sheet__dash">—</span>
                )}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  )

  let body: ReactNode
  if (!refG) {
    body = (
      <p className="data-overview-gap-sheet__empty">
        Run <strong>Check</strong> in the bar to load per-expiry gap for this symbol.
      </p>
    )
  } else if (!refG.ok) {
    body = (
      <p className="data-overview-gap-sheet__err" role="alert">
        {refG.error ?? 'Gap compare failed.'}
      </p>
    )
  } else {
    const expiries = refG.expiries ?? []
    if (expiries.length === 0) {
      body = (
        <p className="data-overview-gap-sheet__empty">
          {refG.message ?? 'No per-expiry rows (nothing to list).'}
        </p>
      )
    } else {
      const { behind, ahead } = classifyReferenceGapExpiries(expiries)
      body = (
        <>
          {localErr ? (
            <p className="data-overview-gap-sheet__err" role="alert">
              {localErr}
            </p>
          ) : null}
          {refG.expiries_truncated || refG.truncated ? (
            <p className="data-overview-gap-sheet__note">List capped on server — totals may be partial.</p>
          ) : null}

          <p className="data-overview-gap-sheet__refgap-intro">
            Reference vs Massive: only expiries with gap ≠ 0 (fully matched expiries are not listed).
          </p>

          <section className="data-overview-gap-sheet__sec">
            <div className="data-overview-gap-sheet__sec-head">
              <h5 className="data-overview-gap-sheet__sec-title data-overview-gap-sheet__sec-title--sub">
                Behind reference (gap {'>'} 0)
              </h5>
              {behind.length > 0 ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={rowBusy != null || sectionBusy}
                  title="Enqueue one reference upsert per expiry in this section (row-level gaps)."
                  onClick={() => void runFillBehindSection(behind)}
                >
                  {sectionBusy ? 'Enqueueing…' : 'Fill row gaps in section'}
                </button>
              ) : null}
            </div>
            {behind.length === 0 ? (
              <p className="data-overview-gap-sheet__muted">None</p>
            ) : (
              expiryTable(behind, { showFill: true })
            )}
          </section>

          <section className="data-overview-gap-sheet__sec">
            <h5 className="data-overview-gap-sheet__sec-title data-overview-gap-sheet__sec-title--sub">
              Ahead of reference (gap {'<'} 0)
            </h5>
            {ahead.length === 0 ? (
              <p className="data-overview-gap-sheet__muted">None</p>
            ) : (
              expiryTable(ahead, { showFill: false })
            )}
          </section>
        </>
      )
    }
  }

  return (
    <div className="data-overview-gap-sheet data-overview-gap-sheet--embedded" role="region">
      {body}
    </div>
  )
}

export function DataOverviewAllGapsSheet({
  open,
  onClose,
  wlRows,
  comparePool,
  refGapBySymbol,
  fillApiRef,
}: {
  open: boolean
  onClose: () => void
  wlRows: WatchlistDbCoverageSymbolRow[]
  /** Same as Check bar — only these symbols appear in the sheet. */
  comparePool: string[]
  refGapBySymbol: Record<string, OptionContractsReferenceGapResult>
  fillApiRef: RefObject<DataOverviewOptionJobsBarHandle | null>
}) {
  const asideRef = useRef<HTMLDivElement | null>(null)

  const poolUpperSet = useMemo(
    () => new Set(comparePool.map(s => s.trim().toUpperCase()).filter(Boolean)),
    [comparePool],
  )
  const gapsWlRows = useMemo(
    () => wlRows.filter(r => poolUpperSet.has(r.symbol.trim().toUpperCase())),
    [wlRows, poolUpperSet],
  )
  // Symbols in comparePool (have refGap data) but NOT in wlRows (not in watchlist coverage scan).
  // Show reference gap only; nullable stats are unavailable without watchlist coverage data.
  const wlSymSet = useMemo(
    () => new Set(wlRows.map(r => r.symbol.trim().toUpperCase())),
    [wlRows],
  )
  const extraPoolSymbols = useMemo(
    () =>
      Array.from(poolUpperSet)
        .filter(s => !wlSymSet.has(s) && refGapBySymbol[s] != null)
        .sort(),
    [poolUpperSet, wlSymSet, refGapBySymbol],
  )

  const watchlistPoolIssueCount = useMemo(
    () =>
      gapsWlRows.filter(r => {
        const symU = r.symbol.trim().toUpperCase()
        return (
          nullableCoverageSectionShouldRender(r.option_contracts) ||
          referenceGapSectionShouldRender(refGapBySymbol[symU])
        )
      }).length,
    [gapsWlRows, refGapBySymbol],
  )

  const poolReferenceTruncated = useMemo(() => {
    for (const s of poolUpperSet) {
      const g = refGapBySymbol[s]
      if (g?.ok && (g.expiries_truncated || g.truncated)) return true
    }
    return false
  }, [poolUpperSet, refGapBySymbol])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => asideRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  return (
    <div className="ref-jobs-sheet-backdrop" role="presentation" onClick={onClose}>
      <aside
        ref={asideRef}
        className="ref-jobs-sheet ref-jobs-sheet--wide data-overview-all-gaps-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-overview-all-gaps-title"
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
      >
        <div className="ref-jobs-sheet-header">
          <h3 id="data-overview-all-gaps-title" className="ref-jobs-sheet-title">
            All reference gaps
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <p className="ref-jobs-sheet-meta">
          Symbols shown: <strong>compare pool</strong> only (same as <strong>Check</strong>). Per symbol: <strong>nullable column
          NULL %</strong> includes columns below the healthy fill threshold <em>or</em> with SQL <code>NULL</code> rows (matrix{' '}
          <strong>C gap</strong> &gt; 0), and <strong>reference row gap</strong> lists only expiries with gap ≠ 0 (same run as{' '}
          <strong>Check</strong>). The gap{' '}
          <strong>PG</strong> column counts rows whose <code>contract_key</code> appears in the Massive reference list for that
          expiry. When behind, use per-expiry <strong>Fill row gap</strong> or <strong>Fill row gaps in section</strong>. Nullable
          columns: use <strong>Fill row</strong> / <strong>Fill column</strong> in the table when it appears.
        </p>

        <div className="data-overview-all-gaps-sheet__body">
          <AllGapsOptionContractsColumnGuide />
          {poolReferenceTruncated ? (
            <p className="data-overview-gap-sheet__note data-overview-all-gaps-sheet__trunc-banner" role="status">
              One or more pooled symbols hit the server <strong>max expiries</strong> limit and/or a per-expiry Massive API{' '}
              <strong>page</strong> cap. Rollup Gap / per-expiry tables only cover what that Compare run scanned — open{' '}
              <strong>Advanced · reference compare</strong> in the bar, raise Max expiries, and run <strong>Check</strong>{' '}
              again if you need tail expiries.
            </p>
          ) : null}
          {poolUpperSet.size === 0 ? (
            <p className="data-overview-all-gaps-sheet__empty-pool" role="status">
              No symbols in the compare pool. Add symbols in the matrix (Symbol column) or <strong>Select all</strong>, then
              open <strong>All gaps</strong> again.
            </p>
          ) : gapsWlRows.length === 0 && extraPoolSymbols.length === 0 ? (
            <p className="data-overview-all-gaps-sheet__empty-pool" role="status">
              None of the pooled symbols are in the current watchlist coverage response. Refresh watchlist data or adjust the
              pool.
            </p>
          ) : (
            <>
              {gapsWlRows.length > 0 && watchlistPoolIssueCount === 0 && extraPoolSymbols.length === 0 ? (
                <p className="data-overview-all-gaps-sheet__empty-pool" role="status">
                  No issues to list for the current compare pool — reference expiries are in sync, matrix <strong>C gap</strong> is
                  0, and nullable column fills meet the healthy band (or run <strong>Check</strong> for symbols that are not
                  loaded yet).
                </p>
              ) : null}
              {gapsWlRows.map(r => {
                const symU = r.symbol.trim().toUpperCase()
                const refG = refGapBySymbol[symU]
                if (
                  !nullableCoverageSectionShouldRender(r.option_contracts) &&
                  !referenceGapSectionShouldRender(refG)
                ) {
                  return null
                }
                return (
                  <article key={r.symbol} className="data-overview-all-gaps-sheet__sym">
                    <h4 className="data-overview-all-gaps-sheet__sym-h">
                      <code>{r.symbol}</code>
                    </h4>
                    <NullableColumnNullStatsBlock oc={r.option_contracts} symU={symU} fillApiRef={fillApiRef} />
                    <ReferenceGapSymbolBlock symU={symU} refG={refG} fillApiRef={fillApiRef} />
                  </article>
                )
              })}
              {extraPoolSymbols.map(symU => (
                <article key={symU} className="data-overview-all-gaps-sheet__sym">
                  <h4 className="data-overview-all-gaps-sheet__sym-h">
                    <code>{symU}</code>
                  </h4>
                  <section className="data-overview-gap-sheet__sec" aria-label="Nullable column null statistics">
                    <h5 className="data-overview-gap-sheet__sec-title data-overview-gap-sheet__sec-title--sub">
                      Nullable / optional column NULL share
                    </h5>
                    <p className="data-overview-gap-sheet__muted">
                      {symU} is not in the watchlist coverage scan — nullable stats unavailable.
                      Add {symU} to the watchlist as an optionable STK to see coverage percentages here.
                    </p>
                  </section>
                  <ReferenceGapSymbolBlock symU={symU} refG={refGapBySymbol[symU]} fillApiRef={fillApiRef} />
                </article>
              ))}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}
