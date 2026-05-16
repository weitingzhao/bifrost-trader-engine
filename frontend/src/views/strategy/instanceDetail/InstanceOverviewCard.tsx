import { useMemo } from 'react'
import type { Execution, StrategyInstance } from '../../../types'
import { fmtTs } from '../../../utils/format'
import { computeInstancePositionStatus } from './instanceDetailPnlMetrics'

function formatInstanceOpenedAt(instance: StrategyInstance): string {
  if (instance.opened_at_epoch != null && Number.isFinite(Number(instance.opened_at_epoch))) {
    return fmtTs(instance.opened_at_epoch)
  }
  if (instance.opened_at != null && typeof instance.opened_at === 'string' && instance.opened_at.trim() !== '') {
    const ms = Date.parse(instance.opened_at)
    if (Number.isFinite(ms)) return fmtTs(ms / 1000)
  }
  return '—'
}

export function InstanceOverviewCard({
  instance,
  executionsForPosition,
  executionsLoading,
}: {
  instance: StrategyInstance
  executionsForPosition: Execution[]
  executionsLoading: boolean
}) {
  const positionStatus = useMemo(
    () => computeInstancePositionStatus(executionsForPosition),
    [executionsForPosition],
  )

  const statusChip =
    executionsLoading ? (
      <span className="muted instance-detail-overview-status-loading" aria-hidden>
        …
      </span>
    ) : positionStatus === 'no_fills' ? (
      <span
        className="instance-detail-status-chip instance-detail-overview-status-chip is-unknown"
        title="No attributed fills in the performance book for this instance yet."
      >
        No fills
      </span>
    ) : (
      <span
        className={`instance-detail-status-chip instance-detail-overview-status-chip ${
          positionStatus === 'closed' ? 'is-flat' : 'is-open'
        }`}
        title={
          positionStatus === 'closed'
            ? 'All contracts: buy quantity matches sell quantity (flat net) for this instance.'
            : 'At least one contract has open net quantity (buy and sell counts do not net to zero).'
        }
      >
        {positionStatus === 'closed' ? 'Closed' : 'Open'}
      </span>
    )

  return (
    <section
      className="instance-detail-overview-card detail-block"
      aria-label="Instance overview"
    >
      <h3 className="instance-detail-section-title instance-detail-overview-head">
        <span>Overview</span>
        {statusChip}
      </h3>
      <dl className="info-dl instance-detail-info-dl">
        <dt>Structure</dt>
        <dd>
          {instance.strategy_structure_name != null || instance.strategy_structure_id != null ? (
            <span>{instance.strategy_structure_name ?? `Structure ${instance.strategy_structure_id}`}</span>
          ) : (
            '—'
          )}
          {instance.strategy_structure_id != null && instance.strategy_structure_name != null && (
            <span className="muted" style={{ marginLeft: '0.25rem' }}>
              ({instance.strategy_structure_id})
            </span>
          )}
        </dd>
        <dt>Opened at</dt>
        <dd>{formatInstanceOpenedAt(instance)}</dd>
        <dt>Created at</dt>
        <dd>
          {instance.created_at_epoch != null ? fmtTs(instance.created_at_epoch) : instance.created_at ?? '—'}
        </dd>
        <dt>Label</dt>
        <dd>{instance.label ?? '—'}</dd>
        {instance.notes != null && instance.notes.trim() !== '' && (
          <>
            <dt>Notes</dt>
            <dd>{instance.notes}</dd>
          </>
        )}
      </dl>
    </section>
  )
}
