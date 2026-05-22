import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Page title row with optional Ops auth bar on the right (Celery / Socket / Daemon Ops). */
export function SettingsPageHeader({
  children,
  actions,
  celeryLayout,
  className,
}: {
  children: ReactNode
  actions?: ReactNode
  /** Title block grows; auth aligns top-right (Socket, Celery, Daemon Ops). */
  celeryLayout?: boolean
  className?: string
}) {
  return (
    <div
      className={cn(
        'mb-5 flex flex-wrap gap-3 border-b border-border pb-4',
        celeryLayout ? 'items-start justify-between' : 'items-center justify-between',
        className,
      )}
    >
      <div className={cn('flex min-w-0 flex-col gap-0.5', celeryLayout && 'flex-1')}>{children}</div>
      {actions != null ? <div className="flex shrink-0 flex-col items-end gap-2">{actions}</div> : null}
    </div>
  )
}

export function SettingsPageTitle({
  children,
  className,
  id,
  style,
}: {
  children: ReactNode
  className?: string
  id?: string
  style?: CSSProperties
}) {
  return (
    <h2
      id={id}
      style={style}
      className={cn(
        'm-0 inline-flex flex-wrap items-center gap-2 text-[length:var(--text-headline)] font-bold tracking-tight text-foreground',
        className,
      )}
    >
      {children}
    </h2>
  )
}

export function SettingsPageSubtitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('m-0 text-[length:var(--text-caption)] font-normal text-muted-foreground', className)}>
      {children}
    </p>
  )
}

export function SettingsPageActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-3', className)}>{children}</div>
  )
}
