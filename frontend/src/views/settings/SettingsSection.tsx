import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Vertical section divider inside Settings pages (replaces `.replay-section`). */
export function SettingsSection({
  children,
  className,
  id,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: {
  children: ReactNode
  className?: string
  id?: string
  'aria-label'?: string
  'aria-labelledby'?: string
}) {
  return (
    <section
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      className={cn(
        'min-w-0 border-t border-border pt-4 first:mt-4 first:border-t-0 first:pt-0',
        'mt-5 [&_h3]:mb-3 [&_h3]:text-[length:var(--text-title)] [&_h3]:text-foreground',
        className,
      )}
    >
      {children}
    </section>
  )
}
