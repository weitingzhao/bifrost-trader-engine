#!/usr/bin/env node
/**
 * Generate optionDiscoveryClasses.ts from app-surfaces.css + TSX token scan.
 * Run: node scripts/generate-option-discovery-classes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')
const cssPath = path.join(srcRoot, 'styles/app-surfaces.css')
const outPath = path.join(srcRoot, 'views/optionDiscovery/optionDiscoveryClasses.ts')

const PREFIXES = [/^(od)-/, /^(option-discovery)-/, /^(strike-ladder)-/, /^(mp)-/]
const GREEKS_PREFIXES = [/^(option-greeks-page)/, /^(greeks-table)/, /^(greeks-calc-tooltip)/]

function walkTsx(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walkTsx(full, acc)
    } else if (/\.tsx$/.test(name)) acc.push(full)
  }
  return acc
}

function collectTokensFromTsx() {
  const tokens = new Set()
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g
  const targets = walkTsx(srcRoot).filter((f) => {
    const rel = path.relative(srcRoot, f)
    return (
      rel.includes('optionDiscovery') ||
      rel === 'views/OptionDiscoveryPage.tsx' ||
      rel === 'views/OptionGreeksPage.tsx' ||
      rel === 'views/OptionScreenerPage.tsx'
    )
  })
  for (const f of targets) {
    const text = fs.readFileSync(f, 'utf8')
    let m
    while ((m = re.exec(text)) !== null) {
      const cls = m[1] ?? m[2] ?? m[3] ?? ''
      for (const t of cls.split(/\s+/)) {
        const tok = t.replace(/\$\{[^}]*\}/g, '').trim()
        if (!tok) continue
        if (
          tok.startsWith('od-') ||
          tok.startsWith('option-discovery-') ||
          tok.startsWith('strike-ladder') ||
          tok.startsWith('mp-') ||
          tok.startsWith('option-greeks-') ||
          tok.startsWith('greeks-')
        ) {
          tokens.add(tok.split('--')[0])
          tokens.add(tok)
        }
      }
    }
  }
  return tokens
}

function toCamel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function classToKey(className) {
  let body = className.replace(/__/g, '-').replace(/\./g, '-')
  let modifier = ''
  if (body.includes('--')) {
    ;[body, modifier] = body.split('--')
  }

  let prefix = ''
  if (body.startsWith('od-')) {
    body = body.slice(3)
  } else if (body.startsWith('option-discovery-')) {
    prefix = 'optionDiscovery'
    body = body.slice('option-discovery-'.length)
  } else if (body.startsWith('strike-ladder-')) {
    prefix = 'strikeLadder'
    body = body.slice('strike-ladder-'.length)
  } else if (body === 'strike-ladder') {
    body = ''
    prefix = 'strikeLadder'
  } else if (body.startsWith('mp-')) {
    prefix = 'mp'
    body = body.slice(3)
  } else if (body.startsWith('option-greeks-page__')) {
    prefix = 'optionGreeks'
    body = body.slice('option-greeks-page__'.length)
  } else if (body === 'option-greeks-page') {
    return 'optionGreeksPage' + (modifier ? toCamel(modifier).replace(/^./, (c) => c.toUpperCase()) : '')
  } else if (body.startsWith('greeks-table__')) {
    prefix = 'greeksTable'
    body = body.slice('greeks-table__'.length)
  } else if (body.startsWith('greeks-calc-tooltip__')) {
    prefix = 'greeksCalcTooltip'
    body = body.slice('greeks-calc-tooltip__'.length)
  } else if (body.startsWith('greeks-calc-tooltip')) {
    prefix = 'greeksCalcTooltip'
    body = body.replace(/^greeks-calc-tooltip-?/, '')
  } else if (body.startsWith('greeks-table')) {
    prefix = 'greeksTable'
    body = body.replace(/^greeks-table-?/, '')
  }

  let key = toCamel(body)
  if (prefix) {
    key = prefix + (key ? key.charAt(0).toUpperCase() + key.slice(1) : '')
  }
  if (modifier) {
    key += toCamel(modifier).replace(/^./, (c) => c.toUpperCase())
  }
  if (/^\d/.test(key)) key = 'n' + key
  return key
}

function parseCssRules(css) {
  const rules = new Map()
  const re = /([^{]+)\{([^}]*)\}/g
  let m
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim()
    const body = m[2].trim()
    if (!selector.startsWith('.') && !selector.startsWith('#od-layer')) continue
    if (selector.includes(',') && !selector.startsWith('#od-layer')) {
      for (const part of selector.split(',')) {
        const sel = part.trim()
        if (sel.startsWith('.')) mergeRule(rules, sel, body)
      }
      continue
    }
    mergeRule(rules, selector, body)
  }
  return rules
}

function mergeRule(rules, selector, body) {
  const simple = selector.match(/^\.([a-zA-Z0-9_-]+)$/)
  if (simple) {
    const cls = simple[1]
    const prev = rules.get(cls) ?? ''
    rules.set(cls, prev ? `${prev} ${body}` : body)
    return
  }
  const mod = selector.match(/^\.([a-zA-Z0-9_-]+)--([a-zA-Z0-9_-]+)$/)
  if (mod) {
    rules.set(`${mod[1]}--${mod[2]}`, body)
  }
}

const TW_MAP = {
  display: { flex: 'flex', grid: 'grid', block: 'block', 'inline-flex': 'inline-flex', none: 'hidden' },
  'flex-direction': { column: 'flex-col', row: 'flex-row' },
  'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
  'align-items': {
    center: 'items-center',
    'flex-start': 'items-start',
    'flex-end': 'items-end',
    baseline: 'items-baseline',
    stretch: 'items-stretch',
  },
  'justify-content': {
    center: 'justify-center',
    'space-between': 'justify-between',
    'flex-end': 'justify-end',
    'flex-start': 'justify-start',
  },
  'flex-shrink': { 0: 'shrink-0', 1: 'shrink' },
  'min-width': { 0: 'min-w-0' },
  width: { '100%': 'w-full' },
  'font-weight': { 600: 'font-semibold', 700: 'font-bold', 500: 'font-medium', 800: 'font-extrabold' },
  'text-align': { center: 'text-center', right: 'text-right', left: 'text-left' },
  'white-space': { nowrap: 'whitespace-nowrap' },
  'font-variant-numeric': { 'tabular-nums': 'tabular-nums' },
  'list-style': { none: 'list-none' },
  cursor: { pointer: 'cursor-pointer', help: 'cursor-help', 'not-allowed': 'cursor-not-allowed' },
  'user-select': { none: 'select-none' },
  overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto' },
  'overflow-x': { auto: 'overflow-x-auto', hidden: 'overflow-x-hidden' },
  'overflow-y': { auto: 'overflow-y-auto', hidden: 'overflow-y-hidden' },
  'border-collapse': { collapse: 'border-collapse', separate: 'border-separate' },
}

function cssDeclToTw(prop, value) {
  const v = value.replace(/\s+/g, ' ').trim().replace(/;$/, '')
  if (TW_MAP[prop]?.[v]) return TW_MAP[prop][v]
  if (prop === 'gap' && v.startsWith('var(--space-')) return `gap-[${v}]`
  if (prop === 'margin' && v === '0') return 'm-0'
  if (prop === 'padding' && v === '0') return 'p-0'
  if (prop === 'width' && v === '100%') return 'w-full'
  if (prop === 'min-width' && v === '0') return 'min-w-0'
  if (prop === 'flex' && v === '1') return 'flex-1'
  if (prop === 'position' && v === 'relative') return 'relative'
  if (prop === 'position' && v === 'fixed') return 'fixed'
  if (prop === 'position' && v === 'sticky') return 'sticky'
  if (prop === 'position' && v === 'absolute') return 'absolute'
  if (prop === 'inset' && v === '0') return 'inset-0'
  if (prop === 'border-radius' && v === '999px') return 'rounded-full'
  if (prop === 'border-radius' && v === '8px') return 'rounded-lg'
  if (prop === 'border-radius' && v === '10px') return 'rounded-[10px]'
  if (prop === 'border-radius' && v === '6px') return 'rounded-md'
  if (prop === 'border-radius' && v === '4px') return 'rounded'
  if (prop === 'font-size' && v.includes('text-caption')) return 'text-[length:var(--text-caption)]'
  if (prop === 'font-size' && v.includes('text-body')) return 'text-[length:var(--text-body)]'
  if (prop === 'font-size' && v.includes('text-sm')) return 'text-sm'
  if (prop === 'font-size' && v.includes('text-tiny')) return 'text-[length:var(--text-tiny)]'
  if (prop === 'color' && v.includes('text-muted')) return 'text-muted-foreground'
  if (prop === 'color' && v.includes('text-main')) return 'text-foreground'
  if (prop === 'color' && v.includes('text-dim')) return 'text-muted-foreground/80'
  if (prop === 'color' && v.includes('accent')) return 'text-primary'
  if (prop === 'background' && v.includes('surface-elevated')) return 'bg-muted/30'
  if (prop === 'background' && v.includes('surface')) return 'bg-card'
  if (prop === 'background' && v.includes('color-bg')) return 'bg-background'
  if (prop === 'border' && v.includes('1px solid var(--color-border)')) return 'border border-border'
  const safe = v.replace(/\s+/g, '_')
  return `[${prop}:${safe.replace(/_/g, ' ')}]`
}

function cssBlockToTailwind(block) {
  if (!block) return ''
  const parts = []
  for (const decl of block.split(';')) {
    const trimmed = decl.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx < 0) continue
    const prop = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (prop.startsWith('transition') || prop === 'content' || prop === 'animation') continue
    const tw = cssDeclToTw(prop, value)
    if (tw) parts.push(tw)
  }
  return [...new Set(parts)].join(' ')
}

function odRef(className) {
  return `od.${classToKey(className)}`
}

const css = fs.readFileSync(cssPath, 'utf8')
const rules = parseCssRules(css)
const tsxTokens = collectTokensFromTsx()

const allClasses = new Set()
for (const t of tsxTokens) {
  allClasses.add(t)
  if (t.includes('--')) allClasses.add(t.split('--')[0])
}

for (const cls of rules.keys()) {
  if (
    cls.startsWith('od-') ||
    cls.startsWith('option-discovery-') ||
    cls.startsWith('strike-ladder') ||
    cls.startsWith('mp-')
  ) {
    allClasses.add(cls)
  }
}

const entries = []
for (const cls of [...allClasses].sort()) {
  if (cls.includes(' ')) continue
  const key = classToKey(cls)
  if (!key || entries.some((e) => e.key === key)) continue
  const tw = cssBlockToTailwind(rules.get(cls) ?? rules.get(cls.split('--')[0] ?? ''))
  entries.push({ cls, key, tw: tw || 'min-w-0' })
}

const lines = []
lines.push("import { cn } from '@/lib/utils'")
lines.push('')
lines.push('/** Option Discovery — Tailwind replacements for od-* / option-discovery-* (Phase 7 Wave 7) */')
lines.push('export const od = {')
for (const { key, tw } of entries) {
  lines.push(`  ${key}: '${tw.replace(/'/g, "\\'")}',`)
}
lines.push('} as const')
lines.push('')

const helpers = `
export function odDataStateClass(status: string) {
  const tone: Record<string, string> = {
    loading: 'border-primary/30 bg-primary/5',
    empty: 'border-dashed',
    error: 'border-destructive/40 bg-destructive/5 text-destructive',
    idle: '',
  }
  return cn(od.dataState, tone[status])
}

export function odLayerSectionClass(enabled: boolean) {
  return cn(od.layerSection, !enabled && od.layerSectionLocked)
}

export function odChainExpiryChipClass(active: boolean) {
  return cn(
    od.chainExpiryChip,
    'inline-flex flex-row items-center justify-center gap-[0.35rem] rounded-full border border-border/80 bg-card px-[0.55rem] py-[0.2rem] font-[inherit] leading-[1.2] transition-colors hover:border-primary/35 hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-55',
    active && od.chainExpiryChipActive,
  )
}

export function odUnderlyingChipClass(active: boolean) {
  return cn(
    od.underlyingChip,
    'inline-flex flex-row items-center justify-center gap-1 rounded-full border border-border/80 bg-muted/40 px-[0.6rem] py-[0.22rem] font-[inherit] leading-[1.15] transition-colors hover:border-primary/35 hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
    active && od.underlyingChipActive,
  )
}

export function odGreeksSourceBtnClass(active: boolean) {
  return cn(
    od.greeksSourceBtn,
    'border-0 bg-transparent px-[0.45rem] py-[0.1rem] text-[0.62rem] font-semibold uppercase tracking-wide text-muted-foreground/80 transition-colors hover:bg-border hover:text-muted-foreground',
    active && od.greeksSourceBtnActive,
  )
}

export function odMoneynessBadgeClass(label: string) {
  const map: Record<string, string> = {
    itm: od.moneynessBadgeItm,
    atm: od.moneynessBadgeAtm,
    otm: od.moneynessBadgeOtm,
  }
  return cn(od.moneynessBadge, map[label.toLowerCase()])
}

export function odSnapshotFeedbackClass(level: 'error' | 'warning' | 'info') {
  const map = { error: od.snapshotFeedbackError, warning: od.snapshotFeedbackWarning, info: od.snapshotFeedbackInfo }
  return cn(od.snapshotFeedback, map[level])
}

export function odChainRowClass(opts: { atm?: boolean; itm?: boolean; selected?: boolean; highlight?: boolean }) {
  return cn(
    od.chainRow,
    od.quoteRow,
    'cursor-pointer transition-colors hover:bg-muted/40',
    opts.atm && od.chainRowAtm,
    !opts.atm && opts.itm && od.chainRowItm,
    !opts.atm && !opts.itm && od.chainRowOtm,
    opts.highlight && od.quoteRowSelected,
  )
}

export function odChainTdClass(selected: boolean) {
  return cn(od.chainTd, od.chainTdData, 'cursor-pointer', selected && od.chainTdSelected)
}

export function odChainStrikeCellClass(selected: boolean) {
  return cn(od.chainStrikeCell, selected && od.chainStrikeCellSelected)
}

export function odAnalyticsSkewValClass(sign: string) {
  const map: Record<string, string> = {
    'put-heavy': od.analyticsSkewValPutHeavy,
    'call-heavy': od.analyticsSkewValCallHeavy,
    neutral: od.analyticsSkewValNeutral,
  }
  return cn(od.analyticsSkewVal, map[sign] ?? od.analyticsSkewValNeutral)
}

export function odIvTermExpItemClass(checked: boolean) {
  return cn(
    od.ivTermExpItem,
    'flex cursor-pointer items-center gap-[0.45rem] rounded-lg border border-border/65 bg-muted/30 p-[0.38rem_0.45rem] transition-colors hover:border-primary/30 hover:bg-primary/10 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50',
    checked && od.ivTermExpItemChecked,
  )
}

export function odIvSheetHoverClass(warn: boolean) {
  return cn(od.ivSheetHover, warn && od.ivSheetHoverWarn)
}

export function odStrikeLadderTwoColsClass(singleSide: boolean) {
  return cn(od.strikeLadderTwoCols, singleSide && od.strikeLadderTwoColsSingleSide)
}

export function odIvTermConeChartsRowClass(triple: boolean) {
  return cn(od.ivTermConeChartsRow, triple && od.ivTermConeChartsRowTriple)
}

export function odExpFilterBtnClass(active: boolean) {
  return cn(
    od.optionDiscoveryExpFilterBtn,
    'w-full cursor-pointer rounded-md border border-border bg-card px-1 py-[0.16rem] text-[0.62rem] leading-none text-muted-foreground/80 hover:border-border hover:text-foreground',
    active && 'border-primary bg-primary/10 text-primary',
  )
}

export function odExpirationKindBadge(kind: 'weeklies' | 'quarterlies') {
  return cn(
    od.optionDiscoveryExpirationKindBadge,
    kind === 'weeklies' ? od.optionDiscoveryExpirationKindBadgeWeeklies : od.optionDiscoveryExpirationKindBadgeQuarterlies,
    od.ivTermExpKindBubble,
  )
}

export function odBsDiffClass(kind: 'ok' | 'warn' | 'alert') {
  const map = { ok: od.bsDiffOk, warn: od.bsDiffWarn, alert: od.bsDiffAlert }
  return cn(od.bsDiff, map[kind])
}

export function greeksIvClass(iv: number | null) {
  if (iv == null) return ''
  if (iv < 0.3) return od.greeksTableIvLow
  if (iv < 0.8) return od.greeksTableIvMid
  return od.greeksTableIvHigh
}

export function greeksDeltaClass(delta: number | null) {
  if (delta == null) return ''
  const abs = Math.abs(delta)
  if (abs >= 0.4 && abs <= 0.6) return od.greeksTableDeltaAtm
  return ''
}

export function odChartSvgClass() {
  return cn(od.maxPainSvg, od.chartSvg, 'block h-auto w-full max-w-full')
}

export function odIconBtnNeutral(extra?: string) {
  return cn(extra, '[&.section-header-icon-btn:hover]:transform-none [&.section-header-icon-btn:active]:transform-none')
}
`

lines.push(helpers.trim())
lines.push('')

fs.writeFileSync(outPath, lines.join('\n'))
console.log(`Wrote ${outPath} (${entries.length} od tokens)`)
