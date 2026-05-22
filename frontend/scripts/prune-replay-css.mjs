#!/usr/bin/env node
/**
 * Remove .replay-* rule blocks from app-surfaces.css when no TS/TSX file uses the class in className.
 * Keeps rules whose selectors also target non-replay hooks renamed for scope (ledger-trade-records-section).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const cssPath = path.join(__dirname, '../src/styles/app-surfaces.css')
const srcRoot = path.join(__dirname, '../src')

const RENAME = new Map([
  ['replay-section-trade-records', 'ledger-trade-records-section'],
  ['replay-strategy-opp-cell', 'ledger-strategy-opp-cell'],
])

function walk(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walk(full, acc)
    } else if (/\.(tsx|ts)$/.test(name)) acc.push(full)
  }
  return acc
}

const srcText = walk(srcRoot)
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n')

function classUsedInSource(className) {
  const renamed = RENAME.get(className) ?? className
  return srcText.includes(renamed) || srcText.includes(className)
}

function selectorUsesOnlyDeadReplay(selector) {
  const classes = [...selector.matchAll(/\.replay-[a-z0-9-]+/g)].map((m) => m[0].slice(1))
  if (classes.length === 0) return false
  return classes.every((c) => !classUsedInSource(c))
}

function parseRules(css) {
  const rules = []
  let i = 0
  while (i < css.length) {
    const start = i
    while (i < css.length && css[i] !== '{') {
      if (css[i] === '/' && css[i + 1] === '*') {
        const end = css.indexOf('*/', i + 2)
        i = end === -1 ? css.length : end + 2
        continue
      }
      i++
    }
    if (i >= css.length) break
    const selStart = start
    const selector = css.slice(selStart, i).trim()
    let depth = 0
    const bodyStart = i
    while (i < css.length) {
      if (css[i] === '{') depth++
      else if (css[i] === '}') {
        depth--
        if (depth === 0) {
          i++
          break
        }
      }
      i++
    }
    const chunk = css.slice(selStart, i)
    if (selector && !selector.startsWith('@')) {
      rules.push({ selector, chunk, start: selStart, end: i })
    }
  }
  return rules
}

let css = fs.readFileSync(cssPath, 'utf8')
const beforeLines = css.split('\n').length

for (const [from, to] of RENAME) {
  css = css.replaceAll(`.${from}`, `.${to}`)
}

const rules = parseRules(css)
let removed = 0
const chunksToRemove = []
for (const rule of rules) {
  if (!rule.selector.includes('replay-')) continue
  if (selectorUsesOnlyDeadReplay(rule.selector)) {
    chunksToRemove.push(rule)
    removed++
  }
}

// Remove from end to start
chunksToRemove.sort((a, b) => b.start - a.start)
for (const rule of chunksToRemove) {
  css = css.slice(0, rule.start) + css.slice(rule.end)
}

// Remove orphaned @keyframes only used by replay refresh
if (!css.includes('replay-fetch-refresh-spin') && css.includes('@keyframes replay-fetch-refresh-spin')) {
  css = css.replace(/@keyframes replay-fetch-refresh-spin\s*\{[^}]*\}\s*/g, '')
}

css = css.replace(/\n{4,}/g, '\n\n\n')
fs.writeFileSync(cssPath, css)
const afterLines = css.split('\n').length
console.log(`Removed ${removed} replay rule block(s). Lines: ${beforeLines} → ${afterLines} (−${beforeLines - afterLines})`)
