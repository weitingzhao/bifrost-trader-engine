import type { CSSProperties } from 'react'
import { InfoTooltip } from '../../components/InfoTooltip'
import type { OptionsFocusTableId } from './optionFocusDataset'
import type { WatchlistStocksTableId } from './stockFocusDataset'
import type { WatchlistTableSelection, WatchlistUnifiedDataset } from './watchlistUnifiedFocus'

const RADIO_NAME = 'watchlist-coverage-unified-focus'

const focusLegendSrOnly: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}

function isCodeDatasetChip(): boolean {
  return true
}

function dbObjectKindForOptionTable(id: OptionsFocusTableId): 'table' | 'view' {
  return id === 'option_snapshots_with_underlying_day' ? 'view' : 'table'
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

function optionChip(
  v: OptionsFocusTableId,
  label: string,
  title: string,
  value: WatchlistUnifiedDataset,
  onChange: (next: WatchlistTableSelection) => void,
) {
  const kind = dbObjectKindForOptionTable(v)
  const tip =
    kind === 'view'
      ? `${title} — SQL view`
      : `${title} — table`
  return (
    <label key={v} className="data-overview-focus-chips__chip-wrap" title={tip}>
      <input
        type="radio"
        name={RADIO_NAME}
        value={v}
        checked={value === v}
        onChange={() => onChange(v)}
      />
      <span
        className={`data-overview-focus-chips__chip${isCodeDatasetChip() ? ' data-overview-focus-chips__chip--code' : ''}`}
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

function stockTableChip(
  id: WatchlistStocksTableId,
  value: WatchlistUnifiedDataset,
  onChange: (next: WatchlistTableSelection) => void,
) {
  return (
    <label key={id} className="data-overview-focus-chips__chip-wrap" title={id}>
      <input
        type="radio"
        name={RADIO_NAME}
        value={id}
        checked={value === id}
        onChange={() => onChange(id)}
      />
      <span className="data-overview-focus-chips__chip data-overview-focus-chips__chip--code">
        <IconDbTable className="data-overview-focus-chips__icon data-overview-focus-chips__icon--table" />
        <span className="data-overview-focus-chips__chip-label">
          <code>{id}</code>
        </span>
      </span>
    </label>
  )
}

/** Planned DB mirror of Massive unified snapshot (GET /v3/snapshot); not implemented yet — not part of focus radios. */
function stockSnapshotsPlaceholderChip() {
  return (
    <span
      className="data-overview-focus-chips__chip-wrap data-overview-focus-chips__chip-wrap--placeholder"
      title="Planned: PostgreSQL table populated from Massive GET /v3/snapshot (Unified Snapshot). No table yet."
      role="note"
    >
      <span className="data-overview-focus-chips__chip data-overview-focus-chips__chip--code data-overview-focus-chips__chip--placeholder">
        <IconDbTable className="data-overview-focus-chips__icon data-overview-focus-chips__icon--table" />
        <span className="data-overview-focus-chips__chip-label">
          <code>stock_snapshots</code>
        </span>
      </span>
    </span>
  )
}

/** Unified focus grid for Watchlist coverage (Detail): FDN, SNP (snapshots), STG, RPT — no Quick row. */
export function WatchlistCoverageFocusChips({
  value,
  onChange,
  embedded = false,
}: {
  value: WatchlistUnifiedDataset
  onChange: (next: WatchlistTableSelection) => void
  embedded?: boolean
}) {
  return (
    <fieldset className="data-overview-focus-chips data-overview-focus-chips--compact">
      <legend
        className={embedded ? undefined : 'data-overview-focus-chips__legend'}
        style={embedded ? focusLegendSrOnly : undefined}
      >
        <span className={embedded ? undefined : 'data-overview-focus-chips__legend-text'}>
          {embedded ? (
            'Watchlist coverage — table focus'
          ) : (
            <>
              Focus dataset
              <InfoTooltip text="Pick one table — watchlist coverage loads when you select a chip. Options-only vs Stocks-only by asset class. FDN / Snapshots / STG / RPT groupings unchanged. Reference utilities (tickers, ticker_overview, ticker_types) are outside this block." />
            </>
          )}
        </span>
      </legend>

      <div className="data-overview-focus-chips__matrix" role="presentation">
        <span className="data-overview-focus-chips__rk" title="Fundamental — core contracts and bars">
          FDN
        </span>
        <div className="data-overview-focus-chips__row data-overview-focus-chips__row--fdn">
          <div
            className="data-overview-focus-chips__chip-group"
            role="group"
            aria-label="Daily: stock and option day bars, contract reference"
          >
            {stockTableChip('stock_day', value, onChange)}
            {optionChip('option_day', 'option_day', 'Daily option bars', value, onChange)}
            {optionChip('option_contracts', 'option_contracts', 'Reference / contract definitions', value, onChange)}
          </div>
          <div
            className="data-overview-focus-chips__chip-group"
            role="group"
            aria-label="Intraday: stock and option minute bars"
          >
            {stockTableChip('stock_min', value, onChange)}
            {optionChip('option_min', 'option_min', 'Minute option bars', value, onChange)}
          </div>
        </div>

        <span className="data-overview-focus-chips__rk" title="Option chain snapshots and unified stock snapshot (planned)">
          SNP
        </span>
        <div className="data-overview-focus-chips__row">
          {optionChip('option_snapshots', 'option_snapshots', 'Chain & intraday greeks', value, onChange)}
          {stockSnapshotsPlaceholderChip()}
        </div>

        <span className="data-overview-focus-chips__rk" title="Staging — tables plus one SQL view">
          STG
        </span>
        <div className="data-overview-focus-chips__row">
          {optionChip(
            'option_snapshots_with_underlying_day',
            'option_snapshots_with_underlying_day',
            'View joined to underlying stock_day',
            value,
            onChange,
          )}
          {optionChip('option_expiration_cache', 'option_expiration_cache', 'Expiration cache rows', value, onChange)}
          {optionChip('option_open_interest_daily', 'option_open_interest_daily', 'EOD open interest', value, onChange)}
        </div>

        <span className="data-overview-focus-chips__rk" title="Report tables">
          RPT
        </span>
        <div className="data-overview-focus-chips__row">
          {optionChip(
            'report_option_atm_iv_daily',
            'report_option_atm_iv_daily',
            'ATM implied volatility',
            value,
            onChange,
          )}
          {optionChip(
            'report_option_max_pain_daily',
            'report_option_max_pain_daily',
            'Max pain by expiry',
            value,
            onChange,
          )}
        </div>
      </div>
    </fieldset>
  )
}
