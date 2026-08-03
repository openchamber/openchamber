#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createManagedOpenCodeGuardian } from '../server/lib/guardian/guardian.js';
import { resolveCurrentUsername } from '../server/lib/guardian/windows-acl.js';
import { ensurePrivateDirectory } from '../server/lib/opencode/managed-opencode-handoff-v2/filesystem.js';
import { resolveGuardianPaths } from '../server/lib/guardian/paths.js';
import { probeProcessLiveness, readProcessIdentity } from '../server/lib/guardian/process-identity.js';
import { recoverStaleGuardianTransportArtifacts } from '../server/lib/guardian/ipc-transport.js';
import {
  acquireGuardianPidMarker,
  releaseGuardianPidMarker,
  updateGuardianPidMarkerTransportIdentity,
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
    } else if (arg === '--username' || arg.startsWith('--username=')) {
      throw new Error('The --username option is not supported; Windows ACLs always use the current Windows user.');
    }
  }
  return args;
};

let markerOwnership = null;
let shutdownRetryHold = null;

const retainProcessForShutdownRetry = () => {
  if (shutdownRetryHold) return;
  // A failed stop closes the listener before reporting an uncertain artifact
  // cleanup. Keep the standalone process and its marker alive so a later
  // signal can retry the same authoritative guardian shutdown.
  shutdownRetryHold = setInterval(() => {}, 1000);
};

const releaseOwnedMarker = () => {
  if (!markerOwnership) return;
  releaseGuardianPidMarker(markerOwnership);
  markerOwnership = null;
};

export const shouldRetainGuardianAuthority = (guardian, error) => Boolean(
  guardian
  && error?.cleanupSettled !== true
  && (
    error?.code === 'GUARDIAN_CLEANUP_UNCERTAIN'
    || error?.code === 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN'
  )
);

export const shouldReleaseGuardianMarkerAfterStartupFailure = (guardian, error) => (
  !shouldRetainGuardianAuthority(guardian, error)
  && (error?.cleanupSettled === true || !guardian)
);

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
  // The production entrypoint always derives the Windows ACL principal from
  // the current process. Test callers inject usernames through the lower-level
  // filesystem/guardian dependency seams instead of a CLI principal flag.
  const username = effectivePaths.platform === 'win32'
    ? resolveCurrentUsername({ log: console.warn })
    : undefined;
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
    onVerifiedStale: ({ marker }) => recoverStaleGuardianTransportArtifacts({
      platform: effectivePaths.platform,
      socketPath: effectivePaths.socketPath,
      portPath: effectivePaths.portPath,
      priorMarker: marker,
      liveness: probeProcessLiveness,
      username,
    }),
  });

  let guardian;

  const shutdown = async (signal) => {
    console.log(`[guardian-cli] received ${signal}, shutting down...`);
    try {
      await guardian.stop();
    } catch (error) {
      console.error('[guardian-cli] shutdown error:', error.message);
      // A failed child or transport termination leaves the guardian
      // authoritative and retryable. Do not remove the singleton marker or
      // report a clean process exit while cleanup remains uncertain.
      retainProcessForShutdownRetry();
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
      onTransportReady: (transportIdentity) => {
        if (effectivePaths.platform === 'win32') return;
        markerOwnership = updateGuardianPidMarkerTransportIdentity(
          markerOwnership,
          transportIdentity,
        );
      },
      onStopped: () => {
        if (shutdownRetryHold) {
          clearInterval(shutdownRetryHold);
          shutdownRetryHold = null;
        }
        releaseOwnedMarker();
        process.exit(0);
      },
    });
    await guardian.start();
  } catch (error) {
    console.error('[guardian-cli] failed to start:', error.message);
    if (shouldRetainGuardianAuthority(guardian, error)) {
      // Startup reached the transport but could not prove that cleanup
      // completed. Keep the process and marker authoritative so SIGTERM/SIGINT
      // can retry guardian.stop() instead of allowing a second guardian to
      // race an unresolved discovery/socket artifact.
      retainProcessForShutdownRetry();
    } else if (shouldReleaseGuardianMarkerAfterStartupFailure(guardian, error)) {
      // The guardian explicitly marked startup rollback clean, or construction
      // failed before a guardian instance existed. Only those paths have
      // proved that no live transport/child authority remains.
      releaseOwnedMarker();
      process.exit(1);
    } else {
      // An unclassified failure after guardian construction is equivalent to an
      // unexpected parent exit: retain the marker rather than allowing a new
      // guardian to race an artifact whose ownership was not verified.
      retainProcessForShutdownRetry();
    }
  }

  // Block until stopped.
  await new Promise(() => {});
};

const isDirectInvocation = (() => {
  if (!process.argv[1]) return false;
  const entrypointPath = path.resolve(fileURLToPath(import.meta.url));
  const invokedPath = path.resolve(process.argv[1]);
  if (invokedPath === entrypointPath) return true;
  try {
    return path.resolve(fs.realpathSync(invokedPath)) === entrypointPath;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((error) => {
    console.error('[guardian-cli] fatal error:', error);
    process.exit(1);
  });
}
