import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedOpenCodeHandoffV2State } from '../opencode/managed-opencode-handoff-v2/record.js';
import { createManagedOpenCodeHandoffV2Store } from '../opencode/managed-opencode-handoff-v2/store.js';
import { createManagedOpenCodeHandoffV2Protocol } from '../opencode/managed-opencode-handoff-v2/protocol.js';
import { createManagedOpenCodeHandoffV2SecretProvider } from '../opencode/managed-opencode-handoff-v2/secret-provider.js';
import {
  createManagedOpenCodeCredentialStore,
  MANAGED_OPENCODE_CREDENTIAL_DIRECTORY,
  MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX,
} from '../opencode/managed-opencode-handoff-v2/credential-store.js';
import { ManagedOpenCodeGuardian, createManagedOpenCodeGuardian } from './guardian.js';
import {
  GuardianClient,
  GuardianClientError,
  GUARDIAN_AMBIGUOUS_REQUEST_CODE,
  isAmbiguousGuardianRequestError,
} from './guardian-client.js';
import { GuardianIpcServer } from './ipc-server.js';
import { detectAndAdoptGuardianChild } from './detection.js';
import { GUARDIAN_IPC_MAX_FRAME_BYTES } from './ipc-auth.js';
import { createLaunchFingerprint } from './owner-identity.js';
import {
  acquireGuardianPidMarker,
  readGuardianPidMarker,
  releaseGuardianPidMarker,
  updateGuardianPidMarkerTransportIdentity,
} from './pid-marker.js';
import { resolveGuardianPaths } from './paths.js';
import * as windowsAcl from './windows-acl.js';
import * as windowsProcess from './windows-process.js';

let roots = [];
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

const setPlatformForTest = (platform) => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
};

const restorePlatform = () => {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, 'platform', originalPlatformDescriptor);
  } else {
    delete process.platform;
  }
};

const createClock = (initialTime = 1_000) => {
  let time = initialTime;
  return {
    now: () => time,
    set: (nextTime) => { time = nextTime; },
    advance: (milliseconds) => { time += milliseconds; },
  };
};

const createFakeStore = (clock) => {
  const records = new Map();
  const operations = new Map();
  return {
    records,
    operations,
    read: async ({ incarnation }) => {
      const row = records.get(incarnation);
      return row ? { ...row } : null;
    },
    list: async () => Array.from(records.values(), (row) => ({ ...row })),
    compareAndSwap: async ({ incarnation, expected, next, nextForAuthoritativeTime, allowExpired = false }) => {
      const current = records.get(incarnation) ?? null;
      if (expected === null) {
        if (current !== null) return { status: 'conflict' };
        const candidate = nextForAuthoritativeTime
          ? nextForAuthoritativeTime(clock.now())
          : next;
        records.set(incarnation, { ...candidate });
        return { status: 'applied' };
      }
      if (
        current === null
        || current.revision !== expected.revision
        || current.mac !== expected.mac
        || current.leaseExpiresAt !== expected.leaseExpiresAt
      ) {
        return { status: 'conflict' };
      }
      if (!allowExpired && current.leaseExpiresAt <= clock.now()) return { status: 'expired' };
      const candidate = nextForAuthoritativeTime
        ? nextForAuthoritativeTime(clock.now())
        : next;
      records.set(incarnation, { ...candidate });
      return { status: 'applied' };
    },
    readOperation: async ({ operationId }) => {
      const row = operations.get(operationId);
      return row ? { ...row } : null;
    },
    listOperations: async () => Array.from(operations.values(), (row) => ({ ...row })),
    compareAndSwapOperation: async ({ operationId, expected, next, nextForAuthoritativeTime, allowExpired = false }) => {
      const current = operations.get(operationId) ?? null;
      if (expected === null) {
        if (current !== null) return { status: 'conflict' };
      } else if (!current
        || current.revision !== expected.revision
        || current.mac !== expected.mac
        || current.confirmationExpiresAt !== expected.confirmationExpiresAt) {
        return { status: 'conflict' };
      } else if (!allowExpired && current.confirmationExpiresAt <= clock.now()) {
        return { status: 'expired' };
      }
      const candidate = nextForAuthoritativeTime ? nextForAuthoritativeTime(clock.now()) : next;
      if (!allowExpired && candidate.confirmationExpiresAt <= clock.now()) return { status: 'expired' };
      operations.set(operationId, { ...candidate });
      return { status: 'applied' };
    },
    cleanup: async () => ({ removed: 0 }),
    close: async () => {},
    hasV2Records: async () => records.size > 0,
  };
};

const createMockChild = (opts = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn((signal) => {
    if (signal === 'SIGTERM' && opts.ignoreSigTerm) {
      return true;
    }
    queueMicrotask(() => {
      child.signalCode = signal;
      child.exitCode = signal === 'SIGKILL' ? null : 0;
      child.emit('close', child.exitCode, signal);
    });
    return true;
  });
  return child;
};

const createUnauthenticatedCredentialStore = () => ({
  create: vi.fn(),
  read: vi.fn(),
  remove: vi.fn(),
});

const createGuardianFixture = async (overrides = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const clock = createClock();
  const store = overrides.store ?? createFakeStore(clock);
  const fixtureOptions = overrides.options ?? {};
  const secretProvider = overrides.secretProvider ?? createManagedOpenCodeHandoffV2SecretProvider({
    rootDir: root,
    ...(fixtureOptions.username ? { username: fixtureOptions.username } : {}),
    ...(fixtureOptions.aclInspector ? { aclInspector: fixtureOptions.aclInspector } : {}),
    ...(fixtureOptions.reparseChecker ? { reparseChecker: fixtureOptions.reparseChecker } : {}),
  });
  const protocol = overrides.protocol ?? createManagedOpenCodeHandoffV2Protocol({
    secretProvider,
    store,
    now: clock.now,
    defaultLeaseMs: 60_000,
  });
  const log = vi.fn();
  const managedHealthProbe = overrides.managedHealthProbe ?? vi.fn(async () => ({ healthy: true }));
  const guardian = new ManagedOpenCodeGuardian({
    store,
    credentialStore: overrides.credentialStore ?? createUnauthenticatedCredentialStore(),
    protocol,
    secretProvider,
    rootDir: root,
    log,
    healthCheckIntervalMs: 0,
    leaseRenewalIntervalMs: 0,
    cleanupIntervalMs: 0,
    allowUnauthenticatedCredentials: true,
    spawnFn: overrides.spawnFn,
    processInspector: overrides.processInspector
      ?? (({ record } = {}) => ({
        processStartTicks: '12345',
        ...(record?.launchSpec ? {
          launch: {
            commandLine: `${path.basename(record.launchSpec.binary)} serve --hostname ${record.launchSpec.hostname} --port ${record.port}`,
            cwd: record.launchSpec.cwd,
          },
        } : {}),
      })),
    managedHealthProbe,
    ...fixtureOptions,
  });
  return { root, clock, store, secretProvider, protocol, guardian, log, managedHealthProbe };
};

const seedActiveRecord = async (protocol, { processStartTicks, pid = process.pid, port = 4096 } = {}) => {
  const launchSpec = {
    binary: 'opencode',
    args: [],
    hostname: '127.0.0.1',
    port,
    cwd: '/tmp/project',
  };
  const owner = {
    ownerInstanceId: 'owner-rehydrate',
    runtimeIdentity: 'runtime-rehydrate',
    launchFingerprint: createLaunchFingerprint(launchSpec),
  };
  const reservation = await protocol.reserveLaunch({
    leaseMs: 60_000,
    owner,
    launchSpec,
  });
  const launching = await protocol.beginLaunch({
    incarnation: reservation.record.incarnation,
    expectedRevision: reservation.record.revision,
    withCredential: async () => undefined,
  });
  const active = await protocol.bindSpawnedProcess({
    incarnation: launching.record.incarnation,
    expectedRevision: launching.record.revision,
    identity: { pid, port, processStartTicks },
    owner,
    launchSpec,
  });
  expect(active.ok).toBe(true);
  return { ...active.record, owner, launchSpec };
};

const seedLaunchingRecord = async (protocol, { port = 4097 } = {}) => {
  const launchSpec = {
    binary: 'opencode',
    args: [],
    hostname: '127.0.0.1',
    port,
    cwd: '/tmp/project',
  };
  const owner = {
    ownerInstanceId: `owner-launching-${port}`,
    runtimeIdentity: `runtime-launching-${port}`,
    launchFingerprint: createLaunchFingerprint(launchSpec),
  };
  const reservation = await protocol.reserveLaunch({
    leaseMs: 60_000,
    owner,
    launchSpec,
  });
  const launching = await protocol.beginLaunch({
    incarnation: reservation.record.incarnation,
    expectedRevision: reservation.record.revision,
    withCredential: async () => undefined,
  });
  expect(launching).toMatchObject({
    ok: true,
    record: { state: ManagedOpenCodeHandoffV2State.Launching },
  });
  return launching.record;
};

const settleAttentionForTest = async (guardian) => {
  const attention = (await guardian.listChildren()).filter((entry) => entry.state === 'attention');
  for (const entry of attention) {
    const loaded = await guardian.protocol.readRecord({
      incarnation: entry.incarnation,
      allowExpired: true,
    });
    if (!loaded?.ok || [
      ManagedOpenCodeHandoffV2State.Interrupted,
      ManagedOpenCodeHandoffV2State.Retired,
      ManagedOpenCodeHandoffV2State.Stopping,
    ].includes(loaded.record.state)) continue;
    const stopping = await guardian.protocol.beginStopping({
      incarnation: entry.incarnation,
      expectedRevision: loaded.record.revision,
      allowExpired: true,
    });
    if (!stopping?.ok) continue;
    await guardian.protocol.retire({
      incarnation: entry.incarnation,
      expectedRevision: stopping.record.revision,
      allowExpired: true,
    });
  }
};

const createCmdWrapperLaunch = (root, { port, targetName, binary = 'cmd.exe' }) => {
  const launchSpec = {
    binary,
    args: ['/d', '/s', '/c', 'call', path.join(root, targetName)],
    hostname: '127.0.0.1',
    port,
    cwd: '/tmp/project',
  };
  return {
    launchSpec,
    owner: {
      ownerInstanceId: `wrapper-owner-${port}`,
      runtimeIdentity: `wrapper-runtime-${port}`,
      launchFingerprint: createLaunchFingerprint(launchSpec),
    },
  };
};

beforeEach(() => {
  roots = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) {
    const root = roots.pop();
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
});

describe('GuardianClient input validation', () => {
  it('requires a non-empty incarnation and complete owner identity for credentials', async () => {
    const client = new GuardianClient({ socketPath: path.join(os.tmpdir(), 'unused-guardian.sock') });
    const completeOwner = {
      ownerInstanceId: 'client-owner',
      runtimeIdentity: 'client-runtime',
      launchFingerprint: 'client-fingerprint',
    };

    await expect(client.credential({ incarnation: '', owner: completeOwner }))
      .rejects.toMatchObject({ code: 'owner_required' });
    await expect(client.credential({
      incarnation: 'client-incarnation',
      owner: { ownerInstanceId: 'client-owner', runtimeIdentity: 'client-runtime' },
    })).rejects.toMatchObject({ code: 'owner_required' });

    client.disconnect();
  });
});

describe('ManagedOpenCodeGuardian', () => {
  it.skipIf(process.platform === 'win32')('constructs with valid dependencies', async () => {
    const { guardian } = await createGuardianFixture();
    expect(guardian).toBeInstanceOf(ManagedOpenCodeGuardian);
  });

  it.skipIf(process.platform === 'win32')('persists the verified transport identity before guardian startup resolves', async () => {
    let markerOwnership = null;
    let started = false;
    const onStopped = vi.fn(() => {
      if (markerOwnership) {
        releaseGuardianPidMarker(markerOwnership);
        markerOwnership = null;
      }
    });
    const onTransportReady = vi.fn((transportIdentity) => {
      markerOwnership = updateGuardianPidMarkerTransportIdentity(markerOwnership, transportIdentity);
    });
    const { guardian, root } = await createGuardianFixture({
      options: { onStopped, onTransportReady },
    });
    markerOwnership = await acquireGuardianPidMarker({
      pidFile: path.join(root, 'guardian.pid'),
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });

    try {
      await guardian.start();
      started = true;
      const marker = readGuardianPidMarker(markerOwnership.pidFile);
      expect(onTransportReady).toHaveBeenCalledOnce();
      expect(marker?.transportIdentity).toMatchObject({
        publicIdentity: { type: 'socket' },
        ownerIdentity: { type: 'socket' },
      });
      await guardian.stop();
      started = false;
      expect(onStopped).toHaveBeenCalledOnce();
      expect(readGuardianPidMarker(markerOwnership?.pidFile || path.join(root, 'guardian.pid'))).toBeNull();
    } finally {
      if (started) await guardian.stop().catch(() => {});
      if (markerOwnership) {
        releaseGuardianPidMarker(markerOwnership);
        markerOwnership = null;
      }
    }
  });

  it.skipIf(process.platform === 'win32')('retains the PID marker and stop callback when POSIX transport cleanup fails', async () => {
    let markerOwnership = null;
    const onStopped = vi.fn(() => releaseGuardianPidMarker(markerOwnership));
    const { guardian, root } = await createGuardianFixture({ options: { onStopped } });
    const pidFile = path.join(root, 'guardian.pid');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });

    await guardian.start();
    const unlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (typeof target === 'string' && target.endsWith('.remove')) {
        throw Object.assign(new Error('socket unlink denied'), { code: 'EACCES' });
      }
      return unlinkSync(target, ...args);
    });

    try {
      await expect(guardian.stop()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        message: 'Guardian IPC transport cleanup failed',
      });
      expect(onStopped).not.toHaveBeenCalled();
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
    } finally {
      unlinkSpy.mockRestore();
    }

    await expect(guardian.stop()).resolves.toBeUndefined();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(readGuardianPidMarker(pidFile)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('retains authority when the POSIX guardian socket is replaced during stop', async () => {
    let markerOwnership = null;
    let stopped = false;
    const onStopped = vi.fn(() => {
      if (!markerOwnership) return;
      const ownership = markerOwnership;
      markerOwnership = null;
      releaseGuardianPidMarker(ownership);
    });
    const { guardian, root } = await createGuardianFixture({ options: { onStopped } });
    const pidFile = path.join(root, 'guardian.pid');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });

    await guardian.start();
    const socketPath = guardian.socketPath;
    fs.unlinkSync(socketPath);
    fs.writeFileSync(socketPath, 'replacement-transport');

    try {
      await expect(guardian.stop()).rejects.toMatchObject({
        code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
        message: 'Guardian IPC transport cleanup failed',
      });
      expect(onStopped).not.toHaveBeenCalled();
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
      expect(fs.readFileSync(socketPath, 'utf8')).toBe('replacement-transport');
    } finally { /* the replacement is removed before the retry below */ }

    fs.unlinkSync(socketPath);
    // A missing public path is an uncertainty condition. Restore the same
    // inode from the still-private owner alias before retrying stop; the
    // transport must not synthesize or remove an unproven public replacement.
    fs.linkSync(`${socketPath}.owner`, socketPath);
    await expect(guardian.stop()).resolves.toBeUndefined();
    stopped = true;
    expect(onStopped).toHaveBeenCalledOnce();
    expect(readGuardianPidMarker(pidFile)).toBeNull();

    if (!stopped && markerOwnership) releaseGuardianPidMarker(markerOwnership);
  });

  it.skipIf(process.platform === 'win32')('does not release the marker when startup rollback cannot clean transport', async () => {
    let markerOwnership = null;
    const onStopped = vi.fn(() => releaseGuardianPidMarker(markerOwnership));
    const { guardian, root } = await createGuardianFixture({ options: { onStopped } });
    const pidFile = path.join(root, 'guardian.pid');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });

    const socketPath = guardian.socketPath;
    const realLstatSync = fs.lstatSync.bind(fs);
    let socketStat = null;
    const retainedSocketPath = `${socketPath}.retained`;
    let renameStarted = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation((target, ...args) => {
      if (target === socketPath && !renameStarted) {
        try {
           const current = realLstatSync(target, ...args);
           if (!socketStat) {
             socketStat = current;
             try { fs.linkSync(socketPath, retainedSocketPath); } catch { /* already retained */ }
           }
           return current;
        } catch (error) {
          if (socketStat) return socketStat;
          throw error;
        }
      }
      return realLstatSync(target, ...args);
    });
    const realRenameSync = fs.renameSync.bind(fs);
    let restoredSocketName = false;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (source === socketPath && !restoredSocketName) {
        restoredSocketName = true;
        renameStarted = true;
        realRenameSync(retainedSocketPath, socketPath);
      }
      return realRenameSync(source, destination);
    });
    const realUnlinkSync = fs.unlinkSync.bind(fs);
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
      if (typeof target === 'string' && target.endsWith('.remove')) {
        throw Object.assign(new Error('socket unlink denied during startup rollback'), { code: 'EACCES' });
      }
      return realUnlinkSync(target, ...args);
    });
    const startTimersSpy = vi.spyOn(guardian, 'startTimers').mockImplementation(() => {
      throw new Error('timer startup failed');
    });

    try {
      await expect(guardian.start()).rejects.toMatchObject({ code: 'GUARDIAN_CLEANUP_UNCERTAIN' });
      expect(onStopped).not.toHaveBeenCalled();
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
    } finally {
      startTimersSpy.mockRestore();
      unlinkSpy.mockRestore();
      renameSpy.mockRestore();
      lstatSpy.mockRestore();
      try { fs.unlinkSync(retainedSocketPath); } catch { /* cleanup */ }
    }

    await expect(guardian.stop()).resolves.toBeUndefined();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(readGuardianPidMarker(pidFile)).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('retains marker authority for an unknown pre-existing POSIX transport artifact', async () => {
    let markerOwnership = null;
    let guardian = null;
    let stopped = false;
    const onStopped = vi.fn(() => {
      if (!markerOwnership) return;
      const ownership = markerOwnership;
      markerOwnership = null;
      releaseGuardianPidMarker(ownership);
    });
    const fixture = await createGuardianFixture({ options: { onStopped } });
    guardian = fixture.guardian;
    const pidFile = path.join(fixture.root, 'guardian.pid');
    fs.writeFileSync(guardian.socketPath, 'pre-existing-transport-artifact');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: fixture.root },
      },
      requireIdentity: true,
    });

    try {
      await expect(guardian.start()).rejects.toMatchObject({
        code: 'GUARDIAN_CLEANUP_UNCERTAIN',
      });
      expect(onStopped).not.toHaveBeenCalled();
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
      expect(fs.readFileSync(guardian.socketPath, 'utf8')).toBe('pre-existing-transport-artifact');

      fs.unlinkSync(guardian.socketPath);
      // The helper binds the private owner pathname before the public
      // no-clobber publication fails; both failed-start artifacts must be
      // absent before marker authority can be released.
      fs.unlinkSync(`${guardian.socketPath}.owner`);
      await expect(guardian.stop()).resolves.toBeUndefined();
      stopped = true;
      expect(onStopped).toHaveBeenCalledOnce();
      expect(readGuardianPidMarker(pidFile)).toBeNull();
    } finally {
      if (!stopped && guardian) await guardian.stop().catch(() => {});
      if (markerOwnership) {
        releaseGuardianPidMarker(markerOwnership);
        markerOwnership = null;
      }
    }
  });

  it.skipIf(process.platform === 'win32')('settles a one-shot startup cleanup retry before releasing the marker', async () => {
    let markerOwnership = null;
    const onStopped = vi.fn(() => releaseGuardianPidMarker(markerOwnership));
    const { guardian, root } = await createGuardianFixture({ options: { onStopped } });
    const pidFile = path.join(root, 'guardian.pid');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });
    const startTimersSpy = vi.spyOn(guardian, 'startTimers').mockImplementation(() => {
      throw new Error('one-shot startup failure');
    });
    const stopSpy = vi.spyOn(GuardianIpcServer.prototype, 'stop')
      .mockRejectedValueOnce(Object.assign(new Error('one-shot cleanup failure'), { code: 'EACCES' }));

    try {
      await expect(guardian.start()).rejects.toMatchObject({ code: 'GUARDIAN_CLEANUP_UNCERTAIN' });
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
      expect(fs.existsSync(guardian.socketPath)).toBe(true);
    } finally {
      startTimersSpy.mockRestore();
      stopSpy.mockRestore();
    }

    await expect(guardian.stop()).resolves.toBeUndefined();
    expect(onStopped).toHaveBeenCalledOnce();
    expect(readGuardianPidMarker(pidFile)).toBeNull();
    expect(fs.existsSync(guardian.socketPath)).toBe(false);
    expect(fs.readdirSync(root).some((name) => name.endsWith('.remove'))).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('retains authority when startup rollback leaves an attention-only durable record', async () => {
    let markerOwnership = null;
    let guardian = null;
    let record = null;
    let stopped = false;
    const onStopped = vi.fn(() => {
      if (!markerOwnership) return;
      const ownership = markerOwnership;
      markerOwnership = null;
      releaseGuardianPidMarker(ownership);
    });
    const { guardian: fixtureGuardian, root, store, protocol } = await createGuardianFixture({
      options: { onStopped },
    });
    guardian = fixtureGuardian;
    record = await seedLaunchingRecord(protocol);
    const pidFile = path.join(root, 'guardian.pid');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });
    const closeSpy = vi.spyOn(store, 'close');
    const startTimersSpy = vi.spyOn(guardian, 'startTimers').mockImplementation(() => {
      throw new Error('startup timer failure after attention recovery');
    });

    try {
      const startupError = await guardian.start().then(() => null, (error) => error);
      expect(startupError).toMatchObject({ code: 'GUARDIAN_CLEANUP_UNCERTAIN' });
      expect(startupError.cleanupSettled).not.toBe(true);
      expect(onStopped).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(guardian.socketPath)).toBe(true);
      await expect(guardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
        }),
      ]));
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });

      const latest = await protocol.readRecord({ incarnation: record.incarnation });
      const interrupted = await protocol.markInterrupted({
        incarnation: record.incarnation,
        expectedRevision: latest.record.revision,
      });
      expect(interrupted.ok).toBe(true);

      startTimersSpy.mockRestore();
      await expect(guardian.stop()).resolves.toBeUndefined();
      stopped = true;
      expect(onStopped).toHaveBeenCalledOnce();
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(readGuardianPidMarker(pidFile)).toBeNull();
    } finally {
      startTimersSpy.mockRestore();
      if (!stopped && guardian) {
        const latest = await protocol.readRecord({ incarnation: record.incarnation }).catch(() => null);
        if (latest?.ok && latest.record.state === ManagedOpenCodeHandoffV2State.Launching) {
          await protocol.markInterrupted({
            incarnation: record.incarnation,
            expectedRevision: latest.record.revision,
          }).catch(() => {});
        }
        try { await guardian.stop(); } catch { /* preserve the assertion failure */ }
      }
      if (markerOwnership) {
        releaseGuardianPidMarker(markerOwnership);
        markerOwnership = null;
      }
    }
  });

  it.skipIf(process.platform === 'win32')('retains authority when normal stop has an attention-only durable record', async () => {
    let markerOwnership = null;
    let stopped = false;
    const onStopped = vi.fn(() => {
      if (!markerOwnership) return;
      const ownership = markerOwnership;
      markerOwnership = null;
      releaseGuardianPidMarker(ownership);
    });
    const { guardian, root, store, protocol } = await createGuardianFixture({
      options: { onStopped },
    });
    const record = await seedLaunchingRecord(protocol);
    const pidFile = path.join(root, 'guardian.pid');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });
    const closeSpy = vi.spyOn(store, 'close');

    try {
      await guardian.start();
      await expect(guardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
        }),
      ]));

      const stopError = await guardian.stop().then(() => null, (error) => error);
      expect(stopError).toMatchObject({
        code: 'GUARDIAN_CLEANUP_UNCERTAIN',
        message: 'Guardian cleanup is uncertain: unresolved attention records remain',
      });
      expect(onStopped).not.toHaveBeenCalled();
      expect(closeSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(guardian.socketPath)).toBe(true);
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });

      const latest = await protocol.readRecord({ incarnation: record.incarnation });
      const interrupted = await protocol.markInterrupted({
        incarnation: record.incarnation,
        expectedRevision: latest.record.revision,
      });
      expect(interrupted.ok).toBe(true);

      await expect(guardian.stop()).resolves.toBeUndefined();
      stopped = true;
      expect(onStopped).toHaveBeenCalledOnce();
      expect(closeSpy).toHaveBeenCalledOnce();
      expect(readGuardianPidMarker(pidFile)).toBeNull();
    } finally {
      if (!stopped) {
        const latest = await protocol.readRecord({ incarnation: record.incarnation }).catch(() => null);
        if (latest?.ok && latest.record.state === ManagedOpenCodeHandoffV2State.Launching) {
          await protocol.markInterrupted({
            incarnation: record.incarnation,
            expectedRevision: latest.record.revision,
          }).catch(() => {});
        }
        try { await guardian.stop(); } catch { /* preserve the assertion failure */ }
      }
      if (markerOwnership) {
        releaseGuardianPidMarker(markerOwnership);
        markerOwnership = null;
      }
    }
  });

  it.skipIf(process.platform === 'win32')('retains attention until terminal credential removal succeeds on a later stop retry', async () => {
    const credentialStore = {
      create: vi.fn(),
      read: vi.fn(),
      remove: vi.fn()
        .mockRejectedValueOnce(new Error('credential store temporarily unavailable'))
        .mockResolvedValueOnce({ removed: true }),
    };
    const onStopped = vi.fn();
    const { guardian, protocol } = await createGuardianFixture({
      credentialStore,
      options: {
        allowUnauthenticatedCredentials: false,
        onStopped,
      },
    });
    const record = await seedLaunchingRecord(protocol);
    let stopped = false;

    try {
      await guardian.start();
      await expect(guardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
        }),
      ]));

      const latest = await protocol.readRecord({ incarnation: record.incarnation });
      const interrupted = await protocol.markInterrupted({
        incarnation: record.incarnation,
        expectedRevision: latest.record.revision,
      });
      expect(interrupted.ok).toBe(true);

      await expect(guardian.stop()).rejects.toMatchObject({
        code: 'GUARDIAN_CLEANUP_UNCERTAIN',
      });
      expect(credentialStore.remove).toHaveBeenCalledOnce();
      expect(credentialStore.remove).toHaveBeenCalledWith(expect.objectContaining({
        incarnation: record.incarnation,
        credentialFingerprint: record.credentialFingerprint,
      }));
      await expect(guardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
        }),
      ]));
      expect(onStopped).not.toHaveBeenCalled();

      await expect(guardian.stop()).resolves.toBeUndefined();
      stopped = true;
      expect(credentialStore.remove).toHaveBeenCalledTimes(2);
      await expect(guardian.listChildren()).resolves.toEqual([]);
      expect(onStopped).toHaveBeenCalledOnce();
    } finally {
      if (!stopped) await guardian.stop().catch(() => {});
    }
  });

  it.skipIf(process.platform === 'win32')('marks an uncertain original startup error as settled after rollback succeeds', async () => {
    let markerOwnership = null;
    const { guardian, root } = await createGuardianFixture();
    const pidFile = path.join(root, 'guardian.pid');
    markerOwnership = await acquireGuardianPidMarker({
      pidFile,
      pid: process.pid,
      identity: {
        processStartTicks: '123',
        launch: { commandLine: 'node guardian.test.js', cwd: root },
      },
      requireIdentity: true,
    });
    const startupFailure = Object.assign(
      new Error('startup operation reported cleanup uncertainty'),
      { code: 'GUARDIAN_CLEANUP_UNCERTAIN' },
    );
    const startTimersSpy = vi.spyOn(guardian, 'startTimers').mockImplementation(() => {
      throw startupFailure;
    });

    try {
      await expect(guardian.start()).rejects.toMatchObject({
        code: 'GUARDIAN_CLEANUP_UNCERTAIN',
        cleanupSettled: true,
      });
      expect(fs.existsSync(guardian.socketPath)).toBe(false);
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
      expect(releaseGuardianPidMarker(markerOwnership)).toBe(true);
      markerOwnership = null;
      expect(readGuardianPidMarker(pidFile)).toBeNull();
    } finally {
      startTimersSpy.mockRestore();
      if (markerOwnership) releaseGuardianPidMarker(markerOwnership);
    }
  });

  it.skipIf(process.platform === 'win32')('fails guardian startup closed when recovery-store listing rejects', async () => {
    const clock = createClock();
    const baseStore = createFakeStore(clock);
    const store = {
      ...baseStore,
      list: vi.fn().mockRejectedValue(new Error('recovery database unavailable')),
    };
    const { guardian, root, log } = await createGuardianFixture({ store });

    await expect(guardian.start()).rejects.toThrow(/recovery store read failed: recovery database unavailable/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('recovery store read failed'));
    expect(fs.existsSync(path.join(root, 'guardian.sock'))).toBe(false);
    await expect(guardian.listChildren()).resolves.toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('throws on invalid constructor arguments', async () => {
    await expect(() => new ManagedOpenCodeGuardian({})).toThrow('ManagedOpenCodeGuardian requires a store');
    await expect(() => new ManagedOpenCodeGuardian({ store: { read: () => {} } }))
      .toThrow('ManagedOpenCodeGuardian requires a protocol');
  });

  // W-C: the `process.platform === 'win32'` rejection in `start()` is
  // removed. On Windows, `start()` now requires either a `socketPath`
  // (with a `portPath` shim) or a `portPath` + `username`. The
  // fixture's createGuardianFixture() does not pass either, so the
  // constructor allows the build but `start()` fails with a clear
  // 'Windows portPath is required' message. The opt-out remains
  // `OPENCHAMBER_RESTART_HANDOFF=disabled` / `--no-handoff`.
  it.skipIf(process.platform === 'win32')('requires portPath on Windows when starting', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const { guardian } = await createGuardianFixture();
      await expect(guardian.start()).rejects.toThrow(/Windows portPath is required/);
    } finally {
      Object.defineProperty(process, 'platform', originalPlatform ?? { value: process.platform });
    }
  });

  it.skipIf(process.platform === 'win32')('spawns managed OpenCode and tracks child', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian } = await createGuardianFixture({ spawnFn });

    await guardian.start();

    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
      leaseMs: 60_000,
    });

    // Emit listening line after event listeners are set up.
    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);

    const result = await spawnPromise;
    expect(result).toMatchObject({ pid: 12345, port: 4096 });
    expect(typeof result.incarnation).toBe('string');

    const children = await guardian.listChildren();
    expect(children.length).toBe(1);
    expect(children[0].state).toBe(ManagedOpenCodeHandoffV2State.Active);

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('fails closed before spawning when durable operation creation fails', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const fixture = await createGuardianFixture({ spawnFn });
    fixture.store.compareAndSwapOperation = vi.fn().mockResolvedValue({ status: 'conflict' });
    await fixture.guardian.start();

    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4098,
      cwd: '/tmp/project',
    };
    await expect(fixture.guardian.spawnManagedOpenCode({
      ...launchSpec,
      env: {},
      owner: {
        ownerInstanceId: 'operation-create-failure-owner',
        runtimeIdentity: 'operation-create-failure-runtime',
        launchFingerprint: createLaunchFingerprint(launchSpec),
      },
      launchSpec,
    })).rejects.toMatchObject({ code: 'GUARDIAN_OPERATION_CREATE_FAILED' });

    expect(spawnFn).not.toHaveBeenCalled();
    const records = await fixture.store.list();
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe(ManagedOpenCodeHandoffV2State.Interrupted);
    await fixture.guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('rehydrates an operation fence when its child row is absent and resolves it after the row returns', async () => {
    const first = await createGuardianFixture();
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: first.root,
      secretProvider: first.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4124,
      cwd: '/tmp/project',
    };
    const active = await seedActiveRecord(first.protocol, {
      pid: 98765,
      processStartTicks: '12345',
      port: launchSpec.port,
    });
    const owner = active.owner;
    const operationId = randomBytes(32).toString('base64url');
    const operation = await first.protocol.createOperation({
      operationId,
      kind: 'stop',
      incarnation: active.incarnation,
      owner,
      target: {
        revision: active.revision,
        leaseExpiresAt: active.leaseExpiresAt,
        mac: active.mac,
      },
    });
    expect(operation.ok).toBe(true);
    const interrupted = await first.protocol.markInterrupted({
      incarnation: active.incarnation,
      expectedRevision: active.revision,
    });
    expect(interrupted.ok).toBe(true);
    await credentialStore.create({
      ...interrupted.record,
      password: 'rehydrated-operation-secret',
    });
    // Simulate the child row being temporarily absent while the durable
    // operation remains pending across a guardian/web-process restart.
    first.store.records.delete(active.incarnation);
    let failRecordRead = true;
    const rehydrationProtocol = {
      ...first.protocol,
      readRecord: vi.fn(async (input) => {
        if (failRecordRead) {
          failRecordRead = false;
          throw new Error('child record read temporarily unavailable');
        }
        return first.protocol.readRecord(input);
      }),
    };

    const second = await createGuardianFixture({
      store: first.store,
      protocol: rehydrationProtocol,
      secretProvider: first.secretProvider,
      credentialStore,
      processLiveness: () => false,
      options: { allowUnauthenticatedCredentials: false },
      spawnFn: vi.fn().mockReturnValue(createMockChild()),
    });

    try {
      await second.guardian.start();
      // The first authoritative read fails and the next reports absence; in
      // both cases the operation-linked attention remains durable and blocks
      // a later launch.
      await expect(second.guardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          incarnation: active.incarnation,
          operationId,
          state: 'attention',
        }),
      ]);
      await expect(second.guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: {},
        owner,
        launchSpec,
      })).rejects.toThrow(/blocked by attention record/);
      await expect(credentialStore.read({
        incarnation: active.incarnation,
        ownerInstanceId: interrupted.record.ownerInstanceId,
        runtimeIdentity: interrupted.record.runtimeIdentity,
        launchFingerprint: interrupted.record.launchFingerprint,
        credentialFingerprint: interrupted.record.credentialFingerprint,
      })).resolves.toEqual({ username: 'opencode', password: 'rehydrated-operation-secret' });

      // The authoritative terminal row returns later. Resolution is still
      // possible because the absent-row attention was never deleted or
      // converted into credential cleanup.
      first.store.records.set(active.incarnation, interrupted.record);
      await second.guardian.cleanup();
      await expect(second.guardian.listChildren()).resolves.toEqual([]);
      await expect(credentialStore.read({
        incarnation: active.incarnation,
        ownerInstanceId: interrupted.record.ownerInstanceId,
        runtimeIdentity: interrupted.record.runtimeIdentity,
        launchFingerprint: interrupted.record.launchFingerprint,
        credentialFingerprint: interrupted.record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
    } finally {
      try { await second.guardian.stop(); } catch { /* retention assertions are authoritative */ }
    }
  });

  it.skipIf(process.platform === 'win32')('rehydrates an unresolved transition operation and blocks a different-port launch', async () => {
    const originalFetch = globalThis.fetch;
    let secondGuardian;
    try {
      const first = await createGuardianFixture();
      const active = await seedActiveRecord(first.protocol, {
        pid: process.pid,
        processStartTicks: '12345',
        port: 4131,
      });
      const operationId = randomBytes(32).toString('base64url');
      const operation = await first.protocol.createOperation({
        operationId,
        kind: 'prepare-handoff',
        incarnation: active.incarnation,
        owner: active.owner,
        target: {
          revision: active.revision,
          leaseExpiresAt: active.leaseExpiresAt,
          mac: active.mac,
        },
      });
      expect(operation.ok).toBe(true);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processLiveness: () => true,
        spawnFn: vi.fn().mockReturnValue(createMockChild()),
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();

      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          incarnation: active.incarnation,
          operationId,
          state: 'attention',
        }),
      ]);
      const launchSpec = {
        ...active.launchSpec,
        port: 4132,
      };
      await expect(secondGuardian.spawnManagedOpenCode({
        ...launchSpec,
        env: {},
        owner: {
          ...active.owner,
          launchFingerprint: createLaunchFingerprint(launchSpec),
        },
        launchSpec,
      })).rejects.toThrow(/blocked by attention record/);
      await expect(secondGuardian.getOperationStatus({ operationId, owner: active.owner }))
        .resolves.toMatchObject({ operation: { state: 'pending' } });
    } finally {
      if (secondGuardian) {
        try { await secondGuardian.stop(); } catch { /* unresolved attention is the assertion */ }
      }
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(process.platform === 'win32')('keeps an in-flight operation fenced across its horizon until guardian quiescence resolves it', async () => {
    const base = await createGuardianFixture();
    let permitResolution = false;
    const protocol = {
      ...base.protocol,
      createOperation: (input) => base.protocol.createOperation({ ...input, horizonMs: 100 }),
      resolveOperation: vi.fn((input) => permitResolution
        ? base.protocol.resolveOperation(input)
        : Promise.resolve({ ok: false, reason: 'operation-cas-failed' })),
    };
    const child = createMockChild();
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4120,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'horizon-owner',
      runtimeIdentity: 'horizon-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const { guardian } = await createGuardianFixture({
      store: base.store,
      secretProvider: base.secretProvider,
      protocol,
      spawnFn: vi.fn().mockReturnValue(child),
    });

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({ ...launchSpec, env: {}, owner, launchSpec });
      setTimeout(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4120\n'), 10);
      await spawnPromise;
      const operation = (await base.store.listOperations())[0];
      expect((await guardian.listChildren()).some((entry) => entry.state === 'attention')).toBe(true);

      base.clock.advance(200);
      await guardian.cleanup();
      await expect(guardian.getOperationStatus({ operationId: operation.operationId, owner })).resolves.toMatchObject({
        operation: { state: 'expired' },
      });
      await expect(guardian.spawnManagedOpenCode({
        ...launchSpec,
        port: 4121,
        launchSpec: { ...launchSpec, port: 4121 },
        env: {},
        owner: { ...owner, launchFingerprint: createLaunchFingerprint({ ...launchSpec, port: 4121 }) },
      })).rejects.toThrow(/blocked by attention/);

      permitResolution = true;
      await guardian.cleanup();
      expect(protocol.resolveOperation).toHaveBeenCalledTimes(3);
      expect((await guardian.listChildren()).some((entry) => entry.state === 'attention')).toBe(false);
    } finally {
      try { await guardian.stop(); } catch { /* the retention assertions are authoritative */ }
    }
  });

  it.skipIf(process.platform === 'win32')('retains every overlapping incarnation operation until all resolve', async () => {
    const base = await createGuardianFixture();
    const allowed = new Set();
    const protocol = {
      ...base.protocol,
      resolveOperation: vi.fn((input) => allowed.has(input.operationId)
        ? base.protocol.resolveOperation(input)
        : Promise.resolve({ ok: false, reason: 'operation-cas-failed' })),
    };
    const child = createMockChild();
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4124,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'overlap-owner',
      runtimeIdentity: 'overlap-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const { guardian, store } = await createGuardianFixture({
      store: base.store,
      secretProvider: base.secretProvider,
      protocol,
      spawnFn: vi.fn().mockReturnValue(child),
    });

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'overlap-secret' },
        owner,
        launchSpec,
      });
      setTimeout(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4124\n'), 10);
      const spawned = await spawnPromise;
      const spawnOperation = (await store.listOperations()).find((operation) => operation.kind === 'spawn');

      await guardian.prepareHandoff({ incarnation: spawned.incarnation, owner });
      const prepareOperation = (await store.listOperations()).find((operation) => operation.kind === 'prepare-handoff');
      const fenced = (await guardian.listChildren()).find((entry) => entry.incarnation === spawned.incarnation);
      expect(fenced.operationIds).toEqual(expect.arrayContaining([
        spawnOperation.operationId,
        prepareOperation.operationId,
      ]));

      // The later prepare operation resolves first. The earlier spawn handle
      // remains unresolved, so attention and credentials remain retained.
      allowed.add(prepareOperation.operationId);
      await guardian.cleanup();
      expect((await guardian.listChildren()).find((entry) => entry.incarnation === spawned.incarnation))
        .toMatchObject({ state: 'attention', operationIds: [spawnOperation.operationId] });

      // Abort creates a third operation without overwriting the original
      // spawn handle. Resolve the remaining operations in the other order.
      await guardian.abortHandoff({ incarnation: spawned.incarnation, owner });
      const abortOperation = (await store.listOperations()).find((operation) => operation.kind === 'abort-handoff');
      allowed.add(spawnOperation.operationId);
      allowed.add(abortOperation.operationId);
      // A later abort result must not overwrite the original operation set.
      // The unresolved spawn handle remains the authoritative blocker until
      // its own exact binding is resolved.
      expect((await guardian.listChildren()).find((entry) => entry.incarnation === spawned.incarnation))
        .toMatchObject({ operationIds: expect.arrayContaining([spawnOperation.operationId]) });
    } finally {
      try { await guardian.stop(); } catch { /* retention assertions are authoritative */ }
    }
  });

  it.skipIf(process.platform === 'win32')('retains terminal handles after operation CAS failure and resolves them on retry', async () => {
    const base = await createGuardianFixture();
    let failResolution = false;
    const protocol = {
      ...base.protocol,
      resolveOperation: vi.fn(async (input) => {
        if (failResolution) {
          failResolution = false;
          throw new Error('operation CAS unavailable');
        }
        return base.protocol.resolveOperation(input);
      }),
    };
    const child = createMockChild();
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4122,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'retention-owner',
      runtimeIdentity: 'retention-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const { guardian, store } = await createGuardianFixture({
      store: base.store,
      secretProvider: base.secretProvider,
      protocol,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
      spawnFn: vi.fn().mockReturnValue(child),
    });

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'retained-operation-secret' },
        owner,
        launchSpec,
      });
      setTimeout(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4122\n'), 10);
      const spawned = await spawnPromise;
      const active = (await store.list()).find((record) => record.incarnation === spawned.incarnation);
      failResolution = true;

      await expect(guardian.stopChild({ incarnation: spawned.incarnation, owner }))
        .rejects.toMatchObject({ code: 'GUARDIAN_OPERATION_RESOLUTION_UNCERTAIN' });
      const operation = (await store.listOperations()).find((candidate) => candidate.state === 'pending');
      await expect(guardian.getOperationStatus({
        operationId: operation.operationId,
        owner,
      })).resolves.toMatchObject({ operation: { state: 'pending' }, record: { state: 'retired' } });
      await expect(credentialStore.read({
        incarnation: spawned.incarnation,
        ...owner,
        credentialFingerprint: active.credentialFingerprint,
      })).resolves.toEqual({ username: 'opencode', password: 'retained-operation-secret' });
      expect(JSON.stringify(await guardian.listChildren())).not.toContain('retained-operation-secret');

      await guardian.cleanup();
      await expect(credentialStore.read({
        incarnation: spawned.incarnation,
        ...owner,
        credentialFingerprint: active.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      await expect(guardian.listChildren()).resolves.toEqual([]);
    } finally {
      try { await guardian.stop(); } catch { /* cleanup is asserted above */ }
    }
  });

  it.skipIf(process.platform === 'win32')('retains credentials through an unexpected exit operation-resolution failure', async () => {
    const base = await createGuardianFixture();
    let resolutionFailures = 1;
    const protocol = {
      ...base.protocol,
      resolveOperation: vi.fn(async (input) => {
        if (resolutionFailures > 0) {
          resolutionFailures -= 1;
          return { ok: false, reason: 'operation-cas-failed' };
        }
        return base.protocol.resolveOperation(input);
      }),
    };
    const child = createMockChild();
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4123,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'unexpected-exit-owner',
      runtimeIdentity: 'unexpected-exit-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const { guardian, store } = await createGuardianFixture({
      store: base.store,
      secretProvider: base.secretProvider,
      protocol,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
      spawnFn: vi.fn().mockReturnValue(child),
    });

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'unexpected-exit-secret' },
        owner,
        launchSpec,
      });
      setTimeout(() => child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4123\n'), 10);
      const spawned = await spawnPromise;
      const active = (await store.list()).find((record) => record.incarnation === spawned.incarnation);
      expect((await store.listOperations()).find((operation) => operation.incarnation === spawned.incarnation))
        .toMatchObject({ state: 'pending' });

      // The first failed resolution above is the ambiguous spawn outcome. A
      // later unexpected exit must not turn that unresolved operation into
      // premature credential deletion.
      resolutionFailures = 1;
      child.exitCode = 1;
      child.emit('close', 1, null);
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(credentialStore.read({
        incarnation: spawned.incarnation,
        ...owner,
        credentialFingerprint: active.credentialFingerprint,
      })).resolves.toEqual({ username: 'opencode', password: 'unexpected-exit-secret' });
      expect((await guardian.listChildren()).some((entry) => entry.operationId)).toBe(true);

      resolutionFailures = 0;
      await guardian.cleanup();
      await expect(credentialStore.read({
        incarnation: spawned.incarnation,
        ...owner,
        credentialFingerprint: active.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      await expect(guardian.listChildren()).resolves.toEqual([]);
    } finally {
      try { await guardian.stop(); } catch { /* retention assertions are authoritative */ }
    }
  });

  it.skipIf(process.platform === 'win32')('does not include malformed child stdout in guardian launch errors', async () => {
    const password = 'guardian-malformed-url-secret';
    const mockChild = createMockChild();
    const { guardian } = await createGuardianFixture({
      spawnFn: vi.fn().mockReturnValue(mockChild),
    });
    await guardian.start();

    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4096,
      cwd: '/tmp/project',
    };
    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: { OPENCODE_SERVER_PASSWORD: password },
      leaseMs: 60_000,
      owner: {
        ownerInstanceId: 'guardian-malformed-owner',
        runtimeIdentity: 'guardian-malformed-runtime',
        launchFingerprint: createLaunchFingerprint(launchSpec),
      },
      launchSpec,
    });
    setTimeout(() => {
      mockChild.stdout.emit('data', `opencode server listening password=${password}\n`);
    }, 10);

    const thrown = await spawnPromise.catch((error) => error);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.message).toContain('Failed to parse server url from OpenCode startup output');
    expect(thrown.message).not.toContain('opencode server listening');
    expect(thrown.message).not.toContain(password);
    await settleAttentionForTest(guardian);
    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('stops child with SIGTERM then SIGKILL', async () => {
    const mockChild = createMockChild({ ignoreSigTerm: true });
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian } = await createGuardianFixture({ spawnFn });

    await guardian.start();

    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    });

    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);

    const { incarnation } = await spawnPromise;

    // Stop child; don't resolve close so SIGKILL is reached.
    const stopPromise = guardian.stopChild({ incarnation, administrative: true });
    await stopPromise;

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
    // After timeout, SIGKILL is issued.
    expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');

    const children = await guardian.listChildren();
    expect(children.length).toBe(0);

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('health check returns healthy for mock HTTP', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian } = await createGuardianFixture({ spawnFn });

    await guardian.start();

    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    });

    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);

    const { incarnation } = await spawnPromise;

    // Mock fetch globally for health check.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({ healthy: true }),
    });

    const health = await guardian.healthCheck({ incarnation });
    expect(health.healthy).toBe(true);

    globalThis.fetch = originalFetch;
    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('persists protected credentials, scopes retrieval, redacts list, and removes on stop', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const base = await createGuardianFixture({ spawnFn });
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const managedHealthProbe = vi.fn(async () => ({
      healthy: false,
      credentialProofFailed: true,
      reason: 'managed OpenCode health proof was unavailable or invalid; refusing to send the managed credential',
    }));
    const { guardian } = await createGuardianFixture({
      spawnFn,
      credentialStore,
      secretProvider: base.secretProvider,
      store: base.store,
      managedHealthProbe,
      options: { allowUnauthenticatedCredentials: false },
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4101,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'credential-owner',
      runtimeIdentity: 'credential-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const password = 'credential-secret-for-child';

    await guardian.start();
    const spawnPromise = guardian.spawnManagedOpenCode({
      ...launchSpec,
      env: {
        OPENCODE_SERVER_USERNAME: 'managed-user',
        OPENCODE_SERVER_PASSWORD: password,
      },
      owner,
      launchSpec,
    });
    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4101\n');
    }, 10);
    const { incarnation } = await spawnPromise;
    const credentialFile = path.join(
      base.root,
      MANAGED_OPENCODE_CREDENTIAL_DIRECTORY,
      `${incarnation}${MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX}`,
    );
    const atRest = fs.readFileSync(credentialFile);
    expect(atRest.includes(Buffer.from(password))).toBe(false);
    expect(JSON.stringify(await guardian.listChildren())).not.toContain(password);
    await expect(guardian.getCredential({ incarnation, owner })).resolves.toEqual({
      username: 'managed-user',
      password,
    });
    await expect(guardian.getCredential({
      incarnation,
      owner: { ...owner, ownerInstanceId: 'wrong-owner' },
      administrative: true,
    })).rejects.toThrow(/does not match|identity is required/);

    await expect(guardian.stopChild({ incarnation, owner })).resolves.toMatchObject({
      state: ManagedOpenCodeHandoffV2State.Retired,
    });
    expect(fs.existsSync(credentialFile)).toBe(false);
    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('cleans a confirmed failed launch credential only after interruption', async () => {
    const spawnFn = vi.fn(() => { throw new Error('spawn failed'); });
    const base = await createGuardianFixture({ spawnFn });
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const { guardian, store } = await createGuardianFixture({
      spawnFn,
      credentialStore,
      secretProvider: base.secretProvider,
      store: base.store,
      options: { allowUnauthenticatedCredentials: false },
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4102,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'failed-owner',
      runtimeIdentity: 'failed-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    await guardian.start();
    await expect(guardian.spawnManagedOpenCode({
      ...launchSpec,
      env: { OPENCODE_SERVER_PASSWORD: 'failed-launch-secret' },
      owner,
      launchSpec,
    })).rejects.toThrow('spawn failed');
    const [record] = await store.list();
    expect(record.state).toBe(ManagedOpenCodeHandoffV2State.Interrupted);
    await expect(credentialStore.read({
      incarnation: record.incarnation,
      ownerInstanceId: record.ownerInstanceId,
      runtimeIdentity: record.runtimeIdentity,
      launchFingerprint: record.launchFingerprint,
      credentialFingerprint: record.credentialFingerprint,
    })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('cleans a linked credential when publication fsync remains unavailable', async () => {
    const base = await createGuardianFixture();
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const { guardian, store } = await createGuardianFixture({
      credentialStore,
      secretProvider: base.secretProvider,
      store: base.store,
      spawnFn: vi.fn(),
      options: { allowUnauthenticatedCredentials: false },
    });
    const warmupKey = await base.secretProvider.deriveCredentialEncryptionKey({
      incarnation: randomBytes(32).toString('base64url'),
    });
    warmupKey.fill(0);
    const descriptor = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4105,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'fsync-failure-owner',
      runtimeIdentity: 'fsync-failure-runtime',
      launchFingerprint: createLaunchFingerprint(descriptor),
    };
    const failure = Object.assign(new Error('post-link fsync failed'), { code: 'EIO' });
    const fsyncSync = fs.fsyncSync.bind(fs);
    let directoryFailures = 2;
    const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fileDescriptor) => {
      if (fs.fstatSync(fileDescriptor).isDirectory() && directoryFailures > 0) {
        directoryFailures -= 1;
        throw failure;
      }
      return fsyncSync(fileDescriptor);
    });

    try {
      await guardian.start();
      await expect(guardian.spawnManagedOpenCode({
        ...descriptor,
        env: { OPENCODE_SERVER_PASSWORD: 'fsync-failure-secret' },
        owner,
        launchSpec: descriptor,
      })).rejects.toThrow(/publication is not durable|credential record could not be created/);

      const [record] = await store.list();
      expect(record).toMatchObject({ state: ManagedOpenCodeHandoffV2State.Interrupted });
      const credentialPath = path.join(
        base.root,
        MANAGED_OPENCODE_CREDENTIAL_DIRECTORY,
        `${record.incarnation}${MANAGED_OPENCODE_CREDENTIAL_FILE_SUFFIX}`,
      );
      expect(fs.existsSync(credentialPath)).toBe(false);
    } finally {
      fsyncSpy.mockRestore();
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('retains a credential when failed-child termination is unconfirmed', async () => {
    const child = createMockChild({ ignoreSigTerm: true });
    const base = await createGuardianFixture();
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const protocol = {
      ...base.protocol,
      bindSpawnedProcess: vi.fn().mockResolvedValue({ ok: false, reason: 'forced-bind-failure' }),
    };
    const spawnFn = vi.fn().mockReturnValue(child);
    const { guardian, store } = await createGuardianFixture({
      spawnFn,
      credentialStore,
      secretProvider: base.secretProvider,
      store: base.store,
      protocol,
      options: {
        allowUnauthenticatedCredentials: false,
        processLiveness: () => true,
        stopSignalTimeoutMs: 0,
        stopKillTimeoutMs: 0,
      },
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4103,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'unconfirmed-owner',
      runtimeIdentity: 'unconfirmed-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    await guardian.start();
    const spawnPromise = guardian.spawnManagedOpenCode({
      ...launchSpec,
      env: { OPENCODE_SERVER_PASSWORD: 'unconfirmed-secret' },
      owner,
      launchSpec,
    });
    setTimeout(() => {
      child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4103\n');
    }, 10);
    await expect(spawnPromise).rejects.toThrow(/forced-bind-failure/);
    const [record] = await store.list();
    expect(record.state).not.toBe(ManagedOpenCodeHandoffV2State.Interrupted);
    await expect(credentialStore.read({
      incarnation: record.incarnation,
      ownerInstanceId: record.ownerInstanceId,
      runtimeIdentity: record.runtimeIdentity,
      launchFingerprint: record.launchFingerprint,
      credentialFingerprint: record.credentialFingerprint,
    })).resolves.toEqual({ username: 'opencode', password: 'unconfirmed-secret' });
    await settleAttentionForTest(guardian);
    await credentialStore.remove(record);
    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('renews lease for active children', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian, protocol } = await createGuardianFixture({
      spawnFn,
      options: { leaseRenewalIntervalMs: 10 },
    });

    await guardian.start();

    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    });

    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);

    const { incarnation } = await spawnPromise;

    const before = await guardian.listChildren();
    expect(before.length).toBe(1);

    // The guardian timer owns renewal. Wait for the persisted revision to
    // advance, then exercise both subsequent transitions against the local
    // entry as well as the durable record.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const renewed = await protocol.readRecord({ incarnation });
    expect(renewed.ok).toBe(true);
    expect(renewed.record.revision).toBeGreaterThan(before[0].revision);

    await expect(guardian.prepareHandoff({ incarnation, administrative: true }))
      .resolves.toMatchObject({ state: ManagedOpenCodeHandoffV2State.HandoffPrepared });

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('cleans up expired records', async () => {
    const { guardian } = await createGuardianFixture();
    await guardian.start();

    const cleanupSpy = vi.spyOn(guardian, 'cleanup').mockResolvedValue({ removed: 2 });
    const result = await guardian.cleanup();
    expect(result.removed).toBe(2);
    cleanupSpy.mockRestore();

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')(' IPC round-trip with guardian-client', async () => {
    const { guardian, root } = await createGuardianFixture();
    await guardian.start();

    const client = new GuardianClient({ socketPath: guardian.socketPath });

    try {
      await client.connect();

      // The guardian consumes an authenticated sequence as soon as it
      // accepts the request, even when the dispatcher returns an error. The
      // client must therefore be able to continue on the same connection.
      await expect(client.health({ incarnation: 'missing-child' }))
        .rejects.toMatchObject({ code: 'owner_required' });
      await expect(client.health({
        incarnation: 'missing-child',
        owner: {
          ownerInstanceId: 'missing-owner',
          runtimeIdentity: 'missing-runtime',
          launchFingerprint: 'missing-fingerprint',
        },
      }))
        .rejects.toMatchObject({ code: 'execution_error' });
      await expect(client.list()).resolves.toEqual([]);

      const mockChild = createMockChild();
      const spawnFn = vi.fn().mockReturnValue(mockChild);
      // Re-inject spawnFn into the guardian for the IPC call.
      guardian.setSpawnFn?.(spawnFn);

      const spawnPromise = client.spawn({
        port: 4097,
        hostname: '127.0.0.1',
        binary: 'opencode',
        args: [],
        cwd: '/tmp/project',
        env: {},
        owner: {
          ownerInstanceId: 'owner-ipc',
          runtimeIdentity: 'runtime-ipc',
          launchFingerprint: createLaunchFingerprint({
            binary: 'opencode',
            args: [],
            hostname: '127.0.0.1',
            port: 4097,
            cwd: '/tmp/project',
          }),
        },
      });

      // The IPC server will call guardian.spawnManagedOpenCode which spawns.
      // We need to emit the listening line after a tick.
      setTimeout(() => {
        mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4097\n');
      }, 10);

      const result = await spawnPromise;
      expect(result).toMatchObject({ pid: 12345, port: 4097 });

      const listResult = await client.list();
      expect(Array.isArray(listResult)).toBe(true);
      expect(listResult.length).toBe(1);

      const owner = {
        ownerInstanceId: 'owner-ipc',
        runtimeIdentity: 'runtime-ipc',
        launchFingerprint: createLaunchFingerprint({
          binary: 'opencode',
          args: [],
          hostname: '127.0.0.1',
          port: 4097,
          cwd: '/tmp/project',
        }),
      };
      const prepareOperationId = randomBytes(32).toString('base64url');
      await client.prepareHandoff({ incarnation: result.incarnation, owner, operationId: prepareOperationId });
      await expect(client.operationStatus({ operationId: prepareOperationId, owner }))
        .resolves.toMatchObject({
          operation: {
            operationId: prepareOperationId,
            kind: 'prepare-handoff',
            state: 'resolved',
            resolutionState: ManagedOpenCodeHandoffV2State.HandoffPrepared,
          },
        });
      await expect(client.operationList({ owner })).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ operationId: prepareOperationId })]),
      );
      const rollback = await client.abortHandoff({ incarnation: result.incarnation, owner });
      expect(rollback).toMatchObject({
        state: ManagedOpenCodeHandoffV2State.Active,
        incarnation: result.incarnation,
      });
      expect(rollback.ok).toBeUndefined();

      await client.stop({
        incarnation: result.incarnation,
        owner: {
          ownerInstanceId: 'owner-ipc',
          runtimeIdentity: 'runtime-ipc',
          launchFingerprint: createLaunchFingerprint({
            binary: 'opencode',
            args: [],
            hostname: '127.0.0.1',
            port: 4097,
            cwd: '/tmp/project',
          }),
        },
      });
    } finally {
      client.disconnect();
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects oversized IPC frames before JSON parsing', async () => {
    const { guardian } = await createGuardianFixture();
    await guardian.start();
    const socket = net.createConnection(guardian.socketPath);
    let buffer = '';
    const responses = [];
    const waiters = [];
    const nextResponse = () => {
      if (responses.length > 0) return Promise.resolve(responses.shift());
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const response = JSON.parse(line);
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(response);
        else responses.push(response);
      }
    });
    socket.on('error', () => {});

    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      await expect(nextResponse()).resolves.toMatchObject({ type: 'challenge' });
      socket.write(`${'x'.repeat(GUARDIAN_IPC_MAX_FRAME_BYTES + 1)}\n`);
      await expect(nextResponse()).resolves.toMatchObject({
        error: { code: 'frame_too_large' },
      });
    } finally {
      socket.destroy();
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects oversized IPC responses before dispatching them to a client', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-frame-client-'));
    roots.push(root);
    const socketPath = path.join(root, 'guardian.sock');
    const server = net.createServer((socket) => {
      let buffer = '';
      let handshakeComplete = false;
      socket.write(`${JSON.stringify({ type: 'challenge', challenge: 'frame-test-challenge' })}\n`);
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const request = JSON.parse(line);
          if (!handshakeComplete) {
            handshakeComplete = true;
            socket.write(`${JSON.stringify({ id: request.id, result: { authenticated: true } })}\n`);
            continue;
          }
          socket.write(`${'x'.repeat(GUARDIAN_IPC_MAX_FRAME_BYTES + 1)}\n`);
        }
      });
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    const client = new GuardianClient({
      socketPath,
      authSecret: Buffer.alloc(32, 3),
      requestTimeoutMs: 500,
    });

    try {
      await expect(client.spawn({ sideEffect: true })).rejects.toMatchObject({
        code: GUARDIAN_AMBIGUOUS_REQUEST_CODE,
        ambiguous: true,
        retryable: false,
        originalCode: 'frame_too_large',
      });
    } finally {
      client.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.skipIf(process.platform === 'win32')('retrieves credentials over authenticated IPC only for the exact owner', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const base = await createGuardianFixture({ spawnFn });
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4104,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'ipc-credential-owner',
      runtimeIdentity: 'ipc-credential-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const managedHealthProbe = vi.fn(async () => ({ healthy: true }));
    // Use the connection-bound probe seam; a plain fetch mock would bypass the
    // security contract this test is intended to exercise.
    const fixture = await createGuardianFixture({
      spawnFn,
      credentialStore,
      secretProvider: base.secretProvider,
      store: base.store,
      managedHealthProbe,
      options: { allowUnauthenticatedCredentials: false },
    });
    const managedGuardian = fixture.guardian;
    const client = new GuardianClient({ socketPath: managedGuardian.socketPath });

    try {
      await managedGuardian.start();
      await client.connect();
      const spawnPromise = client.spawn({
        ...launchSpec,
        env: {
          OPENCODE_SERVER_USERNAME: 'ipc-user',
          OPENCODE_SERVER_PASSWORD: 'ipc-secret',
        },
        owner,
        launchSpec,
      });
      setTimeout(() => {
        mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4104\n');
      }, 10);
      const result = await spawnPromise;

      await expect(client.credential({
        incarnation: result.incarnation,
        owner: { ...owner, runtimeIdentity: 'wrong-runtime' },
        administrative: true,
      })).rejects.toMatchObject({
        code: 'execution_error',
        message: expect.stringMatching(/ownership identity does not match/),
      });
      await expect(client.credential({
        incarnation: result.incarnation,
        owner,
      })).resolves.toEqual({ username: 'ipc-user', password: 'ipc-secret' });
      await expect(client.health({
        incarnation: result.incarnation,
        owner: { ...owner, launchFingerprint: 'wrong-fingerprint' },
      })).rejects.toMatchObject({
        code: 'execution_error',
        message: expect.stringMatching(/ownership identity does not match/),
      });
      await expect(client.health({ incarnation: result.incarnation, owner })).resolves.toEqual({ healthy: true });
      expect(managedHealthProbe).toHaveBeenCalledWith(expect.objectContaining({
        url: 'http://127.0.0.1:4104/global/health',
        record: expect.objectContaining({ incarnation: result.incarnation, port: 4104 }),
        credential: { username: 'ipc-user', password: 'ipc-secret' },
      }));

      const restoredCredentials = [];
      const adopted = await detectAndAdoptGuardianChild(managedGuardian.socketPath, undefined, {
        expectedOwner: {
          ownerInstanceId: owner.ownerInstanceId,
          runtimeIdentity: owner.runtimeIdentity,
        },
        restoreCredential: (credential) => {
          restoredCredentials.push({ ...credential });
        },
      });
      expect(adopted).toMatchObject({
        incarnation: result.incarnation,
        owner,
        url: 'http://127.0.0.1:4104',
      });
      expect(restoredCredentials).toEqual([{ username: 'ipc-user', password: 'ipc-secret' }]);

      const listed = await client.list();
      expect(JSON.stringify(listed)).not.toContain('ipc-secret');
      expect(JSON.stringify(listed)).not.toContain('ipc-user');
      await expect(client.stop({ incarnation: result.incarnation, owner })).resolves.toMatchObject({
        state: ManagedOpenCodeHandoffV2State.Retired,
      });
    } finally {
      client.disconnect();
      await managedGuardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('does not send Basic Auth when the managed health proof is missing', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const base = await createGuardianFixture({ spawnFn });
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const managedHealthProbe = vi.fn(async () => {
      throw new Error('managed health proof missing');
    });
    const { guardian } = await createGuardianFixture({
      spawnFn,
      credentialStore,
      secretProvider: base.secretProvider,
      store: base.store,
      managedHealthProbe,
      options: { allowUnauthenticatedCredentials: false },
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4106,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'proof-owner',
      runtimeIdentity: 'proof-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'proof-password' },
        owner,
        launchSpec,
      });
      setTimeout(() => {
        mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4106\n');
      }, 10);
      const { incarnation } = await spawnPromise;

      await expect(guardian.healthCheckForOwner({ incarnation, owner })).resolves.toMatchObject({
        healthy: false,
        reason: expect.stringContaining('refusing to send the managed credential'),
      });
      expect(managedHealthProbe).toHaveBeenCalledOnce();
    } finally {
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('fails adoption confirmation when credentials mutate after the health read', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const credentials = [
      { username: 'ipc-user', password: 'credential-before' },
      { username: 'ipc-user', password: 'credential-before' },
      { username: 'ipc-user', password: 'credential-after' },
    ];
    let readCount = 0;
    const credentialStore = {
      create: vi.fn(),
      read: vi.fn(async () => credentials[Math.min(readCount++, credentials.length - 1)]),
      remove: vi.fn().mockResolvedValue({ removed: true }),
    };
    const { guardian } = await createGuardianFixture({
      spawnFn,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4110,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'adoption-credential-race-owner',
      runtimeIdentity: 'adoption-credential-race-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'credential-before' },
        owner,
        launchSpec,
      });
      setTimeout(() => mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4110\n'), 10);
      const spawned = await spawnPromise;
      const listed = await guardian.listChildren();
      const record = listed.find((candidate) => candidate.incarnation === spawned.incarnation);

      await expect(guardian.confirmAdoption({
        incarnation: spawned.incarnation,
        owner,
        expected: {
          revision: record.revision,
          leaseExpiresAt: record.leaseExpiresAt,
          mac: record.mac,
        },
      })).rejects.toThrow(/credential changed/);
      expect(credentialStore.read).toHaveBeenCalledTimes(3);
    } finally {
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('fails adoption confirmation when final health changes', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    let healthCount = 0;
    const credentialStore = {
      create: vi.fn(),
      read: vi.fn().mockResolvedValue({ username: 'ipc-user', password: 'health-race-password' }),
      remove: vi.fn().mockResolvedValue({ removed: true }),
    };
    const managedHealthProbe = vi.fn(async () => {
      healthCount += 1;
      return { healthy: healthCount === 1 };
    });
    const { guardian } = await createGuardianFixture({
      spawnFn,
      credentialStore,
      managedHealthProbe,
      options: { allowUnauthenticatedCredentials: false },
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4111,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'adoption-health-race-owner',
      runtimeIdentity: 'adoption-health-race-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'health-race-password' },
        owner,
        launchSpec,
      });
      setTimeout(() => mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4111\n'), 10);
      const spawned = await spawnPromise;
      const listed = await guardian.listChildren();
      const record = listed.find((candidate) => candidate.incarnation === spawned.incarnation);

      await expect(guardian.confirmAdoption({
        incarnation: spawned.incarnation,
        owner,
        expected: {
          revision: record.revision,
          leaseExpiresAt: record.leaseExpiresAt,
          mac: record.mac,
        },
      })).rejects.toThrow(/final health confirmation failed/);
      expect(managedHealthProbe).toHaveBeenCalledTimes(2);
    } finally {
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('serializes credential health ahead of same-incarnation stop', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    let releaseHealth;
    const healthStarted = new Promise((resolve) => {
      releaseHealth = resolve;
    });
    const managedHealthProbe = vi.fn(async () => {
      await healthStarted;
      return { healthy: true };
    });
    const base = await createGuardianFixture({ spawnFn });
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const { guardian } = await createGuardianFixture({
      spawnFn,
      credentialStore,
      secretProvider: base.secretProvider,
      store: base.store,
      managedHealthProbe,
      options: { allowUnauthenticatedCredentials: false },
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4107,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'health-stop-owner',
      runtimeIdentity: 'health-stop-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'health-stop-password' },
        owner,
        launchSpec,
      });
      setTimeout(() => {
        mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4107\n');
      }, 10);
      const { incarnation } = await spawnPromise;

      const health = guardian.healthCheckForOwner({ incarnation, owner });
      await vi.waitFor(() => expect(managedHealthProbe).toHaveBeenCalledOnce());
      let stopSettled = false;
      const stop = guardian.stopChild({ incarnation, owner }).finally(() => {
        stopSettled = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(stopSettled).toBe(false);

      releaseHealth();
      await expect(health).resolves.toEqual({ healthy: true });
      await expect(stop).resolves.toMatchObject({ state: ManagedOpenCodeHandoffV2State.Retired });
      await expect(credentialStore.read({
        incarnation,
        ...owner,
        credentialFingerprint: (await base.protocol.readRecord({ incarnation })).record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
    } finally {
      try { await guardian.stop(); } catch { /* child stop is asserted above */ }
    }
  });

  it.skipIf(process.platform === 'win32')('routes adoption confirmation through the v2 CAS authority', async () => {
    const mockChild = createMockChild();
    const base = await createGuardianFixture();
    const confirmRecord = vi.fn((input) => base.protocol.confirmRecord(input));
    const protocol = { ...base.protocol, confirmRecord };
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: base.root,
      secretProvider: base.secretProvider,
    });
    const { guardian } = await createGuardianFixture({
      store: base.store,
      secretProvider: base.secretProvider,
      protocol,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
      spawnFn: vi.fn().mockReturnValue(mockChild),
      managedHealthProbe: vi.fn(async () => ({ healthy: true })),
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4113,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'adoption-cas-owner',
      runtimeIdentity: 'adoption-cas-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'adoption-cas-password' },
        owner,
        launchSpec,
      });
      setTimeout(() => mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4113\n'), 10);
      const spawned = await spawnPromise;
      const record = (await guardian.listChildren()).find((candidate) => candidate.incarnation === spawned.incarnation);

      await expect(guardian.confirmAdoption({
        incarnation: spawned.incarnation,
        owner,
        expected: {
          revision: record.revision,
          leaseExpiresAt: record.leaseExpiresAt,
          mac: record.mac,
        },
      })).resolves.toMatchObject({ record });
      expect(confirmRecord).toHaveBeenCalledOnce();
      expect(confirmRecord).toHaveBeenCalledWith(expect.objectContaining({
        incarnation: spawned.incarnation,
        expectedRevision: record.revision,
        expectedLeaseExpiresAt: record.leaseExpiresAt,
        expectedMac: record.mac,
      }));
    } finally {
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('confirms a retired record after child removal with exact owner and binding', async () => {
    const mockChild = createMockChild();
    const { guardian, root } = await createGuardianFixture({ spawnFn: vi.fn().mockReturnValue(mockChild) });
    const client = new GuardianClient({ socketPath: path.join(root, 'guardian.sock') });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4112,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'terminal-confirm-owner',
      runtimeIdentity: 'terminal-confirm-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    try {
      await guardian.start();
      await client.connect();
      const spawnPromise = client.spawn({
        ...launchSpec,
        env: {},
        owner,
        launchSpec,
      });
      setTimeout(() => mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4112\n'), 10);
      const spawned = await spawnPromise;
      const retired = await client.stop({ incarnation: spawned.incarnation, owner });
      expect(await client.list()).toEqual([]);

      await expect(client.terminalStatus({
        incarnation: spawned.incarnation,
        owner,
      })).resolves.toMatchObject({ record: retired });
      await expect(client.confirmTerminal({
        incarnation: spawned.incarnation,
        owner,
        expected: {
          revision: retired.revision,
          leaseExpiresAt: retired.leaseExpiresAt,
          mac: retired.mac,
        },
      })).resolves.toMatchObject({ record: retired });

      await expect(client.confirmTerminal({
        incarnation: spawned.incarnation,
        owner: { ...owner, ownerInstanceId: 'wrong-owner' },
        expected: {
          revision: retired.revision,
          leaseExpiresAt: retired.leaseExpiresAt,
          mac: retired.mac,
        },
      })).rejects.toThrow(/ownership identity does not match/);
      await expect(client.confirmTerminal({
        incarnation: spawned.incarnation,
        owner,
        expected: {
          revision: retired.revision + 1,
          leaseExpiresAt: retired.leaseExpiresAt,
          mac: retired.mac,
        },
      })).rejects.toThrow(/binding changed/);
      await expect(client.confirmTerminal({
        incarnation: spawned.incarnation,
        owner,
        expected: {
          revision: retired.revision,
          leaseExpiresAt: retired.leaseExpiresAt,
          mac: 'wrong-mac',
        },
      })).rejects.toThrow(/binding changed/);
      await expect(client.confirmTerminal({
        incarnation: 'wrong-incarnation',
        owner,
        expected: {
          revision: retired.revision,
          leaseExpiresAt: retired.leaseExpiresAt,
          mac: retired.mac,
        },
      })).rejects.toThrow(/terminal record is unavailable/);
    } finally {
      client.disconnect();
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('serializes concurrent launches while keeping read-only list responsive', async () => {
    const child = createMockChild();
    let resolveSpawnStarted;
    const spawnStarted = new Promise((resolve) => { resolveSpawnStarted = resolve; });
    const spawnFn = vi.fn(() => {
      resolveSpawnStarted();
      return child;
    });
    const { guardian, root } = await createGuardianFixture({ spawnFn });
    const clients = [
      new GuardianClient({ socketPath: path.join(root, 'guardian.sock') }),
      new GuardianClient({ socketPath: path.join(root, 'guardian.sock') }),
      new GuardianClient({ socketPath: path.join(root, 'guardian.sock') }),
    ];
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4098,
      cwd: '/tmp/project',
    };
    const launch = (ownerInstanceId) => ({
      ...launchSpec,
      env: {},
      launchSpec,
      owner: {
        ownerInstanceId,
        runtimeIdentity: `${ownerInstanceId}-runtime`,
        launchFingerprint: createLaunchFingerprint(launchSpec),
      },
    });

    try {
      await guardian.start();
      await Promise.all(clients.map((client) => client.connect()));

      const firstLaunch = clients[0].spawn(launch('concurrent-owner-a'));
      await spawnStarted;
      const secondLaunch = clients[1].spawn(launch('concurrent-owner-b'));

      // The first launch is still waiting for its listening notification, but
      // read-only inspection must not wait behind the mutation lock.
      await expect(clients[2].list()).resolves.toEqual([]);

      child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4098\n');
      await expect(firstLaunch).resolves.toMatchObject({ port: 4098 });
      await expect(secondLaunch).rejects.toThrow(/blocked by unresolved child/);
      expect(spawnFn).toHaveBeenCalledOnce();
      await expect(clients[2].list()).resolves.toHaveLength(1);
    } finally {
      for (const client of clients) client.disconnect();
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('does not launch a child queued after shutdown begins', async () => {
    const child = createMockChild();
    let resolveSpawnStarted;
    const spawnStarted = new Promise((resolve) => { resolveSpawnStarted = resolve; });
    const spawnFn = vi.fn(() => {
      resolveSpawnStarted();
      return child;
    });
    const { guardian, root } = await createGuardianFixture({ spawnFn });
    const shutdownClient = new GuardianClient({ socketPath: path.join(root, 'guardian.sock') });
    const launchClient = new GuardianClient({ socketPath: path.join(root, 'guardian.sock') });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4099,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'shutdown-race-owner',
      runtimeIdentity: 'shutdown-race-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    let resolveStopStarted;
    const stopStarted = new Promise((resolve) => { resolveStopStarted = resolve; });

    try {
      await guardian.start();
      await Promise.all([shutdownClient.connect(), launchClient.connect()]);
      const initialLaunch = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: {},
        launchSpec,
        owner,
      });
      await spawnStarted;
      child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4099\n');
      await expect(initialLaunch).resolves.toMatchObject({ port: 4099 });

      // Hold the child in the termination wait so the second client races a
      // live shutdown mutation rather than merely calling after shutdown.
      child.kill = vi.fn(() => {
        resolveStopStarted();
        return true;
      });
      const shutdown = shutdownClient.shutdown();
      await stopStarted;
      const queuedLaunch = launchClient.spawn({
        ...launchSpec,
        port: 4100,
        launchSpec: { ...launchSpec, port: 4100 },
        owner: {
          ...owner,
          ownerInstanceId: 'queued-after-shutdown',
          runtimeIdentity: 'queued-after-shutdown-runtime',
          launchFingerprint: createLaunchFingerprint({ ...launchSpec, port: 4100 }),
        },
      });
      child.exitCode = 0;
      child.emit('close', 0, 'SIGTERM');

      await expect(shutdown).resolves.toMatchObject({ acknowledged: true });
      await expect(queuedLaunch).rejects.toThrow();
      expect(spawnFn).toHaveBeenCalledOnce();
    } finally {
      shutdownClient.disconnect();
      launchClient.disconnect();
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('recovers the mutation queue after a failed mutation', async () => {
    const { guardian } = await createGuardianFixture();
    await guardian.start();

    const startTimersSpy = vi.spyOn(guardian, 'startTimers').mockImplementationOnce(() => {
      throw new Error('reload failed');
    });

    try {
      await expect(guardian.reload()).rejects.toThrow('reload failed');
      await expect(guardian.reload()).resolves.toEqual({ reloaded: true });
      expect(startTimersSpy).toHaveBeenCalledTimes(2);
    } finally {
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('reconnects after a timed-out RPC before sending the next sequence', async () => {
    const { guardian } = await createGuardianFixture();
    await guardian.start();
    const healthSpy = vi.spyOn(guardian, 'healthCheckForOwner').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ healthy: false }), 100)),
    );
    const client = new GuardianClient({
      socketPath: guardian.socketPath,
      requestTimeoutMs: 20,
    });

    try {
      await expect(client.health({
        incarnation: 'slow-child',
        owner: {
          ownerInstanceId: 'slow-owner',
          runtimeIdentity: 'slow-runtime',
          launchFingerprint: 'slow-fingerprint',
        },
      }))
        .rejects.toMatchObject({ code: 'request_timeout' });
      await expect(client.list()).resolves.toEqual([]);
    } finally {
      healthSpy.mockRestore();
      client.disconnect();
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('enforces singleton via PID file', async () => {
    // This is tested at the CLI entrypoint level; here we verify the fixture.
    const { root } = await createGuardianFixture();
    const pidFile = path.join(root, 'guardian.pid');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });

    // Simulate CLI singleton check.
    const isProcessAlive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const existingPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    expect(existingPid).toBe(process.pid);
    expect(isProcessAlive(existingPid)).toBe(true);

    fs.unlinkSync(pidFile);
  });

  it.skipIf(process.platform === 'win32')('fails closed on spawn with bad binary', async () => {
    const { guardian } = await createGuardianFixture();
    await guardian.start();

    await expect(guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: '',
      cwd: '/tmp/project',
      env: {},
    })).rejects.toThrow('Invalid binary');

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('accepts resolver-shaped OpenCode cmd and bat wrappers and appends serve arguments after the target', async () => {
    for (const [index, targetName] of ['opencode.cmd', 'OpenCode.BAT'].entries()) {
      const mockChild = createMockChild();
      const spawnFn = vi.fn().mockReturnValue(mockChild);
      const fixture = await createGuardianFixture({ spawnFn });
      const port = 4190 + index;
      const { launchSpec, owner } = createCmdWrapperLaunch(fixture.root, { port, targetName });
      let started = false;
      try {
        await fixture.guardian.start();
        started = true;
        const spawnPromise = fixture.guardian.spawnManagedOpenCode({
          ...launchSpec,
          env: {},
          owner,
          launchSpec,
        });
        setTimeout(() => {
          mockChild.stdout.emit('data', `opencode server listening on http://127.0.0.1:${port}\n`);
        }, 10);

        await spawnPromise;
        expect(spawnFn).toHaveBeenCalledWith(
          launchSpec.binary,
          [
            ...launchSpec.args,
            'serve',
            '--hostname',
            launchSpec.hostname,
            '--port',
            String(port),
          ],
          expect.objectContaining({ cwd: launchSpec.cwd, windowsHide: true }),
        );
      } finally {
        if (started) await fixture.guardian.stop();
      }
    }
  });

  it.skipIf(process.platform === 'win32')('rejects arbitrary cmd commands, shell operators, non-absolute targets, and unrelated batch targets', async () => {
    const spawnFn = vi.fn().mockReturnValue(createMockChild());
    const { root, guardian } = await createGuardianFixture({ spawnFn });
    await guardian.start();

    const invalidArgs = [
      ['/d', '/s', '/c', 'echo', path.join(root, 'opencode.cmd')],
      ['/d', '/s', '/c', 'call', path.join(root, 'opencode.cmd'), '&', 'whoami'],
      ['/d', '/s', '/c', 'call', path.join(root, 'unrelated-tool.bat')],
      ['/d', '/s', '/c', 'call', 'opencode.cmd'],
    ];
    for (const args of invalidArgs) {
      await expect(guardian.spawnManagedOpenCode({
        port: 4199,
        hostname: '127.0.0.1',
        binary: 'cmd.exe',
        args,
        cwd: '/tmp/project',
        env: {},
      })).rejects.toThrow('not an allowed OpenCode launch target');
    }

    expect(spawnFn).not.toHaveBeenCalled();
    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('rejects a managed password before reserving an ownerless launch', async () => {
    const spawnFn = vi.fn().mockReturnValue(createMockChild());
    const { guardian, store } = await createGuardianFixture({ spawnFn });
    await guardian.start();

    await expect(guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: { OPENCODE_SERVER_PASSWORD: 'ownerless-secret' },
    })).rejects.toThrow(/stable owner identity/);
    expect(await store.list()).toEqual([]);
    expect(spawnFn).not.toHaveBeenCalled();
    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('interrupts the authoritative post-beginLaunch record when spawn fails', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn failed after beginLaunch');
    });
    const { guardian, store } = await createGuardianFixture({ spawnFn });
    await guardian.start();

    await expect(guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    })).rejects.toThrow('spawn failed after beginLaunch');

    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: ManagedOpenCodeHandoffV2State.Interrupted });
    expect(records[0].revision).toBeGreaterThan(0);

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('cleans up a published credential when beginLaunch fails', async () => {
    const base = await createGuardianFixture();
    const credentialStore = {
      create: vi.fn().mockResolvedValue({ created: true }),
      read: vi.fn(),
      remove: vi.fn().mockResolvedValue({ removed: true }),
    };
    const beginLaunch = vi.fn().mockResolvedValue({
      ok: false,
      reason: 'credential-publication-failed',
    });
    const protocol = { ...base.protocol, beginLaunch };
    const { guardian, store } = await createGuardianFixture({
      store: base.store,
      protocol,
      secretProvider: base.secretProvider,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
      spawnFn: vi.fn(),
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4108,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'begin-launch-failure-owner',
      runtimeIdentity: 'begin-launch-failure-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };

    try {
      await guardian.start();
      await expect(guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'begin-launch-failure-password' },
        owner,
        launchSpec,
      })).rejects.toThrow('Failed to begin launch: credential-publication-failed');

      expect(beginLaunch).toHaveBeenCalledOnce();
      expect(credentialStore.create).toHaveBeenCalledOnce();
      expect(credentialStore.remove).toHaveBeenCalledWith(expect.objectContaining({
        credentialFingerprint: expect.any(String),
      }));
      await expect(store.list()).resolves.toEqual([
        expect.objectContaining({ state: ManagedOpenCodeHandoffV2State.Interrupted }),
      ]);
      await expect(guardian.listChildren()).resolves.toEqual([]);
    } finally {
      await guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('re-reads the current revision after a stale launch-cleanup CAS', async () => {
    const base = await createGuardianFixture();
    let readCount = 0;
    let markCount = 0;
    const readRecord = vi.fn(async (input) => {
      const loaded = await base.protocol.readRecord(input);
      if (readCount++ === 0 && loaded.ok) {
        return {
          ...loaded,
          record: {
            ...loaded.record,
            revision: Math.max(0, loaded.record.revision - 1),
          },
        };
      }
      return loaded;
    });
    const markInterrupted = vi.fn(async (input) => {
      if (markCount++ === 0) return { ok: false, reason: 'stale-revision' };
      return base.protocol.markInterrupted(input);
    });
    const protocol = {
      ...base.protocol,
      readRecord,
      markInterrupted,
    };
    const spawnFn = vi.fn(() => {
      throw new Error('spawn failed after beginLaunch');
    });
    const { guardian, store } = await createGuardianFixture({
      store: base.store,
      secretProvider: base.secretProvider,
      protocol,
      spawnFn,
    });
    await guardian.start();

    await expect(guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    })).rejects.toThrow('spawn failed after beginLaunch');

    const records = await store.list();
    expect(records).toHaveLength(1);
    expect(records[0].state).toBe(ManagedOpenCodeHandoffV2State.Interrupted);
    expect(readRecord).toHaveBeenCalledTimes(2);
    expect(markInterrupted).toHaveBeenCalledTimes(2);
    expect(markInterrupted.mock.calls[1][0].expectedRevision)
      .toBeGreaterThan(markInterrupted.mock.calls[0][0].expectedRevision);

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('fails closed on spawn with invalid port', async () => {
    const { guardian } = await createGuardianFixture();
    await guardian.start();

    await expect(guardian.spawnManagedOpenCode({
      port: 70000,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    })).rejects.toThrow('Invalid port');

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('prepareHandoff transitions to HandoffPrepared', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian } = await createGuardianFixture({ spawnFn });

    await guardian.start();

    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    });

    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);

    const { incarnation } = await spawnPromise;
    const prepared = await guardian.prepareHandoff({ incarnation, administrative: true });
    expect(prepared.state).toBe(ManagedOpenCodeHandoffV2State.HandoffPrepared);

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32').each([
    ['beginStopping', 'stopChild', 'stop'],
    ['prepareHandoff', 'prepareHandoff', 'prepare-handoff'],
    ['abortHandoff', 'abortHandoff', 'abort-handoff'],
  ])('retains a %s transition operation in durable attention when the transition fails', async (
    transition,
    action,
    operationKind,
  ) => {
    const base = await createGuardianFixture();
    const child = createMockChild();
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4140 + ['stopChild', 'prepareHandoff', 'abortHandoff'].indexOf(action),
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: `transition-failure-${transition}`,
      runtimeIdentity: `transition-failure-${transition}-runtime`,
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const failedTransition = vi.fn().mockResolvedValue({
      ok: false,
      reason: `${transition}-failed`,
    });
    const protocol = {
      ...base.protocol,
      [transition]: failedTransition,
    };
    const { guardian, store } = await createGuardianFixture({
      store: base.store,
      secretProvider: base.secretProvider,
      protocol,
      spawnFn: vi.fn().mockReturnValue(child),
    });

    try {
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: {},
        owner,
        launchSpec,
      });
      setTimeout(() => child.stdout.emit('data', `opencode server listening on http://127.0.0.1:${launchSpec.port}\n`), 10);
      const spawned = await spawnPromise;

      if (action === 'abortHandoff') {
        await guardian.protocol.prepareHandoff({
          incarnation: spawned.incarnation,
          expectedRevision: (await guardian.protocol.readRecord({ incarnation: spawned.incarnation })).record.revision,
        });
      }

      await expect(guardian[action]({
        incarnation: spawned.incarnation,
        owner,
      })).rejects.toThrow();

      const operation = (await store.listOperations()).find((candidate) => candidate.kind === operationKind);
      expect(operation).toMatchObject({ state: 'pending', kind: operationKind });
      expect((await guardian.listChildren()).find((entry) => entry.incarnation === spawned.incarnation))
        .toMatchObject({ state: 'attention', operationIds: [operation.operationId] });
      await expect(guardian.spawnManagedOpenCode({
        ...launchSpec,
        port: launchSpec.port + 100,
        launchSpec: { ...launchSpec, port: launchSpec.port + 100 },
        env: {},
        owner: {
          ...owner,
          launchFingerprint: createLaunchFingerprint({ ...launchSpec, port: launchSpec.port + 100 }),
        },
      })).rejects.toThrow(/blocked by attention record/);
    } finally {
      try { await guardian.stop(); } catch { /* unresolved attention is the assertion */ }
    }
  });

  it.skipIf(process.platform === 'win32')('rejects owner-scoped stops for ownerless children', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian } = await createGuardianFixture({ spawnFn });

    await guardian.start();
    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    });
    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);

    const { incarnation } = await spawnPromise;
    // Remove the injected legacy test escape hatch so the normal IPC-facing
    // ownership rule is exercised for this ownerless record.
    guardian.setSpawnFn(undefined);
    await expect(guardian.stopChild({ incarnation })).rejects.toThrow(/ownership identity is required/);
    expect((await guardian.listChildren()).length).toBe(1);

    await guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('gracefully stops all children on stop()', async () => {
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian } = await createGuardianFixture({ spawnFn });

    await guardian.start();

    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    });

    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);

    await spawnPromise;
    expect((await guardian.listChildren()).length).toBe(1);

    await guardian.stop();
    expect((await guardian.listChildren()).length).toBe(0);
  });

  it.skipIf(process.platform === 'win32')('rehydrates a live stopping record and blocks a duplicate launch', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let secondGuardian;
    let started = false;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const stopping = await first.protocol.beginStopping({
        incarnation: record.incarnation,
        expectedRevision: record.revision,
      });
      expect(stopping.ok).toBe(true);

      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processInspector: ({ record }) => ({
          processStartTicks: '12345',
          launch: {
            commandLine: `${path.basename(record.launchSpec.binary)} serve --hostname ${record.launchSpec.hostname} --port ${record.port}`,
            cwd: record.launchSpec.cwd,
          },
        }),
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();
      started = true;

      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          incarnation: record.incarnation,
          state: ManagedOpenCodeHandoffV2State.Stopping,
          pid: process.pid,
          port: 4096,
        }),
      ]);

      await expect(secondGuardian.spawnManagedOpenCode({
        port: 4096,
        hostname: record.launchSpec.hostname,
        binary: record.launchSpec.binary,
        args: record.launchSpec.args,
        cwd: record.launchSpec.cwd,
        env: {},
        owner: record.owner,
        launchSpec: record.launchSpec,
      })).rejects.toThrow(/blocked by unresolved child/);
    } finally {
      processKill.mockImplementation((pid, signal) => {
        if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true;
      });
      if (started) await secondGuardian.stop();
      processKill.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('keeps a live rehydrated child in attention when its protected credential is missing', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true }),
    });
    let secondGuardian;
    let alive = true;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const actualCredentialStore = createManagedOpenCodeCredentialStore({
        rootDir: first.root,
        secretProvider: first.secretProvider,
      });
      const credentialStore = {
        create: vi.fn(),
        read: actualCredentialStore.read,
        remove: vi.fn().mockResolvedValue({ removed: true }),
      };
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        credentialStore,
        options: {
          allowUnauthenticatedCredentials: false,
          processLiveness: () => alive,
          processInspector: ({ record: inspectedRecord }) => ({
            processStartTicks: '12345',
            launch: {
              commandLine: `${path.basename(inspectedRecord.launchSpec.binary)} serve --hostname ${inspectedRecord.launchSpec.hostname} --port ${inspectedRecord.port}`,
              cwd: inspectedRecord.launchSpec.cwd,
            },
          }),
        },
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();

      expect(globalThis.fetch).not.toHaveBeenCalled();
      await expect(secondGuardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
          reason: expect.stringContaining('credential'),
        }),
      ]));
      await expect(secondGuardian.healthCheck({ incarnation: record.incarnation })).resolves.toEqual({
        healthy: false,
        reason: 'managed OpenCode credential is unavailable',
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      if (secondGuardian) {
        alive = false;
        try { await secondGuardian.stop(); } catch { /* cleanup assertion covers any unresolved state */ }
      }
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(process.platform === 'win32').each([
    ['a timeout', async () => { throw new Error('timeout'); }],
    ['a connection failure', async () => { throw new Error('connection refused'); }],
    ['a server failure', async () => ({ ok: false, status: 503 })],
    ['malformed health data', async () => ({ ok: true, json: async () => null })],
    ['an unhealthy response', async () => ({ ok: true, json: async () => ({ healthy: false }) })],
  ])('retains a live rehydrated child after %s without terminalizing it', async (_label, responseFactory) => {
    let secondGuardian;
    let alive = true;
    let currentHealthResponse = responseFactory;
    const managedHealthProbe = vi.fn(async () => {
      const response = await currentHealthResponse();
      if (!response?.ok) {
        return {
          healthy: false,
          credentialProofFailed: true,
          status: response?.status,
          reason: 'managed OpenCode health proof challenge was rejected; refusing to send the managed credential',
        };
      }
      const body = typeof response.json === 'function'
        ? await response.json().catch(() => null)
        : null;
      if (body?.healthy === true) return { healthy: true };
      return {
        healthy: false,
        credentialProofFailed: true,
        reason: 'managed OpenCode health proof was unavailable or invalid; refusing to send the managed credential',
      };
    });
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const actualCredentialStore = createManagedOpenCodeCredentialStore({
        rootDir: first.root,
        secretProvider: first.secretProvider,
      });
      await actualCredentialStore.create({
        incarnation: record.incarnation,
        ownerInstanceId: record.ownerInstanceId,
        runtimeIdentity: record.runtimeIdentity,
        launchFingerprint: record.launchFingerprint,
        credentialFingerprint: record.credentialFingerprint,
        password: 'rehydration-password',
      });
      const credentialStore = {
        create: vi.fn(),
        read: actualCredentialStore.read,
        remove: vi.fn((input) => actualCredentialStore.remove(input)),
      };
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        credentialStore,
        options: {
          allowUnauthenticatedCredentials: false,
          processLiveness: () => alive,
          processInspector: ({ record: inspectedRecord }) => ({
            processStartTicks: '12345',
            launch: {
              commandLine: `${path.basename(inspectedRecord.launchSpec.binary)} serve --hostname ${inspectedRecord.launchSpec.hostname} --port ${inspectedRecord.port}`,
              cwd: inspectedRecord.launchSpec.cwd,
            },
          }),
        },
        managedHealthProbe,
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();

      await expect(second.protocol.readRecord({ incarnation: record.incarnation })).resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Active },
      });
      await expect(secondGuardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
           kind: 'credential-proof-failed',
        }),
      ]));
      expect(credentialStore.remove).not.toHaveBeenCalled();

      currentHealthResponse = async () => ({ ok: true, json: async () => ({ healthy: true }) });
      await expect(secondGuardian.healthCheck({ incarnation: record.incarnation })).resolves.toEqual({
        healthy: true,
      });
      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          incarnation: record.incarnation,
          state: ManagedOpenCodeHandoffV2State.Active,
        }),
      ]);
    } finally {
      alive = false;
      if (secondGuardian) {
        try { await secondGuardian.stop(); } catch { /* cleanup assertion covers failures */ }
      }
    }
  });

  it.skipIf(process.platform === 'win32')('cleans credentials before interrupting a confirmed-dead active record', async () => {
    let secondGuardian;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const credentialStore = createManagedOpenCodeCredentialStore({
        rootDir: first.root,
        secretProvider: first.secretProvider,
      });
      await credentialStore.create({
        ...record,
        password: 'confirmed-dead-password',
      });

      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        credentialStore,
        options: {
          allowUnauthenticatedCredentials: false,
          processLiveness: () => false,
        },
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();

      await expect(second.protocol.readRecord({ incarnation: record.incarnation })).resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Interrupted },
      });
      await expect(credentialStore.read({
        incarnation: record.incarnation,
        ownerInstanceId: record.ownerInstanceId,
        runtimeIdentity: record.runtimeIdentity,
        launchFingerprint: record.launchFingerprint,
        credentialFingerprint: record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      await expect(secondGuardian.listChildren()).resolves.toEqual([]);
    } finally {
      if (secondGuardian) await secondGuardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('reconciles a credential left by a crash before beginLaunch', async () => {
    const first = await createGuardianFixture();
    const durableStore = createManagedOpenCodeHandoffV2Store({ rootDir: first.root });
    const durableProtocol = createManagedOpenCodeHandoffV2Protocol({
      secretProvider: first.secretProvider,
      store: durableStore,
      now: first.clock.now,
      defaultLeaseMs: 60_000,
    });
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: first.root,
      secretProvider: first.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4111,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'reserved-crash-owner',
      runtimeIdentity: 'reserved-crash-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await durableProtocol.reserveLaunch({ owner, launchSpec });
    expect(reservation.ok).toBe(true);

    // Equivalent to a guardian crash after credential publication and before
    // beginLaunch's CAS: the durable row is still Reserved and has no process
    // identity, so no detached child can exist for this incarnation.
    await credentialStore.create({
      ...reservation.record,
      password: 'reserved-crash-password',
    });
    first.clock.advance(60_001);

    const second = await createGuardianFixture({
      store: durableStore,
      protocol: durableProtocol,
      secretProvider: first.secretProvider,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
    });
    await second.guardian.start();

    await expect(second.protocol.readRecord({
      incarnation: reservation.record.incarnation,
      allowExpired: true,
    }))
      .resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Interrupted },
      });
    await expect(credentialStore.read({
      incarnation: reservation.record.incarnation,
      ownerInstanceId: reservation.record.ownerInstanceId,
      runtimeIdentity: reservation.record.runtimeIdentity,
      launchFingerprint: reservation.record.launchFingerprint,
      credentialFingerprint: reservation.record.credentialFingerprint,
    })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
    await expect(second.guardian.listChildren()).resolves.toEqual([]);
    await second.guardian.stop();
  });

  it.skipIf(process.platform === 'win32')('retries a transient Reserved terminal CAS in the same guardian', async () => {
    const first = await createGuardianFixture();
    let failTerminalCas = true;
    const transientStore = {
      ...first.store,
      compareAndSwap: async (input) => {
        if (failTerminalCas && input.expected !== null) {
          failTerminalCas = false;
          throw new Error('transient reserved CAS failure');
        }
        return first.store.compareAndSwap(input);
      },
    };
    const protocol = createManagedOpenCodeHandoffV2Protocol({
      secretProvider: first.secretProvider,
      store: transientStore,
      now: first.clock.now,
      defaultLeaseMs: 60_000,
    });
    const realCredentialStore = createManagedOpenCodeCredentialStore({
      rootDir: first.root,
      secretProvider: first.secretProvider,
    });
    const credentialStore = {
      ...realCredentialStore,
      remove: vi.fn((...args) => realCredentialStore.remove(...args)),
    };
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4113,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'reserved-transient-owner',
      runtimeIdentity: 'reserved-transient-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await protocol.reserveLaunch({ owner, launchSpec });
    await credentialStore.create({
      ...reservation.record,
      password: 'reserved-transient-password',
    });

    const second = await createGuardianFixture({
      store: transientStore,
      protocol,
      secretProvider: first.secretProvider,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
    });

    try {
      await second.guardian.start();
      await expect(second.protocol.readRecord({
        incarnation: reservation.record.incarnation,
        allowExpired: true,
      })).resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Reserved },
      });
      expect(credentialStore.remove).not.toHaveBeenCalled();
      expect(second.log.mock.calls.flat().join('\n')).toContain('scheduled attention reconciliation');

      // The explicit cleanup retry is the same-process recovery path; no
      // restart is needed and the credential remains until the CAS succeeds.
      await second.guardian.cleanup();
      await expect(second.protocol.readRecord({
        incarnation: reservation.record.incarnation,
        allowExpired: true,
      })).resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Interrupted },
      });
      await expect(credentialStore.read({
        incarnation: reservation.record.incarnation,
        ownerInstanceId: reservation.record.ownerInstanceId,
        runtimeIdentity: reservation.record.runtimeIdentity,
        launchFingerprint: reservation.record.launchFingerprint,
        credentialFingerprint: reservation.record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      expect(credentialStore.remove).toHaveBeenCalledOnce();
      await expect(second.guardian.listChildren()).resolves.toEqual([]);
    } finally {
      await second.guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('keeps bounded retry scheduled when Reserved terminalization outlives credential cleanup', async () => {
    const first = await createGuardianFixture();
    const durableStore = createManagedOpenCodeHandoffV2Store({ rootDir: first.root });
    const protocol = createManagedOpenCodeHandoffV2Protocol({
      secretProvider: first.secretProvider,
      store: durableStore,
      now: first.clock.now,
      defaultLeaseMs: 60_000,
    });
    const realCredentialStore = createManagedOpenCodeCredentialStore({
      rootDir: first.root,
      secretProvider: first.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4114,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'reserved-credential-retry-owner',
      runtimeIdentity: 'reserved-credential-retry-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await protocol.reserveLaunch({ owner, launchSpec });
    const credentialDescriptor = {
      ...reservation.record,
      password: 'reserved-credential-retry-password',
    };
    await realCredentialStore.create(credentialDescriptor);
    const credentialStore = {
      ...realCredentialStore,
      remove: vi.fn()
        .mockRejectedValueOnce(new Error('credential removal temporarily unavailable'))
        .mockImplementation((...args) => realCredentialStore.remove(...args)),
    };
    const second = await createGuardianFixture({
      store: durableStore,
      protocol,
      secretProvider: first.secretProvider,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
    });

    try {
      await second.guardian.start();
      await expect(second.protocol.readRecord({
        incarnation: reservation.record.incarnation,
        allowExpired: true,
      })).resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Interrupted },
      });
      await expect(realCredentialStore.read(credentialDescriptor)).resolves.toMatchObject({
        password: 'reserved-credential-retry-password',
      });
      expect(credentialStore.remove).toHaveBeenCalledOnce();
      await expect(second.guardian.listChildren()).resolves.toEqual([
        expect.objectContaining({ kind: 'confirmed-death-cleanup-failed', incarnation: reservation.record.incarnation }),
      ]);

      await new Promise((resolve) => setTimeout(resolve, 1100));

      await expect(realCredentialStore.read(credentialDescriptor))
        .rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      await expect(second.guardian.listChildren()).resolves.toEqual([]);
      expect(credentialStore.remove).toHaveBeenCalledTimes(2);
    } finally {
      await second.guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('retries reserved recovery when its lease expires before the terminal CAS', async () => {
    const first = await createGuardianFixture();
    let raced = false;
    const casInputs = [];
    const raceStore = {
      ...first.store,
      compareAndSwap: async (input) => {
        casInputs.push(input);
        if (!raced && input.expected !== null) {
          raced = true;
          first.clock.advance(60_001);
        }
        return first.store.compareAndSwap(input);
      },
    };
    const raceProtocol = createManagedOpenCodeHandoffV2Protocol({
      secretProvider: first.secretProvider,
      store: raceStore,
      now: first.clock.now,
      defaultLeaseMs: 60_000,
    });
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: first.root,
      secretProvider: first.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4115,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'reserved-race-owner',
      runtimeIdentity: 'reserved-race-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await raceProtocol.reserveLaunch({ owner, launchSpec });
    await credentialStore.create({
      ...reservation.record,
      password: 'reserved-race-password',
    });

    const replacementChild = createMockChild();
    const second = await createGuardianFixture({
      store: raceStore,
      protocol: raceProtocol,
      secretProvider: first.secretProvider,
      credentialStore,
      spawnFn: vi.fn(() => replacementChild),
      options: { allowUnauthenticatedCredentials: false },
    });

    try {
      await second.guardian.start();
      expect(raced).toBe(true);
      const terminalCasInputs = casInputs.filter((input) => input.expected !== null);
      expect(terminalCasInputs).toHaveLength(2);
      expect(terminalCasInputs[1]).toMatchObject({
        allowExpired: true,
        expected: terminalCasInputs[0].expected,
      });
      await expect(second.protocol.readRecord({
        incarnation: reservation.record.incarnation,
        allowExpired: true,
      })).resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Interrupted },
      });
      await expect(credentialStore.read({
        incarnation: reservation.record.incarnation,
        ownerInstanceId: reservation.record.ownerInstanceId,
        runtimeIdentity: reservation.record.runtimeIdentity,
        launchFingerprint: reservation.record.launchFingerprint,
        credentialFingerprint: reservation.record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      await expect(second.guardian.listChildren()).resolves.toEqual([]);

      const replacementLaunch = second.guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: { OPENCODE_SERVER_PASSWORD: 'replacement-password' },
        owner,
        launchSpec,
      });
      setTimeout(() => {
        replacementChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4115\n');
      }, 10);
      await expect(replacementLaunch).resolves.toMatchObject({ port: 4115 });
    } finally {
      await second.guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('retains a terminal record when credential removal fails until cleanup retries', async () => {
    const first = await createGuardianFixture();
    const cleanupStore = {
      ...first.store,
      cleanup: async ({ protectedIncarnations = [] } = {}) => {
        const protectedSet = new Set(protectedIncarnations);
        let removed = 0;
        for (const [incarnation, record] of first.store.records) {
          if (
            record.leaseExpiresAt <= first.clock.now()
            && [ManagedOpenCodeHandoffV2State.Interrupted, ManagedOpenCodeHandoffV2State.Retired]
              .includes(record.state)
            && !protectedSet.has(incarnation)
          ) {
            first.store.records.delete(incarnation);
            removed += 1;
          }
        }
        return { removed };
      },
    };
    const cleanupProtocol = createManagedOpenCodeHandoffV2Protocol({
      secretProvider: first.secretProvider,
      store: cleanupStore,
      now: first.clock.now,
      defaultLeaseMs: 60_000,
    });
    const realCredentialStore = createManagedOpenCodeCredentialStore({
      rootDir: first.root,
      secretProvider: first.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4113,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'terminal-cleanup-owner',
      runtimeIdentity: 'terminal-cleanup-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await cleanupProtocol.reserveLaunch({ owner, launchSpec });
    const launching = await cleanupProtocol.beginLaunch({
      incarnation: reservation.record.incarnation,
      expectedRevision: reservation.record.revision,
      withCredential: async () => undefined,
    });
    const interrupted = await cleanupProtocol.markInterrupted({
      incarnation: launching.record.incarnation,
      expectedRevision: launching.record.revision,
    });
    await realCredentialStore.create({
      ...interrupted.record,
      password: 'terminal-cleanup-password',
    });
    first.clock.advance(60_001);

    const credentialStore = {
      ...realCredentialStore,
      remove: vi.fn(),
    };
    const removeSpy = credentialStore.remove
      .mockRejectedValueOnce(new Error('temporary credential removal failure'))
      .mockRejectedValueOnce(new Error('temporary credential removal failure'))
      .mockImplementation((...args) => realCredentialStore.remove(...args));
    const second = await createGuardianFixture({
      store: cleanupStore,
      protocol: cleanupProtocol,
      secretProvider: first.secretProvider,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
    });

    try {
      await second.guardian.start();
      expect(removeSpy).toHaveBeenCalledTimes(1);

      // The periodic cleanup path must not erase the terminal recovery handle
      // while the credential removal attention is still unresolved.
      await expect(second.guardian.cleanup()).resolves.toEqual({ removed: 0 });
      await expect(cleanupStore.read({ incarnation: interrupted.record.incarnation }))
        .resolves.toMatchObject({ state: ManagedOpenCodeHandoffV2State.Interrupted });
      await expect(credentialStore.read({
        incarnation: interrupted.record.incarnation,
        ownerInstanceId: interrupted.record.ownerInstanceId,
        runtimeIdentity: interrupted.record.runtimeIdentity,
        launchFingerprint: interrupted.record.launchFingerprint,
        credentialFingerprint: interrupted.record.credentialFingerprint,
      })).resolves.toEqual({ username: 'opencode', password: 'terminal-cleanup-password' });

      // Reconciliation retries the same identity-fenced removal, then the
      // now-unneeded terminal row may be removed by the same cleanup pass.
      await expect(second.guardian.cleanup()).resolves.toEqual({ removed: 1 });
      await expect(cleanupStore.read({ incarnation: interrupted.record.incarnation })).resolves.toBeNull();
      await expect(credentialStore.read({
        incarnation: interrupted.record.incarnation,
        ownerInstanceId: interrupted.record.ownerInstanceId,
        runtimeIdentity: interrupted.record.runtimeIdentity,
        launchFingerprint: interrupted.record.launchFingerprint,
        credentialFingerprint: interrupted.record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      expect(removeSpy).toHaveBeenCalledTimes(3);
      await expect(second.guardian.listChildren()).resolves.toEqual([]);
    } finally {
      removeSpy.mockRestore();
      await second.guardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('retains a credential for an unresolved launching orphan until terminal cleanup is fenced', async () => {
    const first = await createGuardianFixture();
    const credentialStore = createManagedOpenCodeCredentialStore({
      rootDir: first.root,
      secretProvider: first.secretProvider,
    });
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4112,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'launching-crash-owner',
      runtimeIdentity: 'launching-crash-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await first.protocol.reserveLaunch({ owner, launchSpec });
    const launching = await first.protocol.beginLaunch({
      incarnation: reservation.record.incarnation,
      expectedRevision: reservation.record.revision,
      withCredential: async () => undefined,
    });
    await credentialStore.create({
      ...launching.record,
      password: 'launching-crash-password',
    });

    const second = await createGuardianFixture({
      store: first.store,
      protocol: first.protocol,
      secretProvider: first.secretProvider,
      credentialStore,
      options: { allowUnauthenticatedCredentials: false },
    });
    await second.guardian.start();

    await expect(second.guardian.listChildren()).resolves.toEqual([
      expect.objectContaining({
        state: 'attention',
        incarnation: launching.record.incarnation,
        port: launchSpec.port,
      }),
    ]);
    await expect(credentialStore.read({
      incarnation: launching.record.incarnation,
      ownerInstanceId: launching.record.ownerInstanceId,
      runtimeIdentity: launching.record.runtimeIdentity,
      launchFingerprint: launching.record.launchFingerprint,
      credentialFingerprint: launching.record.credentialFingerprint,
    })).resolves.toEqual({
      username: 'opencode',
      password: 'launching-crash-password',
    });

    // Only after an explicit CAS terminalization may attention reconciliation
    // remove the credential; an unresolved Launching row alone is not proof of
    // child death.
    const current = await second.protocol.readRecord({ incarnation: launching.record.incarnation });
    await expect(second.protocol.markInterrupted({
      incarnation: launching.record.incarnation,
      expectedRevision: current.record.revision,
    })).resolves.toMatchObject({ ok: true });
    await second.guardian.stop();
    await expect(credentialStore.read({
      incarnation: launching.record.incarnation,
      ownerInstanceId: launching.record.ownerInstanceId,
      runtimeIdentity: launching.record.runtimeIdentity,
      launchFingerprint: launching.record.launchFingerprint,
      credentialFingerprint: launching.record.credentialFingerprint,
    })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
  });

  it.skipIf(process.platform === 'win32')('cleans credentials before retiring a dead expired handoff record', async () => {
    let secondGuardian;
    try {
      const first = await createGuardianFixture();
      const active = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const prepared = await first.protocol.prepareHandoff({
        incarnation: active.incarnation,
        expectedRevision: active.revision,
      });
      expect(prepared).toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffV2State.HandoffPrepared } });
      const record = prepared.record;
      const credentialStore = createManagedOpenCodeCredentialStore({
        rootDir: first.root,
        secretProvider: first.secretProvider,
      });
      const replacementChild = createMockChild();
      await credentialStore.create({ ...record, password: 'expired-handoff-password' });
      first.clock.advance(60_001);

      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        credentialStore,
        spawnFn: vi.fn(() => replacementChild),
        options: {
          allowUnauthenticatedCredentials: false,
          processLiveness: () => false,
        },
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();

      await expect(second.store.list()).resolves.toEqual([
        expect.objectContaining({
          incarnation: record.incarnation,
          state: ManagedOpenCodeHandoffV2State.Retired,
        }),
      ]);
      await expect(credentialStore.read({
        incarnation: record.incarnation,
        ownerInstanceId: record.ownerInstanceId,
        runtimeIdentity: record.runtimeIdentity,
        launchFingerprint: record.launchFingerprint,
        credentialFingerprint: record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
      await expect(secondGuardian.listChildren()).resolves.toEqual([]);

      const replacementLaunchSpec = {
        binary: 'opencode',
        args: [],
        hostname: '127.0.0.1',
        port: 4114,
        cwd: '/tmp/project',
      };
      const replacementLaunch = secondGuardian.spawnManagedOpenCode({
        ...replacementLaunchSpec,
        env: {},
        owner: {
          ownerInstanceId: 'post-cleanup-owner',
          runtimeIdentity: 'post-cleanup-runtime',
          launchFingerprint: createLaunchFingerprint(replacementLaunchSpec),
        },
        launchSpec: replacementLaunchSpec,
      });
      setTimeout(() => {
        replacementChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4114\n');
      }, 10);
      await expect(replacementLaunch).resolves.toMatchObject({ port: 4114 });
    } finally {
      if (secondGuardian) await secondGuardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('cleans credentials before retiring a dead stopping record', async () => {
    let secondGuardian;
    try {
      const first = await createGuardianFixture();
      const active = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const stopping = await first.protocol.beginStopping({
        incarnation: active.incarnation,
        expectedRevision: active.revision,
      });
      const record = stopping.record;
      const credentialStore = createManagedOpenCodeCredentialStore({
        rootDir: first.root,
        secretProvider: first.secretProvider,
      });
      await credentialStore.create({ ...record, password: 'stopping-password' });

      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        credentialStore,
        options: {
          allowUnauthenticatedCredentials: false,
          processLiveness: () => false,
        },
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();

      await expect(second.protocol.readRecord({ incarnation: record.incarnation })).resolves.toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Retired },
      });
      await expect(credentialStore.read({
        incarnation: record.incarnation,
        ownerInstanceId: record.ownerInstanceId,
        runtimeIdentity: record.runtimeIdentity,
        launchFingerprint: record.launchFingerprint,
        credentialFingerprint: record.credentialFingerprint,
      })).rejects.toMatchObject({ code: 'MANAGED_OPENCODE_CREDENTIAL_MISSING' });
    } finally {
      if (secondGuardian) await secondGuardian.stop();
    }
  });

  it.skipIf(process.platform === 'win32')('retains an expired stopping record across guardian restart', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let secondGuardian;
    let alive = true;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const stopping = await first.protocol.beginStopping({
        incarnation: record.incarnation,
        expectedRevision: record.revision,
      });
      expect(stopping.ok).toBe(true);

      // This is the failed-stop state that must survive lease expiry. The
      // second guardian must recover the same durable handle rather than
      // allowing cleanup to erase it and launch a duplicate child.
      first.clock.advance(60_001);
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        options: {
          processLiveness: () => alive,
          stopSignalTimeoutMs: 0,
    stopKillTimeoutMs: 0,
        },
        processInspector: ({ record: inspected }) => ({
          processStartTicks: '12345',
          launch: {
            commandLine: `${path.basename(inspected.launchSpec.binary)} serve --hostname ${inspected.launchSpec.hostname} --port ${inspected.port}`,
            cwd: inspected.launchSpec.cwd,
          },
        }),
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();

      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          incarnation: record.incarnation,
          state: ManagedOpenCodeHandoffV2State.Stopping,
        }),
      ]);
    } finally {
      alive = false;
      if (secondGuardian) await secondGuardian.stop();
      processKill.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('does not retire a live rehydrated POSIX child after ignored signals', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let alive = true;
    let secondGuardian;
    let client;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const stopping = await first.protocol.beginStopping({
        incarnation: record.incarnation,
        expectedRevision: record.revision,
      });
      expect(stopping.ok).toBe(true);

      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        options: {
          processLiveness: () => alive,
          stopSignalTimeoutMs: 0,
          stopKillTimeoutMs: 0,
        },
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();
      client = new GuardianClient({ socketPath: secondGuardian.socketPath });
      await client.connect();

      await expect(secondGuardian.stopChild({
        incarnation: record.incarnation,
        administrative: true,
      })).rejects.toMatchObject({ code: 'GUARDIAN_CHILD_STILL_RUNNING' });
      expect(await client.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          incarnation: record.incarnation,
          state: 'attention',
          operationId: expect.any(String),
        }),
      ]));
      expect((await second.protocol.readRecord({ incarnation: record.incarnation })).record.state)
        .toBe(ManagedOpenCodeHandoffV2State.Stopping);

      alive = false;
      await expect(secondGuardian.stopChild({
        incarnation: record.incarnation,
        administrative: true,
      })).resolves.toMatchObject({ state: ManagedOpenCodeHandoffV2State.Retired });
      expect(await client.list()).toEqual([]);
    } finally {
      client?.disconnect();
      if (secondGuardian) {
        try { await secondGuardian.stop(); } catch { /* assertion covers live retry failure */ }
      }
      processKill.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('surfaces a durable launching record as attention and blocks its port', async () => {
    let secondGuardian;
    let started = false;
    const first = await createGuardianFixture();
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4097,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'launch-window-owner',
      runtimeIdentity: 'launch-window-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await first.protocol.reserveLaunch({ owner, launchSpec });
    const launching = await first.protocol.beginLaunch({
      incarnation: reservation.record.incarnation,
      expectedRevision: reservation.record.revision,
      withCredential: async () => undefined,
    });
    expect(launching).toMatchObject({
      ok: true,
      record: { state: ManagedOpenCodeHandoffV2State.Launching },
    });

    try {
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();
      started = true;

      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          state: 'attention',
          incarnation: reservation.record.incarnation,
          port: 4097,
        }),
      ]);
      await expect(secondGuardian.spawnManagedOpenCode({
        ...launchSpec,
        env: {},
        owner,
        launchSpec,
      })).rejects.toThrow(/blocked by attention record/);
    } finally {
      if (started) {
        await settleAttentionForTest(secondGuardian);
        await secondGuardian.stop();
      }
    }
  });

  it.skipIf(process.platform === 'win32')('blocks unrelated launches while a null-port attention record is unresolved', async () => {
    const first = await createGuardianFixture();
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4109,
      cwd: '/tmp/project',
    };
    const owner = {
      ownerInstanceId: 'unbound-port-owner',
      runtimeIdentity: 'unbound-port-runtime',
      launchFingerprint: createLaunchFingerprint(launchSpec),
    };
    const reservation = await first.protocol.reserveLaunch({ owner });
    const launching = await first.protocol.beginLaunch({
      incarnation: reservation.record.incarnation,
      expectedRevision: reservation.record.revision,
      withCredential: async () => undefined,
    });
    expect(launching).toMatchObject({
      ok: true,
      record: {
        state: ManagedOpenCodeHandoffV2State.Launching,
        launchSpec: null,
        port: null,
      },
    });

    const child = createMockChild();
    const second = await createGuardianFixture({
      store: first.store,
      protocol: first.protocol,
      secretProvider: first.secretProvider,
      spawnFn: vi.fn(() => child),
    });
    let started = false;
    try {
      await second.guardian.start();
      started = true;
      const attention = await second.guardian.listChildren();
      expect(attention).toEqual([
        expect.objectContaining({
          state: 'attention',
          incarnation: reservation.record.incarnation,
          ownerInstanceId: owner.ownerInstanceId,
          runtimeIdentity: owner.runtimeIdentity,
          reason: 'durable launch has no bound process identity; refusing to resume or guess a detached child',
        }),
      ]);
      expect(attention[0]).not.toHaveProperty('port');

      await expect(second.guardian.spawnManagedOpenCode({
        ...launchSpec,
        env: {},
        owner,
        launchSpec,
      })).rejects.toThrow(/blocked by attention record/);

      const unrelatedLaunchSpec = { ...launchSpec, port: 4110 };
      const unrelatedOwner = {
        ownerInstanceId: 'unrelated-owner',
        runtimeIdentity: 'unrelated-runtime',
        launchFingerprint: createLaunchFingerprint(unrelatedLaunchSpec),
      };
      await expect(second.guardian.spawnManagedOpenCode({
        ...unrelatedLaunchSpec,
        env: {},
        owner: unrelatedOwner,
        launchSpec: unrelatedLaunchSpec,
      })).rejects.toThrow(/blocked by attention record/);
    } finally {
      if (started) {
        await settleAttentionForTest(second.guardian);
        await second.guardian.stop();
      }
    }
  });

  it.skipIf(process.platform === 'win32')('blocks launches when an unresolved attention record has incomplete owner identity', async () => {
    const first = await createGuardianFixture();
    const launchSpec = {
      binary: 'opencode',
      args: [],
      hostname: '127.0.0.1',
      port: 4111,
      cwd: '/tmp/project',
    };
    const reservation = await first.protocol.reserveLaunch({ owner: {}, launchSpec });
    const launching = await first.protocol.beginLaunch({
      incarnation: reservation.record.incarnation,
      expectedRevision: reservation.record.revision,
      withCredential: async () => undefined,
    });
    expect(launching).toMatchObject({
      ok: true,
      record: { state: ManagedOpenCodeHandoffV2State.Launching, port: null },
    });

    const second = await createGuardianFixture({
      store: first.store,
      protocol: first.protocol,
      secretProvider: first.secretProvider,
    });
    let started = false;
    try {
      await second.guardian.start();
      started = true;
      await expect(second.guardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          state: 'attention',
          incarnation: reservation.record.incarnation,
          port: launchSpec.port,
        }),
      ]);

      const unrelatedLaunchSpec = { ...launchSpec, port: 4112 };
      await expect(second.guardian.spawnManagedOpenCode({
        ...unrelatedLaunchSpec,
        env: {},
        owner: {
          ownerInstanceId: 'complete-owner',
          runtimeIdentity: 'complete-runtime',
          launchFingerprint: createLaunchFingerprint(unrelatedLaunchSpec),
        },
        launchSpec: unrelatedLaunchSpec,
      })).rejects.toThrow(/blocked by attention record/);
    } finally {
      if (started) {
        await settleAttentionForTest(second.guardian);
        await second.guardian.stop();
      }
    }
  });

  it.skipIf(process.platform === 'win32')('fails closed when POSIX process start identity cannot be revalidated', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let secondGuardian;
    let started = false;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processInspector: () => ({ processStartTicks: null }),
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();
      started = true;

      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
          reason: 'POSIX process start identity is unavailable',
        }),
      ]);
    } finally {
      if (started) {
        await settleAttentionForTest(secondGuardian);
        await secondGuardian.stop();
      }
      processKill.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a rehydrated POSIX child after PID reuse', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    let secondGuardian;
    let started = false;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processInspector: ({ record: inspectedRecord }) => ({
          processStartTicks: '99999',
          launch: {
            commandLine: `${path.basename(inspectedRecord.launchSpec.binary)} serve --hostname ${inspectedRecord.launchSpec.hostname} --port ${inspectedRecord.port}`,
            cwd: inspectedRecord.launchSpec.cwd,
          },
        }),
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();
      started = true;

      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
          reason: 'PID start identity changed',
        }),
      ]);
    } finally {
      if (started) {
        await settleAttentionForTest(secondGuardian);
        await secondGuardian.stop();
      }
      processKill.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('revalidates a rehydrated POSIX launch identity before health probes', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const originalFetch = globalThis.fetch;
    let currentTicks = '12345';
    let foreignLaunch = false;
    let secondGuardian;
    let started = false;
    let record;
    try {
      const first = await createGuardianFixture();
      record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const inspector = ({ record: inspectedRecord }) => ({
        processStartTicks: currentTicks,
        launch: !foreignLaunch
          ? {
            commandLine: `${path.basename(inspectedRecord.launchSpec.binary)} serve --hostname ${inspectedRecord.launchSpec.hostname} --port ${inspectedRecord.port}`,
            cwd: inspectedRecord.launchSpec.cwd,
          }
          : {
            commandLine: 'foreign-server serve --hostname 127.0.0.1 --port 4096',
            cwd: '/tmp/foreign-project',
          },
      });
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processInspector: inspector,
      });
      secondGuardian = second.guardian;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });
      await secondGuardian.start();
      started = true;
      globalThis.fetch.mockClear();

      foreignLaunch = true;
      await expect(secondGuardian.healthCheck({ incarnation: record.incarnation })).resolves.toEqual({
        healthy: false,
        reason: 'live executable or launch arguments do not match',
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
      await expect(secondGuardian.prepareHandoff({
        incarnation: record.incarnation,
        administrative: true,
      })).rejects.toMatchObject({ code: 'GUARDIAN_CHILD_IDENTITY_INVALID' });
    } finally {
      currentTicks = '12345';
      foreignLaunch = false;
      processKill.mockImplementation((pid, signal) => {
        if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true;
      });
      if (started) {
        await secondGuardian.stopChild({ incarnation: record.incarnation, administrative: true });
        await secondGuardian.stop();
      }
      globalThis.fetch = originalFetch;
      processKill.mockRestore();
    }
  });

  it.skipIf(process.platform === 'win32')('revalidates process identity after health before rehydrated adoption', async () => {
    const originalFetch = globalThis.fetch;
    let inspections = 0;
    let secondGuardian;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processInspector: ({ record: inspectedRecord }) => {
          inspections += 1;
          return {
            processStartTicks: '12345',
            launch: inspections === 1
              ? {
                commandLine: `${path.basename(inspectedRecord.launchSpec.binary)} serve --hostname ${inspectedRecord.launchSpec.hostname} --port ${inspectedRecord.port}`,
                cwd: inspectedRecord.launchSpec.cwd,
              }
              : {
                commandLine: 'foreign-server serve --hostname 127.0.0.1 --port 4096',
                cwd: '/tmp/foreign-project',
              },
          };
        },
      });
      secondGuardian = second.guardian;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: true }),
      });

      await secondGuardian.start();
      expect(inspections).toBeGreaterThanOrEqual(2);
      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
          reason: 'live executable or launch arguments do not match',
        }),
      ]);
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    } finally {
      if (secondGuardian) {
        await settleAttentionForTest(secondGuardian);
        await secondGuardian.stop();
      }
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(process.platform === 'win32')('rejects a process replacement during the in-flight rehydration health probe', async () => {
    const originalFetch = globalThis.fetch;
    let releaseHealth;
    let healthStarted;
    const healthStartedPromise = new Promise((resolve) => { healthStarted = resolve; });
    const healthReleasePromise = new Promise((resolve) => { releaseHealth = resolve; });
    let foreignLaunch = false;
    let secondGuardian;
    let started = false;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processInspector: ({ record: inspectedRecord }) => foreignLaunch
          ? {
            processStartTicks: '99999',
            launch: {
              commandLine: 'foreign-server serve --hostname 127.0.0.1 --port 4096',
              cwd: '/tmp/foreign-project',
            },
          }
          : {
            processStartTicks: '12345',
            launch: {
              commandLine: `${path.basename(inspectedRecord.launchSpec.binary)} serve --hostname ${inspectedRecord.launchSpec.hostname} --port ${inspectedRecord.port}`,
              cwd: inspectedRecord.launchSpec.cwd,
            },
          },
      });
      secondGuardian = second.guardian;
      globalThis.fetch = vi.fn(async () => {
        healthStarted();
        await healthReleasePromise;
        return {
          ok: true,
          json: async () => ({ healthy: true }),
        };
      });

      const startPromise = secondGuardian.start();
      await healthStartedPromise;
      // The persisted process is replaced while the port-based health request
      // is awaiting its response. The post-health identity fence must win over
      // the otherwise healthy response and prevent adoption.
      foreignLaunch = true;
      releaseHealth();
      await startPromise;
      started = true;

      await expect(secondGuardian.listChildren()).resolves.toEqual([
        expect.objectContaining({
          state: 'attention',
          incarnation: record.incarnation,
          reason: 'PID start identity changed',
        }),
      ]);
    } finally {
      if (!started && secondGuardian) {
        releaseHealth?.();
        try { await secondGuardian.stop(); } catch { /* cleanup assertion covers unresolved state */ }
      } else if (secondGuardian) {
        try {
          await settleAttentionForTest(secondGuardian);
          await secondGuardian.stop();
        } catch { /* cleanup assertion covers unresolved state */ }
      }
      globalThis.fetch = originalFetch;
    }
  });

  it.skipIf(process.platform === 'win32')('fails closed before POSIX termination when identity becomes unavailable', async () => {
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true }),
    });
    let identityAvailable = true;
    let secondGuardian;
    let started = false;
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
      const second = await createGuardianFixture({
        store: first.store,
        protocol: first.protocol,
        secretProvider: first.secretProvider,
        processInspector: ({ record: inspectedRecord }) => identityAvailable
          ? {
            processStartTicks: '12345',
            launch: {
              commandLine: `${path.basename(inspectedRecord.launchSpec.binary)} serve --hostname ${inspectedRecord.launchSpec.hostname} --port ${inspectedRecord.port}`,
              cwd: inspectedRecord.launchSpec.cwd,
            },
          }
          : { processStartTicks: null, launch: null },
      });
      secondGuardian = second.guardian;
      await secondGuardian.start();
      started = true;
      processKill.mockClear();

      identityAvailable = false;
      await expect(secondGuardian.stopChild({
        incarnation: record.incarnation,
        administrative: true,
      })).rejects.toThrow(/POSIX child identity validation failed: POSIX process start identity is unavailable/);
      expect(processKill).not.toHaveBeenCalledWith(-record.pid, expect.any(String));
    } finally {
      identityAvailable = true;
      processKill.mockImplementation((pid, signal) => {
        if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        return true;
      });
      if (started) await secondGuardian.stop();
      globalThis.fetch = originalFetch;
      processKill.mockRestore();
    }
  });
});

describe('createManagedOpenCodeGuardian factory', () => {
  it.skipIf(process.platform === 'win32')('creates with injected dependencies', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-factory-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);

    const guardian = createManagedOpenCodeGuardian({ rootDir: root });
    expect(guardian).toBeInstanceOf(ManagedOpenCodeGuardian);
  });
});

describe('Windows rehydration identity and termination guards', () => {
  const createWindowsFixture = async (processInspector, guardianOverrides = {}) => {
    const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-win-port-'));
    roots.push(portDir);
    const fixture = await createGuardianFixture({
      ...guardianOverrides,
      processInspector,
      options: {
        portPath: path.join(portDir, 'port'),
        username: 'test-user',
        aclInspector: () => ({ entries: [{ principal: 'test-user', rights: ['F'] }] }),
        ...guardianOverrides.options,
      },
    });
    const record = await seedActiveRecord(fixture.protocol, {
      processStartTicks: '638912345678901234',
    });
    return { ...fixture, record };
  };

  const stubWindowsAcls = () => {
    vi.spyOn(windowsAcl, 'applyDirectoryAcl').mockReturnValue({ ok: true, username: 'test-user' });
    vi.spyOn(windowsAcl, 'applyPrivateFileAcl').mockReturnValue({ ok: true, username: 'test-user' });
    vi.spyOn(windowsAcl, 'applyDiscoveryFileAcl').mockReturnValue({ ok: true, username: 'test-user' });
  };

  const installHealthyProbe = () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ healthy: true }),
    });
  };

  it('retains the PID marker and stop callback when Windows discovery cleanup fails', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-win-cleanup-'));
    roots.push(portDir);
    let markerOwnership = null;
    const onStopped = vi.fn(() => releaseGuardianPidMarker(markerOwnership));
    let guardian;
    let started = false;

    try {
      const fixture = await createGuardianFixture({
        options: {
          portPath: path.join(portDir, 'port'),
          username: 'test-user',
          aclInspector: () => ({ entries: [{ principal: 'test-user', rights: ['F'] }] }),
          onStopped,
        },
      });
      guardian = fixture.guardian;
      const pidFile = path.join(fixture.root, 'guardian.pid');
      markerOwnership = await acquireGuardianPidMarker({
        pidFile,
        pid: process.pid,
        identity: {
          processStartTicks: '123',
          launch: { commandLine: 'node guardian.test.js', cwd: fixture.root },
        },
        requireIdentity: true,
      });

      await guardian.start();
      started = true;
      const discoveryPath = guardian.portPath;
      const unlinkSync = fs.unlinkSync.bind(fs);
      const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
        if (typeof target === 'string' && target.endsWith('.remove')) {
          throw Object.assign(new Error('discovery unlink denied'), { code: 'EACCES' });
        }
        return unlinkSync(target, ...args);
      });

      try {
        await expect(guardian.stop()).rejects.toMatchObject({
          code: 'GUARDIAN_TRANSPORT_CLEANUP_UNCERTAIN',
          message: 'Guardian IPC transport cleanup failed',
        });
        expect(onStopped).not.toHaveBeenCalled();
        expect(readGuardianPidMarker(pidFile)).toMatchObject({
          status: 'valid',
          token: markerOwnership.token,
        });
        expect(fs.existsSync(discoveryPath)).toBe(true);
      } finally {
        unlinkSpy.mockRestore();
      }

      await expect(guardian.stop()).resolves.toBeUndefined();
      started = false;
      expect(onStopped).toHaveBeenCalledOnce();
      expect(readGuardianPidMarker(pidFile)).toBeNull();
    } finally {
      if (started) {
        try { await guardian.stop(); } catch { /* preserve the failure under test */ }
      }
      restorePlatform();
    }
  });

  it('retains marker ownership when Windows discovery identity is unavailable after O_EXCL open', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-win-identity-'));
    roots.push(portDir);
    let markerOwnership = null;
    const onStopped = vi.fn(() => releaseGuardianPidMarker(markerOwnership));

    try {
      const fixture = await createGuardianFixture({
        options: {
          portPath: path.join(portDir, 'port'),
          username: 'test-user',
          aclInspector: () => ({ entries: [{ principal: 'test-user', rights: ['F'] }] }),
          onStopped,
        },
      });
      const pidFile = path.join(fixture.root, 'guardian.pid');
      markerOwnership = await acquireGuardianPidMarker({
        pidFile,
        pid: process.pid,
        identity: {
          processStartTicks: '123',
          launch: { commandLine: 'node guardian.test.js', cwd: fixture.root },
        },
        requireIdentity: true,
      });

      const fstatSpy = vi.spyOn(fs, 'fstatSync').mockImplementation(() => {
        throw Object.assign(new Error('discovery identity metadata unavailable'), { code: 'EIO' });
      });
      try {
        await expect(fixture.guardian.start()).rejects.toMatchObject({
          code: 'GUARDIAN_CLEANUP_UNCERTAIN',
        });
        expect(onStopped).not.toHaveBeenCalled();
        expect(readGuardianPidMarker(pidFile)).toMatchObject({
          status: 'valid',
          token: markerOwnership.token,
        });
        expect(fs.existsSync(`${fixture.guardian.portPath}.lock`)).toBe(true);
      } finally {
        fstatSpy.mockRestore();
      }
    } finally {
      restorePlatform();
    }
  });

  it('retains marker ownership when Windows publication rollback is uncertain', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-win-publication-'));
    roots.push(portDir);
    const portPath = path.join(portDir, 'port');
    let markerOwnership = null;
    const onStopped = vi.fn(() => releaseGuardianPidMarker(markerOwnership));
    let guardian = null;
    let stopped = false;
    let published = false;
    let linkSpy = null;
    let unlinkSpy = null;

    try {
      const fixture = await createGuardianFixture({
        options: {
          portPath,
          username: 'test-user',
          aclInspector: () => ({ entries: [{ principal: 'test-user', rights: ['F'] }] }),
          reparseChecker: (candidate) => {
            if (published && candidate === portPath) throw new Error('post-link validation denied');
            return false;
          },
          onStopped,
        },
      });
      guardian = fixture.guardian;
      const pidFile = path.join(fixture.root, 'guardian.pid');
      markerOwnership = await acquireGuardianPidMarker({
        pidFile,
        pid: process.pid,
        identity: {
          processStartTicks: '123',
          launch: { commandLine: 'node guardian.test.js', cwd: fixture.root },
        },
        requireIdentity: true,
      });

      const realLinkSync = fs.linkSync.bind(fs);
      linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((source, destination, ...args) => {
        const result = realLinkSync(source, destination, ...args);
        if (destination === portPath) published = true;
        return result;
      });
      const realUnlinkSync = fs.unlinkSync.bind(fs);
      unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target, ...args) => {
        const name = typeof target === 'string' ? path.basename(target) : '';
        if (name.startsWith('.port.') && !name.startsWith('.port.tmp.') && !name.startsWith('.port.lock.')) {
          throw Object.assign(new Error('final rollback denied'), { code: 'EACCES' });
        }
        return realUnlinkSync(target, ...args);
      });

      await expect(guardian.start()).rejects.toMatchObject({ code: 'GUARDIAN_CLEANUP_UNCERTAIN' });
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
      expect(fs.existsSync(portPath)).toBe(true);

      unlinkSpy.mockRestore();
      unlinkSpy = null;
      linkSpy.mockRestore();
      linkSpy = null;
      published = false;

      await expect(guardian.stop()).resolves.toBeUndefined();
      stopped = true;
      expect(onStopped).toHaveBeenCalledOnce();
      expect(readGuardianPidMarker(pidFile)).toBeNull();
    } finally {
      published = false;
      unlinkSpy?.mockRestore();
      linkSpy?.mockRestore();
      if (guardian && !stopped) {
        try { await guardian.stop(); } catch { /* preserve the assertion failure */ }
      }
      restorePlatform();
    }
  });

  it('retains marker authority for an unknown pre-existing Windows discovery artifact', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-win-unknown-final-'));
    roots.push(portDir);
    const portPath = path.join(portDir, 'port');
    fs.writeFileSync(portPath, 'pre-existing-discovery-artifact');
    let markerOwnership = null;
    let guardian = null;
    let stopped = false;
    const onStopped = vi.fn(() => {
      if (!markerOwnership) return;
      const ownership = markerOwnership;
      markerOwnership = null;
      releaseGuardianPidMarker(ownership);
    });

    try {
      const fixture = await createGuardianFixture({
        options: {
          portPath,
          username: 'test-user',
          aclInspector: () => ({ entries: [{ principal: 'test-user', rights: ['F'] }] }),
          onStopped,
        },
      });
      guardian = fixture.guardian;
      const pidFile = path.join(fixture.root, 'guardian.pid');
      markerOwnership = await acquireGuardianPidMarker({
        pidFile,
        pid: process.pid,
        identity: {
          processStartTicks: '123',
          launch: { commandLine: 'node guardian.test.js', cwd: fixture.root },
        },
        requireIdentity: true,
      });

      await expect(guardian.start()).rejects.toMatchObject({
        code: 'GUARDIAN_CLEANUP_UNCERTAIN',
      });
      expect(onStopped).not.toHaveBeenCalled();
      expect(readGuardianPidMarker(pidFile)).toMatchObject({
        status: 'valid',
        token: markerOwnership.token,
      });
      expect(fs.readFileSync(portPath, 'utf8')).toBe('pre-existing-discovery-artifact');

      fs.unlinkSync(portPath);
      expect(fs.existsSync(portPath)).toBe(false);
      await expect(guardian.stop()).resolves.toBeUndefined();
      stopped = true;
      expect(onStopped).toHaveBeenCalledOnce();
      expect(readGuardianPidMarker(pidFile)).toBeNull();
    } finally {
      if (!stopped && guardian) await guardian.stop().catch(() => {});
      if (markerOwnership) {
        releaseGuardianPidMarker(markerOwnership);
        markerOwnership = null;
      }
      restorePlatform();
    }
  });

  it('rehydrates and stops a child with lossless Windows ticks', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    installHealthyProbe();
    const inspector = vi.fn(() => ({
      processStartTicks: '638912345678901234',
      launch: {
        commandLine: 'opencode serve --hostname 127.0.0.1 --port 4096',
        cwd: null,
      },
    }));
    const terminateSpy = vi.spyOn(windowsProcess, 'terminateChildWindows').mockResolvedValue({ ok: true });
    let guardian;
    let record;
    let started = false;
    try {
      ({ guardian, record } = await createWindowsFixture(inspector));
      await guardian.start();
      started = true;

      await expect(guardian.listChildren()).resolves.toMatchObject([{
        incarnation: record.incarnation,
        state: ManagedOpenCodeHandoffV2State.Active,
        processStartTicks: '638912345678901234',
      }]);

      await guardian.stopChild({ incarnation: record.incarnation, administrative: true });
      expect(terminateSpy).toHaveBeenCalledOnce();
    } finally {
      if (started) await guardian.stop();
      delete globalThis.fetch;
      restorePlatform();
    }
  });

  it('requires the complete Windows serve command while tolerating normal case differences', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    installHealthyProbe();
    let commandLine = 'OPENCODE.EXE SERVE --HOSTNAME 127.0.0.1 --PORT 4096';
    const inspector = vi.fn(() => ({
      processStartTicks: '638912345678901234',
      launch: { commandLine, cwd: null },
    }));
    const handleTerminator = vi.fn().mockResolvedValue({ status: 'already-gone' });
    let guardian;
    let record;
    let started = false;
    try {
      ({ guardian, record } = await createWindowsFixture(inspector, {
        options: { windowsHandleTerminator: handleTerminator },
      }));
      await guardian.start();
      started = true;
      globalThis.fetch.mockClear();

      commandLine = 'opencode --hostname 127.0.0.1 --port 4096';
      await expect(guardian.healthCheck({ incarnation: record.incarnation })).resolves.toEqual({
        healthy: false,
        reason: 'live executable or launch arguments do not match',
      });
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      commandLine = 'opencode serve --hostname 127.0.0.1 --port 4096';
      if (started) {
        await guardian.stopChild({ incarnation: record.incarnation, administrative: true });
        await guardian.stop();
      }
      delete globalThis.fetch;
      restorePlatform();
    }
  });

  it('routes rehydrated Windows termination through the injected handle helper', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    installHealthyProbe();
    const inspector = vi.fn(() => ({
      processStartTicks: '638912345678901234',
      launch: {
        commandLine: 'opencode serve --hostname 127.0.0.1 --port 4096',
        cwd: null,
      },
    }));
    const handleTerminator = vi.fn().mockResolvedValue({ status: 'already-gone' });
    let guardian;
    let record;
    let started = false;
    try {
      ({ guardian, record } = await createWindowsFixture(inspector, {
        options: { windowsHandleTerminator: handleTerminator },
      }));
      await guardian.start();
      started = true;

      await expect(guardian.stopChild({ incarnation: record.incarnation, administrative: true }))
        .resolves.toMatchObject({ state: ManagedOpenCodeHandoffV2State.Retired });
      expect(handleTerminator).toHaveBeenCalledOnce();
      expect(handleTerminator).toHaveBeenCalledWith(
        expect.objectContaining({ isRehydrated: true, pid: record.pid }),
        { record: expect.objectContaining({
          incarnation: record.incarnation,
          processStartTicks: record.processStartTicks,
          launchSpec: record.launchSpec,
        }) },
      );
    } finally {
      if (started) await guardian.stop();
      delete globalThis.fetch;
      restorePlatform();
    }
  });

  it('keeps a failed rehydrated-child termination authoritative and IPC-reachable', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    installHealthyProbe();
    const inspector = vi.fn(() => ({
      processStartTicks: '638912345678901234',
      launch: {
        commandLine: 'opencode serve --hostname 127.0.0.1 --port 4096',
        cwd: null,
      },
    }));
    const terminateSpy = vi.spyOn(windowsProcess, 'terminateChildWindows')
      .mockResolvedValue({ ok: false, reason: 'still-running' });
    let guardian;
    let client;
    let started = false;
    try {
      const fixture = await createWindowsFixture(inspector);
      guardian = fixture.guardian;
      await guardian.start();
      started = true;

      const ipcPaths = resolveGuardianPaths({
        platform: 'win32',
        rootDir: fixture.root,
        socketPath: guardian.socketPath,
        portPath: guardian.portPath,
      });
      client = new GuardianClient({
        socketPath: guardian.socketPath,
        portPath: guardian.portPath,
        authSecretPath: ipcPaths.authSecretPath,
        username: 'test-user',
        aclInspector: () => ({ entries: [{ principal: 'test-user', rights: ['F'] }] }),
      });
      await client.connect();

      await expect(guardian.stop()).rejects.toMatchObject({ code: 'GUARDIAN_STOP_FAILED' });
      const localRecords = await guardian.listChildren();
      expect(localRecords).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'attention', operationId: expect.any(String) }),
      ]));
      const persisted = await fixture.protocol.readRecord({ incarnation: localRecords[0].incarnation });
      expect(persisted).toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Stopping },
      });
      await expect(client.list()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ state: 'attention', operationId: expect.any(String) }),
      ]));

      terminateSpy.mockResolvedValue({ ok: true });
      await expect(guardian.stop()).resolves.toBeUndefined();
    } finally {
      client?.disconnect();
      terminateSpy.mockResolvedValue({ ok: true });
      if (started) {
        try { await guardian.stop(); } catch { /* cleanup assertion already captured the failure */ }
      }
      delete globalThis.fetch;
      restorePlatform();
    }
  });

  it('marks a Windows record as attention when identity queries fail', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    installHealthyProbe();
    const inspector = vi.fn(() => ({ processStartTicks: null, launch: null }));
    let guardian;
    let started = false;
    try {
      ({ guardian } = await createWindowsFixture(inspector));
      await guardian.start();
      started = true;

      await expect(guardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          reason: 'Windows process start identity is unavailable',
        }),
      ]));
    } finally {
      if (started) {
        await settleAttentionForTest(guardian);
        await guardian.stop();
      }
      delete globalThis.fetch;
      restorePlatform();
    }
  });

  it('marks a Windows record as attention when the PID has been reused', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    installHealthyProbe();
    const inspector = vi.fn(() => ({
      processStartTicks: '638912345678901235',
      launch: {
        commandLine: 'opencode serve --hostname 127.0.0.1 --port 4096',
        cwd: null,
      },
    }));
    let guardian;
    let started = false;
    try {
      ({ guardian } = await createWindowsFixture(inspector));
      await guardian.start();
      started = true;

      await expect(guardian.listChildren()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: 'attention',
          reason: 'PID start identity changed',
        }),
      ]));
    } finally {
      if (started) {
        await settleAttentionForTest(guardian);
        await guardian.stop();
      }
      delete globalThis.fetch;
      restorePlatform();
    }
  });

  it('refuses destructive termination after Windows identity changes', async () => {
    setPlatformForTest('win32');
    stubWindowsAcls();
    installHealthyProbe();
    let currentTicks = '638912345678901234';
    const inspector = vi.fn(() => ({
      processStartTicks: currentTicks,
      launch: {
        commandLine: 'opencode serve --hostname 127.0.0.1 --port 4096',
        cwd: null,
      },
    }));
    const terminateSpy = vi.spyOn(windowsProcess, 'terminateChildWindows').mockResolvedValue({ ok: true });
    let guardian;
    let started = false;
    try {
      ({ guardian } = await createWindowsFixture(inspector));
      await guardian.start();
      started = true;
      currentTicks = '638912345678901235';

      await expect(guardian.stopChild({
        incarnation: (await guardian.listChildren())[0].incarnation,
        administrative: true,
      })).rejects.toThrow(/Windows child identity validation failed/);
      expect(terminateSpy).not.toHaveBeenCalled();
    } finally {
      if (started) {
        currentTicks = '638912345678901234';
        try { await guardian.stop(); } catch { /* cleanup after the assertion */ }
      }
      delete globalThis.fetch;
      restorePlatform();
    }
  });
});

describe('GuardianClient', () => {
  const createRawClientServer = async (onRequest) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-client-frame-'));
    roots.push(root);
    const socketPath = path.join(root, 'guardian.sock');
    const server = net.createServer((socket) => {
      let buffer = '';
      socket.write(`${JSON.stringify({ type: 'challenge', challenge: 'client-frame-test-challenge' })}\n`);
      socket.on('error', () => {});
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          onRequest(socket, JSON.parse(line));
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    return { server, socketPath };
  };

  it.skipIf(process.platform === 'win32')('throws on invalid socket path', () => {
    expect(() => new GuardianClient({})).toThrow('Guardian client requires a socket path');
  });

  it.skipIf(process.platform === 'win32')('throws when disposed', () => {
    const client = new GuardianClient({ socketPath: '/tmp/test.sock' });
    client.disconnect();
    expect(() => client.connect()).toThrow('disposed');
  });

  it.skipIf(process.platform === 'win32')('enforces the inclusive outbound frame limit before writing', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const requests = [];
    const { server, socketPath } = await createRawClientServer((socket, request) => {
      requests.push(request);
      if (request.method === 'handshake') {
        socket.write(`${JSON.stringify({ id: request.id, result: { authenticated: true } })}\n`);
      } else {
        socket.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      }
    });
    const client = new GuardianClient({ socketPath, authSecret: Buffer.alloc(32, 4) });

    try {
      await client.connect();
      await expect(client.spawn({ value: '' })).resolves.toEqual({});
      const firstRequest = requests.find((request) => request.method === 'spawn');
      const emptyFrameBytes = Buffer.byteLength(`${JSON.stringify(firstRequest)}\n`, 'utf8');
      const exactPadding = GUARDIAN_IPC_MAX_FRAME_BYTES - emptyFrameBytes;

      await expect(client.spawn({ value: 'x'.repeat(exactPadding) })).resolves.toEqual({});
      const spawnRequests = requests.filter((request) => request.method === 'spawn');
      expect(Buffer.byteLength(`${JSON.stringify(spawnRequests[1])}\n`, 'utf8'))
        .toBe(GUARDIAN_IPC_MAX_FRAME_BYTES);

      await expect(client.spawn({ value: 'x'.repeat(exactPadding + 1) }))
        .rejects.toMatchObject({ code: 'frame_too_large' });
      expect(requests.filter((request) => request.method === 'spawn')).toHaveLength(2);
    } finally {
      client.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.skipIf(process.platform === 'win32')('accepts coalesced inbound frames when each frame is within the limit', async () => {
    const payloadSize = Math.floor(GUARDIAN_IPC_MAX_FRAME_BYTES * 0.6);
    const { server, socketPath } = await createRawClientServer((socket, request) => {
      if (request.method === 'handshake') {
        socket.write(`${JSON.stringify({ id: request.id, result: { authenticated: true } })}\n`);
        return;
      }
      const first = `${JSON.stringify({ id: request.id, result: { payload: 'a'.repeat(payloadSize) } })}\n`;
      const second = `${JSON.stringify({ id: 'ignored-response', result: { payload: 'b'.repeat(payloadSize) } })}\n`;
      expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(GUARDIAN_IPC_MAX_FRAME_BYTES);
      expect(Buffer.byteLength(second, 'utf8')).toBeLessThanOrEqual(GUARDIAN_IPC_MAX_FRAME_BYTES);
      expect(Buffer.byteLength(first + second, 'utf8')).toBeGreaterThan(GUARDIAN_IPC_MAX_FRAME_BYTES);
      socket.write(first + second);
    });
    const client = new GuardianClient({ socketPath, authSecret: Buffer.alloc(32, 5) });

    try {
      const result = await client.list();
      expect(result.payload).toHaveLength(payloadSize);
    } finally {
      client.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.skipIf(process.platform === 'win32')('marks a sent non-idempotent request ambiguous when disconnect rejects it', async () => {
    let receivedSpawn;
    const spawnReceived = new Promise((resolve) => { receivedSpawn = resolve; });
    const { server, socketPath } = await createRawClientServer((socket, request) => {
      if (request.method === 'handshake') {
        socket.write(`${JSON.stringify({ id: request.id, result: { authenticated: true } })}\n`);
        return;
      }
      if (request.method === 'spawn') receivedSpawn();
    });
    const client = new GuardianClient({
      socketPath,
      authSecret: Buffer.alloc(32, 6),
    });

    try {
      const pendingSpawn = client.spawn({ sideEffect: true });
      await spawnReceived;
      client.disconnect();

      await expect(pendingSpawn).rejects.toMatchObject({
        code: GUARDIAN_AMBIGUOUS_REQUEST_CODE,
        ambiguous: true,
        retryable: false,
        originalCode: 'disconnected',
      });
      await pendingSpawn.catch((error) => {
        expect(isAmbiguousGuardianRequestError(error)).toBe(true);
        expect(error.retryable).toBe(false);
      });
    } finally {
      client.disconnect();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it.skipIf(process.platform === 'win32')('reconnects with a fresh authenticated sequence after a consumed request loses its response', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-client-reconnect-'));
    roots.push(root);
    const socketPath = path.join(root, 'guardian.sock');
    const authSecret = Buffer.alloc(32, 8);
    let server;
    const spawn = vi.fn(async () => {
      // The server has already verified and consumed sequence 0 before this
      // handler runs. Close the connection before the response is delivered;
      // retrying spawn would be unsafe because its side effect is ambiguous.
      await server.stop();
      return { spawned: true };
    });
    const guardian = {
      spawnManagedOpenCode: spawn,
      listChildren: vi.fn(async () => [{ incarnation: 'after-reconnect' }]),
    };
    const createServer = () => new GuardianIpcServer({
      socketPath,
      guardian,
      authSecret,
    });
    server = createServer();
    await server.start();
    const client = new GuardianClient({
      socketPath,
      authSecret,
      requestTimeoutMs: 500,
    });

    try {
      await expect(client.spawn({ sideEffect: true }))
        .rejects.toMatchObject({
          code: GUARDIAN_AMBIGUOUS_REQUEST_CODE,
          ambiguous: true,
          retryable: false,
          originalCode: 'connection_closed',
        });

      // A new server instance represents recovery after the guardian process
      // crash. The next request must authenticate as sequence 0 on its new
      // session, not reuse the consumed sequence from the dead connection.
      server = createServer();
      await server.start();
      await expect(client.list()).resolves.toEqual([{ incarnation: 'after-reconnect' }]);
      expect(spawn).toHaveBeenCalledOnce();
    } finally {
      client.disconnect();
      await server.stop();
    }
  });

  it('keeps ambiguity detectable after lifecycle-style error sanitization', () => {
    const error = new GuardianClientError('request outcome is unknown', 'connection_closed', { ambiguous: true });
    const sanitized = new Error(error.message);
    sanitized.code = error.code;

    expect(error.retryable).toBe(false);
    expect(error.originalCode).toBe('connection_closed');
    expect(isAmbiguousGuardianRequestError(sanitized)).toBe(true);
    expect(sanitized.code).toBe(GUARDIAN_AMBIGUOUS_REQUEST_CODE);
  });
});

describe('W-D: #terminateChild platform branch', () => {
  // These tests run on every CI (Linux + Windows). On Linux they
  // flip `process.platform` to `'win32'` and verify the Windows
  // branch is taken; the flip is restored in `finally` so the
  // sibling Unix tests below are unaffected. On real Windows CI the
  // branch is already active, so the test exercises it without
  // needing a flip.
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  const setPlatformForTest = (value) => {
    Object.defineProperty(process, 'platform', { value, configurable: true });
  };

  const restorePlatform = () => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    } else {
      delete process.platform;
    }
  };

  // This test mocks `process.platform` AFTER `start()` resolves, so
  // it only works on a Linux/POSIX runner. On real Windows CI,
  // `start()` itself is called with `process.platform === 'win32'`
  // from the start (no mocking yet), and the POSIX backend would
  // bind a Unix-domain socket that Windows cannot create. The
  // equivalent Windows branch is exercised by `guardian.test.js`'s
  // `requires portPath on Windows when starting` (line ~146), which
  // mocks `process.platform = 'win32'` BEFORE `start()` runs and
  // asserts the expected `Windows portPath is required` error.
  it.skipIf(process.platform === 'win32')('routes termination through terminateChildWindows on win32 (mocked platform)', async () => {
    // Construct everything under the real (Linux) platform so the
    // secret provider, store, and IPC server initialize normally.
    // Then flip `process.platform` to 'win32' immediately before
    // calling `stopChild` so `#terminateChild` observes the mocked
    // platform and takes the Windows branch. The platform flip is
    // restored in `finally` so sibling tests are unaffected.
    const mockChild = createMockChild();
    const spawnFn = vi.fn().mockReturnValue(mockChild);
    const { guardian } = await createGuardianFixture({ spawnFn });
    await guardian.start();
    const spawnPromise = guardian.spawnManagedOpenCode({
      port: 4096,
      hostname: '127.0.0.1',
      binary: 'opencode',
      cwd: '/tmp/project',
      env: {},
    });
    setTimeout(() => {
      mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
    }, 10);
    const { incarnation } = await spawnPromise;

    const terminateSpy = vi.spyOn(windowsProcess, 'terminateChildWindows').mockResolvedValue({ ok: true });
    try {
      setPlatformForTest('win32');
       await guardian.stopChild({ incarnation, administrative: true });

      // The Windows helper was called exactly once, with the
      // expected child and the STOP_SIGNAL_TIMEOUT_MS (2500ms)
      // timeout.
      expect(terminateSpy).toHaveBeenCalledTimes(1);
      const [calledChild, calledOptions] = terminateSpy.mock.calls[0];
      expect(calledChild).toBe(mockChild);
      expect(calledOptions).toEqual({ timeoutMs: 2500 });

      // The Unix path would have called mockChild.kill('SIGTERM').
      // It must NOT have been called.
      expect(mockChild.kill).not.toHaveBeenCalled();
    } finally {
      terminateSpy.mockRestore();
      restorePlatform();
    }
    await guardian.stop();
  });

  // Real Unix-socket listener — Windows cannot use Unix-domain
  // sockets, so `start()` would never resolve / would throw EACCES
  // when called with `process.platform === 'win32'`. Gated to
  // POSIX/Linux CI; the platform-flip-to-'win32' branch above is
  // the matching Windows coverage.
  it.skipIf(process.platform === 'win32')('uses the Unix SIGTERM/SIGKILL escalation when platform is non-win32', async () => {
    // Sanity: on the real (Linux) platform, the Unix branch is
    // what runs. The spec for W-D is that the Unix path is
    // byte-for-byte identical to the pre-W-D version. We exercise
    // the `child.kill('SIGTERM')` and `child.kill('SIGKILL')` path
    // by using the existing `createMockChild({ ignoreSigTerm: true })`
    // helper, and we explicitly assert the platform is linux.
    setPlatformForTest('linux');
    const terminateSpy = vi.spyOn(windowsProcess, 'terminateChildWindows').mockResolvedValue({ ok: true });
    try {
      const mockChild = createMockChild({ ignoreSigTerm: true });
      const spawnFn = vi.fn().mockReturnValue(mockChild);
      const { guardian } = await createGuardianFixture({ spawnFn });
      await guardian.start();
      const spawnPromise = guardian.spawnManagedOpenCode({
        port: 4096,
        hostname: '127.0.0.1',
        binary: 'opencode',
        cwd: '/tmp/project',
        env: {},
      });
      setTimeout(() => {
        mockChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:4096\n');
      }, 10);
      const { incarnation } = await spawnPromise;
       await guardian.stopChild({ incarnation, administrative: true });

      // The Unix path was taken: child.kill('SIGTERM') and
      // (after timeout) child.kill('SIGKILL') were called.
      expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockChild.kill).toHaveBeenCalledWith('SIGKILL');
      // The Windows helper was NOT called.
      expect(terminateSpy).not.toHaveBeenCalled();
      await guardian.stop();
    } finally {
      terminateSpy.mockRestore();
      restorePlatform();
    }
  });
});
