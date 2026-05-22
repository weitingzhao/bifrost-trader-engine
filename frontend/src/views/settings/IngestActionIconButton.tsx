import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type IngestActionVariant = 'default' | 'success' | 'danger'

const variantClass: Record<IngestActionVariant, string> = {
  default:
    'h-8 w-8 min-h-8 min-w-8 border border-border bg-muted/40 text-foreground hover:bg-muted',
  success:
    'h-8 w-8 min-h-8 min-w-8 border border-emerald-500/40 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25',
  danger:
    'h-8 w-8 min-h-8 min-w-8 border border-destructive/40 bg-destructive/15 text-destructive hover:bg-destructive/25',
}

/** Compact icon control for Socket/Daemon ingest rows (replaces `.btn.btn-icon-small`). */
export function IngestActionIconButton({
  variant = 'default',
  title,
  'aria-label': ariaLabel,
  onClick,
  children,
}: {
  variant?: IngestActionVariant
  title: string
  'aria-label': string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn('rounded-md p-0', variantClass[variant])}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
    >
      {children}
    </Button>
  )
}
