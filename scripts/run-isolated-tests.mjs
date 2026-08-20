#!/usr/bin/env node
// Runs every test file under the given roots, each in its own process.
//
// Two properties of this repository make that the working arrangement rather
// than a preference:
//
// - The shared UI and extension suites keep module-level singletons (runtime
//   endpoint, relay tunnel, stores, registries). Executed in one process they
//   leak state into each other and fail by load order, which is why the relay
//   guidance already says to run those files one at a time.
// - The same directories mix `bun:test` and `node:test` files, so no single
//   runner command covers them. The framework is read from the file's imports
//   instead of being listed here, so adding a test never requires editing a
//   list that then rots.
//
// Usage: node scripts/run-isolated-tests.mjs <root> [...roots]

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const TEST_FILE = /\.(test|spec)\.(js|cjs|mjs|jsx|ts|tsx)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-bundle', 'build', 'out', '.git', 'ios', 'android']);
const MAX_PARALLEL = 4;

const collect = (root, found = []) => {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, found);
      continue;
    }
    if (TEST_FILE.test(entry.name)) found.push(full);
  }
  return found;
};

/** `null` when the file names no known runner, so it is reported instead of skipped silently. */
const resolveCommand = (file) => {
  const source = readFileSync(file, 'utf8');
  const isTypeScript = /\.tsx?$/.test(file);
  // TypeScript goes to Bun even when the file imports `node:test`, which Bun
  // implements. Node's ESM loader cannot resolve the extensionless local
  // specifiers these files use (`./sseProxy`), so it never ran them at all.
  if (isTypeScript || /from\s+['"]bun:test['"]/.test(source)) {
    return { label: 'bun', command: 'bun', args: ['test', file] };
  }
  if (/from\s+['"]node:test['"]/.test(source)) {
    return { label: 'node', command: 'node', args: ['--test', file] };
  }
  return null;
};

const run = ({ command, args }) => new Promise((resolve) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('error', (error) => resolve({ code: 1, output: `${output}${error.message}` }));
  child.on('close', (code) => resolve({ code: code ?? 1, output }));
});

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('run-isolated-tests: expected at least one root directory');
  process.exit(1);
}

const files = [];
for (const root of roots) {
  const resolved = path.resolve(root);
  if (!statSync(resolved).isDirectory()) {
    console.error(`run-isolated-tests: not a directory: ${root}`);
    process.exit(1);
  }
  files.push(...collect(resolved));
}
files.sort();

const failures = [];
const unknown = [];
let passed = 0;
let next = 0;

const worker = async () => {
  while (next < files.length) {
    const file = files[next++];
    const relative = path.relative(process.cwd(), file);
    const resolved = resolveCommand(file);
    if (!resolved) {
      unknown.push(relative);
      continue;
    }
    const { code, output } = await run(resolved);
    if (code === 0) {
      passed += 1;
    } else {
      failures.push({ relative, label: resolved.label, output });
      console.error(`FAIL (${resolved.label}) ${relative}`);
    }
  }
};

await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, files.length) }, worker));

for (const failure of failures) {
  console.error(`\n===== ${failure.relative} (${failure.label}) =====\n${failure.output}`);
}

for (const file of unknown) {
  console.error(`UNKNOWN RUNNER ${file}: imports neither bun:test nor node:test`);
}

console.log(`\n${passed}/${files.length} test files passed${failures.length ? `, ${failures.length} failed` : ''}${unknown.length ? `, ${unknown.length} with no known runner` : ''}`);

process.exit(failures.length > 0 || unknown.length > 0 ? 1 : 0);
