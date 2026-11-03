import react from '@vitejs/plugin-react'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

// Static build for GitHub Pages: `pnpm build:static` (BASE defaults to /tendertransparency/).
// GitHub Pages serves 404.html for unknown paths, so a copy of index.html makes deep links work.
const spaFallback = (): Plugin => ({
  name: 'spa-404-fallback',
  apply: 'build',
  closeBundle() {
    if (process.env.VITE_STATIC === '1') copyFileSync(resolve('dist/index.html'), resolve('dist/404.html'))
  },
})

export default defineConfig({
  base: process.env.VITE_STATIC === '1' ? (process.env.BASE ?? '/tendertransparency/') : '/',
  plugins: [react(), spaFallback()],
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  server: { proxy: { '/api': 'http://127.0.0.1:8000' } },
})
