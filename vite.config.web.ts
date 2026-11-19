import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// 仅用于在浏览器中预览渲染层（渲染进程使用 mockApi）
export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@': resolve('src/renderer')
    }
  },
  build: {
    outDir: resolve('.preview'),
    emptyOutDir: true
  },
  server: { port: 5183 },
  preview: { port: 5183 }
})
