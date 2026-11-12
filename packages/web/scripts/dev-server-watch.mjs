#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveBunExecutable } from '../../../scripts/lib/bun-executable.mjs';
import { withoutInjectedEnv } from '../server/lib/injected-env.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const webRoot = path.resolve(__dirname, '..');

export function createDevServerWatchCommand(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const bunExecutable = options.bunExecutable ?? resolveBunExecutable({ env, platform });
  const configuredPort = env.OPENCHAMBER_PORT?.trim();
  const port = configuredPort || '3001';

  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`Invalid OPENCHAMBER_PORT: ${port}`);
  }

  return {
    command: bunExecutable,
    args: platform === 'win32'
      ? ['--watch', 'server/index.js', '--port', port]
      : [
          'x',
          'nodemon',
          '--watch',
          'server',
          '--ext',
          'js',
          '--exec',
          `bun server/index.js --port ${port}`,
        ],
    spawnOptions: {
      cwd: webRoot,
      stdio: 'inherit',
      // A shell an agent or the integrated terminal opens carries the app's
      // own server settings (its UI password, `OPENCHAMBER_RUNTIME=desktop`,
      // its web assets); the dev server would ask for that password and half
      // act as the desktop. The record holds names only, so an inline
      // override of a recorded name goes too; that fails closed (without
      // `OPENCHAMBER_HOST` it stays on loopback), and
      // `env -u OPENCHAMBER_INJECTED_ENV` keeps everything.
      env: {
        ...withoutInjectedEnv(env),
        OPENCHAMBER_RELAY_HOST: env.OPENCHAMBER_RELAY_HOST || 'off',
        // The dev UI runs on its own loopback port (Vite); see allowsLocalDevOrigins.
        OPENCHAMBER_ALLOW_DEV_ORIGINS: '1',
      },
      windowsHide: true,
    },
  };
}

export function runDevServerWatch(options = {}) {
  const runner = options.runner ?? spawn;
  const { command, args, spawnOptions } = createDevServerWatchCommand(options);
  const child = runner(command, args, spawnOptions);

  child.on('error', (error) => {
    console.error('[dev:web:server] Failed to start server watcher:', error);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
  return child;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    runDevServerWatch();
  } catch (error) {
    console.error('[dev:web:server] Unable to configure server watcher:', error);
    process.exitCode = 1;
  }
}
