import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { loadServerPorts } from './scripts/loadServerPorts.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

function loadUiBuildLabelSync() {
  const pkgPath = path.join(__dirname, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
  const ver = pkg.version ?? '0.0.0'
  let sha = ''
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    }).trim()
  } catch {
    /* no .git */
  }
  const when = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`
  return sha ? `${ver} · ${sha} · ${when}` : `${ver} · ${when}`
}

let s
try {
  s = loadServerPorts()
} catch (e) {
  console.warn(
    '[next.config] loadServerPorts failed; API rewrites disabled until Python config is available.',
    e,
  )
  s = null
}

const MONITOR = s ? `http://127.0.0.1:${s.monitor_port}` : null
const MASSIVE = s ? `http://127.0.0.1:${s.massive_port}` : null
const DOCS = s ? `http://127.0.0.1:${s.docs_port}` : null
const OPS = s ? `http://127.0.0.1:${s.ops_port}` : null
const TRADING = s ? `http://127.0.0.1:${s.trading_port}` : null
const STRATEGY = s ? `http://127.0.0.1:${s.strategy_port}` : null
const PORTFOLIO = s ? `http://127.0.0.1:${s.portfolio_port}` : null
const MARKET = s ? `http://127.0.0.1:${s.market_port}` : null
const RESEARCH = s ? `http://127.0.0.1:${s.research_port}` : null

function devRewrites() {
  if (!MONITOR) return []
  return [
    {
      source: '/executions/strategy-attribution/:path*',
      destination: `${PORTFOLIO}/executions/strategy-attribution/:path*`,
    },
    { source: '/ops/:path*', destination: `${OPS}/ops/:path*` },
    { source: '/ops', destination: `${OPS}/ops` },
    { source: '/status/:path*', destination: `${MONITOR}/status/:path*` },
    { source: '/health', destination: `${MONITOR}/health` },
    { source: '/operations/:path*', destination: `${MONITOR}/operations/:path*` },
    { source: '/quotes/:path*', destination: `${MARKET}/quotes/:path*` },
    { source: '/research/massive/:path*', destination: `${MASSIVE}/research/massive/:path*` },
    { source: '/research/docs/:path*', destination: `${DOCS}/research/docs/:path*` },
    { source: '/research/option/:path*', destination: `${RESEARCH}/research/option/:path*` },
    { source: '/research/screening/:path*', destination: `${RESEARCH}/research/screening/:path*` },
    { source: '/research/data/:path*', destination: `${RESEARCH}/research/data/:path*` },
    { source: '/research/screener/:path*', destination: `${RESEARCH}/research/screener/:path*` },
    { source: '/research/greeks/:path*', destination: `${RESEARCH}/research/greeks/:path*` },
    { source: '/research/iv-term-structure/:path*', destination: `${RESEARCH}/research/iv-term-structure/:path*` },
    { source: '/research/iv-volatility-cone/:path*', destination: `${RESEARCH}/research/iv-volatility-cone/:path*` },
    { source: '/research/max-pain/:path*', destination: `${RESEARCH}/research/max-pain/:path*` },
    { source: '/research/put-call-ratio/:path*', destination: `${RESEARCH}/research/put-call-ratio/:path*` },
    { source: '/risk_summary/:path*', destination: `${MONITOR}/risk_summary/:path*` },
    { source: '/executions/:path*', destination: `${TRADING}/executions/:path*` },
    { source: '/performance/:path*', destination: `${TRADING}/performance/:path*` },
    { source: '/transactions/:path*', destination: `${TRADING}/transactions/:path*` },
    { source: '/bars/:path*', destination: `${MARKET}/bars/:path*` },
    { source: '/indices/:path*', destination: `${MARKET}/indices/:path*` },
    { source: '/market/:path*', destination: `${MARKET}/market/:path*` },
    { source: '/watchlist/:path*', destination: `${MARKET}/watchlist/:path*` },
    { source: '/position-categories/:path*', destination: `${MONITOR}/position-categories/:path*` },
    { source: '/portfolio/:path*', destination: `${PORTFOLIO}/portfolio/:path*` },
    { source: '/positions/:path*', destination: `${MONITOR}/positions/:path*` },
    { source: '/control/:path*', destination: `${MONITOR}/control/:path*` },
    { source: '/account-sync/:path*', destination: `${MONITOR}/account-sync/:path*` },
    { source: '/strategies/:path*', destination: `${STRATEGY}/strategies/:path*` },
    { source: '/api/:path*', destination: `${MONITOR}/api/:path*` },
    { source: '/config/:path*', destination: `${MONITOR}/config/:path*` },
    { source: '/docs/:path*', destination: `${MONITOR}/docs/:path*` },
    { source: '/openapi.json', destination: `${MONITOR}/openapi.json` },
  ]
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_UI_BUILD_LABEL: loadUiBuildLabelSync(),
  },
  async rewrites() {
    if (process.env.NODE_ENV === 'production') {
      return { beforeFiles: [], afterFiles: [], fallback: [] }
    }
    const rules = devRewrites()
    return {
      beforeFiles: rules.map((r) => ({
        ...r,
        missing: [{ type: 'header', key: 'sec-fetch-dest', value: 'document' }],
      })),
      afterFiles: [],
      fallback: [],
    }
  },
}

export default nextConfig
