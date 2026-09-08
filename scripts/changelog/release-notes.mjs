#!/usr/bin/env node
// GitHub Release body and name for one version, from `changelog/<version>.md`.
//
//   node scripts/changelog/release-notes.mjs 1.2.3 artifacts/release-notes.md
//
// Writes the body to the given file and prints the release title on stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadReleases, renderReleaseNotes } from './lib.mjs';

const [version, outFile] = process.argv.slice(2);
if (!version || !outFile) {
  console.error('usage: release-notes.mjs <version> <out-file>');
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
try {
  const { releases } = loadReleases(path.join(repoRoot, 'changelog'));
  const release = releases.find((entry) => entry.version === version);
  if (!release) throw new Error(`changelog/${version}.md not found; run "oc-dev create-release" before tagging`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, renderReleaseNotes(release));
  process.stdout.write(`${release.title}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
