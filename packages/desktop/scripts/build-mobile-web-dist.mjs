import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const webDir = path.join(repoRoot, 'packages', 'web');
const tauriDir = path.join(repoRoot, 'packages', 'desktop', 'src-tauri');
const sourceDistDir = path.join(webDir, 'dist');
const targetDistDir = path.join(tauriDir, 'resources', 'mobile-web-dist');

const run = (command, args, cwd, env = {}) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...env,
    },
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
};

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

console.log('[mobile] building bundled web assets...');
run('bun', ['run', 'build'], webDir, { VITE_RUNTIME_PLATFORM: 'mobile' });

console.log('[mobile] preparing mobile frontendDist...');
await fs.rm(targetDistDir, { recursive: true, force: true });
await copyDir(sourceDistDir, targetDistDir);

console.log(`[mobile] assets ready: ${targetDistDir}`);
