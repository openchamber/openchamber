/**
 * Managed OpenCode handoff v2 record model and state machine.
 *
 * Trust boundary for bootstrap adoption (Phase 2B):
 *   The canonical bootstrap adoption path from the lifecycle startup
 *   (`detectAndAdoptGuardianChild` -> `GuardianClient.list()`) trusts the
 *   returned `(pid, port, incarnation)` of an `Active` child without
 *   requiring a `claimCapability`. This is intentional:
 *
 *     - `claimCapability` is only issued during `beginLaunch` (spawn time)
 *       by the issuing guardian
 *     - bootstrap adoption happens AFTER the spawned child has already
 *       reached `Active`, so there is no protocol-level credential in the
 *       caller's hand
 *     - there is no protocol-level credential available without changing
 *       the protocol itself
 *
 *   The trust boundary is enforced by the host/UID-scoped permissioning
 *   model around the v2 root directory (see `filesystem.js`, the atomic
 *   PID-file singleton, and the `0600` IPC socket), not by an in-protocol
 *   capability. Same-UID local processes are the documented trust boundary.
 *
 *   Cross-process adoption with a `claimCapability` (i.e. requiring the
 *   caller to present the spawn-time credential before `Active -> Claimed`)
 *   is intentionally out of scope for this Phase 2B handoff and is tracked
 *   separately for a later handoff design.
 */
export const MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION = 2;
export const MANAGED_OPENCODE_HANDOFF_V2_INCARNATION_BYTES = 32;
export const MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES = 32;
export const MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS = 24 * 60 * 60 * 1000;

export const ManagedOpenCodeHandoffV2State = Object.freeze({
  Reserved: 'reserved',
  LaunchDelivering: 'launch-delivering',
  Launching: 'launching',
  Active: 'active',
  HandoffPrepared: 'handoff-prepared',
  Claimed: 'claimed',
  Interrupted: 'interrupted',
  Stopping: 'stopping',
  Retired: 'retired',
});

export const MANAGED_OPENCODE_HANDOFF_V2_ALLOWED_TRANSITIONS = Object.freeze({
  [ManagedOpenCodeHandoffV2State.Reserved]: Object.freeze([
    ManagedOpenCodeHandoffV2State.LaunchDelivering,
    ManagedOpenCodeHandoffV2State.Interrupted,
    ManagedOpenCodeHandoffV2State.Stopping,
  ]),
  [ManagedOpenCodeHandoffV2State.LaunchDelivering]: Object.freeze([
    ManagedOpenCodeHandoffV2State.Launching,
  ]),
  [ManagedOpenCodeHandoffV2State.Launching]: Object.freeze([
    ManagedOpenCodeHandoffV2State.Active,
    ManagedOpenCodeHandoffV2State.Interrupted,
    ManagedOpenCodeHandoffV2State.Stopping,
  ]),
  [ManagedOpenCodeHandoffV2State.Active]: Object.freeze([
    ManagedOpenCodeHandoffV2State.HandoffPrepared,
    ManagedOpenCodeHandoffV2State.Interrupted,
    ManagedOpenCodeHandoffV2State.Stopping,
  ]),
  [ManagedOpenCodeHandoffV2State.HandoffPrepared]: Object.freeze([
    ManagedOpenCodeHandoffV2State.Claimed,
    ManagedOpenCodeHandoffV2State.Interrupted,
    ManagedOpenCodeHandoffV2State.Stopping,
  ]),
  [ManagedOpenCodeHandoffV2State.Claimed]: Object.freeze([
    ManagedOpenCodeHandoffV2State.Active,
    ManagedOpenCodeHandoffV2State.Interrupted,
    ManagedOpenCodeHandoffV2State.Stopping,
  ]),
  [ManagedOpenCodeHandoffV2State.Interrupted]: Object.freeze([]),
  [ManagedOpenCodeHandoffV2State.Stopping]: Object.freeze([
    ManagedOpenCodeHandoffV2State.Retired,
  ]),
  [ManagedOpenCodeHandoffV2State.Retired]: Object.freeze([]),
});

const RECORD_KEYS = Object.freeze([
  'v',
  'state',
  'incarnation',
  'credentialFingerprint',
  'pid',
  'port',
  'processStartTicks',
  'createdAt',
  'leaseExpiresAt',
  'revision',
  'mac',
]);
const PROCESS_IDENTITY_KEYS = Object.freeze(['pid', 'port', 'processStartTicks']);
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const STATE_VALUES = new Set(Object.values(ManagedOpenCodeHandoffV2State));

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactlyKeys = (value, expectedKeys) => isObject(value)
  && Object.keys(value).length === expectedKeys.length
  && expectedKeys.every((key) => Object.hasOwn(value, key));
const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isPid = (value) => Number.isSafeInteger(value) && value > 0;
const isPort = (value) => Number.isSafeInteger(value) && value > 0 && value <= 65535;

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

export const isManagedOpenCodeHandoffV2Incarnation = (value) =>
  decodeCanonicalBase64Url(value, MANAGED_OPENCODE_HANDOFF_V2_INCARNATION_BYTES) !== null;

const isCanonicalKey = (value) =>
  decodeCanonicalBase64Url(value, MANAGED_OPENCODE_HANDOFF_V2_KEY_BYTES) !== null;

export const normalizeManagedOpenCodeHandoffV2ProcessIdentity = (value) => {
  if (!hasExactlyKeys(value, PROCESS_IDENTITY_KEYS)) return null;
  if (!isPid(value.pid) || !isPort(value.port) || !isSafeNonNegativeInteger(value.processStartTicks)) {
    return null;
  }
  return {
    pid: value.pid,
    port: value.port,
    processStartTicks: value.processStartTicks,
  };
};

const hasNoProcessIdentity = (record) =>
  record.pid === null && record.port === null && record.processStartTicks === null;

const hasProcessIdentity = (record) => normalizeManagedOpenCodeHandoffV2ProcessIdentity({
  pid: record.pid,
  port: record.port,
  processStartTicks: record.processStartTicks,
}) !== null;

const allowsMissingIdentity = (state) => state === ManagedOpenCodeHandoffV2State.Reserved
  || state === ManagedOpenCodeHandoffV2State.LaunchDelivering
  || state === ManagedOpenCodeHandoffV2State.Launching
  || state === ManagedOpenCodeHandoffV2State.Interrupted
  || state === ManagedOpenCodeHandoffV2State.Stopping
  || state === ManagedOpenCodeHandoffV2State.Retired;

const requiresIdentity = (state) => state === ManagedOpenCodeHandoffV2State.Active
  || state === ManagedOpenCodeHandoffV2State.HandoffPrepared
  || state === ManagedOpenCodeHandoffV2State.Claimed;

export const normalizeManagedOpenCodeHandoffV2Record = (value) => {
  if (!hasExactlyKeys(value, RECORD_KEYS)) return null;
  if (value.v !== MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION || !STATE_VALUES.has(value.state)) {
    return null;
  }
  if (!isManagedOpenCodeHandoffV2Incarnation(value.incarnation) || !isCanonicalKey(value.credentialFingerprint)) {
    return null;
  }
  if (
    !isSafeNonNegativeInteger(value.createdAt)
    || !isSafeNonNegativeInteger(value.leaseExpiresAt)
    || value.leaseExpiresAt <= value.createdAt
    || !isSafeNonNegativeInteger(value.revision)
    || !isCanonicalKey(value.mac)
  ) {
    return null;
  }

  if (requiresIdentity(value.state) && !hasProcessIdentity(value)) return null;
  if (!allowsMissingIdentity(value.state) && !requiresIdentity(value.state)) return null;
  if (!hasNoProcessIdentity(value) && !hasProcessIdentity(value)) return null;
  if (
    (value.state === ManagedOpenCodeHandoffV2State.Reserved
      || value.state === ManagedOpenCodeHandoffV2State.LaunchDelivering
      || value.state === ManagedOpenCodeHandoffV2State.Launching)
    && !hasNoProcessIdentity(value)
  ) {
    return null;
  }

  return {
    v: value.v,
    state: value.state,
    incarnation: value.incarnation,
    credentialFingerprint: value.credentialFingerprint,
    pid: value.pid,
    port: value.port,
    processStartTicks: value.processStartTicks,
    createdAt: value.createdAt,
    leaseExpiresAt: value.leaseExpiresAt,
    revision: value.revision,
    mac: value.mac,
  };
};

export const canonicalizeManagedOpenCodeHandoffV2Record = (record) => {
  const normalized = normalizeManagedOpenCodeHandoffV2Record(record);
  if (!normalized) throw new TypeError('Invalid managed OpenCode handoff v2 record');
  return Buffer.from(JSON.stringify([
    normalized.v,
    normalized.state,
    normalized.incarnation,
    normalized.credentialFingerprint,
    normalized.pid,
    normalized.port,
    normalized.processStartTicks,
    normalized.createdAt,
    normalized.leaseExpiresAt,
    normalized.revision,
  ]), 'utf8');
};

export const toPublicManagedOpenCodeHandoffV2Record = (record) => ({
  v: record.v,
  state: record.state,
  incarnation: record.incarnation,
  credentialFingerprint: record.credentialFingerprint,
  pid: record.pid,
  port: record.port,
  processStartTicks: record.processStartTicks,
  createdAt: record.createdAt,
  leaseExpiresAt: record.leaseExpiresAt,
  revision: record.revision,
});
