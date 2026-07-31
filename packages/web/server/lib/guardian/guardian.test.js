import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ManagedOpenCodeHandoffV2State } from '../opencode/managed-opencode-handoff-v2/record.js';
import { createManagedOpenCodeHandoffV2Store } from '../opencode/managed-opencode-handoff-v2/store.js';
import { createManagedOpenCodeHandoffV2Protocol } from '../opencode/managed-opencode-handoff-v2/protocol.js';
import { createManagedOpenCodeHandoffV2SecretProvider } from '../opencode/managed-opencode-handoff-v2/secret-provider.js';
import { ManagedOpenCodeGuardian, createManagedOpenCodeGuardian } from './guardian.js';
import { GuardianClient, GuardianClientError } from './guardian-client.js';
import { createLaunchFingerprint } from './owner-identity.js';
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
  return {
    records,
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
  const guardian = new ManagedOpenCodeGuardian({
    store,
    protocol,
    secretProvider,
    rootDir: root,
    log,
    healthCheckIntervalMs: 0,
    leaseRenewalIntervalMs: 0,
    cleanupIntervalMs: 0,
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
    ...fixtureOptions,
  });
  return { root, clock, store, secretProvider, protocol, guardian, log };
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

describe('ManagedOpenCodeGuardian', () => {
  it.skipIf(process.platform === 'win32')('constructs with valid dependencies', async () => {
    const { guardian } = await createGuardianFixture();
    expect(guardian).toBeInstanceOf(ManagedOpenCodeGuardian);
  });

  it('fails guardian startup closed when recovery-store listing rejects', async () => {
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
      await client.prepareHandoff({ incarnation: result.incarnation, owner });
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

  it.skipIf(process.platform === 'win32')('reconnects after a timed-out RPC before sending the next sequence', async () => {
    const { guardian } = await createGuardianFixture();
    await guardian.start();
    const healthSpy = vi.spyOn(guardian, 'healthCheck').mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ healthy: false }), 100)),
    );
    const client = new GuardianClient({
      socketPath: guardian.socketPath,
      requestTimeoutMs: 20,
    });

    try {
      await expect(client.health({ incarnation: 'slow-child' }))
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
          state: ManagedOpenCodeHandoffV2State.Stopping,
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
      if (started) await secondGuardian.stop();
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
      if (started) await secondGuardian.stop();
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
      if (started) await secondGuardian.stop();
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
    try {
      const first = await createGuardianFixture();
      const record = await seedActiveRecord(first.protocol, { processStartTicks: '12345' });
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
      if (started) await secondGuardian.stop();
      globalThis.fetch = originalFetch;
      processKill.mockRestore();
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
  const createWindowsFixture = async (processInspector) => {
    const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-guardian-win-port-'));
    roots.push(portDir);
    const fixture = await createGuardianFixture({
      processInspector,
      options: {
        portPath: path.join(portDir, 'port'),
        username: 'test-user',
        aclInspector: () => ({ entries: [{ principal: 'test-user', rights: ['F'] }] }),
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
        expect.objectContaining({ state: ManagedOpenCodeHandoffV2State.Stopping }),
      ]));
      const persisted = await fixture.protocol.readRecord({ incarnation: localRecords[0].incarnation });
      expect(persisted).toMatchObject({
        ok: true,
        record: { state: ManagedOpenCodeHandoffV2State.Stopping },
      });
      await expect(client.list()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ state: ManagedOpenCodeHandoffV2State.Stopping }),
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
      if (started) await guardian.stop();
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
      if (started) await guardian.stop();
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
  it.skipIf(process.platform === 'win32')('throws on invalid socket path', () => {
    expect(() => new GuardianClient({})).toThrow('Guardian client requires a socket path');
  });

  it.skipIf(process.platform === 'win32')('throws when disposed', () => {
    const client = new GuardianClient({ socketPath: '/tmp/test.sock' });
    client.disconnect();
    expect(() => client.connect()).toThrow('disposed');
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
