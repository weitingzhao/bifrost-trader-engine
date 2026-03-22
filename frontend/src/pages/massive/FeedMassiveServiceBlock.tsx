import type { ReactNode } from 'react'
import type { ChecklistRow } from '../massiveFeedChecklistRows'

export type EffectiveServiceStatus = ChecklistRow['projectStatus'] | 'not-on-tier'

function statusLabel(s: EffectiveServiceStatus): string {
  if (s === 'implemented') return 'Implemented'
  if (s === 'partial') return 'Partial'
  if (s === 'not-on-tier') return 'Not on tier'
  return 'Not implemented'
}

function lampClass(s: EffectiveServiceStatus): string {
  if (s === 'implemented') return 'feed-massive-svc-lamp feed-massive-svc-lamp--ok'
  if (s === 'partial') return 'feed-massive-svc-lamp feed-massive-svc-lamp--partial'
  if (s === 'not-on-tier') return 'feed-massive-svc-lamp feed-massive-svc-lamp--tier'
  return 'feed-massive-svc-lamp feed-massive-svc-lamp--fail'
}

export interface FeedMassiveServiceBlockProps {
  /** Section anchor id (e.g. feed-massive-svc-snapshot). */
  anchorId: string
  effectiveStatus: EffectiveServiceStatus
  onHelpClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  evidence: ReactNode
  testArea?: ReactNode
  children?: ReactNode
}

/**
 * Unified header for Massive Option service sections: status lamp, evidence, test strip, help.
 */
export function FeedMassiveServiceBlock({
  anchorId,
  effectiveStatus,
  onHelpClick,
  evidence,
  testArea,
  children,
}: FeedMassiveServiceBlockProps) {
  return (
    <div id={anchorId} className="feed-massive-service-block">
      <div className="feed-massive-svc-toolbar">
        <span className={lampClass(effectiveStatus)} title={statusLabel(effectiveStatus)} aria-label={`Service status: ${statusLabel(effectiveStatus)}`} />
        <span className="feed-massive-svc-status-label">{statusLabel(effectiveStatus)}</span>
        <button type="button" className="btn btn-secondary feed-massive-svc-help-btn" onClick={onHelpClick}>
          Help
        </button>
      </div>
      <div className="feed-massive-svc-evidence" aria-label="Evidence">
        <span className="feed-massive-svc-evidence-label">Evidence</span>
        <div className="feed-massive-svc-evidence-body">{evidence}</div>
      </div>
      {testArea != null ? (
        <div className="feed-massive-svc-test" aria-label="Test">
          <span className="feed-massive-svc-test-label">Test</span>
          <div className="feed-massive-svc-test-body">{testArea}</div>
        </div>
      ) : null}
      {children != null ? <div className="feed-massive-svc-main">{children}</div> : null}
    </div>
  )
}

export function massiveHelpSections(row: ChecklistRow) {
  return (
    <>
      <p className="feed-massive-help-lead">
        <strong>Purpose</strong>
      </p>
      <p className="feed-massive-help-text">{row.purpose}</p>
      <p className="feed-massive-help-lead">
        <strong>What we verify</strong>
      </p>
      <p className="feed-massive-help-text">{row.helpVerification}</p>
      <p className="feed-massive-help-lead">
        <strong>Notes</strong>
      </p>
      <p className="feed-massive-help-text">{row.description}</p>
      {row.testHint ? (
        <>
          <p className="feed-massive-help-lead">
            <strong>Test hint</strong>
          </p>
          <p className="feed-massive-help-text">{row.testHint}</p>
        </>
      ) : null}
      <p className="feed-massive-help-lead">
        <strong>Quick verification</strong>
      </p>
      <p className="feed-massive-help-text">{row.verification}</p>
    </>
  )
}
