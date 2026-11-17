import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBinaryArchitecture } from './binary-architecture.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronPackagePath = path.resolve(__dirname, '..', 'package.json');

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export const OPENCODE_SERVER_ENTRY = 'serve.mjs';

export const readPinnedOpenCodeServerVersion = () => {
  const pkg = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
  const version = String(pkg.devDependencies?.['@opencode/server'] ?? '').trim();
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`packages/electron/package.json must pin @opencode/server to an exact version, got: ${version || '(missing)'}`);
  }
  return version;
};

export const runOpenCodeServerVersion = (entry, runtime = process.execPath) => {
  const result = spawnSync(runtime, [entry, '--version'], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`Failed to run ${entry} --version (${result.error?.message ?? `exit ${result.status ?? result.signal}`})\n${result.stderr ?? ''}`);
  }
  return result.stdout.trim();
};

const nativeFiles = (dir, manifest) => {
  const assets = path.join(dir, 'assets');
  const nodePtyRoot = path.join(assets, path.dirname(path.dirname(manifest.nodePty)));
  const prebuilds = path.join(nodePtyRoot, 'prebuilds', `${manifest.platform}-${manifest.arch}`);
  return [
    ['persistent PTY daemon', path.join(assets, manifest.persistentPty)],
    ['file watcher', path.join(assets, manifest.parcelWatcher)],
    ['fff library', path.join(assets, manifest.fff)],
    ['fff FFI binding', path.join(assets, manifest.fffFfi)],
    ['node-pty binding', path.join(prebuilds, manifest.platform === 'win32' ? 'conpty.node' : 'pty.node')],
  ];
};

export const verifyOpenCodeServer = (dir, { platform, arch, version, runtime }) => {
  const entry = path.join(dir, OPENCODE_SERVER_ENTRY);
  if (!fs.existsSync(entry)) throw new Error(`Bundled OpenCode server not found: ${entry}`);
  const manifestPath = path.join(dir, 'assets', 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Bundled OpenCode server has no asset manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) throw new Error(`Bundled OpenCode server version mismatch: expected ${version}, got ${manifest.version}`);
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(`Bundled OpenCode server was staged for ${manifest.platform}-${manifest.arch}, expected ${platform}-${arch}`);
  }
  for (const key of ['nodePty', 'photonWasm']) {
    const file = path.join(dir, 'assets', manifest[key]);
    if (!fs.existsSync(file)) throw new Error(`Bundled OpenCode server is missing ${key}: ${file}`);
  }
  for (const [label, file] of nativeFiles(dir, manifest)) {
    if (!fs.existsSync(file)) throw new Error(`Bundled OpenCode server is missing its ${label}: ${file}`);
    const actual = readBinaryArchitecture(file, platform);
    if (actual !== arch) throw new Error(`Bundled OpenCode server ${label} is ${actual}, expected ${arch}: ${file}`);
  }
  if (platform !== 'win32') {
    const daemon = path.join(dir, 'assets', manifest.persistentPty);
    if ((fs.statSync(daemon).mode & 0o111) === 0) throw new Error(`Bundled OpenCode PTY daemon is not executable: ${daemon}`);
  }
  if (!runtime) return { version, ran: false };
  const reported = runOpenCodeServerVersion(entry, runtime);
  if (reported !== version) throw new Error(`Bundled OpenCode server reports ${reported || '(nothing)'}, expected ${version}`);
  return { version, ran: true };
};
