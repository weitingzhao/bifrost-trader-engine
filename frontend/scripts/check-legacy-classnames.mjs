#!/usr/bin/env node
/**
 * Fail if any TSX file outside legacy-class-allowlist.json uses banned legacy class fragments.
 * Run: npm run lint:legacy-classes
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')
const allowlistPath = path.join(__dirname, 'legacy-class-allowlist.json')

const BANNED = [
  'card', 'process-section', 'btn-', 'table-scroll', 'settings-page', 'lamp-icon',
  'app-header-', 'page-title-', 'wl2', 'od-detail', 'riv-',
]

const { files: allowed } = JSON.parse(fs.readFileSync(allowlistPath, 'utf8'))
const allowedSet = new Set(allowed)

const SKIP = new Set([
  'src/components/ui/card.tsx',
  'src/components/shared/kpi-card.tsx',
])

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

function classTokensFromAttr(classAttr) {
  return classAttr
    .split(/\s+/)
    .flatMap(token => token.split(/\$\{/)[0].trim())
    .filter(Boolean)
}

function findBanned(text) {
  const found = new Set()
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const cls = m[1] ?? m[2] ?? m[3] ?? ''
    for (const token of classTokensFromAttr(cls)) {
      for (const frag of BANNED) {
        if (frag.endsWith('-')) {
          if (token.includes(frag)) found.add(frag)
        } else if (token === frag) {
          found.add(frag)
        }
      }
    }
  }
  return [...found]
}

const violations = []
for (const full of walk(srcRoot)) {
  const rel = path.relative(frontendRoot, full).replace(/\\/g, '/')
  if (SKIP.has(rel) || allowedSet.has(rel)) continue
  const hits = findBanned(fs.readFileSync(full, 'utf8'))
  if (hits.length > 0) violations.push({ rel, hits })
}

if (violations.length === 0) {
  console.log('lint:legacy-classes OK (no banned classes outside allowlist)')
  process.exit(0)
}

console.error(`lint:legacy-classes: ${violations.length} file(s) use legacy classes but are not on the allowlist:\n`)
for (const { rel, hits } of violations) {
  console.error(`  ${rel}: ${hits.join(', ')}`)
}
console.error('\nMigrate to Tailwind/shadcn or add to allowlist via generate-legacy-class-allowlist.mjs only when intentionally deferring.')
process.exit(1)
