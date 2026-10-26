// Diagnostic build for performance attribution: `bun run build:web:diag`.
// The production config, plus:
//  - no minification and source maps, so CPU profiles, traces and stacks name
//    real functions and map back to source files;
//  - zustand's vanilla store reports every notification to
//    globalThis.__ocStoreProbe when a page-side probe installed one
//    (scripts/perf/render-probe.mjs); without the probe the store is unchanged.
// Written to <repo>/tmp/web-dist-diag, outside the package: anything under
// packages/web is copied into the desktop app's asar with @openchamber/web, and
// a diag build there once added ~146 MB to the packaged app. Measure timings
// on the production build; use this one to name what the time was spent on.
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
    // Fail the build rather than ship a diagnostic build whose store counts
    // silently read zero.
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
