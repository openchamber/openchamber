import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DESKTOP_DEV_PORT = 3901;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const desktopDir = path.join(repoRoot, 'packages', 'desktop');
const tauriDir = path.join(desktopDir, 'src-tauri');

const inferTargetTriple = () => {
  const fromEnv = typeof process.env.TAURI_ENV_TARGET_TRIPLE === 'string' ? process.env.TAURI_ENV_TARGET_TRIPLE.trim() : '';
  if (fromEnv) return fromEnv;

  if (process.platform === 'darwin') {
    return process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }

  if (process.platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }

  if (process.platform === 'linux') {
    return process.arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }

  return `${process.arch}-${process.platform}`;
};

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

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }

    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      child.off('exit', onExit);
      resolve();
    }, timeoutMs);

    child.once('exit', onExit);
  });
}

function signalChild(child, signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      process.kill(-child.pid, signal);
      return;
    }
  } catch {
  }

  try {
    child.kill(signal);
  } catch {
  }
}

async function requestApiShutdown() {
  const url = `http://127.0.0.1:${DESKTOP_DEV_PORT}/api/system/shutdown`;
  try {
    await fetch(url, { method: 'POST' });
  } catch {
  }
}

async function stopChildTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  signalChild(child, 'SIGINT');
  await waitForExit(child, 2500);

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGTERM');
    await waitForExit(child, 2500);
  }

  if (child.exitCode === null && child.signalCode === null) {
    signalChild(child, 'SIGKILL');
    await waitForExit(child, 1000);
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
