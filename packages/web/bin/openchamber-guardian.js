#!/usr/bin/env node

import { createManagedOpenCodeGuardian } from '../server/lib/guardian/guardian.js';
import { resolveCurrentUsername } from '../server/lib/guardian/windows-acl.js';
import { ensurePrivateDirectory } from '../server/lib/opencode/managed-opencode-handoff-v2/filesystem.js';
import { resolveGuardianPaths } from '../server/lib/guardian/paths.js';
import { readProcessIdentity } from '../server/lib/guardian/process-identity.js';
import {
  acquireGuardianPidMarker,
  releaseGuardianPidMarker,
} from '../server/lib/guardian/pid-marker.js';

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

let markerOwnership = null;

const releaseOwnedMarker = () => {
  if (!markerOwnership) return;
  releaseGuardianPidMarker(markerOwnership);
  markerOwnership = null;
};

// Startup errors and unexpected exits must only release a marker acquired by
// this process. The helper compares the persisted ownership token before
// unlinking, so a later guardian cannot be damaged by cleanup.
process.once('exit', releaseOwnedMarker);

const main = async () => {
  // W-C: the Windows early-exit is removed. The same singleton marker +
  // createManagedOpenCodeGuardian flow runs on every
  // platform; the IPC transport factory inside `ManagedOpenCodeGuardian`
  // dispatches to the platform-correct backend.
  const args = parseArgs(process.argv);
  const paths = resolveGuardianPaths({
    dataDir: args.dataDir,
    socketPath: args.socketPath,
    portPath: args.portPath,
  });
  const effectivePaths = {
    ...paths,
  };
  const username = typeof args.username === 'string' && args.username.length > 0
    ? args.username
    : (effectivePaths.platform === 'win32' ? resolveCurrentUsername({ log: console.warn }) : undefined);
  ensurePrivateDirectory(effectivePaths.rootDir, {
    platform: effectivePaths.platform,
    username,
    log: console.warn,
  });
  const pidFile = effectivePaths.pidFile;
  markerOwnership = await acquireGuardianPidMarker({
    pidFile,
    identity: readProcessIdentity(process.pid),
    requireIdentity: true,
  });

  let guardian;

  const shutdown = async (signal) => {
    console.log(`[guardian-cli] received ${signal}, shutting down...`);
    try {
      await guardian.stop();
    } catch (error) {
      console.error('[guardian-cli] shutdown error:', error.message);
      // A failed child termination leaves the guardian authoritative and
      // reachable so an operator can retry through authenticated IPC. Do not
      // remove the singleton marker or report a clean process exit while a
      // live child record remains.
      return;
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  // SIGHUP is the POSIX reload signal. Windows uses SIGBREAK because Node
  // does not deliver SIGHUP there. Both handlers only restart timers; they
  // do not terminate the guardian.
  const reloadTimers = (signal) => {
    console.log(`[guardian-cli] received ${signal}, reloading config...`);
    void guardian.reload().catch((error) => {
      console.error(`[guardian-cli] reload failed: ${error.message}`);
    });
  };
  process.on('SIGHUP', () => reloadTimers('SIGHUP'));
  if (process.platform === 'win32') {
    process.on('SIGBREAK', () => reloadTimers('SIGBREAK'));
  }

  try {
    guardian = createManagedOpenCodeGuardian({
      rootDir: effectivePaths.rootDir,
      socketPath: effectivePaths.socketPath,
      portPath: effectivePaths.portPath,
      authSecretPath: effectivePaths.authSecretPath,
      username,
      healthCheckIntervalMs: args.healthInterval,
      leaseRenewalIntervalMs: args.leaseInterval,
      onStopped: () => {
        releaseOwnedMarker();
        process.exit(0);
      },
    });
    await guardian.start();
  } catch (error) {
    console.error('[guardian-cli] failed to start:', error.message);
    releaseOwnedMarker();
    process.exit(1);
  }

  // Block until stopped.
  await new Promise(() => {});
};

main().catch((error) => {
  console.error('[guardian-cli] fatal error:', error);
  releaseOwnedMarker();
  process.exit(1);
});
