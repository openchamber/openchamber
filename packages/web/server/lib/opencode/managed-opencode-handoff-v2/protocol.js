import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  canonicalizeManagedOpenCodeHandoffV2Record,
  isManagedOpenCodeHandoffV2Incarnation,
  MANAGED_OPENCODE_HANDOFF_V2_ALLOWED_TRANSITIONS,
  MANAGED_OPENCODE_HANDOFF_V2_INCARNATION_BYTES,
  MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES,
  MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS,
  MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION,
  ManagedOpenCodeHandoffV2State,
  normalizeManagedOpenCodeHandoffV2ProcessIdentity,
  normalizeManagedOpenCodeHandoffV2OwnerIdentity,
  normalizeManagedOpenCodeHandoffV2Record,
  normalizeManagedOpenCodeHandoffV2LaunchSpec,
  toPublicManagedOpenCodeHandoffV2Record,
} from './record.js';

const MANAGED_OPENCODE_HANDOFF_V2_DEFAULT_LEASE_MS = 5 * 60 * 1000;

const ZERO_MAC = Buffer.alloc(MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES).toString('base64url');

const failed = (reason) => ({ ok: false, reason });
const succeeded = (record, extra = {}) => ({
  ok: true,
  record: toPublicManagedOpenCodeHandoffV2Record(record),
  ...extra,
});
const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const normalizeLease = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS ? value : null;
const isExpiredRecoveryState = (state) => state === ManagedOpenCodeHandoffV2State.Stopping
  || state === ManagedOpenCodeHandoffV2State.HandoffPrepared;

const nextRevision = (record) =>
  record.revision < Number.MAX_SAFE_INTEGER ? record.revision + 1 : null;

const expectedRecord = (record) => ({
  revision: record.revision,
  mac: record.mac,
  leaseExpiresAt: record.leaseExpiresAt,
});

/**
 * Storage- and lifecycle-agnostic v2 foundation. It intentionally does not
 * spawn/reap children or expose handoff/adoption operations; callers inject a
 * store with cross-process atomic CAS and deliver credentials through a
 * post-CAS callback.
 */
export const createManagedOpenCodeHandoffV2Protocol = ({
  secretProvider,
  store,
  now = () => Date.now(),
  defaultLeaseMs = MANAGED_OPENCODE_HANDOFF_V2_DEFAULT_LEASE_MS,
} = {}) => {
  if (
    !secretProvider
    || typeof secretProvider.deriveRecordMacKey !== 'function'
    || typeof secretProvider.getLifecycleCredentialFingerprint !== 'function'
    || typeof secretProvider.issueLifecycleCredential !== 'function'
  ) {
    throw new TypeError('Managed OpenCode handoff v2 protocol requires a secret provider');
  }
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSwap !== 'function') {
    throw new TypeError('Managed OpenCode handoff v2 protocol requires an atomic record store');
  }
  if (typeof now !== 'function') {
    throw new TypeError('Managed OpenCode handoff v2 protocol requires a clock function');
  }

  const configuredDefaultLease = normalizeLease(defaultLeaseMs);
  if (!configuredDefaultLease) {
    throw new TypeError('Managed OpenCode handoff v2 protocol received an invalid default lease');
  }

  const inFlightLaunchMaterials = new Map();

  const nowMs = () => {
    try {
      const value = now();
      return isSafeNonNegativeInteger(value) ? value : null;
    } catch {
      return null;
    }
  };

  const withRecordMacKey = async (incarnation, useKey) => {
    let key;
    try {
      key = await secretProvider.deriveRecordMacKey({ incarnation });
      if (!Buffer.isBuffer(key) || key.length !== MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES) {
        throw new Error('Managed OpenCode handoff v2 record MAC key is invalid');
      }
      return await useKey(key);
    } finally {
      key?.fill(0);
    }
  };

  const signRecordWithKey = (record, key) => {
    const unsigned = normalizeManagedOpenCodeHandoffV2Record({ ...record, mac: ZERO_MAC });
    if (!unsigned) throw new TypeError('Invalid managed OpenCode handoff v2 record');
    let mac;
    try {
      mac = createHmac('sha256', key)
        .update(canonicalizeManagedOpenCodeHandoffV2Record(unsigned))
        .digest();
      return { ...unsigned, mac: mac.toString('base64url') };
    } finally {
      mac?.fill(0);
    }
  };

  const calculateMac = async (record) => withRecordMacKey(
    record.incarnation,
    (key) => createHmac('sha256', key)
      .update(canonicalizeManagedOpenCodeHandoffV2Record(record))
      .digest(),
  );

  const signRecord = async (record) => withRecordMacKey(
    record.incarnation,
    (key) => signRecordWithKey(record, key),
  );

  const verifySignedRecord = async (record) => {
    const normalized = normalizeManagedOpenCodeHandoffV2Record(record);
    if (!normalized) return null;

    let provided;
    let expected;
    try {
      provided = Buffer.from(normalized.mac, 'base64url');
      expected = await calculateMac(normalized);
      if (provided.length !== expected.length) return null;
      return timingSafeEqual(provided, expected) ? normalized : null;
    } catch {
      return null;
    } finally {
      provided?.fill(0);
      expected?.fill(0);
    }
  };

  const readRawRecord = async (incarnation) => {
    try {
      return { ok: true, value: await store.read({ incarnation }) };
    } catch {
      return failed('store-read-failed');
    }
  };

  const loadRecord = async (incarnation, { allowExpired = false } = {}) => {
    if (!isManagedOpenCodeHandoffV2Incarnation(incarnation)) {
      return failed('invalid-incarnation');
    }
    const loaded = await readRawRecord(incarnation);
    if (!loaded.ok) return loaded;
    if (loaded.value === null) return failed('record-absent');

    const record = await verifySignedRecord(loaded.value);
    if (!record) return failed('record-invalid');
    if (record.incarnation !== incarnation) return failed('record-key-mismatch');
    const current = nowMs();
    if (current === null) return failed('clock-invalid');
    if (current >= record.leaseExpiresAt) {
      revokeInFlightLaunchMaterial(incarnation);
      if (!allowExpired || !isExpiredRecoveryState(record.state)) return failed('record-expired');
      return { ok: true, record, expired: true };
    }
    return { ok: true, record };
  };

  const compareAndSwap = async ({ incarnation, expected, next, nextForAuthoritativeTime, allowExpired = false }) => {
    try {
      const input = { incarnation, expected };
      if (next !== undefined) input.next = { ...next };
      if (nextForAuthoritativeTime !== undefined) {
        input.nextForAuthoritativeTime = nextForAuthoritativeTime;
      }
      if (allowExpired) input.allowExpired = true;
      const result = await store.compareAndSwap(input);
      if (!result || Object.keys(result).length !== 1) return failed('compare-and-swap-failed');
      if (result.status === 'applied') return { ok: true };
      if (result.status === 'conflict') return failed('compare-and-swap-conflict');
      if (result.status === 'expired') return failed('record-expired');
      return failed('compare-and-swap-failed');
    } catch {
      return failed('compare-and-swap-failed');
    }
  };

  const revokeInFlightLaunchMaterial = (incarnation, expectedMaterial) => {
    const entry = inFlightLaunchMaterials.get(incarnation);
    if (!entry || (expectedMaterial !== undefined && entry.material !== expectedMaterial)) return false;
    inFlightLaunchMaterials.delete(incarnation);
    clearTimeout(entry.expiryTimer);
    entry.material.dispose();
    return true;
  };

  const getInFlightLaunchMaterialAuthority = (incarnation, material, record) => {
    const entry = inFlightLaunchMaterials.get(incarnation);
    if (
      !entry
      || entry.material !== material
      || entry.state !== record.state
      || entry.revision !== record.revision
      || entry.expiresAt !== record.leaseExpiresAt
    ) {
      return failed('launch-fence-lost');
    }

    const current = nowMs();
    if (current === null) {
      revokeInFlightLaunchMaterial(incarnation, material);
      return failed('clock-invalid');
    }
    if (current >= entry.expiresAt) {
      revokeInFlightLaunchMaterial(incarnation, material);
      return failed('record-expired');
    }
    return { ok: true };
  };

  const armInFlightLaunchMaterial = (incarnation, material, record) => {
    if (inFlightLaunchMaterials.has(incarnation)) return failed('launch-fence-lost');
    const entry = {
      material,
      state: record.state,
      revision: record.revision,
      expiresAt: record.leaseExpiresAt,
      expiryTimer: null,
    };
    inFlightLaunchMaterials.set(incarnation, entry);
    const authority = getInFlightLaunchMaterialAuthority(incarnation, material, record);
    if (!authority.ok) return authority;

    const current = nowMs();
    if (current === null) {
      revokeInFlightLaunchMaterial(incarnation, material);
      return failed('clock-invalid');
    }
    if (current >= entry.expiresAt) {
      revokeInFlightLaunchMaterial(incarnation, material);
      return failed('record-expired');
    }
    const delay = entry.expiresAt - current;
    const expiryTimer = setTimeout(
      () => revokeInFlightLaunchMaterial(incarnation, material),
      delay,
    );
    expiryTimer.unref?.();
    entry.expiryTimer = expiryTimer;
    return { ok: true };
  };

  const verifyLaunchDeliveryFence = async (record, material) => {
    const authority = getInFlightLaunchMaterialAuthority(record.incarnation, material, record);
    if (!authority.ok) return authority;
    const loaded = await loadRecord(record.incarnation);
    if (!loaded.ok) {
      revokeInFlightLaunchMaterial(record.incarnation, material);
      return loaded;
    }
    if (
      loaded.record.state !== record.state
      || loaded.record.revision !== record.revision
      || loaded.record.mac !== record.mac
      || loaded.record.leaseExpiresAt !== record.leaseExpiresAt
    ) {
      revokeInFlightLaunchMaterial(record.incarnation, material);
      return failed('launch-fence-lost');
    }
    return getInFlightLaunchMaterialAuthority(record.incarnation, material, record);
  };

  const transition = async ({ incarnation, expectedRevision, nextState, allowExpired = false }) => {
    if (!isSafeNonNegativeInteger(expectedRevision)) return failed('invalid-revision');
    const loaded = await loadRecord(incarnation, { allowExpired });
    if (!loaded.ok) return loaded;
    const record = loaded.record;
    if (record.revision !== expectedRevision) return failed('stale-revision');
    if (record.state === ManagedOpenCodeHandoffV2State.LaunchDelivering) {
      return failed('launch-delivery-fenced');
    }
    if (!MANAGED_OPENCODE_HANDOFF_V2_ALLOWED_TRANSITIONS[record.state].includes(nextState)) {
      return failed('illegal-transition');
    }
    if (
      loaded.expired
      && (!allowExpired
        || ![
          ManagedOpenCodeHandoffV2State.Stopping,
          ManagedOpenCodeHandoffV2State.Retired,
        ].includes(nextState))
    ) {
      return failed('record-expired');
    }

    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');
    let next;
    try {
      next = await signRecord({ ...record, state: nextState, revision });
    } catch {
      return failed('record-sign-failed');
    }
    const stored = await compareAndSwap({
      incarnation: record.incarnation,
      expected: expectedRecord(record),
      next,
      allowExpired,
    });
    if (!stored.ok) return stored;
    if (
      nextState === ManagedOpenCodeHandoffV2State.Interrupted
      || nextState === ManagedOpenCodeHandoffV2State.Stopping
      || nextState === ManagedOpenCodeHandoffV2State.Retired
    ) {
      revokeInFlightLaunchMaterial(record.incarnation);
    }
    return succeeded(next);
  };

  const interruptKnownLaunchRecord = async (record) => {
    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');
    let interrupted;
    try {
      interrupted = await signRecord({
        ...record,
        state: ManagedOpenCodeHandoffV2State.Interrupted,
        revision,
      });
    } catch {
      return failed('record-sign-failed');
    }
    const stored = await compareAndSwap({
      incarnation: record.incarnation,
      expected: expectedRecord(record),
      next: interrupted,
    });
    if (stored.ok) revokeInFlightLaunchMaterial(record.incarnation);
    return stored;
  };

  const reserveLaunch = async ({ leaseMs = configuredDefaultLease, owner, launchSpec = null } = {}) => {
    const lease = normalizeLease(leaseMs);
    if (!lease) return failed('invalid-lease');
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {});
    if (!normalizedOwner) {
      return failed('invalid-owner-identity');
    }
    const normalizedLaunchSpec = normalizeManagedOpenCodeHandoffV2LaunchSpec(launchSpec);
    if (launchSpec !== null && !normalizedLaunchSpec) return failed('invalid-launch-spec');

    let incarnationBytes;
    let incarnation;
    let record;
    try {
      incarnationBytes = randomBytes(MANAGED_OPENCODE_HANDOFF_V2_INCARNATION_BYTES);
      incarnation = incarnationBytes.toString('base64url');
      const credentialFingerprint = await secretProvider.getLifecycleCredentialFingerprint({ incarnation });
      const stored = await withRecordMacKey(incarnation, async (key) => compareAndSwap({
        incarnation,
        expected: null,
        nextForAuthoritativeTime: (authoritativeNow) => {
          if (authoritativeNow > Number.MAX_SAFE_INTEGER - lease) {
            throw new Error('Managed OpenCode handoff v2 lease overflows the clock');
          }
          record = signRecordWithKey({
            v: MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION,
            state: ManagedOpenCodeHandoffV2State.Reserved,
            incarnation,
            ...normalizedOwner,
            launchSpec: normalizedLaunchSpec,
            credentialFingerprint,
            pid: null,
            port: null,
            processStartTicks: null,
            createdAt: authoritativeNow,
            leaseExpiresAt: authoritativeNow + lease,
            revision: 0,
          }, key);
          return record;
        },
      }));
      return stored.ok && record ? succeeded(record) : stored;
    } catch {
      return failed('reservation-failed');
    } finally {
      incarnationBytes?.fill(0);
    }
  };

  const beginLaunch = async ({ incarnation, expectedRevision, withCredential } = {}) => {
    if (!isSafeNonNegativeInteger(expectedRevision)) return failed('invalid-revision');
    if (typeof withCredential !== 'function') return failed('invalid-launch-callback');
    const loaded = await loadRecord(incarnation);
    if (!loaded.ok) return loaded;
    const record = loaded.record;
    if (record.state !== ManagedOpenCodeHandoffV2State.Reserved) return failed('launch-not-allowed');
    if (record.revision !== expectedRevision) return failed('stale-revision');

    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');
    let delivery;
    try {
      delivery = await signRecord({
        ...record,
        state: ManagedOpenCodeHandoffV2State.LaunchDelivering,
        revision,
      });
    } catch {
      return failed('record-sign-failed');
    }
    let material;
    let deliveryApplied = false;
    try {
      material = await secretProvider.issueLifecycleCredential({ incarnation: record.incarnation });
      if (material?.fingerprint !== record.credentialFingerprint || typeof material.withCredential !== 'function') {
        throw new Error('Managed OpenCode handoff v2 lifecycle material is invalid');
      }

      const armed = armInFlightLaunchMaterial(record.incarnation, material, delivery);
      if (!armed.ok) return armed;
      const stored = await compareAndSwap({
        incarnation: record.incarnation,
        expected: expectedRecord(record),
        next: delivery,
      });
      if (!stored.ok) return stored;
      deliveryApplied = true;

      const deliveryFence = await verifyLaunchDeliveryFence(delivery, material);
      if (!deliveryFence.ok) {
        await interruptKnownLaunchRecord(delivery);
        return deliveryFence;
      }

      await material.withCredential(async (credential) => {
        const authority = getInFlightLaunchMaterialAuthority(record.incarnation, material, delivery);
        if (!authority.ok) {
          const error = new Error('Managed OpenCode handoff v2 launch delivery fence was lost');
          error.launchFenceReason = authority.reason;
          throw error;
        }
        return withCredential(credential);
      });

      const completionFence = await verifyLaunchDeliveryFence(delivery, material);
      if (!completionFence.ok) {
        await interruptKnownLaunchRecord(delivery);
        return completionFence;
      }

      const launchingRevision = nextRevision(delivery);
      if (launchingRevision === null) return failed('revision-exhausted');
      const launching = await signRecord({
        ...delivery,
        state: ManagedOpenCodeHandoffV2State.Launching,
        revision: launchingRevision,
      });
      const completed = await compareAndSwap({
        incarnation: delivery.incarnation,
        expected: expectedRecord(delivery),
        next: launching,
      });
      return completed.ok ? succeeded(launching) : completed;
    } catch (error) {
      if (deliveryApplied) await interruptKnownLaunchRecord(delivery);
      if (typeof error?.launchFenceReason === 'string') {
        return failed(error.launchFenceReason);
      }
      return failed('launch-callback-failed');
    } finally {
      if (inFlightLaunchMaterials.get(record.incarnation)?.material === material) {
        revokeInFlightLaunchMaterial(record.incarnation);
      } else {
        material?.dispose();
      }
    }
  };

  const bindSpawnedProcess = async ({ incarnation, expectedRevision, identity, owner, launchSpec } = {}) => {
    if (!isSafeNonNegativeInteger(expectedRevision)) return failed('invalid-revision');
    const normalizedIdentity = normalizeManagedOpenCodeHandoffV2ProcessIdentity(identity);
    if (!normalizedIdentity) return failed('invalid-process-identity');
    const loaded = await loadRecord(incarnation);
    if (!loaded.ok) return loaded;
    const record = loaded.record;
    if (record.state !== ManagedOpenCodeHandoffV2State.Launching) return failed('bind-not-allowed');
    if (record.revision !== expectedRevision) return failed('stale-revision');

    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {
      ownerInstanceId: record.ownerInstanceId,
      runtimeIdentity: record.runtimeIdentity,
      launchFingerprint: record.launchFingerprint,
    });
    if (!normalizedOwner) {
      return failed('invalid-owner-identity');
    }
    const normalizedLaunchSpec = normalizeManagedOpenCodeHandoffV2LaunchSpec(launchSpec ?? record.launchSpec);
    if ((launchSpec !== undefined && launchSpec !== null && !normalizedLaunchSpec)
      || (record.launchSpec !== null && !normalizedLaunchSpec)) {
      return failed('invalid-launch-spec');
    }
    if (
      record.ownerInstanceId !== null
      && (record.ownerInstanceId !== normalizedOwner.ownerInstanceId
        || record.runtimeIdentity !== normalizedOwner.runtimeIdentity
        || record.launchFingerprint !== normalizedOwner.launchFingerprint)
    ) {
      return failed('owner-identity-mismatch');
    }

    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');
    let next;
    try {
      next = await signRecord({
        ...record,
        ...normalizedOwner,
        launchSpec: normalizedLaunchSpec,
        ...normalizedIdentity,
        state: ManagedOpenCodeHandoffV2State.Active,
        revision,
      });
    } catch {
      return failed('record-sign-failed');
    }
    const stored = await compareAndSwap({
      incarnation: record.incarnation,
      expected: expectedRecord(record),
      next,
    });
    return stored.ok ? succeeded(next) : stored;
  };

  const renewLease = async ({ incarnation, expectedRevision, leaseMs = configuredDefaultLease } = {}) => {
    if (!isSafeNonNegativeInteger(expectedRevision)) return failed('invalid-revision');
    const lease = normalizeLease(leaseMs);
    if (!lease) return failed('invalid-lease');

    const loaded = await loadRecord(incarnation);
    if (!loaded.ok) return loaded;
    const record = loaded.record;
    if (record.state !== ManagedOpenCodeHandoffV2State.Active) return failed('lease-not-renewable');
    if (record.revision !== expectedRevision) return failed('stale-revision');
    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');

    let next;
    try {
      const stored = await withRecordMacKey(record.incarnation, async (key) => compareAndSwap({
        incarnation: record.incarnation,
        expected: expectedRecord(record),
        nextForAuthoritativeTime: (authoritativeNow) => {
          if (authoritativeNow > Number.MAX_SAFE_INTEGER - lease) {
            throw new Error('Managed OpenCode handoff v2 lease overflows the clock');
          }
          next = signRecordWithKey({
            ...record,
            leaseExpiresAt: authoritativeNow + lease,
            revision,
          }, key);
          return next;
        },
      }));
      return stored.ok && next ? succeeded(next) : stored;
    } catch {
      return failed('record-sign-failed');
    }
  };

  // A handoff-prepared record represents a still-bound child.  If the
  // guardian was down long enough for its lease to expire, an authenticated
  // recovery inspection may re-establish an active lease after the caller has
  // independently verified that child.  This is intentionally narrower than
  // normal renewal: it cannot revive an arbitrary expired state.
  const recoverExpiredHandoff = async ({
    incarnation,
    expectedRevision,
    leaseMs = configuredDefaultLease,
  } = {}) => {
    if (!isSafeNonNegativeInteger(expectedRevision)) return failed('invalid-revision');
    const lease = normalizeLease(leaseMs);
    if (!lease) return failed('invalid-lease');

    const loaded = await loadRecord(incarnation, { allowExpired: true });
    if (!loaded.ok) return loaded;
    if (!loaded.expired || loaded.record.state !== ManagedOpenCodeHandoffV2State.HandoffPrepared) {
      return failed('handoff-recovery-not-allowed');
    }
    const record = loaded.record;
    if (record.revision !== expectedRevision) return failed('stale-revision');
    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');

    let next;
    try {
      const stored = await withRecordMacKey(record.incarnation, async (key) => compareAndSwap({
        incarnation: record.incarnation,
        expected: expectedRecord(record),
        allowExpired: true,
        nextForAuthoritativeTime: (authoritativeNow) => {
          if (authoritativeNow > Number.MAX_SAFE_INTEGER - lease) {
            throw new Error('Managed OpenCode handoff v2 lease overflows the clock');
          }
          next = signRecordWithKey({
            ...record,
            state: ManagedOpenCodeHandoffV2State.Active,
            leaseExpiresAt: authoritativeNow + lease,
            revision,
          }, key);
          return next;
        },
      }));
      return stored.ok && next ? succeeded(next) : stored;
    } catch {
      return failed('handoff-recovery-failed');
    }
  };

  return Object.freeze({
    reserveLaunch,
    beginLaunch,
    bindSpawnedProcess,
    renewLease,
    readRecord: async ({ incarnation, allowExpired = false } = {}) => {
      const loaded = await loadRecord(incarnation, { allowExpired });
      return loaded.ok ? succeeded(loaded.record) : loaded;
    },
    verifyRecord: async (record, { allowExpired = false } = {}) => {
      const verified = await verifySignedRecord(record);
      if (!verified) return failed('record-invalid');
      const current = nowMs();
      if (current === null) return failed('clock-invalid');
      if (current >= verified.leaseExpiresAt) {
        if (!allowExpired || !isExpiredRecoveryState(verified.state)) return failed('record-expired');
        return succeeded(verified, { expired: true });
      }
      return succeeded(verified);
    },
    markInterrupted: (input = {}) => transition({
      ...input,
      nextState: ManagedOpenCodeHandoffV2State.Interrupted,
    }),
    beginStopping: (input = {}) => transition({
      ...input,
      nextState: ManagedOpenCodeHandoffV2State.Stopping,
    }),
    abortHandoff: (input = {}) => transition({
      ...input,
      nextState: ManagedOpenCodeHandoffV2State.Active,
    }),
    retire: (input = {}) => transition({
      ...input,
      nextState: ManagedOpenCodeHandoffV2State.Retired,
    }),
    recoverExpiredHandoff,
  });
};
