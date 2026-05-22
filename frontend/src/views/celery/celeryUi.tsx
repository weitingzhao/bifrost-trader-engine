import { cva, type VariantProps } from 'class-variance-authority'
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { PageSection } from '@/components/shared/page-section'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'

export const CELERY_SECTION_TITLE =
  'm-0 inline-flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground'

export function CelerySectionTitle({
  id,
  children,
  className,
}: {
  id?: string
  children: ReactNode
  className?: string
}) {
  return (
    <h3 id={id} className={cn(CELERY_SECTION_TITLE, className)}>
      {children}
    </h3>
  )
}

/** Compact section card (replaces replay-section dashboard-section). */
export function CelerySection({
  id,
  'aria-labelledby': ariaLabelledBy,
  className,
  children,
}: {
  id?: string
  'aria-labelledby'?: string
  className?: string
  children: ReactNode
}) {
  return (
    <PageSection id={id} aria-label={ariaLabelledBy} className={cn('min-w-0 gap-3 p-4 md:p-4', className)}>
      {children}
    </PageSection>
  )
}

export const celeryIconButtonVariants = cva(
  'inline-flex shrink-0 items-center justify-center rounded-lg border p-0 transition-[background,border-color,color,box-shadow,filter] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        refresh:
          'h-8 w-8 border-border bg-[var(--color-surface)] text-muted-foreground shadow-sm hover:border-[color-mix(in_srgb,var(--color-accent)_38%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-surface))] hover:text-[var(--color-accent)] disabled:opacity-55',
        'delete-pending':
          'h-8 w-8 border border-[rgba(234,179,8,0.35)] bg-[var(--color-warning-soft)] text-[var(--color-warning)] shadow-none hover:border-[rgba(234,179,8,0.5)] hover:bg-[color-mix(in_srgb,var(--color-warning-soft)_82%,var(--color-warning)_18%)] active:bg-[color-mix(in_srgb,var(--color-warning-soft)_72%,var(--color-warning)_28%)]',
        'delete-running':
          'h-8 w-8 border border-[rgba(163,230,53,0.25)] bg-[var(--color-accent-soft)] text-[var(--color-accent)] shadow-none hover:border-[rgba(163,230,53,0.42)] hover:bg-[color-mix(in_srgb,var(--color-accent-soft)_82%,var(--color-accent)_18%)] active:bg-[color-mix(in_srgb,var(--color-accent-soft)_72%,var(--color-accent)_28%)]',
        'delete-done':
          'h-8 w-8 border border-[rgba(34,197,94,0.35)] bg-[var(--color-success-soft)] text-[var(--color-success)] shadow-none hover:border-[rgba(34,197,94,0.5)] hover:bg-[color-mix(in_srgb,var(--color-success-soft)_82%,var(--color-success)_18%)] active:bg-[color-mix(in_srgb,var(--color-success-soft)_72%,var(--color-success)_28%)]',
        'delete-failed':
          'h-8 w-8 border border-[rgba(239,68,68,0.35)] bg-[var(--color-danger-soft)] text-[var(--color-danger)] shadow-none hover:border-[rgba(239,68,68,0.5)] hover:bg-[color-mix(in_srgb,var(--color-danger-soft)_82%,var(--color-danger)_18%)] active:bg-[color-mix(in_srgb,var(--color-danger-soft)_72%,var(--color-danger)_28%)]',
        delete:
          'h-8 w-8 border border-[color-mix(in_srgb,var(--color-danger)_55%,var(--color-border))] bg-gradient-to-b from-[color-mix(in_srgb,var(--color-danger)_90%,#fff)] via-[var(--color-danger)] to-[color-mix(in_srgb,var(--color-danger)_90%,#1a0505)] text-white shadow-[0_1px_0_rgba(255,255,255,0.18)_inset,0_2px_8px_color-mix(in_srgb,var(--color-danger)_32%,transparent)] hover:brightness-105 active:brightness-[0.97]',
        trim:
          'h-8 w-8 border border-[color-mix(in_srgb,var(--color-accent)_45%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_10%,var(--color-surface))] text-[var(--color-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_18%,var(--color-surface))] hover:border-[color-mix(in_srgb,var(--color-accent)_58%,var(--color-border))] active:brightness-[0.96]',
        'scale-add-all':
          'border border-[rgba(34,197,94,0.38)] bg-[var(--color-success-soft)] text-[var(--color-success)] shadow-none hover:border-[rgba(34,197,94,0.55)] hover:bg-[color-mix(in_srgb,var(--color-success-soft)_82%,var(--color-success)_18%)] active:bg-[color-mix(in_srgb,var(--color-success-soft)_72%,var(--color-success)_28%)] disabled:opacity-50',
        'scale-reset':
          'border border-[rgba(234,179,8,0.4)] bg-[var(--color-warning-soft)] text-[var(--color-warning)] shadow-none hover:border-[rgba(234,179,8,0.55)] hover:bg-[color-mix(in_srgb,var(--color-warning-soft)_82%,var(--color-warning)_18%)] active:bg-[color-mix(in_srgb,var(--color-warning-soft)_72%,var(--color-warning)_28%)] disabled:opacity-50',
        'scale-remove-all':
          'border border-[rgba(239,68,68,0.4)] bg-[var(--color-danger-soft)] text-[var(--color-danger)] shadow-none hover:border-[rgba(239,68,68,0.55)] hover:bg-[color-mix(in_srgb,var(--color-danger-soft)_82%,var(--color-danger)_18%)] active:bg-[color-mix(in_srgb,var(--color-danger-soft)_72%,var(--color-danger)_28%)] disabled:opacity-50',
        'instance-recreate':
          'h-8 w-8 border border-[rgba(234,179,8,0.4)] bg-[var(--color-warning-soft)] text-[var(--color-warning)] shadow-none hover:border-[rgba(234,179,8,0.55)] hover:bg-[color-mix(in_srgb,var(--color-warning-soft)_82%,var(--color-warning)_18%)] disabled:opacity-50',
        'instance-remove':
          'h-8 w-8 border border-[rgba(239,68,68,0.4)] bg-[var(--color-danger-soft)] text-[var(--color-danger)] shadow-none hover:border-[rgba(239,68,68,0.55)] hover:bg-[color-mix(in_srgb,var(--color-danger-soft)_82%,var(--color-danger)_18%)] disabled:opacity-50',
      },
      withLabel: {
        true: 'h-auto min-h-8 w-auto gap-1.5 px-2.5 py-1.5 [&_svg]:shrink-0',
        false: '',
      },
      spinning: {
        true: '[&_svg]:origin-center [&_svg]:animate-spin',
        false: '',
      },
    },
    defaultVariants: {
      withLabel: false,
      spinning: false,
    },
  },
)

export type CeleryIconButtonVariant = NonNullable<VariantProps<typeof celeryIconButtonVariants>['variant']>

export function CeleryIconButton({
  variant,
  withLabel,
  spinning,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof celeryIconButtonVariants> & { children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(celeryIconButtonVariants({ variant, withLabel, spinning }), className)}
      {...props}
    >
      {children}
    </button>
  )
}

export function CeleryIconButtonLabel({ children }: { children: ReactNode }) {
  return (
    <span className="whitespace-nowrap text-[0.72rem] font-bold tracking-wide">{children}</span>
  )
}

export function celeryMainTabClass(active: boolean) {
  return cn(
    'mb-[-1px] cursor-pointer rounded-t-lg border-b-2 border-transparent px-4 py-1.5 text-sm font-medium text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
    active && 'border-[var(--color-accent)] text-[var(--color-accent)]',
  )
}

export function celeryQueueTabClass(active: boolean) {
  return cn(
    'mb-[-1px] cursor-pointer rounded-t-md border-b-2 border-transparent px-3.5 py-1.5 text-sm font-medium text-muted-foreground hover:bg-white/[0.04] hover:text-foreground',
    active && 'border-[var(--color-accent)] text-[var(--color-accent)]',
  )
}

export function celeryStatusBubbleClass(active: boolean) {
  return cn(
    'cursor-pointer rounded-full border border-border bg-[var(--color-surface)] px-2.5 py-1 text-[length:var(--text-tiny)] font-medium leading-tight text-muted-foreground transition-[background,color,border-color,box-shadow] hover:border-white/10 hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
    active &&
      'border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_14%,transparent)] text-[var(--color-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_25%,transparent)]',
  )
}

export function CeleryEmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('px-4 py-4 text-center text-[0.8125rem] text-muted-foreground', className)}>
      {children}
    </div>
  )
}

export function CeleryFilterButton({ active, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'cursor-pointer rounded-[var(--radius)] border border-border bg-background px-2 py-1 text-[0.6875rem] font-semibold text-muted-foreground transition-[background,color] hover:bg-[var(--color-surface)]',
        active && 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white',
        className,
      )}
      {...props}
    />
  )
}

export function celeryConsoleButtonClass(active?: boolean) {
  return cn(
    'rounded-md border border-border bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
    active && 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]',
  )
}

export function CeleryConsoleButton({ active, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-md border border-border bg-[var(--color-surface)] px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
        active && 'border-[var(--color-accent)] bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] text-[var(--color-accent)]',
        className,
      )}
      {...props}
    />
  )
}

export function CeleryPgCountButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'block w-full cursor-pointer border-none bg-transparent p-0.5 text-right font-[inherit] tabular-nums text-inherit hover:underline hover:brightness-110',
        className,
      )}
      {...props}
    />
  )
}

export function CeleryQueueNavButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'block w-full cursor-pointer border-none bg-transparent p-0 text-left font-[inherit] text-inherit hover:[&_code]:text-[var(--color-accent)] hover:[&_code]:underline',
        className,
      )}
      {...props}
    />
  )
}

export function CeleryLampNavButton({ className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex cursor-pointer items-center justify-center border-none bg-transparent p-0 font-[inherit] leading-none text-inherit hover:scale-110 hover:brightness-110 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
        className,
      )}
      {...props}
    />
  )
}

export function CelerySupportFilterButton({
  active,
  className,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'active'> & { active?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-[1.6rem] w-[1.6rem] shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-muted-foreground hover:bg-white/[0.06] hover:text-[var(--color-accent)]',
        active && 'text-[var(--color-accent)]',
        className,
      )}
      {...props}
    />
  )
}

export function CeleryConfirmOverlay({
  children,
  onBackdropClick,
}: {
  children: ReactNode
  onBackdropClick?: () => void
}) {
  return (
    <div
      className="fixed inset-0 z-[4000] flex items-center justify-center bg-black/55 p-4"
      role="presentation"
      onClick={e => {
        if (e.target === e.currentTarget) onBackdropClick?.()
      }}
    >
      {children}
    </div>
  )
}

export function CeleryConfirmDialog({
  title,
  message,
  confirming,
  confirmLabel = 'Confirm',
  onCancel,
  onConfirm,
}: {
  title: string
  message: string
  confirming: boolean
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <CeleryConfirmOverlay onBackdropClick={confirming ? undefined : onCancel}>
      <div
        className="w-full max-w-[26rem] rounded-xl border border-border bg-[var(--color-surface-elevated)] p-5 shadow-[0_16px_48px_rgba(0,0,0,0.35)]"
        role="dialog"
        aria-modal="true"
        aria-labelledby="celery-queue-confirm-title"
      >
        <h4 id="celery-queue-confirm-title" className="mb-3 text-[1.05rem] font-semibold text-foreground">
          {title}
        </h4>
        <p className="mb-4 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{message}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={confirming} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={confirming} onClick={onConfirm}>
            {confirming ? '…' : confirmLabel}
          </Button>
        </div>
      </div>
    </CeleryConfirmOverlay>
  )
}

export function CeleryOpsTable({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('min-w-0 overflow-x-auto', className)}>
      <Table className="text-sm">{children}</Table>
    </div>
  )
}

export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
}

export function celeryPgCellClass(status: 'pending' | 'running' | 'done' | 'failed') {
  const base = 'text-right tabular-nums'
  if (status === 'running') return cn(base, 'text-yellow-300')
  if (status === 'done') return cn(base, 'text-green-300')
  if (status === 'failed') return cn(base, 'text-red-300')
  return base
}

export function celeryWorkerFilterRowClass(highlighted: boolean) {
  return highlighted
    ? 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)] shadow-[inset_2px_0_0_var(--color-accent)]'
    : undefined
}

export function celeryBrokerBtnClass(kind: 'start' | 'restart' | 'stop') {
  const base = 'rounded-[var(--radius)] px-4 py-2 text-[0.8125rem] font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-50'
  if (kind === 'start') return cn(base, 'border-none bg-[var(--color-green)] text-white')
  if (kind === 'restart') return cn(base, 'border-none bg-[var(--color-yellow,#e6a817)] text-[#1a1a1a]')
  return cn(base, 'border border-border bg-[var(--color-surface)] text-foreground')
}

export function celeryWorkerStatusClass(lamp: 'green' | 'yellow' | 'red') {
  if (lamp === 'green') return 'text-[var(--color-green)]'
  if (lamp === 'yellow') return 'text-[var(--color-yellow,#e6a817)]'
  return 'text-[var(--color-red)]'
}

export function celeryRuntimeLampStatusClass(lamp: string) {
  if (lamp === 'green') return 'text-[var(--color-green)]'
  if (lamp === 'yellow') return 'text-[var(--color-yellow,#e6a817)]'
  if (lamp === 'red') return 'text-[var(--color-red)]'
  return 'text-muted-foreground'
}

export function CeleryCapabilitySheet({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'mb-3 min-w-0 rounded-lg border border-border bg-black/[0.12] p-3',
        className,
      )}
      {...props}
    />
  )
}

export function CelerySheetBlock({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-4 border-t border-border pt-3 first:mt-0 first:border-t-0 first:pt-0', className)}
      {...props}
    />
  )
}

export function CelerySheetBlockTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h4
      className={cn(
        'mb-2 inline-flex items-center gap-1 text-sm font-semibold text-muted-foreground',
        className,
      )}
      {...props}
    />
  )
}
