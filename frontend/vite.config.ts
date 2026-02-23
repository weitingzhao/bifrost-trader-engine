import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/status': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/operations': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/control': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/config': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/docs': { target: 'http://127.0.0.1:8765', changeOrigin: true },
      '/openapi.json': { target: 'http://127.0.0.1:8765', changeOrigin: true },
    },
  },
})
