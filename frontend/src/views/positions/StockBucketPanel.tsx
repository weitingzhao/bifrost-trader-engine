import type { ReactElement } from 'react'
import { stockSymbolInspectorBtnClass } from '@/components/shared/exec-row-buttons'
import type { LivePositionRow } from '../portfolio/types'
import { fmtUsd } from '../../utils/format'
import { fmtSignedPct, fmtLivePositionMarketValueQtyTimesLast } from './positionUtils'

export function buildOpenStockPositionRows(
  positions: LivePositionRow[],
  rowKeyPrefix: string,
  onInspectStock?: (p: LivePositionRow) => void,
): ReactElement[] {
  const byAccount: Record<string, LivePositionRow[]> = {}
  for (const position of positions) {
    const accId = (position.account_id ?? '').trim() || '—'
    if (!byAccount[accId]) byAccount[accId] = []
    byAccount[accId].push(position)
  }
  const accountIds = Object.keys(byAccount).sort()
  const rows: ReactElement[] = []
  for (const accId of accountIds) {
    rows.push(
      <tr key={`${rowKeyPrefix}-acc-${accId}`} className="replay-portfolio-group-header">
        <td colSpan={9}>
          <strong>{accId}</strong>
        </td>
      </tr>,
    )
    for (const position of byAccount[accId]) {
      const qty = Number(position.position)
      const lastPrice = position.price != null && Number.isFinite(Number(position.price)) ? Number(position.price) : null
      const avgCost = position.avgCost != null && Number.isFinite(Number(position.avgCost)) ? Number(position.avgCost) : null
      const prevClose =
        position.daily_prev_close != null && Number.isFinite(Number(position.daily_prev_close))
          ? Number(position.daily_prev_close)
          : null
      const pnl =
        position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
          ? Number(position.unrealized_pnl)
          : null
      const sincePct =
        pnl != null && avgCost != null && avgCost !== 0 && Number.isFinite(qty) ? (pnl / (Math.abs(avgCost * qty))) * 100 : null
      const dailyPnl =
        lastPrice != null && prevClose != null && Number.isFinite(qty) ? (lastPrice - prevClose) * qty : null
      const dailyPct =
        dailyPnl != null && prevClose != null && prevClose !== 0 ? ((lastPrice! - prevClose) / prevClose) * 100 : null
      const contractKey = position.contract_key ?? `${position.symbol ?? ''}|STK|||`
      rows.push(
        <tr key={`${rowKeyPrefix}-open-stk-${accId}-${position.symbol ?? ''}-${contractKey}`}>
          <td>{accId}</td>
          <td>
            {onInspectStock ? (
              <button
                type="button"
                className={stockSymbolInspectorBtnClass}
                onClick={() => onInspectStock(position)}
                aria-label={`Open details for ${position.symbol ?? 'symbol'}`}
              >
                <strong>{position.symbol ?? '—'}</strong>
              </button>
            ) : (
              <strong>{position.symbol ?? '—'}</strong>
            )}
          </td>
          <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
          <td>{Number.isFinite(qty) ? qty : '—'}</td>
          <td>{fmtUsd(position.avgCost)}</td>
          <td>{fmtUsd(position.price)}</td>
          <td>{fmtLivePositionMarketValueQtyTimesLast(position)}</td>
          <td className="coverage-pnl-stacked-cell">
            <div className={(dailyPnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}>
              {dailyPnl != null ? fmtUsd(dailyPnl) : '—'}
            </div>
            <div className={`coverage-pnl-stacked-pct ${(dailyPct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {dailyPct != null ? fmtSignedPct(dailyPct) : '—'}
            </div>
          </td>
          <td className="coverage-pnl-stacked-cell">
            <div className={(pnl ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}>{pnl != null ? fmtUsd(pnl) : '—'}</div>
            <div className={`coverage-pnl-stacked-pct ${(sincePct ?? 0) >= 0 ? 'pnl-positive' : 'pnl-negative'}`}>
              {sincePct != null ? fmtSignedPct(sincePct) : '—'}
            </div>
          </td>
        </tr>,
      )
    }
  }
  return rows
}

export function renderIndependentHoldingRow(
  position: LivePositionRow,
  keyPrefix: string,
  onInspectStock?: (p: LivePositionRow) => void,
): ReactElement {
  const accId = (position.account_id ?? '').trim() || '—'
  const qty = Number(position.position)
  const lastPrice =
    position.price != null && Number.isFinite(Number(position.price)) ? Number(position.price) : null
  const dailyPrev =
    position.daily_prev_close != null && Number.isFinite(Number(position.daily_prev_close))
      ? Number(position.daily_prev_close)
      : null
  let dailyPnl: number | null = null
  let dailyPct: number | null = null
  if (lastPrice != null && dailyPrev != null && Number.isFinite(qty) && qty !== 0) {
    dailyPnl = (lastPrice - dailyPrev) * qty
    const dBase = Math.abs(dailyPrev * qty)
    dailyPct = dBase > 0 ? (dailyPnl / dBase) * 100 : null
  }
  const totalPnl =
    position.unrealized_pnl != null && Number.isFinite(Number(position.unrealized_pnl))
      ? Number(position.unrealized_pnl)
      : null
  const avgCost =
    position.avgCost != null && Number.isFinite(Number(position.avgCost)) ? Number(position.avgCost) : null
  const costBasis =
    avgCost != null && Number.isFinite(qty) && qty !== 0 ? Math.abs(qty) * avgCost : null
  const totalPct =
    costBasis != null && costBasis > 0 && totalPnl != null && Number.isFinite(totalPnl)
      ? (totalPnl / costBasis) * 100
      : null
  const ck = (position.contract_key ?? '').trim()
  return (
    <tr key={`${keyPrefix}-${accId}-${position.symbol ?? ''}-${ck || 'stk'}`}>
      <td>{accId}</td>
      <td>
        {onInspectStock ? (
          <button
            type="button"
            className={stockSymbolInspectorBtnClass}
            onClick={() => onInspectStock(position)}
            aria-label={`Open details for ${position.symbol ?? 'symbol'}`}
          >
            <strong>{position.symbol ?? '—'}</strong>
          </button>
        ) : (
          <strong>{position.symbol ?? '—'}</strong>
        )}
      </td>
      <td>{qty > 0 ? 'Long' : qty < 0 ? 'Short' : '—'}</td>
      <td>{Number.isFinite(qty) ? qty : '—'}</td>
      <td>{fmtUsd(position.avgCost)}</td>
      <td>{fmtUsd(lastPrice)}</td>
      <td>{fmtLivePositionMarketValueQtyTimesLast(position)}</td>
      <td>
        <span className={((dailyPnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtUsd(dailyPnl)}</span>
        {' / '}
        <span className={((dailyPct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtSignedPct(dailyPct)}</span>
      </td>
      <td>
        <span className={((totalPnl ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtUsd(totalPnl)}</span>
        {' / '}
        <span className={((totalPct ?? 0) >= 0) ? 'pnl-positive' : 'pnl-negative'}>{fmtSignedPct(totalPct)}</span>
      </td>
    </tr>
  )
}

interface StockBucketPanelProps {
  panelId: string
  tabButtonId: string
  heading: string
  rows: LivePositionRow[]
  rowKeyPrefix: string
  emptyHint: string
  onInspectStock?: (p: LivePositionRow) => void
}

export function StockBucketPanel({
  panelId,
  tabButtonId,
  heading,
  rows,
  rowKeyPrefix,
  emptyHint,
  onInspectStock,
}: StockBucketPanelProps) {
  return (
    <div id={panelId} role="tabpanel" aria-labelledby={tabButtonId} className="system-tab-panel">
      <h5 className="replay-sub">{heading}</h5>
      {rows.length === 0 ? (
        <p className="section-hint">{emptyHint}</p>
      ) : (
        <div className="replay-portfolio-table-wrap">
          <table className="table-operations">
            <thead>
              <tr>
                <th>Account</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Qty</th>
                <th>Avg Cost</th>
                <th>Last</th>
                <th>Market Value</th>
                <th className="coverage-pnl-stacked-th">Daily $/&nbsp;%</th>
                <th className="coverage-pnl-stacked-th">Since $/&nbsp;%</th>
              </tr>
            </thead>
            <tbody>{buildOpenStockPositionRows(rows, rowKeyPrefix, onInspectStock)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}
