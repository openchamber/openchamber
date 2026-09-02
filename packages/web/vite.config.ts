import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';
import { themeStoragePlugin } from '../../vite-theme-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const pwaDevEnabled = process.env.OPENCHAMBER_DISABLE_PWA_DEV !== '1';
const reactScanToggle = (process.env.VITE_ENABLE_REACT_SCAN ?? '').toLowerCase();
const enableReactScan = reactScanToggle === '1' || reactScanToggle === 'true' || reactScanToggle === 'on' || reactScanToggle === 'yes';
const themeDirectory = path.resolve(__dirname, '../ui/src/lib/theme/themes');

const themeJsonHmrPlugin = () => ({
  name: 'openchamber-theme-json-hmr',
  handleHotUpdate({ file, server }: { file: string; server: { ws: { send: (payload: unknown) => void } } }) {
    if (!file.startsWith(`${themeDirectory}${path.sep}`) || path.extname(file) !== '.json') {
      return;
    }

    try {
      server.ws.send({
        type: 'custom',
        event: 'openchamber:theme-updated',
        data: JSON.parse(readFileSync(file, 'utf-8')),
      });
      // Theme JSON is applied by the runtime event listener. Returning no
      // modules prevents Vite's otherwise unavoidable page-reload fallback.
      return [];
    } catch {
      // Leave the previous valid theme active while an editor writes invalid
      // or incomplete JSON; the next valid save will replace it.
      return [];
    }
  },
});

export default defineConfig({
  root: path.resolve(__dirname, '.'),
  plugins: [
    react({
      babel: {
        plugins: ['babel-plugin-react-compiler'],
      },
    }),
    {
      name: 'inject-react-scan-script',
      transformIndexHtml() {
        if (!enableReactScan) {
          return;
        }
        return [
          {
            tag: 'script',
            attrs: {
              crossorigin: 'anonymous',
              src: '//unpkg.com/react-scan/dist/auto.global.js',
            },
            injectTo: 'head-prepend',
          },
        ];
      },
    },
    themeStoragePlugin(),
    themeJsonHmrPlugin(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,ttf,otf,eot}'],
        // iOS Safari/PWA is much more reliable with a classic (non-module) SW bundle.
        rollupFormat: 'iife',
        // We already keep a custom manifest in index.html
        injectionPoint: undefined,
      },
      devOptions: {
        enabled: pwaDevEnabled,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: [
      { find: '@opencode-ai/sdk/v2', replacement: path.resolve(__dirname, '../../node_modules/@opencode-ai/sdk/dist/v2/client.js') },
      { find: '@openchamber/ui', replacement: path.resolve(__dirname, '../ui/src') },
      { find: '@web', replacement: path.resolve(__dirname, './src') },
      { find: '@', replacement: path.resolve(__dirname, '../ui/src') },
    ],
  },
  worker: {
    format: 'es',
  },
  define: {
    'process.env': {},
    global: 'globalThis',
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  optimizeDeps: {
    include: ['@opencode-ai/sdk/v2'],
  },
  server: {
    port: 5173,
    proxy: {
      '/auth': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
      },
      '/health': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
      },
      '/linear': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        mobile: path.resolve(__dirname, 'mobile.html'),
        miniChat: path.resolve(__dirname, 'mini-chat.html'),
      },
      external: ['node:child_process', 'node:fs', 'node:path', 'node:url'],
      output: {
        manualChunks(id) {
          // Pin Vite's tiny runtime helpers to their own stable chunk. Otherwise
          // Rollup co-locates the `__vitePreload` helper into an arbitrary vendor
          // chunk (e.g. `shiki`), and since every dynamic import pulls the helper,
          // that whole vendor (here Shiki core + the 629KB oniguruma engine) gets
          // dragged into the eager bootstrap graph.
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vendor-vite-runtime';
          }
          if (!id.includes('node_modules')) return undefined;

          // Resolve the real package from the LAST `node_modules/` segment.
          // bun's isolated install nests packages as
          // `node_modules/.bun/<pkg>@<ver>/node_modules/<pkg>/...`, so the first
          // `node_modules/` segment is `.bun` — using it collapses every dependency
          // (incl. lazy-only ones) into a single giant eager `vendor-.bun` chunk.
          const lastNodeModules = id.lastIndexOf('node_modules/');
          const match = id.slice(lastNodeModules + 'node_modules/'.length);
          if (!match) return undefined;

          const segments = match.split('/');
          const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];

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
            return undefined;
          }

          // Split @pierre/diffs by usage as well: the eager tool renderer needs
          // only its pure patch parser, while the Shiki-importing render stack
          // must stay loadable on demand. One merged vendor chunk would make
          // the parser import download the whole stack eagerly.
          if (packageName === '@pierre/diffs') {
            return undefined;
          }

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react';
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand';

          if (packageName === '@opencode-ai/sdk') return 'vendor-opencode-sdk';
          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown';
          if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui';

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-');
          return `vendor-${sanitized}`;
        },
      },
    },
  },
});
