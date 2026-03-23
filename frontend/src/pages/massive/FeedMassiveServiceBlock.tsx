import { useRef, type ReactNode, type MouseEvent } from 'react'
import type { ChecklistRow } from '../massiveFeedChecklistRows'
import { SettingsSidebarLampGlyph } from '../settings/settingsSidebarLampGlyphs'
import {
  checklistEffectiveStatusLabel,
  effectiveStatusToSidebarLamp,
  shortServiceLabel,
  type EffectiveServiceStatus,
  type MassiveSidebarLamp,
} from './massiveChecklistStatus'

export type { EffectiveServiceStatus } from './massiveChecklistStatus'

function statusLabel(s: EffectiveServiceStatus): string {
  return checklistEffectiveStatusLabel(s)
}

function lampClass(s: EffectiveServiceStatus): string {
  if (s === 'implemented') return 'feed-massive-svc-lamp feed-massive-svc-lamp--ok'
  if (s === 'partial') return 'feed-massive-svc-lamp feed-massive-svc-lamp--partial'
  if (s === 'not-on-tier') return 'feed-massive-svc-lamp feed-massive-svc-lamp--tier'
  return 'feed-massive-svc-lamp feed-massive-svc-lamp--fail'
}

function titleInlineLampClass(lamp: MassiveSidebarLamp): string {
  if (lamp === 'tier') return 'tier'
  return lamp
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

export interface FeedMassiveServiceBlockProps {
  /** Section anchor id (e.g. feed-massive-svc-snapshot). Omit when the parent section owns the fragment id. */
  anchorId?: string
  effectiveStatus: EffectiveServiceStatus
  evidence: ReactNode
  testArea?: ReactNode
  children?: ReactNode
  /** When set, Help opens this block and inline docs replace the draggable panel. */
  checklistRow?: ChecklistRow
  /** Legacy: optional external help (e.g. until all blocks use checklistRow). */
  onHelpClick?: (e: MouseEvent<HTMLButtonElement>) => void
}

/**
 * Unified header for Massive Option service sections: status lamp, evidence, test strip, optional Help + inline verification docs.
 */
export function FeedMassiveServiceBlock({
  anchorId,
  effectiveStatus,
  evidence,
  testArea,
  children,
  checklistRow,
  onHelpClick,
}: FeedMassiveServiceBlockProps) {
  const verificationRef = useRef<HTMLDetailsElement>(null)

  const openVerification = () => {
    const el = verificationRef.current
    if (el) {
      el.open = true
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }

  const handleHelp = (e: MouseEvent<HTMLButtonElement>) => {
    if (checklistRow) {
      openVerification()
    }
    onHelpClick?.(e)
  }

  const showHelp = Boolean(checklistRow || onHelpClick)
  const sidebarLamp = effectiveStatusToSidebarLamp(effectiveStatus)
  const statusWords = checklistEffectiveStatusLabel(effectiveStatus)

  return (
    <div {...(anchorId ? { id: anchorId } : {})} className="feed-massive-service-block">
      <div className="feed-massive-svc-toolbar">
        {checklistRow ? (
          <>
            <span
              className={`title-inline-lamp lamp-icon ${titleInlineLampClass(sidebarLamp)}`}
              title={`${statusWords} — ${shortServiceLabel(checklistRow)}`}
              aria-hidden
            >
              <SettingsSidebarLampGlyph id={checklistRow.id} />
            </span>
            <span className="feed-massive-svc-cap-name">{shortServiceLabel(checklistRow)}</span>
            <span className="feed-massive-svc-impl-status" aria-label={`Implementation status: ${statusWords}`}>
              {statusWords}
            </span>
          </>
        ) : (
          <>
            <span
              className={lampClass(effectiveStatus)}
              title={statusLabel(effectiveStatus)}
              aria-label={`Service status: ${statusLabel(effectiveStatus)}`}
            />
            <span className="feed-massive-svc-status-label">{statusLabel(effectiveStatus)}</span>
          </>
        )}
        {showHelp ? (
          <button type="button" className="btn btn-secondary feed-massive-svc-help-btn" onClick={handleHelp}>
            Help
          </button>
        ) : null}
      </div>
      <div
        className={
          testArea != null
            ? 'feed-massive-svc-work feed-massive-svc-work--split'
            : 'feed-massive-svc-work'
        }
      >
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
      </div>
      {children != null ? <div className="feed-massive-svc-main">{children}</div> : null}
      {checklistRow ? (
        <details ref={verificationRef} className="feed-massive-svc-verification" id={`feed-massive-verification-${checklistRow.id}`}>
          <summary className="feed-massive-svc-verification-summary">About and verification</summary>
          <div className="feed-massive-svc-verification-body">{massiveHelpSections(checklistRow)}</div>
        </details>
      ) : null}
    </div>
  )
}
