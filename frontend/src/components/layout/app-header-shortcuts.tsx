'use client'

import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const pillGroupClass =
  'inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2 py-1.5 text-xs text-foreground transition-colors hover:border-border hover:bg-muted'

const shortcutBtnClass =
  'inline-flex items-center justify-center rounded-md p-0.5 leading-none text-foreground hover:bg-background'

export function AppHeaderShortcutPill({
  children,
  className,
  'aria-label': ariaLabel,
}: {
  children: ReactNode
  className?: string
  'aria-label'?: string
}) {
  return (
    <div className={cn(pillGroupClass, className)} aria-label={ariaLabel}>
      {children}
    </div>
  )
}

export function AppHeaderShortcutButton({
  active,
  title,
  'aria-label': ariaLabel,
  onClick,
  children,
  className,
}: {
  active?: boolean
  title: string
  'aria-label': string
  onClick: () => void
  children: ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      className={cn(
        shortcutBtnClass,
        active && 'bg-primary/15 text-primary',
        className,
      )}
      title={title}
      aria-label={ariaLabel}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

export function AppHeaderStopButton({
  onClick,
  title,
  'aria-label': ariaLabel,
  disabled,
}: {
  onClick: () => void
  title: string
  'aria-label': string
  disabled?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-5 min-h-5 min-w-5 rounded hover:bg-destructive/15 hover:text-destructive"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      <X size={14} aria-hidden />
    </Button>
  )
}

export function AppHeaderQueueBadge({ value }: { value: string }) {
  return (
    <span
      className="min-w-4 text-right text-[0.65rem] font-bold tabular-nums text-muted-foreground pointer-events-none"
      title="Queue summary Pending total"
    >
      {value}
    </span>
  )
}
