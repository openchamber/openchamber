import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  canonicalizeManagedOpenCodeHandoffRecord,
  createManagedOpenCodeHandoffProtocol,
  MANAGED_OPENCODE_HANDOFF_CHILD_CREDENTIAL_HKDF_INFO,
  MANAGED_OPENCODE_HANDOFF_RECORD_MAC_HKDF_INFO,
  ManagedOpenCodeHandoffState,
} from './managed-opencode-handoff-protocol.js';

const clone = (value) => (value && typeof value === 'object' ? { ...value } : value);
const createClaimCapability = () => randomBytes(32).toString('base64url');

const createClock = (initialTime = 1_000) => {
  let time = initialTime;
  return {
    now: () => time,
    set: (nextTime) => { time = nextTime; },
    advance: (delta) => { time += delta; },
  };
};

// This is deliberately only a test fake. Its compare-and-swap applies the
// expiry predicate in the same synchronous commit section as the revision/MAC
// comparison. Production callers must inject an equivalent cross-process CAS.
const createInMemoryCasStore = ({ now } = {}) => {
  const records = new Map();
  let beforeCompareAndSwap = null;
  let readError = null;
  let compareAndSwapError = null;
  const read = vi.fn(async ({ incarnation }) => {
    if (readError) throw readError;
    return clone(records.has(incarnation) ? records.get(incarnation) : null);
  });
  const compareAndSwap = vi.fn(async ({ incarnation, expected, next, requireUnexpired }) => {
    if (compareAndSwapError) throw compareAndSwapError;
    await beforeCompareAndSwap?.();

    const commitTime = now();
    const expiresAt = requireUnexpired?.expiresAt;
    if (
      !Number.isSafeInteger(expiresAt)
      || commitTime >= expiresAt
      || commitTime >= next.expiresAt
    ) {
      return { status: 'expired' };
    }

    const current = records.has(incarnation) ? records.get(incarnation) : null;
    if (expected === null) {
      if (current !== null) return { status: 'conflict' };
    } else if (
      !current
      || current.revision !== expected.revision
      || current.mac !== expected.mac
      || current.expiresAt !== expected.expiresAt
    ) {
      return { status: 'conflict' };
    }

    records.set(incarnation, clone(next));
    return { status: 'applied' };
  });
  return {
    records,
    read,
    compareAndSwap,
    setBeforeCompareAndSwap: (handler) => { beforeCompareAndSwap = handler; },
    setReadError: (error) => { readError = error; },
    setCompareAndSwapError: (error) => { compareAndSwapError = error; },
  };
};

const identityFor = (record) => ({
  pid: record.pid,
  port: record.port,
  incarnation: record.incarnation,
  fingerprint: record.fingerprint,
});

const createFakeChild = ({ pid = 43210, port = 4096 } = {}) => {
  let identity = null;
  const child = {
    pid,
    port,
    processResponse: undefined,
    healthResponse: undefined,
    bind(record) {
      identity = identityFor(record);
    },
    setProcessResponse(response) {
      child.processResponse = response;
    },
    setHealthResponse(response) {
      child.healthResponse = response;
    },
    spawn: vi.fn(),
    kill: vi.fn(),
    listen: vi.fn(),
    connect: vi.fn(),
    readSecret: vi.fn(),
    writeSecret: vi.fn(),
  };
  child.verifyProcess = vi.fn(async (input) => {
    if (typeof child.processResponse === 'function') return child.processResponse(input);
    return child.processResponse ?? ({ ok: true, ...identity });
  });
  child.verifyAuthenticatedHealth = vi.fn(async (input) => {
    if (typeof child.healthResponse === 'function') return child.healthResponse(input);
    return child.healthResponse ?? ({ ok: true, ...identity });
  });
  return child;
};

const createFixture = ({
  masterSecret = Buffer.alloc(32, 7),
  clock = createClock(),
  now = clock.now,
  child = createFakeChild(),
  store = createInMemoryCasStore({ now: clock.now }),
} = {}) => {
  const protocol = createManagedOpenCodeHandoffProtocol({
    masterSecret,
    store,
    now,
    verifyProcess: child.verifyProcess,
    verifyAuthenticatedHealth: child.verifyAuthenticatedHealth,
  });
  return { child, clock, masterSecret, now, protocol, store };
};

const prepareHandoff = async (fixture, { ttlMs = 10_000 } = {}) => {
  const prepared = await fixture.protocol.prepareLaunch({
    pid: fixture.child.pid,
    port: fixture.child.port,
    ttlMs,
  });
  expect(prepared.ok).toBe(true);
  fixture.child.bind(prepared.record);

  const active = await fixture.protocol.activate({
    incarnation: prepared.record.incarnation,
    expectedRevision: prepared.record.revision,
  });
  expect(active.ok).toBe(true);

  const handoff = await fixture.protocol.prepareHandoff({
    incarnation: active.record.incarnation,
    expectedRevision: active.record.revision,
  });
  expect(handoff.ok).toBe(true);
  return { prepared, active, handoff };
};

const mutationInput = (record, claimCapability, overrides = {}) => ({
  incarnation: record.incarnation,
  expectedRevision: record.revision,
  claimant: record.claimant,
  claimCapability,
  identity: identityFor(record),
  ...overrides,
});

describe('managed OpenCode handoff protocol', () => {
  it('runs the valid signed lifecycle without exposing the private claim capability', async () => {
    const fixture = createFixture();
    const { prepared, active, handoff } = await prepareHandoff(fixture);
    const claimCapability = createClaimCapability();

    expect(prepared.record).toMatchObject({
      v: 1,
      state: ManagedOpenCodeHandoffState.LaunchPrepared,
      revision: 0,
      claimant: null,
    });
    expect(prepared.record).not.toHaveProperty('mac');
    expect(prepared.record).not.toHaveProperty('childCredential');
    expect(prepared.record).not.toHaveProperty('claimCapability');
    expect(active.record.state).toBe(ManagedOpenCodeHandoffState.Active);
    expect(handoff.record.state).toBe(ManagedOpenCodeHandoffState.HandoffPrepared);

    const claimed = await fixture.protocol.claim({
      incarnation: handoff.record.incarnation,
      expectedRevision: handoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability,
    });
    expect(claimed).toMatchObject({
      ok: true,
      record: {
        state: ManagedOpenCodeHandoffState.Claimed,
        claimant: 'web-runtime-1',
        revision: handoff.record.revision + 1,
      },
    });
    expect(claimed.record).not.toHaveProperty('claimCapability');
    expect(claimed.record).not.toHaveProperty('claimCapabilityDigest');

    const stopping = await fixture.protocol.beginStopping(mutationInput(claimed.record, claimCapability));
    const retired = await fixture.protocol.retire(mutationInput(stopping.record, claimCapability));
    expect(retired.record.state).toBe(ManagedOpenCodeHandoffState.Retired);

    await expect(fixture.protocol.readRecord({ incarnation: retired.record.incarnation }))
      .resolves.toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffState.Retired } });
    await expect(fixture.protocol.activate({
      incarnation: retired.record.incarnation,
      expectedRevision: retired.record.revision,
    })).resolves.toEqual({ ok: false, reason: 'illegal-transition' });
  });

  it('fails closed for malformed, unknown, and tampered records', async () => {
    const fixture = createFixture();
    const malformedIncarnation = randomBytes(32).toString('base64url');
    fixture.store.records.set(malformedIncarnation, { v: 1 });

    await expect(fixture.protocol.readRecord({ incarnation: malformedIncarnation }))
      .resolves.toEqual({ ok: false, reason: 'record-invalid' });

    const { handoff } = await prepareHandoff(fixture);
    const raw = fixture.store.records.get(handoff.record.incarnation);
    fixture.store.records.set(handoff.record.incarnation, { ...raw, unknownAuthorityField: true });
    await expect(fixture.protocol.readRecord({ incarnation: handoff.record.incarnation }))
      .resolves.toEqual({ ok: false, reason: 'record-invalid' });

    fixture.store.records.set(handoff.record.incarnation, { ...raw, port: raw.port + 1 });
    await expect(fixture.protocol.readRecord({ incarnation: handoff.record.incarnation }))
      .resolves.toEqual({ ok: false, reason: 'record-invalid' });
  });

  it('does not reopen expired records', async () => {
    const clock = createClock();
    const fixture = createFixture({ clock });
    const prepared = await fixture.protocol.prepareLaunch({ pid: 43210, port: 4096, ttlMs: 10 });
    fixture.child.bind(prepared.record);
    clock.set(prepared.record.expiresAt);

    await expect(fixture.protocol.activate({
      incarnation: prepared.record.incarnation,
      expectedRevision: prepared.record.revision,
    })).resolves.toEqual({ ok: false, reason: 'record-expired' });
    expect(fixture.store.records.get(prepared.record.incarnation).state)
      .toBe(ManagedOpenCodeHandoffState.LaunchPrepared);
  });

  it('rejects a claim when time expires while an injected verifier is pending', async () => {
    const clock = createClock();
    const fixture = createFixture({ clock });
    const { handoff } = await prepareHandoff(fixture, { ttlMs: 10 });
    const claimCapability = createClaimCapability();
    fixture.child.setProcessResponse(async () => {
      clock.set(handoff.record.expiresAt);
      return { ok: true, ...identityFor(handoff.record) };
    });
    fixture.store.compareAndSwap.mockClear();

    await expect(fixture.protocol.claim({
      incarnation: handoff.record.incarnation,
      expectedRevision: handoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability,
    })).resolves.toEqual({ ok: false, reason: 'record-expired' });
    expect(fixture.store.compareAndSwap).toHaveBeenCalledOnce();
    expect(fixture.store.records.get(handoff.record.incarnation).state)
      .toBe(ManagedOpenCodeHandoffState.HandoffPrepared);
  });

  it('rejects a transition when the atomic CAS observes expiry at commit time', async () => {
    const clock = createClock();
    const fixture = createFixture({ clock });
    const prepared = await fixture.protocol.prepareLaunch({ pid: 43210, port: 4096, ttlMs: 10 });
    fixture.child.bind(prepared.record);
    fixture.store.setBeforeCompareAndSwap(() => {
      clock.set(prepared.record.expiresAt);
    });
    fixture.store.compareAndSwap.mockClear();

    await expect(fixture.protocol.activate({
      incarnation: prepared.record.incarnation,
      expectedRevision: prepared.record.revision,
    })).resolves.toEqual({ ok: false, reason: 'record-expired' });
    expect(fixture.store.compareAndSwap).toHaveBeenCalledOnce();
    expect(fixture.store.records.get(prepared.record.incarnation).state)
      .toBe(ManagedOpenCodeHandoffState.LaunchPrepared);
  });

  it('rejects illegal state transitions before attempting a mutation', async () => {
    const fixture = createFixture();
    const prepared = await fixture.protocol.prepareLaunch({ pid: 43210, port: 4096 });
    fixture.store.compareAndSwap.mockClear();

    await expect(fixture.protocol.prepareHandoff({
      incarnation: prepared.record.incarnation,
      expectedRevision: prepared.record.revision,
    })).resolves.toEqual({ ok: false, reason: 'illegal-transition' });
    expect(fixture.store.compareAndSwap).not.toHaveBeenCalled();
  });

  it('allows exactly one of competing claims through the injected CAS', async () => {
    const fixture = createFixture();
    const { handoff } = await prepareHandoff(fixture);
    fixture.store.compareAndSwap.mockClear();

    const claims = await Promise.all([
      fixture.protocol.claim({
        incarnation: handoff.record.incarnation,
        expectedRevision: handoff.record.revision,
        claimant: 'web-runtime-1',
        claimCapability: createClaimCapability(),
      }),
      fixture.protocol.claim({
        incarnation: handoff.record.incarnation,
        expectedRevision: handoff.record.revision,
        claimant: 'desktop-runtime-1',
        claimCapability: createClaimCapability(),
      }),
    ]);

    expect(claims.filter((result) => result.ok)).toHaveLength(1);
    expect(claims.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'compare-and-swap-conflict' },
    ]);
    expect(fixture.store.compareAndSwap).toHaveBeenCalledTimes(2);
  });

  it('does not let a record reader reconstruct or replay claim authority', async () => {
    const fixture = createFixture();
    const { handoff } = await prepareHandoff(fixture);
    const claimCapability = createClaimCapability();
    const claimed = await fixture.protocol.claim({
      incarnation: handoff.record.incarnation,
      expectedRevision: handoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability,
    });
    const observed = await fixture.protocol.readRecord({ incarnation: claimed.record.incarnation });
    const persisted = fixture.store.records.get(claimed.record.incarnation);
    fixture.store.compareAndSwap.mockClear();

    expect(observed.record).not.toHaveProperty('claimCapability');
    expect(observed.record).not.toHaveProperty('claimCapabilityDigest');
    await expect(fixture.protocol.beginStopping(mutationInput(
      observed.record,
      persisted.claimCapabilityDigest,
    ))).resolves.toEqual({ ok: false, reason: 'claim-capability-mismatch' });
    await expect(fixture.protocol.beginStopping(mutationInput(observed.record, undefined)))
      .resolves.toEqual({ ok: false, reason: 'invalid-claim-capability' });
    expect(fixture.store.compareAndSwap).not.toHaveBeenCalled();

    await expect(fixture.protocol.beginStopping(mutationInput(observed.record, claimCapability)))
      .resolves.toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffState.Stopping } });
  });

  it('requires claimant, raw capability, revision, and identity for claimed mutations', async () => {
    const fixture = createFixture();
    const { handoff } = await prepareHandoff(fixture);
    const claimCapability = createClaimCapability();
    const claimed = await fixture.protocol.claim({
      incarnation: handoff.record.incarnation,
      expectedRevision: handoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability,
    });
    fixture.store.compareAndSwap.mockClear();

    await expect(fixture.protocol.beginStopping(mutationInput(claimed.record, claimCapability, {
      claimant: 'other-runtime',
    }))).resolves.toEqual({ ok: false, reason: 'claimant-mismatch' });
    await expect(fixture.protocol.beginStopping(mutationInput(claimed.record, createClaimCapability())))
      .resolves.toEqual({ ok: false, reason: 'claim-capability-mismatch' });
    await expect(fixture.protocol.beginStopping(mutationInput(claimed.record, claimCapability, {
      identity: { ...identityFor(claimed.record), port: claimed.record.port + 1 },
    }))).resolves.toEqual({ ok: false, reason: 'identity-mismatch' });
    await expect(fixture.protocol.beginStopping(mutationInput(claimed.record, claimCapability, {
      expectedRevision: claimed.record.revision + 1,
    }))).resolves.toEqual({ ok: false, reason: 'stale-revision' });
    expect(fixture.store.compareAndSwap).not.toHaveBeenCalled();

    await expect(fixture.protocol.beginStopping(mutationInput(claimed.record, claimCapability)))
      .resolves.toMatchObject({ ok: true, record: { state: ManagedOpenCodeHandoffState.Stopping } });
  });

  it.each([
    ['PID', (record) => ({ pid: record.pid + 1 })],
    ['port', (record) => ({ port: record.port + 1 })],
    ['incarnation', () => ({ incarnation: randomBytes(32).toString('base64url') })],
    ['fingerprint', () => ({ fingerprint: randomBytes(32).toString('base64url') })],
  ])('rejects %s reuse that does not attest to the signed child identity', async (_label, mutate) => {
    const fixture = createFixture();
    const { handoff } = await prepareHandoff(fixture);
    fixture.child.setProcessResponse({
      ok: true,
      ...identityFor(handoff.record),
      ...mutate(handoff.record),
    });

    await expect(fixture.protocol.claim({
      incarnation: handoff.record.incarnation,
      expectedRevision: handoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    })).resolves.toEqual({ ok: false, reason: 'process-verification-failed' });
  });

  it('rejects explicit process and authenticated-health verifier failures before CAS', async () => {
    const processFailure = createFixture();
    const { handoff: processHandoff } = await prepareHandoff(processFailure);
    processFailure.child.setProcessResponse({ ok: false });
    processFailure.store.compareAndSwap.mockClear();
    await expect(processFailure.protocol.claim({
      incarnation: processHandoff.record.incarnation,
      expectedRevision: processHandoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    })).resolves.toEqual({ ok: false, reason: 'process-verification-failed' });
    expect(processFailure.child.verifyAuthenticatedHealth).not.toHaveBeenCalled();
    expect(processFailure.store.compareAndSwap).not.toHaveBeenCalled();

    const healthFailure = createFixture();
    const { handoff: healthHandoff } = await prepareHandoff(healthFailure);
    healthFailure.child.setHealthResponse({ ok: false });
    healthFailure.store.compareAndSwap.mockClear();
    await expect(healthFailure.protocol.claim({
      incarnation: healthHandoff.record.incarnation,
      expectedRevision: healthHandoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    })).resolves.toEqual({ ok: false, reason: 'health-verification-failed' });
    expect(healthFailure.store.compareAndSwap).not.toHaveBeenCalled();
  });

  it('fails closed for malformed verifier attestations and verifier exceptions', async () => {
    const malformed = createFixture();
    const { handoff: malformedHandoff } = await prepareHandoff(malformed);
    malformed.child.setProcessResponse({ ok: true });
    await expect(malformed.protocol.claim({
      incarnation: malformedHandoff.record.incarnation,
      expectedRevision: malformedHandoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    })).resolves.toEqual({ ok: false, reason: 'process-verification-failed' });

    const processFailure = createFixture();
    const { handoff: processHandoff } = await prepareHandoff(processFailure);
    processFailure.child.setProcessResponse(async () => { throw new Error('process unavailable'); });
    await expect(processFailure.protocol.claim({
      incarnation: processHandoff.record.incarnation,
      expectedRevision: processHandoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    })).resolves.toEqual({ ok: false, reason: 'process-verification-failed' });

    const healthFailure = createFixture();
    const { handoff: healthHandoff } = await prepareHandoff(healthFailure);
    healthFailure.child.setHealthResponse(async () => { throw new Error('health unavailable'); });
    await expect(healthFailure.protocol.claim({
      incarnation: healthHandoff.record.incarnation,
      expectedRevision: healthHandoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    })).resolves.toEqual({ ok: false, reason: 'health-verification-failed' });
  });

  it('fails closed for store exceptions and invalid clock or expiry input', async () => {
    const fixture = createFixture();
    const prepared = await fixture.protocol.prepareLaunch({ pid: 43210, port: 4096 });
    fixture.store.setReadError(new Error('read unavailable'));
    await expect(fixture.protocol.readRecord({ incarnation: prepared.record.incarnation }))
      .resolves.toEqual({ ok: false, reason: 'store-read-failed' });
    fixture.store.setReadError(null);
    fixture.store.setCompareAndSwapError(new Error('CAS unavailable'));
    await expect(fixture.protocol.activate({
      incarnation: prepared.record.incarnation,
      expectedRevision: prepared.record.revision,
    })).resolves.toEqual({ ok: false, reason: 'compare-and-swap-failed' });

    const invalidClock = createFixture({ now: () => Number.NaN });
    await expect(invalidClock.protocol.prepareLaunch({ pid: 43210, port: 4096 }))
      .resolves.toEqual({ ok: false, reason: 'clock-invalid' });
    const invalidExpiry = createFixture();
    await expect(invalidExpiry.protocol.prepareLaunch({ pid: 43210, port: 4096, ttlMs: 0 }))
      .resolves.toEqual({ ok: false, reason: 'invalid-expiry' });
  });

  it('passes verifiers only the signed child identity', async () => {
    const masterSecret = Buffer.alloc(32, 31);
    const fixture = createFixture({ masterSecret });
    const { handoff } = await prepareHandoff(fixture);
    const expectedIdentity = identityFor(handoff.record);

    await expect(fixture.protocol.claim({
      incarnation: handoff.record.incarnation,
      expectedRevision: handoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    })).resolves.toMatchObject({ ok: true });

    for (const verifier of [fixture.child.verifyProcess, fixture.child.verifyAuthenticatedHealth]) {
      expect(verifier).toHaveBeenCalledWith(expectedIdentity);
      const input = verifier.mock.calls[0][0];
      expect(Object.keys(input).sort()).toEqual(['fingerprint', 'incarnation', 'pid', 'port']);
      expect(input).not.toHaveProperty('masterSecret');
      expect(input).not.toHaveProperty('childCredential');
      expect(input).not.toHaveProperty('claimCapability');
    }
  });

  it('uses independent HKDF domains for the child credential and record MAC', async () => {
    const masterSecret = Buffer.alloc(32, 23);
    const fixture = createFixture({ masterSecret });
    const prepared = await fixture.protocol.prepareLaunch({ pid: 43210, port: 4096 });
    const raw = fixture.store.records.get(prepared.record.incarnation);
    const salt = Buffer.from(raw.incarnation, 'base64url');
    const childCredential = Buffer.from(hkdfSync(
      'sha256',
      masterSecret,
      salt,
      Buffer.from(MANAGED_OPENCODE_HANDOFF_CHILD_CREDENTIAL_HKDF_INFO),
      32,
    ));
    const recordMacKey = Buffer.from(hkdfSync(
      'sha256',
      masterSecret,
      salt,
      Buffer.from(MANAGED_OPENCODE_HANDOFF_RECORD_MAC_HKDF_INFO),
      32,
    ));

    expect(childCredential.equals(recordMacKey)).toBe(false);
    expect(createHash('sha256').update(childCredential).digest('base64url')).toBe(raw.fingerprint);
    expect(createHmac('sha256', recordMacKey)
      .update(canonicalizeManagedOpenCodeHandoffRecord(raw))
      .digest('base64url')).toBe(raw.mac);
    expect(createHmac('sha256', childCredential)
      .update(canonicalizeManagedOpenCodeHandoffRecord(raw))
      .digest('base64url')).not.toBe(raw.mac);

    childCredential.fill(0);
    recordMacKey.fill(0);
  });

  it('requires a binary master secret and does not touch fake child side effects', async () => {
    const store = createInMemoryCasStore({ now: () => 1_000 });
    const child = createFakeChild();
    expect(() => createManagedOpenCodeHandoffProtocol({
      store,
      verifyProcess: child.verifyProcess,
      verifyAuthenticatedHealth: child.verifyAuthenticatedHealth,
    })).toThrow('binary master secret');
    expect(() => createManagedOpenCodeHandoffProtocol({
      masterSecret: Buffer.alloc(31),
      store,
      verifyProcess: child.verifyProcess,
      verifyAuthenticatedHealth: child.verifyAuthenticatedHealth,
    })).toThrow('at least 32 bytes');

    const fixture = createFixture({ child });
    const { handoff } = await prepareHandoff(fixture);
    await fixture.protocol.claim({
      incarnation: handoff.record.incarnation,
      expectedRevision: handoff.record.revision,
      claimant: 'web-runtime-1',
      claimCapability: createClaimCapability(),
    });

    for (const sideEffect of [child.spawn, child.kill, child.listen, child.connect, child.readSecret, child.writeSecret]) {
      expect(sideEffect).not.toHaveBeenCalled();
    }
  });
});
