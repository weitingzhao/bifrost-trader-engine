import { useMemo } from 'react'
import type { StrategyStructure } from '../../../api'
import type { Execution, StrategyInstance } from '../../../types'
import { fmtTs } from '../../../utils/format'
import { summarizeConstraints, summarizeLegs, getStructureTypeLabel } from '../strategyFormUtils'
import { computeInstancePositionStatus, computeInstanceThroughEnd } from './instanceDetailPnlMetrics'

function formatStructureName(instance: StrategyInstance, structure: StrategyStructure | null): string {
  const name = structure?.name ?? instance.strategy_structure_name
  const id = structure?.strategy_structure_id ?? instance.strategy_structure_id
  if (name != null && id != null) return `${name} (${id})`
  if (name != null) return name
  if (id != null) return `Structure ${id}`
  return '—'
}

export function InstanceOverviewStructureCard({
  instance,
  executionsForPosition,
  executionsLoading,
  structure,
  structureLoading,
  structureError,
}: {
  instance: StrategyInstance
  executionsForPosition: Execution[]
  executionsLoading: boolean
  structure: StrategyStructure | null
  structureLoading: boolean
  structureError: string | null
}) {
  const positionStatus = useMemo(
    () => computeInstancePositionStatus(executionsForPosition),
    [executionsForPosition],
  )

  const throughEnd = useMemo(
    () =>
      computeInstanceThroughEnd({
        instance,
        executions: executionsForPosition,
        positionStatus,
      }),
    [instance, executionsForPosition, positionStatus],
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
    <section className="instance-detail-summary-card detail-block" aria-label="Instance summary">
      <h3 className="instance-detail-section-title instance-detail-overview-head">
        <span>Overview</span>
        {statusChip}
      </h3>

      <dl className="info-dl instance-detail-info-dl instance-detail-summary-dl">
        <dt>Structure</dt>
        <dd>{formatStructureName(instance, structure)}</dd>

        <dt>Open → End</dt>
        <dd title={executionsLoading ? 'Loading executions…' : throughEnd.title}>
          {executionsLoading ? (
            <span className="muted">…</span>
          ) : (
            <>
              <span>{throughEnd.openSec != null ? fmtTs(throughEnd.openSec) : '—'}</span>
              <span className="muted"> → </span>
              <span>{throughEnd.endLabel ?? '—'}</span>
            </>
          )}
        </dd>

        {instance.label != null && String(instance.label).trim() !== '' && (
          <>
            <dt>Label</dt>
            <dd>{instance.label}</dd>
          </>
        )}

        {structureLoading ? (
          <>
            <dt>Details</dt>
            <dd className="muted">Loading structure…</dd>
          </>
        ) : structureError != null ? (
          <>
            <dt>Details</dt>
            <dd className="error-message">{structureError}</dd>
          </>
        ) : structure != null ? (
          <>
            <dt>Type</dt>
            <dd>{getStructureTypeLabel(structure.structure_type)}</dd>
            <dt>Legs</dt>
            <dd title={summarizeLegs(structure.legs)}>{summarizeLegs(structure.legs)}</dd>
            <dt>Constraints</dt>
            <dd title={summarizeConstraints(structure.constraints)}>{summarizeConstraints(structure.constraints)}</dd>
          </>
        ) : (
          <>
            <dt>Details</dt>
            <dd className="muted">No linked structure details.</dd>
          </>
        )}
      </dl>
    </section>
  )
}
