import { cn } from '@/lib/utils'

export const SETTINGS_GROUP_CARD = 'settings-group-card'

export const su = {
  group: cn(
    SETTINGS_GROUP_CARD,
    'min-w-0 rounded-xl border border-border bg-[var(--color-surface)] p-4 transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.12)]',
  ),
  groupHeader: 'mb-3 flex items-center gap-2 border-b border-border pb-2',
  groupTitle: 'text-[length:var(--text-caption)] font-bold uppercase tracking-widest text-foreground',
  groupBody: 'min-w-0 space-y-3',
  subtitle: 'm-0 max-w-[48rem] text-sm text-muted-foreground',
  sheetTitle: 'mb-2 text-sm font-semibold text-foreground',
  section: 'space-y-3',
  sectionGap: 'mt-4 border-t border-border pt-4 first:mt-0 first:border-t-0 first:pt-0',
  readonlyBadge:
    'ml-2 inline-flex rounded-full border border-border bg-[var(--color-surface-elevated)] px-2 py-0.5 text-[0.625rem] font-bold uppercase tracking-wide text-muted-foreground',
  readonlyHint: 'ml-2 text-xs font-normal text-muted-foreground',
  collapsibleHeader:
    'flex cursor-pointer items-center gap-2 bg-[var(--color-surface-elevated)] px-3 py-2 text-left text-sm font-semibold text-foreground hover:bg-white/[0.04]',
  collapsibleChevron: 'inline-block text-[0.55rem] text-muted-foreground transition-transform',
  collapsibleChevronOpen: 'rotate-180',
  collapsibleTitle: 'font-semibold',
  preferenceControls: 'flex flex-wrap gap-3',
  heartbeatRow: 'flex flex-wrap items-center gap-3',
  heartbeatLabel: 'inline-flex flex-wrap items-center gap-2 text-sm text-muted-foreground',
  heartbeatLabelText: 'min-w-[12rem] font-medium text-foreground',
  heartbeatInputWrap: 'inline-flex items-center gap-1',
  heartbeatInput:
    'w-16 rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
  heartbeatUnit: 'text-xs text-muted-foreground',
}

export function flexQueryTableWrapClass(className?: string) {
  return cn('min-w-0 overflow-x-auto rounded-md border border-border', className)
}

export const flexQueryTableClass =
  'w-full min-w-[36rem] border-collapse text-sm [&_th]:border-b [&_th]:border-border [&_th]:bg-[var(--color-surface-elevated)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_tbody_tr:last-child_td]:border-b-0'

export function flexQueryCellTypeClass(className?: string) {
  return cn('whitespace-nowrap text-sm font-medium text-muted-foreground', className)
}

export function flexQueryCellInputClass(className?: string) {
  return cn('min-w-[8rem]', className)
}

export const flexQueryInputClass =
  'w-full min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-60'

export function settingsIbReadonlyFieldClass(className?: string) {
  return cn(flexQueryInputClass, 'bg-[var(--color-surface-elevated)] text-muted-foreground', className)
}

export function settingsIbConfigThClass(kind: 'label' | 'host' | 'secondary', className?: string) {
  const base = 'text-xs font-semibold uppercase tracking-wide'
  if (kind === 'label') return cn(base, 'w-[10rem] text-muted-foreground', className)
  return cn(base, 'text-foreground', className)
}

export function clientIdsGroupHeaderClass(className?: string) {
  return cn('bg-[var(--color-surface-elevated)] px-3 py-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground', className)
}

export function settingsIbReadonlySectionHeaderClass(className?: string) {
  return cn('bg-[var(--color-surface-elevated)]', className)
}

export const settingsHolidays = {
  filters: 'flex flex-wrap items-end gap-3',
  input:
    'ml-2 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
  inputText: 'min-w-[12rem]',
  addRow: 'flex flex-wrap items-end gap-3',
  addLabel: 'flex flex-col gap-1 text-sm text-muted-foreground',
  empty: 'text-sm text-muted-foreground',
  msgOk: 'text-sm text-[var(--color-success)]',
  msgErr: 'text-sm text-[var(--color-danger)]',
  tableWrap: 'min-w-0 overflow-x-auto rounded-md border border-border',
  table:
    'w-full border-collapse text-sm [&_th]:border-b [&_th]:border-border [&_th]:bg-[var(--color-surface-elevated)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:text-xs [&_th]:font-semibold [&_td]:border-b [&_td]:border-border [&_td]:px-3 [&_td]:py-2',
  dateCell: 'whitespace-nowrap font-mono text-xs',
  labelCell: 'max-w-[16rem]',
}
