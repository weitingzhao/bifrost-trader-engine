#!/usr/bin/env node
/**
 * Safe codemod: replace ONLY legacy BEM class strings that exist in w9 / appUi / rl.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '../src')

function keyToClass(key) {
  return key
    .replace(/([A-Z])/g, '-$1')
    .replace(/([a-z])(\d)/g, '$1-$2')
    .toLowerCase()
    .replace(/^-/, '')
}

function parseW9Keys() {
  const text = fs.readFileSync(path.join(srcRoot, 'styles/wave9Classes.ts'), 'utf8')
  const map = new Map()
  for (const m of text.matchAll(/^\s+(\w+):/gm)) {
    const key = m[1]
    map.set(keyToClass(key), `w9.${key}`)
  }
  return map
}

const CLASS_TO_EXPR = parseW9Keys()

// Manual overrides (prefer shared modules)
Object.assign(CLASS_TO_EXPR, {
  'replay-section': 'rl.section',
  'replay-page': 'rl.page',
  'replay-toolbar': 'rl.toolbar',
  'replay-bubble-switch': 'rl.bubbleSwitch',
  'replay-portfolio-tabs-wrap': 'rl.portfolioTabsWrap',
  'replay-sync-hint': 'rl.syncHint',
  'replay-placeholder': 'rl.placeholder',
  'data-table': 'dataTableClass',
  'table-wrap': 'dataTableWrapClass()',
  'table-wrapper': 'dataTableWrapClass()',
  'table-operations': 'operationsTableClass',
  'section-hint': 'sectionHintClass',
  'section-desc': 'sectionDescClass',
  'controls': 'controlsClass',
  'card-operations': 'cardOperationsClass',
  'research-page-head': 'researchPageHeadClass',
  'app-page-stack': 'appPageStackClass',
  'msg-ok': 'msgOkClass',
  'msg-error': 'msgErrorClass',
  'msg-warning': 'msgWarningClass',
  'pnl-positive': 'pnlPositiveClass',
  'pnl-negative': 'pnlNegativeClass',
  'system-tabs': 'systemTabsClass()',
  'system-tab-panel': 'systemTabPanelClass()',
})

const SKIP_FILES = new Set(['styles/wave9Classes.ts', 'components/shared/appUi.ts', 'lib/replayLayout.ts'])

function isLegacyToken(token) {
  return CLASS_TO_EXPR.has(token)
}

function tokensToExpr(tokens) {
  const legacy = tokens.filter(isLegacyToken)
  if (legacy.length === 0) return null
  const other = tokens.filter((t) => !isLegacyToken(t))
  const refs = legacy.map((t) => CLASS_TO_EXPR.get(t))
  if (tokens.includes('system-tab')) {
    const hasActive = tokens.includes('active')
    const rest = tokens.filter((t) => t !== 'system-tab' && t !== 'active' && !isLegacyToken(t))
    const base = hasActive ? 'systemTabClass(true)' : 'systemTabClass()'
    const parts = [base, ...refs.filter((r) => !r.includes('systemTab')), ...rest.map((t) => `'${t}'`)]
    return parts.length === 1 ? parts[0] : `cn(${parts.join(', ')})`
  }
  if (other.length === 0) {
    return refs.length === 1 ? refs[0] : `cn(${refs.join(', ')})`
  }
  return `cn(${[...refs, ...other.map((t) => `'${t}'`)].join(', ')})`
}

function migrateString(str) {
  const tokens = str.trim().split(/\s+/).filter(Boolean)
  if (!tokens.some(isLegacyToken) && !tokens.includes('system-tab')) return null
  return tokensToExpr(tokens)
}

function addImports(text) {
  const needs = {
    w9: /\bw9\./.test(text),
    rl: /\brl\./.test(text),
    cn: /\bcn\(/.test(text),
    appUi: /\b(dataTableClass|operationsTableClass|sectionHintClass|sectionDescClass|controlsClass|cardOperationsClass|researchPageHeadClass|appPageStackClass|msgOkClass|msgErrorClass|msgWarningClass|pnlPositiveClass|pnlNegativeClass|dataTableWrapClass)\b/.test(text),
    statusUi: /\b(systemTabClass|systemTabsClass|systemTabPanelClass)\b/.test(text),
  }
  const lines = []
  if (needs.w9 && !text.includes("from '@/styles/wave9Classes'")) lines.push("import { w9 } from '@/styles/wave9Classes'")
  if (needs.rl && !text.includes("from '@/lib/replayLayout'")) lines.push("import { rl } from '@/lib/replayLayout'")
  if (needs.cn && !text.includes("from '@/lib/utils'")) lines.push("import { cn } from '@/lib/utils'")
  if (needs.appUi && !text.includes("from '@/components/shared/appUi'")) {
    const names = []
    for (const n of ['dataTableClass','dataTableWrapClass','operationsTableClass','sectionHintClass','sectionDescClass','controlsClass','cardOperationsClass','researchPageHeadClass','appPageStackClass','msgOkClass','msgErrorClass','msgWarningClass','pnlPositiveClass','pnlNegativeClass']) {
      if (new RegExp(`\\b${n}\\b`).test(text)) names.push(n)
    }
    if (names.length) lines.push(`import { ${names.join(', ')} } from '@/components/shared/appUi'`)
  }
  if (needs.statusUi && !text.includes("from '@/views/status/statusUi'")) {
    const names = []
    for (const n of ['systemTabClass','systemTabsClass','systemTabPanelClass']) {
      if (new RegExp(`\\b${n}\\b`).test(text)) names.push(n)
    }
    if (names.length) lines.push(`import { ${names.join(', ')} } from '@/views/status/statusUi'`)
  }
  if (!lines.length) return text
  const m = text.match(/^import .+\n/m)
  return m ? text.slice(0, m.index + m[0].length) + lines.join('\n') + '\n' + text.slice(m.index + m[0].length) : lines.join('\n') + '\n' + text
}

function migrateContent(text) {
  let next = text
  next = next.replace(/className="([^"]+)"/g, (_, cls) => {
    const m = migrateString(cls)
    return m ? `className={${m}}` : `className="${cls}"`
  })
  next = next.replace(/className='([^']+)'/g, (_, cls) => {
    const m = migrateString(cls)
    return m ? `className={${m}}` : `className='${cls}'`
  })
  // cn('legacy', 'other')
  next = next.replace(/className=\{cn\(([^)]*)\)\}/g, (full, inner) => {
    if (inner.includes('w9.') || inner.includes('rl.')) return full
    const parts = inner.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, ''))
    const allTokens = parts.flatMap((p) => p.split(/\s+/).filter(Boolean))
    if (!allTokens.some(isLegacyToken) && !allTokens.includes('system-tab')) return full
    const m = tokensToExpr(allTokens)
    return m ? `className={${m}}` : full
  })
  return addImports(next)
}

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walk(full, acc)
    } else if (/\.tsx$/.test(name)) acc.push(full)
  }
  return acc
}

let changed = 0
for (const file of walk(srcRoot)) {
  const rel = path.relative(srcRoot, file)
  if (SKIP_FILES.has(rel)) continue
  const orig = fs.readFileSync(file, 'utf8')
  const next = migrateContent(orig)
  if (next !== orig) {
    fs.writeFileSync(file, next)
    changed++
    console.log('migrated', rel)
  }
}
console.log('Done', changed)
