// Сборка демо-страницы (preview.html) одним файлом: npm run build:preview
import { defineConfig } from 'vite'
import { resolve } from 'node:path'

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-preview',
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    modulePreload: false,
    rollupOptions: { input: resolve(__dirname, 'preview.html') },
  },
})
