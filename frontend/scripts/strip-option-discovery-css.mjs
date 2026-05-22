#!/usr/bin/env node
/** Remove od-* / option-discovery-* / strike-ladder* / #od-layer* / mp-* blocks from app-surfaces.css */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cssPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/styles/app-surfaces.css')
const css = fs.readFileSync(cssPath, 'utf8')

const SKIP_SELECTOR =
  /^(\.(od-|option-discovery-|strike-ladder|mp-)|#od-layer|\/\* Option Discovery|\/\* ---------- Option Discovery)/

function shouldSkipSelector(selector) {
  const s = selector.trim()
  if (SKIP_SELECTOR.test(s)) return true
  if (s.includes('.od-') || s.includes('.option-discovery-') || s.includes('.strike-ladder')) return true
  if (s.startsWith('#od-layer')) return true
  if (/^\.mp-/.test(s.split(/[,\s]/)[0])) return true
  return false
}

const out = []
let i = 0
while (i < css.length) {
  const nextRule = css.indexOf('{', i)
  if (nextRule === -1) {
    out.push(css.slice(i))
    break
  }
  const selector = css.slice(i, nextRule)
  const close = css.indexOf('}', nextRule)
  if (close === -1) {
    out.push(css.slice(i))
    break
  }
  const block = css.slice(i, close + 1)
  if (!shouldSkipSelector(selector)) {
    out.push(block)
  }
  i = close + 1
}

const nextCss = out.join('')
fs.writeFileSync(cssPath, nextCss)
const before = css.split('\n').length
const after = nextCss.split('\n').length
console.log(`Stripped option-discovery CSS: ${before} → ${after} lines (${before - after} removed)`)
