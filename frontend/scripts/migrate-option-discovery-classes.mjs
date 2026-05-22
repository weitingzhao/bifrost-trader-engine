#!/usr/bin/env node
/**
 * Codemod: replace od-* / option-discovery-* / strike-ladder-* / mp-* class strings with od.* tokens.
 * Run: node scripts/migrate-option-discovery-classes.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '../src')

const MIGRATE_PREFIXES = ['od-', 'option-discovery-', 'strike-ladder', 'mp-']
const GREEKS_PREFIXES = ['option-greeks-', 'greeks-table', 'greeks-calc-tooltip']

const SKIP_FILES = new Set([
  'views/optionDiscovery/optionDiscoveryClasses.ts',
])

function toCamel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase())
}

function classToOdKey(className) {
  let body = className.replace(/__/g, '-')
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

function isMigrateToken(token) {
  if (!token || token.includes('${')) return false
  return (
    MIGRATE_PREFIXES.some((p) => token === p.replace(/-$/, '') || token.startsWith(p)) ||
    GREEKS_PREFIXES.some((p) => token.startsWith(p))
  )
}

function odRef(token) {
  return `od.${classToOdKey(token)}`
}

function splitMigrateTokens(str) {
  return str.trim().split(/\s+/).filter(Boolean)
}

function classStringToExpr(str) {
  const tokens = splitMigrateTokens(str)
  const migrate = tokens.filter(isMigrateToken)
  const keep = tokens.filter((t) => !isMigrateToken(t))
  if (migrate.length === 0) return null
  const parts = [...keep, ...migrate.map(odRef)]
  if (parts.length === 1) return parts[0]
  return `cn(${parts.join(', ')})`
}

const CLASS_RE = /(?:od|option-discovery|strike-ladder|mp|option-greeks|greeks-table|greeks-calc-tooltip)(?:-[a-z0-9]+)+(?:--[a-z0-9]+)*/g

function migrateTemplateLiteral(tmpl) {
  const m = tmpl.match(
    /^(.*?)(od|option-discovery|strike-ladder|mp|option-greeks|greeks-[a-z-]+)([^\s`]*)\$\{([^}]+)\?\s*'([^']*)'\s*:\s*''\}(.*)$/,
  )
  if (m) {
    const [, pre, , restBase, cond, modStr, post] = m
    const baseTok = (pre + restBase).trim().split(/\s+/).filter(isMigrateToken).pop()
    const modTok = modStr.trim().split(/\s+/).find(isMigrateToken)
    const preKeep = splitMigrateTokens(pre).filter((t) => !isMigrateToken(t))
    const postKeep = splitMigrateTokens(post).filter((t) => !isMigrateToken(t))
    const parts = [...preKeep]
    if (baseTok) parts.push(odRef(baseTok))
    if (modTok) parts.push(`${cond.trim()} && ${odRef(modTok)}`)
    parts.push(...postKeep)
    return parts.length === 1 ? parts[0] : `cn(${parts.join(', ')})`
  }

  if (!tmpl.includes('${')) {
    return classStringToExpr(tmpl)
  }
  return null
}

function addImports(content) {
  const needsOd = /\bod\./.test(content)
  const needsCn = /\bcn\(/.test(content)
  if (!needsOd && !needsCn) return content

  let next = content
  if (needsOd && !next.includes("from '@/views/optionDiscovery/optionDiscoveryClasses'") && !next.includes("from './optionDiscoveryClasses'")) {
    const rel = next.includes('views/optionDiscovery/')
    const importPath = next.match(/views\/optionDiscovery\//)
      ? "./optionDiscoveryClasses"
      : "@/views/optionDiscovery/optionDiscoveryClasses"
    const helperNames = new Set()
    const helperRe =
      /\b(odDataStateClass|odLayerSectionClass|odChainExpiryChipClass|odUnderlyingChipClass|odGreeksSourceBtnClass|odMoneynessBadgeClass|odSnapshotFeedbackClass|odChainRowClass|odChainTdClass|odChainStrikeCellClass|odAnalyticsSkewValClass|odIvTermExpItemClass|odIvSheetHoverClass|odStrikeLadderTwoColsClass|odIvTermConeChartsRowClass|odExpFilterBtnClass|odExpirationKindBadge|odBsDiffClass|greeksIvClass|greeksDeltaClass|odChartSvgClass|odIconBtnNeutral)\b/g
    let hm
    while ((hm = helperRe.exec(next)) !== null) helperNames.add(hm[1])
    const exports = ['od', ...helperNames]
    next = `import { ${exports.join(', ')} } from '${importPath}'\n` + next
  }
  if (needsCn && !next.includes("from '@/lib/utils'")) {
    next = `import { cn } from '@/lib/utils'\n` + next
  }
  return next
}

function migrateContent(content) {
  let next = content

  // Local odPanel* constants → od tokens
  next = next.replace(
    /const odPanelHeaderCls =[\s\S]*?\nconst odPanelSectionTitleCls =[\s\S]*?\n/,
    '',
  )

  next = next.replace(/\bodPanelSectionCls\b/g, 'od.detailSection')
  next = next.replace(/\bodPanelSectionTitleCls\b/g, 'od.detailSectionTitle')
  next = next.replace(/\bodPanelHeaderCls\b/g, 'od.detailHeader')
  next = next.replace(/\bodPanelTitleCls\b/g, 'od.detailTitle')
  next = next.replace(/\bodPanelExpiryCls\b/g, 'od.detailExpiry')
  next = next.replace(/\bodPanelDelayedCls\b/g, 'od.detailDelayed')

  // ivClass / deltaClass helpers in OptionGreeksPage
  next = next.replace(
    /function ivClass\(iv: number \| null\): string \{[\s\S]*?\n\}/,
    '// ivClass → greeksIvClass from optionDiscoveryClasses',
  )
  next = next.replace(
    /function deltaClass\(delta: number \| null\): string \{[\s\S]*?\n\}/,
    '// deltaClass → greeksDeltaClass from optionDiscoveryClasses',
  )
  next = next.replace(/\bivClass\(/g, 'greeksIvClass(')
  next = next.replace(/\bdeltaClass\(/g, 'greeksDeltaClass(')

  // diffClass in OptionContractDetailPanel
  next = next.replace(
    /function diffClass\([^)]*\)[^{]*\{[\s\S]*?\n\}/,
    '',
  )
  next = next.replace(/\bdiffClass\(([^)]+)\)/g, 'odBsDiffClass($1)')

  // Specialized template patterns
  next = next.replace(
    /className=\{`od-layer-section\$\{enabled \? '' : ' od-layer-section--locked'\}`\}/g,
    'className={odLayerSectionClass(enabled)}',
  )
  next = next.replace(
    /className=\{`od-data-state od-data-state--\$\{status\}`\}/g,
    'className={odDataStateClass(status)}',
  )
  next = next.replace(
    /className=\{`od-chain-expiry-chip\$\{sel \? ' od-chain-expiry-chip--active' : ''\}`\}/g,
    'className={odChainExpiryChipClass(sel)}',
  )
  next = next.replace(
    /className=\{`od-underlying-chip \$\{active \? 'od-underlying-chip--active' : ''\}`\}/g,
    'className={odUnderlyingChipClass(active)}',
  )
  next = next.replace(
    /className=\{`od-greeks-source-btn\$\{greeksSource === 'snapshot' \? ' od-greeks-source-btn--active' : ''\}`\}/g,
    "className={odGreeksSourceBtnClass(greeksSource === 'snapshot')}",
  )
  next = next.replace(
    /className=\{`od-greeks-source-btn\$\{greeksSource === 'bs' \? ' od-greeks-source-btn--active' : ''\}`\}/g,
    "className={odGreeksSourceBtnClass(greeksSource === 'bs')}",
  )
  next = next.replace(
    /className=\{`od-moneyness-badge od-moneyness-badge--\$\{selectedDerived\.moneynessLabel\.toLowerCase\(\)\}`\}/g,
    'className={odMoneynessBadgeClass(selectedDerived.moneynessLabel)}',
  )
  next = next.replace(
    /className=\{`od-snapshot-feedback od-snapshot-feedback--\$\{snapshotFeedback\.level\}`\}/g,
    'className={odSnapshotFeedbackClass(snapshotFeedback.level)}',
  )
  next = next.replace(
    /className=\{`strike-ladder-two-cols\$\{strikeSideMode !== 'all' \? ' strike-ladder-two-cols--single-side' : ''\}`\}/g,
    "className={odStrikeLadderTwoColsClass(strikeSideMode !== 'all')}",
  )
  next = next.replace(
    /className=\{`od-iv-term-exp-item\$\{checked \? ' od-iv-term-exp-item--checked' : ''\}`\}/g,
    'className={odIvTermExpItemClass(checked)}',
  )
  next = next.replace(
    /className=\{`od-iv-sheet-hover\$\{warn \? ' od-iv-sheet-hover--warn' : ''\}`\}/g,
    'className={odIvSheetHoverClass(warn)}',
  )
  next = next.replace(
    /className=\{`od-analytics-skew-val od-analytics-skew-val--\$\{skewSign\}`\}/g,
    'className={odAnalyticsSkewValClass(skewSign)}',
  )

  next = next.replace(/className="([^"]*)"/g, (_, cls) => {
    if (!CLASS_RE.test(cls)) {
      CLASS_RE.lastIndex = 0
      return `className="${cls}"`
    }
    CLASS_RE.lastIndex = 0
    const expr = classStringToExpr(cls)
    return expr ? `className={${expr}}` : `className="${cls}"`
  })

  next = next.replace(/className='([^']*)'/g, (_, cls) => {
    if (!/(od-|option-discovery|strike-ladder|mp-|greeks-|option-greeks)/.test(cls)) return `className='${cls}'`
    const expr = classStringToExpr(cls)
    return expr ? `className={${expr}}` : `className='${cls}'`
  })

  next = next.replace(/className=\{`([^`]*(?:od-|option-discovery|strike-ladder|mp-|greeks-|option-greeks)[^`]*)`\}/g, (_, tmpl) => {
    const migrated = migrateTemplateLiteral(tmpl)
    return migrated ? `className={${migrated}}` : `className={\`${tmpl}\`}`
  })

  // row className with moneyClass variable
  next = next.replace(
    /className=\{`od-chain-row od-quote-row\$\{rowHighlight \? ' od-quote-row--selected' : ''\}\$\{moneyClass\}`\}/g,
    'className={cn(odChainRowClass({ atm, itm, selected: rowHighlight }), moneyClass)}',
  )

  next = next.replace(
    /className=\{`od-chain-td od-chain-td-data\$\{sideSelected \? ' od-chain-td--selected' : ''\}`\}/g,
    'className={odChainTdClass(sideSelected)}',
  )

  next = next.replace(
    /className=\{`od-chain-strike-cell\$\{callSel \|\| putSel \? ' od-chain-strike-cell--selected' : ''\}`\}/g,
    'className={odChainStrikeCellClass(callSel || putSel)}',
  )

  next = next.replace(
    /className=\{`option-discovery-exp-filter-btn \$\{expirationFilterKind === '([^']+)' \? 'active' : ''\}`\}/g,
    "className={odExpFilterBtnClass(expirationFilterKind === '$1')}",
  )

  // od-max-pain-svg od-chart-svg → helper
  next = next.replace(/className=\{cn\(od\.maxPainSvg, od\.chartSvg\)\}/g, 'className={odChartSvgClass()}')
  next = next.replace(/className=\{cn\(od\.maxPainSvg, od\.chartSvg, ([^)]+)\)\}/g, 'className={cn(odChartSvgClass(), $1)}')

  // Remaining quoted tokens in expressions
  next = next.replace(/'(od-[a-z0-9-]+(?:--[a-z0-9-]+)?)'/g, (match, cls) => {
    if (!isMigrateToken(cls)) return match
    return odRef(cls)
  })

  next = next.replace(/'(option-discovery-[a-z0-9-]+(?:--[a-z0-9-]+)?)'/g, (match, cls) => {
    if (!isMigrateToken(cls)) return match
    return odRef(cls)
  })

  next = next.replace(/'(strike-ladder[a-z0-9-]*(?:--[a-z0-9-]+)?)'/g, (match, cls) => {
    if (!isMigrateToken(cls)) return match
    return odRef(cls)
  })

  // className={rowWarn ? 'od-iv-data-row--cone-warn' : undefined}
  next = next.replace(
    /className=\{([a-zA-Z_]+) \? '(od-[a-z0-9-]+(?:--[a-z0-9-]+)?)' : undefined\}/g,
    'className={$1 ? $2 : undefined}'.replace('$2', (_, __, cls) => odRef(cls)),
  )
  next = next.replace(
    /className=\{([a-zA-Z_]+) \? '(od-[a-z0-9-]+(?:--[a-z0-9-]+)?)' : undefined\}/g,
    (_, cond, cls) => `className={${cond} ? ${odRef(cls)} : undefined}`,
  )

  next = next.replace(
    /className=\{([a-zA-Z_]+) \? '(od-[a-z0-9-]+(?:--[a-z0-9-]+)?)' : undefined\}/g,
    (_, cond, cls) => `className={${cond} ? ${odRef(cls)} : undefined}`,
  )

  // tr className={rowWarn ? 'od-iv-data-row--cone-warn' : undefined}
  // td className={rowWarn ? 'od-iv-data-cell--warn' : undefined}

  // option-greeks toggle
  next = next.replace(
    /className=\{`option-greeks-page__toggle\$\{rightFilter === v \? ' option-greeks-page__toggle--active' : ''\}`\}/g,
    'className={cn(od.optionGreeksToggle, rightFilter === v && od.optionGreeksToggleActive)}',
  )

  // greeks row classes
  next = next.replace(
    /className=\{`greeks-table__row greeks-table__row--\$\{row\.right\.toLowerCase\(\)\}`\}/g,
    'className={cn(od.greeksTableRow, row.right === "C" ? od.greeksTableRowCall : od.greeksTableRowPut)}',
  )

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

const targetRes = [
  'views/OptionDiscoveryPage.tsx',
  'views/OptionGreeksPage.tsx',
  'views/OptionScreenerPage.tsx',
  'views/optionDiscovery',
]

let changed = 0
for (const file of walk(srcRoot)) {
  const rel = path.relative(srcRoot, file).replace(/\\/g, '/')
  if (SKIP_FILES.has(rel)) continue
  const inScope =
    targetRes.some((t) => rel === t || rel.startsWith(t + '/')) ||
    rel.startsWith('views/optionDiscovery/')
  if (!inScope) continue

  const original = fs.readFileSync(file, 'utf8')
  if (!/(od-|option-discovery|strike-ladder|mp-|option-greeks|greeks-table|greeks-calc)/.test(original)) continue

  let migrated = migrateContent(original)
  migrated = addImports(migrated)

  if (migrated !== original) {
    fs.writeFileSync(file, migrated)
    changed++
    console.log('migrated:', rel)
  }
}

console.log(`Done. ${changed} file(s) updated.`)
