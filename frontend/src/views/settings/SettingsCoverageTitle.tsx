import type { ReactNode } from 'react'
import { InfoTooltip } from '../../components/InfoTooltip'
import { BREADCRUMB_LINK_CLASS, PAGE_TITLE_CLASS } from '../../components/SectionPageTitle'

/** Settings → optional group → page breadcrumb for Data Coverage embed pages. */
export function SettingsCoverageTitle({
  groupLabel,
  groupHash,
  pageTitle,
  infoText,
  children,
}: {
  groupLabel?: string
  groupHash?: string
  pageTitle: string
  infoText: string
  children?: ReactNode
}) {
  return (
    <h2 className={PAGE_TITLE_CLASS} style={{ marginBottom: 'var(--space-2)' }}>
      <button
        type="button"
        className={BREADCRUMB_LINK_CLASS}
        onClick={() => { window.location.hash = '#settings-heartbeat' }}
        aria-label="Go to Settings"
      >
        Settings
      </button>
      {groupLabel && groupHash ? (
        <>
          {' / '}
          <button
            type="button"
            className={BREADCRUMB_LINK_CLASS}
            onClick={() => { window.location.hash = groupHash }}
            aria-label={`Go to ${groupLabel} coverage group`}
          >
            {groupLabel}
          </button>
        </>
      ) : null}
      {' / '}
      <span className="font-bold">{pageTitle}</span>
      <InfoTooltip text={infoText} />
      {children}
    </h2>
  )
}
