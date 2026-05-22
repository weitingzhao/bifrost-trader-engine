import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

const execIconBtnClass =
  'inline-flex h-8 min-h-8 min-w-8 items-center justify-center rounded-md border border-border bg-transparent p-0 text-foreground shadow-none hover:border-[var(--color-border-strong)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-accent)]'

const execIconBtnDangerClass =
  'border-[var(--color-danger-muted,rgba(220,38,38,0.4))] text-[var(--color-danger,#dc2626)] hover:border-[var(--color-danger,#dc2626)] hover:bg-[rgba(220,38,38,0.08)] hover:text-[var(--color-danger,#dc2626)]'

/** Compact row action icon (replaces `.btn.btn-icon-small`). */
export function ExecRowIconButton({
  variant = 'default',
  className,
  children,
  ...props
}: {
  variant?: 'default' | 'danger'
  children: ReactNode
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(execIconBtnClass, variant === 'danger' && execIconBtnDangerClass, className)}
      {...props}
    >
      {children}
    </Button>
  )
}

export function LinkStrategyIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <ExecRowIconButton
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    </ExecRowIconButton>
  )
}

export function LinkStockLegIconButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <ExecRowIconButton
      onClick={e => {
        e.stopPropagation()
        onClick()
      }}
      title={title}
      aria-label={title}
    >
      <svg viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M3 18h6v-6H3v6zm9-12h6V3h-6v3zM3 8h6V3H3v5zm9 10h6v-6h-6v6z" />
        <path d="M14 9h2M9 14v2" />
      </svg>
    </ExecRowIconButton>
  )
}

/** Stock symbol opens inspector (replaces `.riv-stock-symbol-btn`). */
export const stockSymbolInspectorBtnClass =
  'm-0 cursor-pointer border-0 bg-transparent p-0 font-inherit text-inherit hover:underline focus-visible:outline-none'

export const stockSymbolInspectorBtnCompactClass = 'text-[0.85em] align-baseline'

/** Option contract opens inspector (replaces `.riv-opt-contract-btn`). */
export const optContractInspectorBtnClass =
  'm-0 cursor-pointer border-0 bg-transparent p-0 text-left font-inherit text-inherit hover:underline focus-visible:outline-none'

/** Section heading with inline tooltip (replaces `.page-title-with-tooltip` on subheadings). */
export const sectionHeadingWithTooltipClass = 'inline-flex items-center gap-2'
