import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface SettingsShellProps {
  sidebar?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * Settings layout shell — padding and width contract (replaces .settings-page / .settings-main).
 */
export function SettingsShell({ children, className }: SettingsShellProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 w-full max-w-full flex-col',
        'px-[var(--settings-main-padding-x)] py-[var(--settings-main-padding-y)]',
        className,
      )}
    >
      <div className="min-w-0 max-w-full flex-1">{children}</div>
    </div>
  )
}
