#!/usr/bin/env node
// The Docker image installs its own copy of the OpenCode CLI. That pin is the
// only one outside the manifests, so a bundled-OpenCode bump moves
// `@opencode/client` and `@opencode/server` and leaves the image behind with no
// check to notice. `scripts/check-opencode-pins.test.mjs` runs this against the
// real tree, so a drift fails `bun run test`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const readJson = (root, relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));

// Only the install command decides what the image ships: a version mentioned in
// a comment must not satisfy the check. Two different install pins are an error.
export const readDockerCliPin = (dockerfile) => {
  const versions = new Set();
  for (const rawLine of dockerfile.split('\n')) {
    const line = rawLine.replace(/(^|\s)#.*$/, '');
    for (const match of line.matchAll(/npm install[^\n]*?@opencode\/cli@([0-9][^\s"'\\&;]*)/g)) versions.add(match[1]);
  }
  return versions.size === 1 ? [...versions][0] : null;
};

export const readOpencodePins = (root = ROOT) => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const rootPackage = readJson(root, 'package.json');
  const electronPackage = readJson(root, 'packages/electron/package.json');
  return {
    dockerCli: readDockerCliPin(dockerfile),
    workspaceClient: rootPackage.dependencies?.['@opencode/client'] ?? null,
    desktopServer: electronPackage.devDependencies?.['@opencode/server'] ?? null,
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
    console.log(`OpenCode pins agree on ${result.pins.dockerCli}`);
  } else {
    console.error('OpenCode pins disagree:', JSON.stringify(result.pins, null, 2));
    console.error('Update Dockerfile (npm install -g @opencode/cli@...), package.json (@opencode/client) and packages/electron/package.json (@opencode/server) together.');
    process.exit(1);
  }
}
