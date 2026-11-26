import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';
import { assertServerProgramBoundary } from './server-program-boundary.mjs';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

export function findServerTypeScript(root = webRoot) {
  return ['server', 'bin'].flatMap((folder) => fs.readdirSync(path.join(root, folder), { recursive: true })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => path.join(root, folder, file)));
}

export const JAVASCRIPT_ENTRIES = [
  'bin/cli.js',
  'server/index.js',
  'server/lib/dictation/local/worker-process.js',
  'server/lib/git/credential-helper.js',
  'server/lib/git/repository-credential-helper.js',
  'server/lib/git/ssh-wrapper.js',
];

const NOT_IMPLEMENTATION = /(?:\.(?:test|spec|fixture|test-support|bench)\.|(?:^|\/)(?:tests?|__tests__|test-support)(?:\/|$)|-live-support\.)/;

export function findServerJavaScript(root = webRoot) {
  return ['server', 'bin'].flatMap((folder) => fs.readdirSync(path.join(root, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll(path.sep, '/')))
    .filter((file) => file.endsWith('.js') && !file.startsWith('server/built-in-extensions/')
      && !NOT_IMPLEMENTATION.test(file) && !JAVASCRIPT_ENTRIES.includes(file));
}

const COMMAND_LENGTH_BUDGET = 20_000;

export function batchByCommandLength(files, budget = COMMAND_LENGTH_BUDGET) {
  const batches = [];
  let length = 0;
  for (const file of files) {
    if (!batches.length || length + file.length + 1 > budget) {
      batches.push([]);
      length = 0;
    }
    batches.at(-1).push(file);
    length += file.length + 1;
  }
  return batches;
}

export function findPairedDeclarations(files) {
  return files.filter((file) => fs.existsSync(file.replace(/\.ts$/, '.d.ts')));
}

export function checkServerTypes(root = webRoot, lint = process.argv.includes('--lint')) {
  const files = findServerTypeScript(root);
  const paired = findPairedDeclarations(files);
  if (paired.length) {
    for (const file of paired) console.error(`${file}: delete the paired .d.ts when converting its implementation`);
    return 1;
  }
  const javascript = findServerJavaScript(root);
  if (javascript.length) {
    for (const file of javascript) console.error(`${file}: server and CLI code is TypeScript. Write this module as .ts; only the entries Node runs by file name stay JavaScript (JAVASCRIPT_ENTRIES in packages/web/scripts/check-server-types.mjs).`);
    return 1;
  }
  if (lint) {
    if (!files.length) return 0;
    const bun = resolveBunExecutable();
    for (const config of ['oxlint.config.ts', 'oxlint.anti-slop.config.ts']) {
      for (const batch of batchByCommandLength(files.map((file) => path.relative(root, file)))) {
        const result = spawnSync(bun, ['x', 'oxlint', '-c', path.resolve(webRoot, '../..', config), '--report-unused-disable-directives', ...batch], { cwd: root, stdio: 'inherit', windowsHide: true });
        if (result.error) console.error(result.error.message);
        if (result.status !== 0) return result.status ?? 1;
      }
    }
    return 0;
  }
  try {
    assertServerProgramBoundary(root);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
  const require = createRequire(import.meta.url);
  const compiler = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  return spawnSync(process.execPath, [compiler, '-p', path.join(root, 'tsconfig.server-check.json')], { cwd: root, stdio: 'inherit' }).status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = checkServerTypes();
}
