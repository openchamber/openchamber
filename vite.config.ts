import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { themeStoragePlugin } from './vite-theme-plugin'
import { paraglideVitePlugin } from '@inlang/paraglide-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    themeStoragePlugin(),
    paraglideVitePlugin({
      project: './packages/ui/project.inlang',
      outdir: './packages/ui/src/paraglide',
    }),
  ],
  resolve: {
    alias: [
      { find: '@opencode-ai/sdk/v2', replacement: path.resolve(__dirname, './node_modules/@opencode-ai/sdk/dist/v2/client.js') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
  },
  optimizeDeps: {
    include: ['@opencode-ai/sdk/v2'],
  },
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined

          const match = id.split('node_modules/')[1]
          if (!match) return undefined

          const segments = match.split('/')
          const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react'
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand'
          if (packageName === '@opencode-ai/sdk') return 'vendor-opencode-sdk'
          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown'
          if (packageName.startsWith('@radix-ui')) return 'vendor-radix'
          if (packageName.includes('react-syntax-highlighter') || packageName.includes('highlight.js')) return 'vendor-syntax'

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-')
          return `vendor-${sanitized}`
        },
      },
    },
  },
})
