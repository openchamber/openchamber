import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createManagedOpenCodeHandoffV2Store } from '../opencode/managed-opencode-handoff-v2/store.js';
import { createManagedOpenCodeHandoffV2Protocol } from '../opencode/managed-opencode-handoff-v2/protocol.js';
import { createManagedOpenCodeHandoffV2SecretProvider } from '../opencode/managed-opencode-handoff-v2/secret-provider.js';
import { createManagedOpenCodeCredentialStore } from '../opencode/managed-opencode-handoff-v2/credential-store.js';
import { createManagedOpenCodeGuardian } from './guardian.js';
import { GuardianClient } from './guardian-client.js';
import { performConnectionBoundManagedOpenCodeHealth } from './health-client.js';
import {
  compareProcessIdentity,
  probeProcessLiveness,
  readProcessIdentity,
} from './process-identity.js';

const REPO_ROOT = path.resolve(new URL('../../../../../', import.meta.url).pathname);
const FIXTURE_PATH = path.join(REPO_ROOT, 'scripts', 'guardian-test-opencode.js');
const WEB_PROCESS_HARNESS = path.join(REPO_ROOT, 'scripts', 'process-boundary-web-harness.mjs');
const POSIX_BOUNDARY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'web-restart-boundary-posix.sh');

const roots = [];
const boundaries = new Set();

const redactBoundaryText = (value, secrets = []) => {
  let text = String(value ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) {
      text = text.split(secret).join('<redacted>');
    }
  }
  return text;
};

const redactBoundaryReport = (value, secrets = []) => {
  if (Array.isArray(value)) return value.map((entry) => redactBoundaryReport(entry, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /^(?:password|credentialPassword)$/i.test(key)
        ? (entry === null || entry === undefined ? entry : '<redacted>')
        : redactBoundaryReport(entry, secrets),
    ]));
  }
  return typeof value === 'string' ? redactBoundaryText(value, secrets) : value;
};

const mkRoot = (label) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `openchamber-process-boundary-${label}-`));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  return root;
};

const reserveFreePort = async () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const createLaunchSpec = ({ port, fixturePath: fixture }) => {
  const launchSpec = {
    binary: process.execPath,
    args: [fixture],
    hostname: '127.0.0.1',
    port,
    cwd: REPO_ROOT,
  };
  return launchSpec;
};

const createLaunchFingerprint = (launchSpec) => createHash('sha256')
  .update(JSON.stringify([
    launchSpec.binary,
    launchSpec.args,
    launchSpec.hostname,
    launchSpec.port,
    launchSpec.cwd,
  ]))
  .digest('base64url');

const createOwner = (label, launchSpec) => ({
  ownerInstanceId: `process-boundary-owner-${label}`,
  runtimeIdentity: `process-boundary-runtime-${label}`,
  launchFingerprint: createLaunchFingerprint(launchSpec),
});

const waitForListeningPort = async (port, timeoutMs = 5000) => {
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
      setTimeout(() => finish(false), 250).unref();
    });
    if (reachable) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

const waitForOwnedChild = async (guardian, owner, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entries = await guardian.listChildren();
    if (entries.some((entry) => exactOwnerMatches(entry, owner))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const ownerKey = (owner) => [
  owner?.ownerInstanceId,
  owner?.runtimeIdentity,
  owner?.launchFingerprint,
].join('\0');

const exactOwnerMatches = (record, owner) => record?.ownerInstanceId === owner?.ownerInstanceId
  && record?.runtimeIdentity === owner?.runtimeIdentity
  && record?.launchFingerprint === owner?.launchFingerprint;

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

const expectedChildExited = (child) => {
  const liveness = probeProcessLiveness(child.pid);
  if (liveness === 'dead') return true;
  if (liveness !== 'alive' || readLinuxProcessState(child.pid) !== 'Z') return false;
  const actual = readProcessIdentity(child.pid);
  return actual?.processStartTicks !== null
    && String(actual?.processStartTicks) === String(child.identity?.processStartTicks);
};

const waitForExpectedChildExit = async (child, timeoutMs = 1_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (expectedChildExited(child)) return true;
    if (probeProcessLiveness(child.pid) !== 'alive') return false;
    const actual = readProcessIdentity(child.pid);
    if (!actual || compareProcessIdentity(child.identity, actual) !== null) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return expectedChildExited(child);
};

const runPosixBoundary = (extraEnv = {}) => spawnSync(
  'bash',
  [POSIX_BOUNDARY_SCRIPT],
  {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
  },
);

const listPosixBoundaryRoots = () => new Set(
  fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()
      && entry.name.startsWith('openchamber-web-restart-boundary.'))
    .map((entry) => path.join(os.tmpdir(), entry.name)),
);

const runPosixBoundaryWithSignal = () => new Promise((resolve, reject) => {
  const child = spawn('bash', [POSIX_BOUNDARY_SCRIPT], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      OPENCHAMBER_BOUNDARY_LEAVE_GUARDIAN: '1',
      OPENCHAMBER_BOUNDARY_HANG_CLEANUP: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let signalTimer;
  let hardTimer;
  let settled = false;
  let validatedIdentity = null;
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const finish = (result, error = null) => {
    if (settled) return;
    settled = true;
    clearTimeout(signalTimer);
    clearTimeout(hardTimer);
    if (error) reject(error);
    else resolve({ ...result, stdout, stderr });
  };

  signalTimer = setTimeout(() => {
    const expectedIdentity = readProcessIdentity(child.pid);
    const currentIdentity = readProcessIdentity(child.pid);
    if (!expectedIdentity?.launch?.commandLine?.includes(POSIX_BOUNDARY_SCRIPT)
      || path.resolve(expectedIdentity.launch.cwd || '') !== REPO_ROOT
      || !currentIdentity
      || compareProcessIdentity(expectedIdentity, currentIdentity) !== null) {
      finish(null, new Error('POSIX boundary shell identity could not be validated before SIGTERM'));
      return;
    }
    validatedIdentity = expectedIdentity;
    if (!child.kill('SIGTERM')) {
      finish(null, new Error('POSIX boundary shell did not accept SIGTERM'));
    }
  }, 1000);
  hardTimer = setTimeout(() => {
    const identity = readProcessIdentity(child.pid);
    if (validatedIdentity
      && identity
      && compareProcessIdentity(validatedIdentity, identity) === null) {
      try { child.kill('SIGKILL'); } catch { /* preserve the timeout evidence */ }
    }
    finish(null, new Error('POSIX boundary shell did not finish after bounded signal cleanup'));
  }, 20_000);
  child.once('error', (error) => finish(null, error));
  child.once('close', (code, signal) => finish({ code, signal }));
});

const confirmExpectedChildStopped = async (boundary, client, incarnation) => {
  const child = boundary.expectedChildren.get(incarnation);
  if (!child) return;
  if (!await waitForExpectedChildExit(child)) {
    throw new Error(`managed child ${incarnation} did not exit after guardian stop`);
  }
  const remaining = await client.list();
  if (remaining.some((entry) => entry?.incarnation === incarnation
    && exactOwnerMatches(entry, child.owner))) {
    throw new Error(`managed child ${incarnation} remains after guardian stop`);
  }
  boundary.expectedChildren.delete(incarnation);
};

const trackBoundary = (root, guardian, store) => {
  const boundary = {
    root,
    guardian,
    store,
    clients: new Set(),
    expectedChildren: new Map(),
    expectedOwnerKeys: new Set(),
    cleanupPromise: null,
    cleanupAttempted: false,
    cleanupReported: false,
  };
  boundaries.add(boundary);
  return boundary;
};

const trackClient = (boundary, client) => {
  boundary.clients.add(client);
  return client;
};

const trackExpectedChild = (boundary, spawned, owner, identity = undefined) => {
  if (!spawned || typeof spawned.incarnation !== 'string'
    || !Number.isSafeInteger(spawned.pid) || spawned.pid <= 0) {
    throw new Error('managed child identity was unavailable for boundary cleanup');
  }
  const observed = identity ?? readProcessIdentity(spawned.pid);
  if (!observed?.processStartTicks || !observed.launch?.commandLine) {
    throw new Error('managed child process identity was unavailable for boundary cleanup');
  }
  boundary.expectedChildren.set(spawned.incarnation, {
    incarnation: spawned.incarnation,
    pid: spawned.pid,
    owner,
    identity: observed,
  });
  boundary.expectedOwnerKeys.add(ownerKey(owner));
};

const trackReportedChildren = (boundary, children) => {
  for (const child of Array.isArray(children) ? children : []) {
    if (!child || typeof child.incarnation !== 'string'
      || !Number.isSafeInteger(child.pid) || child.pid <= 0
      || typeof child.processStartTicks !== 'string'
      || !child.owner || typeof child.owner.ownerInstanceId !== 'string'
      || typeof child.owner.runtimeIdentity !== 'string'
      || typeof child.owner.launchFingerprint !== 'string') continue;
    trackExpectedChild(boundary, {
      incarnation: child.incarnation,
      pid: child.pid,
    }, child.owner, {
      processStartTicks: child.processStartTicks,
      launch: child.launch ?? null,
      owner: child.processOwner ?? null,
    });
  }
};

const cleanupBoundary = (boundary) => {
  if (boundary.cleanupPromise) return boundary.cleanupPromise;
  boundary.cleanupAttempted = true;
  boundary.cleanupPromise = (async () => {
    const errors = [];
    const client = [...boundary.clients][0];
    let listed = [];
    try {
      listed = await boundary.guardian.listChildren();
    } catch (error) {
      errors.push(error);
    }

    const exactEntryMatches = (entry, child) => exactOwnerMatches(entry, child.owner)
      && Number(entry?.pid) === Number(child.pid)
      && String(entry?.processStartTicks) === String(child.identity?.processStartTicks);
    const validateList = (entries, expectedChildren) => {
      const validationErrors = [];
      if (!Array.isArray(entries)) {
        validationErrors.push(new Error('guardian child list was not an array'));
        return validationErrors;
      }

      for (const [incarnation, expected] of expectedChildren) {
        const matches = entries.filter((entry) => entry?.incarnation === incarnation);
        if (matches.length !== 1) {
          if (matches.length === 0 && expectedChildExited(expected)) continue;
          validationErrors.push(new Error(
            `guardian child list did not contain exactly one record for managed child ${incarnation}`,
          ));
          continue;
        }
        const [entry] = matches;
        if (!exactOwnerMatches(entry, expected.owner)
          || Number(entry.pid) !== Number(expected.pid)
          || String(entry.processStartTicks) !== String(expected.identity?.processStartTicks)) {
          validationErrors.push(new Error(`guardian returned a mismatched identity for ${incarnation}`));
        }
      }

      for (const entry of entries) {
        const expected = expectedChildren.get(entry?.incarnation);
        if (expected
          && exactOwnerMatches(entry, expected.owner)
          && Number(entry.pid) === Number(expected.pid)
          && String(entry.processStartTicks) === String(expected.identity?.processStartTicks)) continue;
        if (boundary.expectedOwnerKeys.has(ownerKey({
          ownerInstanceId: entry?.ownerInstanceId,
          runtimeIdentity: entry?.runtimeIdentity,
          launchFingerprint: entry?.launchFingerprint,
        }))) {
          validationErrors.push(new Error(`unexpected or mismatched run-owned child ${entry?.incarnation}`));
        } else if (entry?.incarnation) {
          validationErrors.push(new Error(`unexpected guardian child record ${entry.incarnation}`));
        } else {
          validationErrors.push(new Error('guardian returned an unidentifiable child record'));
        }
      }
      return validationErrors;
    };

    // A list error, missing exact owner/incarnation, or any foreign child is
    // an authority failure. Do not stop even a known child in that state: an
    // unscoped guardian stop would turn a diagnostic failure into a foreign
    // process termination. The root and guardian authority remain retained.
    if (errors.length === 0) {
      errors.push(...validateList(listed, boundary.expectedChildren));
    }

    // Stop only after the complete list has proved that every target is the
    // exact test-owned incarnation. Never use guardian.stop() as a fallback
    // after validation failure; it is reached only after all child records
    // have been removed and is therefore service teardown, not child cleanup.
    if (errors.length === 0) {
      if (!client && boundary.expectedChildren.size > 0) {
        errors.push(new Error('owner-scoped managed child cleanup requires a tracked client'));
      }
      for (const child of [...boundary.expectedChildren.values()]) {
        if (errors.length > 0) break;
        if (!listed.some((entry) => exactEntryMatches(entry, child))
          && expectedChildExited(child)) {
          boundary.expectedChildren.delete(child.incarnation);
          continue;
        }
        let stopError = null;
        try {
          await client.stop({ incarnation: child.incarnation, owner: child.owner });
        } catch (error) {
          stopError = error;
        }
        if (!await waitForExpectedChildExit(child)) {
          const error = new Error(`managed child ${child.incarnation} did not exit after bounded cleanup`);
          error.code = 'BOUNDARY_CHILD_CLEANUP_UNRESOLVED';
          if (stopError) error.cause = stopError;
          errors.push(error);
          continue;
        }
        try {
          const remaining = await boundary.guardian.listChildren();
          if (remaining.some((entry) => exactEntryMatches(entry, child))) {
            errors.push(new Error(`managed child ${child.incarnation} remains in guardian state`));
            continue;
          }
          const remainingErrors = validateList(
            remaining,
            new Map([...boundary.expectedChildren].filter(([incarnation]) => incarnation !== child.incarnation)),
          );
          if (remainingErrors.length > 0) {
            errors.push(...remainingErrors);
            continue;
          }
        } catch (error) {
          errors.push(error);
          continue;
        }
        boundary.expectedChildren.delete(child.incarnation);
        if (stopError) errors.push(stopError);
      }
    }

    if (errors.length === 0) {
      try {
        const afterChildren = await boundary.guardian.listChildren();
        if (!Array.isArray(afterChildren) || afterChildren.length > 0) {
          errors.push(new Error('guardian child state remained after owner-scoped cleanup'));
        }
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      try {
        await boundary.guardian.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 0) {
      const socketPath = boundary.guardian.socketPath;
      if (fs.existsSync(socketPath) || fs.existsSync(`${socketPath}.owner`)) {
        errors.push(new Error(`guardian transport artifacts remain at ${socketPath}`));
      }
    }
    for (const trackedClient of boundary.clients) {
      try { trackedClient.disconnect(); } catch (error) { errors.push(error); }
    }
    if (errors.length === 0) return null;
    return new AggregateError(errors, 'process-boundary cleanup failed');
  })();
  boundary.cleanupPromise.then((error) => { boundary.cleanupError = error; }).catch(() => {});
  return boundary.cleanupPromise;
};

const attachCleanupFailure = (primaryError, cleanupError) => {
  try { primaryError.cleanupError = cleanupError; } catch { /* preserve primary error */ }
  try {
    if (!primaryError.cause) primaryError.cause = cleanupError;
  } catch { /* preserve primary error */ }
};

const withBoundaryCleanup = async (boundary, body) => {
  let primaryError = null;
  try {
    return await body();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupError = await cleanupBoundary(boundary);
    boundary.cleanupReported = true;
    if (cleanupError) {
      if (primaryError) attachCleanupFailure(primaryError, cleanupError);
      else throw cleanupError;
    }
  }
};

const buildGuardian = async (root) => {
  const secretProvider = createManagedOpenCodeHandoffV2SecretProvider({ rootDir: root });
  const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
  await store.open?.();
  const protocol = createManagedOpenCodeHandoffV2Protocol({
    secretProvider,
    store,
    defaultLeaseMs: 60_000,
  });
  const credentialStore = createManagedOpenCodeCredentialStore({
    rootDir: root,
    secretProvider,
    platform: process.platform,
  });
  const guardian = createManagedOpenCodeGuardian({
    rootDir: root,
    store,
    protocol,
    secretProvider,
    credentialStore,
    healthCheckIntervalMs: 0,
    leaseRenewalIntervalMs: 0,
    cleanupIntervalMs: 0,
    managedHealthProbe: performConnectionBoundManagedOpenCodeHealth,
    log: () => {},
  });
  return { guardian, store };
};

afterEach(async () => {
  const cleanupResults = new Map();
  const errors = [];
  for (const boundary of boundaries) {
    const cleanupError = await cleanupBoundary(boundary);
    cleanupResults.set(boundary.root, cleanupError);
    if (cleanupError && !boundary.cleanupReported) {
      errors.push(cleanupError);
      process.stderr.write(
        `[process-boundary cleanup] ${cleanupError.message}\n`,
      );
    }
  }
  boundaries.clear();

  while (roots.length > 0) {
    const root = roots.pop();
    if (cleanupResults.get(root)) {
      process.stderr.write(`[process-boundary cleanup] retaining unresolved root ${root}\n`);
      continue;
    }
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
      process.stderr.write(`[process-boundary cleanup] retaining root ${root}: ${error.message}\n`);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'process-boundary afterEach cleanup failed');
});

describe('process-boundary guardian credential handoff', () => {
  // The real fixture (scripts/guardian-test-opencode.js) uses POSIX
  // expectations (chmod, signal handling) and is only meaningful on Linux.
  // The Windows path is covered separately by the hard-gated Windows
  // workflow and is intentionally not claimed by this local test. Bun is
  // also excluded: real child/process IPC evidence is collected by the
  // explicit Node >=22 runner, not by a Bun-compatible substitute.
   it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('boots the real guardian and managed-child fixture; restores the credential across a graceful restart and fails closed for a wrong owner', async () => {
    expect(fs.existsSync(FIXTURE_PATH)).toBe(true);

    const root = mkRoot('restart');
    const { guardian, store } = await buildGuardian(root);
    const boundary = trackBoundary(root, guardian, store);
    await guardian.start();

    const client = trackClient(boundary, new GuardianClient({ socketPath: guardian.socketPath }));

     await withBoundaryCleanup(boundary, async () => {
      await client.connect();
      const launchPort = await reserveFreePort();
      const launchSpec = createLaunchSpec({ port: launchPort, fixturePath: FIXTURE_PATH });
      const owner = createOwner('restart', launchSpec);

      // 1. Initial spawn through the authenticated IPC boundary.
      const firstSpawn = await client.spawn({
        ...launchSpec,
        env: {
          OPENCODE_SERVER_USERNAME: 'boundary-user',
          OPENCODE_SERVER_PASSWORD: 'boundary-secret',
        },
        owner,
        launchSpec,
      });
      trackExpectedChild(boundary, firstSpawn, owner);
      expect(firstSpawn).toMatchObject({ port: launchPort });
      expect(firstSpawn.incarnation).toEqual(expect.any(String));

      // 2. Retrieve the credential through the authenticated owner-scoped RPC.
      const firstCredential = await client.credential({
        incarnation: firstSpawn.incarnation,
        owner,
      });
      expect(firstCredential?.username).toBe('boundary-user');
      expect(firstCredential?.password === 'boundary-secret').toBe(true);

      // 3. Health probe through the same authenticated channel — the
      //    real fixture's password-protected endpoint must accept our
      //    credential only after the unauthenticated proof succeeded.
      const firstHealth = await client.health({
        incarnation: firstSpawn.incarnation,
        owner,
      });
      expect(firstHealth).toEqual({ healthy: true });
      const healthyFixturePort = await waitForListeningPort(launchPort);
      expect(healthyFixturePort).toBe(true);

      // 4. A fresh socket cannot expose its outgoing request headers to this
      //    caller; the fixture's 401 is the observable fail-closed check.
      const captureFixture = (port) => new Promise((resolve) => {
        let status = null;
        const probe = net.createConnection({ host: '127.0.0.1', port }, () => {
          probe.write(
            `GET /global/health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`,
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
      const before = await captureFixture(launchPort);
      // A fresh socket cannot expose its outgoing request headers to this
      // caller. The fixture's 401 is the observable fail-closed contract.
      expect(before.status).toBe(401);

      // 5. Graceful restart: stop the old fixture, spawn a new fixture on a
      //    new port, and prove the credential can be restored (re-derived
      //    from the encrypted store) without sending empty Authorization
      //    headers first.
       await client.stop({ incarnation: firstSpawn.incarnation, owner });
       await confirmExpectedChildStopped(boundary, client, firstSpawn.incarnation);

      const restartPort = await reserveFreePort();
      const restartSpec = createLaunchSpec({ port: restartPort, fixturePath: FIXTURE_PATH });
      const restartOwner = createOwner('restart', restartSpec);
      const restartSpawn = await client.spawn({
        ...restartSpec,
        env: {
          OPENCODE_SERVER_USERNAME: 'boundary-user',
          OPENCODE_SERVER_PASSWORD: 'boundary-secret',
        },
        owner: restartOwner,
        launchSpec: restartSpec,
      });
      trackExpectedChild(boundary, restartSpawn, restartOwner);
      expect(restartSpawn).toMatchObject({ port: restartPort });

      const restartCredential = await client.credential({
        incarnation: restartSpawn.incarnation,
        owner: restartOwner,
      });
      expect(restartCredential?.username).toBe('boundary-user');
      expect(restartCredential?.password === 'boundary-secret').toBe(true);

      const restartHealth = await client.health({
        incarnation: restartSpawn.incarnation,
        owner: restartOwner,
      });
      expect(restartHealth).toEqual({ healthy: true });

      // 6. Wrong-owner credential retrieval must fail closed without ever
      //    surfacing the stored credential. This is the port-swap /
      //    wrong-owner scenario.
      await expect(client.credential({
        incarnation: restartSpawn.incarnation,
        owner: createOwner('wrong', restartSpec),
      })).rejects.toMatchObject({
        code: 'execution_error',
        message: expect.stringMatching(/ownership identity does not match/),
      });

      // 7. Cleanup: stop the restart fixture and confirm `list` is empty
      //    so a subsequent adoption from the real web process starts clean.
       await client.stop({ incarnation: restartSpawn.incarnation, owner: restartOwner });
       await confirmExpectedChildStopped(boundary, client, restartSpawn.incarnation);
       const finalList = await client.list();
      expect(finalList).toEqual([]);
     });
   });

  // The web process harness boots `GuardianClient` against a guardian
  // launched in the test process; this is the closest local approximation
  // to a "true web-binary" process boundary without requiring the web
  // server build to be produced in the worktree.
  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('the web-process harness drives spawn → credential → health through real GuardianClient IPC and never sends the credential before proof + reuse', async () => {
    expect(fs.existsSync(WEB_PROCESS_HARNESS)).toBe(true);

    const root = mkRoot('harness');
    const { guardian, store } = await buildGuardian(root);
    const boundary = trackBoundary(root, guardian, store);
    await guardian.start();
    const client = trackClient(boundary, new GuardianClient({ socketPath: guardian.socketPath }));
    const launchPort = await reserveFreePort();
    const launchSpec = createLaunchSpec({ port: launchPort, fixturePath: FIXTURE_PATH });
    const owner = createOwner('harness', launchSpec);

    await withBoundaryCleanup(boundary, async () => {
    const harness = spawn(process.execPath, [WEB_PROCESS_HARNESS], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCHAMBER_GUARDIAN_SOCKET: guardian.socketPath,
        OPENCHAMBER_GUARDIAN_LAUNCH_PORT: String(launchPort),
        OPENCHAMBER_GUARDIAN_FIXTURE: FIXTURE_PATH,
        OPENCHAMBER_GUARDIAN_OWNER_ID: owner.ownerInstanceId,
        OPENCHAMBER_GUARDIAN_RUNTIME_ID: owner.runtimeIdentity,
        OPENCHAMBER_GUARDIAN_LAUNCH_FINGERPRINT: owner.launchFingerprint,
        OPENCHAMBER_GUARDIAN_LAUNCH_CWD: launchSpec.cwd,
        OPENCHAMBER_GUARDIAN_USERNAME: 'harness-user',
        OPENCHAMBER_GUARDIAN_PASSWORD: 'harness-secret',
      },
    });
    let stdout = '';
    let stderr = '';
    harness.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    harness.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    const exitInfo = await new Promise((resolve) => {
      harness.once('exit', (code, signal) => resolve({ code, signal }));
    });
    let rawReport;
    let report;
    try {
      rawReport = JSON.parse(stdout);
      report = redactBoundaryReport(rawReport, ['harness-secret']);
      trackReportedChildren(boundary, rawReport.createdChildren);
    } catch {
      const safeStderr = redactBoundaryText(stderr, ['harness-secret']);
      throw new Error(
        `harness did not emit a JSON report (exit=${JSON.stringify(exitInfo)}). `
          + `stderr=${safeStderr}`,
      );
    }
    if (exitInfo.code !== 0) {
      const safeStderr = redactBoundaryText(stderr, ['harness-secret']);
      throw new Error(
        `harness exited non-zero (${JSON.stringify(exitInfo)}). `
          + `report=${JSON.stringify(report)} stderr=${safeStderr}`,
      );
    }
    expect(JSON.stringify(rawReport).includes('harness-secret')).toBe(false);
    expect(report).toMatchObject({
      credential: {
        username: 'harness-user',
        password: '<redacted>',
        passwordMatches: true,
      },
      health: { healthy: true },
      preProofStatus: 401,
      wrongOwner: {
        rejected: true,
        message: expect.stringMatching(/ownership identity does not match/),
      },
    });
    // The harness is the "web" process; it must never log the secret.
    expect(stderr.includes('harness-secret')).toBe(false);

    await client.connect();
    await expect(client.list()).resolves.toEqual([]);
    });
  });

  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('stops the managed child when the web harness fails after spawn', async () => {
    expect(fs.existsSync(WEB_PROCESS_HARNESS)).toBe(true);

    const root = mkRoot('harness-failure');
    const { guardian, store } = await buildGuardian(root);
    const boundary = trackBoundary(root, guardian, store);
    await guardian.start();
    const client = trackClient(boundary, new GuardianClient({ socketPath: guardian.socketPath }));
    const launchPort = await reserveFreePort();
    const launchSpec = createLaunchSpec({ port: launchPort, fixturePath: FIXTURE_PATH });
    const owner = createOwner('harness-failure', launchSpec);
    await withBoundaryCleanup(boundary, async () => {
    const harness = spawn(process.execPath, [WEB_PROCESS_HARNESS], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OPENCHAMBER_GUARDIAN_SOCKET: guardian.socketPath,
        OPENCHAMBER_GUARDIAN_LAUNCH_PORT: String(launchPort),
        OPENCHAMBER_GUARDIAN_FIXTURE: FIXTURE_PATH,
        OPENCHAMBER_GUARDIAN_OWNER_ID: owner.ownerInstanceId,
        OPENCHAMBER_GUARDIAN_RUNTIME_ID: owner.runtimeIdentity,
        OPENCHAMBER_GUARDIAN_LAUNCH_FINGERPRINT: owner.launchFingerprint,
        OPENCHAMBER_GUARDIAN_LAUNCH_CWD: launchSpec.cwd,
        OPENCHAMBER_GUARDIAN_USERNAME: 'harness-user',
        OPENCHAMBER_GUARDIAN_PASSWORD: 'harness-secret',
        OPENCHAMBER_BOUNDARY_FAIL_AFTER_SPAWN: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    harness.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    harness.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    const exitInfo = await new Promise((resolve) => {
      harness.once('exit', (code, signal) => resolve({ code, signal }));
    });
    expect(exitInfo.code).toBe(1);
    expect(stderr).not.toContain('harness-secret');
    const rawReport = JSON.parse(stdout);
    trackReportedChildren(boundary, rawReport.createdChildren);
    expect(rawReport).toMatchObject({
      spawn: { port: launchPort },
      error: { message: 'intentional process-boundary failure after managed child spawn' },
    });
    await client.connect();
    await expect(client.list()).resolves.toEqual([]);
    });
  });

  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('preserves signal failure while cleaning the exact harness-owned child', async () => {
    const root = mkRoot('harness-signal');
    const { guardian, store } = await buildGuardian(root);
    const boundary = trackBoundary(root, guardian, store);
    await guardian.start();
    const client = trackClient(boundary, new GuardianClient({ socketPath: guardian.socketPath }));
    const launchPort = await reserveFreePort();
    const launchSpec = createLaunchSpec({ port: launchPort, fixturePath: FIXTURE_PATH });
    const owner = createOwner('harness-signal', launchSpec);

    await withBoundaryCleanup(boundary, async () => {
      const harness = spawn(process.execPath, [WEB_PROCESS_HARNESS], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENCHAMBER_GUARDIAN_SOCKET: guardian.socketPath,
          OPENCHAMBER_GUARDIAN_LAUNCH_PORT: String(launchPort),
          OPENCHAMBER_GUARDIAN_FIXTURE: FIXTURE_PATH,
          OPENCHAMBER_GUARDIAN_OWNER_ID: owner.ownerInstanceId,
          OPENCHAMBER_GUARDIAN_RUNTIME_ID: owner.runtimeIdentity,
          OPENCHAMBER_GUARDIAN_LAUNCH_FINGERPRINT: owner.launchFingerprint,
          OPENCHAMBER_GUARDIAN_LAUNCH_CWD: launchSpec.cwd,
          OPENCHAMBER_GUARDIAN_USERNAME: 'harness-user',
          OPENCHAMBER_GUARDIAN_PASSWORD: 'harness-secret',
          OPENCHAMBER_BOUNDARY_HOLD_AFTER_SPAWN: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      harness.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      harness.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      expect(await waitForOwnedChild(guardian, owner)).toBe(true);
      expect(harness.kill('SIGTERM')).toBe(true);
      const exitInfo = await new Promise((resolve) => {
        harness.once('close', (code, signal) => resolve({ code, signal }));
      });
      const rawReport = JSON.parse(stdout);
      trackReportedChildren(boundary, rawReport.createdChildren);
      expect(exitInfo.code).toBe(143);
      expect(rawReport.error).toEqual({ message: 'received SIGTERM', code: 'SIGTERM' });
      expect(stderr).not.toContain('harness-secret');
      await client.connect();
      await expect(client.list()).resolves.toEqual([]);
    });
  });

  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('fails a passing harness body when teardown reports a cleanup failure', async () => {
    const root = mkRoot('harness-cleanup-failure');
    const { guardian, store } = await buildGuardian(root);
    const boundary = trackBoundary(root, guardian, store);
    await guardian.start();
    const client = trackClient(boundary, new GuardianClient({ socketPath: guardian.socketPath }));
    const launchPort = await reserveFreePort();
    const launchSpec = createLaunchSpec({ port: launchPort, fixturePath: FIXTURE_PATH });
    const owner = createOwner('harness-cleanup-failure', launchSpec);

    await withBoundaryCleanup(boundary, async () => {
      const harness = spawn(process.execPath, [WEB_PROCESS_HARNESS], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          OPENCHAMBER_GUARDIAN_SOCKET: guardian.socketPath,
          OPENCHAMBER_GUARDIAN_LAUNCH_PORT: String(launchPort),
          OPENCHAMBER_GUARDIAN_FIXTURE: FIXTURE_PATH,
          OPENCHAMBER_GUARDIAN_OWNER_ID: owner.ownerInstanceId,
          OPENCHAMBER_GUARDIAN_RUNTIME_ID: owner.runtimeIdentity,
          OPENCHAMBER_GUARDIAN_LAUNCH_FINGERPRINT: owner.launchFingerprint,
          OPENCHAMBER_GUARDIAN_LAUNCH_CWD: launchSpec.cwd,
          OPENCHAMBER_GUARDIAN_USERNAME: 'harness-user',
          OPENCHAMBER_GUARDIAN_PASSWORD: 'harness-secret',
          OPENCHAMBER_BOUNDARY_FAIL_CLEANUP: '1',
        },
      });
      let stdout = '';
      let stderr = '';
      harness.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
      harness.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
      const exitInfo = await new Promise((resolve) => {
        harness.once('close', (code, signal) => resolve({ code, signal }));
      });
      const rawReport = JSON.parse(stdout);
      trackReportedChildren(boundary, rawReport.createdChildren);
      expect(exitInfo.code).toBe(1);
      expect(rawReport.cleanupError).toMatchObject({
        message: 'intentional process-boundary cleanup failure',
      });
      expect(rawReport.error).toBeUndefined();
      expect(stderr).not.toContain('harness-secret');
      await client.connect();
      await expect(client.list()).resolves.toEqual([]);
    });
  });

  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('reports body and cleanup statuses without replacing a body or signal failure', async () => {
    const initialBoundaryRoots = listPosixBoundaryRoots();
    const success = runPosixBoundary();
    expect(success.status).toBe(0);
    expect(success.stderr).toContain('status: body=0 cleanup=0');

    const bodyFailure = runPosixBoundary({ OPENCHAMBER_BOUNDARY_FAIL_AFTER_SPAWN: '1' });
    expect(bodyFailure.status).not.toBe(0);
    expect(bodyFailure.stderr).toMatch(/status: body=\d+ cleanup=\d+/);
    expect(bodyFailure.stderr).toContain('body=1');

    const cleanupFailure = runPosixBoundary({
      OPENCHAMBER_BOUNDARY_LEAVE_GUARDIAN: '1',
      OPENCHAMBER_BOUNDARY_HANG_CLEANUP: '1',
      OPENCHAMBER_BOUNDARY_SKIP_GUARDIAN_ASSERT: '1',
    });
    expect(cleanupFailure.status).toBe(1);
    expect(cleanupFailure.stderr).toContain('status: body=0 cleanup=1');

    const signalFailure = await runPosixBoundaryWithSignal();
    expect(signalFailure.code).toBe(143);
    expect(signalFailure.signal).toBe(null);
    expect(signalFailure.stderr).toContain('status: body=143 cleanup=1');
    const newBoundaryRoots = [...listPosixBoundaryRoots()]
      .filter((root) => !initialBoundaryRoots.has(root));
    expect(newBoundaryRoots).toEqual([]);
  }, 30_000);

  it.skipIf(process.platform === 'win32' || Boolean(process.versions?.bun))('does not stop a foreign child when owner cleanup validation fails', async () => {
    const root = mkRoot('foreign-child-cleanup');
    const { guardian, store } = await buildGuardian(root);
    const boundary = trackBoundary(root, guardian, store);
    const client = trackClient(boundary, new GuardianClient({ socketPath: guardian.socketPath }));
    const spawnedChildren = [];

    const spawnOwnedChild = async (label) => {
      const port = await reserveFreePort();
      const launchSpec = createLaunchSpec({ port, fixturePath: FIXTURE_PATH });
      const owner = createOwner(label, launchSpec);
      const spawned = await client.spawn({
        ...launchSpec,
        env: {
          OPENCODE_SERVER_USERNAME: 'boundary-user',
          OPENCODE_SERVER_PASSWORD: 'boundary-secret',
        },
        owner,
        launchSpec,
      });
      const identity = readProcessIdentity(spawned.pid);
      if (!identity) throw new Error(`could not capture ${label} child identity`);
      const child = { ...spawned, owner, identity };
      spawnedChildren.push(child);
      return child;
    };

    let released = false;
    try {
      await guardian.start();
      await client.connect();
      const expected = await spawnOwnedChild('owner-cleanup');
      const foreign = await spawnOwnedChild('foreign-cleanup');
      trackExpectedChild(boundary, expected, expected.owner, expected.identity);

      await expect(withBoundaryCleanup(boundary, async () => {})).rejects.toThrow(
        'process-boundary cleanup failed',
      );
      expect(fs.existsSync(root)).toBe(true);

      // A foreign record makes the list ambiguous for administrative teardown.
      // The foreign process and its exact identity must remain untouched, and
      // the known child must not be stopped as a side effect of that failure.
      expect(probeProcessLiveness(foreign.pid)).toBe('alive');
      expect(compareProcessIdentity(foreign.identity, readProcessIdentity(foreign.pid))).toBe(null);
      expect(probeProcessLiveness(expected.pid)).toBe('alive');
      await expect(guardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          incarnation: foreign.incarnation,
          ownerInstanceId: foreign.owner.ownerInstanceId,
          runtimeIdentity: foreign.owner.runtimeIdentity,
          launchFingerprint: foreign.owner.launchFingerprint,
        }),
      ]));

      // Finish only the exact test-owned incarnations so this regression does
      // not leave a child or guardian running for the next test.
      for (const child of spawnedChildren) {
        if (probeProcessLiveness(child.pid) === 'alive'
          && compareProcessIdentity(child.identity, readProcessIdentity(child.pid)) === null) {
          await guardian.stopChild({ incarnation: child.incarnation, owner: child.owner });
        }
        await waitForExpectedChildExit(child);
      }
      await expect(guardian.listChildren()).resolves.toEqual([]);
      await guardian.stop();
      client.disconnect();
      boundaries.delete(boundary);
      const rootIndex = roots.indexOf(root);
      if (rootIndex >= 0) roots.splice(rootIndex, 1);
      fs.rmSync(root, { recursive: true, force: true });
      released = true;
    } finally {
      if (!released) {
        // Best-effort cleanup remains owner-scoped. If this path cannot prove
        // an exact child identity, leave the boundary registered so afterEach
        // retains the root instead of guessing or issuing guardian.stop().
        for (const child of spawnedChildren) {
          if (probeProcessLiveness(child.pid) !== 'alive'
            || compareProcessIdentity(child.identity, readProcessIdentity(child.pid)) !== null) continue;
          try {
            await guardian.stopChild({ incarnation: child.incarnation, owner: child.owner });
          } catch { /* retain authority */ }
        }
      }
    }
  });
});
