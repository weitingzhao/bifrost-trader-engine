#!/usr/bin/env node
/**
 * Generate wave9Classes.ts from app-surfaces.css for selectors still used in TSX.
 * Usage: node scripts/generate-wave9-classes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')
const cssPath = path.join(srcRoot, 'styles/app-surfaces.css')

/** Classes handled by existing modules — excluded from w9 generation. */
const EXCLUDED_PREFIXES = [
  'data-overview-',
  'ref-jobs-',
  'od-',
  'option-discovery-',
  'strike-ladder-',
  'feed-massive-',
  'fm-',
  'replay-',
  'architecture-console-',
  'architecture-unified-',
  'architecture-source-bubble',
  'architecture-log-source-',
]

const EXCLUDED_EXACT = new Set([
  'data-table',
  'table-wrap',
  'table-wrapper',
  'table-pagination',
  'app-tab',
  'app-tabs',
])

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

function collectTsxClassTokens() {
  const tokens = new Set()
  const attrRe = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`|\{([^}]*)\})/g
  const strRe = /['"`]([a-zA-Z][a-zA-Z0-9_-]*(?:__[a-zA-Z0-9_-]+)?(?:--[a-zA-Z0-9_-]+)?)['"`]/g
  for (const f of walkTsx(srcRoot)) {
    const text = fs.readFileSync(f, 'utf8')
    let m
    while ((m = attrRe.exec(text)) !== null) {
      const cls = m[1] ?? m[2] ?? m[3] ?? m[4] ?? ''
      for (const t of cls.split(/\s+/)) {
        const tok = t.split(/\$\{/)[0].trim()
        if (tok && /^[a-zA-Z]/.test(tok)) tokens.add(tok)
      }
    }
    while ((m = strRe.exec(text)) !== null) {
      if (/^[a-zA-Z]/.test(m[1])) tokens.add(m[1])
    }
  }
  return tokens
}

function parseSimpleRules(css) {
  const rules = new Map()
  const blockRe = /([^{]+)\{([^}]*)\}/g
  let m
  while ((m = blockRe.exec(css)) !== null) {
    const selector = m[1].trim()
    if (selector.includes(',')) continue
    if (selector.includes('[')) continue
    if (selector.includes(':')) continue
    if (!selector.startsWith('.')) continue
    if (selector.slice(1).includes('.')) continue
    if (selector.includes(' ')) continue
    const className = selector.slice(1)
    const body = m[2].trim()
    if (!body) continue
    if (!rules.has(className)) rules.set(className, body)
  }
  return rules
}

function cssPropToTw(prop, value) {
  const v = value.trim().replace(/;$/, '')
  if (v.includes('var(--')) {
    if (prop === 'font-size') return `text-[length:${v}]`
    if (prop === 'line-height') return `leading-[${v}]`
    if (prop === 'gap') return `gap-[${v}]`
    if (prop === 'padding') return `p-[${v}]`
    if (prop === 'margin') return `m-[${v}]`
    if (prop === 'margin-top') return `mt-[${v}]`
    if (prop === 'margin-bottom') return `mb-[${v}]`
    if (prop === 'margin-left') return `ml-[${v}]`
    if (prop === 'border-radius') return `rounded-[${v}]`
    if (prop === 'color') return `text-[${v}]`
    if (prop === 'background') return `bg-[${v}]`
    if (prop === 'border-color') return `border-[${v}]`
    if (prop === 'width') return `w-[${v}]`
    if (prop === 'min-width') return `min-w-[${v}]`
    if (prop === 'max-width') return `max-w-[${v}]`
    if (prop === 'height') return `h-[${v}]`
    if (prop === 'min-height') return `min-h-[${v}]`
    if (prop === 'max-height') return `max-h-[${v}]`
    if (prop === 'top') return `top-[${v}]`
    if (prop === 'left') return `left-[${v}]`
    if (prop === 'z-index') return `z-[${v}]`
    if (prop === 'opacity') return `opacity-[${v}]`
    if (prop === 'letter-spacing') return `tracking-[${v}]`
    if (prop === 'font-weight') return `font-[${v}]`
    return `[${prop}:${v}]`
  }

  const map = {
    display: { flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', block: 'block', none: 'hidden' },
    'flex-direction': { column: 'flex-col', row: 'flex-row' },
    'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
    'align-items': { center: 'items-center', 'flex-start': 'items-start', baseline: 'items-baseline', stretch: 'items-stretch' },
    'justify-content': { 'space-between': 'justify-between', center: 'justify-center', 'flex-end': 'justify-end' },
    'text-align': { left: 'text-left', right: 'text-right', center: 'text-center' },
    'font-weight': { '500': 'font-medium', '600': 'font-semibold', '700': 'font-bold' },
    'text-transform': { uppercase: 'uppercase', lowercase: 'lowercase', none: 'normal-case' },
    'white-space': { nowrap: 'whitespace-nowrap', normal: 'whitespace-normal' },
    overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto' },
    'overflow-x': { hidden: 'overflow-x-hidden', auto: 'overflow-x-auto' },
    position: { fixed: 'fixed', sticky: 'sticky', relative: 'relative', absolute: 'absolute' },
    cursor: { pointer: 'cursor-pointer', 'not-allowed': 'cursor-not-allowed' },
    'list-style': { none: 'list-none' },
    'border-collapse': { collapse: 'border-collapse' },
    'vertical-align': { middle: 'align-middle', top: 'align-top' },
    'font-variant-numeric': { 'tabular-nums': 'tabular-nums' },
    'flex-shrink': { '0': 'shrink-0' },
    'user-select': { none: 'select-none' },
    'text-decoration': { underline: 'underline', none: 'no-underline' },
  }

  if (map[prop]?.[v]) return map[prop][v]
  if (prop === 'margin' && v === '0') return 'm-0'
  if (prop === 'padding' && v === '0') return 'p-0'
  if (prop === 'border' && v === 'none') return 'border-0'
  if (prop === 'background' && v === 'none') return 'bg-none'
  if (prop === 'width' && v === '100%') return 'w-full'
  if (prop === 'min-width' && v === '0') return 'min-w-0'
  if (prop === 'font' && v === 'inherit') return 'font-[inherit]'

  if (v.includes('color-mix') || v.includes('rgba') || v.includes('#')) {
    if (prop === 'color') return `text-[${v}]`
    if (prop === 'background') return `bg-[${v}]`
    if (prop === 'border-color') return `border-[${v}]`
    if (prop === 'box-shadow') return `shadow-[${v}]`
  }

  return `[${prop}:${v}]`
}

function cssBlockToTailwind(body) {
  const parts = []
  for (const line of body.split(';')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const idx = trimmed.indexOf(':')
    if (idx < 0) continue
    const prop = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (prop.startsWith('transition') || prop === 'animation') continue
    const tw = cssPropToTw(prop, value)
    if (tw) parts.push(tw)
  }
  return parts.join(' ')
}

function classToKey(className) {
  const parts = className.split('--').flatMap((s) => s.split('__'))
  return parts
    .filter(Boolean)
    .map((seg, i) =>
      i === 0
        ? seg.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
        : seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()),
    )
    .join('')
}

function shouldExclude(className) {
  if (EXCLUDED_EXACT.has(className)) return true
  return EXCLUDED_PREFIXES.some((p) => className.startsWith(p))
}

const css = fs.readFileSync(cssPath, 'utf8')
const rules = parseSimpleRules(css)
const tsxTokens = collectTsxClassTokens()

const usedInTsx = [...tsxTokens].filter((t) => rules.has(t) && !shouldExclude(t)).sort()
console.log(`TSX tokens matching app-surfaces: ${usedInTsx.length}`)

const entries = {}
const missing = []
for (const className of usedInTsx) {
  const key = classToKey(className)
  if (entries[key]) continue
  const tw = cssBlockToTailwind(rules.get(className) ?? '')
  if (!tw) {
    missing.push(className)
    entries[key] = '/* no simple rule */'
  } else {
    entries[key] = tw
  }
}

const lines = Object.entries(entries)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([k, v]) => {
    const escaped = v.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `  ${k}: '${escaped}',`
  })
  .join('\n')

const outPath = path.join(srcRoot, 'styles/wave9Classes.ts')
const content = `import { cn } from '@/lib/utils'

/** Auto-migrated from app-surfaces.css — Phase 7 Wave 9 (final) */
export const w9 = {
${lines}
} as const

export function w9Cn(...parts: Array<string | false | null | undefined>) {
  return cn(...parts)
}
`

fs.writeFileSync(outPath, content)
console.log(`Wrote ${outPath} (${Object.keys(entries).length} keys)`)
if (missing.length) console.log(`Missing simple rules: ${missing.length}`)
