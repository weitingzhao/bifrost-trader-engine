import { cn } from '@/lib/utils'

export const swr = {
  head: 'mb-3 flex flex-wrap items-start justify-between gap-2',
  headMain: 'min-w-[min(100%,14rem)] flex-1',
  headActions: 'ml-auto flex shrink-0 items-center gap-2',
  hint: 'm-0 max-w-[48rem] text-sm text-muted-foreground',
  loading: 'm-0 whitespace-nowrap text-sm text-muted-foreground',
  list: 'flex flex-col gap-2',
  grid: 'grid grid-cols-[repeat(auto-fill,minmax(14.5rem,1fr))] gap-2 md:grid-cols-[repeat(auto-fill,minmax(15.5rem,1fr))] xl:grid-cols-[repeat(auto-fill,minmax(16rem,1fr))]',
  totals: 'min-w-0',
  panel:
    'max-w-full min-w-0 overflow-hidden rounded-lg border border-border bg-[var(--color-surface-elevated)] px-[0.65rem] py-[0.55rem] text-left font-[inherit] text-inherit',
  panelClickable:
    'cursor-pointer transition-[border-color,box-shadow] hover:border-[var(--color-accent)] hover:shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_25%,transparent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] disabled:cursor-default disabled:opacity-100',
  panelTotal: 'border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_8%,var(--color-surface-elevated))]',
  panelTitle: 'mb-2 truncate text-sm font-semibold text-foreground',
  panelSection: 'space-y-1',
  panelSectionLabel: 'text-[0.625rem] font-bold uppercase tracking-wide text-muted-foreground',
  kpis: 'grid grid-cols-2 gap-x-2 gap-y-1',
  kpi: 'flex items-baseline justify-between gap-1 text-xs',
  kpiHighlight: 'col-span-2 rounded bg-black/10 px-1 py-0.5',
  kpiLabel: 'text-muted-foreground',
  kpiValue: 'font-semibold tabular-nums text-foreground',
  kpiValueNeutral: 'text-muted-foreground',
  kpiValueWinPctDim: 'text-muted-foreground',
  metrics: 'grid gap-1',
  metrics3: 'grid-cols-1',
  metrics2: 'grid-cols-2',
  metricsPnl: '',
  metricsUnderlying: 'text-xs',
  metric: 'flex items-baseline justify-between gap-1 text-xs',
  metricRow: 'flex items-baseline justify-between gap-1',
  metricLabel: 'text-muted-foreground',
  metricValue: 'font-semibold tabular-nums',
  metricValuePnl: 'tabular-nums',
  metricValueMuted: 'text-muted-foreground',
}

export function strategyWinRatePanelClass(clickable?: boolean, total?: boolean, className?: string) {
  return cn(
    swr.panel,
    clickable && swr.panelClickable,
    total && swr.panelTotal,
    className,
  )
}

export function winRateKpiValueClass(total: number, wins: number) {
  const base = cn(swr.kpiValue, 'strategy-win-rate-kpi__value--winpct')
  if (total <= 0) return cn(base, swr.kpiValueWinPctDim)
  const pct = (wins / total) * 100
  if (pct > 50) return cn(base, 'text-[var(--color-success)]')
  if (pct < 50) return cn(base, 'text-[var(--color-danger)]')
  return cn(base, swr.kpiValueWinPctDim)
}

export function pnlPositiveClass(className?: string) {
  return cn('text-[var(--color-success)]', className)
}

export function pnlNegativeClass(className?: string) {
  return cn('text-[var(--color-danger)]', className)
}
