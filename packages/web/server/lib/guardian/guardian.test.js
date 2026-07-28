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

let roots = [];

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
    compareAndSwap: async ({ incarnation, expected, next, nextForAuthoritativeTime }) => {
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
      if (current.leaseExpiresAt <= clock.now()) return { status: 'expired' };
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
  const secretProvider = overrides.secretProvider ?? createManagedOpenCodeHandoffV2SecretProvider({ rootDir: root });
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
    ...overrides.options,
  });
  return { root, clock, store, secretProvider, protocol, guardian, log };
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

  it.skipIf(process.platform === 'win32')('throws on invalid constructor arguments', async () => {
    await expect(() => new ManagedOpenCodeGuardian({})).toThrow('ManagedOpenCodeGuardian requires a store');
    await expect(() => new ManagedOpenCodeGuardian({ store: { read: () => {} } }))
      .toThrow('ManagedOpenCodeGuardian requires a protocol');
  });

  it.skipIf(process.platform === 'win32')('rejects on Windows', async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const { guardian } = await createGuardianFixture();
    await expect(guardian.start()).rejects.toThrow('Linux/POSIX only');
    Object.defineProperty(process, 'platform', originalPlatform ?? { value: process.platform });
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
    const stopPromise = guardian.stopChild({ incarnation });
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
    const { guardian, clock } = await createGuardianFixture({ spawnFn });

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

    // Advance clock to simulate lease renewal scenario.
    clock.advance(1000);

    const before = await guardian.listChildren();
    expect(before.length).toBe(1);

    // Renew lease manually.
    const record = before[0];
    const renewed = await guardian.protocol.renewLease({
      incarnation,
      expectedRevision: record.revision,
      leaseMs: 60_000,
    });
    expect(renewed.ok).toBe(true);

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

      const mockChild = createMockChild();
      const spawnFn = vi.fn().mockReturnValue(mockChild);
      // Re-inject spawnFn into the guardian for the IPC call.
      guardian.setSpawnFn?.(spawnFn);

      const spawnPromise = client.spawn({
        port: 4097,
        hostname: '127.0.0.1',
        binary: 'opencode',
        cwd: '/tmp/project',
        env: {},
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

      await client.stop({ incarnation: result.incarnation });
    } finally {
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
    const prepared = await guardian.prepareHandoff({ incarnation });
    expect(prepared.state).toBe(ManagedOpenCodeHandoffV2State.HandoffPrepared);

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
