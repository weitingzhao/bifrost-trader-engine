import type { StrategyInstance } from '../../../types'

export function InstanceDetailHeader({
  strategyInstanceId,
  instance,
}: {
  strategyInstanceId: number
  instance: StrategyInstance
}) {
  return (
    <header className="instance-detail-header flex min-w-0 flex-col gap-2 border-b border-border pb-3">
      <div className="instance-detail-header-title flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="instance-detail-header-id text-base font-semibold text-foreground">Instance {strategyInstanceId}</span>
        {instance.label != null && String(instance.label).trim() !== '' && (
          <span className="instance-detail-header-label text-sm text-muted-foreground">{instance.label}</span>
        )}
        <span className="instance-detail-header-account text-sm text-muted-foreground">{instance.account_id}</span>
      </div>
      <div className="instance-detail-header-links text-sm">
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
