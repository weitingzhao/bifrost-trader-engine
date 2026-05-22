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

import { findBannedInText } from './legacy-class-match.mjs'

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

const violations = []
for (const full of walk(srcRoot)) {
  const rel = path.relative(frontendRoot, full).replace(/\\/g, '/')
  if (SKIP.has(rel) || allowedSet.has(rel)) continue
  const hits = findBannedInText(fs.readFileSync(full, 'utf8'))
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
