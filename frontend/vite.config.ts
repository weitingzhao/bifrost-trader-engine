import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

/** Proxy targets come from merged YAML (same as Python read_config); no hardcoded listen ports. */
function pickPython(): string {
  const unixVenv = path.join(projectRoot, '.venv', 'bin', 'python')
  if (fs.existsSync(unixVenv)) return unixVenv
  const winVenv = path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
  if (fs.existsSync(winVenv)) return winVenv
  return 'python3'
}

function loadServerPorts(): Record<string, number> {
  const py = pickPython()
  const code = [
    'import json,sys',
    `sys.path.insert(0, ${JSON.stringify(projectRoot)})`,
    'from src.app.config import read_config',
    'c,_=read_config()',
    'print(json.dumps(c["server"]))',
  ].join('; ')
  try {
    const out = execFileSync(py, ['-c', code], {
      cwd: projectRoot,
      encoding: 'utf-8',
      env: { ...process.env },
    }).trim()
    return JSON.parse(out) as Record<string, number>
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(
      `Vite dev proxy: could not load server ports from merged YAML (${py}). ` +
        `Align BIFROST_CONFIG / BIFROST_ENV with your Python APIs and ensure all server.* listen ports are set. ${msg}`,
    )
  }
}

const s = loadServerPorts()
const MONITOR = `http://127.0.0.1:${s.monitor_port}`
const MASSIVE = `http://127.0.0.1:${s.massive_port}`
const DOCS = `http://127.0.0.1:${s.docs_port}`
const OPS = `http://127.0.0.1:${s.ops_port}`
const TRADING = `http://127.0.0.1:${s.trading_port}`
const STRATEGY = `http://127.0.0.1:${s.strategy_port}`
const PORTFOLIO = `http://127.0.0.1:${s.portfolio_port}`
const MARKET = `http://127.0.0.1:${s.market_port}`
const RESEARCH = `http://127.0.0.1:${s.research_port}`

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['labtop-vs-mac-pro'],
    proxy: {
      '^/executions/strategy-attribution': { target: PORTFOLIO, changeOrigin: true },
      '/ops': {
        target: OPS,
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      '/status': { target: MONITOR, changeOrigin: true },
      '/health': { target: MONITOR, changeOrigin: true },
      '/operations': { target: MONITOR, changeOrigin: true },
      '/quotes': { target: MARKET, changeOrigin: true },
      '/research/massive': { target: MASSIVE, changeOrigin: true },
      '/research/docs': { target: DOCS, changeOrigin: true },
      '/research/option': { target: RESEARCH, changeOrigin: true },
      '/research/iv-term-structure': { target: RESEARCH, changeOrigin: true },
      '/research/max-pain': { target: RESEARCH, changeOrigin: true },
      '/risk_summary': { target: MONITOR, changeOrigin: true },
      '/executions': { target: TRADING, changeOrigin: true },
      '/performance': { target: TRADING, changeOrigin: true },
      '/transactions': { target: TRADING, changeOrigin: true },
      '/bars': { target: MARKET, changeOrigin: true },
      '/indices': { target: MARKET, changeOrigin: true },
      '/market': { target: MARKET, changeOrigin: true },
      '/watchlist': { target: MARKET, changeOrigin: true },
      '/position-categories': { target: PORTFOLIO, changeOrigin: true },
      '/portfolio': { target: PORTFOLIO, changeOrigin: true },
      '/positions': { target: MONITOR, changeOrigin: true },
      '/control': { target: MONITOR, changeOrigin: true },
      '/strategies': { target: STRATEGY, changeOrigin: true },
      '/api': { target: MONITOR, changeOrigin: true },
      '/config': { target: MONITOR, changeOrigin: true },
      '/docs': { target: MONITOR, changeOrigin: true },
      '/openapi.json': { target: MONITOR, changeOrigin: true },
    },
  },
})
