import {
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const MANAGED_OPENCODE_HANDOFF_RECORD_VERSION = 1;
export const MANAGED_OPENCODE_HANDOFF_INCARNATION_BYTES = 32;
export const MANAGED_OPENCODE_HANDOFF_KEY_BYTES = 32;
export const MANAGED_OPENCODE_HANDOFF_DEFAULT_TTL_MS = 5 * 60 * 1000;

export const ManagedOpenCodeHandoffState = Object.freeze({
  LaunchPrepared: 'launch-prepared',
  Active: 'active',
  HandoffPrepared: 'handoff-prepared',
  Claimed: 'claimed',
  Stopping: 'stopping',
  Retired: 'retired',
});

export const MANAGED_OPENCODE_HANDOFF_ALLOWED_TRANSITIONS = Object.freeze({
  [ManagedOpenCodeHandoffState.LaunchPrepared]: Object.freeze([
    ManagedOpenCodeHandoffState.Active,
    ManagedOpenCodeHandoffState.Stopping,
  ]),
  [ManagedOpenCodeHandoffState.Active]: Object.freeze([
    ManagedOpenCodeHandoffState.HandoffPrepared,
    ManagedOpenCodeHandoffState.Stopping,
  ]),
  [ManagedOpenCodeHandoffState.HandoffPrepared]: Object.freeze([
    ManagedOpenCodeHandoffState.Claimed,
    ManagedOpenCodeHandoffState.Stopping,
  ]),
  [ManagedOpenCodeHandoffState.Claimed]: Object.freeze([
    ManagedOpenCodeHandoffState.Stopping,
  ]),
  [ManagedOpenCodeHandoffState.Stopping]: Object.freeze([
    ManagedOpenCodeHandoffState.Retired,
  ]),
  [ManagedOpenCodeHandoffState.Retired]: Object.freeze([]),
});

// These labels are intentionally distinct. The child credential is never a
// record-MAC key, even though both are derived from the same master secret.
export const MANAGED_OPENCODE_HANDOFF_CHILD_CREDENTIAL_HKDF_INFO =
  'openchamber/managed-opencode-handoff/v1/child-credential';
export const MANAGED_OPENCODE_HANDOFF_RECORD_MAC_HKDF_INFO =
  'openchamber/managed-opencode-handoff/v1/record-mac';
export const MANAGED_OPENCODE_HANDOFF_CLAIM_CAPABILITY_HKDF_INFO =
  'openchamber/managed-opencode-handoff/v1/claim-capability';

const RECORD_MAC_BYTES = 32;
const MAX_RECORD_TTL_MS = 24 * 60 * 60 * 1000;
const OPAQUE_AUTHORITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const RECORD_KEYS = Object.freeze([
  'v',
  'state',
  'incarnation',
  'fingerprint',
  'pid',
  'port',
  'createdAt',
  'expiresAt',
  'revision',
  'claimant',
  'claimCapabilityDigest',
  'mac',
]);
const IDENTITY_KEYS = Object.freeze([
  'pid',
  'port',
  'incarnation',
  'fingerprint',
]);
const ATTESTATION_KEYS = Object.freeze([
  'ok',
  'pid',
  'port',
  'incarnation',
  'fingerprint',
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactlyKeys = (value, expectedKeys) => {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length && expectedKeys.every((key) => Object.hasOwn(value, key));
};

const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isPid = (value) => Number.isSafeInteger(value) && value > 0;
const isPort = (value) => Number.isSafeInteger(value) && value > 0 && value <= 65535;
const isOpaqueAuthority = (value) => typeof value === 'string' && OPAQUE_AUTHORITY_PATTERN.test(value);

const decodeCanonicalBase64Url = (value, byteLength) => {
  if (typeof value !== 'string' || !BASE64_URL_PATTERN.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    if (decoded.length !== byteLength || decoded.toString('base64url') !== value) return null;
    return decoded;
  } catch {
    return null;
  }
};

const isCanonicalBase64Url = (value, byteLength) =>
  decodeCanonicalBase64Url(value, byteLength) !== null;

const isClaimCapability = (value) =>
  isCanonicalBase64Url(value, MANAGED_OPENCODE_HANDOFF_KEY_BYTES);

const isKnownState = (value) => Object.values(ManagedOpenCodeHandoffState).includes(value);

const hasClaimBinding = (record) => record.claimant !== null || record.claimCapabilityDigest !== null;

const normalizeRecord = (value) => {
  if (!hasExactlyKeys(value, RECORD_KEYS)) return null;
  if (value.v !== MANAGED_OPENCODE_HANDOFF_RECORD_VERSION || !isKnownState(value.state)) return null;
  if (!isCanonicalBase64Url(value.incarnation, MANAGED_OPENCODE_HANDOFF_INCARNATION_BYTES)) return null;
  if (!isCanonicalBase64Url(value.fingerprint, MANAGED_OPENCODE_HANDOFF_KEY_BYTES)) return null;
  if (!isPid(value.pid) || !isPort(value.port)) return null;
  if (!isSafeNonNegativeInteger(value.createdAt) || !isSafeNonNegativeInteger(value.expiresAt)) return null;
  if (value.expiresAt <= value.createdAt || !isSafeNonNegativeInteger(value.revision)) return null;
  if (!isCanonicalBase64Url(value.mac, RECORD_MAC_BYTES)) return null;

  const hasClaim = hasClaimBinding(value);
  if (
    hasClaim
    && (!isOpaqueAuthority(value.claimant)
      || !isCanonicalBase64Url(value.claimCapabilityDigest, MANAGED_OPENCODE_HANDOFF_KEY_BYTES))
  ) {
    return null;
  }
  if (!hasClaim && (value.claimant !== null || value.claimCapabilityDigest !== null)) return null;

  if (
    (value.state === ManagedOpenCodeHandoffState.LaunchPrepared
      || value.state === ManagedOpenCodeHandoffState.Active
      || value.state === ManagedOpenCodeHandoffState.HandoffPrepared)
    && hasClaim
  ) {
    return null;
  }
  if (value.state === ManagedOpenCodeHandoffState.Claimed && !hasClaim) return null;

  return {
    v: value.v,
    state: value.state,
    incarnation: value.incarnation,
    fingerprint: value.fingerprint,
    pid: value.pid,
    port: value.port,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    revision: value.revision,
    claimant: value.claimant,
    claimCapabilityDigest: value.claimCapabilityDigest,
    mac: value.mac,
  };
};

const canonicalizeAuthorityFields = (record) => Buffer.from(JSON.stringify([
  record.v,
  record.state,
  record.incarnation,
  record.fingerprint,
  record.pid,
  record.port,
  record.createdAt,
  record.expiresAt,
  record.revision,
  record.claimant,
  record.claimCapabilityDigest,
]), 'utf8');

/**
 * Returns the fixed-order bytes authenticated by a handoff record MAC. The
 * record MAC is intentionally omitted from its own authenticated payload.
 */
export const canonicalizeManagedOpenCodeHandoffRecord = (record) => {
  const normalized = normalizeRecord(record);
  if (!normalized) throw new TypeError('Invalid managed OpenCode handoff record');
  return canonicalizeAuthorityFields(normalized);
};

const toPublicRecord = (record) => ({
  v: record.v,
  state: record.state,
  incarnation: record.incarnation,
  fingerprint: record.fingerprint,
  pid: record.pid,
  port: record.port,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  revision: record.revision,
  claimant: record.claimant,
});

const cloneRecord = (record) => ({ ...record });
const failed = (reason) => ({ ok: false, reason });
const succeeded = (record) => ({ ok: true, record: toPublicRecord(record) });

const normalizeMasterSecret = (value) => {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw new TypeError('Managed OpenCode handoff protocol requires a binary master secret');
  }
  if (value.byteLength < MANAGED_OPENCODE_HANDOFF_KEY_BYTES) {
    throw new TypeError('Managed OpenCode handoff protocol requires a master secret of at least 32 bytes');
  }
  return Buffer.from(value);
};

const normalizeTtl = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= MAX_RECORD_TTL_MS ? value : null;

const normalizeAttestation = (value) => {
  if (!hasExactlyKeys(value, ATTESTATION_KEYS) || value.ok !== true) return null;
  if (!isPid(value.pid) || !isPort(value.port)) return null;
  if (!isCanonicalBase64Url(value.incarnation, MANAGED_OPENCODE_HANDOFF_INCARNATION_BYTES)) return null;
  if (!isCanonicalBase64Url(value.fingerprint, MANAGED_OPENCODE_HANDOFF_KEY_BYTES)) return null;
  return {
    pid: value.pid,
    port: value.port,
    incarnation: value.incarnation,
    fingerprint: value.fingerprint,
  };
};

const normalizeIdentity = (value) => {
  if (!hasExactlyKeys(value, IDENTITY_KEYS)) return null;
  if (!isPid(value.pid) || !isPort(value.port)) return null;
  if (!isCanonicalBase64Url(value.incarnation, MANAGED_OPENCODE_HANDOFF_INCARNATION_BYTES)) return null;
  if (!isCanonicalBase64Url(value.fingerprint, MANAGED_OPENCODE_HANDOFF_KEY_BYTES)) return null;
  return {
    pid: value.pid,
    port: value.port,
    incarnation: value.incarnation,
    fingerprint: value.fingerprint,
  };
};

const matchesRecordIdentity = (record, identity) =>
  identity !== null
  && identity.pid === record.pid
  && identity.port === record.port
  && identity.incarnation === record.incarnation
  && identity.fingerprint === record.fingerprint;

/**
 * Creates the storage- and runtime-agnostic protocol for a single managed
 * OpenCode child record. `store.compareAndSwap` must be an actually atomic,
 * cross-process primitive; this module deliberately provides no in-memory lock
 * or promise queue as a substitute.
 */
export const createManagedOpenCodeHandoffProtocol = ({
  masterSecret,
  store,
  verifyProcess,
  verifyAuthenticatedHealth,
  now = () => Date.now(),
  defaultTtlMs = MANAGED_OPENCODE_HANDOFF_DEFAULT_TTL_MS,
} = {}) => {
  const masterKey = normalizeMasterSecret(masterSecret);
  if (!store || typeof store.read !== 'function' || typeof store.compareAndSwap !== 'function') {
    throw new TypeError('Managed OpenCode handoff protocol requires store.read and atomic store.compareAndSwap');
  }
  if (typeof verifyProcess !== 'function' || typeof verifyAuthenticatedHealth !== 'function') {
    throw new TypeError('Managed OpenCode handoff protocol requires process and authenticated-health verifiers');
  }
  if (typeof now !== 'function') throw new TypeError('Managed OpenCode handoff protocol requires a clock function');

  const configuredDefaultTtl = normalizeTtl(defaultTtlMs);
  if (!configuredDefaultTtl) throw new TypeError('Managed OpenCode handoff protocol received an invalid default TTL');

  const nowMs = () => {
    try {
      const value = now();
      return isSafeNonNegativeInteger(value) ? value : null;
    } catch {
      return null;
    }
  };

  const deriveKey = (incarnation, info) => {
    const salt = decodeCanonicalBase64Url(incarnation, MANAGED_OPENCODE_HANDOFF_INCARNATION_BYTES);
    if (!salt) throw new TypeError('Invalid managed OpenCode handoff incarnation');
    return Buffer.from(hkdfSync(
      'sha256',
      masterKey,
      salt,
      Buffer.from(info, 'utf8'),
      MANAGED_OPENCODE_HANDOFF_KEY_BYTES,
    ));
  };

  const calculateRecordMac = (record) => {
    const recordMacKey = deriveKey(record.incarnation, MANAGED_OPENCODE_HANDOFF_RECORD_MAC_HKDF_INFO);
    try {
      return createHmac('sha256', recordMacKey).update(canonicalizeAuthorityFields(record)).digest();
    } finally {
      recordMacKey.fill(0);
    }
  };

  const calculateClaimCapabilityDigest = (incarnation, claimCapability) => {
    const capabilityBytes = decodeCanonicalBase64Url(claimCapability, MANAGED_OPENCODE_HANDOFF_KEY_BYTES);
    if (!capabilityBytes) return null;
    const capabilityKey = deriveKey(incarnation, MANAGED_OPENCODE_HANDOFF_CLAIM_CAPABILITY_HKDF_INFO);
    try {
      return createHmac('sha256', capabilityKey).update(capabilityBytes).digest();
    } finally {
      capabilityBytes.fill(0);
      capabilityKey.fill(0);
    }
  };

  const signRecord = (record) => ({
    ...record,
    mac: calculateRecordMac(record).toString('base64url'),
  });

  const verifySignedRecord = (record) => {
    const normalized = normalizeRecord(record);
    if (!normalized) return null;

    let providedMac;
    let expectedMac;
    try {
      providedMac = decodeCanonicalBase64Url(normalized.mac, RECORD_MAC_BYTES);
      expectedMac = calculateRecordMac(normalized);
      if (!providedMac || providedMac.length !== expectedMac.length) return null;
      return timingSafeEqual(providedMac, expectedMac) ? normalized : null;
    } catch {
      return null;
    }
  };

  const readRawRecord = async (incarnation) => {
    try {
      return { ok: true, value: await store.read({ incarnation }) };
    } catch {
      return failed('store-read-failed');
    }
  };

  const loadRecord = async (incarnation) => {
    if (!isCanonicalBase64Url(incarnation, MANAGED_OPENCODE_HANDOFF_INCARNATION_BYTES)) {
      return failed('invalid-incarnation');
    }

    const loaded = await readRawRecord(incarnation);
    if (!loaded.ok) return loaded;
    // Only literal null means absent. Undefined, malformed objects, and failed
    // MACs are all invalid authority records and never become "free" records.
    if (loaded.value === null) return failed('record-absent');

    const record = verifySignedRecord(loaded.value);
    if (!record) return failed('record-invalid');
    if (record.incarnation !== incarnation) return failed('record-key-mismatch');

    const current = nowMs();
    if (current === null) return failed('clock-invalid');
    if (current >= record.expiresAt) return failed('record-expired');
    return { ok: true, record };
  };

  const compareAndSwap = async ({ incarnation, expected, next }) => {
    try {
      const result = await store.compareAndSwap({
        incarnation,
        expected,
        next: cloneRecord(next),
        // The injected store must evaluate this predicate with its authoritative
        // clock in the same atomic operation as the expected-record comparison.
        requireUnexpired: { expiresAt: expected?.expiresAt ?? next.expiresAt },
      });
      if (!hasExactlyKeys(result, ['status'])) return failed('compare-and-swap-failed');
      if (result.status === 'applied') return { ok: true };
      if (result.status === 'expired') return failed('record-expired');
      if (result.status === 'conflict') return failed('compare-and-swap-conflict');
      return failed('compare-and-swap-failed');
    } catch {
      return failed('compare-and-swap-failed');
    }
  };

  const nextRevision = (record) =>
    record.revision < Number.MAX_SAFE_INTEGER ? record.revision + 1 : null;

  const hasMatchingClaimCapability = (record, claimCapability) => {
    if (!isClaimCapability(claimCapability)) return false;
    let providedDigest;
    let expectedDigest;
    try {
      providedDigest = calculateClaimCapabilityDigest(record.incarnation, claimCapability);
      expectedDigest = decodeCanonicalBase64Url(
        record.claimCapabilityDigest,
        MANAGED_OPENCODE_HANDOFF_KEY_BYTES,
      );
      if (!providedDigest || !expectedDigest || providedDigest.length !== expectedDigest.length) return false;
      return timingSafeEqual(providedDigest, expectedDigest);
    } catch {
      return false;
    } finally {
      providedDigest?.fill(0);
      expectedDigest?.fill(0);
    }
  };

  const prepareLaunch = async ({ pid, port, ttlMs = configuredDefaultTtl } = {}) => {
    if (!isPid(pid) || !isPort(port)) return failed('invalid-child-identity');
    const normalizedTtl = normalizeTtl(ttlMs);
    const createdAt = nowMs();
    if (createdAt === null) return failed('clock-invalid');
    if (!normalizedTtl || createdAt > Number.MAX_SAFE_INTEGER - normalizedTtl) {
      return failed('invalid-expiry');
    }

    let incarnation;
    try {
      incarnation = randomBytes(MANAGED_OPENCODE_HANDOFF_INCARNATION_BYTES).toString('base64url');
    } catch {
      return failed('entropy-failed');
    }

    let childCredential;
    try {
      childCredential = deriveKey(incarnation, MANAGED_OPENCODE_HANDOFF_CHILD_CREDENTIAL_HKDF_INFO);
      const fingerprint = createHash('sha256').update(childCredential).digest('base64url');
      const record = signRecord({
        v: MANAGED_OPENCODE_HANDOFF_RECORD_VERSION,
        state: ManagedOpenCodeHandoffState.LaunchPrepared,
        incarnation,
        fingerprint,
        pid,
        port,
        createdAt,
        expiresAt: createdAt + normalizedTtl,
        revision: 0,
        claimant: null,
        claimCapabilityDigest: null,
      });

      const existing = await readRawRecord(incarnation);
      if (!existing.ok) return existing;
      if (existing.value !== null) return failed('record-already-present');

      const stored = await compareAndSwap({ incarnation, expected: null, next: record });
      return stored.ok ? succeeded(record) : stored;
    } catch {
      return failed('record-create-failed');
    } finally {
      childCredential?.fill(0);
    }
  };

  const transition = async ({
    incarnation,
    expectedRevision,
    nextState,
    claimant,
    claimCapability,
    identity,
  } = {}) => {
    if (!isSafeNonNegativeInteger(expectedRevision)) return failed('invalid-revision');
    if (!isKnownState(nextState)) return failed('invalid-state');

    const loaded = await loadRecord(incarnation);
    if (!loaded.ok) return loaded;
    const record = loaded.record;

    if (record.revision !== expectedRevision) return failed('stale-revision');
    if (!MANAGED_OPENCODE_HANDOFF_ALLOWED_TRANSITIONS[record.state].includes(nextState)) {
      return failed('illegal-transition');
    }
    if (nextState === ManagedOpenCodeHandoffState.Claimed) return failed('claim-required');

    if (hasClaimBinding(record)) {
      if (!isOpaqueAuthority(claimant) || claimant !== record.claimant) return failed('claimant-mismatch');
      if (!isClaimCapability(claimCapability)) return failed('invalid-claim-capability');
      if (!hasMatchingClaimCapability(record, claimCapability)) return failed('claim-capability-mismatch');
      if (!matchesRecordIdentity(record, normalizeIdentity(identity))) return failed('identity-mismatch');
    } else if (claimant !== undefined || claimCapability !== undefined || identity !== undefined) {
      return failed('unexpected-claim-authority');
    }

    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');
    const next = signRecord({ ...record, state: nextState, revision });
    const stored = await compareAndSwap({
      incarnation: record.incarnation,
      expected: { revision: record.revision, mac: record.mac, expiresAt: record.expiresAt },
      next,
    });
    return stored.ok ? succeeded(next) : stored;
  };

  const verifyAttestation = async (verifier, record) => {
    const expected = {
      incarnation: record.incarnation,
      fingerprint: record.fingerprint,
      pid: record.pid,
      port: record.port,
    };
    try {
      const attestation = normalizeAttestation(await verifier(Object.freeze(expected)));
      return attestation
        && attestation.incarnation === expected.incarnation
        && attestation.fingerprint === expected.fingerprint
        && attestation.pid === expected.pid
        && attestation.port === expected.port;
    } catch {
      return false;
    }
  };

  const claim = async ({ incarnation, expectedRevision, claimant, claimCapability } = {}) => {
    if (!isSafeNonNegativeInteger(expectedRevision)) return failed('invalid-revision');
    if (!isOpaqueAuthority(claimant)) return failed('invalid-claimant');
    if (!isClaimCapability(claimCapability)) return failed('invalid-claim-capability');

    const loaded = await loadRecord(incarnation);
    if (!loaded.ok) return loaded;
    const record = loaded.record;

    if (record.state !== ManagedOpenCodeHandoffState.HandoffPrepared) return failed('claim-not-allowed');
    if (record.revision !== expectedRevision) return failed('stale-revision');

    // Both attestations are mandatory and both bind the live child to every
    // identity value in the signed record before the atomic claim attempt.
    if (!(await verifyAttestation(verifyProcess, record))) return failed('process-verification-failed');
    if (!(await verifyAttestation(verifyAuthenticatedHealth, record))) {
      return failed('health-verification-failed');
    }

    const revision = nextRevision(record);
    if (revision === null) return failed('revision-exhausted');
    const claimCapabilityDigest = calculateClaimCapabilityDigest(record.incarnation, claimCapability);
    if (!claimCapabilityDigest) return failed('invalid-claim-capability');
    try {
      const next = signRecord({
        ...record,
        state: ManagedOpenCodeHandoffState.Claimed,
        revision,
        claimant,
        claimCapabilityDigest: claimCapabilityDigest.toString('base64url'),
      });
      const stored = await compareAndSwap({
        incarnation: record.incarnation,
        expected: { revision: record.revision, mac: record.mac, expiresAt: record.expiresAt },
        next,
      });
      return stored.ok ? succeeded(next) : stored;
    } finally {
      claimCapabilityDigest.fill(0);
    }
  };

  const verifyRecord = (record) => {
    const verified = verifySignedRecord(record);
    if (!verified) return failed('record-invalid');
    const current = nowMs();
    if (current === null) return failed('clock-invalid');
    if (current >= verified.expiresAt) return failed('record-expired');
    return succeeded(verified);
  };

  return {
    prepareLaunch,
    readRecord: async ({ incarnation } = {}) => {
      const loaded = await loadRecord(incarnation);
      return loaded.ok ? succeeded(loaded.record) : loaded;
    },
    verifyRecord,
    transition,
    activate: (input = {}) => transition({ ...input, nextState: ManagedOpenCodeHandoffState.Active }),
    prepareHandoff: (input = {}) => transition({ ...input, nextState: ManagedOpenCodeHandoffState.HandoffPrepared }),
    beginStopping: (input = {}) => transition({ ...input, nextState: ManagedOpenCodeHandoffState.Stopping }),
    retire: (input = {}) => transition({ ...input, nextState: ManagedOpenCodeHandoffState.Retired }),
    claim,
  };
};
