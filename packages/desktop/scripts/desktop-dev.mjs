#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const desktopDir = path.join(repoRoot, 'packages/desktop');

/**
 * Resolve the directory that holds node_modules for packages/desktop.
 * In a git worktree, node_modules live only in the main worktree, not in
 * each linked worktree checkout. We detect this by checking whether
 * node_modules/.bin/tauri exists under the current repoRoot's desktop dir.
 * If not, we climb to the main worktree via `git rev-parse --git-common-dir`.
 */
function resolveModulesRoot() {
  const localBin = path.join(desktopDir, 'node_modules', '.bin', 'tauri');
  if (fs.existsSync(localBin)) {
    return repoRoot;
  }

  // We're in a linked worktree — find the main worktree root.
  const result = spawnSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0 || !result.stdout) {
    return repoRoot; // fallback: let bun try and fail with the usual error
  }

  // --git-common-dir returns the path to the shared .git directory;
  // its parent is the main worktree root.
  const gitCommonDir = result.stdout.trim();
  const mainRoot = path.isAbsolute(gitCommonDir)
    ? path.dirname(gitCommonDir)
    : path.dirname(path.resolve(repoRoot, gitCommonDir));

  const mainBin = path.join(mainRoot, 'packages', 'desktop', 'node_modules', '.bin', 'tauri');
  if (fs.existsSync(mainBin)) {
    return mainRoot;
  }

  return repoRoot; // fallback
}

const modulesRoot = resolveModulesRoot();
const tauriBin = path.join(modulesRoot, 'packages', 'desktop', 'node_modules', '.bin', 'tauri');

function spawnProcess(command, args, opts = {}) {
  return spawn(command, args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    ...opts,
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
  // Invoke the @tauri-apps/cli script directly so the correct binary is used
  // regardless of whether we're in the main worktree or a linked worktree.
  const tauriProcess = spawnProcess(
    tauriBin,
    [
      'dev',
      '--features',
      'devtools',
      '--config',
      './src-tauri/tauri.dev.conf.json',
    ],
    { cwd: desktopDir },
  );

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
