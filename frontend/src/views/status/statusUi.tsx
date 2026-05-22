import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Button } from '@/components/ui/button'

export const statusSectionHintClass = 'm-0 text-sm text-muted-foreground'
export const statusCountdownNumClass = 'font-semibold tabular-nums text-[var(--color-accent)]'
export const statusMsgOkClass = 'text-sm text-muted-foreground'
export const statusMsgErrClass = 'text-sm text-[var(--color-danger)]'

export function systemTabPanelClass(className?: string) {
  return cn('min-h-[7.5rem]', className)
}

export function systemTabsClass(className?: string) {
  return cn('mb-4 flex gap-0 border-b border-border', className)
}

export function systemTabClass(active?: boolean, className?: string) {
  return cn(
    '-mb-px inline-flex cursor-pointer items-center gap-2 border-b-2 border-transparent bg-transparent px-4 py-2 text-sm font-medium text-muted-foreground transition-[color,border-color] hover:text-foreground',
    active && 'border-[var(--color-accent)] text-foreground',
    className,
  )
}

export function statusPanelSectionClass(className?: string) {
  return cn(
    'rounded-xl border border-border bg-black/[0.15] p-3',
    className,
  )
}

export function daemonHeaderClass(className?: string) {
  return cn('mb-3 flex flex-wrap items-start justify-between gap-3', className)
}

export function daemonCardTitleClass(className?: string) {
  return cn('m-0 inline-flex flex-wrap items-center gap-2 text-base font-semibold text-foreground', className)
}

export function daemonGroupsClass(layout?: 'default' | 'account-sync', className?: string) {
  return cn(
    'grid gap-3',
    layout === 'account-sync'
      ? 'grid-cols-1 md:grid-cols-[1fr_1fr_2fr]'
      : 'grid-cols-1 md:grid-cols-[1fr_1fr_2fr]',
    className,
  )
}

export function monitorApiIbRowClass(className?: string) {
  return cn('flex flex-col gap-3 md:flex-row md:items-stretch', className)
}

export function monitorApiIbColClass(kind: 'api' | 'ib', className?: string) {
  return cn('flex min-w-0 flex-col', kind === 'api' ? 'md:flex-[2]' : 'md:flex-[3]', className)
}

export function DaemonGroup({
  id,
  className,
  children,
}: {
  id?: string
  className?: string
  children: ReactNode
}) {
  return (
    <div
      id={id}
      className={cn(
        'min-w-0 rounded-xl border border-border bg-[var(--color-surface)] p-4 transition-[border-color,box-shadow] hover:border-[var(--color-border-strong)] hover:shadow-[0_4px_20px_rgba(0,0,0,0.12)]',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function DaemonGroupHeader({
  className,
  withAction,
  children,
}: {
  className?: string
  withAction?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'mb-3 flex items-center gap-2 border-b border-border pb-2',
        withAction && 'justify-between',
        className,
      )}
    >
      {children}
    </div>
  )
}

export function DaemonGroupTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('text-[length:var(--text-caption)] font-bold uppercase tracking-widest text-foreground', className)}>
      {children}
    </span>
  )
}

export function DaemonGroupBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('min-w-0 space-y-2', className)}>{children}</div>
}

export function IbConnectionTable({ className, children, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="min-w-0 overflow-x-auto">
      <Table className={cn('text-sm', className)} {...props}>
        {children}
      </Table>
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

export function ibConnectionThClass(className?: string) {
  return cn('text-xs font-semibold uppercase tracking-wide text-muted-foreground', className)
}

export function ibConnectionRowLabelClass(className?: string) {
  return cn('whitespace-nowrap text-sm font-medium text-foreground', className)
}

export function ibConnectionCellClass(className?: string) {
  return cn('text-sm text-muted-foreground', className)
}

export function sectionHeaderIconBtnClass(className?: string) {
  return cn(
    'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border bg-[var(--color-surface)] text-muted-foreground transition-[border-color,background,color] hover:border-[color-mix(in_srgb,var(--color-accent)_38%,var(--color-border))] hover:bg-[color-mix(in_srgb,var(--color-accent)_9%,var(--color-surface))] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50',
    className,
  )
}

export function SectionHeaderIconButton({
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cn(sectionHeaderIconBtnClass(), className)} {...props}>
      {children}
    </button>
  )
}

export function statusControlBtnClass(kind: 'resume' | 'suspend' | 'retry' | 'flatten', className?: string) {
  const base = 'h-auto px-2 py-1 text-[0.8125rem]'
  if (kind === 'resume') return cn(base, className)
  if (kind === 'suspend') return cn(base, className)
  return cn(base, className)
}

export function StatusControlButton({
  kind,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind: 'resume' | 'suspend' | 'retry' | 'flatten' }) {
  return <Button type="button" size="sm" variant="outline" className={statusControlBtnClass(kind, className)} {...props} />
}

/** Event subscribe panel (IbEventSubscribePanel). */
export const es = {
  section: statusPanelSectionClass,
  headerRow: 'mb-3 flex flex-wrap items-start justify-between gap-3',
  streamAges: 'flex flex-wrap items-center gap-2',
  ageBadge:
    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.6875rem] font-semibold tabular-nums',
  ageFresh: 'border-[rgba(34,197,94,0.35)] bg-[var(--color-success-soft)] text-[var(--color-success)]',
  ageRecent: 'border-[rgba(234,179,8,0.35)] bg-[var(--color-warning-soft)] text-[var(--color-warning)]',
  ageStale: 'border-[rgba(249,115,22,0.35)] bg-[rgba(249,115,22,0.12)] text-orange-400',
  ageOld: 'border-[rgba(239,68,68,0.35)] bg-[var(--color-danger-soft)] text-[var(--color-danger)]',
  ageLabel: 'text-[0.625rem] font-bold uppercase tracking-wide opacity-80',
  ageValue: 'tabular-nums',
  subheading: 'mb-2 mt-4 text-sm font-semibold text-foreground first:mt-0',
  tabPanelFirstHeading: 'mt-0',
  inlineCode: 'rounded bg-black/20 px-1 py-0.5 font-mono text-[0.78em]',
  tickerChip:
    'inline-flex rounded-full border border-border bg-[var(--color-surface-elevated)] px-2 py-0.5 font-mono text-xs',
  tickerChips: 'flex flex-wrap gap-1.5',
  summaryLine: 'text-sm text-muted-foreground',
  summaryK: 'mr-1 font-semibold text-foreground',
  scroll: 'max-h-[min(24rem,50vh)] overflow-auto rounded-md border border-border',
  tableWrap: 'min-w-0 overflow-x-auto rounded-md border border-border',
  table: 'w-full border-collapse text-xs [&_th]:sticky [&_th]:top-0 [&_th]:z-[1] [&_th]:border-b [&_th]:border-border [&_th]:bg-[var(--color-surface-elevated)] [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-semibold [&_td]:border-b [&_td]:border-border [&_td]:px-2 [&_td]:py-1.5',
  statusCell: 'inline-flex items-center gap-1.5',
  contractCell: 'max-w-[12rem] truncate font-mono text-xs',
  redisMetricCell: 'text-right tabular-nums',
  redisKeyCell: 'max-w-[10rem] truncate font-mono text-[0.7rem]',
}

export function eventSubscribeAgeBadgeClass(ageSec: number) {
  if (ageSec < 10) return cn(es.ageBadge, es.ageFresh)
  if (ageSec < 60) return cn(es.ageBadge, es.ageRecent)
  if (ageSec < 300) return cn(es.ageBadge, es.ageStale)
  return cn(es.ageBadge, es.ageOld)
}
