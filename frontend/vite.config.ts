import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: ['labtop-vs-mac-pro'],
    proxy: {
      '/ops': {
        target: 'http://127.0.0.1:8768',
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
      '/status': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/health': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/operations': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/quotes': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/research/massive': { target: 'http://127.0.0.1:8766', changeOrigin: true },
      '/research/docs': { target: 'http://127.0.0.1:8767', changeOrigin: true },
      '/research': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/risk_summary': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/executions': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/performance': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/transactions': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/bars': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/indices': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/market': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/watchlist': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/position-categories': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/positions': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/portfolio': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/control': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/strategies': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/config': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/docs': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/openapi.json': { target: 'http://127.0.0.1:8765', changeOrigin: true },
    },
  },
})
