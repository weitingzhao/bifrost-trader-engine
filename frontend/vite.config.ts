import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Dev proxy targets — align with config YAML server.*_port (default bifrost split ports). */
const MONITOR = 'http://127.0.0.1:8765'
const MASSIVE = 'http://127.0.0.1:8766'
const DOCS = 'http://127.0.0.1:8767'
const OPS = 'http://127.0.0.1:8768'
const TRADING = 'http://127.0.0.1:8769'
const STRATEGY = 'http://127.0.0.1:8770'
const PORTFOLIO = 'http://127.0.0.1:8771'
const MARKET = 'http://127.0.0.1:8772'
const RESEARCH = 'http://127.0.0.1:8773'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['labtop-vs-mac-pro'],
    proxy: {
      // Portfolio-only execution path (must be before /executions → trading)
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
