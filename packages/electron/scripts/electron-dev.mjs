#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const electronDir = path.join(repoRoot, 'packages/electron');
const electronCli = fileURLToPath(import.meta.resolve('electron/cli.js'));
const preferredHmrUiPort = Number(process.env.OPENCHAMBER_HMR_UI_PORT || '5173');
const preferredHmrApiPort = Number(process.env.OPENCHAMBER_HMR_API_PORT || '3901');

const quoteWindowsCommandArg = (value) => `"${String(value).replace(/"/g, '""')}"`;

function resolveWindowsCommand(command) {
  if (process.platform !== 'win32' || path.isAbsolute(command)) {
    return command;
  }

  const result = spawnSync('where.exe', [command], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    return command;
  }

  const candidates = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return candidates.find((entry) => /\.(exe|cmd|bat)$/i.test(entry)) || candidates[0] || command;
}

function spawnProcess(command, args, options = {}) {
  const resolvedCommand = resolveWindowsCommand(command);
  const isWindowsCommandScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedCommand);
  const spawnCommand = isWindowsCommandScript ? (process.env.ComSpec || 'cmd.exe') : resolvedCommand;
  const spawnArgs = isWindowsCommandScript
    ? ['/d', '/s', '/c', ['call', quoteWindowsCommandArg(resolvedCommand), ...args.map(quoteWindowsCommandArg)].join(' ')]
    : args;

  return spawn(spawnCommand, spawnArgs, {
    cwd: repoRoot,
    env: { ...process.env, OPENCHAMBER_ELECTRON_DEV: '1' },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    windowsVerbatimArguments: isWindowsCommandScript,
    ...options,
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: { ...process.env, OPENCHAMBER_ELECTRON_DEV: '1' },
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}`));
    });
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

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(preferredPort) {
  const start = Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : 0;
  if (start === 0) {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.once('listening', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        server.close(() => resolve(port));
      });
      server.listen(0, '127.0.0.1');
    });
  }

  for (let port = start; port < start + 50; port += 1) {
    if (await isPortAvailable(port)) {
      if (port !== start) {
        console.warn(`[electron:dev] port ${start} is unavailable, using ${port} instead.`);
      }
      return port;
    }
  }

  throw new Error(`No available port found near ${start}`);
}

function killWindowsProcessTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
  }
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

  if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null) {
    killWindowsProcessTree(child.pid);
    await waitForExit(child, 1000);
  }

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
  const useBundledUi = process.env.OPENCHAMBER_ELECTRON_USE_BUNDLED_UI === '1';
  let devServer = null;
  let hmrApiPort = '';
  let hmrUiPort = '';

  if (useBundledUi) {
    await runProcess('bun', ['run', '--cwd', 'packages/electron', 'build:web-assets']);
  } else {
    hmrApiPort = String(await findAvailablePort(preferredHmrApiPort));
    hmrUiPort = String(await findAvailablePort(preferredHmrUiPort));
    devServer = spawnProcess('node', ['./scripts/dev-web-hmr.mjs'], {
      env: {
        ...process.env,
        OPENCHAMBER_ELECTRON_DEV: '1',
        OPENCHAMBER_HMR_UI_PORT: hmrUiPort,
        OPENCHAMBER_HMR_API_PORT: hmrApiPort,
        OPENCHAMBER_DISABLE_PWA_DEV: '1',
      },
    });
  }

  const electron = spawnProcess(process.execPath, [electronCli, './main.mjs'], {
    cwd: electronDir,
    env: {
      ...process.env,
      OPENCHAMBER_ELECTRON_DEV: '1',
      ...(useBundledUi ? { OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '1' } : {}),
      OPENCHAMBER_HMR_UI_PORT: hmrUiPort,
      OPENCHAMBER_HMR_API_PORT: hmrApiPort,
      OPENCHAMBER_DISABLE_PWA_DEV: '1',
    },
  });

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

  devServer?.on('exit', onChildExit('dev server'));
  electron.on('exit', onChildExit('electron'));
  devServer?.on('error', (error) => {
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
