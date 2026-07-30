#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createManagedOpenCodeGuardian } from '../server/lib/guardian/guardian.js';
import { resolveManagedOpenCodeHandoffV2Root } from '../server/lib/opencode/managed-opencode-handoff-v2/filesystem.js';
import { resolveCurrentUsername } from '../server/lib/guardian/windows-acl.js';

/**
 * W-C: per-platform runtime paths for the standalone guardian.
 *
 * Linux/POSIX: `~/.local/state/openchamber/managed-opencode-handoff-v2`
 *   holds both the v2 root (mode `0700`) and the PID file (`0600`).
 *   `socketPath` resolves to `<rootDir>/guardian.sock`.
 *
 * Windows: `%LOCALAPPDATA%\openchamber\managed-opencode-handoff-v2`
 *   holds both the v2 root (per-user `icacls` ACL) and the PID file.
 *   `portPath` resolves to `<rootDir>/port` (the discovery file
 *   published by `createIpcServer` after the listener binds).
 *
 * `OPENCHAMBER_DATA_DIR`, when set to an absolute path, overrides the
 * default per-platform root for parity with the existing operator
 * workflow.
 */
const resolveWindowsDataDir = () => {
  const envValue = process.env.OPENCHAMBER_DATA_DIR;
  if (typeof envValue === 'string' && envValue.trim().length > 0 && path.isAbsolute(envValue)) {
    return envValue;
  }
  const localAppData = process.env.LOCALAPPDATA
    || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'openchamber', 'managed-opencode-handoff-v2');
};

const DEFAULT_POSIX_DATA_DIR = path.join(os.homedir(), '.local', 'state', 'openchamber', 'managed-opencode-handoff-v2');

const RUNTIME_PATHS = (() => {
  if (process.platform === 'win32') {
    const rootDir = resolveWindowsDataDir();
    return {
      platform: 'win32',
      rootDir,
      socketPath: undefined,
      portPath: path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'port'),
      pidDir: resolveManagedOpenCodeHandoffV2Root(rootDir),
      pidFile: path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.pid'),
    };
  }
  const rootDir = typeof process.env.OPENCHAMBER_DATA_DIR === 'string' && process.env.OPENCHAMBER_DATA_DIR.length > 0
    ? process.env.OPENCHAMBER_DATA_DIR
    : DEFAULT_POSIX_DATA_DIR;
  return {
    platform: process.platform,
    rootDir,
    socketPath: path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.sock'),
    portPath: undefined,
    pidDir: resolveManagedOpenCodeHandoffV2Root(rootDir),
    pidFile: path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.pid'),
  };
})();

const parseArgs = (argv) => {
  const args = {
    socketPath: undefined,
    portPath: undefined,
    dataDir: undefined,
    healthInterval: undefined,
    leaseInterval: undefined,
    username: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--socket-path' && i + 1 < argv.length) {
      args.socketPath = argv[i + 1];
      i += 1;
    } else if (arg === '--port-path' && i + 1 < argv.length) {
      // Windows-only override for the discovery file location.
      args.portPath = argv[i + 1];
      i += 1;
    } else if (arg === '--data-dir' && i + 1 < argv.length) {
      args.dataDir = argv[i + 1];
      i += 1;
    } else if (arg === '--health-interval' && i + 1 < argv.length) {
      args.healthInterval = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === '--lease-interval' && i + 1 < argv.length) {
      args.leaseInterval = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === '--username' && i + 1 < argv.length) {
      // Windows-only: override the resolved current user (rare; only
      // useful for tests that mock `resolveCurrentUsername`).
      args.username = argv[i + 1];
      i += 1;
    }
  }
  return args;
};

const readPidFile = (pidFile) => {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/**
 * W-C: PID file write is now a function of `(pidFile, pidDir, platform)`
 * rather than module-level constants. On Linux we `chmod 0600` (per the
 * Unix trust boundary); on Windows the per-user `icacls` ACL on the
 * v2 root covers the PID file by inheritance, so no explicit chmod is
 * needed (`chmodSync` is a no-op on Windows but skipped for clarity).
 */
const writePidFile = (pidFile, pidDir) => {
  fs.mkdirSync(pidDir, { recursive: true });
  try {
    const mode = process.platform === 'win32' ? 0o600 : 0o600; // explicit for symmetry; chmod skipped on win32
    const fd = fs.openSync(pidFile, 'wx', mode);
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // Another process may have created the file concurrently.
      const existingPid = readPidFile(pidFile);
      if (existingPid && isProcessAlive(existingPid)) {
        console.error(`Guardian is already running (pid ${existingPid})`);
        process.exit(1);
      }
      // Stale PID file; remove and retry once.
      try {
        fs.unlinkSync(pidFile);
      } catch {
        // Ignore unlink errors.
      }
      const fd = fs.openSync(pidFile, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid));
      fs.closeSync(fd);
    } else {
      throw error;
    }
  }
};

const removePidFile = (pidFile) => {
  try {
    fs.unlinkSync(pidFile);
  } catch {
    // Ignore.
  }
};

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const enforceSingleton = (pidFile) => {
  const existingPid = readPidFile(pidFile);
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`Guardian is already running (pid ${existingPid})`);
    process.exit(1);
  }
};

const main = async () => {
  // W-C: the Windows early-exit is removed. The same singleton +
  // writePidFile + createManagedOpenCodeGuardian flow runs on every
  // platform; the IPC transport factory inside `ManagedOpenCodeGuardian`
  // dispatches to the platform-correct backend.
  const args = parseArgs(process.argv);
  const paths = {
    ...RUNTIME_PATHS,
    socketPath: typeof args.socketPath === 'string' ? args.socketPath : RUNTIME_PATHS.socketPath,
    portPath: typeof args.portPath === 'string' ? args.portPath : RUNTIME_PATHS.portPath,
    rootDir: typeof args.dataDir === 'string' && args.dataDir.length > 0 ? args.dataDir : RUNTIME_PATHS.rootDir,
  };
  const pidFile = path.join(paths.pidDir, 'guardian.pid');
  enforceSingleton(pidFile);
  writePidFile(pidFile, paths.pidDir);

  const username = typeof args.username === 'string' && args.username.length > 0
    ? args.username
    : (paths.platform === 'win32' ? resolveCurrentUsername({ log: console.warn }) : undefined);

  const guardian = createManagedOpenCodeGuardian({
    rootDir: paths.rootDir,
    socketPath: paths.socketPath,
    portPath: paths.portPath,
    username,
    healthCheckIntervalMs: args.healthInterval,
    leaseRenewalIntervalMs: args.leaseInterval,
  });

  const shutdown = async (signal) => {
    console.log(`[guardian-cli] received ${signal}, shutting down...`);
    try {
      await guardian.stop();
    } catch (error) {
      console.error('[guardian-cli] shutdown error:', error.message);
    } finally {
      removePidFile(pidFile);
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // SIGHUP is the legacy reload signal (config-reload-no-op on both
  // platforms). On Windows `process.on('SIGHUP', ...)` is silently
  // ignored by Node, so we additionally register `SIGBREAK` for the
  // Ctrl+Break event in a console-attached Windows run. Both handlers
  // are safe to install unconditionally: `process.on` for an
  // unsupported signal is a no-op on POSIX runners.
  process.on('SIGHUP', () => {
    console.log('[guardian-cli] received SIGHUP, reloading config...');
    guardian.stopTimers();
    guardian.startTimers();
  });
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => shutdown('SIGBREAK'));
  }

  try {
    await guardian.start();
  } catch (error) {
    console.error('[guardian-cli] failed to start:', error.message);
    removePidFile(pidFile);
    process.exit(1);
  }

  // Block until stopped.
  await new Promise(() => {});
};

main().catch((error) => {
  console.error('[guardian-cli] fatal error:', error);
  // Best-effort: try to remove the default pidFile even if `main`
  // never reached the writePidFile step.
  try { removePidFile(RUNTIME_PATHS.pidFile); } catch { /* ignore */ }
  process.exit(1);
});
