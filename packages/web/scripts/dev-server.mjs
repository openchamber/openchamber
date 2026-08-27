#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');

const port = process.env.OPENCHAMBER_PORT || '3001';
const relayHost = process.env.OPENCHAMBER_RELAY_HOST || 'off';

const child = spawn('bun', ['server/index.js', '--port', port], {
  cwd: packageRoot,
  env: {
    ...process.env,
    OPENCHAMBER_RELAY_HOST: relayHost,
  },
  stdio: 'inherit',
});

let shuttingDown = false;

function forwardSignal(signal) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  try {
    child.kill(signal);
  } catch {
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    shuttingDown = true;
    forwardSignal(signal);
  });
}

child.on('exit', (code, signal) => {
  if (shuttingDown) {
    process.exit(0);
  }
  if (signal) {
    process.exit(1);
  }
  process.exit(typeof code === 'number' ? code : 1);
});