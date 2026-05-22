import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function SettingsStatusMessage({
  children,
  error,
  className,
}: {
  children: ReactNode
  error?: boolean
  className?: string
}) {
  return (
    <span
      className={cn(
        'rounded-md px-2 py-1 text-[length:var(--text-caption)]',
        error ? 'bg-[var(--color-danger-soft)]' : 'bg-[var(--color-success-soft)]',
        className,
      )}
      role={error ? 'alert' : undefined}
    >
      {children}
    </span>
  )
}
