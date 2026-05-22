import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { InfoTooltip } from './InfoTooltip'

export interface SectionPageTitleProps {
  id?: string
  menu: string
  pageTitle: string
  onMenuClick?: () => void
  menuNavigateAriaLabel?: string
  infoText: string
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

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
      <button
        type="button"
        className="border-0 bg-transparent p-0 font-inherit text-[var(--color-link)] hover:text-[var(--color-link-hover)] hover:underline focus-visible:rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        onClick={onMenuClick}
        aria-label={aria}
      >
        {menu}
      </button>
    ) : (
      <span className="text-[var(--color-link)]">{menu}</span>
    )

  return (
    <h2
      id={id}
      className={cn(
        'm-0 inline-flex flex-wrap items-center gap-2 text-[length:var(--text-headline)] font-bold tracking-tight text-foreground',
        className,
      )}
      style={style}
    >
      {menuEl}
      <span className="text-foreground">
        {' / '}
        <span className="font-bold">{pageTitle}</span>
      </span>
      <InfoTooltip text={infoText} />
      {children}
    </h2>
  )
}
