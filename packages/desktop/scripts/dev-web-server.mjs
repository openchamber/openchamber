import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inferTargetTriple } from './lib/target.mjs';
import { waitForExit, signalChild, stopChildTree } from './lib/process-manager.mjs';

const DESKTOP_DEV_PORT = 3901;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const desktopDir = path.join(repoRoot, 'packages', 'desktop');
const tauriDir = path.join(desktopDir, 'src-tauri');

const targetTriple = inferTargetTriple();
const sidecarName = process.platform === 'win32'
  ? `openchamber-server-${targetTriple}.exe`
  : `openchamber-server-${targetTriple}`;

const sidecarPath = path.join(tauriDir, 'sidecars', sidecarName);
const distDir = path.join(tauriDir, 'resources', 'web-dist');
const webDir = path.join(repoRoot, 'packages', 'web');

const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}`);
  }
};

console.log('[desktop] ensuring sidecar + web-dist...');
run('node', ['./scripts/build-sidecar.mjs'], desktopDir);

console.log(`[desktop] starting API server on http://127.0.0.1:${DESKTOP_DEV_PORT} ...`);

const apiChild = spawn(sidecarPath, ['--port', String(DESKTOP_DEV_PORT)], {
  cwd: repoRoot,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    OPENCHAMBER_HOST: '127.0.0.1',
    OPENCHAMBER_DIST_DIR: distDir,
    NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1',
    no_proxy: process.env.no_proxy || 'localhost,127.0.0.1',
  },
});

console.log('[desktop] starting Vite HMR server on http://127.0.0.1:5173 ...');

const webChild = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '5173', '--strictPort'], {
  cwd: webDir,
  stdio: 'inherit',
  detached: process.platform !== 'win32',
  env: {
    ...process.env,
    OPENCHAMBER_PORT: String(DESKTOP_DEV_PORT),
    NO_PROXY: process.env.NO_PROXY || 'localhost,127.0.0.1',
    no_proxy: process.env.no_proxy || 'localhost,127.0.0.1',
  },
});

let shuttingDown = false;

async function requestApiShutdown() {
  const url = `http://127.0.0.1:${DESKTOP_DEV_PORT}/api/system/shutdown`;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
  }
}

const shutdown = async (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;

  await requestApiShutdown();
  await Promise.all([stopChildTree(webChild), stopChildTree(apiChild)]);
  process.exit(exitCode);
};

const handleExit = (label) => (code, signal) => {
  if (shuttingDown) {
    return;
  }

  if (code !== 0 || signal) {
    console.error(`[desktop] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
  }

  shutdown(typeof code === 'number' ? code : 1).catch((error) => {
    console.error('[desktop] shutdown failed:', error);
    process.exit(1);
  });
};

apiChild.on('exit', handleExit('API server'));
webChild.on('exit', handleExit('Vite server'));

const handleError = (label) => (error) => {
  if (shuttingDown) {
    return;
  }
  console.error(`[desktop] failed to start ${label}:`, error);
  shutdown(1).catch(() => process.exit(1));
};

apiChild.on('error', handleError('API server'));
webChild.on('error', handleError('Vite server'));

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});
process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});
process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
