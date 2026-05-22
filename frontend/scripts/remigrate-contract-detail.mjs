#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const p = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/views/optionDiscovery/OptionContractDetailPanel.tsx')
let t = fs.readFileSync(p, 'utf8')

// Remove local Tailwind constant block (already in od.detail*)
t = t.replace(
  /const odPanelHeaderCls =[\s\S]*?const odPanelSectionTitleCls =[\s\S]*?\n(?=import )/,
  '',
)

const PANEL_MAP = {
  odPanelHeaderCls: 'od.detailHeader',
  odPanelTitleCls: 'od.detailTitle',
  odPanelExpiryCls: 'od.detailExpiry',
  odPanelDelayedCls: 'od.detailDelayed',
  odPanelSectionCls: 'od.detailSection',
  odPanelSectionTitleCls: 'od.detailSectionTitle',
}

for (const [from, to] of Object.entries(PANEL_MAP)) {
  t = t.replaceAll(`className={${from}}`, `className={${to}}`)
  t = t.replaceAll(`className={${from} `, `className={${to} `)
}

function toCamel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase()).replace(/__([a-z0-9])/g, (_, c) => c.toUpperCase())
}
function odRef(className) {
  let body = className
  let modifier = ''
  if (body.includes('--')) [body, modifier] = body.split('--')
  if (body.startsWith('od-')) body = body.slice(3)
  let key = toCamel(body)
  if (modifier) key += toCamel(modifier).replace(/^./, (c) => c.toUpperCase())
  return `od.${key}`
}

function cnExpr(str) {
  const toks = str.trim().split(/\s+/).filter(Boolean)
  const odToks = toks.filter((x) => x.startsWith('od-'))
  const keep = toks.filter((x) => !x.startsWith('od-'))
  if (!odToks.length) return null
  const parts = [...keep.map((k) => `'${k}'`), ...odToks.map(odRef)]
  return parts.length === 1 ? parts[0] : `cn(${parts.join(', ')})`
}

t = t.replace(/className="([^"]*)"/g, (_, cls) => {
  const e = cnExpr(cls)
  return e ? `className={${e}}` : `className="${cls}"`
})

t = t.replace(/className=\{`([^`]*)`\}/g, (_, tmpl) => {
  if (tmpl.includes('od-moneyness-badge')) return 'className={odMoneynessBadgeClass(selectedDerived.moneynessLabel)}'
  if (tmpl.includes("greeksSource === 'snapshot'")) return "className={odGreeksSourceBtnClass(greeksSource === 'snapshot')}"
  if (tmpl.includes("greeksSource === 'bs'")) return "className={odGreeksSourceBtnClass(greeksSource === 'bs')}"
  if (tmpl.includes('od-tradability-value od-tradability-')) {
    return "className={cn(od.tradabilityValue, tradability.score >= 60 ? od.tradabilityGood : tradability.score >= 30 ? od.tradabilityFair : od.tradabilityPoor)}"
  }
  if (tmpl.includes('od-rv-label od-rv-label--')) {
    return 'className={cn(od.kvV, od.rvLabel, rvLabel === "Rich" ? od.rvLabelRich : rvLabel === "Cheap" ? od.rvLabelCheap : od.rvLabelNeutral)}'
  }
  const e = cnExpr(tmpl)
  return e ? `className={${e}}` : `className={\`${tmpl}\`}`
})

t = t.replace(
  /className=\{`\$\{odPanelSectionCls\} od-bs-compare`\}/g,
  'className={cn(od.detailSection, od.bsCompare)}',
)

t = t.replace(/className=\{\`od-bs-diff od-bs-diff--\$\{([^}]+)\}\`\}/g, 'className={odBsDiffClass($1)}')
t = t.replace(/className=\{\`od-bs-diff \$\{([^}]+)\}\`\}/g, 'className={cn(odBsDiffClass($1), od.bsDiff)}')

if (!t.includes("from './optionDiscoveryClasses'")) {
  t = `import { cn } from '@/lib/utils'\nimport { od, odMoneynessBadgeClass, odGreeksSourceBtnClass, odBsDiffClass } from './optionDiscoveryClasses'\n${t}`
}

t = t.replace(
  /className=\{cn\(od\.contractDetailStack, '\[&>:first-child\]:border-t-0'\)\}/g,
  "className={cn('[&>:first-child]:border-t-0', od.contractDetailStack)}",
)
t = t.replace(
  /className=\{cn\('\[&>:first-child\]:border-t-0', od\.contractDetailStack\)\}/g,
  "className={cn('[&>:first-child]:border-t-0', od.contractDetailStack)}",
)

// diffClass fn -> use odBsDiffClass
t = t.replace(
  /function diffClass\(pct: number \| null\): 'ok' \| 'warn' \| 'alert' \{\n[\s\S]*?\n\}\n\n/,
  '',
)
t = t.replace(/diffClass\(/g, 'odBsDiffClass(')

// odBsDiffClass returns class string; wrap pct helper
t = t.replace(
  /function odBsDiffClass\(pct: number \| null\): 'ok' \| 'warn' \| 'alert'/,
  "function diffClassKind(pct: number | null): 'ok' | 'warn' | 'alert'",
)
t = t.replace(/odBsDiffClass\((ivDiff|deltaDiff|gammaDiff|thetaDiff|vegaDiff)\)/g, 'odBsDiffClass(diffClassKind($1))')

fs.writeFileSync(p, t)
console.log('OK lines', t.split('\n').length)
