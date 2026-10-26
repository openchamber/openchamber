#!/usr/bin/env node
// Removes installed dependencies and build outputs so the next `bun install`
// starts from a fresh checkout state. `bun install` rebuilds what the
// postinstall step needs (SDK, built-in extensions, Electron binary).
//
// Only directories with well-known generated names are removed: every
// `node_modules`, `dist` and `dist-*` under the root and `packages/`, plus the
// built-in extension output of the web server. Dot-directories (`.git`,
// `.opencode`, agent worktrees) and the native mobile projects are left alone.
//
// Usage: node scripts/clean.mjs [--dry-run]

import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

const GENERATED_DIR = /^(node_modules|dist|dist-[\w-]+)$/;
const SKIP_DIRS = new Set(['ios', 'android']);
const BUILT_IN_EXTENSIONS = /^(built-in-extensions|built-in-extensions\.previous-.+|\.builtin-build-.+)$/;

const collectGenerated = (dir, found) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (GENERATED_DIR.test(entry.name)) {
      found.push(fullPath);
    } else {
      collectGenerated(fullPath, found);
    }
  }
  return found;
};

const collectBuiltInExtensions = () => {
  const serverDir = path.join(repoRoot, 'packages', 'web', 'server');
  return readdirSync(serverDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && BUILT_IN_EXTENSIONS.test(entry.name))
    .map((entry) => path.join(serverDir, entry.name));
};

const targets = [
  path.join(repoRoot, 'node_modules'),
  ...collectGenerated(path.join(repoRoot, 'packages'), []),
  ...collectBuiltInExtensions(),
].filter((target) => existsSync(target));

for (const target of targets) {
  console.log(`${dryRun ? 'would remove' : 'removing'} ${path.relative(repoRoot, target)}`);
  if (!dryRun) rmSync(target, { recursive: true, force: true });
}

console.log(dryRun ? '\nDry run, nothing removed.' : '\nDone. Run `bun install` to set things up again.');
