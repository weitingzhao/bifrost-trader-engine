import { rl } from '@/lib/replayLayout'
import { pnlNegativeClass, pnlPositiveClass } from '@/components/shared/appUi'
import { w9 } from '@/styles/wave9Classes'
import { Fragment, type ReactNode } from 'react'
import { fmtUsd } from '../../utils/format'
import {
  fmtSignedPct, fmtHeldSharesWhole, fmtSurplusShares,
  coverageRowMarketValueTotal, groupCoverageByAccount,
} from './positionUtils'
import type { CoveragePoolSortCol } from './positionUtils'
import { stockSymbolInspectorBtnClass } from '@/components/shared/exec-row-buttons'
import type { StockCoverageItem } from '../portfolio/types'

interface StockCoverageTableProps {
  rows: StockCoverageItem[]
  keyPrefix: string
  streamHostAccountId: string
  streamSecondaryAccountId: string
  showAvailableHeldContracts?: boolean
  hideBackedOpportunities?: boolean
  underlyingPoolSlim?: boolean
  backingPoolSlim?: boolean
  underlyingPoolSort?: {
    column: CoveragePoolSortCol
    dir: 'asc' | 'desc'
    onColumnClick: (col: CoveragePoolSortCol) => void
  }
  onInspectCoverageSymbol?: (ci: StockCoverageItem) => void
}

export function StockCoverageTable({
  rows,
  keyPrefix,
  streamHostAccountId,
  streamSecondaryAccountId,
  showAvailableHeldContracts,
  hideBackedOpportunities,
  underlyingPoolSlim,
  backingPoolSlim,
  underlyingPoolSort,
  onInspectCoverageSymbol,
}: StockCoverageTableProps) {
  const tableOpts = {
    showAvailableHeldContracts,
    hideBackedOpportunities,
    underlyingPoolSlim,
    backingPoolSlim,
    underlyingPoolSort,
    onInspectCoverageSymbol,
  }

  const slim = tableOpts?.underlyingPoolSlim === true
  const backingSlim = tableOpts?.backingPoolSlim === true
  const backingLayout = backingSlim && !slim
  const poolSort = tableOpts?.underlyingPoolSort
  const showAvail = slim || tableOpts?.showAvailableHeldContracts === true
  const hideBacked = slim || tableOpts?.hideBackedOpportunities === true
  const showHeldColumn = !backingLayout
  const showHeldAmtColumn = slim || backingLayout || (showAvail && !backingLayout && !slim)
  const accountCellClass = (accountId: string) => {
    const a = (accountId ?? '').trim()
    if (streamSecondaryAccountId && a === streamSecondaryAccountId) return 'coverage-account-id coverage-account-secondary'
    if (streamHostAccountId && a === streamHostAccountId) return 'coverage-account-id coverage-account-host'
    return 'coverage-account-id coverage-account-other'
  }
  const poolSortOn = !!(poolSort && (slim || backingLayout))
  const poolGroupByAccount = slim || backingLayout
  const accountGroupColSpan = poolGroupByAccount ? 7 : 0
  const sortCol = poolSort?.column ?? 'market_price'
  const sortDir = poolSort?.dir ?? 'desc'
  const accountGroups = poolGroupByAccount
    ? groupCoverageByAccount(
        rows,
        sortCol,
        sortDir,
        streamHostAccountId,
        streamSecondaryAccountId,
      )
    : null
  const sortTh = (label: ReactNode, col: CoveragePoolSortCol, title?: string) => {
    if (!poolSortOn) return <th title={title}>{label}</th>
    const active = poolSort.column === col
    return (
      <th
        className={rl.thSortable}
        title={title}
        role="button"
        tabIndex={0}
        aria-sort={active ? (poolSort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
        onClick={() => poolSort.onColumnClick(col)}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            poolSort.onColumnClick(col)
          }
        }}
      >
        {label}
        {active ? (poolSort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
      </th>
    )
  }
  const renderCoverageDataRow = (ci: StockCoverageItem, rowKey: string) => {
    const statusLabel =
      ci.held_shares >= ci.required_shares
        ? 'Covered'
        : ci.held_shares > 0
          ? 'Partial'
          : 'Naked'
    const statusClass =
      ci.held_shares >= ci.required_shares
        ? 'coverage-status-covered'
        : ci.held_shares > 0
          ? 'coverage-status-partial'
          : 'coverage-status-naked'
    const optionSupportLabel =
      ci.optionable_supported === true
        ? 'Optionable'
        : ci.optionable_supported === false
          ? 'Not optionable'
          : 'Mixed / Unknown'
    const backedOpps = ci.backing_opportunities ?? []
    const availContracts = showAvail ? Math.floor(Math.max(0, ci.held_shares) / 100) : 0
    const acc = ci.account_id || '—'
    return (
      <tr key={rowKey}>
        <td>
          {tableOpts?.onInspectCoverageSymbol ? (
            <button
              type="button"
              className={stockSymbolInspectorBtnClass}
              onClick={() => tableOpts.onInspectCoverageSymbol?.(ci)}
              aria-label={`Stock details for ${ci.symbol} in account ${acc}`}
            >
              {ci.symbol}
            </button>
          ) : (
            <strong>{ci.symbol}</strong>
          )}
        </td>
        {!poolGroupByAccount && <td className={rl.muted}>{acc}</td>}
        {!hideBacked && (
          <td title={backedOpps.join(', ') || undefined}>
            {backedOpps.length > 0 ? backedOpps.join(', ') : '—'}
          </td>
        )}
        {showHeldColumn && (
          <td className={slim ? 'coverage-held-shares-cell' : undefined}>
            {slim ? fmtHeldSharesWhole(ci.held_shares) : ci.held_shares}
          </td>
        )}
        {showHeldAmtColumn &&
          (slim || backingLayout ? (
            <td
              className={`coverage-available-held-amt-cell coverage-available-held-amt-slim${slim && !backingLayout ? ' coverage-held-amt-underlying-narrow' : ''}`}
            >
              <span
                className={`coverage-available-contracts-only${slim && !backingLayout ? ' coverage-held-amt-underlying-contracts' : ''}`}
                title={
                  backingLayout
                    ? `${Math.floor(Math.max(0, Math.min(ci.held_shares, ci.required_shares)) / 100)} contracts — min(${ci.held_shares} held, ${ci.required_shares} required) sh ÷ 100`
                    : `${ci.held_shares} sh ÷ 100`
                }
              >
                {backingLayout
                  ? Math.floor(
                      Math.max(0, Math.min(ci.held_shares || 0, ci.required_shares || 0)) / 100,
                    )
                  : Math.floor(Math.max(0, ci.held_shares) / 100)}
              </span>
              {backingLayout && ci.instances_needing > 1 && (
                <span className={w9.coverageSharedHint}> ({ci.instances_needing} strat.)</span>
              )}
            </td>
          ) : (
            <td className={w9.coverageAvailableHeldAmtCell}>
              <div className={w9.coverageAvailableContracts} title={`${ci.held_shares} sh ÷ 100`}>
                {availContracts}
              </div>
              <div className={w9.coverageAvailableContractsLabel}>contracts</div>
              <div className={w9.coverageAvailableSharesLine} title="Share qty (100 sh per contract)">
                {ci.held_shares} sh
              </div>
            </td>
          ))}
        {!slim && !backingLayout && (
          <td>
            {ci.required_shares}
            {ci.instances_needing > 1 && (
              <span className={w9.coverageSharedHint}> ({ci.instances_needing} strat.)</span>
            )}
          </td>
        )}
        {!slim && !backingSlim && (
          <td>
            <span className={ci.surplus_or_gap >= 0 ? pnlPositiveClass : pnlNegativeClass}>
              {fmtSurplusShares(ci.surplus_or_gap)}
            </span>
          </td>
        )}
        {!slim && !backingSlim && <td>{optionSupportLabel}</td>}
        {slim || backingLayout ? (
          <td className={w9.coverageCostAvgCell} title="Cost basis (total) / avg cost per share">
            <div className={w9.coverageCostAvgBasis}>{fmtUsd(ci.cost_basis_total)}</div>
            <div className={w9.coverageCostAvgPerShare}>{fmtUsd(ci.avg_cost_per_share)}</div>
          </td>
        ) : (
          <>
            <td>{fmtUsd(ci.cost_basis_total)}</td>
            <td>{fmtUsd(ci.avg_cost_per_share)}</td>
          </>
        )}
        {slim || backingLayout ? (
          <td
            className={w9.coverageMktValuePriceCell}
            title="Position market value (held × last) / price per share"
          >
            <div className={w9.coverageMktValueTotal}>{fmtUsd(coverageRowMarketValueTotal(ci))}</div>
            <div className={w9.coverageMktValuePerShare}>{fmtUsd(ci.live_last_price)}</div>
          </td>
        ) : (
          <td>{fmtUsd(ci.live_last_price)}</td>
        )}
        {slim || backingLayout ? (
          <td className={w9.coveragePnlStackedCell}>
            <div className={((ci.daily_pnl ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}>
              {fmtUsd(ci.daily_pnl)}
            </div>
            <div className={`coverage-pnl-stacked-pct ${((ci.daily_pct ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}`}>
              {fmtSignedPct(ci.daily_pct)}
            </div>
          </td>
        ) : (
          <td>
            <span className={((ci.daily_pnl ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}>
              {fmtUsd(ci.daily_pnl)}
            </span>
            {' / '}
            <span className={((ci.daily_pct ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}>
              {fmtSignedPct(ci.daily_pct)}
            </span>
          </td>
        )}
        {slim || backingLayout ? (
          <td className={w9.coveragePnlStackedCell}>
            <div className={((ci.total_pnl ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}>
              {fmtUsd(ci.total_pnl)}
            </div>
            <div className={`coverage-pnl-stacked-pct ${((ci.total_pct ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}`}>
              {fmtSignedPct(ci.total_pct)}
            </div>
          </td>
        ) : (
          <td>
            <span className={((ci.total_pnl ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}>
              {fmtUsd(ci.total_pnl)}
            </span>
            {' / '}
            <span className={((ci.total_pct ?? 0) >= 0) ? pnlPositiveClass : pnlNegativeClass}>
              {fmtSignedPct(ci.total_pct)}
            </span>
          </td>
        )}
        {!slim && !backingSlim && (
          <td>
            <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
          </td>
        )}
      </tr>
    )
  }
  return (
  <div className={rl.portfolioTableWrap}>
    <table
      className={`table-operations instance-sheet-sub-table coverage-summary-table${poolSortOn ? ' coverage-underlying-pool-sortable' : ''}`}
    >
      <thead>
        <tr>
          {slim || backingLayout ? sortTh('Symbol', 'symbol') : <th>Symbol</th>}
          {!poolGroupByAccount && <th>Account</th>}
          {!hideBacked && <th>Backed opportunities</th>}
          {showHeldColumn &&
            (slim ? sortTh('Held', 'held', 'Long share qty (whole shares).') : <th>Held</th>)}
          {showHeldAmtColumn &&
            (backingLayout ? (
              sortTh(
                <span className={w9.coveragePoolThBackedAmt}>
                  Backed
                  <br />
                  Amt
                </span>,
                'backed_amt',
                'Contracts backing watchlist hedge: min(held, required) ÷ 100.',
              )
            ) : slim && poolSortOn ? (
              sortTh(
                <span className={w9.coveragePoolThHeldAmt}>
                  Held
                  <br />
                  Amt
                </span>,
                'held_amt',
                'Contracts ≈ max(0, long shares) ÷ 100.',
              )
            ) : slim ? (
              <th title="Contracts ≈ max(0, long shares) ÷ 100.">
                <span className={w9.coveragePoolThHeldAmt}>Held<br />Amt</span>
              </th>
            ) : (
              <th title="Option contracts ≈ max(0, long shares) ÷ 100.">Available Held Amt</th>
            ))}
          {!slim && !backingLayout && <th>Required</th>}
          {!slim && !backingSlim && <th>Surplus / Gap</th>}
          {!slim && !backingSlim && <th>Option support</th>}
          {slim || backingLayout ? (
            sortTh(
              'Basis / Avg',
              'cost_basis',
              'Total cost basis (top) and average cost per share (bottom).',
            )
          ) : (
            <>
              <th>Cost basis</th>
              <th>Avg cost</th>
            </>
          )}
          {backingLayout ? (
            sortTh(
              'Mkt / Price',
              'market_price',
              'Market value (held × last) / share price. Sort by value.',
            )
          ) : slim ? (
            sortTh(
              'Mkt value / Price',
              'market_price',
              'Total market value (held × last) and price per share. Sort by total value.',
            )
          ) : (
            <th>Live last</th>
          )}
          {slim || backingLayout ? <th className={w9.coveragePnlStackedTh}>Daily</th> : <th>Daily ($ / %)</th>}
          {slim || backingLayout ? <th className={w9.coveragePnlStackedTh}>Total</th> : <th>Total ($ / %)</th>}
          {!slim && !backingSlim && <th>Status</th>}
        </tr>
      </thead>
      <tbody>
        {accountGroups
          ? accountGroups.map(({ accountId, items }) => (
              <Fragment key={`${keyPrefix}-acc-${accountId}`}>
                <tr className="coverage-pool-account-group-row">
                  <td
                    colSpan={accountGroupColSpan}
                    className={accountCellClass(accountId)}
                    title="Host vs Secondary use Settings → Stream host / secondary account IDs."
                  >
                    {accountId}
                  </td>
                </tr>
                {items.map(ci =>
                  renderCoverageDataRow(ci, `${keyPrefix}-${accountId}-${ci.symbol}`),
                )}
              </Fragment>
            ))
          : rows.map(ci =>
              renderCoverageDataRow(ci, `${keyPrefix}-${ci.symbol}-${ci.account_id || '—'}`),
            )}
      </tbody>
    </table>
  </div>
  )
}
