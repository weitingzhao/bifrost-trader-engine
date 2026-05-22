#!/usr/bin/env node
/**
 * Codemod: replace data-overview-*, ref-jobs-*, architecture-console-* with do/rj/ac tokens.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '../src')

const PREFIXES = [
  { prefix: 'data-overview-', exportName: 'do', importFrom: '@/views/dataOverview/dataOverviewClasses' },
  { prefix: 'ref-jobs-', exportName: 'rj', importFrom: '@/views/massive/refJobsClasses' },
  {
    prefix: 'architecture-',
    exportName: 'ac',
    importFrom: '@/views/architecture/architectureConsoleClasses',
    only: [
      'architecture-console-',
      'architecture-unified-',
      'architecture-source-bubble',
      'architecture-source-bubbles',
      'architecture-log-source-',
    ],
  },
]

function classToKey(className, prefix) {
  let rest = className
  if (rest.startsWith(prefix)) rest = rest.slice(prefix.length)
  rest = rest.replace(/^[-_]+/, '')
  const segments = rest.split('--').flatMap(s => s.split('__'))
  return segments
    .filter(Boolean)
    .map((seg, i) =>
      i === 0
        ? seg.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
        : seg.charAt(0).toUpperCase() +
          seg.slice(1).replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()),
    )
    .join('')
}

function refForClass(className, exportName, prefix) {
  return `${exportName}.${classToKey(className, prefix)}`
}

function matchesPrefix(className, cfg) {
  if (cfg.only) return cfg.only.some(p => className.startsWith(p))
  return className.startsWith(cfg.prefix)
}

function splitTokens(str, cfg) {
  return str
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter(c => matchesPrefix(c, cfg))
}

function tokensToCn(tokens, cfg) {
  if (tokens.length === 0) return null
  if (tokens.length === 1) return refForClass(tokens[0], cfg.exportName, cfg.prefix)
  return `cn(${tokens.map(t => refForClass(t, cfg.exportName, cfg.prefix)).join(', ')})`
}

function migrateString(str) {
  for (const cfg of PREFIXES) {
    const tokens = splitTokens(str, cfg)
    if (tokens.length === 0) continue
    const allTokens = str.trim().split(/\s+/).filter(Boolean)
    const legacy = allTokens.filter(t => matchesPrefix(t, cfg))
    const other = allTokens.filter(t => !matchesPrefix(t, cfg))
    const legacyCn = legacy.length === 1
      ? refForClass(legacy[0], cfg.exportName, cfg.prefix)
      : `cn(${legacy.map(t => refForClass(t, cfg.exportName, cfg.prefix)).join(', ')})`
    if (other.length === 0) return legacyCn
    return `cn(${legacyCn}, '${other.join(' ')}')`
  }
  return null
}

function addImports(content) {
  let next = content
  const needs = {
    do: next.includes('do.'),
    rj: next.includes('rj.'),
    ac: next.includes('ac.'),
    cn: next.includes('cn('),
    logSource: next.includes('logSourceTagClass'),
    sourceBubble: next.includes('sourceBubbleClass'),
  }

  const importLines = []
  if (needs.do && !next.includes("from '@/views/dataOverview/dataOverviewClasses'")) {
    importLines.push(`import { dov } from '@/views/dataOverview/dataOverviewClasses'`)
  }
  if (needs.rj && !next.includes("from '@/views/massive/refJobsClasses'")) {
    importLines.push(`import { rj } from '@/views/massive/refJobsClasses'`)
  }
  if (needs.ac || needs.logSource || needs.sourceBubble) {
    if (!next.includes("from '@/views/architecture/architectureConsoleClasses'")) {
      const parts = ['ac']
      if (needs.logSource) parts.push('logSourceTagClass')
      if (needs.sourceBubble) parts.push('sourceBubbleClass')
      importLines.push(`import { ${parts.join(', ')} } from '@/views/architecture/architectureConsoleClasses'`)
    }
  }
  if (needs.cn && !next.includes("from '@/lib/utils'")) {
    importLines.push(`import { cn } from '@/lib/utils'`)
  }

  if (importLines.length) next = `${importLines.join('\n')}\n${next}`
  return next
}

function migrateContent(content) {
  let next = content

  // Special: architecture source bubble dynamic
  next = next.replace(
    /className=\{`architecture-source-bubble\$\{on \? ' architecture-source-bubble--active' : ' architecture-source-bubble--off'\}`\}/g,
    'className={sourceBubbleClass(on)}',
  )

  // Special: log source tag
  next = next.replace(
    /className=\{`architecture-log-source-tag architecture-log-source--\$\{item\.source\}`\}/g,
    'className={logSourceTagClass(item.source)}',
  )

  // ref-jobs-sheet-status--${tone}
  next = next.replace(
    /className=\{`ref-jobs-sheet-status ref-jobs-sheet-status--\$\{tone\}`\}/g,
    "className={cn(rj.sheetStatus, tone === 'ok' ? rj.sheetStatusOk : tone === 'err' ? rj.sheetStatusErr : rj.sheetStatusRun)}",
  )

  // const ico = 'data-overview-ctl__ico'
  next = next.replace(
    /const\s+(\w+)\s*=\s*'(data-overview-[^']+)'/g,
    (_, name, cls) => `const ${name} = ${refForClass(cls, 'do', 'data-overview-')}`,
  )

  next = next.replace(/className="([^"]+)"/g, (_, cls) => {
    if (!PREFIXES.some(cfg => splitTokens(cls, cfg).length)) return `className="${cls}"`
    const migrated = migrateString(cls)
    return migrated ? `className={${migrated}}` : `className="${cls}"`
  })

  next = next.replace(/className='([^']+)'/g, (_, cls) => {
    if (!PREFIXES.some(cfg => splitTokens(cls, cfg).length)) return `className='${cls}'`
    const migrated = migrateString(cls)
    return migrated ? `className={${migrated}}` : `className='${cls}'`
  })

  next = next.replace(/className=\{`([^`]+)`\}/g, (_, tmpl) => {
    if (!PREFIXES.some(cfg => tmpl.includes(cfg.prefix.replace(/-$/, '')))) return `className={\`${tmpl}\`}`
    // simple ternary suffix
    const m = tmpl.match(
      /^(data-overview-[a-z0-9_-]+(?:__[a-z0-9_-]+)?)\$\{([^}]+)\?\s*'(data-overview-[a-z0-9_-]+(?:--[a-z0-9_-]+)?(?:\s+data-overview-[a-z0-9_-]+(?:--[a-z0-9_-]+)?)?)'\s*:\s*'(data-overview-[a-z0-9_-]+(?:--[a-z0-9_-]+)?(?:\s+data-overview-[a-z0-9_-]+(?:--[a-z0-9_-]+)?)?)'\}$/,
    )
    if (m) {
      const [, base, cond, a, b] = m
      const baseRef = refForClass(base.trim(), 'do', 'data-overview-')
      const aTokens = a.trim().split(/\s+/)
      const bTokens = b.trim().split(/\s+/)
      const aRef =
        aTokens.length === 1
          ? refForClass(aTokens[0], 'do', 'data-overview-')
          : `cn(${aTokens.map(t => refForClass(t, 'do', 'data-overview-')).join(', ')})`
      const bRef =
        bTokens.length === 1
          ? refForClass(bTokens[0], 'do', 'data-overview-')
          : `cn(${bTokens.map(t => refForClass(t, 'do', 'data-overview-')).join(', ')})`
      return `className={cn(${baseRef}, ${cond.trim()} ? ${aRef} : ${bRef})}`
    }

    // pool row modifier
    const pool = tmpl.match(
      /^(data-overview-wl-matrix__sym-btn)\$\{inPool \? ' data-overview-wl-matrix__sym-btn--on' : ''\}$/,
    )
    if (pool) {
      return `className={cn(${refForClass(pool[1], 'do', 'data-overview-')}, inPool && ${refForClass('data-overview-wl-matrix__sym-btn--on', 'do', 'data-overview-')})}`
    }

    if (tmpl.includes('${')) return `className={\`${tmpl}\`}`

    const migrated = migrateString(tmpl)
    return migrated ? `className={${migrated}}` : `className={\`${tmpl}\`}`
  })

  // return 'data-overview-...'
  next = next.replace(
    /return '(data-overview-[a-z0-9_-]+(?:\s+data-overview-[a-z0-9_-]+(?:--[a-z0-9_-]+)?)*)'/g,
    (_, cls) => {
      const migrated = migrateString(cls)
      return migrated ? `return ${migrated}` : `return '${cls}'`
    },
  )

  // ternary return helpers
  next = next.replace(
    /\?\s*'(data-overview-[a-z0-9_-]+(?:\s+data-overview-[a-z0-9_-]+(?:--[a-z0-9_-]+)?)*?)'\s*:\s*'(data-overview-[a-z0-9_-]+(?:\s+data-overview-[a-z0-9_-]+(?:--[a-z0-9_-]+)?)*?)'/g,
    (_, a, b) => {
      const aM = migrateString(a)
      const bM = migrateString(b)
      return aM && bM ? `? ${aM} : ${bM}` : `? '${a}' : '${b}'`
    },
  )

  return addImports(next)
}

const TARGET_DIRS = [
  path.join(srcRoot, 'views/dataOverview'),
  path.join(srcRoot, 'views/massive'),
  path.join(srcRoot, 'components'),
  path.join(srcRoot, 'views'),
]

function shouldProcess(file) {
  const rel = path.relative(srcRoot, file)
  if (rel.endsWith('dataOverviewClasses.ts') || rel.endsWith('refJobsClasses.ts') || rel.endsWith('architectureConsoleClasses.ts')) {
    return false
  }
  const text = fs.readFileSync(file, 'utf8')
  return /data-overview-|ref-jobs-|architecture-console-|architecture-unified-|architecture-source-bubble|architecture-log-source-/.test(
    text,
  )
}

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walk(full, acc)
    } else if (/\.tsx$/.test(name)) acc.push(full)
  }
  return acc
}

const files = new Set()
for (const dir of TARGET_DIRS) {
  for (const f of walk(dir)) files.add(f)
}

let changed = 0
for (const file of files) {
  if (!shouldProcess(file)) continue
  const original = fs.readFileSync(file, 'utf8')
  const migrated = migrateContent(original)
  if (migrated !== original) {
    fs.writeFileSync(file, migrated)
    changed++
    console.log('migrated:', path.relative(srcRoot, file))
  }
}

console.log(`Done. ${changed} file(s) updated.`)
