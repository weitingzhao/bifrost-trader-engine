#!/usr/bin/env node
/** Fix broken `className={`fm.xxx` template literals from first migration pass. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.resolve(__dirname, '../src')

function fixTemplateLiteral(tmpl) {
  // fm.card fm.capSection${expanded ? ' fm.capSectionExpanded' : ' fm.capSectionCollapsed'}${highlight ? ' feed-massive-card--cap-active' : ''}
  if (tmpl.includes('fm.card fm.capSection')) {
    const highlightMatch = tmpl.match(/\$\{highlight \? ' feed-massive-card--cap-active' : ''\}/)
    if (highlightMatch) {
      return 'cn(feedMassiveCapPanelClass(highlight))'
    }
    return 'cn(fm.card, fm.capSection)'
  }

  // fm.capPanelChevron${expanded ? ' fm.capPanelChevronOpen' : ''}
  const chevron = tmpl.match(/^fm\.capPanelChevron\$\{(\w+) \? ' fm\.capPanelChevronOpen' : ''\}$/)
  if (chevron) return `cn(fm.capPanelChevron, ${chevron[1]} && fm.capPanelChevronOpen)`

  const capGroupChevron = tmpl.match(/^fm\.capGroupChevron\$\{(\w+) \? ' fm\.capGroupChevronOpen' : ''\}$/)
  if (capGroupChevron) return `cn(fm.capGroupChevron, ${capGroupChevron[1]} && fm.capGroupChevronOpen)`

  // fm.aggTab${x ? ' fm.aggTabActive' : ''}
  const aggTab = tmpl.match(/^fm\.aggTab\$\{(.+?) \? ' fm\.aggTabActive' : ''\}$/)
  if (aggTab) return `cn(fm.aggTab, ${aggTab[1]} && fm.aggTabActive)`

  // fm.aggTab${x ? ' active' : ''}  (broken partial migration)
  const aggTabBroken = tmpl.match(/^fm\.aggTab\$\{(.+?) \? ' active' : ''\}$/)
  if (aggTabBroken) return `cn(fm.aggTab, ${aggTabBroken[1]} && fm.aggTabActive)`

  // fm.deliveryTab${x ? ' fm.deliveryTabActive' : ''}
  const delTab = tmpl.match(/^fm\.deliveryTab\$\{(.+?) \? ' fm\.deliveryTabActive' : ''\}$/)
  if (delTab) return `cn(fm.deliveryTab, ${delTab[1]} && fm.deliveryTabActive)`

  // fm.tabChip${x ? ' fm.tabChipActive' : ''}
  const chip = tmpl.match(/^fm\.tabChip\$\{(.+?) \? ' fm\.tabChipActive' : ''\}$/)
  if (chip) return `cn(fm.tabChip, ${chip[1]} && fm.tabChipActive)`

  // fm.capGroupToggle${x ? ' fm.capGroupToggleActive' : ''}
  const toggle = tmpl.match(/^fm\.capGroupToggle\$\{(.+?) \? ' fm\.capGroupToggleActive' : ''\}$/)
  if (toggle) return `cn(fm.capGroupToggle, ${toggle[1]} && fm.capGroupToggleActive)`

  // ${feedMassiveDailyBadgeClass(...)}${spinning ? ' feed-massive-daily-badge--busy' : ''}
  const dailyBadge = tmpl.match(/^\$\{feedMassiveDailyBadgeClass\(([^)]+)\)\}\$\{spinning \? ' feed-massive-daily-badge--busy' : ''\}$/)
  if (dailyBadge) return `cn(feedMassiveDailyBadgeClass(${dailyBadge[1]}), spinning && fm.dailyBadgeBusy)`

  return null
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
  let next = content

  next = next.replace(/className=\{`([^`]+)`\}/g, (full, tmpl) => {
    if (!tmpl.includes('fm.') && !tmpl.includes('feed-massive')) return full
    const fixed = fixTemplateLiteral(tmpl)
    return fixed ? `className={${fixed}}` : full
  })

  next = next.replace(
    /\?\s*'feed-massive-svc-work feed-massive-svc-work--split'\s*:\s*'feed-massive-svc-work'/g,
    '? cn(fm.svcWork, fm.svcWorkSplit) : fm.svcWork',
  )

  if (next !== content) {
    if (next.includes('feedMassiveCapPanelClass') && !next.includes("feedMassiveCapPanelClass } from '@/views/feed/feedMassiveStyles'")) {
      // already imported via fm import line
    }
    fs.writeFileSync(file, next)
    changed++
    console.log('fixed:', path.relative(srcRoot, file))
  }
}

console.log(`Fixed ${changed} file(s).`)
