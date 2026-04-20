#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const electronDir = path.join(repoRoot, 'packages/electron');

function spawnProcess(command, args, options = {}) {
  return spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env, OPENCHAMBER_ELECTRON_DEV: '1' },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...options,
  });
}

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

async function main() {
  const devServer = spawnProcess('node', ['./scripts/dev-web-hmr.mjs'], {
    env: {
      ...process.env,
      OPENCHAMBER_ELECTRON_DEV: '1',
      OPENCHAMBER_HMR_UI_PORT: '5173',
      OPENCHAMBER_HMR_API_PORT: '3901',
      OPENCHAMBER_DISABLE_PWA_DEV: '1',
    },
  });
  const electron = spawnProcess('npx', ['electron', './main.mjs'], { cwd: electronDir });

  let cleaning = false;
  const teardown = async (code) => {
    if (cleaning) {
      return;
    }
    cleaning = true;

    await Promise.all([stopChildTree(electron), stopChildTree(devServer)]);
    process.exit(typeof code === 'number' ? code : 0);
  };

  const onChildExit = (label) => (code, signal) => {
    if (code !== 0 || signal) {
      console.warn(`[electron:dev] ${label} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}.`);
    }
    void teardown(code ?? 1);
  };

  devServer.on('exit', onChildExit('dev server'));
  electron.on('exit', onChildExit('electron'));
  devServer.on('error', (error) => {
    console.error('[electron:dev] failed to start dev server:', error);
    void teardown(1);
  });
  electron.on('error', (error) => {
    console.error('[electron:dev] failed to start electron:', error);
    void teardown(1);
  });

  for (const [signal, exitCode] of Object.entries({ SIGINT: 130, SIGTERM: 143, SIGQUIT: 131, SIGHUP: 129 })) {
    process.on(signal, () => {
      void teardown(exitCode);
    });
  }
}

main().catch((error) => {
  console.error('[electron:dev] unexpected error:', error);
  process.exit(1);
});
