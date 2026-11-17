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
