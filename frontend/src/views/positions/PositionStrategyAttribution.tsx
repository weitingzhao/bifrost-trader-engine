import type { Execution } from '../../types'

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

export function LinkStrategyIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button type="button" className="btn btn-icon-small" onClick={e => { e.stopPropagation(); onClick() }} title={title} aria-label={title}>
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </button>
  )
}
