import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, realpathSync } from 'node:fs';
import { VitePWA } from 'vite-plugin-pwa';
import { cacheReactBabel } from './vite-react-babel-cache';
import { SHARE_DOCUMENT_FILE, shareDocumentPlugin } from './vite-share-document';
import { localeSlicesPlugins } from './vite-locale-slices';
import { oneByteChunksPlugin } from './vite-one-byte-chunks';
import { preloadAppGraph } from './vite-preload-app-graph';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'));
const pwaDevEnabled = process.env.OPENCHAMBER_DISABLE_PWA_DEV !== '1';
const reactScanToggle = (process.env.VITE_ENABLE_REACT_SCAN ?? '').toLowerCase();
const enableReactScan = reactScanToggle === '1' || reactScanToggle === 'true' || reactScanToggle === 'on' || reactScanToggle === 'yes';
const themeDirectory = path.resolve(__dirname, '../ui/src/lib/theme/themes');

const reactBabel = { plugins: ['babel-plugin-react-compiler'] };

const aliases = [
  { find: '@openchamber/sdk/schemas', replacement: path.resolve(__dirname, '../sdk/src/schemas.ts') },
  { find: '@openchamber/sdk', replacement: path.resolve(__dirname, '../sdk/src/index.ts') },
  { find: '@openchamber/ui', replacement: path.resolve(__dirname, '../ui/src') },
  { find: '@web', replacement: path.resolve(__dirname, './src') },
  { find: '@', replacement: path.resolve(__dirname, '../ui/src') },
];

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
      return [];
    } catch {
      return [];
    }
  },
});

export default defineConfig({
  root: path.resolve(__dirname, '.'),
  cacheDir: process.env.OPENCHAMBER_VITE_CACHE_DIR || undefined,
  plugins: [
    ...cacheReactBabel(react({ babel: reactBabel }), {
      directory: path.join(os.homedir(), '.cache', 'openchamber', 'react-babel'),
      root: realpathSync(path.resolve(__dirname, '../..')),
      setup: reactBabel,
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
    themeJsonHmrPlugin(),
    ...localeSlicesPlugins(),
    oneByteChunksPlugin(),
    preloadAppGraph({
      appModule: path.resolve(__dirname, '../ui/src/main.tsx'),
      document: 'index.html',
      protocols: ['openchamber-ui:'],
    }),
    shareDocumentPlugin({
      uiSource: path.resolve(__dirname, '../ui/src'),
      aliases,
      react: () => react({ babel: reactBabel }),
    }),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: false,
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,ttf,otf,eot,wasm}'],
        globIgnores: [SHARE_DOCUMENT_FILE],
        rollupFormat: 'iife',
        injectionPoint: undefined,
      },
      devOptions: {
        enabled: pwaDevEnabled,
        type: 'module',
      },
    }),
  ],
  resolve: {
    alias: aliases,
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
    include: ['@opencode/client'],
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
          if (id.includes('vite/preload-helper') || id.includes('vite/modulepreload-polyfill')) {
            return 'vendor-vite-runtime';
          }
          if (!id.includes('node_modules')) return undefined;
          if (id.endsWith('.css')) return undefined;

          const lastNodeModules = id.lastIndexOf('node_modules/');
          const match = id.slice(lastNodeModules + 'node_modules/'.length);
          if (!match) return undefined;

          const segments = match.split('/');
          const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];

          if (
            packageName === '@shikijs/langs' ||
            packageName === '@shikijs/themes' ||
            packageName === '@codemirror/legacy-modes'
          ) {
            return undefined;
          }

          if (packageName === '@pierre/diffs' || packageName === '@pierre/highlights') {
            return undefined;
          }

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react';
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand';

          if (packageName === '@opencode/client') return 'vendor-opencode-client';
          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown';
          if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui';

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-');
          return `vendor-${sanitized}`;
        },
      },
    },
  },
});
