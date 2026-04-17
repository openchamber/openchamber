import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inferTargetTriple } from './lib/target.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const webDir = path.join(repoRoot, 'packages', 'web');
const desktopTauriDir = path.join(repoRoot, 'packages', 'desktop', 'src-tauri');

const resourcesDir = path.join(desktopTauriDir, 'resources');
const resourcesWebDistDir = path.join(resourcesDir, 'web-dist');
const webDistDir = path.join(webDir, 'dist');

const sidecarsDir = path.join(desktopTauriDir, 'sidecars');

const targetTriple = inferTargetTriple();

const bunCompileTargetByTriple = {
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
  'x86_64-pc-windows-msvc': 'bun-windows-x64',
};

const compileTarget = bunCompileTargetByTriple[targetTriple];

if (!compileTarget) {
  console.warn(
    `[desktop] unknown target triple '${targetTriple}', falling back to host-arch sidecar build`
  );
}

const sidecarBaseName = process.platform === 'win32'
  ? `openchamber-server-${targetTriple}.exe`
  : `openchamber-server-${targetTriple}`;
const sidecarOutPath = path.join(sidecarsDir, sidecarBaseName);


const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
};

const resolveBun = () => {
  if (typeof process.env.BUN === 'string' && process.env.BUN.trim()) {
    return process.env.BUN.trim();
  }

  const result = spawnSync('/bin/bash', ['-lc', 'command -v bun'], { encoding: 'utf8' });
  const resolved = (result.stdout || '').trim();
  if (resolved) {
    return resolved;
  }

  return 'bun';
};

const bunExe = resolveBun();


const copyDir = async (src, dst) => {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      await copyDir(from, to);
    } else if (entry.isSymbolicLink()) {
      const link = await fs.readlink(from);
      await fs.symlink(link, to);
    } else {
      await fs.copyFile(from, to);
    }
  }
};

console.log('[desktop] building web UI dist...');
run(bunExe, ['run', 'build'], webDir);

console.log('[desktop] preparing tauri resources...');
await fs.mkdir(resourcesDir, { recursive: true });
await fs.rm(resourcesWebDistDir, { recursive: true, force: true });
await copyDir(webDistDir, resourcesWebDistDir);

console.log('[desktop] building openchamber-server sidecar...');
await fs.mkdir(sidecarsDir, { recursive: true });

const buildArgs = [
  'build',
  '--compile',
  path.join(webDir, 'server', 'index.js'),
  '--outfile',
  sidecarOutPath,
];

if (compileTarget) {
  buildArgs.push('--target', compileTarget);
}

run(bunExe, buildArgs, repoRoot);

if (process.platform !== 'win32') {
  await fs.chmod(sidecarOutPath, 0o755);
}

console.log(`[desktop] sidecar ready: ${sidecarOutPath}`);
console.log(`[desktop] web assets ready: ${resourcesWebDistDir}`);
