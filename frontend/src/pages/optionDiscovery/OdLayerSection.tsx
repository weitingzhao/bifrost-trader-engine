import { useState, type ReactNode } from 'react'
import { OdDataStatePanel } from './OdDataStatePanel'

export function OdLayerSection({
  id,
  step,
  title,
  subtitle,
  enabled = true,
  lockedHint,
  children,
}: {
  id: string
  step: 1 | 2 | 3 | 4
  title: string
  subtitle?: string
  enabled?: boolean
  lockedHint?: string
  children: ReactNode
}) {
  const [collapsed, setCollapsed] = useState(false)
  const titleId = `${id}-title`
  const contentId = `${id}-content`
  return (
    <section
      id={id}
      className={`od-layer-section${enabled ? '' : ' od-layer-section--locked'}`}
      aria-labelledby={titleId}
    >
      <header className="od-layer-section-header">
        <span className="od-layer-step" aria-hidden>
          {step}
        </span>
        <div className="od-layer-section-head-text">
          <h3 id={titleId} className="od-layer-section-title">
            {title}
          </h3>
          {subtitle ? <p className="section-hint od-layer-section-subtitle">{subtitle}</p> : null}
        </div>
        <button
          type="button"
          className="section-header-icon-btn od-layer-toggle-btn"
          onClick={() => setCollapsed(prev => !prev)}
          aria-expanded={!collapsed}
          aria-controls={contentId}
          aria-label={collapsed ? `Expand step ${step}` : `Collapse step ${step}`}
          title={collapsed ? 'Expand section' : 'Collapse section'}
        >
          <svg
            viewBox="0 0 24 24"
            width="16"
            height="16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d={collapsed ? 'M9 18l6-6-6-6' : 'M6 9l6 6 6-6'} />
          </svg>
        </button>
      </header>
      {!collapsed && (
        <div id={contentId} className="od-layer-section-body">
          {!enabled && lockedHint ? (
            <OdDataStatePanel status="idle" hint={lockedHint} />
          ) : (
            children
          )}
        </div>
      )}
    </section>
  )
}
