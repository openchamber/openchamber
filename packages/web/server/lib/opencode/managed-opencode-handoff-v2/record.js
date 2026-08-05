/**
 * Managed OpenCode handoff v2 record model and state machine.
 *
 * Trust boundary for bootstrap adoption (Phase 2B):
 *   The canonical bootstrap adoption path from the lifecycle startup
 *   (`detectAndAdoptGuardianChild` -> `GuardianClient.list()`) accepts only
 *   an `Active` child with a complete stable owner/runtime identity matching
 *   the current OpenChamber instance. It never selects by list order and
 *   rejects ownerless or ambiguous records. It does not require a
 *   `claimCapability`. This is intentional:
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
const MANAGED_OPENCODE_HANDOFF_V2_OPERATION_ID_BYTES = 32;
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

export const ManagedOpenCodeHandoffV2OperationKind = Object.freeze({
  Spawn: 'spawn',
  Stop: 'stop',
  PrepareHandoff: 'prepare-handoff',
  AbortHandoff: 'abort-handoff',
});

export const ManagedOpenCodeHandoffV2OperationState = Object.freeze({
  Pending: 'pending',
  Resolved: 'resolved',
  Expired: 'expired',
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
    ManagedOpenCodeHandoffV2State.Active,
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
  'ownerInstanceId',
  'runtimeIdentity',
  'launchFingerprint',
  'launchSpec',
  'credentialFingerprint',
  'pid',
  'port',
  'processStartTicks',
  'createdAt',
  'leaseExpiresAt',
  'revision',
  'mac',
]);
const LEGACY_RECORD_KEYS = Object.freeze([
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
const OPERATION_KIND_VALUES = new Set(Object.values(ManagedOpenCodeHandoffV2OperationKind));
const OPERATION_STATE_VALUES = new Set(Object.values(ManagedOpenCodeHandoffV2OperationState));
const OPERATION_RESOLUTION_STATE_VALUES = new Set([
  ManagedOpenCodeHandoffV2State.Active,
  ManagedOpenCodeHandoffV2State.HandoffPrepared,
  ManagedOpenCodeHandoffV2State.Interrupted,
  ManagedOpenCodeHandoffV2State.Retired,
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasExactlyKeys = (value, expectedKeys) => isObject(value)
  && Object.keys(value).length === expectedKeys.length
  && expectedKeys.every((key) => Object.hasOwn(value, key));
const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isPid = (value) => Number.isSafeInteger(value) && value > 0;
const isPort = (value) => Number.isSafeInteger(value) && value > 0 && value <= 65535;
const isIdentityString = (value) => value === null
  || (typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1F\x7F]/.test(value));
const normalizeProcessStartTicks = (value) => {
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  return null;
};

export const normalizeManagedOpenCodeHandoffV2LaunchSpec = (value) => {
  if (value === null) return null;
  if (!isObject(value)) return null;
  const keys = ['binary', 'args', 'hostname', 'port', 'cwd'];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return null;
  if (
    typeof value.binary !== 'string' || value.binary.length === 0 || value.binary.length > 4096
    || !Array.isArray(value.args) || value.args.length > 32
    || value.args.some((arg) => typeof arg !== 'string' || arg.length > 4096)
    || typeof value.hostname !== 'string' || value.hostname.length === 0 || value.hostname.length > 255
    || !isPort(value.port)
    || typeof value.cwd !== 'string' || value.cwd.length === 0 || value.cwd.length > 4096
  ) return null;
  return {
    binary: value.binary,
    args: [...value.args],
    hostname: value.hostname,
    port: value.port,
    cwd: value.cwd,
  };
};

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

export const isManagedOpenCodeHandoffV2OperationId = (value) =>
  decodeCanonicalBase64Url(value, MANAGED_OPENCODE_HANDOFF_V2_OPERATION_ID_BYTES) !== null;

export const normalizeManagedOpenCodeHandoffV2ProcessIdentity = (value) => {
  if (!hasExactlyKeys(value, PROCESS_IDENTITY_KEYS)) return null;
  const processStartTicks = normalizeProcessStartTicks(value.processStartTicks);
  if (!isPid(value.pid) || !isPort(value.port) || processStartTicks === null) {
    return null;
  }
  return {
    pid: value.pid,
    port: value.port,
    processStartTicks,
  };
};

export const normalizeManagedOpenCodeHandoffV2OwnerIdentity = (value) => {
  if (!isObject(value)) return null;
  const ownerInstanceId = value.ownerInstanceId ?? null;
  const runtimeIdentity = value.runtimeIdentity ?? null;
  const launchFingerprint = value.launchFingerprint ?? null;
  if (
    !isIdentityString(ownerInstanceId)
    || !isIdentityString(runtimeIdentity)
    || !isIdentityString(launchFingerprint)
    || ((ownerInstanceId === null || runtimeIdentity === null || launchFingerprint === null)
      && (ownerInstanceId !== null || runtimeIdentity !== null || launchFingerprint !== null))
  ) {
    return null;
  }
  return { ownerInstanceId, runtimeIdentity, launchFingerprint };
};

const hasNoProcessIdentity = (record) =>
  record.pid === null && record.port === null && record.processStartTicks === null;

const normalizeProcessIdentity = (record) => normalizeManagedOpenCodeHandoffV2ProcessIdentity({
  pid: record.pid,
  port: record.port,
  processStartTicks: record.processStartTicks,
});

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
  const isLegacy = hasExactlyKeys(value, LEGACY_RECORD_KEYS);
  if (!isLegacy && !hasExactlyKeys(value, RECORD_KEYS)) return null;
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

  const processIdentity = normalizeProcessIdentity(value);
  if (requiresIdentity(value.state) && !processIdentity) return null;
  if (!allowsMissingIdentity(value.state) && !requiresIdentity(value.state)) return null;
  if (!hasNoProcessIdentity(value) && !processIdentity) return null;
  if (
    (value.state === ManagedOpenCodeHandoffV2State.Reserved
      || value.state === ManagedOpenCodeHandoffV2State.LaunchDelivering
      || value.state === ManagedOpenCodeHandoffV2State.Launching)
    && !hasNoProcessIdentity(value)
  ) {
    return null;
  }

  const ownerInstanceId = isLegacy ? null : value.ownerInstanceId;
  const runtimeIdentity = isLegacy ? null : value.runtimeIdentity;
  const launchFingerprint = isLegacy ? null : value.launchFingerprint;
  const launchSpec = isLegacy ? null : normalizeManagedOpenCodeHandoffV2LaunchSpec(value.launchSpec);
  if (
    !isIdentityString(ownerInstanceId)
    || !isIdentityString(runtimeIdentity)
    || !isIdentityString(launchFingerprint)
    || (!isLegacy && value.launchSpec !== null && launchSpec === null)
    || ((ownerInstanceId === null || runtimeIdentity === null || launchFingerprint === null)
      && (ownerInstanceId !== null || runtimeIdentity !== null || launchFingerprint !== null))
  ) {
    return null;
  }

  return {
    v: value.v,
    state: value.state,
    incarnation: value.incarnation,
    ownerInstanceId,
    runtimeIdentity,
    launchFingerprint,
    launchSpec,
    credentialFingerprint: value.credentialFingerprint,
    pid: value.pid,
    port: value.port,
    processStartTicks: processIdentity?.processStartTicks ?? null,
    createdAt: value.createdAt,
    leaseExpiresAt: value.leaseExpiresAt,
    revision: value.revision,
    mac: value.mac,
  };
};

const normalizeOperationBinding = (value) => {
  if (!isObject(value)
    || !isSafeNonNegativeInteger(value.revision)
    || !isSafeNonNegativeInteger(value.leaseExpiresAt)
    || !isCanonicalKey(value.mac)) return null;
  return {
    revision: value.revision,
    leaseExpiresAt: value.leaseExpiresAt,
    mac: value.mac,
  };
};

const OPERATION_KEYS = Object.freeze([
  'v',
  'operationId',
  'kind',
  'incarnation',
  'ownerInstanceId',
  'runtimeIdentity',
  'launchFingerprint',
  'targetRevision',
  'targetLeaseExpiresAt',
  'targetMac',
  'state',
  'resolutionState',
  'resolutionRevision',
  'resolutionLeaseExpiresAt',
  'resolutionMac',
  'createdAt',
  'confirmationExpiresAt',
  'revision',
  'mac',
]);

export const normalizeManagedOpenCodeHandoffV2Operation = (value) => {
  if (!hasExactlyKeys(value, OPERATION_KEYS)
    || value.v !== MANAGED_OPENCODE_HANDOFF_V2_RECORD_VERSION
    || !isManagedOpenCodeHandoffV2OperationId(value.operationId)
    || !OPERATION_KIND_VALUES.has(value.kind)
    || !isManagedOpenCodeHandoffV2Incarnation(value.incarnation)
    || !isIdentityString(value.ownerInstanceId)
    || !isIdentityString(value.runtimeIdentity)
    || !isIdentityString(value.launchFingerprint)
    || value.ownerInstanceId === null
    || value.runtimeIdentity === null
    || value.launchFingerprint === null
    || !isSafeNonNegativeInteger(value.targetRevision)
    || !isSafeNonNegativeInteger(value.targetLeaseExpiresAt)
    || !isCanonicalKey(value.targetMac)
    || !OPERATION_STATE_VALUES.has(value.state)
    || !isSafeNonNegativeInteger(value.createdAt)
    || !isSafeNonNegativeInteger(value.confirmationExpiresAt)
    || value.confirmationExpiresAt <= value.createdAt
    || !isSafeNonNegativeInteger(value.revision)
    || !isCanonicalKey(value.mac)) {
    return null;
  }

  const resolution = value.resolutionState === null
    ? null
    : normalizeOperationBinding({
      revision: value.resolutionRevision,
      leaseExpiresAt: value.resolutionLeaseExpiresAt,
      mac: value.resolutionMac,
    });
  if (value.resolutionState !== null && (!OPERATION_RESOLUTION_STATE_VALUES.has(value.resolutionState) || !resolution)) {
    return null;
  }
  if (value.state === ManagedOpenCodeHandoffV2OperationState.Pending && resolution !== null) return null;
  if (value.state === ManagedOpenCodeHandoffV2OperationState.Resolved && resolution === null) return null;
  if (value.state === ManagedOpenCodeHandoffV2OperationState.Expired && resolution !== null) return null;

  return {
    v: value.v,
    operationId: value.operationId,
    kind: value.kind,
    incarnation: value.incarnation,
    ownerInstanceId: value.ownerInstanceId,
    runtimeIdentity: value.runtimeIdentity,
    launchFingerprint: value.launchFingerprint,
    targetRevision: value.targetRevision,
    targetLeaseExpiresAt: value.targetLeaseExpiresAt,
    targetMac: value.targetMac,
    state: value.state,
    resolutionState: value.resolutionState,
    resolutionRevision: resolution?.revision ?? null,
    resolutionLeaseExpiresAt: resolution?.leaseExpiresAt ?? null,
    resolutionMac: resolution?.mac ?? null,
    createdAt: value.createdAt,
    confirmationExpiresAt: value.confirmationExpiresAt,
    revision: value.revision,
    mac: value.mac,
  };
};

export const canonicalizeManagedOpenCodeHandoffV2Operation = (operation) => {
  const normalized = normalizeManagedOpenCodeHandoffV2Operation(operation);
  if (!normalized) throw new TypeError('Invalid managed OpenCode handoff v2 operation');
  return Buffer.from(JSON.stringify([
    normalized.v,
    normalized.operationId,
    normalized.kind,
    normalized.incarnation,
    normalized.ownerInstanceId,
    normalized.runtimeIdentity,
    normalized.launchFingerprint,
    normalized.targetRevision,
    normalized.targetLeaseExpiresAt,
    normalized.targetMac,
    normalized.state,
    normalized.resolutionState,
    normalized.resolutionRevision,
    normalized.resolutionLeaseExpiresAt,
    normalized.resolutionMac,
    normalized.createdAt,
    normalized.confirmationExpiresAt,
    normalized.revision,
  ]), 'utf8');
};

export const canonicalizeManagedOpenCodeHandoffV2Record = (record) => {
  const normalized = normalizeManagedOpenCodeHandoffV2Record(record);
  if (!normalized) throw new TypeError('Invalid managed OpenCode handoff v2 record');
  return Buffer.from(JSON.stringify([
  normalized.v,
  normalized.state,
  normalized.incarnation,
  normalized.ownerInstanceId,
  normalized.runtimeIdentity,
  normalized.launchFingerprint,
  normalized.launchSpec,
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
  ownerInstanceId: record.ownerInstanceId ?? null,
  runtimeIdentity: record.runtimeIdentity ?? null,
  launchFingerprint: record.launchFingerprint ?? null,
  launchSpec: record.launchSpec ?? null,
  credentialFingerprint: record.credentialFingerprint,
  pid: record.pid,
  port: record.port,
  processStartTicks: record.processStartTicks,
  createdAt: record.createdAt,
  leaseExpiresAt: record.leaseExpiresAt,
  revision: record.revision,
});
