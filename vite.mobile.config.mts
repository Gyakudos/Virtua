import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('./src/mobile', import.meta.url))
const outDir = fileURLToPath(new URL('./dist-mobile', import.meta.url))

export default defineConfig({
  // Android loads index.html from file:///android_asset/public/index.html,
  // so assets must be relative or they resolve to file:///assets/... and never load.
  base: './',
  root,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022'
  }
})
