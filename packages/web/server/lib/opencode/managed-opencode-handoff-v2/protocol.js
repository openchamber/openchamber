import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  canonicalizeManagedOpenCodeHandoffV2Record,
  canonicalizeManagedOpenCodeHandoffV2Operation,
  isManagedOpenCodeHandoffV2Incarnation,
  isManagedOpenCodeHandoffV2OperationId,
  MANAGED_OPENCODE_HANDOFF_V2_ALLOWED_TRANSITIONS,
  MANAGED_OPENCODE_HANDOFF_V2_INCARNATION_BYTES,
  MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES,
  MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS,
  MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION,
  ManagedOpenCodeHandoffV2State,
  ManagedOpenCodeHandoffV2OperationKind,
  ManagedOpenCodeHandoffV2OperationState,
  normalizeManagedOpenCodeHandoffV2ProcessIdentity,
  normalizeManagedOpenCodeHandoffV2Operation,
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
  // The authenticated public record intentionally exposes only public
  // authority fields.  The MAC is one of those fields: lifecycle recovery
  // must be able to compare a persisted ambiguity fence against the exact
  // authenticated record it reconciles, rather than treating a missing MAC
  // as a wildcard.
  record: {
    ...toPublicManagedOpenCodeHandoffV2Record(record),
    mac: record.mac,
  },
  ...extra,
});
const succeededOperation = (operation, extra = {}) => ({
  ok: true,
  operation: { ...operation },
  ...extra,
});
const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const normalizeLease = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS ? value : null;
const isExpiredRecoveryState = (state) => state === ManagedOpenCodeHandoffV2State.Reserved
  || state === ManagedOpenCodeHandoffV2State.Stopping
  || state === ManagedOpenCodeHandoffV2State.HandoffPrepared
  || state === ManagedOpenCodeHandoffV2State.Interrupted
  || state === ManagedOpenCodeHandoffV2State.Retired;

const nextRevision = (record) =>
  record.revision < Number.MAX_SAFE_INTEGER ? record.revision + 1 : null;

const expectedRecord = (record) => ({
  revision: record.revision,
  mac: record.mac,
  leaseExpiresAt: record.leaseExpiresAt,
});
const expectedOperation = (operation) => ({
  revision: operation.revision,
  mac: operation.mac,
  confirmationExpiresAt: operation.confirmationExpiresAt,
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

  const signOperationWithKey = (operation, key) => {
    const unsigned = normalizeManagedOpenCodeHandoffV2Operation({ ...operation, mac: ZERO_MAC });
    if (!unsigned) throw new TypeError('Invalid managed OpenCode handoff v2 operation');
    const mac = createHmac('sha256', key)
      .update(canonicalizeManagedOpenCodeHandoffV2Operation(unsigned))
      .digest();
    try {
      return { ...unsigned, mac: mac.toString('base64url') };
    } finally {
      mac.fill(0);
    }
  };

  const signOperation = async (operation) => withRecordMacKey(
    operation.incarnation,
    (key) => signOperationWithKey(operation, key),
  );

  const verifySignedOperation = async (operation) => {
    const normalized = normalizeManagedOpenCodeHandoffV2Operation(operation);
    if (!normalized) return null;
    let provided;
    let expected;
    try {
      provided = Buffer.from(normalized.mac, 'base64url');
      expected = await withRecordMacKey(normalized.incarnation, (key) => createHmac('sha256', key)
        .update(canonicalizeManagedOpenCodeHandoffV2Operation(normalized))
        .digest());
      return provided.length === expected.length && timingSafeEqual(provided, expected) ? normalized : null;
    } catch {
      return null;
    } finally {
      provided?.fill(0);
      expected?.fill(0);
    }
  };

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

  const compareAndSwapOperation = async ({ operationId, expected, next, nextForAuthoritativeTime, allowExpired = false }) => {
    try {
      if (typeof store.compareAndSwapOperation !== 'function') return failed('operation-store-unavailable');
      const input = { operationId, expected };
      if (next !== undefined) input.next = { ...next };
      if (nextForAuthoritativeTime !== undefined) input.nextForAuthoritativeTime = nextForAuthoritativeTime;
      if (allowExpired) input.allowExpired = true;
      const result = await store.compareAndSwapOperation(input);
      if (!result || Object.keys(result).length !== 1) return failed('operation-compare-and-swap-failed');
      if (result.status === 'applied') return { ok: true };
      if (result.status === 'conflict') return failed('operation-compare-and-swap-conflict');
      if (result.status === 'expired') return failed('operation-expired');
      return failed('operation-compare-and-swap-failed');
    } catch {
      return failed('operation-compare-and-swap-failed');
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
          ManagedOpenCodeHandoffV2State.Interrupted,
          ManagedOpenCodeHandoffV2State.Stopping,
          ManagedOpenCodeHandoffV2State.Retired,
        ].includes(nextState))
    ) {
      return failed('record-expired');
    }

    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');
    const terminal = nextState === ManagedOpenCodeHandoffV2State.Interrupted
      || nextState === ManagedOpenCodeHandoffV2State.Retired;
    let next;
    let stored;
    try {
      if (terminal) {
        // A lost stop/cleanup response is reconciled after the child has left
        // #children. Keep the signed terminal row available for that H5 fence
        // instead of allowing the original launch lease to expire immediately
        // after terminalization. The lease is extended from authoritative store
        // time and never shortened, so cleanup can still prune the row once the
        // retained confirmation horizon has elapsed.
        stored = await withRecordMacKey(record.incarnation, async (key) => compareAndSwap({
          incarnation: record.incarnation,
          expected: expectedRecord(record),
          allowExpired,
          nextForAuthoritativeTime: (authoritativeNow) => {
            if (authoritativeNow > Number.MAX_SAFE_INTEGER - configuredDefaultLease) {
              throw new Error('Managed OpenCode handoff v2 terminal lease overflows the clock');
            }
            next = signRecordWithKey({
              ...record,
              state: nextState,
              revision,
              leaseExpiresAt: Math.max(
                record.leaseExpiresAt,
                authoritativeNow + configuredDefaultLease,
              ),
            }, key);
            return next;
          },
        }));
      } else {
        next = await signRecord({ ...record, state: nextState, revision });
        stored = await compareAndSwap({
          incarnation: record.incarnation,
          expected: expectedRecord(record),
          next,
          allowExpired,
        });
      }
    } catch {
      return failed('record-sign-failed');
    }
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

  // Confirm an already-observed record through the store's authoritative
  // transaction. This deliberately writes the same authenticated record: the
  // CAS predicate proves that revision, lease, and MAC still match at the
  // transaction boundary without inventing a lifecycle transition.
  const confirmRecord = async ({
    incarnation,
    expectedRevision,
    expectedLeaseExpiresAt,
    expectedMac,
    allowExpired = false,
  } = {}) => {
    if (!isSafeNonNegativeInteger(expectedRevision)
      || !isSafeNonNegativeInteger(expectedLeaseExpiresAt)
      || typeof expectedMac !== 'string'
      || expectedMac.length === 0) {
      return failed('invalid-record-binding');
    }
    const loaded = await loadRecord(incarnation, { allowExpired });
    if (!loaded.ok) return loaded;
    const record = loaded.record;
    if (record.revision !== expectedRevision
      || record.leaseExpiresAt !== expectedLeaseExpiresAt
      || record.mac !== expectedMac) {
      return failed('record-binding-changed');
    }
    const stored = await compareAndSwap({
      incarnation: record.incarnation,
      expected: expectedRecord(record),
      next: record,
      allowExpired,
    });
    return stored.ok ? succeeded(record) : stored;
  };

  const operationStoreAvailable = typeof store.readOperation === 'function'
    && typeof store.compareAndSwapOperation === 'function';

  const loadOperation = async (operationId, { allowExpired = false } = {}) => {
    if (!operationStoreAvailable || !isManagedOpenCodeHandoffV2OperationId(operationId)) {
      return failed('operation-store-unavailable');
    }
    let raw;
    try {
      raw = await store.readOperation({ operationId });
    } catch {
      return failed('operation-read-failed');
    }
    if (raw === null) return failed('operation-absent');
    const operation = await verifySignedOperation(raw);
    if (!operation) return failed('operation-invalid');
    const current = nowMs();
    if (current === null) return failed('clock-invalid');
    if (current >= operation.confirmationExpiresAt) {
      if (!allowExpired) return failed('operation-expired');
      return { ok: true, operation, expired: true };
    }
    return { ok: true, operation };
  };

  const createOperation = async ({
    operationId,
    kind,
    incarnation,
    owner,
    target,
    horizonMs = configuredDefaultLease,
  } = {}) => {
    if (!operationStoreAvailable || !isManagedOpenCodeHandoffV2OperationId(operationId)) return failed('operation-store-unavailable');
    if (!Object.values(ManagedOpenCodeHandoffV2OperationKind).includes(kind)
      || !isManagedOpenCodeHandoffV2Incarnation(incarnation)) return failed('invalid-operation');
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity(owner ?? {});
    if (!normalizedOwner || Object.values(normalizedOwner).some((value) => value === null)) return failed('invalid-operation-owner');
    const binding = normalizeManagedOpenCodeHandoffV2Record({
      v: MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION,
      state: ManagedOpenCodeHandoffV2State.Active,
      incarnation,
      ...normalizedOwner,
      launchSpec: null,
      credentialFingerprint: ZERO_MAC,
      pid: 1,
      port: 1,
      processStartTicks: '0',
      createdAt: 0,
      leaseExpiresAt: 1,
      revision: target?.revision,
      mac: target?.mac,
    });
    if (!binding || !Number.isSafeInteger(target?.revision)
      || !Number.isSafeInteger(target?.leaseExpiresAt)
      || typeof target.mac !== 'string' || target.mac.length === 0) return failed('invalid-operation-binding');
    const horizon = normalizeLease(horizonMs);
    if (!horizon) return failed('invalid-operation-horizon');
    let operation;
    try {
      const stored = await withRecordMacKey(incarnation, async (key) => compareAndSwapOperation({
        operationId,
        expected: null,
        nextForAuthoritativeTime: (authoritativeNow) => {
          if (authoritativeNow > Number.MAX_SAFE_INTEGER - horizon) throw new Error('operation horizon overflows the clock');
          operation = signOperationWithKey({
            v: MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION,
            operationId,
            kind,
            incarnation,
            ...normalizedOwner,
            targetRevision: target.revision,
            targetLeaseExpiresAt: target.leaseExpiresAt,
            targetMac: target.mac,
            state: ManagedOpenCodeHandoffV2OperationState.Pending,
            resolutionState: null,
            resolutionRevision: null,
            resolutionLeaseExpiresAt: null,
            resolutionMac: null,
            createdAt: authoritativeNow,
            confirmationExpiresAt: authoritativeNow + horizon,
            revision: 0,
          }, key);
          return operation;
        },
      }));
      return stored.ok && operation ? succeededOperation(operation) : stored;
    } catch {
      return failed('operation-create-failed');
    }
  };

  const resolveOperation = async ({
    operationId,
    expectedRevision,
    expectedConfirmationExpiresAt,
    expectedMac,
    resolutionState,
    resolution,
  } = {}) => {
    const resolutionBinding = resolution?.record ?? resolution;
    if (!Number.isSafeInteger(expectedRevision)
      || !Number.isSafeInteger(expectedConfirmationExpiresAt)
      || typeof expectedMac !== 'string'
      || expectedMac.length === 0
      || ![
        ManagedOpenCodeHandoffV2State.Active,
        ManagedOpenCodeHandoffV2State.HandoffPrepared,
        ManagedOpenCodeHandoffV2State.Interrupted,
        ManagedOpenCodeHandoffV2State.Retired,
      ].includes(resolutionState)
       || !Number.isSafeInteger(resolutionBinding?.revision)
       || !Number.isSafeInteger(resolutionBinding?.leaseExpiresAt)
       || typeof resolutionBinding?.mac !== 'string'
       || resolutionBinding.mac.length === 0) return failed('invalid-operation-resolution');
    // The confirmation horizon is only a point at which the operation must
    // become an explicit expired/unresolved state. It is not permission to
    // clear the side-effect fence. A guardian may resolve an expired row only
    // after it has supplied the exact signed terminal/active evidence and its
    // own quiescence checks.
    const loaded = await loadOperation(operationId, { allowExpired: true });
    if (!loaded.ok) return loaded;
    const operation = loaded.operation;
    if (loaded.expired && operation.state !== ManagedOpenCodeHandoffV2OperationState.Expired) {
      return failed('operation-expired');
    }
    if (operation.revision !== expectedRevision
      || operation.confirmationExpiresAt !== expectedConfirmationExpiresAt
      || operation.mac !== expectedMac
      || (operation.state !== ManagedOpenCodeHandoffV2OperationState.Pending
        && operation.state !== ManagedOpenCodeHandoffV2OperationState.Expired
        && !(operation.state === ManagedOpenCodeHandoffV2OperationState.Resolved
          && operation.resolutionState === ManagedOpenCodeHandoffV2State.Active
           && resolutionState !== ManagedOpenCodeHandoffV2State.Active))) return failed('operation-binding-changed');
    if (!Number.isSafeInteger(resolution?.target?.revision)
      || !Number.isSafeInteger(resolution.target.leaseExpiresAt)
      || typeof resolution.target.mac !== 'string'
      || resolution.target.revision !== operation.targetRevision
      || resolution.target.leaseExpiresAt !== operation.targetLeaseExpiresAt
      || resolution.target.mac !== operation.targetMac) {
      return failed('operation-target-binding-invalid');
    }

    // A resolution is not an arbitrary tuple supplied by the caller. It must
    // be the exact authenticated record that the guardian observed (or a
    // guardian-signed terminal record retained as the post-pruning horizon).
    // This prevents a missing target row, a wrong owner, or a forged MAC from
    // being interpreted as successful resolution.
    const resolutionRecord = resolutionBinding;
    const resolvedRecord = await verifySignedRecord(resolutionRecord);
    if (!resolvedRecord
      || resolvedRecord.incarnation !== operation.incarnation
      || resolvedRecord.ownerInstanceId !== operation.ownerInstanceId
      || resolvedRecord.runtimeIdentity !== operation.runtimeIdentity
      || resolvedRecord.launchFingerprint !== operation.launchFingerprint
      || resolvedRecord.state !== resolutionState
      || resolvedRecord.revision !== resolutionBinding.revision
      || resolvedRecord.leaseExpiresAt !== resolutionBinding.leaseExpiresAt
      || resolvedRecord.mac !== resolutionBinding.mac) {
      return failed('operation-resolution-binding-invalid');
    }

    const target = await loadRecord(operation.incarnation, { allowExpired: true });
    if (!target.ok && target.reason !== 'record-absent') {
      return failed(target.reason === 'store-read-failed'
        ? 'operation-target-read-failed'
        : 'operation-target-invalid');
    }
    if (target.ok && (
      target.record.ownerInstanceId !== operation.ownerInstanceId
      || target.record.runtimeIdentity !== operation.runtimeIdentity
      || target.record.launchFingerprint !== operation.launchFingerprint
      || target.record.revision !== resolvedRecord.revision
      || target.record.leaseExpiresAt !== resolvedRecord.leaseExpiresAt
      || target.record.mac !== resolvedRecord.mac
      || target.record.state !== resolvedRecord.state
    )) {
      return failed('operation-target-binding-changed');
    }
    if (!target.ok && ![
      ManagedOpenCodeHandoffV2State.Interrupted,
      ManagedOpenCodeHandoffV2State.Retired,
    ].includes(resolutionState)) {
      return failed('operation-target-absent');
    }
    const revision = nextRevision(operation);
    if (revision === null) return failed('revision-exhausted');
    let next;
    try {
      const stored = await withRecordMacKey(operation.incarnation, async (key) => compareAndSwapOperation({
        operationId,
        expected: expectedOperation(operation),
        allowExpired: loaded.expired === true,
        next: next = signOperationWithKey({
          ...operation,
          state: ManagedOpenCodeHandoffV2OperationState.Resolved,
          resolutionState,
           resolutionRevision: resolutionBinding.revision,
           resolutionLeaseExpiresAt: resolutionBinding.leaseExpiresAt,
           resolutionMac: resolutionBinding.mac,
          revision,
        }, key),
      }));
      return stored.ok && next ? succeededOperation(next) : stored;
    } catch {
      return failed('operation-resolution-failed');
    }
  };

  const expireOperation = async ({ operationId, expectedRevision, expectedConfirmationExpiresAt, expectedMac } = {}) => {
    const loaded = await loadOperation(operationId, { allowExpired: true });
    if (!loaded.ok) return loaded;
    const operation = loaded.operation;
    if (!loaded.expired || operation.state !== ManagedOpenCodeHandoffV2OperationState.Pending
      || operation.revision !== expectedRevision
      || operation.confirmationExpiresAt !== expectedConfirmationExpiresAt
      || operation.mac !== expectedMac) return failed('operation-not-expired');
    const revision = nextRevision(operation);
    if (revision === null) return failed('revision-exhausted');
    let next;
    try {
      const stored = await withRecordMacKey(operation.incarnation, async (key) => compareAndSwapOperation({
        operationId,
        expected: expectedOperation(operation),
        allowExpired: true,
        next: next = signOperationWithKey({
          ...operation,
          state: ManagedOpenCodeHandoffV2OperationState.Expired,
          revision,
        }, key),
      }));
      return stored.ok && next ? succeededOperation(next, { expired: true }) : stored;
    } catch {
      return failed('operation-expiry-failed');
    }
  };

  const confirmOperation = async ({ operationId, expectedRevision, expectedConfirmationExpiresAt, expectedMac, allowExpired = false } = {}) => {
    const loaded = await loadOperation(operationId, { allowExpired });
    if (!loaded.ok) return loaded;
    const operation = loaded.operation;
    if (operation.revision !== expectedRevision
      || operation.confirmationExpiresAt !== expectedConfirmationExpiresAt
      || operation.mac !== expectedMac) return failed('operation-binding-changed');
    const stored = await compareAndSwapOperation({
      operationId,
      expected: expectedOperation(operation),
      next: operation,
      allowExpired,
    });
    return stored.ok ? succeededOperation(operation, { expired: loaded.expired === true }) : stored;
  };

  const listOperations = async ({ owner } = {}) => {
    if (!operationStoreAvailable || typeof store.listOperations !== 'function') {
      return failed('operation-store-unavailable');
    }
    const hasOwnerScope = owner && typeof owner.ownerInstanceId === 'string'
      && owner.ownerInstanceId.length > 0
      && typeof owner.runtimeIdentity === 'string'
      && owner.runtimeIdentity.length > 0
      && (owner.launchFingerprint === undefined || typeof owner.launchFingerprint === 'string');
    const normalizedOwner = normalizeManagedOpenCodeHandoffV2OwnerIdentity({
      ownerInstanceId: owner?.ownerInstanceId ?? null,
      runtimeIdentity: owner?.runtimeIdentity ?? null,
      launchFingerprint: owner?.launchFingerprint ?? null,
    });
    if (!normalizedOwner || !hasOwnerScope) {
      return failed('invalid-operation-owner');
    }
    let rows;
    try {
      rows = await store.listOperations();
    } catch {
      return failed('operation-read-failed');
    }
    if (!Array.isArray(rows)) return failed('operation-read-failed');
    const operations = [];
    for (const row of rows) {
      const operation = await verifySignedOperation(row);
      if (!operation) return failed('operation-invalid');
      if (operation.ownerInstanceId === normalizedOwner.ownerInstanceId
        && operation.runtimeIdentity === normalizedOwner.runtimeIdentity
        && (owner.launchFingerprint === undefined || operation.launchFingerprint === owner.launchFingerprint)) {
        operations.push({ ...operation });
      }
    }
    return { ok: true, operations };
  };

  // Lifecycle admission is the one intentionally global operation view. It is
  // used only by the guardian to decide whether an unowned/legacy launch may
  // proceed; owner-scoped callers must continue to use listOperations().
  const listAllOperations = async () => {
    if (!operationStoreAvailable || typeof store.listOperations !== 'function') {
      return failed('operation-store-unavailable');
    }
    let rows;
    try {
      rows = await store.listOperations();
    } catch {
      return failed('operation-read-failed');
    }
    if (!Array.isArray(rows)) return failed('operation-read-failed');
    const operations = [];
    for (const row of rows) {
      const operation = await verifySignedOperation(row);
      if (!operation) return failed('operation-invalid');
      operations.push({ ...operation });
    }
    return { ok: true, operations };
  };

  return Object.freeze({
    reserveLaunch,
    beginLaunch,
    bindSpawnedProcess,
    renewLease,
    createOperation,
    readOperation: async ({ operationId, allowExpired = false } = {}) => {
      const loaded = await loadOperation(operationId, { allowExpired });
      return loaded.ok ? succeededOperation(loaded.operation, { expired: loaded.expired === true }) : loaded;
    },
    resolveOperation,
    expireOperation,
    confirmOperation,
    listOperations,
    listAllOperations,
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
    prepareHandoff: (input = {}) => transition({
      ...input,
      nextState: ManagedOpenCodeHandoffV2State.HandoffPrepared,
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
    confirmRecord,
  });
};
