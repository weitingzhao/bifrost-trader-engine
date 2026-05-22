import type { Execution, RealtimeQuote } from '../../types'
import type { OpenOptionPosition } from '../portfolio/types'
import { OptionExecutionRow } from './OptionExecutionRow'
import type { OptionExecRowActions } from './OptionExecutionRow'
import {
  daysUntilExpiry,
  fmtDate,
  fmtDaysAgo,
  fmtExpiry,
  fmtUsd,
  getContractLabelParts,
  parseOptionContractKey,
} from '../../utils/format'
import { instanceIconFillFromMergedExecutions, optionLastStrikePctClass } from './positionUtils'

export type OpenOptSortCol =
  | 'contract'
  | 'expiry'
  | 'strike'
  | 'last'
  | 'qty'
  | 'avg_cost'
  | 'value'
  | 'time'
  | 'un_pnl'

export interface OpenOptSort {
  column: OpenOptSortCol
  dir: 'asc' | 'desc'
}

type ExecLists = { final: Execution[]; tws: Execution[]; merged: Execution[] }

interface Props {
  positions: OpenOptionPosition[]
  sortedPositions: OpenOptionPosition[]
  sort: OpenOptSort
  onSortToggle: (col: OpenOptSortCol) => void
  expandedKeys: string[]
  onToggleExpand: (posKey: string) => void
  getPositionKey: (p: OpenOptionPosition) => string
  getExecLists: (p: OpenOptionPosition) => ExecLists
  getTime: (p: OpenOptionPosition) => number | null
  quotesMap: Record<string, RealtimeQuote>
  onOpenOptionInspector: (p: OpenOptionPosition) => void
  canonicalOptContractKeySet: Set<string>
  syncingTwsAttributionKey: string | null
  syncingFinalAttributionKey: string | null
  execRowActions: OptionExecRowActions
}

export function PositionOptionsTab({
  positions,
  sortedPositions,
  sort,
  onSortToggle,
  expandedKeys,
  onToggleExpand,
  getPositionKey,
  getExecLists,
  getTime,
  quotesMap,
  onOpenOptionInspector,
  canonicalOptContractKeySet,
  syncingTwsAttributionKey,
  syncingFinalAttributionKey,
  execRowActions,
}: Props) {
  return (
    <div
      id="open-panel-options"
      role="tabpanel"
      aria-labelledby="open-tab-options"
      className="system-tab-panel"
    >
      <h5 className="replay-sub">Option positions</h5>
      {positions.length === 0 ? (
        <p className="section-hint">No open option positions under the current filters.</p>
      ) : (
        <div className="replay-portfolio-table-wrap replay-portfolio-table-wrap--no-scroll">
          <table className="table-operations replay-opt-groups positions-opt-main-table">
            <colgroup>
              <col className="pom-col-expand" />
              <col className="pom-col-contract" />
              <col className="pom-col-expiry" />
              <col className="pom-col-strike" />
              <col className="pom-col-last" />
              <col className="pom-col-qty" />
              <col className="pom-col-at" />
              <col className="pom-col-value" />
              <col className="pom-col-quote" />
              <col className="pom-col-time" />
              <col className="pom-col-unpnl" />
              <col className="pom-col-opp" />
              <col className="pom-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th className="replay-opt-expand-col" />
                {(() => {
                  const cols: { col: OpenOptSortCol; label: string; title?: string }[] = [
                    { col: 'contract', label: 'Contract' },
                    { col: 'expiry', label: 'Expiry' },
                    { col: 'strike', label: 'Strike' },
                    { col: 'last', label: 'Last', title: 'Underlying last price; (Last − Strike) / Last %' },
                    { col: 'qty', label: 'Qty' },
                    { col: 'avg_cost', label: '@' },
                    { col: 'value', label: 'Value' },
                    { col: 'time', label: 'Time' },
                    { col: 'un_pnl', label: 'UN PNL' },
                  ]
                  return cols.flatMap(c => {
                    const th = (
                      <th
                        key={c.col}
                        className="replay-th-sortable"
                        title={c.title ?? `Sort by ${c.label}`}
                        onClick={() => onSortToggle(c.col)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSortToggle(c.col) } }}
                        aria-sort={sort.column === c.col ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                      >
                        {c.label}{sort.column === c.col ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                      </th>
                    )
                    if (c.col === 'value') {
                      return [th, <th key="opt-quote" title="Option live bid / mid / ask">Opt Quote</th>]
                    }
                    return [th]
                  })
                })()}
                <th title="Opportunity">Opp</th>
                <th className="replay-opt-actions-cell">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedPositions.flatMap(pos => {
                const posKey = getPositionKey(pos)
                const absQty = Math.abs(pos.qty)
                const sideLabel = pos.qty > 0 ? 'Long' : pos.qty < 0 ? 'Short' : '—'
                const value = (pos.avg_cost ?? 0) * absQty * 100
                const ts = getTime(pos)
                const execLists = getExecLists(pos)
                const execCount = execLists.final.length + execLists.tws.length
                const hasExecutions = execCount > 0
                const isPosExpanded = expandedKeys.includes(posKey)
                const posRow = (
                  <tr
                    key={posKey}
                    className="detail-position-row"
                    onClick={hasExecutions ? e => { e.stopPropagation(); onToggleExpand(posKey) } : undefined}
                    role={hasExecutions ? 'button' : undefined}
                    tabIndex={hasExecutions ? 0 : undefined}
                    onKeyDown={hasExecutions ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleExpand(posKey) } } : undefined}
                    aria-expanded={hasExecutions ? isPosExpanded : undefined}
                  >
                    <td className="replay-opt-expand-col">
                      {hasExecutions ? (
                        <span className={`replay-opt-expand-icon ${isPosExpanded ? 'expanded' : ''}`} aria-hidden>
                          {isPosExpanded ? '▼' : '▶'}
                        </span>
                      ) : null}
                    </td>
                    <td className="replay-opt-contract">
                      {(() => {
                        const p = getContractLabelParts(pos.contract_key)
                        const strikeStr = pos.strike != null ? ` ${pos.strike}` : ''
                        const fill = instanceIconFillFromMergedExecutions(execLists.merged)
                        const instanceIcon =
                          fill === 'empty'
                            ? null
                            : fill === 'none' ? (
                                <span
                                  className="ledger-instance-icon-link ledger-instance-icon-link--different"
                                  title="None of the matched executions have a strategy instance"
                                  aria-label="No strategy instance on matched executions"
                                  role="img"
                                  onClick={e => e.stopPropagation()}
                                >
                                  <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <rect x="5" y="5" width="14" height="14" rx="1" />
                                  </svg>
                                </span>
                              ) : fill === 'all' ? (
                                <span
                                  className="ledger-instance-icon-link ledger-instance-icon-link--same"
                                  title="All matched executions have a strategy instance"
                                  aria-label="All matched executions have a strategy instance"
                                  role="img"
                                  onClick={e => e.stopPropagation()}
                                >
                                  <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <rect x="5" y="5" width="14" height="14" rx="1" />
                                  </svg>
                                </span>
                              ) : (
                                <span
                                  className="ledger-instance-icon-link ledger-instance-icon-link--mixed"
                                  title="Some matched executions have a strategy instance, some do not"
                                  aria-label="Mixed strategy instance on matched executions"
                                  role="img"
                                  onClick={e => e.stopPropagation()}
                                >
                                  <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                    <rect x="5" y="5" width="14" height="14" rx="1" />
                                  </svg>
                                </span>
                              )
                        return p.symbol ? (
                          <>
                            {instanceIcon}
                            <button
                              type="button"
                              className="riv-opt-contract-btn"
                              onClick={e => { e.stopPropagation(); onOpenOptionInspector(pos) }}
                              aria-label={`Option details for ${p.symbol} ${p.rightLabel}${strikeStr}`}
                            >
                              <strong>{p.symbol}</strong> {p.rightLabel}
                              {strikeStr}
                            </button>
                          </>
                        ) : (
                          <>
                            {instanceIcon}
                            <button
                              type="button"
                              className="riv-opt-contract-btn"
                              onClick={e => { e.stopPropagation(); onOpenOptionInspector(pos) }}
                              aria-label={`Option details for ${pos.contract_key}`}
                            >
                              {pos.contract_key}
                            </button>
                          </>
                        )
                      })()}
                    </td>
                    <td className="positions-opt-expiry-cell">
                      <div className="positions-opt-expiry-line1">{fmtExpiry(pos.expiry)}</div>
                      {(() => {
                        const days = daysUntilExpiry(pos.expiry)
                        if (days == null) return null
                        const label = days >= 0 ? (days === 0 ? 'today' : `${days}d`) : `${-days}d ago`
                        return (
                          <div className="positions-opt-expiry-line2">
                            <span className="expiry-days-remaining" title={days >= 0 ? `${days} days left` : `Expired ${-days} days ago`}>{label}</span>
                          </div>
                        )
                      })()}
                    </td>
                    <td><strong>{fmtUsd(pos.strike)}</strong></td>
                    <td className="positions-opt-last-cell">
                      {(() => {
                        const underlying = getContractLabelParts(pos.contract_key).symbol
                        const q = underlying ? quotesMap[underlying] : undefined
                        const last = q?.last != null && Number.isFinite(q.last) ? q.last : null
                        const strikeNum = pos.strike != null && Number.isFinite(pos.strike) ? pos.strike : null
                        const pct = last != null && strikeNum != null && last !== 0 ? ((last - strikeNum) / last) * 100 : null
                        const right = parseOptionContractKey(pos.contract_key).right
                        const side: 'Buy' | 'Sell' = pos.qty > 0 ? 'Buy' : 'Sell'
                        const pctClass = pct != null ? optionLastStrikePctClass(right, side, pct) : ''
                        return (
                          <>
                            <div className="positions-opt-last-line1">{last != null ? fmtUsd(last) : '—'}</div>
                            {pct != null ? (
                              <div className="positions-opt-last-line2">
                                <span className={`replay-last-strike-pct ${pctClass}`.trim()} title={`(Last − Strike) / Last = ${pct.toFixed(2)}%`}>
                                  {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                                </span>
                              </div>
                            ) : null}
                          </>
                        )
                      })()}
                    </td>
                    <td>{sideLabel} {absQty}</td>
                    <td>{fmtUsd(pos.avg_cost)}</td>
                    <td>{fmtUsd(value)}</td>
                    <td className="positions-opt-live-quote">
                      {(() => {
                        const liveQ = quotesMap[pos.contract_key]
                        if (!liveQ) return <span className="replay-muted">—</span>
                        const mid = liveQ.mid ?? (liveQ.bid != null && liveQ.ask != null ? (liveQ.bid + liveQ.ask) / 2 : null)
                        return (
                          <>
                            <div className="positions-opt-quote-line positions-opt-quote-line--bid">
                              {liveQ.bid != null ? <span className="positions-opt-quote-bid">{liveQ.bid.toFixed(2)}</span> : <span className="replay-muted">—</span>}
                            </div>
                            <div className="positions-opt-quote-line positions-opt-quote-line--mid">
                              <strong>{mid != null ? mid.toFixed(2) : '—'}</strong>
                            </div>
                            <div className="positions-opt-quote-line positions-opt-quote-line--ask">
                              {liveQ.ask != null ? <span className="positions-opt-quote-ask">{liveQ.ask.toFixed(2)}</span> : <span className="replay-muted">—</span>}
                            </div>
                          </>
                        )
                      })()}
                    </td>
                    <td className="positions-opt-time-cell">
                      {ts != null ? (
                        <>
                          <div className="positions-opt-time-line1">{fmtDate(ts)}</div>
                          {fmtDaysAgo(ts) ? <div className="positions-opt-time-line2"><span className="replay-time-ago">{fmtDaysAgo(ts)}</span></div> : null}
                        </>
                      ) : '—'}
                    </td>
                    <td>
                      {(() => {
                        const liveQ = quotesMap[pos.contract_key]
                        const liveMid = liveQ?.mid ?? (liveQ?.bid != null && liveQ?.ask != null ? (liveQ.bid + liveQ.ask) / 2 : null)
                        const livePnl = liveMid != null && pos.avg_cost != null
                          ? (liveMid - pos.avg_cost) * absQty * 100 : null
                        return (
                          <>
                            {livePnl != null && (
                              <div>
                                <span className={`replay-pnl-unrealized ${livePnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{fmtUsd(livePnl)}</span>
                                <span className="replay-muted" style={{fontSize:'0.7em'}}> live</span>
                              </div>
                            )}
                            <div className={livePnl != null ? 'replay-muted' : undefined} style={livePnl != null ? {fontSize:'0.75em'} : undefined}>
                              <span className={`replay-pnl-unrealized ${pos.unrealized_pnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>{fmtUsd(pos.unrealized_pnl)}</span>
                              {livePnl != null && <span style={{fontSize:'0.7em'}}> snap</span>}
                            </div>
                          </>
                        )
                      })()}
                    </td>
                    <td className="replay-strategy-opp-cell positions-opt-opp-hint-cell">
                      {execCount === 0 ? '—' : (
                        <span className="replay-muted" title={`${execCount} execution${execCount > 1 ? 's' : ''} — expand row`}>
                          {execCount} exec{execCount > 1 ? 's' : ''} ↓
                        </span>
                      )}
                    </td>
                    <td className="replay-opt-actions-cell">—</td>
                  </tr>
                )
                const execRows = isPosExpanded
                  ? [
                      ...execLists.final.map((ex, ei) => (
                        <OptionExecutionRow
                          key={`${posKey}-exec-final-${ex.account_executions_id ?? ei}`}
                          pos={pos} posKey={posKey} ex={ex} ei={ei}
                          book="final" finalRows={execLists.final} twsRows={execLists.tws}
                          includeAttrColumn={false} includeAccountColumn={false}
                          canonicalOptContractKeySet={canonicalOptContractKeySet}
                          syncingTwsAttributionKey={syncingTwsAttributionKey}
                          syncingFinalAttributionKey={syncingFinalAttributionKey}
                          actions={execRowActions}
                        />
                      )),
                      ...execLists.tws.map((ex, ei) => (
                        <OptionExecutionRow
                          key={`${posKey}-exec-tws-${ex.account_executions_id ?? ei}`}
                          pos={pos} posKey={posKey} ex={ex} ei={ei}
                          book="tws" finalRows={execLists.final} twsRows={execLists.tws}
                          includeAttrColumn={false} includeAccountColumn={false}
                          canonicalOptContractKeySet={canonicalOptContractKeySet}
                          syncingTwsAttributionKey={syncingTwsAttributionKey}
                          syncingFinalAttributionKey={syncingFinalAttributionKey}
                          actions={execRowActions}
                        />
                      )),
                    ]
                  : []
                return [posRow, ...execRows]
              })}
            </tbody>
            <tfoot>
              <tr className="replay-opt-tfoot-total">
                <td colSpan={12} className="replay-opt-tfoot-label">Total</td>
                <td>
                  <span className="replay-pnl-unrealized">
                    {fmtUsd(positions.reduce((acc, p) => acc + p.unrealized_pnl, 0))}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
