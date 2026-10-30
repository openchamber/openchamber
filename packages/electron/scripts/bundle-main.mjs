/**
 * Bundle the Electron main process into dist-bundle/. Three files come out:
 * entry.mjs (what Electron loads: pre-ready configuration and the first
 * window), main.mjs (everything else, imported after `ready`) and
 * early-startup.mjs, which both import. It must stay a separate file that
 * both bundles import at runtime: the early window is handed from entry to
 * main through a slot in that module, and inlining it would give each bundle
 * its own copy. Small electron-* helper deps are inlined; everything else —
 * including the in-process web server (@openchamber/web) and native modules —
 * stays external so it resolves from node_modules at runtime inside the
 * packaged app.
 *
 * Why external matters: packages/web/server pulls in bun-pty, which has
 * a top-level `import { dlopen } from "bun:ffi"`. If we inline it here,
 * Node's ESM loader sees `bun:ffi` at package load time and crashes with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME before any runtime guard can skip it.
 * Leaving @openchamber/web external means the conditional
 * `if (isBunRuntime) await import('bun-pty')` stays dynamic and is never
 * reached under Electron.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const updaterE2eBuild = process.env.OPENCHAMBER_UPDATER_E2E_BUILD === '1';

const result = await Bun.build({
  entrypoints: [
    path.join(root, 'entry.mjs'),
    path.join(root, 'main.mjs'),
    path.join(root, 'early-startup.mjs'),
  ],
  outdir: path.join(root, 'dist-bundle'),
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    '@openchamber/web',
    '@openchamber/web/*',
    'bun-pty',
    'node-pty',
    './main.mjs',
    './early-startup.mjs',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
  define: {
    __OPENCHAMBER_UPDATER_E2E_BUILD__: updaterE2eBuild ? 'true' : 'false',
  },
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

console.log(`[electron] main process bundled -> dist-bundle/{entry,main,early-startup}.mjs (updater E2E=${updaterE2eBuild})`);
