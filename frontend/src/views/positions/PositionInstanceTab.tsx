import { Fragment } from 'react'
import { Button } from '@/components/ui/button'
import {
  optContractInspectorBtnClass,
  stockSymbolInspectorBtnClass,
  stockSymbolInspectorBtnCompactClass,
} from '@/components/shared/exec-row-buttons'
import { cn } from '@/lib/utils'
import type { Execution, RealtimeQuote } from '../../types'
import type { InstanceAllGroup, LivePositionRow, OpenOptionPosition, StockCoverageItem } from '../portfolio/types'
import type { StrategyOpportunity } from '../../api/strategy/strategies'
import {
  daysUntilExpiry,
  fmtDate,
  fmtDaysAgo,
  fmtExpiry,
  fmtUsd,
  getContractLabelParts,
  parseOptionContractKey,
} from '../../utils/format'
import {
  underlyingCoverageStockMetrics,
  fmtSignedPct,
  optionLastStrikePctClass,
  fmtSurplusShares,
} from './positionUtils'
import type { CoveragePoolSortCol } from './positionUtils'
import { StockCoverageTable } from './StockCoverageTable'
import { OptionExecutionRow } from './OptionExecutionRow'
import type { OptionExecRowActions } from './OptionExecutionRow'
import { renderIndependentHoldingRow } from './StockBucketPanel'
import { InfoTooltip } from '../../components/InfoTooltip'
import { RiskProfileDl } from '../../components/RiskProfileDl'
import { formatRiskLabel, formatRiskHedgedBreakdown } from '../../utils/riskProfile'
import { executionMatchesInstanceGroup } from '../portfolio/ledgerOptHelpers'

interface InstanceFilterState {
  structureType: string
  onStructureTypeChange: (v: string) => void
  scopeType: string
  onScopeTypeChange: (v: string) => void
  oppName: string
  onOppNameChange: (v: string) => void
  attributionType: string
  onAttributionTypeChange: (v: string) => void
  options: { structureTypes: string[]; scopeTypes: string[]; oppNames: string[] }
}

interface InstanceExpandState {
  instanceKeys: string[]
  toggleInstance: (key: string) => void
  positionKeys: string[]
  togglePosition: (posKey: string) => void
}

interface InstanceSortState {
  underlyingPool: { col: CoveragePoolSortCol; dir: 'asc' | 'desc' }
  onUnderlyingPoolClick: (col: CoveragePoolSortCol) => void
  backingPool: { col: CoveragePoolSortCol; dir: 'asc' | 'desc' }
  onBackingPoolClick: (col: CoveragePoolSortCol) => void
}

interface InstanceActions {
  openStockInspector: (p: LivePositionRow) => void
  openOptionInspector: (p: OpenOptionPosition) => void
  openStrategyInspector: (id: number) => void
  tryOpenStock: (symbol: string, accountId: string) => void
  getDefaultAccount: (group: InstanceAllGroup) => string
}

type ExecLists = { final: Execution[]; tws: Execution[]; merged: Execution[] }

interface Props {
  sortedGroups: InstanceAllGroup[]
  filter: InstanceFilterState
  expand: InstanceExpandState
  sort: InstanceSortState
  actions: InstanceActions
  oppMap: Map<number, StrategyOpportunity>
  liveStockPositions: LivePositionRow[]
  quotesMap: Record<string, RealtimeQuote>
  cashBp: {
    host: { cash: number | null; bp: number | null }
    secondary: { cash: number | null; bp: number | null }
  }
  underlyingPoolItems: StockCoverageItem[]
  underlyingPoolMarketTotal: number
  sortedUnderlyingPoolItems: StockCoverageItem[]
  watchlistItems: StockCoverageItem[]
  sortedWatchlistItems: StockCoverageItem[]
  independentSections: ReadonlyArray<{ title: string; key: string; rows: LivePositionRow[] }>
  streamHostAccountId: string
  streamSecondaryAccountId: string
  formatOptExecQtyCell: (group: InstanceAllGroup) => string
  getPositionKey: (pos: OpenOptionPosition, instId: number | null | undefined) => string
  getExecLists: (pos: OpenOptionPosition) => ExecLists
  getTime: (pos: OpenOptionPosition) => number | null
  canonicalOptContractKeySet: Set<string>
  syncingTwsAttributionKey: string | null
  syncingFinalAttributionKey: string | null
  execRowActions: OptionExecRowActions
}

export function PositionInstanceTab({
  sortedGroups,
  filter,
  expand,
  sort,
  actions,
  oppMap,
  liveStockPositions,
  quotesMap,
  cashBp,
  underlyingPoolItems,
  underlyingPoolMarketTotal,
  sortedUnderlyingPoolItems,
  watchlistItems,
  sortedWatchlistItems,
  independentSections,
  streamHostAccountId,
  streamSecondaryAccountId,
  formatOptExecQtyCell,
  getPositionKey,
  getExecLists,
  getTime,
  canonicalOptContractKeySet,
  syncingTwsAttributionKey,
  syncingFinalAttributionKey,
  execRowActions,
}: Props) {
  return (
  <div
    id="open-panel-strategy"
    role="tabpanel"
    aria-labelledby="open-tab-strategy"
    className="system-tab-panel"
  >
    <div className="instance-sheet-filters">
      <select
        className="replay-filter-select"
        value={filter.structureType}
        onChange={e => filter.onStructureTypeChange(e.target.value)}
        aria-label="Filter by contract type"
      >
        <option value="all">All Contract Types</option>
        {filter.options.structureTypes.map(st => (
          <option key={st} value={st}>{st.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>
        ))}
      </select>
      <select
        className="replay-filter-select"
        value={filter.oppName}
        onChange={e => filter.onOppNameChange(e.target.value)}
        aria-label="Filter by opportunity"
      >
        <option value="all">All Opportunities</option>
        {filter.options.oppNames.map(n => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
      <div className="instance-sheet-filter-bubble-row">
        <span className="instance-sheet-filter-bubble-label" id="instance-filter-scope-label">
          Symbol scope
        </span>
        <div
          className="replay-bubble-switch instance-sheet-bubble-switch--wrap"
          role="radiogroup"
          aria-labelledby="instance-filter-scope-label"
        >
          <button
            type="button"
            role="radio"
            aria-checked={filter.scopeType === 'all'}
            className={`replay-bubble-switch-btn ${filter.scopeType === 'all' ? 'active' : ''}`}
            onClick={() => filter.onScopeTypeChange('all')}
          >
            All
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={filter.scopeType === '__none__'}
            className={`replay-bubble-switch-btn ${filter.scopeType === '__none__' ? 'active' : ''}`}
            onClick={() => filter.onScopeTypeChange('__none__')}
          >
            None
          </button>
          {filter.options.scopeTypes.filter(s => s !== '').map(s => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={filter.scopeType === s}
              className={`replay-bubble-switch-btn ${filter.scopeType === s ? 'active' : ''}`}
              onClick={() => filter.onScopeTypeChange(s)}
            >
              {s === 'watchlist_stk' ? 'Watchlist (stocks)' : s === 'explicit_symbols' ? 'Explicit symbols' : s}
            </button>
          ))}
        </div>
      </div>
      <div className="instance-sheet-filter-bubble-row">
        <span className="instance-sheet-filter-bubble-label" id="instance-filter-attr-label">
          Attribution
        </span>
        <div
          className="replay-bubble-switch"
          role="radiogroup"
          aria-labelledby="instance-filter-attr-label"
        >
          {(['all', 'single', 'mixed', 'unassigned'] as const).map(v => (
            <button
              key={v}
              type="button"
              role="radio"
              aria-checked={filter.attributionType === v}
              className={`replay-bubble-switch-btn ${filter.attributionType === v ? 'active' : ''}`}
              onClick={() => filter.onAttributionTypeChange(v)}
            >
              {v === 'all' ? 'All' : v === 'single' ? 'Single' : v === 'mixed' ? 'Mixed' : 'Unassigned'}
            </button>
          ))}
        </div>
      </div>
      {(filter.structureType !== 'all' || filter.scopeType !== 'all' || filter.oppName !== 'all' || filter.attributionType !== 'all') && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => { filter.onStructureTypeChange('all'); filter.onScopeTypeChange('all'); filter.onOppNameChange('all'); filter.onAttributionTypeChange('all') }}
        >
          Clear Filters
        </Button>
      )}
    </div>
    {sortedGroups.length === 0 ? (
      <p className="section-hint">No strategies match the current filters.</p>
    ) : (
      <div className="replay-portfolio-table-wrap">
        <table className="table-operations instance-sheet-table">
          <thead>
            <tr>
              <th className="replay-opt-expand-col" />
              <th title="Opportunity">Opp</th>
              <th>Contract Type</th>
              <th>Symbols</th>
              <th>Opened</th>
              <th title="Per option: execution quantities (comma-separated). Uses Final book only when at least one matching Final exists; otherwise TWS. Multiple option lines separated by |.">
                Exec Qty
              </th>
              <th>Underlying</th>
              <th>Opt PNL</th>
              <th>Max Gain</th>
              <th>Max Loss</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {sortedGroups.map(allGroup => {
              const instKey = allGroup.strategy_instance_id != null ? String(allGroup.strategy_instance_id) : '__unassigned__'
              const instLabel = allGroup.strategy_instance_label ?? (allGroup.strategy_instance_id != null ? `Strategy #${allGroup.strategy_instance_id}` : 'Uncategorized')
              const oppName = allGroup.strategy_opportunity_name?.trim() || null
              const openedAt = allGroup.strategy_instance_opened_at_epoch
              const optN = allGroup.options.length
              const optExecQtySummary = formatOptExecQtyCell(allGroup)
              const covN = allGroup.stock_coverage.length
              const isExpanded = expand.instanceKeys.includes(instKey)
              const structLabel = allGroup.structure_type
                ? allGroup.structure_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
                : '—'
              const structBadgeClass = allGroup.structure_type
                ? `instance-sheet-badge instance-sheet-badge-${allGroup.structure_type.replace(/_/g, '-')}`
                : 'instance-sheet-badge'
              const opp = allGroup.strategy_opportunity_id != null ? oppMap.get(allGroup.strategy_opportunity_id) : undefined
              const scopeSymbols = opp?.symbols ?? []
              const scopeType = allGroup.scope_type
              const defaultAccForScope = actions.getDefaultAccount(allGroup)
              const symbolsCell =
                scopeType === 'watchlist_stk' ? (
                  <span className="instance-sheet-badge instance-sheet-badge-scope">Watchlist</span>
                ) : scopeSymbols.length > 0 ? (
                  <span className="instance-sheet-symbols instance-sheet-symbols--buttons">
                    {scopeSymbols.map((symRaw, i) => {
                      const t = String(symRaw ?? '').trim()
                      if (!t) return null
                      return (
                        <Fragment key={`${instKey}-scope-sym-${i}-${t}`}>
                          {i > 0 ? <span className="instance-sheet-symbols-sep" aria-hidden>, </span> : null}
                          <button
                            type="button"
                            className={cn(stockSymbolInspectorBtnClass, stockSymbolInspectorBtnCompactClass)}
                            onClick={e => {
                              e.stopPropagation()
                              actions.tryOpenStock(t, defaultAccForScope)
                            }}
                            aria-label={`Stock details for ${t} (account ${defaultAccForScope || '—'})`}
                          >
                            {t}
                          </button>
                        </Fragment>
                      )
                    })}
                  </span>
                ) : (
                  <span className="replay-muted">—</span>
                )
              return [
                <tr
                  key={`inst-row-${instKey}`}
                  className={`instance-sheet-row ${isExpanded ? 'instance-sheet-row-expanded' : ''}`}
                  onClick={() => expand.toggleInstance(instKey)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); expand.toggleInstance(instKey) } }}
                  aria-expanded={isExpanded}
                >
                  <td className="replay-opt-expand-col">
                    <span className={`replay-opt-expand-icon ${isExpanded ? 'expanded' : ''}`} aria-hidden>
                      {isExpanded ? '▼' : '▶'}
                    </span>
                  </td>
                  <td className="instance-sheet-opp-cell">
                    {allGroup.strategy_instance_id != null ? (
                      <>
                        {oppName ? (
                          <span className="instance-sheet-opp-name">{oppName}</span>
                        ) : null}
                        <button
                          type="button"
                          className="instance-sheet-inst-link instance-sheet-inst-sublabel"
                          title={`View strategy: ${instLabel}`}
                          onClick={e => {
                            e.stopPropagation()
                            actions.openStrategyInspector(allGroup.strategy_instance_id!)
                          }}
                        >
                          {instLabel}
                        </button>
                      </>
                    ) : (
                      <span>{oppName || instLabel}</span>
                    )}
                  </td>
                  <td><span className={structBadgeClass}>{structLabel}</span></td>
                  <td>{symbolsCell}</td>
                  <td>
                    {openedAt != null && Number.isFinite(openedAt) ? (
                      <>{fmtDate(openedAt)}{fmtDaysAgo(openedAt) ? <span className="replay-time-ago"> {fmtDaysAgo(openedAt)}</span> : null}</>
                    ) : '—'}
                  </td>
                  <td
                    className="instance-sheet-exec-qty-cell"
                    title="Per option: execution quantities (comma-separated). Final preferred over TWS when matching Finals exist. | separates option lines."
                  >
                    {optN > 0 ? optExecQtySummary : '—'}
                  </td>
                  <td>
                    {covN > 0 ? (() => {
                      let allCovered = true
                      let anyNaked = false
                      for (const sc of allGroup.stock_coverage) {
                        const hp = liveStockPositions.find(
                          s =>
                            (s.symbol ?? '').toUpperCase() === (sc.symbol ?? '').toUpperCase() &&
                            (s.account_id ?? '').trim() === (sc.account_id ?? '').trim(),
                        )
                        const held = hp ? Math.abs(Number(hp.position) || 0) : 0
                        if (held >= sc.required_shares) continue
                        allCovered = false
                        if (held === 0) anyNaked = true
                      }
                      const statusClass = allCovered
                        ? 'coverage-status-covered'
                        : anyNaked
                          ? 'coverage-status-naked'
                          : 'coverage-status-partial'
                      const statusLabel = allCovered ? 'Covered' : anyNaked ? 'Naked' : 'Partial'
                      return <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
                    })() : <span className="replay-muted">—</span>}
                  </td>
                  <td>{optN > 0 ? <span className="replay-pnl-unrealized">{fmtUsd(allGroup.options_unrealized_pnl)}</span> : <span className="replay-muted">—</span>}</td>
                  {(() => {
                    if (!allGroup.risk_profile) return <><td className="replay-muted">—</td><td className="replay-muted">—</td><td className="replay-muted">—</td></>
                    const rl = formatRiskLabel(allGroup.risk_profile)
                    return <>
                      <td><span className="risk-value-gain">{rl.gainLabel}</span></td>
                      <td><span className={allGroup.risk_profile.max_loss == null ? 'risk-value-loss risk-value-unlimited' : 'risk-value-loss'}>{rl.lossLabel}</span></td>
                      <td><span className={`coverage-status-badge ${allGroup.risk_profile.risk_type === 'defined' ? 'risk-badge-defined' : 'risk-badge-unlimited'}`}>{rl.riskBadge}</span></td>
                    </>
                  })()}
                </tr>,
                ...(isExpanded ? [
                  <tr key={`inst-detail-${instKey}`} className="instance-sheet-detail-row">
                    <td colSpan={11} className="instance-sheet-detail-cell">
                      {optN > 0 && (
                        <div className="instance-sheet-sub-section">
                          <h6 className="replay-sub instance-sheet-sub-heading">Options ({optN})</h6>
                          <div className="replay-portfolio-table-wrap">
                            <table className="table-operations replay-opt-groups instance-sheet-sub-table positions-opt-instance-table">
                              <colgroup>
                                <col className="poi-col-expand" />
                                <col className="poi-col-contract" />
                                <col className="poi-col-expiry" />
                                <col className="poi-col-strike" />
                                <col className="poi-col-last" />
                                <col className="poi-col-qty" />
                                <col className="poi-col-at" />
                                <col className="poi-col-value" />
                                <col className="poi-col-quote" />
                                <col className="poi-col-time" />
                                <col className="poi-col-unpnl" />
                                <col className="poi-col-pool" />
                                <col className="poi-col-attr" />
                                <col className="poi-col-account" />
                                <col className="poi-col-opp" />
                                <col className="poi-col-actions" />
                              </colgroup>
                              <thead>
                                <tr>
                                  <th className="replay-opt-expand-col" />
                                  <th>Contract</th>
                                  <th>Expiry</th>
                                  <th>Strike</th>
                                  <th>Last</th>
                                  <th>Qty</th>
                                  <th>@</th>
                                  <th>Value</th>
                                  <th title="Option live bid / mid / ask">Opt Quote</th>
                                  <th>Time</th>
                                  <th>UN PNL</th>
                                  <th>Pool</th>
                                  <th>Attr</th>
                                  <th>Account</th>
                                  <th title="Opportunity">Opp</th>
                                  <th className="replay-opt-actions-cell">Actions</th>
                                </tr>
                              </thead>
                              <tbody>
                                {allGroup.options.map((pos) => {
                                  const posKey = `ia-${instKey}-${getPositionKey(pos, allGroup.strategy_instance_id)}`
                                  const absQty = Math.abs(pos.qty)
                                  const sideLabel = pos.qty > 0 ? 'Long' : pos.qty < 0 ? 'Short' : '—'
                                  const value = (pos.avg_cost ?? 0) * absQty * 100
                                  const ts = getTime(pos)
                                  const execLists = getExecLists(pos)
                                  const execMatchesInstance = (ex: Execution) => {
                                    if (pos.filtered_exec_lists) return true
                                    return executionMatchesInstanceGroup(
                                      ex,
                                      allGroup.strategy_instance_id,
                                      allGroup.strategy_opportunity_id,
                                    )
                                  }
                                  const scopedFinalExecs = execLists.final.filter(execMatchesInstance)
                                  const scopedTwsExecs = execLists.tws.filter(execMatchesInstance)
                                  const execCount = scopedFinalExecs.length + scopedTwsExecs.length
                                  const hasExecutions = execCount > 0
                                  const isPosExpanded = expand.positionKeys.includes(posKey)
                                  return [
                                    <tr
                                      key={posKey}
                                      className="detail-position-row"
                                      onClick={hasExecutions ? (e) => { e.stopPropagation(); expand.togglePosition(posKey) } : undefined}
                                      role={hasExecutions ? 'button' : undefined}
                                      tabIndex={hasExecutions ? 0 : undefined}
                                      onKeyDown={hasExecutions ? e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); expand.togglePosition(posKey) } } : undefined}
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
                                          const aria = p.symbol
                                            ? `Option details for ${p.symbol} ${p.rightLabel}${strikeStr}`
                                            : `Option details for ${pos.contract_key}`
                                          return p.symbol ? (
                                            <button
                                              type="button"
                                              className={optContractInspectorBtnClass}
                                              onClick={e => {
                                                e.stopPropagation()
                                                actions.openOptionInspector(pos)
                                              }}
                                              aria-label={aria}
                                            >
                                              <strong>{p.symbol}</strong> {p.rightLabel}
                                              {strikeStr}
                                            </button>
                                          ) : (
                                            <button
                                              type="button"
                                              className={optContractInspectorBtnClass}
                                              onClick={e => {
                                                e.stopPropagation()
                                                actions.openOptionInspector(pos)
                                              }}
                                              aria-label={aria}
                                            >
                                              {pos.contract_key}
                                            </button>
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
                                      <td className="replay-muted">{pos.pool_label}</td>
                                      <td>
                                        {pos.filtered_exec_lists ? (
                                          <span
                                            className="attr-badge attr-unassigned"
                                            title="Fills that do not match the instance row for this contract (Uncategorized)"
                                          >
                                            Uncategorized
                                          </span>
                                        ) : pos.attribution_type === 'mixed' ? (
                                          <span className="attr-badge attr-mixed" title={`Estimated attribution (net): ${((pos.attribution_ratio ?? 0) * 100).toFixed(0)}%`}>Mixed</span>
                                        ) : pos.attribution_type === 'single' ? (
                                          <span className="attr-badge attr-single" title="Single instance attribution">Single</span>
                                        ) : (
                                          <span className="attr-badge attr-unassigned" title="No strategy attribution">—</span>
                                        )}
                                      </td>
                                      <td className="positions-opt-account-cell">{pos.account_id || '—'}</td>
                                      <td className="replay-strategy-opp-cell positions-opt-opp-hint-cell">
                                        {execCount === 0 ? '—' : (
                                          <span className="replay-muted" title={`${execCount} execution${execCount > 1 ? 's' : ''} — expand row`}>
                                            {pos.filtered_exec_lists ? (
                                              <abbr title="Uncategorized fills">Unct.</abbr>
                                            ) : null}
                                            {pos.filtered_exec_lists ? ' · ' : null}
                                            {execCount} exec{execCount > 1 ? 's' : ''} ↓
                                          </span>
                                        )}
                                      </td>
                                      <td className="replay-opt-actions-cell">—</td>
                                    </tr>,
                                    ...(isPosExpanded ? [
                                      ...scopedFinalExecs.map((ex, ei) => (
                                        <OptionExecutionRow
                                          key={`${posKey}-exec-final-${ex.account_executions_id ?? ei}`}
                                          pos={pos} posKey={posKey} ex={ex} ei={ei}
                                          book="final" finalRows={scopedFinalExecs} twsRows={scopedTwsExecs}
                                          includeAttrColumn={true}
                                          canonicalOptContractKeySet={canonicalOptContractKeySet}
                                          syncingTwsAttributionKey={syncingTwsAttributionKey}
                                          syncingFinalAttributionKey={syncingFinalAttributionKey}
                                          actions={execRowActions}
                                        />
                                      )),
                                      ...scopedTwsExecs.map((ex, ei) => (
                                        <OptionExecutionRow
                                          key={`${posKey}-exec-tws-${ex.account_executions_id ?? ei}`}
                                          pos={pos} posKey={posKey} ex={ex} ei={ei}
                                          book="tws" finalRows={scopedFinalExecs} twsRows={scopedTwsExecs}
                                          includeAttrColumn={true}
                                          canonicalOptContractKeySet={canonicalOptContractKeySet}
                                          syncingTwsAttributionKey={syncingTwsAttributionKey}
                                          syncingFinalAttributionKey={syncingFinalAttributionKey}
                                          actions={execRowActions}
                                        />
                                      )),
                                    ] : []),
                                  ]
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      {covN > 0 && (
                        <div className="instance-sheet-sub-section">
                          <h6 className="replay-sub instance-sheet-sub-heading">Underlying Coverage</h6>
                          <div className="replay-portfolio-table-wrap">
                            <table className="table-operations instance-sheet-sub-table">
                              <thead>
                                <tr>
                                  <th>Symbol</th>
                                  <th>Account</th>
                                  <th>Cost basis</th>
                                  <th>Avg cost</th>
                                  <th>Live last</th>
                                  <th>Daily ($ / %)</th>
                                  <th>Total ($ / %)</th>
                                  <th>Direction</th>
                                  <th>Required</th>
                                  <th>Held</th>
                                  <th>Status</th>
                                  <th>Surplus / Gap</th>
                                </tr>
                              </thead>
                              <tbody>
                                {allGroup.stock_coverage.map(sc => {
                                  const acct = (sc.account_id ?? '').trim()
                                  const m = underlyingCoverageStockMetrics(liveStockPositions, sc.symbol, acct)
                                  const held = m.held
                                  const gap = held - sc.required_shares
                                  const statusLabel =
                                    held >= sc.required_shares
                                      ? 'Fully Covered'
                                      : held > 0
                                        ? `Partial (${held}/${sc.required_shares})`
                                        : 'Naked'
                                  const statusClass =
                                    held >= sc.required_shares
                                      ? 'coverage-status-covered'
                                      : held > 0
                                        ? 'coverage-status-partial'
                                        : 'coverage-status-naked'
                                  const hasStock = m.held !== 0 || m.cost_basis_total != null
                                  return (
                                    <tr key={`ia-cov-${instKey}-${sc.symbol}-${acct || 'x'}`}>
                                      <td>
                                        <button
                                          type="button"
                                          className={stockSymbolInspectorBtnClass}
                                          onClick={() => actions.tryOpenStock(sc.symbol, acct || '')}
                                          aria-label={`Stock details for ${sc.symbol} in account ${acct || '—'}`}
                                        >
                                          {sc.symbol}
                                        </button>
                                      </td>
                                      <td>
                                        <span className="underlying-coverage-account" title="Stock hedge must be in this account (same as options above)">
                                          {acct || '—'}
                                        </span>
                                      </td>
                                      <td>{fmtUsd(m.cost_basis_total)}</td>
                                      <td>{fmtUsd(m.avg_cost_per_share)}</td>
                                      <td>{fmtUsd(m.live_last_price)}</td>
                                      <td>
                                        {hasStock ? (
                                          <>
                                            <span className={((m.daily_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                              {fmtUsd(m.daily_pnl)}
                                            </span>
                                            {' / '}
                                            <span className={((m.daily_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                              {fmtSignedPct(m.daily_pct)}
                                            </span>
                                          </>
                                        ) : (
                                          '—'
                                        )}
                                      </td>
                                      <td>
                                        {hasStock ? (
                                          <>
                                            <span className={((m.total_pnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                              {fmtUsd(m.total_pnl)}
                                            </span>
                                            {' / '}
                                            <span className={((m.total_pct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>
                                              {fmtSignedPct(m.total_pct)}
                                            </span>
                                          </>
                                        ) : (
                                          '—'
                                        )}
                                      </td>
                                      <td>{sc.direction === 'long' ? 'Long' : 'Short'}</td>
                                      <td>{sc.required_shares}</td>
                                      <td>{held}</td>
                                      <td>
                                        <span className={`coverage-status-badge ${statusClass}`}>{statusLabel}</span>
                                      </td>
                                      <td><span className={gap >= 0 ? 'pnl-positive' : 'pnl-negative'}>{fmtSurplusShares(gap)}</span></td>
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                      {allGroup.risk_profile && (
                        <div className="instance-sheet-sub-section risk-profile-section">
                          <h6 className="replay-sub instance-sheet-sub-heading">Risk Profile</h6>
                          <RiskProfileDl profile={allGroup.risk_profile} fmtUsd={fmtUsd} />
                          {allGroup.risk_profile.naked_short_call_contracts > 0 && (
                            <ul className="risk-hedged-breakdown" style={{ margin: '0.5rem 0 0', paddingLeft: '1.25rem' }}>
                              {formatRiskHedgedBreakdown(allGroup.risk_profile).map((line, i) => (
                                <li key={i} className="risk-unlimited-warning">{line}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>,
                ] : []),
              ]
            })}
          </tbody>
          <tfoot>
            <tr className="replay-opt-tfoot-total">
              <td colSpan={7} className="replay-opt-tfoot-label">
                Total ({sortedGroups.length}{' '}
                {sortedGroups.length !== 1 ? 'strategies' : 'strategy'})
              </td>
              <td>
                <strong>
                  <span className="replay-pnl-unrealized">
                    {fmtUsd(sortedGroups.reduce((acc, g) => acc + g.options_unrealized_pnl, 0))}
                  </span>
                </strong>
              </td>
              <td colSpan={3} className="replay-muted">
                —
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    )}
    {sortedGroups.length > 0 ? (
    <div className="coverage-summary-section">
        <div className="coverage-summary-intro">
          <h6 className="replay-sub instance-sheet-sub-heading coverage-summary-heading-row">
            Coverage summary
            <InfoTooltip text="The Account (asset mix) filter in the top composition row applies here too. Position pool tables below use the same filter. Optionable symbols only; Independent Holdings are not listed in pools. Underlying pool = stock left after opportunity hedges." />
          </h6>
        </div>
        <div className="coverage-pools-row">
            <div className="coverage-pool-panel">
              <p className="section-hint" style={{ margin: '0 0 0.35rem' }}>
                Option underlying Pool
              </p>
              <p className="section-hint" style={{ margin: '0 0 0.4rem', fontSize: '0.82em' }}>
                Long shares not needed for existing opportunity hedges (all scopes); can back additional options.
              </p>
              {underlyingPoolItems.length === 0 && (
                <p
                  className="section-hint coverage-pool-empty-explanation"
                  style={{ margin: '0 0 0.5rem', fontSize: '0.85em', lineHeight: 1.45 }}
                >
                  No rows when every long share is already counted toward instance hedges, or when your instances do not require separate underlying stock backup. The table stays here so you can see the column layout when positions do create surplus.
                </p>
              )}
              <p className="option-underlying-pool-totals" style={{ margin: '0 0 0.45rem' }}>
                <span className="option-underlying-pool-total-item">
                  <span className="option-underlying-pool-total-label">Market Total</span>{' '}
                  <strong>{fmtUsd(underlyingPoolMarketTotal)}</strong>
                </span>
                <span className="option-underlying-pool-total-sep" aria-hidden>
                  {' · '}
                </span>
                <span className="option-underlying-pool-total-item">
                  {streamHostAccountId ? (
                    <>
                      <strong className="coverage-account-id coverage-account-host">
                        {streamHostAccountId}
                      </strong>{' '}
                      <span
                        className="option-underlying-pool-cash-bp"
                        title="Total cash / buying power (account table)"
                      >
                        {fmtUsd(cashBp.host.cash)}
                        {' / '}
                        {fmtUsd(cashBp.host.bp)}
                      </span>
                    </>
                  ) : (
                    <strong className="replay-muted">—</strong>
                  )}
                </span>
                <span className="option-underlying-pool-total-sep" aria-hidden>
                  {' · '}
                </span>
                <span className="option-underlying-pool-total-item">
                  {streamSecondaryAccountId ? (
                    <>
                      <strong className="coverage-account-id coverage-account-secondary">
                        {streamSecondaryAccountId}
                      </strong>{' '}
                      <span
                        className="option-underlying-pool-cash-bp"
                        title="Total cash / buying power (account table)"
                      >
                        {fmtUsd(cashBp.secondary.cash)}
                        {' / '}
                        {fmtUsd(cashBp.secondary.bp)}
                      </span>
                    </>
                  ) : (
                    <strong className="replay-muted">—</strong>
                  )}
                </span>
              </p>
              <StockCoverageTable
                rows={sortedUnderlyingPoolItems}
                keyPrefix="underlying-pool"
                streamHostAccountId={streamHostAccountId}
                streamSecondaryAccountId={streamSecondaryAccountId}
                underlyingPoolSlim={true}
                underlyingPoolSort={{
                  column: sort.underlyingPool.col,
                  dir: sort.underlyingPool.dir,
                  onColumnClick: sort.onUnderlyingPoolClick,
                }}
                onInspectCoverageSymbol={ci => actions.tryOpenStock(ci.symbol, ci.account_id)}
              />
            </div>
          {watchlistItems.length > 0 && (
            <div className="coverage-pool-panel">
              <p className="section-hint" style={{ margin: '0 0 0.35rem' }}>
                Option backing Pool
              </p>
              <p className="section-hint" style={{ margin: '0 0 0.45rem', fontSize: '0.82em' }}>
                Watchlist-scoped opportunities: Required = hedge from those strategies only.
              </p>
              <StockCoverageTable
                rows={sortedWatchlistItems}
                keyPrefix="watchlist-optionable"
                streamHostAccountId={streamHostAccountId}
                streamSecondaryAccountId={streamSecondaryAccountId}
                backingPoolSlim={true}
                underlyingPoolSort={{
                  column: sort.backingPool.col,
                  dir: sort.backingPool.dir,
                  onColumnClick: sort.onBackingPoolClick,
                }}
                onInspectCoverageSymbol={ci => actions.tryOpenStock(ci.symbol, ci.account_id)}
              />
            </div>
          )}
        </div>
      </div>
    ) : (
      <div className="coverage-summary-section coverage-summary-section--placeholder">
        <h6 className="replay-sub instance-sheet-sub-heading coverage-summary-heading-row">
          Coverage summary
          <InfoTooltip text="Option underlying pool and backing pool tables appear when instances match filters. Underlying pool = stock left after opportunity hedges." />
        </h6>
        <p className="section-hint coverage-summary-placeholder-text">
          This section is computed from the instance table above. With no instances matching the current filters, there is nothing to show here—so the pools are hidden, not missing. Clear or widen filters to bring instances back and see Option underlying / backing pools.
        </p>
      </div>
    )}
    {independentSections.some(s => s.rows.length > 0) && (
      <div className="instance-sheet-stock-section">
        <h5 className="replay-sub instance-sheet-section-heading">Independent Holdings</h5>
        <p className="section-hint">Positions without tradeable options (Index, ETF, etc.); not part of any option strategy. Grouped by position category (Stocks, Fixed income, Cash-like).</p>
        <div className="replay-portfolio-table-wrap">
          <table className="table-operations instance-sheet-sub-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Avg Cost</th>
                <th>Last</th>
                <th>Market Value</th>
                <th>Daily ($ / %)</th>
                <th>Total ($ / %)</th>
              </tr>
            </thead>
            <tbody>
              {independentSections
                .filter(s => s.rows.length > 0)
                .flatMap(section => [
                  <tr key={`${section.key}-section`} className="replay-portfolio-group-header">
                    <td colSpan={9}>
                      <strong>{section.title}</strong>
                    </td>
                  </tr>,
                  ...section.rows.map(p => renderIndependentHoldingRow(p, section.key, actions.openStockInspector)),
                ])}
            </tbody>
          </table>
        </div>
      </div>
    )}
  </div>
  )
}
