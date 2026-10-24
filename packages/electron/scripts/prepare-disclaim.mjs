import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds `native/disclaim.c` into `resources/disclaim/disclaim`, which the mac
 * `extraResources` ship as `Resources/disclaim/disclaim` and electron-builder
 * signs with the app. The server starts the managed OpenCode server and
 * terminals through it (`packages/web/server/lib/macos-responsibility.js`).
 * One universal binary serves both architectures. Other platforms skip it.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(__dirname, '..');
const source = path.join(electronRoot, 'native', 'disclaim.c');
const output = path.join(electronRoot, 'resources', 'disclaim', 'disclaim');

if (process.platform !== 'darwin') {
  console.log('[disclaim] not macOS, skipped');
  process.exit(0);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
const result = spawnSync('xcrun', [
  'clang', '-O2', '-Wall', '-Werror',
  '-arch', 'arm64', '-arch', 'x86_64',
  '-mmacosx-version-min=11.0',
  '-o', output, source,
], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`[disclaim] clang failed${result.error ? `: ${result.error.message}` : ''}`);
  process.exit(1);
}
console.log(`[disclaim] built ${path.relative(electronRoot, output)}`);
