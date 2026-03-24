import { useCallback, useState } from 'react'
import { InfoTooltip } from '../../components/InfoTooltip'
import { IvTermStructureChart, type IvTermPoint } from './OptionDiscoveryAnalytics'

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

  return (
    <div className="replay-section od-iv-term-section" aria-label="IV term structure">
      <h4 className="mp-chart-subtitle">
        IV Term Structure
        <InfoTooltip text="ATM implied volatility for the expirations you check below (PostgreSQL option_snapshots; source matches your quote pipeline). Order follows the left sidebar list." />
      </h4>
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
              <IvTermStructureChart points={termPoints} />
              <p className="section-hint od-iv-term-chart-caption" role="status">
                Plotted expirations (with IV):{' '}
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
