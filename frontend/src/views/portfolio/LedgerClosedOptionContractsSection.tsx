import { useState, useEffect, type Dispatch, type SetStateAction } from 'react'
import type { Execution, OptExecutionGroup, OptionStockLinkRow, OptionStockLinkSummary } from '../../types'
import ExecSourceBadge from '../../components/ExecSourceBadge'
import { InfoTooltip } from '../../components/InfoTooltip'
import {
  fmtExpiry,
  fmtTradeDate,
  fmtTs,
  fmtUsd,
  fmtUsd0,
  getContractLabelParts,
} from '../../utils/format'
import {
  adjustedRealizedPnlForOptGroup,
  collectLinkIdsForOptGroup,
  findOppositeLegAttributionSource,
  flattenLinksForOptGroup,
  getInstanceConsistencyState,
  getOptionStockLinkDetailForExecution,
  getOptGroupKey,
  ledgerOptDetailRowPnl,
} from './ledgerOptHelpers'
import { LedgerStgInsCell } from './LedgerStgInsCell'

const CLOSED_PAGE_SIZE = 50

function PaginationBar({
  page,
  total,
  pageSize,
  onPage,
}: {
  page: number
  total: number
  pageSize: number
  onPage: (p: number) => void
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))
  if (totalPages <= 1) return null
  return (
    <div className="ledger-pagination-bar" role="navigation" aria-label="Table pagination">
      <button
        type="button"
        className="ledger-pagination-btn"
        onClick={() => onPage(1)}
        disabled={page === 1}
        aria-label="First page"
      >
        «
      </button>
      <button
        type="button"
        className="ledger-pagination-btn"
        onClick={() => onPage(page - 1)}
        disabled={page === 1}
        aria-label="Previous page"
      >
        ‹
      </button>
      <span className="ledger-pagination-info">
        {page} / {totalPages}
        <span className="ledger-pagination-total"> ({total})</span>
      </span>
      <button
        type="button"
        className="ledger-pagination-btn"
        onClick={() => onPage(page + 1)}
        disabled={page === totalPages}
        aria-label="Next page"
      >
        ›
      </button>
      <button
        type="button"
        className="ledger-pagination-btn"
        onClick={() => onPage(totalPages)}
        disabled={page === totalPages}
        aria-label="Last page"
      >
        »
      </button>
    </div>
  )
}

function LinkStrategyIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      className="btn btn-icon-small"
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </button>
  )
}

function LinkStockLegIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      className="btn btn-icon-small"
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 18h6v-6H3v6zm9-12h6V3h-6v3zM3 8h6V3H3v5zm9 10h6v-6h-6v6z" />
        <path d="M14 9h2M9 14v2" />
      </svg>
    </button>
  )
}

function SyncOppositeLegAttributionButton({
  onClick,
  title,
  disabled,
}: {
  onClick: () => void
  title: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      className="btn btn-icon-small ledger-sync-opposite-leg-btn"
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={title}
      disabled={disabled}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M23 4v6h-6" />
        <path d="M1 20v-6h6" />
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
      </svg>
    </button>
  )
}

export interface LedgerClosedOptionContractsSectionProps {
  sortedClosedGroups: OptExecutionGroup[]
  closedExpandedGroups: OptExecutionGroup[]
  closedPnlSum: number
  detailsTotalPnl: number
  expandedDetailKeys: string[]
  toggleDetailExpand: (key: string) => void
  ledgerOptSort: { column: 'expiry' | 'trade_date'; dir: 'asc' | 'desc' }
  setLedgerOptSort: Dispatch<
    SetStateAction<{ column: 'expiry' | 'trade_date'; dir: 'asc' | 'desc' }>
  >
  onEditExecution: (ex: Execution) => void
  /** Pass `sameContractTrades` (group `trades`) so Assign strategy can suggest instances from sibling fills. */
  onLinkExecution: (ex: Execution, sameContractTrades?: Execution[]) => void
  /** Link OPT row to underlying STK fills (exercise/assignment). */
  onLinkStockExecution?: (ex: Execution) => void
  onDeleteExecution: (ex: Execution) => void
  /** Copy strategy opportunity + instance from opposite-side same-|qty| fill in the group (closed option details). */
  onSyncOppositeLegAttribution?: (target: Execution, peer: Execution) => void | Promise<void>
  /** While a sync PATCH is in flight for this execution id */
  syncingAccountExecutionsId?: number | null
  /** Shown when no row is expanded in the details table */
  detailPlaceholder?: string
  sectionAriaLabel?: string
  /** Map option execution id → linked stock rows (from bulk query). */
  optionStockLinkByOptionId?: Record<number, OptionStockLinkSummary>
  /** Open readonly modal with link rows for this contract group. */
  onViewOptionStockLinks?: (rows: OptionStockLinkRow[], title: string, slippageTotal: number | null) => void
}

export function LedgerClosedOptionContractsSection({
  sortedClosedGroups,
  closedExpandedGroups,
  closedPnlSum,
  detailsTotalPnl,
  expandedDetailKeys,
  toggleDetailExpand,
  ledgerOptSort,
  setLedgerOptSort,
  onEditExecution,
  onLinkExecution,
  onLinkStockExecution,
  onDeleteExecution,
  onSyncOppositeLegAttribution,
  syncingAccountExecutionsId = null,
  detailPlaceholder = 'Click a closed trade row above to load details',
  sectionAriaLabel = 'Closed option positions and details',
  optionStockLinkByOptionId,
  onViewOptionStockLinks,
}: LedgerClosedOptionContractsSectionProps) {
  const [closedPage, setClosedPage] = useState(1)

  useEffect(() => {
    setClosedPage(1)
  }, [sortedClosedGroups.length])

  const totalClosedPages = Math.max(1, Math.ceil(sortedClosedGroups.length / CLOSED_PAGE_SIZE))
  const pagedClosedGroups = sortedClosedGroups.slice(
    (closedPage - 1) * CLOSED_PAGE_SIZE,
    closedPage * CLOSED_PAGE_SIZE,
  )

  return (
    <section aria-label={sectionAriaLabel}>
      <div className="replay-portfolio-table-wrap">
        <table className="table-operations replay-opt-groups">
          <thead>
            <tr>
              <th rowSpan={2} className="replay-opt-expand-col"></th>
              <th rowSpan={2}>Contract</th>
              <th
                rowSpan={2}
                className="replay-th-sortable"
                onClick={e => {
                  e.stopPropagation()
                  setLedgerOptSort(prev =>
                    prev.column === 'expiry'
                      ? { column: 'expiry', dir: prev.dir === 'desc' ? 'asc' : 'desc' }
                      : { column: 'expiry', dir: 'desc' },
                  )
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    setLedgerOptSort(prev =>
                      prev.column === 'expiry'
                        ? { column: 'expiry', dir: prev.dir === 'desc' ? 'asc' : 'desc' }
                        : { column: 'expiry', dir: 'desc' },
                    )
                  }
                }}
                role="button"
                tabIndex={0}
                title="Sort by Expiry"
              >
                Expiry{' '}
                {ledgerOptSort.column === 'expiry'
                  ? ledgerOptSort.dir === 'asc'
                    ? ' ▲'
                    : ' ▼'
                  : ''}
              </th>
              <th rowSpan={2}>STRIKE</th>
              <th colSpan={3}>BUY</th>
              <th colSpan={3}>SELL</th>
              <th rowSpan={2}>Realized PnL</th>
              <th rowSpan={2}>Account</th>
              <th
                rowSpan={2}
                className="replay-th-sortable"
                onClick={e => {
                  e.stopPropagation()
                  setLedgerOptSort(prev =>
                    prev.column === 'trade_date'
                      ? { column: 'trade_date', dir: prev.dir === 'desc' ? 'asc' : 'desc' }
                      : { column: 'trade_date', dir: 'desc' },
                  )
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    e.stopPropagation()
                    setLedgerOptSort(prev =>
                      prev.column === 'trade_date'
                        ? { column: 'trade_date', dir: prev.dir === 'desc' ? 'asc' : 'desc' }
                        : { column: 'trade_date', dir: 'desc' },
                    )
                  }
                }}
                role="button"
                tabIndex={0}
                title="Sort by Trade date"
              >
                Trade date{' '}
                {ledgerOptSort.column === 'trade_date'
                  ? ledgerOptSort.dir === 'asc'
                    ? ' ▲'
                    : ' ▼'
                  : ''}
              </th>
            </tr>
            <tr>
              <th className="replay-th-sub">Size</th>
              <th className="replay-th-sub">@</th>
              <th className="replay-th-sub">Cost</th>
              <th className="replay-th-sub">Size</th>
              <th className="replay-th-sub">@</th>
              <th className="replay-th-sub">Premium</th>
            </tr>
          </thead>
          <tbody>
            {pagedClosedGroups.map(g => {
              const linkIds =
                optionStockLinkByOptionId && onViewOptionStockLinks
                  ? collectLinkIdsForOptGroup(g, optionStockLinkByOptionId)
                  : []
              const linkRows =
                optionStockLinkByOptionId && onViewOptionStockLinks
                  ? flattenLinksForOptGroup(g, optionStockLinkByOptionId)
                  : []
              let linkSlippageSum: number | null = null
              if (optionStockLinkByOptionId && linkIds.length > 0) {
                let s = 0
                let any = false
                const seenOid = new Set<number>()
                for (const ex of g.trades ?? []) {
                  const oid = ex.account_executions_id
                  if (oid == null || seenOid.has(oid)) continue
                  seenOid.add(oid)
                  const t = optionStockLinkByOptionId[oid]?.slippage_total
                  if (t != null && Number.isFinite(t)) {
                    s += t
                    any = true
                  }
                }
                linkSlippageSum = any ? s : null
              }
              const displayGroupPnl = optionStockLinkByOptionId
                ? adjustedRealizedPnlForOptGroup(g, optionStockLinkByOptionId)
                : Number(g.realized_pnl) || 0
              const uniqueAccounts = Array.from(
                new Set((g.trades ?? []).map(t => (t.account_id ?? '').trim()).filter(Boolean)),
              )
              const accountLabel =
                uniqueAccounts.length === 0
                  ? '—'
                  : uniqueAccounts.length === 1
                    ? uniqueAccounts[0]
                    : 'Mix'
              const groupKey = getOptGroupKey(g)
              const isExpanded = expandedDetailKeys.includes(groupKey)
              return (
                <tr
                  key={groupKey}
                  className="replay-opt-group-row"
                  onClick={() => toggleDetailExpand(groupKey)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleDetailExpand(groupKey)
                    }
                  }}
                  aria-expanded={isExpanded}
                  aria-label={isExpanded ? 'Collapse group details' : 'Expand group details'}
                >
                  <td className="replay-opt-expand-col">
                    <span
                      className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`}
                      aria-hidden
                    >
                      {isExpanded ? '▼' : '▶'}
                    </span>
                  </td>
                  <td className="replay-opt-contract">
                    {(() => {
                      const trades = g.trades ?? []
                      const resolvedState = getInstanceConsistencyState(trades)
                      const singleInstanceId =
                        resolvedState === 'same'
                          ? trades.find(
                              t => t.strategy_instance_id != null && Number.isFinite(t.strategy_instance_id),
                            )?.strategy_instance_id ?? null
                          : null
                      const p = getContractLabelParts(g.contract_key)
                      const strikeStr = g.strike != null ? ` ${g.strike}` : ''
                      const instanceIcon =
                        resolvedState !== 'none' ? (
                          resolvedState === 'same' && singleInstanceId != null ? (
                            <a
                              href={`#/strategies/instances/${singleInstanceId}`}
                              className="ledger-instance-icon-link ledger-instance-icon-link--same"
                              target="_blank"
                              rel="noopener noreferrer"
                              title="All fills share one strategy instance (click to open)"
                              aria-label="View strategy instance"
                              onClick={e => e.stopPropagation()}
                            >
                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <rect x="5" y="5" width="14" height="14" rx="1" />
                              </svg>
                            </a>
                          ) : resolvedState === 'same' ? (
                            <span
                              className="ledger-instance-icon-link ledger-instance-icon-link--same"
                              title="All fills share one strategy instance"
                              aria-label="Single shared instance"
                              onClick={e => e.stopPropagation()}
                              role="img"
                            >
                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <rect x="5" y="5" width="14" height="14" rx="1" />
                              </svg>
                            </span>
                          ) : resolvedState === 'multiple' ? (
                            <span
                              className="ledger-instance-icon-link ledger-instance-icon-link--multiple"
                              title="All fills have an instance; more than one distinct instance ID in this group"
                              aria-label="Multiple distinct instances"
                              onClick={e => e.stopPropagation()}
                              role="img"
                            >
                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <rect x="5" y="5" width="14" height="14" rx="1" />
                              </svg>
                            </span>
                          ) : (
                            <span
                              className="ledger-instance-icon-link ledger-instance-icon-link--mixed"
                              title="At least one fill has no strategy instance in this group"
                              aria-label="Some fills missing instance"
                              onClick={e => e.stopPropagation()}
                              role="img"
                            >
                              <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                <rect x="5" y="5" width="14" height="14" rx="1" />
                              </svg>
                            </span>
                          )
                        ) : null
                      const contractTitle = p.symbol
                        ? `${p.symbol} ${p.rightLabel}${strikeStr}`
                        : (g.contract_key ?? 'Contract')
                      const linkStockSummaryIcon =
                        onViewOptionStockLinks && linkIds.length > 0 ? (
                          <button
                            type="button"
                            className="ledger-opt-link-stock-aggregate-icon"
                            title="Linked stock fills — open summary (details show per-fill link IDs)"
                            aria-label="Linked stock fills"
                            onClick={e => {
                              e.stopPropagation()
                              onViewOptionStockLinks(
                                linkRows,
                                `Linked stocks · ${contractTitle}`,
                                linkSlippageSum,
                              )
                            }}
                          >
                            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M3 18h6v-6H3v6zm9-12h6V3h-6v3zM3 8h6V3H3v5zm9 10h6v-6h-6v6z" />
                              <path d="M14 9h2M9 14v2" />
                            </svg>
                          </button>
                        ) : null
                      return (
                        <>
                          {instanceIcon}
                          {p.symbol ? (
                            <>
                              <strong>{p.symbol}</strong> {p.rightLabel}
                              {strikeStr}
                            </>
                          ) : (
                            g.contract_key
                          )}
                          {linkStockSummaryIcon}
                        </>
                      )
                    })()}
                  </td>
                  <td>{fmtExpiry(g.expiry)}</td>
                  <td>
                    <strong>{fmtUsd(g.strike)}</strong>
                  </td>
                  <td>{g.buy_volume}</td>
                  <td>{fmtUsd(g.buy_avg_price)}</td>
                  <td>
                    <span className="replay-cost">{fmtUsd(g.buy_cost)}</span>
                  </td>
                  <td>{g.sell_volume}</td>
                  <td>{fmtUsd(g.sell_avg_price)}</td>
                  <td>
                    <span className="replay-premium">{fmtUsd(g.sell_premium)}</span>
                  </td>
                  <td>
                    <span
                      className={
                        displayGroupPnl >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'
                      }
                      title={
                        linkIds.length > 0
                          ? 'Premium PnL plus sum of linked stock slippage vs Flex close (signed qty × (price − close))'
                          : undefined
                      }
                    >
                      {fmtUsd0(displayGroupPnl)}
                    </span>
                  </td>
                  <td>{accountLabel}</td>
                  <td>
                    {(() => {
                      const dates = (g.trades ?? [])
                        .map(t => t.trade_date)
                        .filter((d): d is string => d != null && String(d).trim() !== '')
                      if (dates.length === 0) return '—'
                      dates.sort()
                      return fmtTradeDate(dates[0])
                    })()}
                  </td>
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="replay-opt-summary-row">
              <td colSpan={10}>Total</td>
              <td>
                <strong
                  className={
                    closedPnlSum >= 0 ? 'replay-pnl-realized' : 'replay-pnl-detail-negative'
                  }
                >
                  {fmtUsd0(closedPnlSum)}
                </strong>
              </td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </table>
        <PaginationBar
          page={closedPage}
          total={sortedClosedGroups.length}
          pageSize={CLOSED_PAGE_SIZE}
          onPage={p => setClosedPage(Math.max(1, Math.min(p, totalClosedPages)))}
        />
      </div>

      <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
        Details (per trade)
        <InfoTooltip text="Click a closed trade row above to load its execution details." />
      </h5>
      <table className="table-operations">
        <thead>
          <tr>
            <th>Contract</th>
            <th>Expiry</th>
            <th>STRIKE</th>
            <th>Stg/Ins</th>
            <th>Trade date</th>
            <th>Side</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Comm.</th>
            <th>PnL</th>
            <th>Account</th>
            <th>Source</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {closedExpandedGroups.length === 0 ? (
            <tr>
              <td colSpan={13} className="replay-detail-placeholder">
                {detailPlaceholder}
              </td>
            </tr>
          ) : (
            closedExpandedGroups.flatMap(g =>
              (g.trades ?? []).map((ex, ti) => {
                const groupTrades = g.trades ?? []
                const oppositeAttributionPeer = findOppositeLegAttributionSource(groupTrades, ex)
                const showSyncOppositeAttribution =
                  onSyncOppositeLegAttribution &&
                  ex.account_executions_id != null &&
                  (ex.strategy_instance_id == null || !Number.isFinite(Number(ex.strategy_instance_id))) &&
                  oppositeAttributionPeer != null
                const s = (ex.side ?? '').toUpperCase()
                const sideLabel =
                  s === 'BUY' || s === 'BOT' || s === 'B'
                    ? 'Buy'
                    : s === 'SELL' || s === 'SLD' || s === 'S'
                      ? 'Sell'
                      : (ex.side ?? '—')
                const { displayPnl, hasCombinedStock } = ledgerOptDetailRowPnl(
                  ex,
                  optionStockLinkByOptionId,
                )
                const pnlClass =
                  displayPnl < 0
                    ? 'replay-pnl-detail-negative'
                    : displayPnl > 0
                      ? 'replay-pnl-detail-positive'
                      : ''
                return (
                  <tr key={`${getOptGroupKey(g)}-${ti}-${ex.time ?? ti}`}>
                    <td>
                      {(() => {
                        const p_ = getContractLabelParts(g.contract_key)
                        const strikeStr_ = g.strike != null ? ` ${g.strike}` : ''
                        const instanceId = ex.strategy_instance_id
                        const instanceLabel = ex.strategy_instance_label?.trim()
                        const instanceTitle = instanceLabel
                          ? `Instance: ${instanceLabel}`
                          : instanceId != null
                            ? `View instance #${instanceId}`
                            : ''
                        const peer = oppositeAttributionPeer
                        return (
                          <>
                            {instanceId != null && (
                              <a
                                href={`#/strategies/instances/${instanceId}`}
                                className="ledger-instance-icon-link"
                                target="_blank"
                                rel="noopener noreferrer"
                                title={instanceTitle}
                                aria-label={instanceTitle || 'View strategy instance'}
                              >
                                <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                  <rect x="5" y="5" width="14" height="14" rx="1" />
                                </svg>
                              </a>
                            )}
                            {p_.symbol ? (
                              <>
                                <strong>{p_.symbol}</strong> {p_.rightLabel}
                                {strikeStr_}
                                {ex.account_executions_id != null && (
                                  <span className="replay-contract-exec-id">#{ex.account_executions_id}</span>
                                )}
                              </>
                            ) : (
                              <>
                                {g.contract_key}
                                {ex.account_executions_id != null && (
                                  <span className="replay-contract-exec-id">#{ex.account_executions_id}</span>
                                )}
                              </>
                            )}
                            {optionStockLinkByOptionId && onViewOptionStockLinks
                              ? (() => {
                                  const {
                                    linkIds: detailLinkIds,
                                    links: detailLinkRows,
                                    slippageTotal: detailSlip,
                                  } = getOptionStockLinkDetailForExecution(ex, optionStockLinkByOptionId)
                                  if (detailLinkIds.length === 0) return null
                                  const pL = getContractLabelParts(g.contract_key)
                                  const strikeStrL = g.strike != null ? ` ${g.strike}` : ''
                                  const detailTitle = pL.symbol
                                    ? `${pL.symbol} ${pL.rightLabel}${strikeStrL}`
                                    : (g.contract_key ?? '')
                                  return (
                                    <span className="ledger-opt-link-stock-badges">
                                      {detailLinkIds.map(lid => (
                                        <button
                                          key={lid}
                                          type="button"
                                          className="ledger-opt-link-stock-badge"
                                          onClick={e => {
                                            e.stopPropagation()
                                            onViewOptionStockLinks(
                                              detailLinkRows,
                                              `Link #${lid} · Exec #${ex.account_executions_id ?? '?'} · ${detailTitle}`,
                                              detailSlip,
                                            )
                                          }}
                                        >
                                          #{lid}
                                        </button>
                                      ))}
                                    </span>
                                  )
                                })()
                              : null}
                            {showSyncOppositeAttribution && peer && onSyncOppositeLegAttribution ? (
                              <SyncOppositeLegAttributionButton
                                disabled={syncingAccountExecutionsId === ex.account_executions_id}
                                title="Apply strategy opportunity and instance from the opposite-side fill with the same quantity in this group"
                                onClick={() => onSyncOppositeLegAttribution(ex, peer)}
                              />
                            ) : null}
                          </>
                        )
                      })()}
                    </td>
                    <td>{fmtExpiry(ex.expiry ?? g.expiry)}</td>
                    <td>
                      <strong>{fmtUsd(g.strike)}</strong>
                    </td>
                    <td>
                      <LedgerStgInsCell ex={ex} />
                    </td>
                    <td
                      title={[
                        ex.time != null ? `Exec time: ${fmtTs(ex.time)}` : null,
                        ex.report_date ? `Report date: ${fmtTradeDate(ex.report_date)}` : null,
                        ex.settle_date_target ? `Settle date: ${fmtTradeDate(ex.settle_date_target)}` : null,
                      ]
                        .filter(Boolean)
                        .join(' | ')}
                    >
                      {fmtTradeDate(ex.trade_date)}
                    </td>
                    <td>{sideLabel}</td>
                    <td>{ex.quantity != null ? Number(ex.quantity) : '—'}</td>
                    <td>{fmtUsd(ex.price)}</td>
                    <td>{fmtUsd(ex.commission ?? 0)}</td>
                    <td
                      title={
                        hasCombinedStock
                          ? 'Option premium cash flow for this fill plus linked stock slippage (vs Flex close)'
                          : undefined
                      }
                    >
                      <span className={pnlClass}>{fmtUsd(displayPnl)}</span>
                    </td>
                    <td>{ex.account_id ?? '—'}</td>
                    <td>
                      <ExecSourceBadge source={ex.source} />
                    </td>
                    <td>
                      {ex.account_executions_id != null ? (
                        <span className="replay-exec-row-actions">
                          <button
                            type="button"
                            className="btn btn-icon-small"
                            onClick={() => onEditExecution(ex)}
                            title="Edit"
                            aria-label="Edit execution"
                          >
                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </button>
                          <LinkStrategyIconButton
                            title="Assign strategy opportunity and instance"
                            onClick={() => onLinkExecution(ex, groupTrades)}
                          />
                          {onLinkStockExecution ? (
                            <LinkStockLegIconButton
                              title="Link underlying stock fills (exercise or assignment)"
                              onClick={() => onLinkStockExecution(ex)}
                            />
                          ) : null}
                          <button
                            type="button"
                            className="btn btn-icon-small btn-icon-danger"
                            onClick={() => onDeleteExecution(ex)}
                            title="Delete"
                            aria-label="Delete execution"
                          >
                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              <line x1="10" y1="11" x2="10" y2="17" />
                              <line x1="14" y1="11" x2="14" y2="17" />
                            </svg>
                          </button>
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                )
              }),
            )
          )}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={9} className="replay-detail-total-label">
              Total PNL
            </td>
            <td
              className={
                detailsTotalPnl < 0
                  ? 'replay-pnl-detail-negative'
                  : detailsTotalPnl > 0
                    ? 'replay-pnl-detail-positive'
                    : ''
              }
            >
              <strong>{fmtUsd(detailsTotalPnl)}</strong>
            </td>
            <td colSpan={3} />
          </tr>
        </tfoot>
      </table>
    </section>
  )
}
