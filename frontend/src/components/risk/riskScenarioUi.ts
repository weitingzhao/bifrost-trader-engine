import { cn } from '@/lib/utils'

export const risk = {
  scenarioMatrix:
    'w-full border-collapse text-xs tabular-nums [&_th]:border-b [&_th]:border-border [&_th]:bg-[var(--color-surface-elevated)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5',
  scenarioColScenario: 'min-w-[7rem] text-left',
  scenarioColNum: 'text-right',
  scenarioCell: 'font-medium',
  scenarioLabel: 'inline-flex items-center gap-1',
  scenarioNa: 'text-muted-foreground',
  scenarioClickWrap: 'p-0 text-right',
  scenarioCellBtn:
    'inline-block w-full cursor-pointer border-0 bg-transparent px-2 py-1 text-right font-[inherit] tabular-nums underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
  scenarioCellBtnActive: 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]',
  scenarioExplain:
    'mt-3 rounded-lg border border-border bg-[var(--color-surface-elevated)] p-3 text-sm',
  scenarioExplainHead: 'mb-2 flex items-start justify-between gap-2',
  scenarioExplainClose:
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-lg leading-none text-muted-foreground hover:bg-white/[0.06] hover:text-foreground',
  scenarioExplainPrinciple: 'mb-2 text-xs leading-relaxed text-muted-foreground',
  scenarioExplainRules: 'mb-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground',
  scenarioExplainNote: 'mb-2 text-xs text-muted-foreground',
  scenarioExplainCode:
    'mb-2 overflow-x-auto rounded bg-black/20 p-2 font-mono text-[0.7rem] leading-relaxed text-foreground',
  scenarioExplainSum: 'text-xs text-muted-foreground',
  valueGain: 'text-[var(--color-success)]',
  valueLoss: 'text-[var(--color-danger)]',
  valueUnlimited: 'font-semibold text-[var(--color-danger)]',
  profileTopLine: 'mb-3 flex flex-wrap items-center gap-2 text-sm',
  profileTopSegment: 'inline-flex items-center gap-1',
  profileTopLabel: 'text-xs font-semibold uppercase tracking-wide text-muted-foreground',
  profileTopValue: 'font-semibold tabular-nums text-foreground',
  profileTopDivider: 'text-muted-foreground',
  profileScenarioPayoffRow: 'flex flex-col gap-3 lg:flex-row',
  profileScenarioCol: 'min-w-0 flex-1',
  profileScenarioSummary: 'rounded-lg border border-border bg-[var(--color-surface-elevated)] p-3',
  profileScenarioSummaryHead: 'mb-2 flex flex-wrap items-baseline gap-1 text-sm',
  profileScenarioSummaryLabel: 'font-semibold text-foreground',
  profileScenarioSummaryHint: 'text-xs text-muted-foreground',
  profileScenarioNote: 'mb-2 text-xs text-muted-foreground',
  profilePayoffCol: 'min-w-0 lg:w-[min(42%,24rem)]',
  profilePayoffColDual: 'lg:w-[min(48%,28rem)]',
  profilePayoffCharts: 'grid gap-3 sm:grid-cols-2',
  profilePayoffChartsStandalone: 'mt-3 grid gap-3 sm:grid-cols-2',
  profileDl: 'mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm',
  profileDtWithHelp: 'inline-flex items-center gap-1 font-medium text-muted-foreground',
  fieldHelpTrigger:
    'inline-flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-border bg-[var(--color-surface-elevated)] text-[0.625rem] font-bold text-muted-foreground hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]',
  fieldHelpTriggerActive: 'border-[var(--color-accent)] text-[var(--color-accent)]',
  fieldHelpPortalRoot: 'fixed inset-0 z-[5000]',
  fieldHelpPortalBackdrop: 'absolute inset-0 bg-black/45',
  fieldHelpPortalPanel:
    'absolute left-1/2 top-1/2 z-[1] max-h-[min(80vh,32rem)] w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl border border-border bg-[var(--color-surface-elevated)] p-4 shadow-[0_16px_48px_rgba(0,0,0,0.35)]',
  fieldHelpPortalHead: 'mb-2 flex cursor-move items-center justify-between gap-2',
  fieldHelpPortalTitle: 'text-sm font-semibold text-foreground',
  fieldHelpPortalClose:
    'rounded border border-border bg-transparent px-2 py-0.5 text-xs text-muted-foreground hover:bg-white/[0.06]',
  fieldHelpPortalBody: 'space-y-2 text-xs leading-relaxed text-muted-foreground',
  fieldHelpPortalFoot: 'mt-3 text-[0.625rem] text-muted-foreground',
  fieldHelpP: 'leading-relaxed',
  fieldHelpCode:
    'overflow-x-auto rounded bg-black/20 p-2 font-mono text-[0.68rem] leading-relaxed text-foreground',
  fieldHelpGrid:
    'w-full border-collapse text-[0.65rem] [&_th]:border-b [&_th]:border-border [&_th]:px-1 [&_th]:py-0.5 [&_td]:border-b [&_td]:border-border [&_td]:px-1 [&_td]:py-0.5',
  fieldHelpGridHi: 'bg-[color-mix(in_srgb,var(--color-accent)_12%,transparent)]',
  badgeDefined: 'rounded-full border border-[rgba(34,197,94,0.35)] bg-[var(--color-success-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--color-success)]',
  badgeUnlimited: 'rounded-full border border-[rgba(239,68,68,0.35)] bg-[var(--color-danger-soft)] px-2 py-0.5 text-xs font-semibold text-[var(--color-danger)]',
}

export function riskScenarioCellBtnClass(positive: boolean, active?: boolean, className?: string) {
  return cn(
    risk.scenarioCellBtn,
    positive ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]',
    active && risk.scenarioCellBtnActive,
    className,
  )
}

export function riskFieldHelpTriggerClass(active?: boolean, className?: string) {
  return cn(risk.fieldHelpTrigger, active && risk.fieldHelpTriggerActive, className)
}
