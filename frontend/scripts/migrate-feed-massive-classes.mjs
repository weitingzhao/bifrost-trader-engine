#!/usr/bin/env node
/**
 * One-shot codemod: replace feed-massive-* class strings with fm.* Tailwind tokens.
 * Run from frontend/: node scripts/migrate-feed-massive-classes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '../src')

/** feed-massive-foo-bar--baz → fm.fooBarBaz */
function classToFmKey(className) {
  const stripped = className.replace(/^feed-massive-/, '')
  const parts = stripped.split('--')
  return parts
    .map(part =>
      part.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()),
    )
    .reduce((acc, part, i) => (i === 0 ? part : acc + part.charAt(0).toUpperCase() + part.slice(1)), '')
}

const CLASS_RE = /feed-massive(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*/g

function fmRefForClass(className) {
  return `fm.${classToFmKey(className)}`
}

function splitClassString(str) {
  return str
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter(c => c.startsWith('feed-massive'))
}

function classStringToCn(str) {
  const tokens = splitClassString(str)
  if (tokens.length === 0) return null
  if (tokens.length === 1) return fmRefForClass(tokens[0])
  return `cn(${tokens.map(fmRefForClass).join(', ')})`
}

function migrateTemplateLiteral(template) {
  // Simple case: `feed-massive-x${cond ? ' feed-massive-y--active' : ''}`
  const staticParts = template.match(/feed-massive(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*/g) ?? []
  if (staticParts.length === 0) return null

  // If template has complex expressions beyond simple ternary with feed-massive strings, skip
  const exprCount = (template.match(/\$\{/g) ?? []).length
  if (exprCount > 2) return null

  // Try pattern: base${cond ? ' modifier' : ''}
  const m = template.match(
    /^(feed-massive(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*)\$\{([^}]+)\?\s*'(feed-massive(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*)'\s*:\s*''\}$/,
  )
  if (m) {
    const [, base, cond, mod] = m
    return `cn(${fmRefForClass(base)}, ${cond.trim()} && ${fmRefForClass(mod)})`
  }

  // Try: only static classes concatenated
  if (!template.includes('${')) {
    const cn = classStringToCn(template)
    return cn
  }

  return null
}

function addImports(content, filePath) {
  const needsFm = content.includes('fm.')
  const needsCn = content.includes('cn(')
  if (!needsFm && !needsCn) return content

  const fmImportPath = path
    .relative(path.dirname(filePath), path.join(srcRoot, 'views/feed/feedMassiveStyles.ts'))
    .replace(/\\/g, '/')
    .replace(/\.ts$/, '')

  const shellImportPath = path
    .relative(path.dirname(filePath), path.join(srcRoot, 'views/feed/FeedMassiveShell.tsx'))
    .replace(/\\/g, '/')
    .replace(/\.tsx$/, '')

  // Prefer @/ alias when under src/
  const fmFrom = fmImportPath.startsWith('.') ? fmImportPath : `@/${fmImportPath.replace(/^src\//, '')}`
  const resolvedFmFrom = fmImportPath.startsWith('../')
    ? fmImportPath
    : '@/views/feed/feedMassiveStyles'

  let next = content

  if (needsFm && !next.includes("from '@/views/feed/feedMassiveStyles'") && !next.includes(`from '${resolvedFmFrom}'`)) {
    const importLine = needsCn
      ? `import { fm, feedMassiveTabDotClass, feedMassiveSvcLampClass, feedMassiveStatusValueClass, feedMassiveCapPanelClass, feedMassiveJobBadgeClass, feedMassiveDailyBadgeClass } from '@/views/feed/feedMassiveStyles'\n`
      : `import { fm } from '@/views/feed/feedMassiveStyles'\n`
    // trim unused helper imports later via eslint; import all helpers for simplicity
    const helperImport = `import { fm, feedMassiveTabDotClass, feedMassiveSvcLampClass, feedMassiveStatusValueClass, feedMassiveCapPanelClass, feedMassiveJobBadgeClass, feedMassiveDailyBadgeClass } from '@/views/feed/feedMassiveStyles'\n`
    next = helperImport + next
  }

  if (needsCn && !next.includes("from '@/lib/utils'")) {
    if (!next.includes('{ cn }')) {
      next = `import { cn } from '@/lib/utils'\n` + next
    }
  }

  // Deduplicate identical imports (rough)
  const lines = next.split('\n')
  const seen = new Set()
  const deduped = []
  for (const line of lines) {
    if (line.startsWith('import { fm,')) {
      if (seen.has('fm')) continue
      seen.add('fm')
    }
    if (line.startsWith('import { cn }')) {
      if (seen.has('cn')) continue
      seen.add('cn')
    }
    deduped.push(line)
  }
  return deduped.join('\n')
}

function migrateDotClassFunctions(content) {
  // overviewDotClass / feedMassiveOverviewDotClass / statusDotClass / lampClass helpers
  let next = content

  next = next.replace(
    /function overviewDotClass\(eff: EffectiveServiceStatus\): string \{[\s\S]*?\n\}/,
    '// overviewDotClass → feedMassiveTabDotClass from feedMassiveStyles',
  )
  next = next.replace(
    /function feedMassiveOverviewDotClass\(eff: EffectiveServiceStatus\): string \{[\s\S]*?\n\}/,
    '// feedMassiveOverviewDotClass → feedMassiveTabDotClass',
  )
  next = next.replace(
    /function statusDotClass\(eff: string\): string \{[\s\S]*?\n\}/,
    '// statusDotClass → feedMassiveTabDotClass',
  )
  next = next.replace(
    /function lampClass\(s: EffectiveServiceStatus\): string \{[\s\S]*?\n\}/,
    '// lampClass → feedMassiveSvcLampClass',
  )

  next = next.replace(/\boverviewDotClass\(/g, 'feedMassiveTabDotClass(')
  next = next.replace(/\bfeedMassiveOverviewDotClass\(/g, 'feedMassiveTabDotClass(')
  next = next.replace(/\bstatusDotClass\(/g, 'feedMassiveTabDotClass(')
  next = next.replace(/\blampClass\(/g, 'feedMassiveSvcLampClass(')

  // statusBadgeClass in DailyDataChecklistSection
  next = next.replace(
    /function statusBadgeClass\(status: string \| undefined\): string \{[\s\S]*?\n\}/,
    '// statusBadgeClass → feedMassiveDailyBadgeClass',
  )
  next = next.replace(/\bstatusBadgeClass\(/g, 'feedMassiveDailyBadgeClass(')

  // job badge in CeleryJobQueuesSection
  next = next.replace(
    /function jobStatusBadgeClass\(status: string\): string \{[\s\S]*?\n\}/,
    '// jobStatusBadgeClass → feedMassiveJobBadgeClass',
  )
  next = next.replace(/\bjobStatusBadgeClass\(/g, 'feedMassiveJobBadgeClass(')

  return next
}

function migrateContent(content) {
  let next = migrateDotClassFunctions(content)

  // className="feed-massive-x feed-massive-y"
  next = next.replace(/className="([^"]*feed-massive[^"]*)"/g, (_, cls) => {
    const cnExpr = classStringToCn(cls)
    return cnExpr ? `className={${cnExpr}}` : `className="${cls}"`
  })

  // className='...'
  next = next.replace(/className='([^']*feed-massive[^']*)'/g, (_, cls) => {
    const cnExpr = classStringToCn(cls)
    return cnExpr ? `className={${cnExpr}}` : `className='${cls}'`
  })

  // className={`...`}
  next = next.replace(/className=\{`([^`]*feed-massive[^`]*)`\}/g, (_, tmpl) => {
    const migrated = migrateTemplateLiteral(tmpl)
    return migrated ? `className={${migrated}}` : `className={\`${tmpl}\`}`
  })

  // return 'feed-massive-...' in helper functions (remaining)
  next = next.replace(
    /return '(feed-massive(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*(?:\s+feed-massive(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*)*)'/g,
    (_, cls) => {
      const cnExpr = classStringToCn(cls)
      return cnExpr ? `return ${cnExpr}` : `return '${cls}'`
    },
  )

  // Ternary in className: configured ? 'feed-massive-status-value feed-massive-status-value--ok' : '...'
  next = next.replace(
    /(\?\s*)'(feed-massive-status-value feed-massive-status-value--ok)'\s*:\s*'(feed-massive-status-value feed-massive-status-value--bad)'/g,
    '? feedMassiveStatusValueClass(true) : feedMassiveStatusValueClass(false)',
  )

  // Remaining quoted feed-massive tokens inside cn or template - replace bare strings
  next = next.replace(/'feed-massive(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*'/g, match => {
    const cn = classStringToCn(match.slice(1, -1))
    return cn ?? match
  })

  // feed-massive inside template with extra non-feed classes e.g. msg-error feed-massive-daily-warn
  next = next.replace(/className=\{cn\(([^}]*)\)\}/g, (full, inner) => {
    if (!inner.includes('feed-massive')) return full
    const parts = inner.split(',').map(p => p.trim())
    const migrated = parts.map(p => {
      const m = p.match(/^'(feed-massive[^']*)'$/)
      if (m) return fmRefForClass(m[1].split(/\s+/)[0])
      return p
    })
    return `className={cn(${migrated.join(', ')})}`
  })

  // Replace any remaining feed-massive- in className contexts (last resort token replace in quotes)
  next = next.replace(/className=\{([^}]*feed-massive[^}]*)\}/g, (full, inner) => {
    if (inner.includes('fm.')) return full
    let replaced = inner.replace(CLASS_RE, m => fmRefForClass(m))
    return `className={${replaced}}`
  })

  next = addImports(next, '')
  return next
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
  if (rel === 'views/feed/feedMassiveStyles.ts' || rel === 'views/feed/FeedMassiveShell.tsx') continue

  const original = fs.readFileSync(file, 'utf8')
  if (!original.includes('feed-massive')) continue
  if (!/className/.test(original) && !/return 'feed-massive/.test(original)) continue

  let migrated = migrateContent(original)
  migrated = addImports(migrated, file)

  if (migrated !== original) {
    fs.writeFileSync(file, migrated)
    changed++
    console.log('migrated:', rel)
  }
}

console.log(`Done. ${changed} file(s) updated.`)
