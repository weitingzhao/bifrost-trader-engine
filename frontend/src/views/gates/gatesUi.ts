import { cn } from '@/lib/utils'
import { dataTableClass, dataTableWrapClass } from '@/components/shared/appUi'

export const gates = {
  section: 'space-y-3',
  statusSummary:
    'grid gap-2 rounded-lg border border-border bg-[var(--color-surface-elevated)] p-3 text-sm [&_strong]:text-foreground',
  tableWrap: dataTableWrapClass,
  table: dataTableClass,
  formSection: 'rounded-lg border border-border bg-[var(--color-surface-elevated)] p-4',
  formStickyHeader: 'sticky top-0 z-[2] -mx-4 mb-4 border-b border-border bg-[var(--color-surface-elevated)] px-4 pb-3',
  form: 'grid gap-4 lg:grid-cols-2',
  formGroup: 'space-y-2 rounded-lg border border-border bg-[var(--color-surface)] p-3',
  formGroupTitle: 'mb-2 text-sm font-semibold text-foreground',
  formRow: 'grid grid-cols-[minmax(8rem,12rem)_1fr] items-center gap-2 text-sm',
  formRowFull: 'col-span-full',
  formRowInline: 'flex flex-wrap items-center gap-2',
  formActions: 'col-span-full flex flex-wrap gap-2 pt-2',
  formHint: 'text-xs text-muted-foreground',
  msgOk: 'text-sm text-[var(--color-success)]',
  msgErr: 'text-sm text-[var(--color-danger)]',
}

export function gatesFormRowClass(full?: boolean, className?: string) {
  return cn(gates.formRow, full && gates.formRowFull, className)
}

export const gatesFormInputClass =
  'w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]'

export const toggleSwitchClass = 'inline-flex cursor-pointer items-center gap-2 text-sm'
export const toggleSwitchCaptionClass = 'text-muted-foreground'
