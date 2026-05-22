import { cn } from '@/lib/utils'

/** Stock Screener — Tailwind replacements for stock-screener.css (Phase 7 Wave 4) */

export const SSP = {
  page: 'flex flex-col gap-3',
  section: 'flex flex-col gap-2',
  sectionHeader: 'mb-0.5 flex items-center gap-3',
  sectionLabel:
    'shrink-0 whitespace-nowrap rounded-sm px-2.5 py-0.5 text-[0.58rem] font-extrabold uppercase tracking-[0.14em]',
  sectionLabelTech: 'border border-violet-400/25 bg-violet-400/10 text-violet-300',
  sectionLabelFund: 'border border-sky-300/25 bg-sky-300/10 text-sky-300',
  sectionRule: 'h-px flex-1 bg-border opacity-60',
  card: 'rounded-[10px] border border-border bg-card px-4 py-3 shadow-sm',
  cardCompact: 'rounded-[10px] border border-border bg-card px-3 py-2 shadow-sm',
  cardHead: 'mb-3 flex flex-wrap items-center justify-between gap-3',
  cardHeadTight: 'mb-2 flex flex-wrap items-center justify-between gap-3',
  cardTitle:
    'm-0 inline-flex items-center gap-2 text-[0.68rem] font-bold uppercase tracking-[0.08em] text-muted-foreground',
  cardTitleAux: 'font-mono text-[0.65rem] font-medium normal-case tracking-normal text-muted-foreground',
  techLayout:
    'mt-1.5 grid grid-cols-1 items-stretch gap-1.5 sm:grid-cols-2 xl:grid-cols-4 [&_.card-head-tight]:mb-1',
  techCellStacked: 'flex flex-col gap-1 [&>.card-compact]:flex-1',
  fundLayout: 'mt-1.5 grid grid-cols-1 items-stretch gap-1.5 lg:grid-cols-[3fr_9fr]',
  fundRightGrid:
    'grid min-w-0 grid-cols-1 gap-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 [&_.card-head-tight]:mb-1',
  fundCellSepa: 'row-span-2 lg:row-span-2',
  fundCellStacked: 'flex flex-col gap-1',
  distBody: 'flex min-h-0 flex-1 flex-col gap-2',
  distActiveHint:
    'mb-1 border-l-2 border-primary bg-sky-300/[0.06] py-1 pl-2 text-[0.7rem] text-muted-foreground rounded-r',
  distActiveHintTech: 'border-l-violet-400 bg-violet-400/[0.08]',
  distActiveBadge:
    'inline-block rounded-sm bg-primary px-1.5 py-px font-mono text-[0.65rem] font-bold text-primary-foreground',
  distActiveBadgeTech: 'bg-violet-400 text-[#0a0c0f]',
  distRows: 'flex flex-col gap-0.5',
  emptyLine: 'text-[0.72rem] text-muted-foreground',
  statusErr: 'text-destructive',
  condGroups: 'flex flex-col gap-[7px]',
  condGroup: 'flex flex-col gap-[3px]',
  condGroupHeader:
    'flex items-center gap-1 border-b border-border pb-1 text-[0.64rem] font-extrabold uppercase tracking-[0.07em] text-muted-foreground',
  condChipsRow: 'flex flex-wrap gap-[3px]',
  condChip:
    'inline-flex cursor-pointer items-center gap-1.5 rounded-[5px] border border-border bg-muted/40 px-2 py-1 text-left font-sans text-[0.72rem] leading-tight text-muted-foreground transition-colors hover:border-border hover:text-foreground',
  condChipActive:
    'border-primary bg-primary/10 font-semibold text-foreground [&_.chip-check]:border-primary [&_.chip-check]:bg-primary [&_.chip-check]:text-primary-foreground',
  condChipCheck:
    'chip-check inline-flex h-[0.85rem] w-[0.85rem] shrink-0 items-center justify-center rounded-[3px] border border-border bg-transparent text-[0.6rem] font-bold text-transparent',
  condChipLabel: 'min-w-0 flex-1 truncate tabular-nums',
  filterTabBadge:
    'inline-flex h-[1.1rem] min-w-[1.1rem] items-center justify-center rounded-full bg-primary px-[3px] text-[0.58rem] font-bold leading-none text-primary-foreground',
  filterTabBadgeTech: 'bg-violet-400/90 text-[#0a0c0f]',
  tierScoreRow: 'mb-1.5 flex items-center gap-1.5 py-[3px]',
  tierScoreLabel: 'text-[0.68rem] font-semibold text-muted-foreground',
  tierScoreInline: 'flex min-w-0 flex-1 items-center gap-1.5',
  tierScoreSlider: 'h-1.5 min-w-0 flex-1 cursor-pointer accent-primary',
  tierScoreVal: 'font-mono text-[0.72rem] tabular-nums text-muted-foreground',
  filterBar:
    'flex flex-wrap items-center gap-3 rounded-lg border border-primary/20 bg-primary/[0.06] px-3.5 py-2',
  filterBarInfo: 'flex flex-1 flex-wrap items-center gap-2',
  filterBarTag: 'rounded-xl px-2.5 py-0.5 text-[0.72rem] font-semibold tracking-wide',
  filterBarTagFund: 'border border-sky-400/30 bg-sky-400/10 text-sky-300',
  filterBarTagTech: 'border border-violet-500/30 bg-violet-500/10 text-violet-400',
  filterBarAnd: 'text-[0.75rem] font-medium text-muted-foreground',
  filterBarStatus: 'ml-1 text-[0.72rem] text-muted-foreground',
  filterBarStatusLoading: 'italic text-primary',
  filterBarPreview: 'inline-flex items-center gap-0.5 text-[0.72rem]',
  filterBarCount: 'text-[0.85rem] text-primary',
  filterBarArrow: 'text-[0.68rem] italic text-muted-foreground/70',
  symbolsStrip:
    'grid grid-cols-1 items-start gap-2 rounded-lg border border-border bg-card/50 p-3 md:grid-cols-[auto_1fr_auto]',
  symbolsStripLabel: 'flex flex-col gap-0.5',
  symbolsStripTitle: 'text-[0.68rem] font-bold uppercase tracking-[0.08em] text-muted-foreground',
  symbolsStripAux: 'font-mono text-[0.65rem] text-muted-foreground',
  symbolsStripLoading: 'animate-pulse',
  symbolsStripInput: 'min-w-0',
  symbolsTextarea:
    'w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring',
  symbolsStripMeta: 'flex flex-wrap items-center gap-2 text-[0.72rem]',
  symbolsStripCount: 'tabular-nums',
  symbolsStripSep: 'h-3 w-px bg-border',
  tableWrap: 'overflow-x-auto',
  table: 'w-full',
  tableEmpty: 'text-muted-foreground',
  rowMissing: 'opacity-70',
  rowActive: 'bg-primary/5',
  condCol: 'flex flex-col gap-1',
  condDots: 'inline-flex flex-wrap items-center gap-[3px]',
  condDot:
    'inline-flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border border-transparent font-mono text-[0.55rem] font-bold',
  condDotFail: 'border-border bg-muted/30 text-muted-foreground/70',
  condDotDim: 'opacity-45',
  dataPair: 'inline-flex items-center gap-1.5 text-[0.65rem]',
  numDim: 'text-muted-foreground/80',
  num: 'font-mono tabular-nums',
  stmtRow: 'inline-flex flex-wrap gap-1',
  stmtChip:
    'inline-flex rounded px-1.5 py-px font-mono text-[0.58rem] font-bold uppercase tracking-wide text-muted-foreground/60 ring-1 ring-border/60',
  stmtChipOk: 'text-emerald-400 ring-emerald-500/40',
  resultsSummaryGood: 'text-emerald-400',
  resultsSummaryTech: 'text-violet-400',
  resultsSummaryWarn: 'text-amber-400',
  symOpenHint: 'text-[0.55rem] text-muted-foreground',
  pill: 'inline-flex items-center rounded-[3px] px-1.5 py-px font-mono text-[0.62rem] font-bold tracking-wide',
  pillPass: 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  pillFail: 'border border-red-400/25 bg-red-400/10 text-red-400',
  pillNa: 'border border-border bg-muted/30 text-muted-foreground',
  pillSm: 'min-w-[14px] justify-center px-[5px] py-0 text-[0.6rem]',
  fundCell:
    'inline-flex min-w-8 items-center justify-center rounded-[3px] px-1.5 py-px font-mono text-[0.7rem] font-bold tracking-wide',
} as const

const TIER_BORDER: Record<string, string> = {
  momentum: 'border-l-[3px] border-l-amber-500/55',
  structure: 'border-l-[3px] border-l-emerald-400/55',
  sentiment: 'border-l-[3px] border-l-pink-400/55',
}

const TIER_TITLE: Record<string, string> = {
  momentum: 'text-amber-500',
  structure: 'text-emerald-400',
  sentiment: 'text-pink-400',
}

const GROUP_BORDER: Record<string, string> = {
  quality: 'border-l-[3px] border-l-sky-300/55',
  balance: 'border-l-[3px] border-l-lime-500/55',
  cashflow: 'border-l-[3px] border-l-emerald-400/55',
  valuation: 'border-l-[3px] border-l-amber-400/55',
  profitability: 'border-l-[3px] border-l-violet-400/55',
  efficiency: 'border-l-[3px] border-l-orange-500/55',
  sentiment: 'border-l-[3px] border-l-pink-400/55',
}

const GROUP_TITLE: Record<string, string> = {
  quality: 'text-sky-300',
  balance: 'text-lime-500',
  cashflow: 'text-emerald-400',
  valuation: 'text-amber-400',
  profitability: 'text-violet-400',
  efficiency: 'text-orange-400',
  sentiment: 'text-pink-400',
}

const TECH_GROUP_HEADER: Record<string, string> = {
  vol: 'text-violet-400 border-b-violet-400/35',
  price52: 'text-emerald-400 border-b-emerald-400/35',
  sma: 'text-sky-400 border-b-sky-400/35',
  price: 'text-amber-400 border-b-amber-400/35',
}

const FUND_GROUP_HEADER: Record<string, string> = {
  eps: 'text-sky-300 border-b-sky-300/35',
  rev: 'text-lime-500 border-b-lime-500/35',
}

const CHIP_BORDER: Record<string, string> = {
  eps: 'border-l-2 border-l-sky-300/55',
  rev: 'border-l-2 border-l-lime-500/55',
  'tech-vol': 'border-l-2 border-l-violet-400/60',
  'tech-price52': 'border-l-2 border-l-emerald-400/60',
  'tech-sma': 'border-l-2 border-l-sky-400/60',
  'tech-price': 'border-l-2 border-l-amber-400/60',
  'tier-momentum': 'border-l-2 border-l-amber-500/60',
  'tier-structure': 'border-l-2 border-l-emerald-400/60',
  'tier-sentiment': 'border-l-2 border-l-pink-400/60',
  'ext-quality': 'border-l-2 border-l-sky-300/50',
  'ext-balance': 'border-l-2 border-l-lime-500/50',
  'ext-cashflow': 'border-l-2 border-l-emerald-400/50',
  'ext-valuation': 'border-l-2 border-l-amber-400/50',
  'ext-profitability': 'border-l-2 border-l-violet-400/50',
  'ext-efficiency': 'border-l-2 border-l-orange-500/50',
  'ext-sentiment': 'border-l-2 border-l-pink-400/50',
}

const DOT_PASS: Record<string, string> = {
  eps: 'bg-sky-300/20 text-sky-300 border-sky-300/45',
  rev: 'bg-lime-500/15 text-lime-500 border-lime-500/40',
  'tech-vol': 'bg-violet-400/20 text-violet-400 border-violet-400/45',
  'tech-price52': 'bg-emerald-400/15 text-emerald-400 border-emerald-400/40',
  'tech-sma': 'bg-sky-400/15 text-sky-400 border-sky-400/40',
  'tech-price': 'bg-amber-400/15 text-amber-400 border-amber-400/40',
}

const FILTER_BAR_TIER: Record<string, string> = {
  momentum: 'border border-amber-500/30 bg-amber-500/10 text-amber-400',
  structure: 'border border-emerald-500/30 bg-emerald-500/10 text-emerald-400',
  sentiment: 'border border-pink-500/30 bg-pink-500/10 text-pink-400',
}

const FUNNEL_BAR: Record<string, string> = {
  ok: 'bg-emerald-500',
  good: 'bg-lime-500',
  warn: 'bg-amber-500',
  poor: 'bg-orange-500',
  error: 'bg-muted-foreground/50',
  'tech-ok': 'bg-violet-400',
  'tech-good': 'bg-violet-700',
  'tech-warn': 'bg-indigo-500',
  'tech-poor': 'bg-indigo-400/70',
  'tech-error': 'bg-gray-500/50',
}

export function tierCardClass(tier: string) {
  return cn(SSP.cardCompact, TIER_BORDER[tier])
}

export function tierTitleClass(tier: string) {
  return cn(SSP.cardTitle, TIER_TITLE[tier])
}

export function groupCardClass(group: string) {
  return cn(SSP.cardCompact, GROUP_BORDER[group])
}

export function groupTitleClass(group: string) {
  return cn(SSP.cardTitle, GROUP_TITLE[group])
}

export function techGroupHeaderClass(group: string) {
  return cn(SSP.condGroupHeader, TECH_GROUP_HEADER[group])
}

export function fundGroupHeaderClass(group: string) {
  return cn(SSP.condGroupHeader, FUND_GROUP_HEADER[group])
}

export function condChipClass(variant: string, active: boolean) {
  return cn(SSP.condChip, CHIP_BORDER[variant], active && SSP.condChipActive)
}

export function condDotClass(group: string, pass: boolean, dim?: boolean) {
  const key = group.startsWith('tech-') ? group : group
  return cn(
    SSP.condDot,
    pass ? cn('border', DOT_PASS[key] ?? DOT_PASS[`tech-${group}`]) : SSP.condDotFail,
    dim && SSP.condDotDim,
  )
}

export function fundCellClass(level: 'all' | 'good' | 'warn' | 'poor' | 'insuf') {
  const tones: Record<string, string> = {
    all: 'border border-emerald-500/40 bg-emerald-500/15 text-emerald-400',
    good: 'border border-lime-500/30 bg-lime-500/10 text-lime-500',
    warn: 'border border-amber-500/30 bg-amber-500/10 text-amber-400',
    poor: 'border border-orange-500/25 bg-orange-500/10 text-orange-400',
    insuf: 'border border-dashed border-border bg-muted/20 italic text-muted-foreground',
  }
  return cn(SSP.fundCell, tones[level])
}

export function fundBarColor(n: number) {
  if (n === 8) return FUNNEL_BAR.ok
  if (n >= 6) return FUNNEL_BAR.good
  if (n >= 4) return FUNNEL_BAR.warn
  if (n >= 2) return FUNNEL_BAR.poor
  return FUNNEL_BAR.error
}

export function techBarColor(n: number) {
  if (n === 11) return FUNNEL_BAR['tech-ok']
  if (n >= 9) return FUNNEL_BAR['tech-good']
  if (n >= 7) return FUNNEL_BAR['tech-warn']
  if (n >= 4) return FUNNEL_BAR['tech-poor']
  return FUNNEL_BAR['tech-error']
}

export function tierScoreValClass(tier: string, minScore: number) {
  return cn(SSP.tierScoreVal, minScore > 0 && TIER_TITLE[tier])
}

export function filterBarTierTag(tier: string) {
  return cn(SSP.filterBarTag, FILTER_BAR_TIER[tier])
}

export function funnelRowClass(clickable: boolean, active: boolean) {
  return cn(
    'grid grid-cols-[3.6rem_minmax(0,1fr)_5.4rem] items-center gap-2 rounded-[5px] px-2 py-[3px] text-[0.74rem] transition-colors',
    clickable && 'cursor-pointer hover:bg-sky-300/[0.06]',
    active && 'bg-sky-300/[0.08]',
  )
}

export function funnelLabelClass(full: boolean, tech?: boolean) {
  return cn(
    'whitespace-nowrap text-right font-mono text-[0.72rem] tabular-nums text-muted-foreground',
    full && (tech ? 'font-bold text-violet-400' : 'font-bold text-emerald-400'),
  )
}

export function funnelBarFillClass(colorKey: string) {
  return cn('h-full rounded-[3px] transition-[width] duration-300', colorKey)
}

export function stmtChipClass(ok: boolean) {
  return cn(SSP.stmtChip, ok && SSP.stmtChipOk)
}

export function boolPillClass(v: boolean | undefined | null, sm = true) {
  if (v === undefined || v === null) return cn(SSP.pill, SSP.pillNa)
  return cn(SSP.pill, sm && SSP.pillSm, v ? SSP.pillPass : SSP.pillFail)
}
