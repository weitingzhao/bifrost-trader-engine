#!/usr/bin/env node
/**
 * Generate dataOverviewClasses.ts + refJobsClasses.ts from legacy.css (Wave 6).
 * Usage: node scripts/generate-wave6-classes.mjs [/path/to/legacy.css]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')
const legacyPath =
  process.argv[2] ??
  (() => {
    try {
      const tmp = '/tmp/legacy.css'
      execSync(
        'git show bf9ce41^:frontend/src/styles/legacy.css > /tmp/legacy.css',
        { cwd: path.join(frontendRoot, '..'), stdio: 'pipe' },
      )
      return tmp
    } catch {
      throw new Error('Provide legacy.css path')
    }
  })()

const settingsCeleryCss = (() => {
  try {
    return execSync('git show HEAD:frontend/src/styles/settings-celery.css', {
      cwd: path.join(frontendRoot, '..'),
      encoding: 'utf8',
    })
  } catch {
    return ''
  }
})()

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

function collectUsedClasses(prefix) {
  const used = new Set()
  const re = new RegExp(`${prefix.replace(/-/g, '\\-')}[a-z0-9_-]+`, 'g')
  for (const f of walkTsx(srcRoot)) {
    const text = fs.readFileSync(f, 'utf8')
    for (const m of text.matchAll(re)) used.add(m[0])
  }
  return used
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
    if (prop === 'outline') return `[outline:${v}]`
    if (prop === 'outline-offset') return `[outline-offset:${v}]`
    if (prop === 'width') return `w-[${v}]`
    if (prop === 'min-width') return `min-w-[${v}]`
    if (prop === 'max-width') return `max-w-[${v}]`
    if (prop === 'height') return `h-[${v}]`
    if (prop === 'max-height') return `max-h-[${v}]`
    if (prop === 'min-height') return `min-h-[${v}]`
    if (prop === 'top') return `top-[${v}]`
    if (prop === 'left') return `left-[${v}]`
    if (prop === 'z-index') return `z-[${v}]`
    if (prop === 'opacity') return `opacity-[${v}]`
    if (prop === 'letter-spacing') return `tracking-[${v}]`
    if (prop === 'font-weight') return `font-[${v}]`
    return `[${prop}:${v}]`
  }

  const map = {
    display: {
      flex: 'flex',
      'inline-flex': 'inline-flex',
      grid: 'grid',
      block: 'block',
      none: 'hidden',
    },
    'flex-direction': { column: 'flex-col', row: 'flex-row' },
    'flex-wrap': { wrap: 'flex-wrap', nowrap: 'flex-nowrap' },
    'align-items': {
      center: 'items-center',
      'flex-start': 'items-start',
      baseline: 'items-baseline',
      stretch: 'items-stretch',
    },
    'justify-content': {
      'space-between': 'justify-between',
      center: 'justify-center',
      'flex-end': 'justify-end',
    },
    'text-align': { left: 'text-left', right: 'text-right', center: 'text-center' },
    'font-weight': {
      '500': 'font-medium',
      '600': 'font-semibold',
      '700': 'font-bold',
    },
    'text-transform': {
      uppercase: 'uppercase',
      lowercase: 'lowercase',
      none: 'normal-case',
    },
    'white-space': { nowrap: 'whitespace-nowrap', normal: 'whitespace-normal' },
    'word-break': { 'break-all': 'break-all', 'break-word': 'break-words' },
    overflow: { hidden: 'overflow-hidden', auto: 'overflow-auto' },
    'overflow-x': { hidden: 'overflow-x-hidden', auto: 'overflow-x-auto' },
    'overflow-y': { auto: 'overflow-y-auto', hidden: 'overflow-y-hidden' },
    position: { fixed: 'fixed', sticky: 'sticky', relative: 'relative', absolute: 'absolute' },
    inset: { '0': 'inset-0' },
    cursor: { pointer: 'cursor-pointer', 'not-allowed': 'cursor-not-allowed', wait: 'cursor-wait' },
    'list-style': { none: 'list-none' },
    'border-collapse': { collapse: 'border-collapse' },
    'vertical-align': { middle: 'align-middle', top: 'align-top' },
    'font-variant-numeric': { 'tabular-nums': 'tabular-nums' },
    'box-sizing': { 'border-box': 'box-border' },
    appearance: { none: 'appearance-none' },
    'flex-shrink': { '0': 'shrink-0', '1': 'shrink' },
    'flex-grow': { '1': 'grow' },
    'text-decoration': {
      underline: 'underline',
      none: 'no-underline',
    },
    'user-select': { none: 'select-none' },
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

function classToKey(className, prefix) {
  let rest = className
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length)
  rest = rest.replace(/^[-_]+/, '')
  const segments = rest.split('--').flatMap(s => s.split('__'))
  return segments
    .filter(Boolean)
    .map((seg, i) =>
      i === 0 ? seg.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()) : seg.charAt(0).toUpperCase() + seg.slice(1).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()),
    )
    .join('')
}

function mergeCompoundRules(css, className) {
  const extras = []
  const patterns = [
    new RegExp(`\\.[^\\s]+\\s+\\.${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'),
    new RegExp(`\\.${className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'),
  ]
  for (const re of patterns) {
    for (const m of css.matchAll(re)) {
      extras.push(cssBlockToTailwind(m[1]))
    }
  }
  return [...new Set(extras.filter(Boolean))].join(' ')
}

function generateExport(prefix, exportName, outPath, cssSources) {
  const rules = new Map()
  for (const css of cssSources) {
    for (const [k, v] of parseSimpleRules(css)) {
      if (k.startsWith(prefix)) rules.set(k, v)
    }
  }

  const entries = {}
  for (const className of [...rules.keys()].sort()) {
    const key = classToKey(className, prefix)
    const baseBody = rules.get(className) ?? ''
    const compound = cssSources.map(c => mergeCompoundRules(c, className)).join(' ')
    const tw = [cssBlockToTailwind(baseBody), compound].filter(Boolean).join(' ')
    entries[key] = tw || '/* migrated — no simple rule */'
  }

  const lines = Object.entries(entries)
    .map(([k, v]) => {
      const escaped = v.replace(/\s+/g, ' ').trim().replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      return `  ${k}: '${escaped}',`
    })
    .join('\n')

  const content = `import { cn } from '@/lib/utils'

/** Auto-migrated from legacy CSS — Phase 7 Wave 6 */
export const ${exportName} = {
${lines}
} as const

export function ${exportName}Cn(...parts: Array<string | false | null | undefined>) {
  return cn(...parts)
}
`
  fs.writeFileSync(outPath, content)
  console.log(`Wrote ${outPath} (${Object.keys(entries).length} keys)`)
}

const legacyCss = fs.readFileSync(legacyPath, 'utf8')
const appSurfacesCss = fs.readFileSync(path.join(srcRoot, 'styles/app-surfaces.css'), 'utf8')

generateExport(
  'data-overview-',
  'dov',
  path.join(srcRoot, 'views/dataOverview/dataOverviewClasses.ts'),
  [legacyCss, appSurfacesCss],
)

generateExport(
  'ref-jobs-',
  'rj',
  path.join(srcRoot, 'views/massive/refJobsClasses.ts'),
  [legacyCss, appSurfacesCss],
)
