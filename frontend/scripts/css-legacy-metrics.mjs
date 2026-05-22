#!/usr/bin/env node
/**
 * Legacy CSS retirement metrics — run from frontend/: npm run css:metrics
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')
const stylesDir = path.join(srcRoot, 'styles')

import { findBannedInText } from './legacy-class-match.mjs'

const LEGACY_ALLOWLIST = new Set([
  path.join(srcRoot, 'components', 'ui', 'card.tsx'),
  path.join(srcRoot, 'components', 'shared', 'kpi-card.tsx'),
])

function lineCount(filePath) {
  if (!fs.existsSync(filePath)) return 0
  return fs.readFileSync(filePath, 'utf8').split('\n').length
}

function walkTsFiles(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const st = fs.statSync(full)
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walkTsFiles(full, acc)
    } else if (/\.(tsx|ts)$/.test(name)) {
      acc.push(full)
    }
  }
  return acc
}

function countBannedInFile(filePath) {
  return findBannedInText(fs.readFileSync(filePath, 'utf8'))
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

console.log('=== Legacy CSS retirement metrics ===\n')

const designTokensPath = path.join(stylesDir, 'design-tokens.css')
const appSurfacesPath = path.join(stylesDir, 'app-surfaces.css')
console.log(`legacy.css lines:        ${lineCount(path.join(stylesDir, 'legacy.css'))} (deleted when 0)`)
console.log(`app-surfaces.css lines:  ${lineCount(appSurfacesPath)}`)
console.log(`design-tokens.css lines: ${lineCount(designTokensPath)}`)
console.log('')

console.log('styles/*.css:')
for (const name of fs.readdirSync(stylesDir).sort()) {
  if (!name.endsWith('.css')) continue
  const full = path.join(stylesDir, name)
  const stat = fs.statSync(full)
  console.log(`  ${name.padEnd(24)} ${String(lineCount(full)).padStart(6)} lines  ${formatBytes(stat.size)}`)
}
console.log('')

const tsFiles = walkTsFiles(srcRoot)
const filesWithBanned = []
for (const f of tsFiles) {
  if (LEGACY_ALLOWLIST.has(f)) continue
  const hits = countBannedInFile(f)
  if (hits.length > 0) {
    filesWithBanned.push({ file: path.relative(frontendRoot, f), hits })
  }
}
console.log(`TS/TSX files with banned legacy class fragments: ${filesWithBanned.length}`)
if (filesWithBanned.length > 0 && process.argv.includes('--verbose')) {
  for (const { file, hits } of filesWithBanned.slice(0, 50)) {
    console.log(`  ${file}: ${hits.join(', ')}`)
  }
  if (filesWithBanned.length > 50) console.log(`  ... and ${filesWithBanned.length - 50} more`)
}
console.log('\nRun with --verbose to list files.')
