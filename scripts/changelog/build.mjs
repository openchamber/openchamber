#!/usr/bin/env node
// Render the changelog outputs from `changelog/*.md`. `oc-dev create-release`
// is the normal caller; agents only edit `changelog/unreleased.md`.
//
//   node scripts/changelog/build.mjs                 write packages/vscode/CHANGELOG.md, changelog/index.json (and CHANGELOG.md while it exists)
//   node scripts/changelog/build.mjs --check         exit 1 when any output differs from what is committed
//   node scripts/changelog/build.mjs --release 1.2.3 [--date YYYY-MM-DD]
//                                                    move unreleased.md to 1.2.3.md (dated today by default), then write
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleases, promoteUnreleased, renderOutputs } from './lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const changelogDirectory = path.join(repoRoot, 'changelog');

const args = process.argv.slice(2);
const readFlag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] ?? null : null;
};
const check = args.includes('--check');
const releaseVersion = readFlag('--release');

try {
  if (releaseVersion) {
    const date = readFlag('--date') ?? new Date().toISOString().slice(0, 10);
    const created = promoteUnreleased(changelogDirectory, releaseVersion, date);
    console.log(`Promoted changelog/unreleased.md to ${path.relative(repoRoot, created)}`);
  }

  // The legacy app changelog is refreshed while it exists and never recreated.
  const legacyAppChangelog = fs.existsSync(path.join(repoRoot, 'CHANGELOG.md'));
  const outputs = renderOutputs(loadReleases(changelogDirectory), { legacyAppChangelog });
  const stale = [];
  for (const [relativePath, content] of Object.entries(outputs)) {
    const target = path.join(repoRoot, relativePath);
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
    if (current === content) continue;
    if (check) {
      stale.push(relativePath);
      continue;
    }
    fs.writeFileSync(target, content);
    console.log(`Wrote ${relativePath}`);
  }
  if (check && stale.length > 0) {
    console.error(`Generated changelog files are out of date: ${stale.join(', ')}. Run "bun run changelog:build" and commit the result.`);
    process.exit(1);
  }
  if (check) console.log('Changelog outputs are up to date.');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
