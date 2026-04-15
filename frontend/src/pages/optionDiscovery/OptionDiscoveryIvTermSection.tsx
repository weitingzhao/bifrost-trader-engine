import { useCallback, useMemo, useState } from 'react'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  IvParametricConeChart,
  IvTermStructureChart,
  IvVolConeChart,
  type IvTermPoint,
  type IvVolConePoint,
} from './OptionDiscoveryAnalytics'

/** Matches backend `min_samples_for_bands` for cone p10–p90 bands. */
const CONE_MIN_DAILY_SAMPLES = 5

const TOOLTIP_SAMPLES_VS_REQ = (actual: number, req: number) =>
  `Expected: at least ${req} calendar days in the lookback window where a daily ATM IV can be computed from PostgreSQL option_snapshots (near-ATM strikes for this expiration, valid IV, and underlying_price that day). Actual: ${actual}. To satisfy: keep ingesting chain snapshots (Massive backfill or Load quotes in section 4) so rows accumulate across days; a wider historical strike grid helps when spot moves. The orange cone line uses option_snapshots_latest and does not require this count.`

const TOOLTIP_BAND_CELLS_NA = (actual: number, req: number) =>
  `P10–P90 / Min / Max are hidden until daily samples reach ${req} (currently ${actual}). See Samples (act. / req.) column.`

function IvSheetHoverCell({
  warn,
  detail,
  children,
}: {
  warn?: boolean
  detail: string
  children: React.ReactNode
}) {
  return (
    <span className={`od-iv-sheet-hover${warn ? ' od-iv-sheet-hover--warn' : ''}`}>
      <span className="od-iv-sheet-hover-target">{children}</span>
      <span className="od-iv-sheet-hover-popup" role="tooltip">
        {detail}
      </span>
    </span>
  )
}

export function OptionDiscoveryIvTermSection({
  symbol,
  expirations,
  selectedExpirations,
  onToggleExpiration,
  onResetExpirationsToDefault,
  onSelectAllExpirations,
  onUncheckAllExpirations,
  maxExpirations,
  defaultExpirationCount,
  massiveBackfillAvailable,
  onBackfillMassiveSnapshots,
  snapshotSyncLoading,
  snapshotSyncStatus,
  onLoad,
  termPoints,
  termLoading,
  termError,
  conePoints,
  coneError,
}: {
  symbol: string
  expirations: string[]
  selectedExpirations: string[]
  onToggleExpiration: (expiration: string, checked: boolean) => void
  onResetExpirationsToDefault: () => void
  onSelectAllExpirations: () => void
  onUncheckAllExpirations: () => void
  maxExpirations: number
  defaultExpirationCount: number
  massiveBackfillAvailable: boolean
  onBackfillMassiveSnapshots: () => Promise<void>
  snapshotSyncLoading: boolean
  snapshotSyncStatus: string | null
  onLoad: () => Promise<void>
  termPoints: IvTermPoint[]
  termLoading: boolean
  termError: string | null
  conePoints: IvVolConePoint[]
  coneError: string | null
}) {
  const [busy, setBusy] = useState(false)
  const run = useCallback(async () => {
    setBusy(true)
    try {
      await onLoad()
    } finally {
      setBusy(false)
    }
  }, [onLoad])

  const runBackfill = useCallback(async () => {
    setBusy(true)
    try {
      await onBackfillMassiveSnapshots()
    } finally {
      setBusy(false)
    }
  }, [onBackfillMassiveSnapshots])

  const sym = symbol.trim()
  const canLoad = sym !== '' && expirations.length >= 2
  const selectedCount = selectedExpirations.length
  const blocked = termLoading || busy || snapshotSyncLoading
  const canRunLoad = selectedCount >= 2 && !blocked
  const hasChart = termPoints.length >= 2

  const fmtIvPct = (v: number | null | undefined): string => {
    if (v == null || !Number.isFinite(v)) return '—'
    return `${(v * 100).toFixed(1)}%`
  }

  const termRows = [...termPoints]
    .filter(p => p.dte_days >= 0)
    .sort((a, b) => a.dte_days - b.dte_days)
  const coneRows = [...conePoints].filter(p => p.dte_days >= 0).sort((a, b) => a.dte_days - b.dte_days)

  const mergedIvRows = useMemo(() => {
    const exps = new Set<string>()
    termRows.forEach(r => exps.add(r.expiration))
    coneRows.forEach(r => exps.add(r.expiration))
    return Array.from(exps)
      .map(exp => {
        const term = termRows.find(t => t.expiration === exp)
        const cone = coneRows.find(c => c.expiration === exp)
        const dte = term?.dte_days ?? cone?.dte_days ?? 0
        return { expiration: exp, dte, term, cone }
      })
      .sort((a, b) => a.dte - b.dte)
  }, [termRows, coneRows])

  return (
    <div className="replay-section od-iv-term-section" aria-label="IV term structure">
      {!canLoad && (
        <p className="section-hint" role="status">
          {!sym
            ? 'Select an underlying to load expirations.'
            : 'Need at least two expiration dates in the list (left sidebar). The highlighted row only drives the chain table below.'}
        </p>
      )}
      {canLoad && (
        <>
          <div className="od-iv-term-exp-panel">
            <p className="section-hint od-iv-term-exp-hint">
              You may check <strong>any</strong> expirations in the list (up to {maxExpirations}), not only the first{' '}
              {defaultExpirationCount}. “Select first {defaultExpirationCount}” is a shortcut. IV term reads existing rows in
              PostgreSQL — if you pick expirations that were never snapshotted, use Backfill (Massive) or Load quotes in section
              4 for those dates.
            </p>
            <div className="od-iv-term-exp-card" role="group" aria-label="Expirations for IV term structure">
              <div className="od-iv-term-exp-card-header">
                <div className="od-iv-term-exp-card-heading">
                  <span className="od-iv-term-exp-card-title">Expirations in chart</span>
                  <span
                    className={`od-iv-term-exp-card-badge${selectedCount < 2 ? ' od-iv-term-exp-card-badge--warn' : ''}`}
                    aria-live="polite"
                  >
                    {selectedCount} / {maxExpirations}
                    {selectedCount < 2 ? ' · min 2' : ''}
                  </span>
                </div>
                <div className="od-iv-term-exp-card-actions">
                  <button
                    type="button"
                    className="od-iv-term-quick-select-btn"
                    onClick={onResetExpirationsToDefault}
                    disabled={blocked}
                    title={`Select the first ${defaultExpirationCount} expirations in sidebar order`}
                  >
                    First {defaultExpirationCount}
                  </button>
                  <button
                    type="button"
                    className="od-iv-term-quick-select-btn"
                    onClick={onSelectAllExpirations}
                    disabled={blocked}
                    title={`Select up to ${maxExpirations} expirations (all listed, in sidebar order)`}
                  >
                    Check all
                  </button>
                  <button
                    type="button"
                    className="od-iv-term-quick-select-btn od-iv-term-quick-select-btn--muted"
                    onClick={onUncheckAllExpirations}
                    disabled={blocked}
                    title="Clear selection down to the first two expirations in sidebar order (minimum required for IV term)"
                  >
                    Uncheck all
                  </button>
                </div>
              </div>
              <ul className="od-iv-term-exp-list">
                {expirations.map(exp => {
                  const checked = selectedExpirations.includes(exp)
                  const atCap = !checked && selectedCount >= maxExpirations
                  return (
                    <li key={exp} className="od-iv-term-exp-li">
                      <label className={`od-iv-term-exp-item${checked ? ' od-iv-term-exp-item--checked' : ''}`}>
                        <input
                          type="checkbox"
                          className="od-iv-term-exp-checkbox"
                          checked={checked}
                          disabled={blocked || atCap}
                          onChange={e => {
                            onToggleExpiration(exp, e.target.checked)
                          }}
                          aria-label={`Include ${exp} in IV term structure`}
                        />
                        <span className="od-iv-term-exp-date">{exp}</span>
                      </label>
                    </li>
                  )
                })}
              </ul>
            </div>
            {massiveBackfillAvailable && (
              <p className="section-hint od-iv-term-backfill-hint">
                Backfill runs the same Massive chain snapshot jobs as “Load quotes” (section 4), once per checked expiration.
                Strike window from section 3 is applied when set; otherwise a broad chain (limit 250) is requested.
              </p>
            )}
          </div>

          {termError && (
            <p className="section-hint od-iv-term-error" role="alert">
              {termError}
            </p>
          )}
          {snapshotSyncLoading && snapshotSyncStatus && (
            <p className="section-hint od-iv-term-sync-status" role="status">
              {snapshotSyncStatus}
            </p>
          )}
          {!snapshotSyncLoading && (termLoading || busy) && (
            <p className="section-hint">Loading term structure…</p>
          )}
          {!snapshotSyncLoading && !(termLoading || busy) && (
            <div className="od-analytics-term-actions">
              {massiveBackfillAvailable && (
                <button
                  type="button"
                  className="section-header-icon-btn od-iv-term-action-icon-btn"
                  disabled={!canRunLoad}
                  onClick={() => void runBackfill()}
                  title="Backfill selected expirations then load IV term structure"
                  aria-label="Backfill selected expirations then load IV term structure"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 7h16" />
                    <path d="M4 12h16" />
                    <path d="M4 17h10" />
                    <path d="M17 14l3 3-3 3" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className="section-header-icon-btn od-iv-term-action-icon-btn"
                disabled={!canRunLoad}
                onClick={() => void run()}
                title={hasChart ? 'Reload IV term structure' : 'Load IV term structure'}
                aria-label={hasChart ? 'Reload IV term structure' : 'Load IV term structure'}
              >
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 21h5v-5" />
                </svg>
              </button>
            </div>
          )}

          {hasChart && (
            <>
              <div className="od-iv-term-cone-charts-row">
                <div className="od-iv-term-chart-pane">
                  <h4 className="mp-chart-subtitle od-iv-term-chart-pane-title">
                    IV Term Structure
                    <InfoTooltip text="ATM implied volatility for the expirations you check below (PostgreSQL option_snapshots; source matches your quote pipeline). Order follows the left sidebar list." />
                  </h4>
                  <div className="od-iv-term-chart-svg-wrap">
                    <IvTermStructureChart points={termPoints} />
                  </div>
                </div>
                <div className="od-iv-term-chart-pane">
                  <h4 className="mp-chart-subtitle od-iv-term-chart-pane-title">
                    IV Volatility Cone
                    <InfoTooltip text="Per calendar expiration: p10–p90 band of daily ATM IV from PostgreSQL option_snapshots (up to 90 calendar days). DTE on the x-axis is today’s days to expiration; past samples had different DTE for the same expiry. Orange line: current ATM IV (same definition as IV term structure)." />
                  </h4>
                  {coneError && (
                    <p className="section-hint od-iv-term-error" role="alert">
                      {coneError}
                    </p>
                  )}
                  {!coneError && conePoints.length >= 2 && (
                    <div className="od-iv-term-chart-svg-wrap">
                      <IvVolConeChart points={conePoints} />
                    </div>
                  )}
                  {!coneError && conePoints.length > 0 && conePoints.length < 2 && (
                    <p className="section-hint">Not enough cone points (need at least 2 expirations).</p>
                  )}
                </div>
              </div>

              {!coneError && conePoints.length >= 2 && (
                <div className="od-iv-term-parametric-row">
                  <div className="od-iv-term-chart-pane">
                    <h4 className="mp-chart-subtitle od-iv-term-chart-pane-title">
                      Parametric IV (historical)
                      <InfoTooltip text="Per expiration: sample mean and sample standard deviation of daily ATM IV over the same lookback as the percentile cone; min/max and mean ±1 SD / ±2 SD (lower bands clamped at 0). Not the same as p10–p90. Call and Put: latest snapshot IV at the chosen ATM strike (same as term structure)." />
                    </h4>
                    <div className="od-iv-term-chart-svg-wrap od-iv-term-chart-svg-wrap--parametric">
                      <IvParametricConeChart points={conePoints} />
                    </div>
                  </div>
                </div>
              )}

              <div className="od-iv-data-table-sheet">
                <h5 className="od-iv-data-table-heading">IV term &amp; cone — combined values</h5>
                <p className="section-hint od-iv-data-source">
                  <strong>Term (latest):</strong> PostgreSQL <code className="od-iv-data-code">option_snapshots_latest</code>{' '}
                  (same pipeline as quotes: Massive or IB).{' '}
                  <strong>Cone (historical bands):</strong> <code className="od-iv-data-code">option_snapshots</code>, one row per
                  NY calendar day per contract (last snapshot that day), up to 90 calendar days; percentiles from daily ATM IV.{' '}
                  <strong>ACT/REQ</strong> = actual daily ATM IV sample count vs minimum ({CONE_MIN_DAILY_SAMPLES}) for bands; hover
                  cells when highlighted.
                </p>
                <div className="od-iv-data-table-wrap od-iv-data-table-wrap--iv-sheet">
                  <table className="od-iv-data-table od-iv-data-table--merged">
                    <thead>
                      <tr>
                        <th scope="col" title="Expiration">Exp</th>
                        <th scope="col" title="Days to expiration">DTE</th>
                        <th scope="col" title="ATM IV (latest, term)">ATM</th>
                        <th scope="col" title="IV Call">C</th>
                        <th scope="col" title="IV Put">P</th>
                        <th scope="col" title="Strike">Str</th>
                        <th scope="col" title="Actual / required daily samples for cone bands">
                          ACT/REQ
                          <InfoTooltip text={`Minimum ${CONE_MIN_DAILY_SAMPLES} daily ATM IV points in the lookback are required for cone p10–p90 bands. Hover this column or P10–Max when highlighted.`} />
                        </th>
                        <th scope="col" title="Cone percentile bands status">
                          Bnd
                          <InfoTooltip text="OK = enough daily samples for percentile bands. Inc = incomplete; hover ACT/REQ or status." />
                        </th>
                        <th scope="col" title="Cone historical P10">P10</th>
                        <th scope="col" title="Cone historical P50">P50</th>
                        <th scope="col" title="Cone historical P90">P90</th>
                        <th scope="col" title="Cone historical min IV">Mn</th>
                        <th scope="col" title="Cone historical max IV">Mx</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mergedIvRows.length === 0 ? (
                        <tr>
                          <td colSpan={13} className="od-iv-data-table-empty">
                            {coneError && !termRows.length ? 'Failed to load data.' : 'No rows.'}
                          </td>
                        </tr>
                      ) : (
                        mergedIvRows.map(({ expiration, dte, term, cone }) => {
                          const actual = cone?.sample_days ?? 0
                          const req = CONE_MIN_DAILY_SAMPLES
                          const bandsOk = cone != null && actual >= req
                          const rowWarn = cone != null && !bandsOk
                          const pctCell = (v: number | null | undefined) => {
                            if (cone == null) return '—'
                            if (v != null && Number.isFinite(v)) return fmtIvPct(v)
                            if (bandsOk) return '—'
                            return (
                              <IvSheetHoverCell warn detail={TOOLTIP_BAND_CELLS_NA(actual, req)}>
                                —
                              </IvSheetHoverCell>
                            )
                          }
                          return (
                            <tr key={expiration} className={rowWarn ? 'od-iv-data-row--cone-warn' : undefined}>
                              <td>{expiration}</td>
                              <td>{dte}</td>
                              <td>{fmtIvPct(term?.atm_iv ?? cone?.atm_iv)}</td>
                              <td>{fmtIvPct(term?.iv_call)}</td>
                              <td>{fmtIvPct(term?.iv_put)}</td>
                              <td>
                                {term?.strike != null && Number.isFinite(term.strike) ? term.strike.toFixed(2) : '—'}
                              </td>
                              <td className={rowWarn ? 'od-iv-data-cell--warn' : undefined}>
                                {cone == null
                                  ? '—'
                                  : (
                                      <IvSheetHoverCell warn={!bandsOk} detail={TOOLTIP_SAMPLES_VS_REQ(actual, req)}>
                                        <span className="od-iv-samples-pair" title={`${actual} / ${req} daily samples`}>
                                          <span className="od-iv-samples-actual">{actual}</span>
                                          <span className="od-iv-samples-sep">/</span>
                                          <span className="od-iv-samples-req">{req}</span>
                                        </span>
                                      </IvSheetHoverCell>
                                    )}
                              </td>
                              <td className={rowWarn ? 'od-iv-data-cell--warn' : undefined}>
                                {cone == null
                                  ? '—'
                                    : bandsOk
                                    ? 'OK'
                                    : (
                                        <IvSheetHoverCell warn detail={TOOLTIP_SAMPLES_VS_REQ(actual, req)}>
                                          <span className="od-iv-band-incomplete" title="Incomplete">
                                            Inc
                                          </span>
                                        </IvSheetHoverCell>
                                      )}
                              </td>
                              <td className={!bandsOk && cone != null ? 'od-iv-data-cell--muted' : undefined}>{pctCell(cone?.iv_p10)}</td>
                              <td className={!bandsOk && cone != null ? 'od-iv-data-cell--muted' : undefined}>{pctCell(cone?.iv_p50)}</td>
                              <td className={!bandsOk && cone != null ? 'od-iv-data-cell--muted' : undefined}>{pctCell(cone?.iv_p90)}</td>
                              <td className={!bandsOk && cone != null ? 'od-iv-data-cell--muted' : undefined}>{pctCell(cone?.iv_min)}</td>
                              <td className={!bandsOk && cone != null ? 'od-iv-data-cell--muted' : undefined}>{pctCell(cone?.iv_max)}</td>
                            </tr>
                          )
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>

              <p className="section-hint od-iv-term-chart-caption" role="status">
                Plotted expirations (term structure):{' '}
                {termPoints
                  .filter(p => p.atm_iv != null && Number.isFinite(p.atm_iv) && p.dte_days >= 0)
                  .sort((a, b) => a.dte_days - b.dte_days)
                  .map(p => p.expiration)
                  .join(', ')}
              </p>
            </>
          )}
        </>
      )}
    </div>
  )
}
