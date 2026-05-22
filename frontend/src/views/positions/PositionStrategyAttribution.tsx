import type { Execution } from '../../types'
import { LinkStrategyIconButton } from '@/components/shared/exec-row-buttons'

export { LinkStrategyIconButton }

export function StrategyAttributionCells({
  ex,
  onOpenStrategyInstance,
}: {
  ex: Execution | null
  onOpenStrategyInstance?: (strategyInstanceId: number) => void
}) {
  if (!ex) return <td className="replay-strategy-opp-cell">—</td>
  const oppName = ex.strategy_opportunity_name?.trim()
  const instanceId = ex.strategy_instance_id
  const instanceLabel = ex.strategy_instance_label?.trim()
  const instanceTitle = instanceLabel ? `Strategy: ${instanceLabel}` : instanceId != null ? `View strategy #${instanceId}` : ''
  return (
    <td className="replay-strategy-opp-cell" title={[instanceTitle, oppName].filter(Boolean).join(' · ') || undefined}>
      <span className="replay-strategy-opp-cell-inner">
        {instanceId != null ? (
          <button
            type="button"
            className="ledger-instance-icon-link"
            title={instanceTitle}
            aria-label={instanceTitle || 'View strategy'}
            onClick={e => {
              e.stopPropagation()
              onOpenStrategyInstance?.(instanceId)
            }}
          >
            <svg viewBox="0 0 24 24" width={14} height={14} className="ledger-instance-icon" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><rect x="5" y="5" width="14" height="14" rx="1" /></svg>
          </button>
        ) : null}
        <span className="replay-strategy-opp-text">{oppName || '—'}</span>
      </span>
    </td>
  )
}
