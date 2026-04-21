/**
 * Bundle main.mjs into a single file. Small electron-* helper deps are
 * inlined; everything else — including the in-process web server
 * (@openchamber/web) and native modules — stays external so it resolves
 * from node_modules at runtime inside the packaged app.
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

const result = await Bun.build({
  entrypoints: [path.join(root, 'main.mjs')],
  outdir: path.join(root, 'dist-bundle'),
  target: 'node',
  format: 'esm',
  external: [
    'electron',
    '@openchamber/web',
    '@openchamber/web/*',
    'bun-pty',
    'node-pty',
    'better-sqlite3',
  ],
  minify: false,
  sourcemap: 'none',
  naming: '[name].mjs',
});

if (!result.success) {
  for (const msg of result.logs) console.error(msg);
  process.exit(1);
}

console.log('[electron] main.mjs bundled -> dist-bundle/main.mjs');
