#!/usr/bin/env node
/**
 * List CSS selectors in domain stylesheets with no matching class token in TSX.
 * Run: npm run css:dead-rules
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const frontendRoot = path.resolve(__dirname, '..')
const srcRoot = path.join(frontendRoot, 'src')
const stylesDir = path.join(srcRoot, 'styles')

const DOMAIN_CSS = [
  'message-center.css',
]

function walkTsx(dir, acc = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '.next') continue
      walkTsx(full, acc)
    } else if (/\.tsx$/.test(name)) acc.push(full)
  }
  return acc
}

function collectTsxTokens() {
  const tokens = new Set()
  const re = /className\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g
  for (const f of walkTsx(srcRoot)) {
    const text = fs.readFileSync(f, 'utf8')
    let m
    while ((m = re.exec(text)) !== null) {
      const cls = m[1] ?? m[2] ?? m[3] ?? ''
      for (const t of cls.split(/\s+/)) {
        const tok = t.split(/\$\{/)[0].trim()
        if (tok) tokens.add(tok)
      }
    }
  }
  return tokens
}

function selectorsFromCss(css) {
  const out = []
  for (const m of css.matchAll(/^\.([a-zA-Z0-9_-]+)/gm)) out.push(m[1])
  return out
}

const tsxTokens = collectTsxTokens()
console.log('=== CSS dead-rule hints (selector not in any TSX className token) ===\n')
console.log(`TSX unique tokens: ${tsxTokens.size}\n`)

for (const file of DOMAIN_CSS) {
  const full = path.join(stylesDir, file)
  if (!fs.existsSync(full)) continue
  const css = fs.readFileSync(full, 'utf8')
  const selectors = selectorsFromCss(css)
  const unused = selectors.filter((s) => {
    if (tsxTokens.has(s)) return false
    const prefix = s.split('__')[0].split('--')[0]
    for (const t of tsxTokens) {
      if (t === s || t.startsWith(s + '-') || t.startsWith(s + '__') || t.startsWith(prefix + '-'))
        return false
    }
    return true
  })
  console.log(`${file}: ${selectors.length} top-level selectors, ~${unused.length} with no direct TSX token`)
  if (process.argv.includes('--verbose')) {
    for (const u of unused.slice(0, 40)) console.log(`  .${u}`)
    if (unused.length > 40) console.log(`  ... +${unused.length - 40} more`)
  }
  console.log('')
}

console.log('Note: unused selectors may still apply via descendants, modifiers, or dynamic class names.')
