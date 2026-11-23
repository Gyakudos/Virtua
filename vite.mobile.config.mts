import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const root = fileURLToPath(new URL('./src/mobile', import.meta.url))
const outDir = fileURLToPath(new URL('./dist-mobile', import.meta.url))

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022'
  }
})
