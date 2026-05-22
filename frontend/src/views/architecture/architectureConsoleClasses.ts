import { cn } from '@/lib/utils'

/** Architecture API log console — Phase 7 Wave 6 */
export const ac = {
  unifiedConsole: 'mt-2 group',
  consoleFilterRow:
    'mb-[var(--space-2)] flex flex-wrap items-start gap-x-[var(--space-3)] gap-y-[var(--space-2)]',
  consoleFilterLabel:
    'shrink-0 pt-[0.35rem] text-[length:var(--text-caption)] font-semibold text-[var(--color-text-dim)]',
  sourceBubbles: 'flex flex-wrap items-center gap-[0.35rem]',
  sourceBubble:
    'm-0 cursor-pointer rounded-full border border-border bg-[color-mix(in_srgb,var(--color-surface-raised,var(--color-border))_40%,transparent)] px-3 py-[0.28rem] text-[length:var(--text-caption)] font-semibold leading-[1.25] text-muted-foreground hover:border-[color-mix(in_srgb,var(--color-accent)_35%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_10%,transparent)] hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]',
  sourceBubbleActive:
    'border-[color-mix(in_srgb,var(--color-accent)_55%,var(--color-border))] bg-[color-mix(in_srgb,var(--color-accent)_16%,transparent)] text-[var(--color-accent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-accent)_22%,transparent)] [html:not([data-theme=light])_&]:border-[color-mix(in_srgb,var(--color-accent)_50%,var(--color-border))] [html:not([data-theme=light])_&]:bg-[color-mix(in_srgb,var(--color-accent)_22%,transparent)] [html:not([data-theme=light])_&]:text-[color-mix(in_srgb,var(--color-accent)_78%,#e8f4ff_22%)]',
  sourceBubbleOff:
    'opacity-55 line-through decoration-[color-mix(in_srgb,var(--color-text-muted)_70%,transparent)]',
  logSourceTag:
    'mr-[0.35rem] inline-block rounded px-[0.35rem] py-[0.05rem] align-baseline text-[0.7rem] font-bold tracking-[0.02em]',
  logSourceMonitor: 'bg-[rgba(59,130,246,0.18)] text-foreground',
  logSourceDocs: 'bg-[rgba(168,85,247,0.2)] text-foreground',
  logSourceOps: 'bg-[rgba(34,197,94,0.18)] text-foreground',
  logSourceTrading: 'bg-[rgba(245,158,11,0.2)] text-foreground',
  logSourcePortfolio: 'bg-[rgba(20,184,166,0.2)] text-foreground',
  logSourceResearch: 'bg-[rgba(99,102,241,0.2)] text-foreground',
  logSourceStrategy: 'bg-[rgba(236,72,153,0.18)] text-foreground',
  logSourceMarket: 'bg-[rgba(14,165,233,0.2)] text-foreground',
  logSourceMassiveWs: 'bg-[rgba(14,165,233,0.22)] text-foreground',
  logSourceIbOperator: 'bg-[rgba(34,197,94,0.2)] text-foreground',
  logSourceIbIngestor: 'bg-[rgba(245,158,11,0.22)] text-foreground',
  logSourceIbAccountAgent: 'bg-[rgba(168,85,247,0.22)] text-foreground',
  logSourceStrategyTrading: 'bg-[rgba(245,158,11,0.22)] text-foreground',
  logSourceAccountSync: 'bg-[rgba(20,184,166,0.22)] text-foreground',
  consoleStatusLine: 'flex items-center justify-between gap-2 text-sm text-muted-foreground',
  consoleStatusMessages: 'flex min-w-0 flex-1 flex-wrap items-center gap-2',
  consoleFetchHint: 'text-[length:var(--text-caption)] leading-[1.35] text-muted-foreground',
  consoleWarning: 'text-[length:var(--text-caption)] leading-[1.35] text-[var(--color-lamp-yellow)]',
  consoleClearErr: 'text-[length:var(--text-caption)] leading-[1.35] text-[var(--color-lamp-red)]',
} as const

const LOG_SOURCE_CLASS: Record<string, string> = {
  monitor: ac.logSourceMonitor,
  docs: ac.logSourceDocs,
  ops: ac.logSourceOps,
  trading: ac.logSourceTrading,
  portfolio: ac.logSourcePortfolio,
  research: ac.logSourceResearch,
  strategy: ac.logSourceStrategy,
  market: ac.logSourceMarket,
  massive_ws: ac.logSourceMassiveWs,
  ib_operator: ac.logSourceIbOperator,
  ib_ingestor: ac.logSourceIbIngestor,
  ib_account_agent: ac.logSourceIbAccountAgent,
  strategy_trading: ac.logSourceStrategyTrading,
  account_sync: ac.logSourceAccountSync,
}

export function logSourceTagClass(source: string): string {
  return cn(ac.logSourceTag, LOG_SOURCE_CLASS[source] ?? '')
}

export function sourceBubbleClass(on: boolean): string {
  return cn(ac.sourceBubble, on ? ac.sourceBubbleActive : ac.sourceBubbleOff)
}
