import type { StrategyInstance } from '../../../types'
import type { StrategyStructure } from '../../../api'
import { fmtTs } from '../../../utils/format'
import { summarizeLegs, summarizeConstraints, getStructureTypeLabel } from '../strategyFormUtils'

export function InstanceOverviewCard({
  instance,
  structure,
  structureLoading,
  structureError,
  openedAtEdit,
  onOpenedAtChange,
  onQuickSet,
  onSaveOpenedAt,
  canQuickSet,
  openedAtSaving,
  openedAtError,
}: {
  instance: StrategyInstance
  structure: StrategyStructure | null
  structureLoading: boolean
  structureError: string | null
  openedAtEdit: string
  onOpenedAtChange: (v: string) => void
  onQuickSet: () => void
  onSaveOpenedAt: () => void
  canQuickSet: boolean
  openedAtSaving: boolean
  openedAtError: string | null
}) {
  return (
    <section className="instance-detail-overview-card detail-block">
      <h3 className="instance-detail-section-title">Overview</h3>
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
        <dd>
          <span className="instance-detail-opened-at-row">
            <input
              type="date"
              value={openedAtEdit}
              onChange={(e) => onOpenedAtChange(e.target.value)}
              className="create-instance-input"
              aria-label="Opened at (editable)"
            />
            <button
              type="button"
              className="btn btn-small btn-secondary"
              onClick={onQuickSet}
              disabled={!canQuickSet}
              title="Set Opened at to the Trade date of the oldest execution below"
            >
              Quick Set
            </button>
            <button
              type="button"
              className="btn btn-small btn-primary"
              onClick={onSaveOpenedAt}
              disabled={openedAtSaving || !openedAtEdit.trim()}
            >
              {openedAtSaving ? 'Saving…' : 'Save'}
            </button>
            {openedAtError != null && (
              <span className="section-hint replay-form-error instance-detail-opened-at-error">{openedAtError}</span>
            )}
          </span>
        </dd>
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

      {instance.strategy_structure_id != null && (
        <div className="instance-detail-structure-embed">
          <h4 className="instance-detail-subheading">Strategy structure</h4>
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
        </div>
      )}
    </section>
  )
}
