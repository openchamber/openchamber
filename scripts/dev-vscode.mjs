#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const extensionPath = path.join(repoRoot, 'packages', 'vscode');
const useDetachedChildren = process.platform === 'darwin';

const codeBin = process.env.OPENCHAMBER_VSCODE_BIN || 'code';
const workspaceArg = process.argv[2] || process.env.OPENCHAMBER_VSCODE_DEV_WORKSPACE || repoRoot;
const workspacePath = path.resolve(workspaceArg);

const resolveDevServerAddress = () => {
  const configured = process.env.OPENCHAMBER_VSCODE_WEBVIEW_URL;
  if (!configured) {
    return { host: 'localhost', port: 5173 };
  }

  try {
    const parsed = new URL(configured);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80),
    };
  } catch {
    return { host: 'localhost', port: 5173 };
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const probePort = (host, port, timeoutMs = 500) => {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;

    const done = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
};

const waitForPort = async (host, port, timeoutMs, shouldAbort) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (shouldAbort()) return false;
    const ready = await probePort(host, port);
    if (ready) return true;
    await sleep(200);
  }
  return false;
};

if (!fs.existsSync(workspacePath)) {
  console.error(`[dev:vscode] Workspace path not found: ${workspacePath}`);
  process.exit(1);
}

function run(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env },
    detached: useDetachedChildren,
    ...options,
  });

  child.on('error', (error) => {
    console.error(`[dev:vscode] Failed to start ${label}:`, error);
  });

  return child;
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
    if (useDetachedChildren && process.platform !== 'win32') {
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

let shuttingDown = false;
const dev = run('vscode dev watchers', 'bun', ['run', '--cwd', 'packages/vscode', 'dev']);

console.log(`[dev:vscode] Starting extension host with ${codeBin}`);
console.log(`[dev:vscode] Workspace: ${workspacePath}`);
console.log(`[dev:vscode] Extension: ${extensionPath}`);
const { host: devServerHost, port: devServerPort } = resolveDevServerAddress();
console.log(`[dev:vscode] Waiting for webview dev server at ${devServerHost}:${devServerPort}`);

const ready = await waitForPort(devServerHost, devServerPort, 30000, () => shuttingDown || dev.exitCode !== null || dev.signalCode !== null);
if (!ready) {
  console.warn('[dev:vscode] Webview dev server not ready in time, opening extension host anyway');
}

const host = run(
  'vscode extension host',
  codeBin,
  [
    '--new-window',
    '--disable-extensions',
    '--extensionDevelopmentPath',
    extensionPath,
    '--wait',
    workspacePath,
  ],
  { detached: false },
);

async function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await Promise.all([stopChildTree(host), stopChildTree(dev)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (code !== 0 || signal) {
      console.error(`[dev:vscode] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

dev.on('exit', onChildExit('watchers'));
host.on('exit', onChildExit('extension host'));

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});

process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});

process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
