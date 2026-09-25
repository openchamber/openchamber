import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { themeStoragePlugin } from './vite-theme-plugin'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    react(),
    themeStoragePlugin(),
  ],
  resolve: {
    alias: [
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
  build: {
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        manualChunks(id) {
          // Pin Vite's tiny runtime helpers to their own stable chunk. Otherwise
          // Rollup co-locates the `__vitePreload` helper into an arbitrary vendor
          // chunk (e.g. `shiki`), and since every dynamic import pulls the helper,
          // that whole vendor (here Shiki core + the 629KB oniguruma engine) gets
          // dragged into the eager bootstrap graph.
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vendor-vite-runtime'
          }
          if (!id.includes('node_modules')) return undefined

          // Resolve the real package from the LAST `node_modules/` segment.
          // bun's isolated install nests packages as
          // `node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/...`, so the first
          // `node_modules/` segment is `.bun` — using it collapses every dependency
          // (incl. lazy-only ones) into a single giant eager `vendor-.bun` chunk.
          const lastNodeModules = id.lastIndexOf('node_modules/')
          const match = id.slice(lastNodeModules + 'node_modules/'.length)
          if (!match) return undefined

          const segments = match.split('/')
          const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]

          // Shiki grammars/themes and CodeMirror legacy modes are dynamically
          // imported one at a time by their registries. Forcing them into a
          // single vendor chunk makes the first language request download every
          // grammar (7.4 MB raw for @shikijs/langs). Let Rollup split them per
          // dynamically imported module so only used languages are fetched —
          // the worker build already behaves this way.
          if (
            packageName === '@shikijs/langs' ||
            packageName === '@shikijs/themes' ||
            packageName === '@codemirror/legacy-modes'
          ) {
            return undefined
          }

          // Split @pierre/diffs by usage as well: the eager tool renderer needs
          // only its pure patch parser, while the Shiki-importing render stack
          // must stay loadable on demand. One merged vendor chunk would make
          // the parser import download the whole stack eagerly.
          if (packageName === '@pierre/diffs') {
            return undefined
          }

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react'
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand'
          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown'
          if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui'

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-')
          return `vendor-${sanitized}`
        },
      },
    },
  },
})
