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
  let nextCasStatus = null;
  let beforeApply = null;
  let afterApply = null;
  return {
    records,
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
});
