#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveBunExecutable } from './lib/bun-executable.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const useDetachedChildren = process.platform === 'darwin';
const webRoot = path.join(repoRoot, 'packages/web');

const bunExecutable = resolveBunExecutable();

function run(label, command, args, env = {}, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd || repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    detached: useDetachedChildren,
    windowsHide: true,
  }).on('error', (error) => {
    console.error(`[dev] Failed to start ${label}:`, error);
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

const uiPort = process.env.OPENCHAMBER_HMR_UI_PORT || '5180';
const backendPort = process.env.OPENCHAMBER_HMR_API_PORT || '3902';
const hmrHost = process.env.OPENCHAMBER_HMR_HOST || '127.0.0.1';

function getLanAddresses() {
  const addresses = [];

  for (const networkAddresses of Object.values(os.networkInterfaces())) {
    for (const address of networkAddresses || []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      addresses.push(address.address);
    }
  }

  return addresses;
}

function clearViteCache() {
  const cacheDirs = [
    path.join(webRoot, 'node_modules/.vite'),
    path.join(webRoot, 'node_modules/.vite-temp'),
  ];

  for (const cacheDir of cacheDirs) {
    if (!existsSync(cacheDir)) continue;
    rmSync(cacheDir, { recursive: true, force: true });
  }
}

clearViteCache();

const api = run(
  'api',
  bunExecutable,
  [
    'run',
    '--cwd',
    'packages/web',
    'dev:server:watch',
  ],
  {
    OPENCHAMBER_PORT: backendPort,
    // Dev backends share the relay identity with the production instance; never
    // let them capture the machine's relay host on their own.
    OPENCHAMBER_RELAY_HOST: process.env.OPENCHAMBER_RELAY_HOST || 'off',
  },
);
let vite = null;
let shuttingDown = false;

// How long the UI waits for the API before it starts anyway.
const API_WAIT_MS = 120_000;

/**
 * The UI port opens only once the API answers. A page loaded in between (a
 * browser tab or a project action opening the address the moment the server
 * starts) got errors for every API call and stayed on an empty screen until
 * reloaded; with the port still closed, the browser keeps waiting instead.
 */
async function waitForApi() {
  const deadline = Date.now() + API_WAIT_MS;
  while (!shuttingDown && Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${backendPort}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!shuttingDown) console.warn(`[dev] API did not answer within ${API_WAIT_MS / 1000}s; starting the UI anyway`);
}

function startVite() {
  vite = run(
    'vite',
    bunExecutable,
    ['x', 'vite', '--force', '--host', hmrHost, '--port', uiPort, '--strictPort'],
    {
      OPENCHAMBER_PORT: backendPort,
      OPENCHAMBER_DISABLE_PWA_DEV: '1',
    },
    { cwd: webRoot },
  );
  vite.on('exit', onChildExit('vite'));
  printAddresses();
}

// `localhost`, not 127.0.0.1: the desktop app lifts Chromium's connection cap
// for 127.0.0.1 (its own server, packages/electron/entry.mjs), and its browser
// panel then fetched the whole module graph at once and Vite reset
// connections. Under `localhost` the panel keeps the cap, as any browser does.
function printAddresses() {
  console.log(`[dev] UI with HMR: http://localhost:${uiPort}`);
  console.log(`[dev] Mobile UI with HMR: http://localhost:${uiPort}/mobile.html`);
  if (hmrHost === '0.0.0.0' || hmrHost === '::') {
    const lanAddresses = getLanAddresses();
    if (lanAddresses.length > 0) {
      for (const address of lanAddresses) {
        console.log(`[dev] LAN/mobile UI: http://${address}:${uiPort}`);
      }
    } else {
      console.log('[dev] LAN/mobile UI: no LAN IPv4 address found');
    }
  }
  console.log(`[dev] API: http://127.0.0.1:${backendPort}`);
  console.log('[dev] IMPORTANT: open UI URL above for HMR; backend URL has no HMR');
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.all([stopChildTree(api), stopChildTree(vite)]);
  process.exit(exitCode);
}

function onChildExit(label) {
  return (code, signal) => {
    if (shuttingDown) return;

    if (code !== 0 || signal) {
      console.error(`[dev] ${label} exited unexpectedly (code=${code ?? 'null'} signal=${signal ?? 'none'})`);
      shutdown(typeof code === 'number' ? code : 1).catch(() => process.exit(1));
      return;
    }

    shutdown(0).catch(() => process.exit(1));
  };
}

api.on('exit', onChildExit('api'));
void waitForApi().then(() => {
  if (!shuttingDown) startVite();
});

process.on('SIGINT', () => {
  shutdown(130).catch(() => process.exit(130));
});
process.on('SIGTERM', () => {
  shutdown(143).catch(() => process.exit(143));
});
process.on('SIGHUP', () => {
  shutdown(129).catch(() => process.exit(129));
});
