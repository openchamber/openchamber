import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createManagedOpenCodeHandoffV2Protocol } from './protocol.js';
import { ManagedOpenCodeHandoffV2State } from './record.js';
import {
  MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME,
  createManagedOpenCodeHandoffV2SecretProvider,
} from './secret-provider.js';
import {
  MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME,
  createManagedOpenCodeHandoffV2Store,
} from './store.js';

const roots = [];

const createClock = (initialTime = 1_000) => {
  let time = initialTime;
  return {
    now: () => time,
    set: (nextTime) => { time = nextTime; },
    advance: (milliseconds) => { time += milliseconds; },
  };
};

const clone = (value) => (value === null ? null : { ...value });

const createFakeStore = (now) => {
  const records = new Map();
  const operations = new Map();
  let nextCasStatus = null;
  let beforeApply = null;
  let afterApply = null;
  return {
    records,
    operations,
    setNextCasStatus: (status) => { nextCasStatus = status; },
    setBeforeApply: (handler) => { beforeApply = handler; },
    setAfterApply: (handler) => { afterApply = handler; },
    read: async ({ incarnation }) => clone(records.get(incarnation) ?? null),
    compareAndSwap: async ({ incarnation, expected, next, nextForAuthoritativeTime, allowExpired = false }) => {
      const before = beforeApply;
      beforeApply = null;
      await before?.({ incarnation, expected, next, nextForAuthoritativeTime });
      if (nextCasStatus !== null) {
        const status = nextCasStatus;
        nextCasStatus = null;
        return { status };
      }
      const current = records.get(incarnation) ?? null;
      if (expected === null) {
        if (current !== null) return { status: 'conflict' };
      } else {
        if (
          current === null
          || current.revision !== expected.revision
          || current.mac !== expected.mac
          || current.leaseExpiresAt !== expected.leaseExpiresAt
        ) {
          return { status: 'conflict' };
        }
        if (!allowExpired && current.leaseExpiresAt <= now()) return { status: 'expired' };
      }

      const candidate = nextForAuthoritativeTime
        ? nextForAuthoritativeTime(now())
        : next;
      if (!allowExpired && candidate.leaseExpiresAt <= now()) return { status: 'expired' };
      records.set(incarnation, clone(candidate));
      const after = afterApply;
      afterApply = null;
      await after?.(candidate);
      return { status: 'applied' };
    },
    readOperation: async ({ operationId }) => clone(operations.get(operationId) ?? null),
    listOperations: async () => [...operations.values()].map(clone),
    compareAndSwapOperation: async ({ operationId, expected, next, nextForAuthoritativeTime, allowExpired = false }) => {
      const current = operations.get(operationId) ?? null;
      if (expected === null) {
        if (current !== null) return { status: 'conflict' };
      } else if (current === null
        || current.revision !== expected.revision
        || current.mac !== expected.mac
        || current.confirmationExpiresAt !== expected.confirmationExpiresAt) {
        return { status: 'conflict' };
      } else if (!allowExpired && current.confirmationExpiresAt <= now()) {
        return { status: 'expired' };
      }
      const candidate = nextForAuthoritativeTime
        ? nextForAuthoritativeTime(now())
        : next;
      if (!allowExpired && candidate.confirmationExpiresAt <= now()) return { status: 'expired' };
      operations.set(operationId, clone(candidate));
      return { status: 'applied' };
    },
    cleanup: async ({ protectedIncarnations = [] } = {}) => {
      const protectedSet = new Set(protectedIncarnations);
      let removed = 0;
      for (const [incarnation, record] of records) {
        if (record.leaseExpiresAt <= now()
          && [ManagedOpenCodeHandoffV2State.Interrupted, ManagedOpenCodeHandoffV2State.Retired]
            .includes(record.state)
          && !protectedSet.has(incarnation)) {
          records.delete(incarnation);
          removed += 1;
        }
      }
      // Resolved rows are durable signed tombstones. The terminal child row
      // may be pruned, but operation absence must never become resolution.
      return { removed };
    },
  };
};

const fixtures = [];

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-v2-protocol-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const clock = createClock();
  const store = createFakeStore(clock.now);
  const secretProvider = createManagedOpenCodeHandoffV2SecretProvider({ rootDir: root });
  const protocol = createManagedOpenCodeHandoffV2Protocol({
    secretProvider,
    store,
    now: clock.now,
    defaultLeaseMs: 10_000,
  });
  const fixture = { clock, protocol, secretProvider, store };
  fixtures.push(fixture);
  return fixture;
};

const beginLaunch = (fixture, reservation, withCredential = async () => undefined) =>
  fixture.protocol.beginLaunch({
    incarnation: reservation.record.incarnation,
    expectedRevision: reservation.record.revision,
    withCredential,
  });

const activate = async (fixture, leaseMs = 10_000) => {
  const reservation = await fixture.protocol.reserveLaunch({ leaseMs });
  const launching = await beginLaunch(fixture, reservation);
  const active = await fixture.protocol.bindSpawnedProcess({
    incarnation: launching.record.incarnation,
    expectedRevision: launching.record.revision,
    identity: { pid: 43210, port: 4096, processStartTicks: 123456 },
  });
  return { active, launching, reservation };
};

afterEach(() => {
  vi.restoreAllMocks();
  while (fixtures.length > 0) fixtures.pop().secretProvider.dispose();
  while (roots.length > 0) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('managed OpenCode handoff v2 protocol foundation', () => {
  it('exposes a signed all-owner operation view for guardian admission', async () => {
    const fixture = createFixture();

    await expect(fixture.protocol.listAllOperations()).resolves.toEqual({
      ok: true,
      operations: [],
    });
  });

  it.skipIf(process.platform === 'win32')('fences credential callbacks behind armed delivery authority and an unexpired launch CAS', async () => {
    const fixture = createFixture();
    const reservation = await fixture.protocol.reserveLaunch({ leaseMs: 10_000 });
    expect(reservation).toMatchObject({
      ok: true,
      record: { state: ManagedOpenCodeHandoffV2State.Reserved, revision: 0 },
    });
    expect(reservation).not.toHaveProperty('launchMaterial');

    let delivered;
    let rawText;
    const launching = await beginLaunch(fixture, reservation, async (credential) => {
      delivered = credential;
      rawText = credential.toString('base64url');
      expect(fixture.store.records.get(reservation.record.incarnation)).toMatchObject({
        state: ManagedOpenCodeHandoffV2State.LaunchDelivering,
        revision: 1,
      });
    });
    expect(launching).toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffV2State.Launching } });
    expect(delivered.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(reservation)).not.toContain(rawText);
    expect(JSON.stringify(fixture.store.records.get(reservation.record.incarnation))).not.toContain(rawText);

    const stale = await fixture.protocol.reserveLaunch();
    const staleCallback = vi.fn();
    await expect(fixture.protocol.beginLaunch({
      incarnation: stale.record.incarnation,
      expectedRevision: stale.record.revision + 1,
      withCredential: staleCallback,
    })).resolves.toEqual({ ok: false, reason: 'stale-revision' });
    expect(staleCallback).not.toHaveBeenCalled();

    const expired = await fixture.protocol.reserveLaunch({ leaseMs: 10 });
    fixture.clock.advance(10);
    const expiredCallback = vi.fn();
    await expect(beginLaunch(fixture, expired, expiredCallback)).resolves.toEqual({ ok: false, reason: 'record-expired' });
    expect(expiredCallback).not.toHaveBeenCalled();

    const expiredAfterFence = await fixture.protocol.reserveLaunch({ leaseMs: 10 });
    fixture.store.setAfterApply(() => fixture.clock.advance(10));
    const afterFenceCallback = vi.fn();
    await expect(beginLaunch(fixture, expiredAfterFence, afterFenceCallback))
      .resolves.toEqual({ ok: false, reason: 'record-expired' });
    expect(afterFenceCallback).not.toHaveBeenCalled();

    const terminalWinsBeforeFence = await fixture.protocol.reserveLaunch({ leaseMs: 10_000 });
    let terminalBeforeFence;
    fixture.store.setBeforeApply(async ({ incarnation, expected, next }) => {
      if (
        incarnation === terminalWinsBeforeFence.record.incarnation
        && next?.state === ManagedOpenCodeHandoffV2State.LaunchDelivering
      ) {
        terminalBeforeFence = await fixture.protocol.markInterrupted({
          incarnation,
          expectedRevision: expected.revision,
        });
      }
    });
    const terminalBeforeFenceCallback = vi.fn();
    await expect(beginLaunch(fixture, terminalWinsBeforeFence, terminalBeforeFenceCallback))
      .resolves.toEqual({ ok: false, reason: 'compare-and-swap-conflict' });
    expect(terminalBeforeFence).toMatchObject({
      ok: true,
      record: { state: ManagedOpenCodeHandoffV2State.Interrupted },
    });
    expect(terminalBeforeFenceCallback).not.toHaveBeenCalled();

    const terminalBlockedByFence = await fixture.protocol.reserveLaunch({ leaseMs: 10_000 });
    let terminalAfterFence;
    fixture.store.setAfterApply(async (candidate) => {
      if (
        candidate.incarnation === terminalBlockedByFence.record.incarnation
        && candidate.state === ManagedOpenCodeHandoffV2State.LaunchDelivering
      ) {
        terminalAfterFence = await fixture.protocol.markInterrupted({
          incarnation: candidate.incarnation,
          expectedRevision: candidate.revision,
        });
      }
    });
    const terminalAfterFenceCallback = vi.fn();
    const launchedAfterFence = await beginLaunch(
      fixture,
      terminalBlockedByFence,
      terminalAfterFenceCallback,
    );
    expect(terminalAfterFence).toEqual({ ok: false, reason: 'launch-delivery-fenced' });
    expect(terminalAfterFenceCallback).toHaveBeenCalledTimes(1);
    expect(launchedAfterFence).toMatchObject({
      ok: true,
      record: { state: ManagedOpenCodeHandoffV2State.Launching, revision: 2 },
    });

    const invalidClock = await fixture.protocol.reserveLaunch({ leaseMs: 10_000 });
    fixture.store.setAfterApply(() => fixture.clock.set(null));
    const invalidClockCallback = vi.fn();
    await expect(beginLaunch(fixture, invalidClock, invalidClockCallback))
      .resolves.toEqual({ ok: false, reason: 'clock-invalid' });
    expect(invalidClockCallback).not.toHaveBeenCalled();
    expect(fixture.store.records.get(invalidClock.record.incarnation)).toMatchObject({
      state: ManagedOpenCodeHandoffV2State.Interrupted,
      revision: 2,
    });
    fixture.clock.set(1_020);

    const terminal = await fixture.protocol.reserveLaunch({ leaseMs: 10_000 });
    const interrupted = await fixture.protocol.markInterrupted({
      incarnation: terminal.record.incarnation,
      expectedRevision: terminal.record.revision,
    });
    const terminalCallback = vi.fn();
    await expect(beginLaunch(fixture, terminal, terminalCallback)).resolves.toEqual({ ok: false, reason: 'launch-not-allowed' });
    expect(interrupted).toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffV2State.Interrupted } });
    expect(terminalCallback).not.toHaveBeenCalled();

    const conflicted = await fixture.protocol.reserveLaunch({ leaseMs: 10_000 });
    fixture.store.setNextCasStatus('conflict');
    const conflictCallback = vi.fn();
    await expect(beginLaunch(fixture, conflicted, conflictCallback)).resolves.toEqual({ ok: false, reason: 'compare-and-swap-conflict' });
    expect(conflictCallback).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('never invokes a callback when a terminal transition wins while delivery material is pending', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-v2-protocol-fence-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const clock = createClock();
    const store = createFakeStore(clock.now);
    const provider = createManagedOpenCodeHandoffV2SecretProvider({ rootDir: root });
    fixtures.push({ secretProvider: provider });
    let releaseIssue;
    let signalIssue;
    const issueReleased = new Promise((resolve) => { releaseIssue = resolve; });
    const issueStarted = new Promise((resolve) => { signalIssue = resolve; });
    const protocol = createManagedOpenCodeHandoffV2Protocol({
      secretProvider: {
        deriveRecordMacKey: provider.deriveRecordMacKey,
        getLifecycleCredentialFingerprint: provider.getLifecycleCredentialFingerprint,
        issueLifecycleCredential: async (input) => {
          signalIssue();
          await issueReleased;
          return provider.issueLifecycleCredential(input);
        },
      },
      store,
      now: clock.now,
      defaultLeaseMs: 10_000,
    });
    const reservation = await protocol.reserveLaunch();
    const callback = vi.fn();
    const launch = protocol.beginLaunch({
      incarnation: reservation.record.incarnation,
      expectedRevision: reservation.record.revision,
      withCredential: callback,
    });

    try {
      await issueStarted;
      expect(store.records.get(reservation.record.incarnation)).toMatchObject({
        state: ManagedOpenCodeHandoffV2State.Reserved,
        revision: 0,
      });
      await expect(protocol.markInterrupted({
        incarnation: reservation.record.incarnation,
        expectedRevision: reservation.record.revision,
      })).resolves.toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffV2State.Interrupted } });
    } finally {
      releaseIssue();
    }

    await expect(launch).resolves.toEqual({ ok: false, reason: 'compare-and-swap-conflict' });
    expect(callback).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('revokes in-flight material on callback failure and expiry', async () => {
    const fixture = createFixture();
    const failedReservation = await fixture.protocol.reserveLaunch();
    let failedBuffer;
    await expect(beginLaunch(fixture, failedReservation, async (credential) => {
      failedBuffer = credential;
      throw new Error('spawn failed');
    })).resolves.toEqual({ ok: false, reason: 'launch-callback-failed' });
    expect(failedBuffer.every((byte) => byte === 0)).toBe(true);
    await expect(fixture.protocol.readRecord({ incarnation: failedReservation.record.incarnation })).resolves.toMatchObject({
      ok: true,
      record: { state: ManagedOpenCodeHandoffV2State.Interrupted },
    });

    const expiringReservation = await fixture.protocol.reserveLaunch({ leaseMs: 10 });
    let releaseExpiryCallback;
    let expiryCallbackEntered;
    const expiryEntered = new Promise((resolve) => { expiryCallbackEntered = resolve; });
    const releaseExpiry = new Promise((resolve) => { releaseExpiryCallback = resolve; });
    let expiringBuffer;
    const expiringLaunch = beginLaunch(fixture, expiringReservation, async (credential) => {
      expiringBuffer = credential;
      expiryCallbackEntered();
      await releaseExpiry;
    });
    await expiryEntered;
    fixture.clock.advance(10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(expiringBuffer.every((byte) => byte === 0)).toBe(true);
    releaseExpiryCallback();
    await expect(expiringLaunch).resolves.toEqual({ ok: false, reason: 'launch-fence-lost' });
  });

  it.skipIf(process.platform === 'win32')('binds only a complete post-spawn identity and bounds repeated early renewals to authoritative time', async () => {
    const fixture = createFixture();
    const reservation = await fixture.protocol.reserveLaunch();
    const launching = await beginLaunch(fixture, reservation);
    await expect(fixture.protocol.bindSpawnedProcess({
      incarnation: launching.record.incarnation,
      expectedRevision: launching.record.revision,
      identity: { pid: 43210, port: 0, processStartTicks: 1 },
    })).resolves.toEqual({ ok: false, reason: 'invalid-process-identity' });

    const active = await fixture.protocol.bindSpawnedProcess({
      incarnation: launching.record.incarnation,
      expectedRevision: launching.record.revision,
      identity: { pid: 43210, port: 4096, processStartTicks: 1 },
    });
    const firstRenewal = await fixture.protocol.renewLease({
      incarnation: active.record.incarnation,
      expectedRevision: active.record.revision,
      leaseMs: 10_000,
    });
    const secondRenewal = await fixture.protocol.renewLease({
      incarnation: firstRenewal.record.incarnation,
      expectedRevision: firstRenewal.record.revision,
      leaseMs: 10_000,
    });
    expect(firstRenewal.record.leaseExpiresAt).toBe(fixture.clock.now() + 10_000);
    expect(secondRenewal.record.leaseExpiresAt).toBe(fixture.clock.now() + 10_000);

    fixture.clock.advance(500);
    const thirdRenewal = await fixture.protocol.renewLease({
      incarnation: secondRenewal.record.incarnation,
      expectedRevision: secondRenewal.record.revision,
      leaseMs: 10_000,
    });
    expect(thirdRenewal.record.leaseExpiresAt).toBe(fixture.clock.now() + 10_000);
    expect(thirdRenewal.record.leaseExpiresAt).toBeLessThan(active.record.leaseExpiresAt + 10_000);
  });

  it.skipIf(process.platform === 'win32')('enforces stopping and retired terminal rules without an implicit handoff', async () => {
    const fixture = createFixture();
    const { active } = await activate(fixture);
    const stopping = await fixture.protocol.beginStopping({
      incarnation: active.record.incarnation,
      expectedRevision: active.record.revision,
    });
    const retired = await fixture.protocol.retire({
      incarnation: stopping.record.incarnation,
      expectedRevision: stopping.record.revision,
    });
    expect(retired).toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffV2State.Retired } });
    await expect(fixture.protocol.renewLease({
      incarnation: retired.record.incarnation,
      expectedRevision: retired.record.revision,
    })).resolves.toEqual({ ok: false, reason: 'lease-not-renewable' });
  });

  it.skipIf(process.platform === 'win32')('retains a signed terminal row beyond the launch lease for H5 confirmation', async () => {
    const fixture = createFixture();
    const { active } = await activate(fixture);
    const originalLease = active.record.leaseExpiresAt;

    // Let the active lease expire while the stop record is still the
    // authoritative recovery handle. Terminalization must establish a fresh
    // confirmation horizon from authoritative time, rather than inheriting an
    // already-expired launch lease that cleanup could prune immediately.
    fixture.clock.advance(9_999);
    const stopping = await fixture.protocol.beginStopping({
      incarnation: active.record.incarnation,
      expectedRevision: active.record.revision,
      allowExpired: true,
    });
    fixture.clock.advance(2);
    const retired = await fixture.protocol.retire({
      incarnation: stopping.record.incarnation,
      expectedRevision: stopping.record.revision,
      allowExpired: true,
    });

    expect(retired).toMatchObject({
      ok: true,
      record: {
        state: ManagedOpenCodeHandoffV2State.Retired,
      },
    });
    expect(retired.record.leaseExpiresAt).toBeGreaterThan(originalLease);
    fixture.clock.advance(1);
    await expect(fixture.protocol.readRecord({
      incarnation: retired.record.incarnation,
      allowExpired: true,
    })).resolves.toMatchObject({
      ok: true,
      record: {
        state: ManagedOpenCodeHandoffV2State.Retired,
        revision: retired.record.revision,
        leaseExpiresAt: retired.record.leaseExpiresAt,
        mac: retired.record.mac,
      },
    });
    fixture.clock.set(retired.record.leaseExpiresAt - 1);
    await expect(fixture.store.cleanup()).resolves.toEqual({ removed: 0 });
    await expect(fixture.protocol.readRecord({
      incarnation: retired.record.incarnation,
      allowExpired: true,
    })).resolves.toMatchObject({ ok: true });
    fixture.clock.set(retired.record.leaseExpiresAt);
    await expect(fixture.store.cleanup()).resolves.toEqual({ removed: 1 });
    await expect(fixture.protocol.readRecord({
      incarnation: retired.record.incarnation,
      allowExpired: true,
    })).resolves.toMatchObject({ ok: false, reason: 'record-absent' });
  });

  it.skipIf(process.platform === 'win32')('owns the active-to-handoff transition and preserves CAS fencing', async () => {
    const fixture = createFixture();
    const { active } = await activate(fixture);

    await expect(fixture.protocol.prepareHandoff({
      incarnation: active.record.incarnation,
      expectedRevision: active.record.revision,
    })).resolves.toMatchObject({
      ok: true,
      record: {
        state: ManagedOpenCodeHandoffV2State.HandoffPrepared,
        revision: active.record.revision + 1,
      },
    });
  });

  it.skipIf(process.platform === 'win32')('fails closed on a MAC-tampered reopened real SQLite record without serializing secret material', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-handoff-v2-integration-'));
    fs.chmodSync(root, 0o700);
    roots.push(root);
    const store = createManagedOpenCodeHandoffV2Store({ rootDir: root });
    const provider = createManagedOpenCodeHandoffV2SecretProvider({ rootDir: root });
    const protocol = createManagedOpenCodeHandoffV2Protocol({ secretProvider: provider, store });
    let reopenedStore;
    let reopenedProvider;
    let delivered;
    let deliveredText;
    try {
      const largeStartTicks = '638912345678901234';
      const reservation = await protocol.reserveLaunch({ leaseMs: 10_000 });
      const launching = await protocol.beginLaunch({
        incarnation: reservation.record.incarnation,
        expectedRevision: reservation.record.revision,
        withCredential: async (credential) => {
          delivered = credential;
          deliveredText = credential.toString('base64url');
        },
      });
      const active = await protocol.bindSpawnedProcess({
        incarnation: launching.record.incarnation,
        expectedRevision: launching.record.revision,
        identity: { pid: 43210, port: 4096, processStartTicks: largeStartTicks },
      });
      expect(active).toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffV2State.Active } });
      await expect(store.read({ incarnation: active.record.incarnation }))
        .resolves.toMatchObject({ processStartTicks: largeStartTicks });
      const firstRenewal = await protocol.renewLease({
        incarnation: active.record.incarnation,
        expectedRevision: active.record.revision,
        leaseMs: 10_000,
      });
      const secondRenewal = await protocol.renewLease({
        incarnation: firstRenewal.record.incarnation,
        expectedRevision: firstRenewal.record.revision,
        leaseMs: 10_000,
      });
      expect(secondRenewal.record.leaseExpiresAt - firstRenewal.record.leaseExpiresAt).toBeLessThan(5_000);
      expect(delivered.every((byte) => byte === 0)).toBe(true);
      await store.close();
      provider.dispose();

      const databasePath = path.join(root, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME);
      const database = new Database(databasePath);
      const row = database.prepare('SELECT * FROM managed_opencode_handoff_v2_records').get();
      const rawMaster = fs.readFileSync(path.join(root, MANAGED_OPENCODE_HANDOFF_V2_MASTER_SECRET_FILENAME));
      const rawMasterText = rawMaster.toString('base64url');
      expect(JSON.stringify(row)).not.toContain(deliveredText);
      expect(JSON.stringify(row)).not.toContain(rawMasterText);
      expect(JSON.stringify(launching)).not.toContain(deliveredText);
      rawMaster.fill(0);
      database.prepare('UPDATE managed_opencode_handoff_v2_records SET mac = ? WHERE incarnation = ?').run(
        randomBytes(32).toString('base64url'),
        reservation.record.incarnation,
      );
      database.close();

      reopenedStore = createManagedOpenCodeHandoffV2Store({ rootDir: root });
      reopenedProvider = createManagedOpenCodeHandoffV2SecretProvider({ rootDir: root });
      const reopenedProtocol = createManagedOpenCodeHandoffV2Protocol({
        secretProvider: reopenedProvider,
        store: reopenedStore,
      });
      await expect(reopenedProtocol.readRecord({ incarnation: reservation.record.incarnation }))
        .resolves.toEqual({ ok: false, reason: 'record-invalid' });
      reopenedProvider.dispose();
      await reopenedStore.close();
    } finally {
      reopenedProvider?.dispose();
      await reopenedStore?.close();
      provider.dispose();
      await store.close();
    }
  });

  it('confirms a complete record binding through an atomic CAS and rejects mutation', async () => {
    const fixture = createFixture();
    const reservation = await fixture.protocol.reserveLaunch({ leaseMs: 10_000 });
    const binding = {
      expectedRevision: reservation.record.revision,
      expectedLeaseExpiresAt: reservation.record.leaseExpiresAt,
      expectedMac: reservation.record.mac,
    };

    await expect(fixture.protocol.confirmRecord({
      incarnation: reservation.record.incarnation,
      ...binding,
    })).resolves.toMatchObject({ ok: true });

    fixture.store.setBeforeApply(({ incarnation }) => {
      fixture.store.records.get(incarnation).revision += 1;
    });
    await expect(fixture.protocol.confirmRecord({
      incarnation: reservation.record.incarnation,
      ...binding,
    })).resolves.toEqual({ ok: false, reason: 'compare-and-swap-conflict' });
  });

  it('resolves a stop operation from its durable horizon after the terminal child row is pruned', async () => {
    const fixture = createFixture();
    const owner = {
      ownerInstanceId: 'operation-owner',
      runtimeIdentity: 'operation-runtime',
      launchFingerprint: 'operation-fingerprint',
    };
    const reservation = await fixture.protocol.reserveLaunch({ owner });
    const launching = await beginLaunch(fixture, reservation);
    const active = await fixture.protocol.bindSpawnedProcess({
      incarnation: launching.record.incarnation,
      expectedRevision: launching.record.revision,
      identity: { pid: 43210, port: 4096, processStartTicks: 1 },
      owner,
    });
    const operationId = randomBytes(32).toString('base64url');
    const created = await fixture.protocol.createOperation({
      operationId,
      kind: 'stop',
      incarnation: active.record.incarnation,
      owner,
      target: {
        revision: active.record.revision,
        leaseExpiresAt: active.record.leaseExpiresAt,
        mac: active.record.mac,
      },
      horizonMs: 10_000,
    });
    expect(created).toMatchObject({ ok: true, operation: { state: 'pending' } });

    const terminal = await fixture.protocol.markInterrupted({
      incarnation: active.record.incarnation,
      expectedRevision: active.record.revision,
    });
    const resolved = await fixture.protocol.resolveOperation({
      operationId,
      expectedRevision: created.operation.revision,
      expectedConfirmationExpiresAt: created.operation.confirmationExpiresAt,
      expectedMac: created.operation.mac,
      resolutionState: terminal.record.state,
      resolution: {
        record: terminal.record,
        target: { revision: created.operation.targetRevision, leaseExpiresAt: created.operation.targetLeaseExpiresAt, mac: created.operation.targetMac },
      },
    });
    expect(resolved).toMatchObject({ ok: true, operation: { state: 'resolved', resolutionState: 'interrupted' } });

    fixture.store.records.delete(active.record.incarnation);
    await expect(fixture.protocol.readOperation({ operationId, allowExpired: true })).resolves.toMatchObject({
      ok: true,
      operation: {
        state: 'resolved',
        incarnation: active.record.incarnation,
        resolutionState: 'interrupted',
        resolutionRevision: terminal.record.revision,
        resolutionMac: terminal.record.mac,
      },
    });
    fixture.clock.set(created.operation.confirmationExpiresAt);
    await expect(fixture.store.cleanup()).resolves.toEqual({ removed: 0 });
    expect(fixture.store.operations.has(operationId)).toBe(true);
  });

  it('keeps an expired operation discoverable until exact terminal evidence resolves it', async () => {
    const fixture = createFixture();
    const owner = {
      ownerInstanceId: 'expired-operation-owner',
      runtimeIdentity: 'expired-operation-runtime',
      launchFingerprint: 'expired-operation-fingerprint',
    };
    const reservation = await fixture.protocol.reserveLaunch({ owner });
    const operationId = randomBytes(32).toString('base64url');
    const created = await fixture.protocol.createOperation({
      operationId,
      kind: 'stop',
      incarnation: reservation.record.incarnation,
      owner,
      target: reservation.record,
      horizonMs: 100,
    });
    const terminal = await fixture.protocol.markInterrupted({
      incarnation: reservation.record.incarnation,
      expectedRevision: reservation.record.revision,
    });

    fixture.clock.set(created.operation.confirmationExpiresAt);
    await expect(fixture.protocol.expireOperation({
      operationId,
      expectedRevision: created.operation.revision,
      expectedConfirmationExpiresAt: created.operation.confirmationExpiresAt,
      expectedMac: created.operation.mac,
    })).resolves.toMatchObject({ ok: true, operation: { state: 'expired' } });
    await expect(fixture.protocol.readOperation({ operationId, allowExpired: true })).resolves.toMatchObject({
      ok: true,
      expired: true,
      operation: { state: 'expired' },
    });
    await expect(fixture.store.cleanup()).resolves.toEqual({ removed: 0 });
    expect(fixture.store.operations.has(operationId)).toBe(true);
    const expiredOperation = (await fixture.protocol.readOperation({ operationId, allowExpired: true })).operation;

    await expect(fixture.protocol.resolveOperation({
      operationId,
      expectedRevision: expiredOperation.revision,
      expectedConfirmationExpiresAt: created.operation.confirmationExpiresAt,
      expectedMac: expiredOperation.mac,
      resolutionState: terminal.record.state,
      resolution: {
        record: terminal.record,
        target: {
          revision: created.operation.targetRevision,
          leaseExpiresAt: created.operation.targetLeaseExpiresAt,
          mac: created.operation.targetMac,
        },
      },
    })).resolves.toMatchObject({ ok: true, operation: { state: 'resolved', resolutionState: 'interrupted' } });
  });

  it('resolves an ambiguous initial spawn safely when its child terminates before adoption', async () => {
    const fixture = createFixture();
    const owner = {
      ownerInstanceId: 'spawn-operation-owner',
      runtimeIdentity: 'spawn-operation-runtime',
      launchFingerprint: 'spawn-operation-fingerprint',
    };
    const reservation = await fixture.protocol.reserveLaunch({ owner });
    const operationId = randomBytes(32).toString('base64url');
    const created = await fixture.protocol.createOperation({
      operationId,
      kind: 'spawn',
      incarnation: reservation.record.incarnation,
      owner,
      target: reservation.record,
      horizonMs: 10_000,
    });
    const launching = await beginLaunch(fixture, reservation);
    const active = await fixture.protocol.bindSpawnedProcess({
      incarnation: launching.record.incarnation,
      expectedRevision: launching.record.revision,
      identity: { pid: 43211, port: 4097, processStartTicks: 2 },
      owner,
    });
    const activeResolution = await fixture.protocol.resolveOperation({
      operationId,
      expectedRevision: created.operation.revision,
      expectedConfirmationExpiresAt: created.operation.confirmationExpiresAt,
      expectedMac: created.operation.mac,
      resolutionState: active.record.state,
      resolution: {
        record: active.record,
        target: { revision: created.operation.targetRevision, leaseExpiresAt: created.operation.targetLeaseExpiresAt, mac: created.operation.targetMac },
      },
    });
    expect(activeResolution).toMatchObject({ ok: true, operation: { resolutionState: 'active' } });
    const terminal = await fixture.protocol.markInterrupted({
      incarnation: active.record.incarnation,
      expectedRevision: active.record.revision,
    });
    await expect(fixture.protocol.resolveOperation({
      operationId,
      expectedRevision: activeResolution.operation.revision,
      expectedConfirmationExpiresAt: activeResolution.operation.confirmationExpiresAt,
      expectedMac: activeResolution.operation.mac,
      resolutionState: terminal.record.state,
      resolution: {
        record: terminal.record,
        target: { revision: created.operation.targetRevision, leaseExpiresAt: created.operation.targetLeaseExpiresAt, mac: created.operation.targetMac },
      },
    })).resolves.toMatchObject({ ok: true, operation: { resolutionState: 'interrupted' } });
    fixture.store.records.delete(reservation.record.incarnation);
    await expect(fixture.protocol.readOperation({ operationId })).resolves.toMatchObject({
      ok: true,
      operation: { state: 'resolved', resolutionState: 'interrupted' },
    });
  });

  it('rejects wrong-binding, absent-target, read-failure, and MAC-corrupt resolutions', async () => {
    const owner = {
      ownerInstanceId: 'binding-owner',
      runtimeIdentity: 'binding-runtime',
      launchFingerprint: 'binding-fingerprint',
    };
    const makeOperation = async () => {
      const fixture = createFixture();
      const reservation = await fixture.protocol.reserveLaunch({ owner });
      const operationId = randomBytes(32).toString('base64url');
      const created = await fixture.protocol.createOperation({
        operationId,
        kind: 'stop',
        incarnation: reservation.record.incarnation,
        owner,
        target: reservation.record,
        horizonMs: 10_000,
      });
      return { fixture, reservation, created, operationId };
    };

    const wrongBinding = await makeOperation();
    const terminal = await wrongBinding.fixture.protocol.markInterrupted({
      incarnation: wrongBinding.reservation.record.incarnation,
      expectedRevision: wrongBinding.reservation.record.revision,
    });
    const wrongOwner = {
      ...terminal.record,
      ownerInstanceId: 'wrong-owner',
    };
    await expect(wrongBinding.fixture.protocol.resolveOperation({
      operationId: wrongBinding.operationId,
      expectedRevision: wrongBinding.created.operation.revision,
      expectedConfirmationExpiresAt: wrongBinding.created.operation.confirmationExpiresAt,
      expectedMac: wrongBinding.created.operation.mac,
      resolutionState: terminal.record.state,
      resolution: {
        record: wrongOwner,
        target: { revision: wrongBinding.created.operation.targetRevision, leaseExpiresAt: wrongBinding.created.operation.targetLeaseExpiresAt, mac: wrongBinding.created.operation.targetMac },
      },
    })).resolves.toEqual({ ok: false, reason: 'operation-resolution-binding-invalid' });

    const absent = await makeOperation();
    const absentTerminal = await absent.fixture.protocol.markInterrupted({
      incarnation: absent.reservation.record.incarnation,
      expectedRevision: absent.reservation.record.revision,
    });
    absent.fixture.store.records.delete(absent.reservation.record.incarnation);
    await expect(absent.fixture.protocol.resolveOperation({
      operationId: absent.operationId,
      expectedRevision: absent.created.operation.revision,
      expectedConfirmationExpiresAt: absent.created.operation.confirmationExpiresAt,
      expectedMac: absent.created.operation.mac,
      resolutionState: 'active',
      resolution: {
        record: absentTerminal.record,
        target: { revision: absent.created.operation.targetRevision, leaseExpiresAt: absent.created.operation.targetLeaseExpiresAt, mac: absent.created.operation.targetMac },
      },
    })).resolves.toEqual({ ok: false, reason: 'operation-resolution-binding-invalid' });
    await expect(absent.fixture.protocol.resolveOperation({
      operationId: absent.operationId,
      expectedRevision: absent.created.operation.revision,
      expectedConfirmationExpiresAt: absent.created.operation.confirmationExpiresAt,
      expectedMac: absent.created.operation.mac,
      resolutionState: absentTerminal.record.state,
      resolution: {
        record: absentTerminal.record,
        target: { revision: absent.created.operation.targetRevision, leaseExpiresAt: absent.created.operation.targetLeaseExpiresAt, mac: absent.created.operation.targetMac },
      },
    })).resolves.toMatchObject({ ok: true, operation: { resolutionState: 'interrupted' } });

    const readFailure = await makeOperation();
    const readFailureTerminal = await readFailure.fixture.protocol.markInterrupted({
      incarnation: readFailure.reservation.record.incarnation,
      expectedRevision: readFailure.reservation.record.revision,
    });
    const originalRead = readFailure.fixture.store.read;
    readFailure.fixture.store.read = async () => { throw new Error('record read failed'); };
    await expect(readFailure.fixture.protocol.resolveOperation({
      operationId: readFailure.operationId,
      expectedRevision: readFailure.created.operation.revision,
      expectedConfirmationExpiresAt: readFailure.created.operation.confirmationExpiresAt,
      expectedMac: readFailure.created.operation.mac,
      resolutionState: 'interrupted',
      resolution: {
        record: readFailureTerminal.record,
        target: { revision: readFailure.created.operation.targetRevision, leaseExpiresAt: readFailure.created.operation.targetLeaseExpiresAt, mac: readFailure.created.operation.targetMac },
      },
    })).resolves.toEqual({ ok: false, reason: 'operation-target-read-failed' });
    readFailure.fixture.store.read = originalRead;

    const corrupt = await makeOperation();
    corrupt.fixture.store.operations.get(corrupt.operationId).mac = 'corrupt';
    await expect(corrupt.fixture.protocol.resolveOperation({
      operationId: corrupt.operationId,
      expectedRevision: corrupt.created.operation.revision,
      expectedConfirmationExpiresAt: corrupt.created.operation.confirmationExpiresAt,
      expectedMac: corrupt.created.operation.mac,
      resolutionState: 'interrupted',
      resolution: {
        record: corrupt.reservation.record,
        target: { revision: corrupt.created.operation.targetRevision, leaseExpiresAt: corrupt.created.operation.targetLeaseExpiresAt, mac: corrupt.created.operation.targetMac },
      },
    })).resolves.toEqual({ ok: false, reason: 'operation-invalid' });
  });

  it('persists and resolves a prepare-handoff operation with the prepared state', async () => {
    const fixture = createFixture();
    const owner = {
      ownerInstanceId: 'prepare-owner',
      runtimeIdentity: 'prepare-runtime',
      launchFingerprint: 'prepare-fingerprint',
    };
    const reservation = await fixture.protocol.reserveLaunch({ owner });
    const launching = await beginLaunch(fixture, reservation);
    const active = await fixture.protocol.bindSpawnedProcess({
      incarnation: launching.record.incarnation,
      expectedRevision: launching.record.revision,
      identity: { pid: 43212, port: 4098, processStartTicks: 3 },
      owner,
    });
    const operationId = randomBytes(32).toString('base64url');
    const created = await fixture.protocol.createOperation({
      operationId,
      kind: 'prepare-handoff',
      incarnation: active.record.incarnation,
      owner,
      target: active.record,
      horizonMs: 10_000,
    });
    const prepared = await fixture.protocol.prepareHandoff({
      incarnation: active.record.incarnation,
      expectedRevision: active.record.revision,
    });
    await expect(fixture.protocol.resolveOperation({
      operationId,
      expectedRevision: created.operation.revision,
      expectedConfirmationExpiresAt: created.operation.confirmationExpiresAt,
      expectedMac: created.operation.mac,
      resolutionState: prepared.record.state,
      resolution: {
        record: prepared.record,
        target: { revision: created.operation.targetRevision, leaseExpiresAt: created.operation.targetLeaseExpiresAt, mac: created.operation.targetMac },
      },
    })).resolves.toMatchObject({
      ok: true,
      operation: { state: 'resolved', resolutionState: 'handoff-prepared' },
    });
  });
});
