import type { CSSProperties, ReactNode } from 'react'
import { InfoTooltip } from './InfoTooltip'

export interface SectionPageTitleProps {
  id?: string
  /** First segment (e.g. Research / Portfolio / Strategy); shown in accent color. */
  menu: string
  /** Current page name after " / ". */
  pageTitle: string
  /** When set, menu is a button; otherwise menu is non-interactive text with the same accent color. */
  onMenuClick?: () => void
  /** Hover / aria label for the menu control. */
  menuNavigateAriaLabel?: string
  infoText: string
  className?: string
  style?: CSSProperties
  /** Rendered after the primary ? tooltip (badges, extra tooltips, counts). */
  children?: ReactNode
}

/**
 * Unified breadcrumb title for Research / Portfolio / Strategy pages:
 * accent menu label, " / " + page name in main text color, ? info tooltip.
 */
export function SectionPageTitle({
  id,
  menu,
  pageTitle,
  onMenuClick,
  menuNavigateAriaLabel,
  infoText,
  className = '',
  style,
  children,
}: SectionPageTitleProps) {
  const aria = menuNavigateAriaLabel ?? `Go to ${menu}`
  const menuEl =
    onMenuClick != null ? (
      <button type="button" className="page-title-breadcrumb-link" onClick={onMenuClick} aria-label={aria}>
        {menu}
      </button>
    ) : (
      <span className="page-title-breadcrumb-menu-static">{menu}</span>
    )

  return (
    <h2 id={id} className={`page-title-with-tooltip ${className}`.trim()} style={style}>
      {menuEl}
      <span className="page-title-breadcrumb-tail">
        {' / '}
        <span className="page-title-breadcrumb-page">{pageTitle}</span>
      </span>
      <InfoTooltip text={infoText} />
      {children}
    </h2>
  )
}
