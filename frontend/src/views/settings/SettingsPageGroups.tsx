import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Column stack for Settings configuration cards (replaces `.settings-page-groups`). */
export function SettingsPageGroups({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col flex-nowrap gap-[var(--settings-section-gap)]',
        className,
      )}
    >
      {children}
    </div>
  )
}
