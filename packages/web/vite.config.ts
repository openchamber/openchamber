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

const wrapSocketError = (socket: any) => {
  for (const methodName of ['on', 'addListener'] as const) {
    const originalMethod = socket[methodName];
    if (typeof originalMethod === 'function') {
      socket[methodName] = function (socketEvent: string, listener: (...args: any[]) => void) {
        if (socketEvent === 'error') {
          const originalListener = listener;
          listener = function (err: any, ...listenerArgs: any[]) {
            if (err && (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED')) {
              return;
            }
            return originalListener.apply(this, [err, ...listenerArgs]);
          };
        }
        return originalMethod.apply(this, [socketEvent, listener]);
      };
    }
  }
};

const configureProxy = (proxy: any) => {
  const originalEmit = proxy.emit;
  proxy.emit = function (event: string, ...args: any[]) {
    if (event === 'error') {
      const err = args[0];
      if (err && (err.code === 'ECONNRESET' || err.code === 'ECONNABORTED')) {
        return false;
      }
    }
    if (event === 'open') {
      const proxySocket = args[0];
      if (proxySocket) {
        wrapSocketError(proxySocket);
      }
    }
    if (event === 'proxyReqWs') {
      const clientSocket = args[2];
      if (clientSocket) {
        wrapSocketError(clientSocket);
      }
    }
    return originalEmit.apply(this, [event, ...args]);
  };
};

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
        configure: configureProxy,
      },
      '/health': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
        configure: configureProxy,
      },
      '/api': {
        target: `http://127.0.0.1:${process.env.OPENCHAMBER_PORT || 3001}`,
        changeOrigin: true,
        ws: true,
        configure: configureProxy,
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
          if (!id.includes('node_modules')) return undefined;

          const match = id.split('node_modules/')[1];
          if (!match) return undefined;

          const segments = match.split('/');
          const packageName = match.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];

          if (packageName === 'react' || packageName === 'react-dom') return 'vendor-react';
          if (packageName === 'zustand' || packageName === 'zustand/middleware') return 'vendor-zustand';

          if (packageName === '@opencode-ai/sdk') return 'vendor-opencode-sdk';
          if (packageName.includes('remark') || packageName.includes('rehype') || packageName === 'react-markdown') return 'vendor-markdown';
          if (packageName === '@base-ui/react' || packageName.startsWith('@base-ui')) return 'vendor-base-ui';
          if (packageName.includes('react-syntax-highlighter') || packageName.includes('highlight.js')) return 'vendor-syntax';

          const sanitized = packageName.replace(/^@/, '').replace(/\//g, '-');
          return `vendor-${sanitized}`;
        },
      },
    },
  },
});
