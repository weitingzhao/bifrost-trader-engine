#!/usr/bin/env node
/** Regenerate allowlist of TSX files that may still use legacy class names until migrated. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')

const BANNED = [
  'card', 'process-section', 'btn-', 'table-scroll', 'settings-page', 'lamp-icon',
  'app-header-', 'page-title-', 'wl2', 'od-detail', 'riv-',
]
const SKIP = new Set([
  path.join(srcRoot, 'components', 'ui', 'card.tsx'),
  path.join(srcRoot, 'components', 'shared', 'kpi-card.tsx'),
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

function hasBanned(text) {
  for (const frag of BANNED) {
    const re = new RegExp(`className\\s*=\\s*['"\`][^'"\`]*\\b${frag.replace(/-/g, '\\-')}`)
    if (re.test(text)) return true
  }
  return false
}

const allowed = []
for (const f of walk(srcRoot)) {
  if (SKIP.has(f)) continue
  if (hasBanned(fs.readFileSync(f, 'utf8'))) {
    allowed.push(path.relative(frontendRoot, f).replace(/\\/g, '/'))
  }
}
allowed.sort()
const out = path.join(__dirname, 'legacy-class-allowlist.json')
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), files: allowed }, null, 2) + '\n')
console.log(`Wrote ${allowed.length} paths to ${out}`)
