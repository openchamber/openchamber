// The OpenCode server the desktop app bundles, staged from this checkout, for dev tooling that needs the
// pinned OpenCode rather than whatever `opencode` is on PATH. The web server runs it when
// OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR names the folder (packages/electron/opencode-server).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolveBunExecutable } from './bun-executable.mjs';

// Bundling takes seconds and the native packages are small; past this, the network is the problem.
const PREPARE_TIMEOUT_MS = 180_000;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

const stagedFor = (dir, version) => {
  const manifestPath = path.join(dir, 'assets', 'manifest.json');
  if (!fs.existsSync(path.join(dir, 'serve.mjs')) || !fs.existsSync(manifestPath)) return false;
  const manifest = readJson(manifestPath);
  return manifest.version === version && manifest.platform === process.platform && manifest.arch === process.arch;
};

// Stages the server for this machine when the checkout has none, or one for another version or target.
// A failure throws at once with what to run by hand: preparing downloads the native packages from npm.
export const ensureBundledOpenCodeServer = (repoRoot) => {
  const electronDir = path.join(repoRoot, 'packages', 'electron');
  const dir = path.join(electronDir, 'resources', 'opencode-server');
  const version = readJson(path.join(electronDir, 'package.json')).devDependencies['@opencode/server'];
  if (stagedFor(dir, version)) return dir;
  const env = { ...process.env };
  delete env.OPENCHAMBER_TARGET_ARCH;
  delete env.ELECTRON_BUILDER_ARCH;
  delete env.OPENCHAMBER_OPENCODE_SERVER_PLATFORM;
  const result = spawnSync(resolveBunExecutable(), ['./scripts/prepare-opencode-server.mjs'], {
    cwd: electronDir,
    env,
    encoding: 'utf8',
    timeout: PREPARE_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.status !== 0 || !stagedFor(dir, version)) {
    const reason = result.error?.code === 'ETIMEDOUT'
      ? `it did not finish in ${PREPARE_TIMEOUT_MS / 1000} s`
      : (result.error?.message ?? (result.stderr || result.stdout || `exit ${result.status}`).trim().split('\n').slice(-3).join(' '));
    throw new Error(`Could not prepare the bundled OpenCode server ${version} (${reason}). It downloads native packages from npm: `
      + 'run `bun run --cwd packages/electron prepare:opencode-server` with network access, or set OPENCODE_BINARY to an OpenCode CLI.');
  }
  return dir;
};

export const bundledOpenCodeServerEnv = (repoRoot) => ({
  OPENCHAMBER_BUNDLED_OPENCODE_SERVER_DIR: ensureBundledOpenCodeServer(repoRoot),
});

// What a dev instance runs as OpenCode: a CLI the caller names in OPENCODE_BINARY first, else the
// checkout's pinned bundled server, prepared only when it is needed.
export const devOpenCodeEnv = (callerEnv, prepareBundled) => (
  callerEnv.OPENCODE_BINARY ? { OPENCODE_BINARY: callerEnv.OPENCODE_BINARY } : prepareBundled()
);
