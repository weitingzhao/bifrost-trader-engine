import { cn } from '@/lib/utils'
import { dataTableClass, dataTableWrapClass } from '@/components/shared/appUi'

export const perf = {
  page: 'flex flex-col gap-4',
  summarySection: 'gap-4',
  subtitle: 'm-0 max-w-[52rem] text-sm text-muted-foreground',
  pane: 'rounded-xl border border-border bg-[var(--color-surface)] p-4',
  filters: 'flex flex-col gap-3',
  filtersInline: 'flex flex-wrap items-end gap-4',
  filtersLoading: 'm-0',
  filterGroup: 'flex min-w-0 flex-wrap items-end gap-4',
  filter: 'flex min-w-0 flex-col gap-1 border-0 p-0',
  filterLegend: 'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
  timeRangePills: 'flex flex-wrap gap-1',
  timeRangePill:
    'inline-flex cursor-pointer items-center rounded-full border border-border bg-[var(--color-surface-elevated)] px-3 py-1 text-xs font-medium text-muted-foreground transition-[border-color,background,color] has-[:checked]:border-[var(--color-accent)] has-[:checked]:bg-[var(--color-accent-soft)] has-[:checked]:text-[var(--color-accent)] hover:border-[var(--color-border-strong)]',
  timeRangePillInput: 'sr-only',
  timeRangePillLabel: '',
  filterSelect:
    'min-w-[10rem] rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground',
  rangeLabel: 'inline-flex flex-col gap-0.5 text-xs text-muted-foreground',
  rangeLabelTitle: 'font-semibold uppercase tracking-wide',
  growthPanel: 'mt-4 rounded-xl border border-border bg-[var(--color-surface-elevated)] p-4',
  growthPanelHeader: 'mb-3 flex flex-wrap items-start justify-between gap-3',
  growthPanelTitleRow: 'flex flex-wrap items-center gap-2',
  growthControls: 'flex flex-wrap items-center gap-3',
  growthUnitToggle:
    'inline-flex overflow-hidden rounded-md border border-border [&_button]:border-0 [&_button]:bg-transparent [&_button]:px-3 [&_button]:py-1 [&_button]:text-xs [&_button]:font-semibold [&_button]:text-muted-foreground [&_button:hover]:bg-white/[0.04] [&_button.active]:bg-[var(--color-accent-soft)] [&_button.active]:text-[var(--color-accent)]',
  growthKpis: 'flex flex-wrap gap-3 text-xs text-muted-foreground',
  growthBody: 'flex flex-col gap-3 lg:flex-row',
  growthLegendSide: 'min-w-[10rem] space-y-1 text-xs',
  growthLegendHint: 'mb-1 block text-[0.625rem] font-bold uppercase tracking-wide text-muted-foreground',
  growthLegendRow: 'flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 hover:bg-white/[0.04]',
  growthLegendRowOff: 'opacity-45',
  growthLegendCheckbox: 'shrink-0',
  growthLegendSwatch: 'inline-block h-2.5 w-2.5 shrink-0 rounded-sm',
  growthLegendLabel: 'truncate text-xs font-medium',
  byDayTableWrap: dataTableWrapClass,
  byDayTable: cn(dataTableClass, 'by-day-table text-xs tabular-nums'),
  calendarStkDayTableWrap: dataTableWrapClass,
  calendarStkDayTable: cn(dataTableClass, 'text-xs tabular-nums'),
  calendarPairsTable:
    'w-full border-collapse text-[0.65rem] tabular-nums [&_th]:border [&_th]:border-border [&_th]:bg-[var(--color-surface-elevated)] [&_th]:px-1 [&_th]:py-0.5 [&_td]:border [&_td]:border-border [&_td]:px-1 [&_td]:py-0.5',
  onTheFlyTableWrap: dataTableWrapClass,
  onTheFlyTable: cn(dataTableClass, 'text-xs tabular-nums'),
  byDayTotalSummaryInline: 'flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground',
  byDayTotalSummaryKv: 'inline-flex items-center gap-1',
  byDaySumNumber: 'font-semibold tabular-nums text-foreground',
}

export function performanceTimeRangePillClass(active?: boolean) {
  return cn(perf.timeRangePill, active && 'border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]')
}

export function tonePositiveClass(className?: string) {
  return cn('text-[var(--color-success)]', className)
}

export function toneNegativeClass(className?: string) {
  return cn('text-[var(--color-danger)]', className)
}
