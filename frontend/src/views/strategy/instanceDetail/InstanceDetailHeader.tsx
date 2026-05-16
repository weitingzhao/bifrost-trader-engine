import type { StrategyInstance } from '../../../types'

export function InstanceDetailHeader({
  strategyInstanceId,
  instance,
}: {
  strategyInstanceId: number
  instance: StrategyInstance
}) {
  return (
    <header className="instance-detail-header">
      <div className="instance-detail-header-title">
        <span className="instance-detail-header-id">Instance {strategyInstanceId}</span>
        {instance.label != null && String(instance.label).trim() !== '' && (
          <span className="instance-detail-header-label muted">{instance.label}</span>
        )}
        <span className="instance-detail-header-account muted">{instance.account_id}</span>
      </div>
      <div className="instance-detail-header-links">
        {instance.strategy_opportunity_id != null && Number.isFinite(Number(instance.strategy_opportunity_id)) ? (
          <a
            href={`#/strategies/opportunities/${instance.strategy_opportunity_id}`}
            className="instance-sheet-inst-link"
          >
            {instance.strategy_opportunity_name ?? `Opportunity #${instance.strategy_opportunity_id}`}
          </a>
        ) : (
          <span className="muted">—</span>
        )}
      </div>
    </header>
  )
}
