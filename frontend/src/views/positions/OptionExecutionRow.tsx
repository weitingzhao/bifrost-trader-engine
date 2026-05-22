import { Button } from '@/components/ui/button'
import { ExecRowIconButton } from '@/components/shared/exec-row-buttons'
import type { Execution } from '../../types'
import { fmtDate, fmtDaysAgo, fmtUsd } from '../../utils/format'
import ExecSourceBadge from '../../components/ExecSourceBadge'
import {
  optExecutionMatchKey, findMatchingFinalForTws, findMatchingTwsForFinal,
  twsNeedsStrategySyncFromFinal, finalNeedsStrategySyncFromTws,
} from './positionUtils'
import { StrategyAttributionCells, LinkStrategyIconButton } from './PositionStrategyAttribution'
import type { OpenOptionPosition } from '../portfolio/types'

export interface OptionExecRowActions {
  onSyncTwsStrategyFromFinal: (t: Execution, f: Execution) => void
  onSyncFinalStrategyFromTws: (f: Execution, t: Execution) => void
  onOpenStrategyInspector: (id: number) => void
  onEdit: (exec: Execution) => void
  onLink: (exec: Execution) => void
  onCloseAgainst: (exec: Execution) => void
  onDelete: (exec: Execution) => void
}

interface Props {
  pos: OpenOptionPosition
  posKey: string
  ex: Execution
  ei: number
  book: 'final' | 'tws'
  finalRows: Execution[]
  twsRows: Execution[]
  includeAttrColumn: boolean
  includeAccountColumn?: boolean
  canonicalOptContractKeySet: Set<string>
  syncingTwsAttributionKey: string | null
  syncingFinalAttributionKey: string | null
  actions: OptionExecRowActions
}

export function OptionExecutionRow({
  pos,
  posKey,
  ex,
  ei,
  book,
  finalRows,
  twsRows,
  includeAttrColumn,
  includeAccountColumn = true,
  canonicalOptContractKeySet,
  syncingTwsAttributionKey,
  syncingFinalAttributionKey,
  actions,
}: Props) {
  const crossBookMatch =
    book === 'final' ? findMatchingTwsForFinal(ex, twsRows) : findMatchingFinalForTws(ex, finalRows)
  const es = (ex.side ?? '').toUpperCase()
  const eSideLabel =
    es === 'BUY' || es === 'BOT' || es === 'B'
      ? 'Buy'
      : es === 'SELL' || es === 'SLD' || es === 'S'
        ? 'Sell'
        : (ex.side ?? '—')
  const eQty = Math.abs(Number(ex.quantity) || 0)
  const ePrice = Number(ex.price) || 0
  const eComm = Number(ex.commission) || 0
  const eTs = ex.time != null ? Number(ex.time) : null
  const isOffTrack = pos.kind === 'offtrack'
  const execInstanceId = ex.strategy_instance_id
  const bookLabel = book === 'final' ? '[Final]' : '[TWS client]'
  const rowKey = `${posKey}-exec-${book}-${ex.account_executions_id ?? ei}`
  const twsContractKey = optExecutionMatchKey(ex.account_id ?? '', ex.contract_key ?? '')
  const hasCanonicalContractRow = canonicalOptContractKeySet.has(twsContractKey)
  const showSyncTws =
    book === 'tws' &&
    hasCanonicalContractRow &&
    crossBookMatch != null &&
    twsNeedsStrategySyncFromFinal(ex, crossBookMatch)
  const showSyncFinal =
    book === 'final' &&
    hasCanonicalContractRow &&
    crossBookMatch != null &&
    finalNeedsStrategySyncFromTws(ex, crossBookMatch)
  const syncBusyTws = syncingTwsAttributionKey === String(ex.account_executions_id ?? '')
  const syncBusyFinal = syncingFinalAttributionKey === String(ex.account_executions_id ?? '')

  return (
    <tr key={rowKey} className="detail-execution-row">
      <td className="replay-opt-expand-col" />
      <td className="detail-exec-indent replay-muted detail-exec-indent--stack" colSpan={2}>
        <div className="detail-exec-indent-stack">
          <div className="detail-exec-line-primary">
            ↳ {bookLabel} exec #{ex.account_executions_id ?? '?'}
            {execInstanceId != null ? (
              <>
                {' '}
                <span className="replay-muted">·</span>{' '}
                <button
                  type="button"
                  className="ledger-instance-icon-link"
                  title={`strategy_instance_id ${execInstanceId}`}
                  aria-label={`View strategy #${execInstanceId}`}
                  onClick={e => {
                    e.stopPropagation()
                    actions.onOpenStrategyInspector(execInstanceId)
                  }}
                >
                  strategy #{execInstanceId}
                </button>
              </>
            ) : null}
          </div>
          {showSyncTws && crossBookMatch != null ? (
            <div className="detail-exec-line-sync">
              <ExecRowIconButton
                className="detail-exec-sync-btn"
                title="Apply opportunity and strategy from the final book row"
                aria-label="Sync strategy attribution from final book"
                disabled={syncBusyTws}
                onClick={e => {
                  e.stopPropagation()
                  actions.onSyncTwsStrategyFromFinal(ex, crossBookMatch)
                }}
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden>
                  <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 9.02 4 10.48 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                </svg>
              </ExecRowIconButton>
            </div>
          ) : null}
          {showSyncFinal && crossBookMatch != null ? (
            <div className="detail-exec-line-sync">
              <ExecRowIconButton
                className="detail-exec-sync-btn"
                title="Apply opportunity and strategy from the TWS client row"
                aria-label="Sync strategy attribution from TWS client book"
                disabled={syncBusyFinal}
                onClick={e => {
                  e.stopPropagation()
                  actions.onSyncFinalStrategyFromTws(ex, crossBookMatch)
                }}
              >
                <svg viewBox="0 0 24 24" width={14} height={14} fill="currentColor" aria-hidden>
                  <path d="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 9.02 4 10.48 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z" />
                </svg>
              </ExecRowIconButton>
            </div>
          ) : null}
        </div>
      </td>
      <td>
        <ExecSourceBadge source={ex.source} />
      </td>
      <td />
      <td>
        {eSideLabel} {eQty || '—'}
      </td>
      <td>{fmtUsd(ePrice)}</td>
      <td />
      <td>
        {eTs != null && Number.isFinite(eTs) ? (
          <>
            {fmtDate(eTs)}
            {fmtDaysAgo(eTs) ? <span className="replay-time-ago"> {fmtDaysAgo(eTs)}</span> : null}
          </>
        ) : (
          '—'
        )}
      </td>
      <td>{eComm ? fmtUsd(eComm) : '—'}</td>
      <td className="replay-muted" />
      {includeAttrColumn ? <td className="replay-muted" /> : null}
      {includeAccountColumn ? <td className="replay-muted positions-opt-account-cell">{ex.account_id ?? '—'}</td> : null}
      <StrategyAttributionCells ex={ex} onOpenStrategyInstance={actions.onOpenStrategyInspector} />
      <td className="replay-opt-actions-cell">
        <span className="replay-exec-row-actions">
          <ExecRowIconButton
            onClick={e => {
              e.stopPropagation()
              actions.onEdit(ex)
            }}
            title="Edit"
            aria-label="Edit execution"
          >
            <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </ExecRowIconButton>
          {ex.account_executions_id != null ? (
            <LinkStrategyIconButton
              title="Assign opportunity and strategy"
              onClick={() => actions.onLink(ex)}
            />
          ) : null}
          {isOffTrack ? (
            <Button
              type="button"
              size="sm"
              onClick={e => {
                e.stopPropagation()
                actions.onCloseAgainst(ex)
              }}
            >
              Close
            </Button>
          ) : null}
          <ExecRowIconButton
            variant="danger"
            onClick={e => {
              e.stopPropagation()
              actions.onDelete(ex)
            }}
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
      </td>
    </tr>
  )
}
