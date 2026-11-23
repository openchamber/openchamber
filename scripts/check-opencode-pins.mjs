#!/usr/bin/env node
// OpenCode is pinned in three manifests: the UI's client in the root
// package.json, the server the desktop app bundles in packages/electron, and the
// server @openchamber/web bundles (the npm package and the Docker image, which
// builds packages/web). A bump that moves one and leaves another behind ships
// two OpenCode versions. `scripts/check-opencode-pins.test.mjs` runs this
// against the real tree, so a drift fails `bun run test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const readJson = (root, relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

export const readOpencodePins = (root = ROOT) => {
  const rootPackage = readJson(root, 'package.json');
  const electronPackage = readJson(root, 'packages/electron/package.json');
  const webPackage = readJson(root, 'packages/web/package.json');
  return {
    workspaceClient: rootPackage.dependencies?.['@opencode/client'] ?? null,
    desktopServer: electronPackage.devDependencies?.['@opencode/server'] ?? null,
    webServer: webPackage.devDependencies?.['@opencode/server'] ?? webPackage.dependencies?.['@opencode/server'] ?? null,
  };
};

export const checkOpencodePins = (pins) => {
  const names = Object.keys(pins);
  const missing = names.filter((name) => !pins[name]);
  if (missing.length > 0) {
    return { ok: false, reason: 'missing', missing, pins };
  }
  const versions = new Set(names.map((name) => pins[name]));
  if (versions.size > 1) {
    return { ok: false, reason: 'mismatch', pins };
  }
  return { ok: true, pins };
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const result = checkOpencodePins(readOpencodePins());
  if (result.ok) {
    console.log(`OpenCode pins agree on ${result.pins.workspaceClient}`);
  } else {
    console.error('OpenCode pins disagree:', JSON.stringify(result.pins, null, 2));
    console.error('Update package.json (@opencode/client), packages/electron/package.json and packages/web/package.json (@opencode/server) together.');
    process.exit(1);
  }
}
