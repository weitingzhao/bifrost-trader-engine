import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Replaces legacy `.card.process-section` root wrappers during CSS retirement. */
export function PageSection({
  children,
  className,
  id,
  style,
  'aria-label': ariaLabel,
}: {
  children: ReactNode
  className?: string
  id?: string
  style?: CSSProperties
  'aria-label'?: string
}) {
  return (
    <div
      id={id}
      aria-label={ariaLabel}
      style={style}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-card p-4 shadow-sm md:p-5',
        className,
      )}
    >
      {children}
    </div>
  )
}
