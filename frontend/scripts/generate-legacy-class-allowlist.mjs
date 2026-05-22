#!/usr/bin/env node
/** Regenerate allowlist of TSX files that may still use legacy class names until migrated. */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')

import { findBannedInText } from './legacy-class-match.mjs'

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

const allowed = []
for (const f of walk(srcRoot)) {
  if (SKIP.has(f)) continue
  if (findBannedInText(fs.readFileSync(f, 'utf8')).length > 0) {
    allowed.push(path.relative(frontendRoot, f).replace(/\\/g, '/'))
  }
}
allowed.sort()
const out = path.join(__dirname, 'legacy-class-allowlist.json')
fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), files: allowed }, null, 2) + '\n')
console.log(`Wrote ${allowed.length} paths to ${out}`)
