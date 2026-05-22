import type { StrategyInstance } from '../../../types'
import type { StrategyStructure } from '../../../api'
import { summarizeLegs, summarizeConstraints, getStructureTypeLabel } from '../strategyFormUtils'

export function InstanceStructureCard({
  instance,
  structure,
  structureLoading,
  structureError,
}: {
  instance: StrategyInstance
  structure: StrategyStructure | null
  structureLoading: boolean
  structureError: string | null
}) {
  if (instance.strategy_structure_id == null) {
    return (
      <section className="instance-detail-structure-panel detail-block rounded-lg border border-border bg-card p-4 shadow-sm">
        <h3 className="instance-detail-section-title">Strategy structure</h3>
        <p className="muted">No structure linked.</p>
      </section>
    )
  }

  return (
    <section className="instance-detail-structure-panel detail-block rounded-lg border border-border bg-card p-4 shadow-sm">
      <h3 className="instance-detail-section-title">Strategy structure</h3>
      {structureLoading ? (
        <p className="muted">Loading structure…</p>
      ) : structureError != null ? (
        <p className="error-message">{structureError}</p>
      ) : structure != null ? (
        <dl className="info-dl instance-detail-info-dl">
          <dt>Name</dt>
          <dd>
            {structure.name}
            <span className="muted" style={{ marginLeft: '0.25rem' }}>
              ({structure.strategy_structure_id})
            </span>
          </dd>
          <dt>Type</dt>
          <dd>{getStructureTypeLabel(structure.structure_type)}</dd>
          {structure.structure_subtype != null && structure.structure_subtype !== '' && (
            <>
              <dt>Subtype</dt>
              <dd>{structure.structure_subtype_label ?? structure.structure_subtype}</dd>
            </>
          )}
          {structure.template_display_name != null && structure.template_display_name !== '' && (
            <>
              <dt>Template</dt>
              <dd>{structure.template_display_name}</dd>
            </>
          )}
          <dt>Legs</dt>
          <dd title={summarizeLegs(structure.legs)}>{summarizeLegs(structure.legs)}</dd>
          <dt>Constraints</dt>
          <dd title={summarizeConstraints(structure.constraints)}>{summarizeConstraints(structure.constraints)}</dd>
        </dl>
      ) : (
        <p className="muted">Structure not found.</p>
      )}
    </section>
  )
}
