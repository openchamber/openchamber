#!/usr/bin/env node
//
// Web-process boundary helper for `scripts/web-restart-boundary-posix.sh`.
//
// This helper simulates the narrow guardian-facing role the bundled
// `openchamber` web server would have in a real deployment: it boots a `GuardianClient`,
// spawns the managed-child fixture, retrieves the credential through
// the authenticated owner-scoped RPC, performs a graceful restart,
// and verifies a wrong-owner / port-swap scenario still fails closed.
//
// The script prints `ok` on success and exits non-zero on any
// deviation. A real web binary is not bundled into this worktree, so
// the helper is the closest local process boundary.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { GuardianClient } from '../packages/web/server/lib/guardian/guardian-client.js';
import { performConnectionBoundManagedOpenCodeHealth } from '../packages/web/server/lib/guardian/health-client.js';
import {
  compareProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
} from '../packages/web/server/lib/guardian/process-identity.js';

const readFlag = (name, fallback = undefined) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
};

const socketPath = readFlag('--socket-path');
const secretPath = readFlag('--secret-path');
const fixturePath = readFlag('--fixture');
const cwd = readFlag('--cwd', process.cwd());
const childStatePath = readFlag('--child-state-path');
const configuredOwnerInstanceId = readFlag('--owner-instance-id', 'web-restart-boundary-owner');
const configuredRuntimeIdentity = readFlag('--runtime-identity', 'web-restart-boundary-runtime');
const cleanupStatePath = readFlag('--cleanup-state');
const cleanupOwned = readFlag('--cleanup-owned') !== undefined;
const guardianStatePath = readFlag('--guardian-state-path');
const recordProcessStatePath = readFlag('--record-process-state');
const recordProcessPid = Number.parseInt(readFlag('--pid', ''), 10);
const recordProcessRole = readFlag('--role', 'process');
const recordExpectedCommand = readFlag('--expected-command');
const recordExpectedCwd = readFlag('--expected-cwd');
const recordExpectedDataDir = readFlag('--expected-data-dir');
const recordExpectedSocketPath = readFlag('--expected-socket-path');
const cleanupGraceMs = Number.parseInt(readFlag('--grace-ms', '1000'), 10);
const BOUNDARY_PASSWORD = 'boundary-secret';

const redactBoundaryText = (value) => String(value ?? '')
  .split(BOUNDARY_PASSWORD)
  .join('<redacted>');

const ownerKey = (owner) => [
  owner?.ownerInstanceId,
  owner?.runtimeIdentity,
  owner?.launchFingerprint,
].join('\0');

const isCompleteOwner = (owner) => typeof owner?.ownerInstanceId === 'string'
  && owner.ownerInstanceId.length > 0
  && typeof owner?.runtimeIdentity === 'string'
  && owner.runtimeIdentity.length > 0
  && typeof owner?.launchFingerprint === 'string'
  && owner.launchFingerprint.length > 0;

const writeProcessState = (statePath, state) => {
  if (typeof statePath !== 'string' || statePath.length === 0) {
    throw new Error('process state path is required');
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the primary error */ }
  }
};

const removeProcessState = (statePath, incarnation = undefined) => {
  if (typeof statePath !== 'string' || statePath.length === 0) return;
  if (incarnation !== undefined) {
    try {
      const current = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (current?.incarnation !== incarnation) return;
    } catch (error) {
      if (error?.code !== 'ENOENT') return;
    }
  }
  try { fs.rmSync(statePath, { force: true }); } catch { /* idempotent cleanup */ }
};

const readProcessState = (statePath, expectedOwner = undefined) => {
  try {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (!state || state.version !== 1
      || !['guardian', 'managed-child', 'process'].includes(state.role)
      || !Number.isSafeInteger(state.pid) || state.pid <= 0
      || !state.identity?.processStartTicks
      || !state.identity?.launch?.commandLine) {
      return null;
    }
    if (state.role === 'managed-child' && (!isCompleteOwner(state.owner)
      || (expectedOwner
        && (state.owner.ownerInstanceId !== expectedOwner.ownerInstanceId
          || state.owner.runtimeIdentity !== expectedOwner.runtimeIdentity)))) return null;
    return state;
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    return null;
  }
};

const processStateMatches = (state) => {
  const actual = readProcessIdentity(state.pid);
  return actual !== null && compareProcessIdentity(state.identity, actual) === null;
};

const readProcessGroupId = (pid) => {
  try {
    const statLine = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingParen = statLine.lastIndexOf(')');
    if (closingParen < 0) return null;
    const fields = statLine.slice(closingParen + 2).trim().split(/\s+/);
    const processGroupId = Number.parseInt(fields[2], 10);
    return Number.isSafeInteger(processGroupId) && processGroupId > 0 ? processGroupId : null;
  } catch {
    return null;
  }
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const readLinuxProcessState = (pid) => {
  if (process.platform !== 'linux') return null;
  try {
    const statLine = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closingParen = statLine.lastIndexOf(')');
    if (closingParen < 0) return null;
    const fields = statLine.slice(closingParen + 2).trim().split(/\s+/);
    return fields[0] || null;
  } catch {
    return null;
  }
};

const isExpectedZombie = (state) => {
  if (readLinuxProcessState(state.pid) !== 'Z') return false;
  const actual = readProcessIdentity(state.pid);
  return actual?.processStartTicks !== null
    && String(actual?.processStartTicks) === String(state.identity?.processStartTicks);
};

const isProcessStateExited = (state) => {
  const liveness = probeProcessLiveness(state.pid);
  return liveness === 'dead' || isExpectedZombie(state);
};

const waitForProcessStateExit = async (state, statePath, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (isProcessStateExited(state)) {
      removeProcessState(statePath);
      return true;
    }
    const liveness = probeProcessLiveness(state.pid);
    if (liveness !== 'alive' || !processStateMatches(state)) return false;
    await sleep(25);
  }
  return false;
};

const cleanupDetachedProcessState = async (statePath, graceMs = 1000, expectedOwner = undefined) => {
  const state = readProcessState(statePath, expectedOwner);
  if (state === undefined) return true;
  if (!state) return false;
  if (isProcessStateExited(state)) {
    removeProcessState(statePath);
    return true;
  }
  if (probeProcessLiveness(state.pid) !== 'alive' || !processStateMatches(state)) return false;

  const signalProcess = (signal) => {
    if (!processStateMatches(state)) return false;
    const processGroupId = state.role === 'managed-child' ? readProcessGroupId(state.pid) : null;
    if (processGroupId === state.pid) {
      try { process.kill(-state.pid, signal); } catch (error) {
        if (error?.code !== 'ESRCH') return false;
      }
    }
    try { process.kill(state.pid, signal); } catch (error) {
      if (error?.code !== 'ESRCH') return false;
    }
    return true;
  };

  if (!signalProcess('SIGTERM')) return false;
  if (await waitForProcessStateExit(state, statePath, Math.max(0, graceMs))) return true;
  if (probeProcessLiveness(state.pid) !== 'alive' || !processStateMatches(state)) return false;

  if (!signalProcess('SIGKILL')) return false;
  return waitForProcessStateExit(state, statePath, 1000);
};

const recordProcessState = (statePath, pid, role, {
  expectedCommand = undefined,
  expectedCwd = undefined,
  expectedDataDir = undefined,
  expectedSocketPath = undefined,
} = {}) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  const identity = readProcessIdentity(pid);
  if (!identity?.processStartTicks || !identity.launch?.commandLine) return false;
  if (expectedCwd && identity.launch.cwd !== expectedCwd) return false;
  if (expectedCommand) {
    const actualArgv = identity.launch.commandLine.split('\0');
    const expectedArgv = [
      actualArgv[0],
      path.resolve(expectedCommand),
      ...(expectedDataDir && expectedSocketPath
        ? ['--data-dir', expectedDataDir, '--socket-path', expectedSocketPath]
        : []),
    ];
    const executableName = path.basename(actualArgv[0] ?? '').toLowerCase();
    if (!/^(?:node|nodejs)(?:\.exe)?$/.test(executableName)
      || actualArgv.length !== expectedArgv.length
      || actualArgv.some((value, index) => value !== expectedArgv[index])) return false;
  }
  writeProcessState(statePath, { version: 1, role, pid, identity });
  return true;
};

const exactOwnerMatches = (entry, owner) => entry?.ownerInstanceId === owner?.ownerInstanceId
  && entry?.runtimeIdentity === owner?.runtimeIdentity
  && entry?.launchFingerprint === owner?.launchFingerprint;

const exactChildEntryMatches = (entry, state) => entry?.incarnation === state?.incarnation
  && exactOwnerMatches(entry, state?.owner)
  && Number(entry?.pid) === Number(state?.pid)
  && String(entry?.processStartTicks) === String(state?.identity?.processStartTicks);

const cleanupOwnedChildren = async ({
  socket,
  secret,
  ownerInstanceId,
  runtimeIdentity,
  childStatePath: expectedChildStatePath,
  guardianStatePath: expectedGuardianStatePath,
}) => {
  if (!socket || !secret || !ownerInstanceId || !runtimeIdentity || !expectedGuardianStatePath) return false;

  const guardianState = readProcessState(expectedGuardianStatePath);
  if (!guardianState || guardianState.role !== 'guardian'
    || probeProcessLiveness(guardianState.pid) !== 'alive'
    || !processStateMatches(guardianState)) return false;

  const expectedChildState = expectedChildStatePath
    ? readProcessState(expectedChildStatePath, { ownerInstanceId, runtimeIdentity })
    : undefined;
  if (expectedChildStatePath && expectedChildState === null) return false;

  if (process.env.OPENCHAMBER_BOUNDARY_FAIL_CLEANUP === '1') {
    process.stderr.write('web-restart-boundary helper: intentional cleanup failure\n');
    return false;
  }
  if (process.env.OPENCHAMBER_BOUNDARY_HANG_CLEANUP === '1') {
    await new Promise(() => {});
  }

  const client = new GuardianClient({ socketPath: socket, authSecretPath: secret });
  let ok = true;
  try {
    await client.connect();
    const entries = await client.list();
    if (expectedChildState) {
      const expectedEntry = entries.find((entry) => exactChildEntryMatches(entry, expectedChildState));
      const unexpectedSameRunOwner = entries.some((entry) => (
        entry?.ownerInstanceId === ownerInstanceId
        && entry?.runtimeIdentity === runtimeIdentity
        && !exactChildEntryMatches(entry, expectedChildState)
      ));
      if (unexpectedSameRunOwner) ok = false;

      let stopError = null;
      if (expectedEntry) {
        try {
          await client.stop({
            incarnation: expectedChildState.incarnation,
            owner: expectedChildState.owner,
          });
        } catch (error) {
          stopError = error;
        }
      }

      if (!await cleanupDetachedProcessState(expectedChildStatePath, 500, expectedChildState.owner)) {
        ok = false;
      }
      if (stopError) ok = false;

      const remaining = await client.list();
      if (remaining.some((entry) => exactChildEntryMatches(entry, expectedChildState))) ok = false;
    } else if (entries.some((entry) => (
      entry?.ownerInstanceId === ownerInstanceId
      && entry?.runtimeIdentity === runtimeIdentity
    ))) {
      // A run-owned child without its exact incarnation state is not safe to
      // infer from `list`; leave the guardian authority intact for escalation.
      ok = false;
    }
  } catch {
    ok = false;
  } finally {
    client.disconnect();
  }
  return ok;
};

if (cleanupStatePath) {
  const cleaned = await cleanupDetachedProcessState(cleanupStatePath, Number.isSafeInteger(cleanupGraceMs)
    ? cleanupGraceMs
    : 1000, {
      ownerInstanceId: configuredOwnerInstanceId,
      runtimeIdentity: configuredRuntimeIdentity,
    });
  if (!cleaned) process.stderr.write('web-restart-boundary helper: refused unsafe process cleanup\n');
  process.exit(cleaned ? 0 : 1);
}

if (recordProcessStatePath) {
  const recorded = recordProcessState(recordProcessStatePath, recordProcessPid, recordProcessRole, {
    expectedCommand: recordExpectedCommand,
    expectedCwd: recordExpectedCwd,
    expectedDataDir: recordExpectedDataDir,
    expectedSocketPath: recordExpectedSocketPath,
  });
  if (!recorded) process.stderr.write('web-restart-boundary helper: process identity unavailable\n');
  process.exit(recorded ? 0 : 1);
}

if (cleanupOwned) {
  const cleaned = await cleanupOwnedChildren({
    socket: socketPath,
    secret: secretPath,
    ownerInstanceId: configuredOwnerInstanceId,
    runtimeIdentity: configuredRuntimeIdentity,
    childStatePath,
    guardianStatePath,
  });
  if (!cleaned) process.stderr.write('web-restart-boundary helper: owner cleanup was incomplete\n');
  process.exit(cleaned ? 0 : 1);
}

if (!socketPath || !secretPath || !fixturePath) {
  throw new Error('web-restart-boundary helper requires --socket-path, --secret-path, and --fixture');
}

const reserveFreePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const waitForListening = async (port, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reachable = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = (value) => {
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      setTimeout(() => finish(false), 200).unref();
    });
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

const fingerprintFor = (launchSpec) => createHash('sha256')
  .update(JSON.stringify([
    launchSpec.binary,
    launchSpec.args,
    launchSpec.hostname,
    launchSpec.port,
    launchSpec.cwd,
  ]))
  .digest('base64url');

const main = async () => {
  const client = new GuardianClient({
    socketPath,
    authSecretPath: secretPath,
    connectTimeoutMs: 2_000,
    requestTimeoutMs: 2_000,
  });
  const ownedLaunches = new Map();
  const activeChildren = new Map();
  let exitCode = 0;
  let primaryFailure = false;
  let signalExitCode = null;
  let clientConnected = false;
  let guardianShutdownAcknowledged = false;
  let cleanupPromise = null;
  let finalizationPromise = null;
  let finalized = false;

  const rememberSpawnedChild = (spawned, owner, launchSpec) => {
    if (typeof spawned?.incarnation !== 'string') return;
    activeChildren.set(spawned.incarnation, {
      incarnation: spawned.incarnation,
      pid: spawned.pid,
      owner,
      launchSpec,
    });
    if (!childStatePath) return;
    const identity = readProcessIdentity(spawned.pid);
    if (!identity?.processStartTicks || !identity.launch?.commandLine) {
      throw new Error('managed child process identity was unavailable for cleanup');
    }
    activeChildren.get(spawned.incarnation).identity = identity;
    writeProcessState(childStatePath, {
      version: 1,
      role: 'managed-child',
      pid: spawned.pid,
      incarnation: spawned.incarnation,
      owner,
      launchSpec,
      identity,
    });
  };

  const forgetSpawnedChild = (incarnation) => {
    activeChildren.delete(incarnation);
    removeProcessState(childStatePath, incarnation);
  };

  const readLinuxProcessState = (pid) => {
    if (process.platform !== 'linux') return null;
    try {
      const statLine = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closingParen = statLine.lastIndexOf(')');
      if (closingParen < 0) return null;
      const fields = statLine.slice(closingParen + 2).trim().split(/\s+/);
      return fields[0] || null;
    } catch {
      return null;
    }
  };

  const trackedChildExited = (child) => {
    const liveness = probeProcessLiveness(child.pid);
    if (liveness === 'dead') return true;
    if (liveness !== 'alive') return false;
    if (readLinuxProcessState(child.pid) !== 'Z') return false;
    const actual = readProcessIdentity(child.pid);
    return actual?.processStartTicks !== null
      && String(actual?.processStartTicks) === String(child.identity?.processStartTicks);
  };

  const waitForTrackedChildExit = async (child, timeoutMs = 1_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      if (trackedChildExited(child)) return true;
      if (probeProcessLiveness(child.pid) !== 'alive') return false;
      const actual = readProcessIdentity(child.pid);
      if (!actual || compareProcessIdentity(child.identity, actual) !== null) return false;
      await sleep(25);
    }
    return trackedChildExited(child);
  };

  const signalTrackedChild = (child, signal) => {
    const actual = readProcessIdentity(child.pid);
    if (!actual || compareProcessIdentity(child.identity, actual) !== null) return false;
    const processGroupId = readProcessGroupId(child.pid);
    if (processGroupId === child.pid) {
      try { process.kill(-child.pid, signal); } catch (error) {
        if (error?.code !== 'ESRCH') return false;
      }
    }
    try { process.kill(child.pid, signal); } catch (error) {
      if (error?.code !== 'ESRCH') return false;
    }
    return true;
  };

  const cleanupTrackedChild = async (child) => {
    let firstError = null;
    if (clientConnected) {
      try {
        await client.stop({ incarnation: child.incarnation, owner: child.owner });
      } catch (error) {
        firstError = error;
      }
    }

    let exited = await waitForTrackedChildExit(child);
    if (!exited && signalTrackedChild(child, 'SIGTERM')) {
      exited = await waitForTrackedChildExit(child, 500);
    }
    if (!exited && signalTrackedChild(child, 'SIGKILL')) {
      exited = await waitForTrackedChildExit(child, 1_000);
    }
    if (!exited) {
      const error = new Error(`managed child ${child.incarnation} did not exit after bounded cleanup`);
      error.code = 'BOUNDARY_CHILD_CLEANUP_UNRESOLVED';
      if (firstError) error.cause = firstError;
      return error;
    }

    if (clientConnected) {
      try {
        const remaining = await client.list();
        if (remaining.some((entry) => (
          entry?.incarnation === child.incarnation
          && exactOwnerMatches(entry, child.owner)
        ))) {
          const error = new Error(`managed child ${child.incarnation} remains in guardian state`);
          error.code = 'BOUNDARY_CHILD_RECORD_UNRESOLVED';
          if (firstError) error.cause = firstError;
          return error;
        }
      } catch (error) {
        firstError ||= error;
      }
    }

    if (firstError) return firstError;
    forgetSpawnedChild(child.incarnation);
    return null;
  };

  const cleanupManagedChildren = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let firstError = null;
      if (clientConnected) {
        try {
          const listed = await client.list();
          for (const entry of listed) {
            if (typeof entry?.incarnation !== 'string') continue;
            const known = activeChildren.get(entry.incarnation);
            if (!known) continue;
            if (!exactOwnerMatches(entry, known.owner)
              || Number(entry.pid) !== Number(known.pid)
              || String(entry.processStartTicks) !== String(known.identity?.processStartTicks)) {
              firstError ||= new Error(`guardian returned a mismatched identity for ${entry.incarnation}`);
            }
          }
        } catch (error) {
          firstError = error;
        }
      }

      for (const child of activeChildren.values()) {
        const cleanupError = await cleanupTrackedChild(child);
        firstError ||= cleanupError;
      }
      return firstError;
    })();
    return cleanupPromise;
  };

  const finalize = () => {
    if (finalizationPromise) return finalizationPromise;
    finalizationPromise = (async () => {
      let cleanupError = null;
      try {
        if (!guardianShutdownAcknowledged) cleanupError = await cleanupManagedChildren();
        if (clientConnected && !guardianShutdownAcknowledged
          && process.env.OPENCHAMBER_BOUNDARY_LEAVE_GUARDIAN !== '1') {
          await client.shutdown();
          guardianShutdownAcknowledged = true;
          clientConnected = false;
        }
      } catch (error) {
        cleanupError ||= error;
      } finally {
        client.disconnect();
      }
      if (cleanupError) {
        process.stderr.write(
          `cleanup: ${redactBoundaryText(cleanupError?.message ?? String(cleanupError))}\n`,
        );
        if (!primaryFailure && signalExitCode === null) exitCode = 1;
      }
      if (!finalized) {
        finalized = true;
        process.stdout.write(primaryFailure || cleanupError ? 'failed\n' : 'ok\n');
        process.exit(signalExitCode ?? exitCode);
      }
    })();
    return finalizationPromise;
  };

  const handleSignal = (signal) => {
    if (finalized || primaryFailure) return;
    primaryFailure = true;
    signalExitCode = signal === 'SIGINT' ? 130 : 143;
    exitCode = signalExitCode;
    process.stderr.write(`received ${signal}\n`);
    void finalize();
  };
  process.once('SIGTERM', () => handleSignal('SIGTERM'));
  process.once('SIGINT', () => handleSignal('SIGINT'));

  try {
    await client.connect();
    clientConnected = true;

    // 1. Spawn the password-protected managed child.
    const port1 = await reserveFreePort();
    const launch1 = {
      binary: process.execPath,
      args: [fixturePath],
      hostname: '127.0.0.1',
      port: port1,
      cwd,
    };
    const owner1 = {
      ownerInstanceId: configuredOwnerInstanceId,
      runtimeIdentity: configuredRuntimeIdentity,
      launchFingerprint: fingerprintFor(launch1),
    };
    ownedLaunches.set(ownerKey(owner1), { owner: owner1, launchSpec: launch1 });
    const first = await client.spawn({
      ...launch1,
      env: {
        OPENCODE_SERVER_USERNAME: 'boundary-user',
        OPENCODE_SERVER_PASSWORD: BOUNDARY_PASSWORD,
      },
      owner: owner1,
      launchSpec: launch1,
    });
    if (!first?.incarnation) {
      throw new Error(`expected managed child incarnation, got ${JSON.stringify(first)}`);
    }
    rememberSpawnedChild(first, owner1, launch1);
    if (process.env.OPENCHAMBER_BOUNDARY_FAIL_AFTER_SPAWN === '1') {
      throw new Error('intentional process-boundary failure after managed child spawn');
    }
    const reachable1 = await waitForListening(port1);
    if (!reachable1) {
      throw new Error(`managed child never started listening on port ${port1}`);
    }

    // 2. A fresh socket cannot expose its outgoing request headers to this
    //    process. Assert the fixture's observable 401 fail-closed response;
    //    the connection-bound health path below covers proof ordering.
    const requestFixtureStatus = (port, authorization) => new Promise((resolve) => {
      let status = null;
      const probe = net.createConnection({ host: '127.0.0.1', port }, () => {
        const authorizationHeader = authorization === undefined
          ? ''
          : `Authorization: ${authorization}\r\n`;
        probe.write(
          'GET /global/health HTTP/1.1\r\n'
            + 'Host: 127.0.0.1\r\n'
            + 'Connection: close\r\n'
            + authorizationHeader
            + '\r\n',
        );
      });
      probe.on('data', (chunk) => {
        const text = chunk.toString('latin1');
        const statusMatch = text.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/);
        if (statusMatch) status = Number.parseInt(statusMatch[1], 10);
      });
      probe.on('end', () => resolve(status));
      probe.on('error', () => resolve(status));
    });
    const preProofStatus = await requestFixtureStatus(port1);
    if (preProofStatus !== 401) {
      throw new Error(`pre-proof fixture request was not rejected (status=${preProofStatus})`);
    }

    // 3. Authenticated credential retrieval over IPC.
    const credential1 = await client.credential({ incarnation: first.incarnation, owner: owner1 });
    if (credential1?.username !== 'boundary-user' || credential1?.password !== BOUNDARY_PASSWORD) {
      throw new Error(`unexpected credential: ${JSON.stringify({
        username: credential1?.username,
        password: credential1?.password ? '<redacted>' : null,
      })}`);
    }

    // 4. Authenticated health probe must succeed with the credential.
    const health1 = await performConnectionBoundManagedOpenCodeHealth({
      url: `http://127.0.0.1:${port1}/global/health`,
      record: {
        incarnation: first.incarnation,
        ownerInstanceId: owner1.ownerInstanceId,
        runtimeIdentity: owner1.runtimeIdentity,
        launchFingerprint: owner1.launchFingerprint,
        port: port1,
      },
      credential: credential1,
    });
    if (health1?.healthy !== true) {
      throw new Error(`expected healthy probe, got ${JSON.stringify(health1)}`);
    }

    // 5. Graceful restart: stop the old child, spawn a new one on a
    //    different port, and prove the credential is restored from the
    //    encrypted store through the same authenticated health contract.
    await client.stop({ incarnation: first.incarnation, owner: owner1 });
    forgetSpawnedChild(first.incarnation);
    const port2 = await reserveFreePort();
    const launch2 = { ...launch1, port: port2 };
    const owner2 = { ...owner1, launchFingerprint: fingerprintFor(launch2) };
    ownedLaunches.set(ownerKey(owner2), { owner: owner2, launchSpec: launch2 });
    const second = await client.spawn({
      ...launch2,
      env: {
        OPENCODE_SERVER_USERNAME: 'boundary-user',
        OPENCODE_SERVER_PASSWORD: BOUNDARY_PASSWORD,
      },
      owner: owner2,
      launchSpec: launch2,
    });
    if (!second?.incarnation) {
      throw new Error(`expected restarted managed child incarnation, got ${JSON.stringify(second)}`);
    }
    rememberSpawnedChild(second, owner2, launch2);
    const reachable2 = await waitForListening(port2);
    if (!reachable2) {
      throw new Error(`restarted managed child never started listening on port ${port2}`);
    }
    const credential2 = await client.credential({ incarnation: second.incarnation, owner: owner2 });
    if (credential2?.username !== 'boundary-user' || credential2?.password !== BOUNDARY_PASSWORD) {
      throw new Error('credential was not restored after graceful restart');
    }
    const restartHealth = await performConnectionBoundManagedOpenCodeHealth({
      url: `http://127.0.0.1:${port2}/global/health`,
      record: {
        incarnation: second.incarnation,
        ownerInstanceId: owner2.ownerInstanceId,
        runtimeIdentity: owner2.runtimeIdentity,
        launchFingerprint: owner2.launchFingerprint,
        port: port2,
      },
      credential: credential2,
    });
    if (restartHealth?.healthy !== true) {
      throw new Error(`expected healthy restart probe, got ${JSON.stringify(restartHealth)}`);
    }

    // 6. Wrong-owner / port-swap scenario must fail closed. The
    //    authenticated owner-scoped credential RPC must reject a
    //    foreign owner even when the active child is on the expected
    //    port; the fixture must still reject an unauthenticated probe.
    const wrongOwner = {
      ownerInstanceId: 'foreign-owner',
      runtimeIdentity: owner2.runtimeIdentity,
      launchFingerprint: owner2.launchFingerprint,
    };
    let wrongOwnerRejected = false;
    try {
      await client.credential({ incarnation: second.incarnation, owner: wrongOwner });
    } catch (error) {
      if (!/ownership identity does not match/.test(error?.message ?? '')) {
        throw new Error(
          `wrong-owner credential request returned an unexpected failure: ${redactBoundaryText(error?.message ?? String(error))}`,
        );
      }
      wrongOwnerRejected = true;
    }
    if (!wrongOwnerRejected) {
      throw new Error('wrong-owner credential request was not rejected');
    }
    const portSwapStatus = await requestFixtureStatus(port2, 'Basic ');
    if (portSwapStatus !== 401) {
      throw new Error(`port-swap fixture request was not rejected (status=${portSwapStatus})`);
    }

    // 7. Cleanup the restarted child so the guardian exits cleanly.
    await client.stop({ incarnation: second.incarnation, owner: owner2 });
    forgetSpawnedChild(second.incarnation);
    if (process.env.OPENCHAMBER_BOUNDARY_LEAVE_GUARDIAN !== '1') {
      await client.shutdown();
      guardianShutdownAcknowledged = true;
      clientConnected = false;
    }
  } catch (error) {
    primaryFailure = true;
    process.stderr.write(`fail: ${redactBoundaryText(error?.message ?? String(error))}\n`);
    exitCode = 1;
  } finally {
    await finalize();
  }
};

main().catch((error) => {
  process.stderr.write(`fail: ${redactBoundaryText(error?.message ?? String(error))}\n`);
  process.exit(1);
});
