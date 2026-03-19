import type { Execution, OptExecutionGroup } from '../../types'
import ExecSourceBadge from '../../components/ExecSourceBadge'
import { InfoTooltip } from '../../components/InfoTooltip'
import { fmtExpiry, fmtTradeDate, fmtTs, fmtUsd, getContractLabelParts } from '../../utils/format'
import { getOptGroupKey } from './ledgerOptHelpers'

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

export interface LedgerOrphanOpenOptionSectionProps {
  sortedOpenUnrealized: OptExecutionGroup[]
  expiredUnrealized: OptExecutionGroup[]
  orphanExpandedGroups: OptExecutionGroup[]
  expandedDetailKeys: string[]
  toggleDetailExpand: (key: string) => void
  onExpiredCloseClick: (groupKey: string) => void
  onEditExecution: (ex: Execution) => void
  onLinkExecution: (ex: Execution) => void
  onDeleteExecution: (ex: Execution) => void
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
  onDeleteExecution,
  detailPlaceholder = 'Click an orphan option row above to load details',
}: LedgerOrphanOpenOptionSectionProps) {
  return (
    <>
      {sortedOpenUnrealized.length > 0 && (
        <div className="replay-portfolio-table-wrap replay-portfolio-table-wrap--no-scroll">
          <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
            Open Option
            <InfoTooltip text="Option positions with non-zero net quantity and future expiry. They are excluded from the Summary (fully closed trades only) and the Closed Option table above." />
          </h5>
          <table className="table-operations replay-opt-groups">
            <thead>
              <tr>
                <th className="replay-opt-expand-col"></th>
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
                    aria-expanded={expandedDetailKeys.includes(groupKey)}
                    aria-label={
                      expandedDetailKeys.includes(groupKey)
                        ? 'Collapse group details'
                        : 'Expand group details'
                    }
                  >
                    <td className="replay-opt-expand-col">
                      <span
                        className={`replay-opt-expand-icon ${expandedDetailKeys.includes(groupKey) ? 'expanded' : ''}`}
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
        <div className="replay-portfolio-table-wrap replay-portfolio-table-wrap--no-scroll">
          <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
            Expired but not closed
            <InfoTooltip text="These option contracts have expired but net quantity is not zero. Some executions may be missing in the trade ledger; add the missing trades to close the position." />
          </h5>
          <table className="table-operations replay-opt-groups">
            <thead>
              <tr>
                <th className="replay-opt-expand-col"></th>
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
                    aria-expanded={expandedDetailKeys.includes(groupKey)}
                    aria-label={
                      expandedDetailKeys.includes(groupKey)
                        ? 'Collapse group details'
                        : 'Expand group details'
                    }
                  >
                    <td className="replay-opt-expand-col">
                      <span
                        className={`replay-opt-expand-icon ${expandedDetailKeys.includes(groupKey) ? 'expanded' : ''}`}
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
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={e => {
                          e.stopPropagation()
                          onExpiredCloseClick(groupKey)
                        }}
                      >
                        Close
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <h5 className="replay-sub replay-opt-detail-title page-title-with-tooltip">
        Details (per trade)
        <InfoTooltip text="Click an orphan option row above to load its execution details." />
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
          {orphanExpandedGroups.length === 0 ? (
            <tr>
              <td colSpan={13} className="replay-detail-placeholder">
                {detailPlaceholder}
              </td>
            </tr>
          ) : (
            orphanExpandedGroups.flatMap(g =>
              (g.trades ?? []).map((ex, ti) => {
                const s = (ex.side ?? '').toUpperCase()
                const sideLabel =
                  s === 'BUY' || s === 'BOT' || s === 'B'
                    ? 'Buy'
                    : s === 'SELL' || s === 'SLD' || s === 'S'
                      ? 'Sell'
                      : (ex.side ?? '—')
                const q = Number(ex.quantity) || 0
                const p = Number(ex.price) || 0
                const c = Number(ex.commission) || 0
                const value = q * p * 100 - c
                const isBuy = s === 'BUY' || s === 'BOT' || s === 'B'
                const isSell = !isBuy
                const pnl = isBuy ? -value : value
                const displayPnl = isSell ? Math.abs(pnl) : pnl
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
                        )
                      })()}
                    </td>
                    <td>{fmtExpiry(ex.expiry ?? g.expiry)}</td>
                    <td>
                      <strong>{fmtUsd(g.strike)}</strong>
                    </td>
                    <td>
                      {(() => {
                        const strategyName = ex.strategy_opportunity_name?.trim()
                        const instanceId = ex.strategy_instance_id
                        if (!strategyName && instanceId == null) return '—'
                        return (
                          <span className="replay-stg-ins">
                            <span className="replay-stg-ins-strategy">{strategyName || '—'}</span>
                            <span className="replay-stg-ins-sep">/</span>
                            {instanceId != null ? (
                              <a
                                href={`#/strategies/instances/${instanceId}`}
                                className="replay-stg-ins-link"
                                target="_blank"
                                rel="noopener noreferrer"
                                title={`Open instance #${instanceId}`}
                                aria-label={`Open instance #${instanceId}`}
                              >
                                #{instanceId}
                              </a>
                            ) : (
                              <span className="replay-stg-ins-empty">—</span>
                            )}
                          </span>
                        )
                      })()}
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
                    <td>
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
                            onClick={() => onLinkExecution(ex)}
                          />
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
      </table>
    </>
  )
}
