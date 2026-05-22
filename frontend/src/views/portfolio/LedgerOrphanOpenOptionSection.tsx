import { rl, expandIcon } from '@/lib/replayLayout'
import { w9 } from '@/styles/wave9Classes'
import { cn } from '@/lib/utils'
import type { Execution, OptExecutionGroup, OptionStockLinkSummary } from '../../types'
import {
  ExecRowIconButton,
  LinkStockLegIconButton,
  LinkStrategyIconButton,
  sectionHeadingWithTooltipClass,
} from '@/components/shared/exec-row-buttons'
import ExecSourceBadge from '../../components/ExecSourceBadge'
import { InfoTooltip } from '../../components/InfoTooltip'
import { fmtExpiry, fmtTradeDate, fmtTs, fmtUsd, getContractLabelParts } from '../../utils/format'
import { getOptGroupKey, ledgerOptDetailRowPnl } from './ledgerOptHelpers'
import { LedgerStgInsCell } from './LedgerStgInsCell'

export interface LedgerOrphanOpenOptionSectionProps {
  sortedOpenUnrealized: OptExecutionGroup[]
  expiredUnrealized: OptExecutionGroup[]
  orphanExpandedGroups: OptExecutionGroup[]
  expandedDetailKeys: string[]
  toggleDetailExpand: (key: string) => void
  onExpiredCloseClick: (groupKey: string) => void
  onEditExecution: (ex: Execution) => void
  onLinkExecution: (ex: Execution, sameContractTrades?: Execution[]) => void
  onLinkStockExecution?: (ex: Execution) => void
  onDeleteExecution: (ex: Execution) => void
  /** When set, detail PnL includes linked stock slippage for that option fill (same as closed section). */
  optionStockLinkByOptionId?: Record<number, OptionStockLinkSummary>
  detailPlaceholder?: string
}

export function LedgerOrphanOpenOptionSection({
  sortedOpenUnrealized,
  expiredUnrealized,
  orphanExpandedGroups,
  expandedDetailKeys,
  toggleDetailExpand,
  onExpiredCloseClick,
  onEditExecution,
  onLinkExecution,
  onLinkStockExecution,
  onDeleteExecution,
  optionStockLinkByOptionId,
  detailPlaceholder = 'Click an orphan option row above to load details',
}: LedgerOrphanOpenOptionSectionProps) {
  return (
    <>
      {sortedOpenUnrealized.length > 0 && (
        <div className={cn(rl.portfolioTableWrap, rl.portfolioTableWrapNoScroll)}>
          <h5 className={`rl.sub rl.optDetailTitle ${sectionHeadingWithTooltipClass}`}>
            Open Option
            <InfoTooltip text="Option positions with non-zero net quantity and future expiry. They are excluded from the Summary (fully closed trades only) and the Closed Option table above." />
          </h5>
          <table className={rl.optGroups}>
            <thead>
              <tr>
                <th className={rl.optExpandCol}></th>
                <th>Contract</th>
                <th>Account</th>
                <th>Expiry</th>
                <th>STRIKE</th>
                <th>Net qty</th>
                <th>Trades (side / qty / price / id)</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {sortedOpenUnrealized.map(g => {
                const p = getContractLabelParts(g.contract_key)
                const strikeStr = g.strike != null ? ` ${g.strike}` : ''
                const tradesSummary = (g.trades ?? [])
                  .map(ex => {
                    const s = (ex.side ?? '').toUpperCase()
                    const sideLabel =
                      s === 'BUY' || s === 'BOT' || s === 'B'
                        ? 'Buy'
                        : s === 'SELL' || s === 'SLD' || s === 'S'
                          ? 'Sell'
                          : (ex.side ?? '—')
                    const q = ex.quantity != null ? Number(ex.quantity) : NaN
                    const p_ = ex.price != null ? Number(ex.price) : NaN
                    const idLabel =
                      ex.account_executions_id != null ? `#${ex.account_executions_id}` : 'id?'
                    const parts: string[] = []
                    parts.push(sideLabel)
                    if (Number.isFinite(q)) parts.push(String(q))
                    if (Number.isFinite(p_)) parts.push(`@${p_}`)
                    parts.push(`(${idLabel})`)
                    return parts.join(' ')
                  })
                  .join('; ')
                const uniqueSources = Array.from(
                  new Set(
                    (g.trades ?? []).map(ex => (ex.source ?? '').trim()).filter(src => src.length > 0),
                  ),
                )
                const groupKey = getOptGroupKey(g)
                const uniqueAccounts = Array.from(
                  new Set(
                    (g.trades ?? []).map(ex => (ex.account_id ?? '').trim()).filter(acc => acc.length > 0),
                  ),
                )
                return (
                  <tr
                    key={`open-orphan-${groupKey}`}
                    className={rl.optGroupRow}
                    onClick={() => toggleDetailExpand(groupKey)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleDetailExpand(groupKey)
                      }
                    }}
                    aria-expanded={expandedDetailKeys.includes(groupKey)}
                    aria-label={
                      expandedDetailKeys.includes(groupKey)
                        ? 'Collapse group details'
                        : 'Expand group details'
                    }
                  >
                    <td className={rl.optExpandCol}>
                      <span
                        className={expandIcon(expandedDetailKeys.includes(groupKey))}
                        aria-hidden
                      >
                        {expandedDetailKeys.includes(groupKey) ? '▼' : '▶'}
                      </span>
                    </td>
                    <td>
                      {p.symbol ? (
                        <>
                          <strong>{p.symbol}</strong> {p.rightLabel}
                          {strikeStr}
                        </>
                      ) : (
                        g.contract_key
                      )}
                    </td>
                    <td>{uniqueAccounts.length > 0 ? uniqueAccounts.join(', ') : '—'}</td>
                    <td>{fmtExpiry(g.expiry)}</td>
                    <td>
                      <strong>{fmtUsd(g.strike)}</strong>
                    </td>
                    <td>{g.net_qty}</td>
                    <td>{tradesSummary || '—'}</td>
                    <td>
                      {uniqueSources.length > 0
                        ? uniqueSources.map(s => <ExecSourceBadge key={s} source={s} />)
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {expiredUnrealized.length > 0 && (
        <div className={cn(rl.portfolioTableWrap, rl.portfolioTableWrapNoScroll)}>
          <h5 className={`rl.sub rl.optDetailTitle ${sectionHeadingWithTooltipClass}`}>
            Expired but not closed
            <InfoTooltip text="These option contracts have expired but net quantity is not zero. Some executions may be missing in the trade ledger; add the missing trades to close the position." />
          </h5>
          <table className={rl.optGroups}>
            <thead>
              <tr>
                <th className={rl.optExpandCol}></th>
                <th>Contract</th>
                <th>Account</th>
                <th>Expiry</th>
                <th>STRIKE</th>
                <th>Net qty</th>
                <th>Trades (side / qty / price / id)</th>
                <th>Source</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {expiredUnrealized.map(g => {
                const p = getContractLabelParts(g.contract_key)
                const strikeStr = g.strike != null ? ` ${g.strike}` : ''
                const tradesSummary = (g.trades ?? [])
                  .map(ex => {
                    const s = (ex.side ?? '').toUpperCase()
                    const sideLabel =
                      s === 'BUY' || s === 'BOT' || s === 'B'
                        ? 'Buy'
                        : s === 'SELL' || s === 'SLD' || s === 'S'
                          ? 'Sell'
                          : (ex.side ?? '—')
                    const q = ex.quantity != null ? Number(ex.quantity) : NaN
                    const p_ = ex.price != null ? Number(ex.price) : NaN
                    const idLabel =
                      ex.account_executions_id != null ? `#${ex.account_executions_id}` : 'id?'
                    const parts: string[] = []
                    parts.push(sideLabel)
                    if (Number.isFinite(q)) parts.push(String(q))
                    if (Number.isFinite(p_)) parts.push(`@${p_}`)
                    parts.push(`(${idLabel})`)
                    return parts.join(' ')
                  })
                  .join('; ')
                const uniqueSources = Array.from(
                  new Set(
                    (g.trades ?? []).map(ex => (ex.source ?? '').trim()).filter(src => src.length > 0),
                  ),
                )
                const groupKey = getOptGroupKey(g)
                const uniqueAccounts = Array.from(
                  new Set(
                    (g.trades ?? []).map(ex => (ex.account_id ?? '').trim()).filter(acc => acc.length > 0),
                  ),
                )
                return (
                  <tr
                    key={`expired-${groupKey}`}
                    className={rl.optGroupRow}
                    onClick={() => toggleDetailExpand(groupKey)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        toggleDetailExpand(groupKey)
                      }
                    }}
                    aria-expanded={expandedDetailKeys.includes(groupKey)}
                    aria-label={
                      expandedDetailKeys.includes(groupKey)
                        ? 'Collapse group details'
                        : 'Expand group details'
                    }
                  >
                    <td className={rl.optExpandCol}>
                      <span
                        className={expandIcon(expandedDetailKeys.includes(groupKey))}
                        aria-hidden
                      >
                        {expandedDetailKeys.includes(groupKey) ? '▼' : '▶'}
                      </span>
                    </td>
                    <td>
                      {p.symbol ? (
                        <>
                          <strong>{p.symbol}</strong> {p.rightLabel}
                          {strikeStr}
                        </>
                      ) : (
                        g.contract_key
                      )}
                    </td>
                    <td>{uniqueAccounts.length > 0 ? uniqueAccounts.join(', ') : '—'}</td>
                    <td>{fmtExpiry(g.expiry)}</td>
                    <td>
                      <strong>{fmtUsd(g.strike)}</strong>
                    </td>
                    <td>{g.net_qty}</td>
                    <td>{tradesSummary || '—'}</td>
                    <td>
                      {uniqueSources.length > 0
                        ? uniqueSources.map(s => <ExecSourceBadge key={s} source={s} />)
                        : '—'}
                    </td>
                    <td className={rl.optActionsCell}>
                      <ExecRowIconButton
                        onClick={e => {
                          e.stopPropagation()
                          onExpiredCloseClick(groupKey)
                        }}
                        title="Close expired position"
                        aria-label="Close expired position"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          width={16}
                          height={16}
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          aria-hidden
                        >
                          <circle cx="12" cy="12" r="10" />
                          <path d="m15 9-6 6M9 9l6 6" />
                        </svg>
                      </ExecRowIconButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <h5 className={`rl.sub rl.optDetailTitle ${sectionHeadingWithTooltipClass}`}>
        Details (per trade)
        <InfoTooltip text="Click an orphan option row above to load its execution details." />
      </h5>
      <table className={w9.tableOperations}>
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
          {orphanExpandedGroups.length === 0 ? (
            <tr>
              <td colSpan={13} className={rl.detailPlaceholder}>
                {detailPlaceholder}
              </td>
            </tr>
          ) : (
            orphanExpandedGroups.flatMap(g =>
              (g.trades ?? []).map((ex, ti) => {
                const groupTrades = g.trades ?? []
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
                        return p_.symbol ? (
                          <>
                            <strong>{p_.symbol}</strong> {p_.rightLabel}
                            {strikeStr_}
                            {ex.account_executions_id != null && (
                              <span className={rl.contractExecId}>#{ex.account_executions_id}</span>
                            )}
                          </>
                        ) : (
                          <>
                            {g.contract_key}
                            {ex.account_executions_id != null && (
                              <span className={rl.contractExecId}>#{ex.account_executions_id}</span>
                            )}
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
                        <span className={rl.execRowActions}>
                          <ExecRowIconButton
                            onClick={() => onEditExecution(ex)}
                            title="Edit"
                            aria-label="Edit execution"
                          >
                            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                            </svg>
                          </ExecRowIconButton>
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
                          <ExecRowIconButton
                            variant="danger"
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
                          </ExecRowIconButton>
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
      </table>
    </>
  )
}
