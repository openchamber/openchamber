import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canaryBuildConfig } from './canary-build-config.mjs';
import { resolveTargetArchitecture } from './target-architecture.mjs';

const env = { ...process.env };
const builderArgs = process.argv.slice(2);

if (env.OPENCHAMBER_DESKTOP_CHANNEL === 'canary') {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const releaseConfig = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).build;
  const configPath = path.join(packageDir, '.cache', 'canary-builder-config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(canaryBuildConfig(releaseConfig), null, 2)}\n`);
  builderArgs.unshift('--config', configPath);
  console.log('[electron] building Canary: the release app with the Canary icons');
}
const targetArchitecture = resolveTargetArchitecture({ environment: env, builderArgs });

if (process.platform === 'win32' && !env.CSC_LINK && !env.WINDOWS_CSC_LINK) {
  env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  console.log('[electron] Windows code signing disabled; building unsigned installer.');
}

const bunBinaryCandidates = [
  process.env.npm_execpath,
  process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : null,
  process.platform === 'win32' ? 'bun.exe' : 'bun',
].filter(Boolean);

const bunBinary = bunBinaryCandidates.find((candidate) => {
  if (path.basename(candidate).toLowerCase().startsWith('bun')) {
    return candidate === 'bun' || candidate === 'bun.exe' || fs.existsSync(candidate);
  }
  return false;
}) || (process.platform === 'win32' ? 'bun.exe' : 'bun');

// bun installs the optional node-llama-cpp platform packages for every Linux arch, and
// electron-builder packs them. Drop the ones for the other architecture so the AppImage
// only carries native code it can load (verify-linux-appimage checks this).
if (process.platform === 'linux') {
  const repoRoot = path.resolve(import.meta.dirname, '../../..');
  // bun's isolated layout keeps the platform packages as links beside node-llama-cpp
  // under node_modules/.bun, so look there as well as in the hoisted scope.
  const bunStore = path.join(repoRoot, 'node_modules/.bun');
  const bunLlamaScopes = fs.existsSync(bunStore)
    ? fs.readdirSync(bunStore)
      .filter((name) => name.startsWith('node-llama-cpp@'))
      .map((name) => path.join(bunStore, name, 'node_modules/@node-llama-cpp'))
    : [];
  const llamaScopes = [
    path.join(repoRoot, 'node_modules/@node-llama-cpp'),
    path.join(repoRoot, 'packages/electron/node_modules/@node-llama-cpp'),
    ...bunLlamaScopes,
  ];
  for (const scope of llamaScopes) {
    if (!fs.existsSync(scope)) continue;
    for (const name of fs.readdirSync(scope)) {
      if (name.startsWith('linux-') && !name.startsWith(`linux-${targetArchitecture.node}`)) {
        console.log(`[electron] pruning other-architecture native package @node-llama-cpp/${name}`);
        fs.rmSync(path.join(scope, name), { recursive: true, force: true });
      }
    }
  }
  // electron-builder also collects the real package directories in bun's store.
  if (fs.existsSync(bunStore)) {
    for (const name of fs.readdirSync(bunStore)) {
      const match = /^@node-llama-cpp\+linux-([^@]+)@/.exec(name);
      if (match && !match[1].startsWith(targetArchitecture.node)) {
        console.log(`[electron] pruning other-architecture store entry ${name}`);
        fs.rmSync(path.join(bunStore, name), { recursive: true, force: true });
      }
    }
  }
}

if (process.platform === 'linux' && !builderArgs.some((argument) => (
  argument === '--x64' || argument === '--arm64' || argument === '--arch' || argument.startsWith('--arch=')
))) {
  builderArgs.push(`--${targetArchitecture.electronBuilder}`);
}

const child = spawn(bunBinary, ['x', 'electron-builder', ...builderArgs], {
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', (error) => {
  console.error('[electron] failed to start electron-builder:', error);
  process.exit(1);
});
