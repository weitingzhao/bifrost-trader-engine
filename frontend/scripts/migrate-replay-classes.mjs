#!/usr/bin/env node
/**
 * Codemod: replay-* class strings → rl.* / helpers from @/lib/replayLayout
 * Run: node scripts/migrate-replay-classes.mjs [file...]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '../src')

const CLASS_RE = /replay(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*/g

function classToRlKey(className) {
  const stripped = className.replace(/^replay-/, '')
  const parts = stripped.split('--')
  return parts
    .map((part) => part.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()))
    .reduce((acc, part, i) => (i === 0 ? part : acc + part.charAt(0).toUpperCase() + part.slice(1)), '')
}

const SKIP_CLASSES = new Set(['active', 'expanded'])

function rlRef(className) {
  if (SKIP_CLASSES.has(className)) return null
  const key = classToRlKey(className)
  return `rl.${key}`
}

function splitReplayTokens(str) {
  return str
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => t.startsWith('replay-') || t === 'active' || t === 'expanded')
}

function migrateClassString(str) {
  const tokens = str.trim().split(/\s+/).filter(Boolean)
  const replay = tokens.filter((t) => t.startsWith('replay-'))
  if (replay.length === 0) return null

  const hasActive = tokens.includes('active')
  const hasExpanded = tokens.includes('expanded')

  if (replay.length === 1 && replay[0] === 'replay-bubble-switch-btn' && tokens.length <= 2 && hasActive) {
    return 'bubbleSwitchBtn(ACTIVE)'
  }
  if (replay.length === 1 && replay[0] === 'replay-opt-expand-icon' && tokens.length <= 2) {
    return hasExpanded ? 'expandIcon(true)' : 'expandIcon(false)'
  }
  if (replay.length === 1 && replay[0] === 'replay-filter-pill' && tokens.length <= 2 && hasActive) {
    return 'filterPill(ACTIVE)'
  }
  if (replay.length === 1 && replay[0] === 'replay-ledger-summary-period-tab' && tokens.length <= 2 && hasActive) {
    return 'periodSummaryTab(ACTIVE)'
  }

  const refs = replay.map((t) => rlRef(t)).filter(Boolean)
  if (refs.length === 0) return null
  if (refs.length === 1 && !hasActive && !hasExpanded) return refs[0]
  const parts = [...refs]
  if (hasActive && replay.some((t) => t.includes('bubble-switch-btn'))) {
    return 'bubbleSwitchBtn(ACTIVE)'
  }
  return `cn(${parts.join(', ')})`
}

function migrateTemplateLiteral(tmpl) {
  if (!tmpl.includes('replay-')) return null

  // `replay-bubble-switch-btn ${cond ? 'active' : ''}`
  let m = tmpl.match(/^replay-bubble-switch-btn\s*\$\{([^}]+)\?\s*'active'\s*:\s*''\}$/)
  if (m) return `bubbleSwitchBtn(${m[1].trim()})`

  m = tmpl.match(/^replay-filter-pill(?:\s+replay-filter-pill-draggable)?\s*\$\{([^}]+)\?\s*'active'\s*:\s*''\}$/)
  if (m) return `filterPill(${m[1].trim()}, { draggable: true })`

  m = tmpl.match(/^replay-filter-pill\s*\$\{([^}]+)\?\s*'active'\s*:\s*''\}$/)
  if (m) return `filterPill(${m[1].trim()})`

  m = tmpl.match(/^replay-opt-expand-icon\s*\$\{([^}]+)\?\s*''\s*:\s*'expanded'\}$/)
  if (m) return `expandIcon(!(${m[1].trim()}))`

  m = tmpl.match(/^replay-opt-expand-icon\s*\$\{([^}]+)\?\s*'expanded'\s*:\s*''\}$/)
  if (m) return `expandIcon(${m[1].trim()})`

  m = tmpl.match(/^replay-fetch-refresh-btn\$\{([^}]+)\?\s*'\s*replay-fetch-refresh-btn--busy'\s*:\s*''\}$/)
  if (m) return `fetchRefreshBtn(${m[1].trim()})`

  m = tmpl.match(/^replay-fetch-refresh-btn\$\{([^}]+)\?\s*'\s*replay-fetch-refresh-btn--busy'\s*:\s*''\}(\s*)$/)
  if (m) return `fetchRefreshBtn(${m[1].trim()})`

  m = tmpl.match(/^replay-fetch-refresh-svg\s+replay-fetch-refresh-svg--spin$/)
  if (m) return 'fetchRefreshSvg(true)'

  m = tmpl.match(/^replay-pnl-unrealized\s+\$\{([^}]+)\}$/)
  if (m) return `pnlUnrealizedClass(${m[1].trim()})`

  m = tmpl.match(/^replay-last-strike-pct\s+\$\{([^}]+)\}$/)
  if (m) return `cn(rl.lastStrikePct, ${m[1].trim()})`

  m = tmpl.match(/^replay-ledger-summary-period-tab\s+\$\{([^}]+)\?\s*'active'\s*:\s*''\}$/)
  if (m) return `periodSummaryTab(${m[1].trim()})`

  m = tmpl.match(/^replay-instance-contain-filter\s+ledger-instance-toolbar-segment\s+\$\{([^}]+)\?\s*'replay-instance-contain-filter--disabled'\s*:\s*''\}$/)
  if (m) return `cn('ledger-instance-toolbar-segment', rl.instanceContainFilter, ${m[1].trim()} && rl.instanceContainFilterDisabled)`

  if (!tmpl.includes('${')) {
    const cnExpr = migrateClassString(tmpl)
    return cnExpr
  }

  return null
}

function addImports(content) {
  const needsRl =
    content.includes('rl.') ||
    /\bbubbleSwitchBtn\(/.test(content) ||
    /\bfilterPill\(/.test(content) ||
    /\bexpandIcon\(/.test(content) ||
    /\bfetchRefreshBtn\(/.test(content) ||
    /\bfetchRefreshSvg\(/.test(content) ||
    /\bperiodSummaryTab\(/.test(content) ||
    /\bpnlUnrealizedClass\(/.test(content) ||
    /\bpnlDetailClass\(/.test(content) ||
    /\bledgerTabMatrixLabels\(/.test(content) ||
    /\bledgerTabButtonRowClass\(/.test(content) ||
    /\bfilterInputClass\(/.test(content)
  const needsCn = content.includes('cn(')
  if (!needsRl && !needsCn) return content

  let next = content
  const helperNames = []
  if (/\bbubbleSwitchBtn\(/.test(next)) helperNames.push('bubbleSwitchBtn')
  if (/\bfilterPill\(/.test(next)) helperNames.push('filterPill')
  if (/\bexpandIcon\(/.test(next)) helperNames.push('expandIcon')
  if (/\bfetchRefreshBtn\(/.test(next)) helperNames.push('fetchRefreshBtn')
  if (/\bfetchRefreshSvg\(/.test(next)) helperNames.push('fetchRefreshSvg')
  if (/\bperiodSummaryTab\(/.test(next)) helperNames.push('periodSummaryTab')
  if (/\bpnlUnrealizedClass\(/.test(next)) helperNames.push('pnlUnrealizedClass')
  if (/\bpnlDetailClass\(/.test(next)) helperNames.push('pnlDetailClass')
  if (/\bledgerTabMatrixLabels\(/.test(next)) helperNames.push('ledgerTabMatrixLabels')
  if (/\bledgerTabButtonRowClass\(/.test(next)) helperNames.push('ledgerTabButtonRowClass')
  if (/\bfilterInputClass\(/.test(next)) helperNames.push('filterInputClass')

  const rlImport = helperNames.length
    ? `import { rl, ${[...new Set(helperNames)].join(', ')} } from '@/lib/replayLayout'\n`
    : `import { rl } from '@/lib/replayLayout'\n`

  if (needsRl && !next.includes("from '@/lib/replayLayout'")) {
    next = rlImport + next
  }
  if (needsCn && !next.includes("from '@/lib/utils'") && !next.match(/import\s*\{[^}]*\bcn\b/)) {
    next = `import { cn } from '@/lib/utils'\n` + next
  }

  // dedupe replayLayout imports
  const lines = next.split('\n')
  let rlLine = ''
  const out = []
  for (const line of lines) {
    if (line.includes("from '@/lib/replayLayout'")) {
      rlLine = line
      continue
    }
    out.push(line)
  }
  if (rlLine || needsRl) {
    const insertAt = out.findIndex((l) => l.startsWith('import '))
    const imp = rlLine || rlImport.trim()
    if (insertAt >= 0) out.splice(insertAt, 0, imp)
    else out.unshift(imp.trim())
  }
  return out.join('\n')
}

function migrateContent(content) {
  let next = content

  next = next.replace(/className="([^"]*replay-[^"]*)"/g, (_, cls) => {
    const expr = migrateClassString(cls)
    return expr ? `className={${expr.replace(/ACTIVE/g, 'true')}}` : `className="${cls}"`
  })

  next = next.replace(/className='([^']*replay-[^']*)'/g, (_, cls) => {
    const expr = migrateClassString(cls)
    return expr ? `className={${expr.replace(/ACTIVE/g, 'true')}}` : `className='${cls}'`
  })

  next = next.replace(/className=\{`([^`]*replay-[^`]*)`\}/g, (_, tmpl) => {
    const migrated = migrateTemplateLiteral(tmpl)
    return migrated ? `className={${migrated}}` : `className={\`${tmpl}\`}`
  })

  // Remaining replay- in cn() or complex className={}
  next = next.replace(/className=\{([^}]*replay-[^}]*)\}/g, (full, inner) => {
    if (inner.includes('rl.')) return full
    let replaced = inner.replace(CLASS_RE, (m) => rlRef(m) ?? m)
    replaced = replaced.replace(/'active'/g, 'rl.bubbleSwitchBtnActive')
    return `className={${replaced}}`
  })

  return next
}

const defaultTargets = [
  'views/LivePage.tsx',
  'views/PositionsPage.tsx',
  'views/AccountsPage.tsx',
  'views/TransferPayPage.tsx',
  'views/StrategyInstancesPage.tsx',
  'views/portfolio',
  'views/positions',
  'components/ExecSourceBadge.tsx',
  'components/LedgerSymbolCombobox.tsx',
  'components/LedgerExpiryMonthCombobox.tsx',
  'components/StrategyOpportunityCombobox.tsx',
]

function walkTarget(target) {
  const full = path.join(srcRoot, target)
  if (!fs.existsSync(full)) return []
  if (fs.statSync(full).isFile()) return [full]
  const acc = []
  for (const name of fs.readdirSync(full)) {
    const p = path.join(full, name)
    if (fs.statSync(p).isDirectory()) acc.push(...walkTarget(path.relative(srcRoot, p)))
    else if (/\.tsx$/.test(name)) acc.push(p)
  }
  return acc
}

const args = process.argv.slice(2)
const targets = args.length ? args.map((a) => a.replace(/^src\//, '')) : defaultTargets

let changed = 0
for (const target of targets) {
  for (const file of walkTarget(target)) {
    const rel = path.relative(srcRoot, file)
    const original = fs.readFileSync(file, 'utf8')
    if (!original.includes('replay-')) continue
    let migrated = migrateContent(original)
    migrated = addImports(migrated)
    if (migrated !== original) {
      fs.writeFileSync(file, migrated)
      changed++
      console.log('migrated:', rel)
    }
  }
}

console.log(`Done. ${changed} file(s) updated.`)
