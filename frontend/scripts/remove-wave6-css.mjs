#!/usr/bin/env node
/** Remove migrated data-overview-* and ref-jobs-* rules from app-surfaces.css */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/app-surfaces.css')
let css = fs.readFileSync(cssPath, 'utf8')

const REMOVE_PREFIXES = ['.data-overview-', '.ref-jobs-']

function shouldRemoveSelector(selector) {
  const parts = selector.split(',').map(s => s.trim())
  return parts.every(part => REMOVE_PREFIXES.some(p => part.includes(p)))
}

const blockRe = /([^{/\n][^{]*)\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g
let removed = 0
css = css.replace(blockRe, (full, sel, body) => {
  const selector = sel.trim()
  if (!shouldRemoveSelector(selector)) return full
  removed++
  return ''
})

css = css.replace(/\n{3,}/g, '\n\n')
fs.writeFileSync(cssPath, css)
console.log(`Removed ${removed} CSS blocks from app-surfaces.css`)
