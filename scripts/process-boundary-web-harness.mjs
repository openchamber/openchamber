#!/usr/bin/env node
// Real Node child acting as the "web" process for the
// process-boundary credential handoff integration test.
//
// It boots `GuardianClient` against a guardian launched by the parent
// test, performs spawn → credential → health over real IPC sockets,
// and proves the credential is never sent to the managed child before
// the unauthenticated proof is verified on the same socket.

import net from 'node:net';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { GuardianClient } from '../packages/web/server/lib/guardian/guardian-client.js';
import { performConnectionBoundManagedOpenCodeHealth } from '../packages/web/server/lib/guardian/health-client.js';
import {
  compareProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
} from '../packages/web/server/lib/guardian/process-identity.js';

const socketPath = process.env.OPENCHAMBER_GUARDIAN_SOCKET;
const launchPort = Number.parseInt(process.env.OPENCHAMBER_GUARDIAN_LAUNCH_PORT ?? '', 10);
const fixturePath = process.env.OPENCHAMBER_GUARDIAN_FIXTURE;
const ownerInstanceId = process.env.OPENCHAMBER_GUARDIAN_OWNER_ID ?? '';
const runtimeIdentity = process.env.OPENCHAMBER_GUARDIAN_RUNTIME_ID ?? '';
const launchFingerprint = process.env.OPENCHAMBER_GUARDIAN_LAUNCH_FINGERPRINT ?? '';
const launchCwd = process.env.OPENCHAMBER_GUARDIAN_LAUNCH_CWD ?? process.cwd();
const username = process.env.OPENCHAMBER_GUARDIAN_USERNAME ?? 'opencode';
const password = process.env.OPENCHAMBER_GUARDIAN_PASSWORD ?? '';

const redactBoundaryText = (value) => {
  const text = String(value ?? '');
  return password ? text.split(password).join('<redacted>') : text;
};

const redactBoundaryReport = (value) => {
  if (Array.isArray(value)) return value.map(redactBoundaryReport);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /^(?:password|credentialPassword)$/i.test(key)
        ? (entry === null || entry === undefined ? entry : '<redacted>')
        : redactBoundaryReport(entry),
    ]));
  }
  return typeof value === 'string' ? redactBoundaryText(value) : value;
};

if (!socketPath || !fixturePath
  || !Number.isSafeInteger(launchPort) || launchPort <= 0
  || !ownerInstanceId || !runtimeIdentity || !launchFingerprint) {
  process.stderr.write('process-boundary harness: missing required env\n');
  process.exit(2);
}

const launchSpec = {
  binary: process.execPath,
  args: [fixturePath],
  hostname: '127.0.0.1',
  port: launchPort,
  cwd: launchCwd,
};

const owner = {
  ownerInstanceId,
  runtimeIdentity,
  launchFingerprint,
};

const exactOwnerMatches = (entry, owner) => entry?.ownerInstanceId === owner?.ownerInstanceId
  && entry?.runtimeIdentity === owner?.runtimeIdentity
  && entry?.launchFingerprint === owner?.launchFingerprint;

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

const readProcessGroupId = (pid) => {
  if (process.platform !== 'linux') return null;
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

const trackedChildExited = (child) => {
  const liveness = probeProcessLiveness(child.pid);
  if (liveness === 'dead') return true;
  if (liveness !== 'alive' || readLinuxProcessState(child.pid) !== 'Z') return false;
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
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return trackedChildExited(child);
};

const activeChildren = new Map();

const report = { createdChildren: [] };
let exitCode = 0;
let primaryFailure = false;
let signalExitCode = null;
let cleanupPromise = null;
let finalizationPromise = null;
let finalized = false;
const client = new GuardianClient({
  socketPath,
  connectTimeoutMs: 2_000,
  requestTimeoutMs: 2_000,
});

const rememberSpawnedChild = (spawned, childOwner, childLaunchSpec) => {
  if (typeof spawned?.incarnation !== 'string') return;
  const identity = readProcessIdentity(spawned.pid);
  if (!identity?.processStartTicks || !identity.launch?.commandLine) {
    throw new Error('managed child process identity was unavailable for cleanup');
  }
  activeChildren.set(spawned.incarnation, {
    incarnation: spawned.incarnation,
    pid: spawned.pid,
    owner: childOwner,
    launchSpec: childLaunchSpec,
    identity,
  });
  report.createdChildren.push({
    incarnation: spawned.incarnation,
    pid: spawned.pid,
    processStartTicks: identity.processStartTicks,
    owner: childOwner,
    launch: identity.launch,
    processOwner: identity.owner,
  });
};

const cleanupManagedChildren = () => {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    let firstError = null;
    if (clientConnected) {
      try {
        const listed = await client.list();
        for (const entry of listed) {
          const known = activeChildren.get(entry?.incarnation);
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
      let stopError = null;
      if (clientConnected) {
        try {
          await client.stop({ incarnation: child.incarnation, owner: child.owner });
        } catch (error) {
          stopError = error;
        }
      }

      let exited = await waitForTrackedChildExit(child);
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (exited) break;
        const actual = readProcessIdentity(child.pid);
        if (!actual || compareProcessIdentity(child.identity, actual) !== null) break;
        const processGroupId = readProcessGroupId(child.pid);
        let signalFailed = false;
        if (processGroupId === child.pid) {
          try { process.kill(-child.pid, signal); } catch (error) {
            if (error?.code !== 'ESRCH') signalFailed = true;
          }
        }
        try { process.kill(child.pid, signal); } catch (error) {
          if (error?.code !== 'ESRCH') signalFailed = true;
        }
        if (signalFailed) {
          firstError ||= new Error(`failed to send ${signal} to managed child ${child.incarnation}`);
          break;
        }
        exited = await waitForTrackedChildExit(child, signal === 'SIGTERM' ? 500 : 1_000);
      }

      if (!exited) {
        const error = new Error(`managed child ${child.incarnation} did not exit after bounded cleanup`);
        error.code = 'BOUNDARY_CHILD_CLEANUP_UNRESOLVED';
        if (stopError) error.cause = stopError;
        firstError ||= error;
        continue;
      }

      if (clientConnected) {
        try {
          const remaining = await client.list();
          if (remaining.some((entry) => entry?.incarnation === child.incarnation
            && exactOwnerMatches(entry, child.owner))) {
            firstError ||= new Error(`managed child ${child.incarnation} remains in guardian state`);
            continue;
          }
        } catch (error) {
          firstError ||= error;
          continue;
        }
      }
      if (stopError) firstError ||= stopError;
      else activeChildren.delete(child.incarnation);
    }
    return firstError;
  })();
  return cleanupPromise;
};

const confirmTrackedChildStopped = async (incarnation) => {
  const child = activeChildren.get(incarnation);
  if (!child) return;
  if (!await waitForTrackedChildExit(child)) {
    throw new Error(`managed child ${incarnation} did not exit after guardian stop`);
  }
  const remaining = await client.list();
  if (remaining.some((entry) => entry?.incarnation === incarnation
    && exactOwnerMatches(entry, child.owner))) {
    throw new Error(`managed child ${incarnation} remains after guardian stop`);
  }
  activeChildren.delete(incarnation);
};

const finalize = () => {
  if (finalizationPromise) {
    return finalizationPromise.then(() => {
      if (!finalized) {
        finalized = true;
        process.stdout.write(`${JSON.stringify(redactBoundaryReport(report))}\n`);
        process.exit(signalExitCode ?? exitCode);
      }
    });
  }
  finalizationPromise = (async () => {
    let cleanupError = null;
    try {
      cleanupError = process.env.OPENCHAMBER_BOUNDARY_FAIL_CLEANUP === '1'
        ? new Error('intentional process-boundary cleanup failure')
        : await cleanupManagedChildren();
    } catch (error) {
      cleanupError = error;
    } finally {
      client.disconnect();
    }
    if (cleanupError) {
      report.cleanupError = {
        message: redactBoundaryText(cleanupError?.message ?? String(cleanupError)),
        code: cleanupError?.code ?? null,
      };
      if (!primaryFailure && signalExitCode === null) exitCode = 1;
    }
    if (!finalized) {
      finalized = true;
      process.stdout.write(`${JSON.stringify(redactBoundaryReport(report))}\n`);
      process.exit(signalExitCode ?? exitCode);
    }
  })();
  return finalizationPromise;
};

let clientConnected = false;
process.once('SIGTERM', () => {
  if (finalized || primaryFailure) return;
  primaryFailure = true;
  signalExitCode = 143;
  exitCode = signalExitCode;
  report.error = { message: 'received SIGTERM', code: 'SIGTERM' };
  void finalize();
});
process.once('SIGINT', () => {
  if (finalized || primaryFailure) return;
  primaryFailure = true;
  signalExitCode = 130;
  exitCode = signalExitCode;
  report.error = { message: 'received SIGINT', code: 'SIGINT' };
  void finalize();
});

try {
  await client.connect();
  clientConnected = true;

  // 1. Spawn the password-protected managed child through the guardian.
  const spawned = await client.spawn({
    ...launchSpec,
    env: {
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    owner,
    launchSpec,
  });
  rememberSpawnedChild(spawned, owner, launchSpec);
  report.spawn = { port: spawned.port, incarnation: spawned.incarnation };
  if (process.env.OPENCHAMBER_BOUNDARY_FAIL_AFTER_SPAWN === '1') {
    throw new Error('intentional process-boundary failure after managed child spawn');
  }
  if (process.env.OPENCHAMBER_BOUNDARY_HOLD_AFTER_SPAWN === '1') {
    await new Promise(() => {});
  }

  // 2. A fresh socket cannot expose its outgoing request headers to this
  //    process. Assert the fixture's observable 401 fail-closed response
  //    instead; the connection-bound health path below covers proof ordering.
  const preProof = await new Promise((resolve) => {
    let status = null;
    const probe = net.createConnection({ host: '127.0.0.1', port: launchPort }, () => {
      probe.write(
        'GET /global/health HTTP/1.1\r\n'
          + 'Host: 127.0.0.1\r\n'
          + 'Connection: close\r\n'
          + '\r\n',
      );
    });
    probe.on('data', (chunk) => {
      const text = chunk.toString('latin1');
      const statusMatch = text.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/);
      if (statusMatch) status = Number.parseInt(statusMatch[1], 10);
    });
    probe.on('end', () => resolve({ status }));
    probe.on('error', () => resolve({ status }));
  });
  if (preProof.status !== 401) {
    throw new Error(`pre-proof fixture request was not rejected (status=${preProof.status})`);
  }
  report.preProofStatus = preProof.status;

  // 3. Retrieve the credential through the authenticated owner-scoped RPC.
  const credential = await client.credential({
    incarnation: spawned.incarnation,
    owner,
  });
  report.credential = {
    username: credential.username,
    password: '<redacted>',
    passwordMatches: credential.password === password,
  };

  // 4. Drive the connection-bound health probe end-to-end through the
  //    real `performConnectionBoundManagedOpenCodeHealth` so the harness
  //    exercises the exact proof + reuse contract the production web
  //    path uses, and the real fixture validates the credential.
  const health = await performConnectionBoundManagedOpenCodeHealth({
    url: `http://127.0.0.1:${launchPort}/global/health`,
    record: {
      incarnation: spawned.incarnation,
      ownerInstanceId: owner.ownerInstanceId,
      runtimeIdentity: owner.runtimeIdentity,
      launchFingerprint: owner.launchFingerprint,
      port: launchPort,
    },
    credential,
  });
  report.health = health;

  // 5. Wrong-owner credential retrieval must fail closed without ever
  //    surfacing the stored credential.
  const wrongOwner = {
    ownerInstanceId: 'wrong-owner-id',
    runtimeIdentity: owner.runtimeIdentity,
    launchFingerprint: owner.launchFingerprint,
  };
  try {
    await client.credential({ incarnation: spawned.incarnation, owner: wrongOwner });
    report.wrongOwner = { rejected: false };
    exitCode = 1;
  } catch (error) {
    if (!/ownership identity does not match/.test(error?.message ?? '')) {
      throw error;
    }
    report.wrongOwner = {
      rejected: true,
      code: error?.code ?? null,
      message: redactBoundaryText(error?.message ?? String(error)),
    };
  }

  // 6. Graceful restart: stop the fixture, spawn a new one with the
  //    same owner, and prove the credential is restored.
  await client.stop({ incarnation: spawned.incarnation, owner });
  await confirmTrackedChildStopped(spawned.incarnation);
  const restartPort = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const restartSpec = { ...launchSpec, port: restartPort };
  const restartOwner = {
    ownerInstanceId: owner.ownerInstanceId,
    runtimeIdentity: owner.runtimeIdentity,
    launchFingerprint: createHash('sha256')
      .update(JSON.stringify([
        restartSpec.binary,
        restartSpec.args,
        restartSpec.hostname,
        restartSpec.port,
        restartSpec.cwd,
      ]))
      .digest('base64url'),
  };
  const restart = await client.spawn({
    ...restartSpec,
    env: {
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    owner: restartOwner,
    launchSpec: restartSpec,
  });
  rememberSpawnedChild(restart, restartOwner, restartSpec);
  const restartCredential = await client.credential({
    incarnation: restart.incarnation,
    owner: restartOwner,
  });
  report.restart = {
    credential: {
      username: restartCredential.username,
      password: '<redacted>',
      passwordMatches: restartCredential.password === password,
    },
    health: await performConnectionBoundManagedOpenCodeHealth({
      url: `http://127.0.0.1:${restartPort}/global/health`,
      record: {
        incarnation: restart.incarnation,
        ownerInstanceId: restartOwner.ownerInstanceId,
        runtimeIdentity: restartOwner.runtimeIdentity,
        launchFingerprint: restartOwner.launchFingerprint,
        port: restartPort,
      },
      credential: restartCredential,
    }),
  };
  await client.stop({ incarnation: restart.incarnation, owner: restartOwner });
  await confirmTrackedChildStopped(restart.incarnation);
} catch (error) {
  primaryFailure = true;
  report.error = {
    message: redactBoundaryText(error?.message ?? String(error)),
    code: error?.code ?? null,
  };
  exitCode = 1;
} finally {
  await finalize();
}
