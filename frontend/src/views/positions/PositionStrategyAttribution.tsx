import { rl } from '@/lib/replayLayout'
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
  if (!ex) return <td className={rl.strategyOppCell}>—</td>
  const oppName = ex.strategy_opportunity_name?.trim()
  const instanceId = ex.strategy_instance_id
  const instanceLabel = ex.strategy_instance_label?.trim()
  const instanceTitle = instanceLabel ? `Strategy: ${instanceLabel}` : instanceId != null ? `View strategy #${instanceId}` : ''
  return (
    <td className={rl.strategyOppCell} title={[instanceTitle, oppName].filter(Boolean).join(' · ') || undefined}>
      <span className={rl.strategyOppCellInner}>
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
        <span className={rl.strategyOppText}>{oppName || '—'}</span>
      </span>
    </td>
  )
}
