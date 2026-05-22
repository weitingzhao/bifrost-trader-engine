import { cn } from '@/lib/utils'

/** Pill tabs (replaces `.app-tabs` / `.app-tab`). */
export function appTabsClass(className?: string) {
  return cn('flex flex-wrap items-center gap-2', className)
}

export function appTabClass(active?: boolean, className?: string) {
  return cn(
    'inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-[var(--color-surface)] px-4 py-2 text-sm font-medium text-muted-foreground transition-[background,color,border-color] hover:bg-[var(--color-surface-elevated)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
    active && 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]',
    className,
  )
}

export const appTabNavDividerClass =
  'mx-1 inline-block h-5 w-px shrink-0 bg-[var(--border-muted,rgba(255,255,255,0.15))]'

/** Compact pagination bar (replaces `.table-pagination`). */
export function tablePaginationClass(className?: string) {
  return cn(
    'inline-flex items-center gap-2 rounded-full border border-border bg-[var(--color-surface-elevated)] px-2 py-1',
    className,
  )
}

export const tablePaginationLabelClass = 'text-[length:var(--text-caption)] text-muted-foreground'
export const tablePaginationInfoClass = 'text-[length:var(--text-caption)] text-foreground'

/** Scrollable data table shell (replaces `.table-wrap` + `.data-table` on raw `<table>`). */
export function dataTableWrapClass(className?: string) {
  return cn('min-w-0 overflow-x-auto rounded-md border border-border', className)
}

export const dataTableClass =
  'w-full border-collapse text-sm [&_th]:border-b [&_th]:border-border [&_th]:bg-[var(--color-surface-elevated)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:tracking-wide [&_th]:text-muted-foreground [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:text-foreground [&_tbody_tr:last-child_td]:border-b-0 [&_tbody_tr:hover]:bg-white/[0.03]'

/** Operations table (replaces `.table-operations`). */
export const operationsTableClass =
  'w-full overflow-hidden rounded-lg border-collapse [&_thead_th]:border-b-2 [&_thead_th]:border-border [&_thead_th]:px-4 [&_thead_th]:py-3 [&_tbody_tr]:transition-[background] [&_tbody_tr:hover]:bg-[rgba(163,230,53,0.06)] [&_tbody_td]:px-4 [&_tbody_td]:py-2 [&_tbody_td]:tabular-nums'

export const appPageStackClass = 'flex flex-col'
export const cardOperationsClass = 'mb-[var(--space-2)]'
export const sectionHintClass = 'm-[var(--space-1)_0_0_0] text-[length:var(--text-caption)] text-muted-foreground'
export const sectionDescClass = 'text-[length:var(--text-caption)] font-normal text-muted-foreground'
export const controlsClass = 'mt-[var(--space-3)] flex flex-wrap gap-[var(--space-2)]'
export const researchPageHeadClass =
  'mb-2 flex flex-wrap items-center justify-between gap-2 [&_.page-title-with-tooltip]:m-0'
export const msgOkClass = 'text-[var(--color-success)]'
export const msgErrorClass = 'text-[var(--color-danger)]'
export const msgWarningClass = 'text-[var(--color-warning)]'
export const pnlPositiveClass = 'text-[var(--color-success)]'
export const pnlNegativeClass = 'text-[var(--color-danger)]'
