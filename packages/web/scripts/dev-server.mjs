#!/usr/bin/env node
import { spawn } from 'node:child_process';

const port = process.env.OPENCHAMBER_PORT || '3001';
const child = spawn('bun', ['server/index.js', '--port', port], {
  cwd: new URL('..', import.meta.url),
  stdio: 'inherit',
  env: process.env,
});

let shuttingDown = false;
let shutdownTimer = null;

const scheduleForcedExit = (exitCode) => {
  if (shutdownTimer) {
    return;
  }
  shutdownTimer = setTimeout(() => {
    process.exit(exitCode);
  }, 5000);
  shutdownTimer.unref?.();
};

const forwardSignal = (signal) => {
  if (shuttingDown || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  shuttingDown = true;
  try {
    child.kill(signal);
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error;
    }
  }
  scheduleForcedExit(signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143);
};

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => forwardSignal(signal));
}

child.on('exit', (code, signal) => {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

child.on('error', (error) => {
  console.error('[web:dev-server] failed to start bun server:', error);
  process.exit(1);
});
