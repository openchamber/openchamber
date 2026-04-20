#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { waitForExit, signalChild, stopChildTree } from './lib/process-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const desktopDir = path.join(repoRoot, 'packages/desktop');

function spawnProcess(command, args, opts = {}) {
  return spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...opts,
  });
}

async function main() {
  const tauriProcess = spawnProcess('bun', [
    '--cwd',
    desktopDir,
    'tauri',
    'dev',
    '--features',
    'devtools',
    '--config',
    './src-tauri/tauri.dev.conf.json',
  ]);

  let cleaning = false;

  const teardown = async (code) => {
    if (cleaning) {
      return;
    }
    cleaning = true;

    await stopChildTree(tauriProcess);
    process.exit(typeof code === 'number' ? code : 0);
  };

  const handleChildExit = (childName) => (code, signal) => {
    if (code !== 0 || signal) {
      console.warn(`[desktop:dev] ${childName} exited with code ${code ?? 'null'} signal ${signal ?? 'none'}.`);
    }
    teardown(code).catch((error) => {
      console.error('[desktop:dev] Cleanup error:', error);
      process.exit(code ?? 1);
    });
  };

  tauriProcess.on('exit', handleChildExit('Tauri dev process'));
  const errorHandler = (label) => (error) => {
    console.error(`[desktop:dev] Failed to start ${label}:`, error);
    teardown(1).catch(() => process.exit(1));
  };

  tauriProcess.on('error', errorHandler('Tauri dev process'));

  const signalExitCodes = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGQUIT: 131,
  };

  Object.entries(signalExitCodes).forEach(([signal, exitCode]) => {
    process.on(signal, () => {
      teardown(exitCode).catch(() => process.exit(exitCode));
    });
  });
}

main().catch((error) => {
  console.error('[desktop:dev] Unexpected error:', error);
  process.exit(1);
});
