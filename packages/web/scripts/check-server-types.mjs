import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertServerProgramBoundary } from './server-program-boundary.mjs';

const webRoot = fileURLToPath(new URL('../', import.meta.url));

export function findServerTypeScript(root = webRoot) {
  return ['server', 'bin'].flatMap((folder) => fs.readdirSync(path.join(root, folder), { recursive: true })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .map((file) => path.join(root, folder, file)));
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
  if (lint) {
    if (!files.length) return 0;
    for (const config of ['oxlint.config.ts', 'oxlint.anti-slop.config.ts']) {
      for (const batch of batchByCommandLength(files.map((file) => path.relative(root, file)))) {
        const result = spawnSync('bunx', ['oxlint', '-c', path.resolve(webRoot, '../..', config), '--report-unused-disable-directives', ...batch], { cwd: root, stdio: 'inherit' });
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
