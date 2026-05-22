#!/usr/bin/env node
/**
 * Codemod: remaining app-surfaces class strings → w9.* / shared modules.
 * Run: node scripts/migrate-wave9-classes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '../src')

/** Exact class → expression (no quotes). */
const EXACT_MAP = {
  'replay-section': 'rl.section',
  'replay-page': 'rl.page',
  'replay-toolbar': 'rl.toolbar',
  'replay-bubble-switch': 'rl.bubbleSwitch',
  'replay-portfolio-tabs-wrap': 'rl.portfolioTabsWrap',
  'replay-sync-hint': 'rl.syncHint',
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
  'msg': 'msgOkClass',
  'pnl-positive': 'pnlPositiveClass',
  'pnl-negative': 'pnlNegativeClass',
  'system-tabs': 'systemTabsClass()',
  'system-tab-panel': 'systemTabPanelClass()',
  'active': 'true',
}

const APP_UI_IMPORTS = new Set([
  'dataTableClass',
  'dataTableWrapClass',
  'operationsTableClass',
  'sectionHintClass',
  'sectionDescClass',
  'controlsClass',
  'cardOperationsClass',
  'researchPageHeadClass',
  'appPageStackClass',
  'msgOkClass',
  'msgErrorClass',
  'msgWarningClass',
  'pnlPositiveClass',
  'pnlNegativeClass',
  'appTabsClass',
  'appTabClass',
  'tablePaginationClass',
])

const STATUS_UI_IMPORTS = new Set(['systemTabsClass', 'systemTabClass', 'systemTabPanelClass'])

function classToW9Key(className) {
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

function refForClass(className) {
  if (EXACT_MAP[className]) return EXACT_MAP[className]
  if (className.startsWith('replay-')) return null // handled by migrate-replay-classes
  if (className.startsWith('data-overview-')) return null
  if (className.startsWith('ref-jobs-')) return null
  if (className.startsWith('od-') || className.startsWith('option-discovery-')) return null
  if (className.startsWith('feed-massive-')) return null
  return `w9.${classToW9Key(className)}`
}

function isMigratable(className) {
  if (!className || className === 'true' || className === 'false') return false
  if (className.startsWith('replay-')) return false
  if (className.startsWith('data-overview-')) return false
  if (className.startsWith('ref-jobs-')) return false
  if (className.startsWith('od-')) return false
  if (className.startsWith('feed-massive-')) return false
  if (className.startsWith('architecture-console-')) return false
  return refForClass(className) !== null
}

function migrateTokenString(str) {
  const tokens = str.trim().split(/\s+/).filter(Boolean)
  const migratable = tokens.filter(isMigratable)
  if (migratable.length === 0) return null

  const refs = tokens.map((t) => {
    if (!isMigratable(t)) return `'${t}'`
    const ref = refForClass(t)
    if (t === 'system-tab' && tokens.includes('active')) {
      return null // handled below
    }
    return ref
  }).filter(Boolean)

  const hasSystemTab = tokens.includes('system-tab')
  const hasActive = tokens.includes('active')
  if (hasSystemTab) {
    const others = tokens.filter((t) => t !== 'system-tab' && t !== 'active' && isMigratable(t))
    const otherRefs = others.map((t) => refForClass(t))
    const base = hasActive ? 'systemTabClass(true)' : 'systemTabClass()'
    if (otherRefs.length === 0) return base
    return `cn(${base}, ${otherRefs.join(', ')})`
  }

  const nonMigratable = tokens.filter((t) => !isMigratable(t))
  const migratableRefs = tokens.filter(isMigratable).map((t) => refForClass(t))

  if (nonMigratable.length === 0) {
    if (migratableRefs.length === 1) return migratableRefs[0]
    return `cn(${migratableRefs.join(', ')})`
  }

  const all = [...migratableRefs, ...nonMigratable.map((t) => `'${t}'`)]
  if (all.length === 1) return all[0]
  return `cn(${all.join(', ')})`
}

function addImports(content) {
  let next = content
  const importLines = []

  const needsAppUi = [...APP_UI_IMPORTS].some((n) => new RegExp(`\\b${n}\\b`).test(next))
  const needsStatusUi = [...STATUS_UI_IMPORTS].some((n) => new RegExp(`\\b${n}\\b`).test(next))
  const needsRl = /\brl\./.test(next) || /\b(rl\.section|rl\.page|rl\.toolbar)\b/.test(next)
  const needsW9 = /\bw9\./.test(next)
  const needsCn = /\bcn\(/.test(next)

  if (needsAppUi && !next.includes("from '@/components/shared/appUi'")) {
    const used = [...APP_UI_IMPORTS].filter((n) => new RegExp(`\\b${n}\\b`).test(next))
    importLines.push(`import { ${used.join(', ')} } from '@/components/shared/appUi'`)
  }
  if (needsStatusUi && !next.includes("from '@/views/status/statusUi'")) {
    const used = [...STATUS_UI_IMPORTS].filter((n) => new RegExp(`\\b${n}\\b`).test(next))
    importLines.push(`import { ${used.join(', ')} } from '@/views/status/statusUi'`)
  }
  if (needsRl && !next.includes("from '@/lib/replayLayout'")) {
    importLines.push(`import { rl } from '@/lib/replayLayout'`)
  }
  if (needsW9 && !next.includes("from '@/styles/wave9Classes'")) {
    importLines.push(`import { w9 } from '@/styles/wave9Classes'`)
  }
  if (needsCn && !next.includes("from '@/lib/utils'")) {
    importLines.push(`import { cn } from '@/lib/utils'`)
  }

  if (importLines.length) next = `${importLines.join('\n')}\n${next}`
  return next
}

function migrateContent(content) {
  if (content.includes('wave9Classes.ts')) return content
  let next = content

  // Skip if no app-surfaces-like classes
  if (!/className=/.test(next)) return next

  next = next.replace(/className="([^"]+)"/g, (_, cls) => {
    if (!cls.split(/\s+/).some(isMigratable)) return `className="${cls}"`
    const migrated = migrateTokenString(cls)
    return migrated ? `className={${migrated}}` : `className="${cls}"`
  })

  next = next.replace(/className='([^']+)'/g, (_, cls) => {
    if (!cls.split(/\s+/).some(isMigratable)) return `className='${cls}'`
    const migrated = migrateTokenString(cls)
    return migrated ? `className={${migrated}}` : `className='${cls}'`
  })

  // Template literals with system-tab active pattern
  next = next.replace(
    /className=\{`system-tab([^`]*)`\}/g,
    (_, rest) => {
      if (rest.includes('${') && rest.includes('active')) {
        const cond = rest.match(/\$\{([^}]+)\}/)?.[1]
        if (cond) return `className={systemTabClass(${cond.trim()})}`
      }
      return `className={\`system-tab${rest}\`}`
    },
  )

  // pnl-positive/negative in template literals
  next = next.replace(
    /className=\{`([^`]*?)`\}/g,
    (_, tmpl) => {
      if (!/\$\{/.test(tmpl)) {
        const migrated = migrateTokenString(tmpl)
        if (migrated) return `className={${migrated}}`
        return `className={\`${tmpl}\`}`
      }
      // `foo ${cond ? 'pnl-positive' : 'pnl-negative' : ''}`
      let m = tmpl.match(/^([^$]*)\$\{([^}]+)\?\s*'pnl-positive'\s*:\s*([^}]+)\?\s*'pnl-negative'\s*:\s*''\}(.*)$/)
      if (m) {
        const [, prefix, cond1, cond2, suffix] = m
        const prefixM = prefix.trim() ? migrateTokenString(prefix.trim()) : null
        const suffixM = suffix.trim() ? migrateTokenString(suffix.trim()) : null
        const pnlExpr = `${cond1.trim()} ? pnlPositiveClass : ${cond2.trim()} ? pnlNegativeClass : ''`
        const parts = [prefixM, pnlExpr, suffixM].filter(Boolean)
        return parts.length === 1 ? `className={${parts[0]}}` : `className={cn(${parts.join(', ')})}`
      }
      return `className={\`${tmpl}\`}`
    },
  )

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

const SKIP = new Set([
  'styles/wave9Classes.ts',
  'views/celery/celeryUi.tsx',
  'views/status/statusUi.tsx',
  'components/shared/appUi.ts',
])

let changed = 0
for (const file of walk(srcRoot)) {
  const rel = path.relative(srcRoot, file)
  if (SKIP.has(rel)) continue
  const original = fs.readFileSync(file, 'utf8')
  const migrated = migrateContent(original)
  if (migrated !== original) {
    fs.writeFileSync(file, migrated)
    changed++
    console.log('migrated:', rel)
  }
}

console.log(`Done. ${changed} file(s) updated.`)
