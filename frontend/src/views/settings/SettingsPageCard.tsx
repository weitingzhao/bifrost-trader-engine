import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Root wrapper for Settings / System pages (replaces legacy `.settings-page-card`). */
export function SettingsPageCard({
  id,
  embedded,
  className,
  children,
}: {
  id?: string
  embedded?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    <div
      id={id}
      className={cn(
        'box-border min-w-0 max-w-full bg-transparent p-0 shadow-none',
        embedded && 'min-w-0 max-w-full',
        className,
      )}
    >
      {children}
    </div>
  )
}
