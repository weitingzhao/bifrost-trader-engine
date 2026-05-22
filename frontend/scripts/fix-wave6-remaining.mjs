#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src')

const REPLACEMENTS = [
  [/"ref-jobs-active-pill"/g, 'rj.activePill'],
  [/'ref-jobs-sheet ref-jobs-sheet--wide'/g, 'cn(rj.sheet, rj.sheetWide)'],
  [/'ref-jobs-sheet'/g, 'rj.sheet'],
  [/'ref-jobs-sheet-meta'/g, 'rj.sheetMeta'],
  [
    /className=\{`data-overview-focus-chips__chip\$\{isCodeDatasetChip\(v\) \? ' data-overview-focus-chips__chip--code' : ''\}`\}/g,
    'className={cn(do.focusChipsChip, isCodeDatasetChip(v) && do.focusChipsChipCode)}',
  ],
  [
    /className=\{`data-overview-focus-chips__chip\$\{isCodeDatasetChip\(\) \? ' data-overview-focus-chips__chip--code' : ''\}`\}/g,
    'className={cn(do.focusChipsChip, isCodeDatasetChip() && do.focusChipsChipCode)}',
  ],
  [/"data-overview-focus-chips__legend"/g, 'do.focusChipsLegend'],
  [/"data-overview-focus-chips__legend-text"/g, 'do.focusChipsLegendText'],
  [/'data-overview-focus-chips__legend'/g, 'do.focusChipsLegend'],
  [/'data-overview-focus-chips__legend-text'/g, 'do.focusChipsLegendText'],
  [
    /className=\{inPool \? 'data-overview-wl-matrix__row--pool' : undefined\}/g,
    'className={inPool ? do.wlMatrixRowPool : undefined}',
  ],
  [
    /className=\{inPool\s+\? 'data-overview-wl-matrix__row--pool'/g,
    'className={inPool ? do.wlMatrixRowPool',
  ],
  [
    /className=\{hasGap \? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--bad' : ''\}/g,
    'className={hasGap ? cn(do.wlMatrixCompletenessPct, do.wlMatrixCompletenessPctBad) : undefined}',
  ],
  [
    /\? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--ok'/g,
    '? cn(do.wlMatrixCompletenessPct, do.wlMatrixCompletenessPctOk)',
  ],
  [
    /\? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--warn'/g,
    '? cn(do.wlMatrixCompletenessPct, do.wlMatrixCompletenessPctWarn)',
  ],
  [
    /\? 'data-overview-wl-matrix__completeness-pct data-overview-wl-matrix__completeness-pct--bad'/g,
    '? cn(do.wlMatrixCompletenessPct, do.wlMatrixCompletenessPctBad)',
  ],
  [
    /className=\{gapRollup\.totalGap > 0 \? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn' : ''\}/g,
    'className={gapRollup.totalGap > 0 ? cn(do.refStripCovPct, do.refStripCovPctWarn) : undefined}',
  ],
  [
    /className=\{\(g\.gap ?? 0\) > 0 \? 'data-overview-ref-strip__cov-pct data-overview-ref-strip__cov-pct--warn' : ''\}/g,
    'className={(g.gap ?? 0) > 0 ? cn(do.refStripCovPct, do.refStripCovPctWarn) : undefined}',
  ],
  [
    /: 'data-overview-gap-sheet__metric data-overview-gap-sheet__metric--na'/g,
    ": cn(do.gapSheetMetric, do.gapSheetMetricNa)",
  ],
  [
    /: 'data-overview-ref-strip__gap-num'/g,
    ': do.refStripGapNum',
  ],
  [
    /: 'data-overview-ref-strip__cov-pct'/g,
    ': do.refStripCovPct',
  ],
]

function ensureImports(content) {
  let next = content
  const needsDo = /\bdo\./.test(next)
  const needsRj = /\brj\./.test(next)
  const needsCn = /\bcn\(/.test(next)
  if (needsDo && !next.includes("from '@/views/dataOverview/dataOverviewClasses'")) {
    next = `import { dov } from '@/views/dataOverview/dataOverviewClasses'\n${next}`
  }
  if (needsRj && !next.includes("from '@/views/massive/refJobsClasses'")) {
    next = `import { rj } from '@/views/massive/refJobsClasses'\n${next}`
  }
  if (needsCn && !next.includes("from '@/lib/utils'")) {
    next = `import { cn } from '@/lib/utils'\n${next}`
  }
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
  let content = fs.readFileSync(file, 'utf8')
  if (!/data-overview-|ref-jobs-|architecture-console-/.test(content)) continue
  const original = content
  for (const [re, rep] of REPLACEMENTS) {
    content = content.replace(re, rep)
  }
  content = ensureImports(content)
  if (content !== original) {
    fs.writeFileSync(file, content)
    changed++
    console.log('fixed:', path.relative(srcRoot, file))
  }
}
console.log(`Fixed ${changed} files`)
