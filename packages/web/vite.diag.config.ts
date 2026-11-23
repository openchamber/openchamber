import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeConfig, type Plugin } from 'vite';
import base from './vite.config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NOTIFY = 'listeners.forEach((listener) => listener(state, previousState));';
const API = /const api = \{[^}]*\};/;

const zustandStoreProbe = (): Plugin => ({
  name: 'openchamber-diag-zustand-store-probe',
  enforce: 'pre',
  transform(code, id) {
    if (!/zustand[\\/]esm[\\/]vanilla\.mjs$/.test(id)) return null;
    const api = code.match(API)?.[0];
    if (!code.includes(NOTIFY) || !api) throw new Error(`zustand vanilla store changed shape (${id}); update vite.diag.config.ts`);
    return code
      .replace(NOTIFY, `const __probe = globalThis.__ocStoreProbe; if (__probe && __probe.recording) { __probe.notify(api, listeners, state, previousState); } else { ${NOTIFY} }`)
      .replace(api, `${api} if (globalThis.__ocStoreProbe) globalThis.__ocStoreProbe.register(api, new Error().stack);`);
  },
});

export default mergeConfig(base, {
  plugins: [zustandStoreProbe()],
  build: {
    outDir: path.resolve(__dirname, '../../tmp/web-dist-diag'),
    minify: false,
    sourcemap: true,
  },
});
