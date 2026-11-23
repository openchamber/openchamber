import { isBoolean, isPlainObject } from '../shared/guards.js';
import { isGitString as isString } from './input-guards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { constants as fsConstants } from 'node:fs';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { isLoopbackHost } from './loopback-http.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type {
  BuildNetworkRecordInput, NetworkOperationOwner, NetworkOperationState, NetworkOperationStoreOptions,
  StoredHydration, StoredHydrationPart, StoredNetworkError, StoredNetworkRecord, StoredNetworkSnapshot,
  StoredNetworkStep, StoredRuntimeIdentity,
} from './network-storage-contracts.js';

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const hasCode = (value: unknown): value is { code?: unknown } => value !== null && value !== undefined;
const errorCode = (cause: unknown) => hasCode(cause) ? cause.code : undefined;
const occupied = <Value>(value: Value | undefined): Value => {
  if (value === undefined) throw new TypeError('Validated Git operation value is missing');
  return value;
};
const field = (value: JsonValue | undefined, key: string): JsonValue | undefined => {
  if (value === null || value === undefined) return undefined;
  if (isJsonObject(value)) return value[key];
  return undefined;
};
const isJsonObject = (value: JsonValue | undefined): value is JsonObject => isPlainObject(value);
const requiredField = (value: JsonValue | undefined, key: string): JsonValue | undefined => {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  return field(value, key);
};
const memberOf = (values: ReadonlySet<string>, value: unknown): value is string =>
  isString(value) && values.has(value);
const includes = <Value extends string>(values: Value[], value: unknown): value is Value =>
  values.some((candidate) => candidate === value);

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_TERMINAL_RETENTION_MS = 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const TERMINAL_STATES = new Set([
  'succeeded', 'partial', 'conflicted', 'failed', 'cancelled', 'outcome-unknown',
]);
const EVICTABLE_STATES = new Set(['succeeded', 'partial', 'conflicted', 'failed', 'cancelled']);
const STEPS = new Set([
  'validated', 'authenticated', 'transferred', 'updated-local-repository', 'checked-out', 'cleaned-up',
]);
const OPERATIONS = new Set([
  'fetch', 'pull', 'push', 'delete-remote-branch', 'sync', 'clone',
  'contributor-fetch', 'checkout-hydration', 'checkout-actions',
]);
const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'NOT_FOUND', 'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG',
  'REMOTE_CHANGED', 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'TRANSPORT_FAILED',
  'CONFLICT', 'CANCELLED', 'TIMEOUT', 'OUTCOME_UNKNOWN', 'RUNTIME_UNSUPPORTED', 'UNKNOWN',
  'GIT_LFS_CLIENT_MISSING', 'CHECKOUT_TOO_LARGE', 'SUBMODULE_SOURCE_LOCAL', 'LFS_SOURCE_LOCAL',
]);
const FAILURE_ERROR_CODES = new Set([
  'INVALID_REQUEST', 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'TRANSPORT_FAILED',
  'RUNTIME_UNSUPPORTED', 'GIT_LFS_CLIENT_MISSING', 'CHECKOUT_TOO_LARGE', 'UNKNOWN',
]);
const STATE_ERROR_CODES: Readonly<Partial<Record<string, ReadonlySet<string>>>> = Object.freeze({
  partial: FAILURE_ERROR_CODES,
  conflicted: new Set(['STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG', 'REMOTE_CHANGED', 'CONFLICT']),
  failed: FAILURE_ERROR_CODES,
  cancelled: new Set(['CANCELLED', 'TIMEOUT']),
  'outcome-unknown': new Set(['OUTCOME_UNKNOWN']),
});
const FORBIDDEN_KEYS = new Set([
  'directory', 'temporaryDirectory', 'rawEndpoint', 'credentialId', 'sourceSha', 'destinationSha',
  'expectedRemoteSha', 'output', 'stdout', 'stderr',
]);
const SAFE_ERROR_MESSAGES: Readonly<Partial<Record<string, string>>> = Object.freeze({
  INVALID_REQUEST: 'Git operation input was invalid',
  NOT_FOUND: 'Git operation target was not found',
  STALE_REPOSITORY: 'Git repository authority changed',
  STALE_BINDING: 'Source control binding changed',
  STALE_CONFIG: 'Git repository configuration changed',
  REMOTE_CHANGED: 'Git remote or transport authority changed',
  AUTHENTICATION_REQUIRED: 'Git authentication is required',
  AUTHENTICATION_FAILED: 'Git authentication failed',
  TRANSPORT_FAILED: 'Git transport failed',
  CONFLICT: 'Git operation left a conflict that requires inspection',
  CANCELLED: 'Git operation was cancelled',
  TIMEOUT: 'Git operation timed out',
  OUTCOME_UNKNOWN: 'Git operation outcome is unknown; inspect repository and remote state before retrying',
  RUNTIME_UNSUPPORTED: 'Git operation is unsupported by this runtime',
  UNKNOWN: 'Git operation failed; inspect repository state before retrying',
  GIT_LFS_CLIENT_MISSING: 'Git LFS is required but unavailable',
  CHECKOUT_TOO_LARGE: 'Checkout has too many files to inspect',
});

const exactKeys = <Value extends object>(value: Value, required: string[], optional: string[] = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const isIdentifier = (value: unknown, max = 1024): value is string => isString(value) && value.length > 0
  && value.length <= max && value.trim() === value && !/[\0\r\n]/.test(value);
const isOperationId = (value: unknown): value is string => isString(value) && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const isVocabularyName = (value: unknown): value is string => isString(value) && /^[a-z][a-z0-9-]{0,63}$/.test(value);
const isOpaqueTargetValue = (value: unknown, key = '', depth = 0): value is JsonValue => {
  if (depth > 8) return false;
  if (value === null || value === true || value === false || Number.isSafeInteger(value)) return true;
  if (isString(value)) {
    if (key === 'displayUrl') return isSafeDisplayEndpoint(value);
    return value.length <= 1024 && !/[\0\r\n]/.test(value)
      && !value.includes('://') && !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value);
  }
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every((entry) => isOpaqueTargetValue(entry, key, depth + 1));
  }
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 64
    && entries.every(([name, entry]) => /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)
      && isOpaqueTargetValue(entry, name, depth + 1));
};
const foreignNames = (record: StoredNetworkRecord) => {
  const snapshot = record?.snapshot;
  const operation = snapshot?.target?.operation;
  const steps = Array.isArray(snapshot?.completedSteps)
    ? snapshot.completedSteps.filter((step) => !STEPS.has(step)) : [];
  const errors = [
    snapshot?.error,
    ...(Array.isArray(snapshot?.stepResults) ? snapshot.stepResults.map((step) => step?.error) : []),
    ...(Array.isArray(snapshot?.hydration?.submodules) ? snapshot.hydration.submodules.map((part) => part?.error) : []),
    ...(Array.isArray(snapshot?.hydration?.lfs) ? snapshot.hydration.lfs.map((part) => part?.error) : []),
  ];
  const codes = [...new Set(errors.map((error) => error?.code)
    .filter((code) => isErrorCodeName(code) && !ERROR_CODES.has(code)))];
  return [
    ...(OPERATIONS.has(operation) ? [] : [`operation ${operation}`]),
    ...steps.map((step) => `step ${step}`),
    ...codes.map((code) => `error ${code}`),
  ].join(', ');
};
const isErrorCodeName = (value: unknown): value is string => isString(value) && /^[A-Z][A-Z0-9_]{0,63}$/.test(value);
const isTimestamp = (value: unknown): value is number => isSafeInteger(value) && value >= 0;
const invalidStore = (cause?: unknown) => Object.assign(new Error('Git network operation storage is invalid', { cause }), {
  code: 'GIT_NETWORK_OPERATION_STORAGE_INVALID',
});
const conflict = () => Object.assign(new Error('Git network operation ID already exists'), {
  code: 'GIT_NETWORK_OPERATION_EXISTS', status: 409,
});
const capacityError = () => Object.assign(new Error('Git network operation storage capacity reached'), {
  code: 'GIT_NETWORK_OPERATION_CAPACITY', status: 503,
});
function clone(value: StoredNetworkSnapshot): StoredNetworkSnapshot;
function clone(value: JsonValue | undefined): JsonValue;
function clone(value: JsonValue | undefined): JsonValue { return JSON.parse(JSON.stringify(value)); }
const redactDisplayEndpoint = (value: JsonValue | undefined) => {
  if (!isString(value) || value.includes('://')) return value;
  const match = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  return match ? `${match[1]}:${match[2]}` : value;
};
const isSafeDisplayEndpoint = (value: unknown): value is string => {
  if (!isString(value) || value.length > 4096 || /[\0\r\n]/.test(value)) return false;
  if (!value.includes('://')) {
    const match = value.match(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:([^\s:\\]+)$/);
    return Boolean(match && !/[?#]/.test(value) && !occupied(match[1]).startsWith('-')
      && occupied(match[1]).split('/').every((part) => part && part !== '.' && part !== '..'));
  }
  try {
    const endpoint = new URL(value);
    const pathname = decodeURIComponent(endpoint.pathname);
    return (['https:', 'ssh:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' && isLoopbackHost(endpoint.hostname)))
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && Boolean(endpoint.hostname && endpoint.pathname && endpoint.pathname !== '/')
      && !/[\0-\x20\x7f\\]/.test(pathname)
      && pathname.split('/').slice(1).every((part) => part && part !== '.' && part !== '..');
  } catch {
    return false;
  }
};
const isRelativeCheckoutPath = (value: unknown): value is string => isString(value) && value.length > 0 && value.length <= 4096
  && value.trim() === value && !/[^\u0020-\u007e\u0080-\uffff]/.test(value)
  && value !== '..' && !value.startsWith('../') && !value.includes('/../')
  && !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes('\\');

const scrubPublicSnapshot = (snapshot: JsonValue | undefined) => {
  const value = clone(snapshot);
  const visit = (candidate: JsonValue | undefined): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isJsonObject(candidate)) return;
    if (isString(candidate.code) && Object.hasOwn(SAFE_ERROR_MESSAGES, candidate.code)
      && Object.hasOwn(candidate, 'message')) {
      candidate.message = SAFE_ERROR_MESSAGES[candidate.code];
    }
    for (const key of Object.keys(candidate)) {
      if (FORBIDDEN_KEYS.has(key) || key === 'actor' || key === 'forceWithLease') delete candidate[key];
      else if (key === 'displayUrl') candidate[key] = redactDisplayEndpoint(candidate[key]);
      else visit(candidate[key]);
    }
  };
  visit(value);
  return value;
};

const validatePublicValue = (value: unknown, depth = 0, budget = { nodes: 0 }, parentKey = ''): value is JsonValue => {
  budget.nodes += 1;
  if (depth > 12 || budget.nodes > 4096) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (isString(value)) {
    if (parentKey === 'displayUrl') return isSafeDisplayEndpoint(value);
    if (parentKey === 'path') return isRelativeCheckoutPath(value);
    if (parentKey === 'displayName') return value.length <= 1024 && !/[\0\r\n/\\]/.test(value);
    return value.length <= 65536 && !value.includes('\0');
  }
  if (Array.isArray(value)) return value.length <= 512
    && value.every((entry) => validatePublicValue(entry, depth + 1, budget, parentKey));
  if (!isPlainObject(value)) return false;
  return Object.entries(value).every(([key, child]) => !FORBIDDEN_KEYS.has(key)
    && key !== 'actor' && validatePublicValue(child, depth + 1, budget, key));
};

const targetFingerprints = (target: JsonValue | undefined) => {
  if (!isJsonObject(target)) return [];
  const candidates = [
    field(field(target.remote, 'endpoint'), 'fingerprint'),
    field(target.remote, 'fingerprint'),
    field(field(target.fetch, 'endpoint'), 'fingerprint'),
    field(field(target.push, 'endpoint'), 'fingerprint'),
    field(target.destination, 'fingerprint'),
  ].filter((value) => value !== undefined);
  if (!candidates.every((value): value is string => isIdentifier(value))) throw invalidStore();
  return candidates;
};

const repositoryIdFor = (snapshot: JsonValue | undefined) => {
  const repositoryId = field(field(snapshot, 'target'), 'repositoryId');
  return isIdentifier(repositoryId) ? repositoryId : null;
};
const immutablePlan = (snapshot: StoredNetworkSnapshot) => {
  const plan: Partial<StoredNetworkSnapshot> = clone(snapshot);
  delete plan.state;
  delete plan.completedSteps;
  delete plan.error;
  delete plan.stepResults;
  delete plan.hydration;
  return plan;
};
const isRuntimeIdentity = (value: unknown): value is StoredRuntimeIdentity => isPlainObject(value)
  && exactKeys(value, ['id', 'platform'])
  && isIdentifier(value.id, 512) && includes(['web', 'desktop'], value.platform);
const isPublicError = (value: unknown, allowUnknownCode = false): value is StoredNetworkError => isPlainObject(value)
  && exactKeys(value, ['code', 'message'])
  && (memberOf(ERROR_CODES, value.code) || (allowUnknownCode && isErrorCodeName(value.code)))
  && isString(value.message) && value.message.length > 0 && value.message.length <= 4096
  && value.message.trim() === value.message && !value.message.includes('\0');
const isEndpoint = (value: unknown): value is { displayUrl: string; fingerprint: string } => isPlainObject(value)
  && exactKeys(value, ['displayUrl', 'fingerprint'])
  && isSafeDisplayEndpoint(value.displayUrl) && isIdentifier(value.fingerprint);
const isRemote = (value: unknown): value is { name: string; endpoint: { displayUrl: string; fingerprint: string } } => isPlainObject(value)
  && exactKeys(value, ['name', 'endpoint'])
  && isIdentifier(value.name, 512) && isEndpoint(value.endpoint);
const isHydrationRequirement = (value: JsonValue | undefined): boolean => isPlainObject(value)
  && exactKeys(value, ['kind', 'path', 'endpoint'])
  && includes(['submodule', 'lfs'], value.kind)
  && isRelativeCheckoutPath(value.path)
  && isEndpoint(value.endpoint);
const isVerification = (value: unknown, mode: unknown): value is JsonObject => {
  if (!isPlainObject(value)) return false;
  if (mode === 'anonymous') return exactKeys(value, ['status']) && value.status === 'anonymous';
  if (mode === 'managed') {
    return exactKeys(value, ['status', 'method'])
      && value.status === 'verified' && value.method === 'credential';
  }
  return mode === 'system' && exactKeys(value, ['status', 'reason'])
    && value.status === 'unverified'
    && includes(['system-credentials', 'local-checkout-actions'], value.reason);
};
const isTransport = (value: unknown): value is JsonValue => {
  if (!isPlainObject(value)) return false;
  if (exactKeys(value, ['fetch', 'push'])) return isTransport(value.fetch) && isTransport(value.push);
  return exactKeys(value, ['mode', 'verification'])
    && includes(['anonymous', 'managed', 'system'], value.mode)
    && isVerification(value.verification, value.mode);
};
const isRef = (value: unknown): value is string => isIdentifier(value, 4096) && value.startsWith('refs/');
const isRepositoryTargetBase = (value: JsonValue | undefined, operation: string, required: string[] = [], optional: string[] = []): boolean => isPlainObject(value)
  && exactKeys(value, ['operation', 'repositoryId', 'bindingRevision', 'configRevision', 'remote', ...required], optional)
  && value.operation === operation
  && isIdentifier(value.repositoryId)
  && isSafeInteger(value.bindingRevision) && value.bindingRevision >= 0
  && isIdentifier(value.configRevision)
  && isRemote(value.remote);
const isTarget = (value: JsonValue | undefined, allowUnknownVocabulary = false): value is JsonObject & { operation: string } => {
  if (!isJsonObject(value) || !isOperationId(value.operation)) return false;
  if (!OPERATIONS.has(value.operation)) return allowUnknownVocabulary && isVocabularyName(value.operation) && isOpaqueTargetValue(value);
  if (value.operation === 'checkout-actions') {
    return exactKeys(value, ['operation']);
  }
  if (value.operation === 'checkout-hydration') {
    if (exactKeys(value, ['operation'])) return true;
    return exactKeys(value, ['operation', 'repositoryId', 'bindingRevision', 'configRevision', 'remote', 'requirements'])
      && isIdentifier(value.repositoryId)
      && isSafeInteger(value.bindingRevision) && value.bindingRevision >= 0
      && isIdentifier(value.configRevision)
      && isRemote(value.remote)
      && Array.isArray(value.requirements) && value.requirements.length <= 256
      && value.requirements.every(isHydrationRequirement);
  }
  if (value.operation === 'clone') {
    return exactKeys(value, ['operation', 'remote', 'destination'])
      && isPlainObject(value.remote) && exactKeys(value.remote, ['displayUrl', 'fingerprint'])
      && isSafeDisplayEndpoint(value.remote.displayUrl) && isIdentifier(value.remote.fingerprint)
      && isPlainObject(value.destination) && exactKeys(value.destination, ['displayName', 'fingerprint'])
      && isIdentifier(value.destination.displayName) && !/[/\\]/.test(value.destination.displayName)
      && isIdentifier(value.destination.fingerprint);
  }
  if (value.operation === 'sync') {
    return isPlainObject(value)
      && exactKeys(value, ['operation', 'repositoryId', 'bindingRevision', 'configRevision', 'fetch', 'pull', 'push'])
      && isIdentifier(value.repositoryId)
      && isSafeInteger(value.bindingRevision) && value.bindingRevision >= 0
      && isIdentifier(value.configRevision)
      && isPlainObject(value.fetch) && exactKeys(value.fetch, ['name', 'endpoint', 'sourceRef', 'destinationRef'])
      && isIdentifier(value.fetch.name, 512) && isEndpoint(value.fetch.endpoint)
      && isRef(value.fetch.sourceRef) && isRef(value.fetch.destinationRef)
      && isPlainObject(value.pull) && exactKeys(value.pull, ['destinationRef']) && isRef(value.pull.destinationRef)
      && isPlainObject(value.push) && exactKeys(value.push, ['name', 'endpoint', 'sourceRef', 'destinationRef'])
      && isIdentifier(value.push.name, 512) && isEndpoint(value.push.endpoint)
      && isRef(value.push.sourceRef) && isRef(value.push.destinationRef);
  }
  if (value.operation === 'contributor-fetch') {
    return exactKeys(value, ['operation', 'remote', 'sourceRef', 'destinationRef'])
      && isRemote(value.remote) && isRef(value.sourceRef) && isRef(value.destinationRef);
  }
  if (!['fetch', 'pull', 'push', 'delete-remote-branch'].includes(value.operation)) return false;
  const remoteFetch = value.operation === 'fetch' && value.fetchScope === 'remote';
  const required = value.operation === 'delete-remote-branch'
    ? ['destinationRef'] : remoteFetch ? [] : ['sourceRef', 'destinationRef'];
  if (!isRepositoryTargetBase(value, value.operation, required, ['fetchScope', 'force', 'configureUpstream'])) return false;
  return (!Object.hasOwn(value, 'sourceRef') || isRef(value.sourceRef))
    && (!Object.hasOwn(value, 'destinationRef') || isRef(value.destinationRef))
    && (!Object.hasOwn(value, 'fetchScope') || value.operation === 'fetch' && includes(['ref', 'remote'], value.fetchScope))
    && (!Object.hasOwn(value, 'force') || remoteFetch && typeof value.force === 'boolean')
    && (!Object.hasOwn(value, 'configureUpstream') || value.operation === 'push' && value.configureUpstream === true);
};
const isStepResults = (value: unknown, allowUnknownVocabulary = false): value is StoredNetworkStep[] => Array.isArray(value) && value.length === 3
  && value.every((step, index) => isPlainObject(step)
    && exactKeys(step, ['step', 'status'], ['error'])
    && step.step === ['fetch', 'pull', 'push'][index]
    && includes(['succeeded', 'skipped', 'conflicted', 'failed', 'cancelled'], step.status)
    && (includes(['succeeded', 'skipped'], step.status) ? step.error === undefined : isPublicError(step.error, allowUnknownVocabulary)));
const HYDRATION_STATUSES = new Set([
  'succeeded', 'authorization-required', 'invalid', 'client-missing', 'failed', 'cancelled', 'not-needed',
]);
const isHydrationPart = (value: unknown, allowUnknownVocabulary = false): value is StoredHydrationPart => isPlainObject(value)
  && exactKeys(value, ['path', 'status'], ['endpoint', 'error'])
  && isRelativeCheckoutPath(value.path)
  && memberOf(HYDRATION_STATUSES, value.status)
  && (value.endpoint === undefined || isEndpoint(value.endpoint))
  && (includes(['succeeded', 'not-needed'], value.status)
    ? value.error === undefined
    : isPublicError(value.error, allowUnknownVocabulary));
const expectedHydrationStatus = (parts: StoredHydrationPart[]) => {
  const statuses = parts.map((entry) => entry.status);
  if (!statuses.length || statuses.every((status) => status === 'not-needed')) return 'not-needed';
  for (const status of ['cancelled', 'invalid', 'client-missing', 'authorization-required', 'failed']) {
    if (statuses.includes(status)) return status;
  }
  return 'succeeded';
};
const isHydration = (value: unknown, allowUnknownVocabulary = false): value is StoredHydration => isPlainObject(value)
  && exactKeys(value, ['status', 'submodules', 'lfs'])
  && memberOf(HYDRATION_STATUSES, value.status)
  && Array.isArray(value.submodules) && value.submodules.length <= 256
  && value.submodules.every((part): part is StoredHydrationPart => isHydrationPart(part, allowUnknownVocabulary))
  && Array.isArray(value.lfs) && value.lfs.length <= 256
  && value.lfs.every((part): part is StoredHydrationPart => isHydrationPart(part, allowUnknownVocabulary))
  && expectedHydrationStatus([...value.submodules, ...value.lfs]) === value.status;
const isSnapshot = (value: JsonValue | undefined, operationId: string, state: string, completedSteps: string[], allowUnknownVocabulary = false): value is StoredNetworkSnapshot => {
  const foreignOperation = allowUnknownVocabulary && !memberOf(OPERATIONS, field(field(value, 'target'), 'operation'));
  const errorCodeFits = (code: string) => STATE_ERROR_CODES[state]?.has(code)
    || (allowUnknownVocabulary && !ERROR_CODES.has(code) && isErrorCodeName(code));
  return isJsonObject(value)
    && exactKeys(value, ['operationId', 'runtimeIdentity', 'transport', 'target', 'completedSteps', 'state'], [
      'error', 'stepResults', 'hydration',
    ])
    && value.operationId === operationId
    && value.state === state
    && isRuntimeIdentity(value.runtimeIdentity)
    && (isTransport(value.transport)
      || value.transport === null && (foreignOperation || field(value.target, 'operation') === 'checkout-hydration'))
    && isTarget(value.target, allowUnknownVocabulary)
    && Array.isArray(value.completedSteps)
    && JSON.stringify(value.completedSteps) === JSON.stringify(completedSteps)
    && (state === 'succeeded' ? value.error === undefined
      : ['planned', 'running'].includes(state) ? value.error === undefined
        : isPublicError(value.error, allowUnknownVocabulary) && errorCodeFits(value.error.code))
    && (value.stepResults === undefined
      ? !(value.target.operation === 'sync' && TERMINAL_STATES.has(state))
      : (value.target.operation === 'sync' || foreignOperation)
        && isStepResults(value.stepResults, allowUnknownVocabulary))
    && !(state === 'partial' && value.target.operation === 'clone'
      && !value.completedSteps.includes('checked-out'))
    && (value.hydration === undefined
      || TERMINAL_STATES.has(state) && isHydration(value.hydration, allowUnknownVocabulary))
    && !(state === 'succeeded' && value.hydration
      && !['succeeded', 'not-needed'].includes(value.hydration.status))
    && validatePublicValue(value);
};

const isOwner = (value: unknown): value is NetworkOperationOwner => isPlainObject(value)
  && exactKeys(value, ['pid', 'host', 'instance'])
  && isSafeInteger(value.pid) && value.pid > 0
  && isIdentifier(value.host, 256) && isIdentifier(value.instance, 128);

function validateRecord(value: JsonValue | undefined, id: JsonValue | undefined, allowUnknownVocabulary = false): asserts value is StoredNetworkRecord {
  const foreignOperation = allowUnknownVocabulary && !memberOf(OPERATIONS, field(field(field(value, 'snapshot'), 'target'), 'operation'));
  if (!isJsonObject(value) || !exactKeys(value, [
    'operationId', 'runtimeIdentity', 'repositoryId', 'targetFingerprints', 'snapshot', 'state',
    'completedSteps', 'createdAt', 'startedAt', 'finishedAt', 'expiresAt',
    'remotePublicationStarted', 'localIntegrationStarted',
  ], ['owner']) || value.operationId !== id
    || (value.owner !== undefined && !isOwner(value.owner)) || !isOperationId(id)
    || !memberOf(TERMINAL_STATES, value.state) && !includes(['planned', 'running'], value.state)
    || !Array.isArray(value.completedSteps) || value.completedSteps.length > (allowUnknownVocabulary ? 32 : STEPS.size)
    || !value.completedSteps.every((step): step is string => memberOf(STEPS, step) || (allowUnknownVocabulary && isVocabularyName(step)))
    || new Set(value.completedSteps).size !== value.completedSteps.length
    || !isTimestamp(value.createdAt)
    || (value.startedAt !== null && (!isTimestamp(value.startedAt) || value.startedAt < value.createdAt))
    || (value.finishedAt !== null && (!isTimestamp(value.finishedAt) || value.finishedAt < value.createdAt))
    || (value.expiresAt !== null && (!isTimestamp(value.expiresAt) || value.finishedAt === null || value.expiresAt < value.finishedAt))
    || typeof value.remotePublicationStarted !== 'boolean'
    || typeof value.localIntegrationStarted !== 'boolean'
    || (value.repositoryId !== null && !isIdentifier(value.repositoryId))
    || !Array.isArray(value.targetFingerprints) || value.targetFingerprints.length > 3
    || value.targetFingerprints.some((fingerprint) => !isIdentifier(fingerprint))
    || !isRuntimeIdentity(value.runtimeIdentity)
    || !isSnapshot(value.snapshot, id, value.state, value.completedSteps, allowUnknownVocabulary)
    || JSON.stringify(value.runtimeIdentity) !== JSON.stringify(value.snapshot.runtimeIdentity)
    || (!foreignOperation && (value.repositoryId !== repositoryIdFor(value.snapshot)
      || JSON.stringify(value.targetFingerprints) !== JSON.stringify(targetFingerprints(value.snapshot.target))))) {
    throw invalidStore();
  }
  if (value.state === 'planned' && (value.startedAt !== null || value.finishedAt !== null || value.expiresAt !== null)) throw invalidStore();
  if (value.state === 'planned' && (value.remotePublicationStarted || value.localIntegrationStarted)) throw invalidStore();
  if (value.state === 'running' && (value.startedAt === null || value.finishedAt !== null || value.expiresAt !== null)) throw invalidStore();
  if (TERMINAL_STATES.has(value.state) && value.finishedAt === null) throw invalidStore();
  if (value.state === 'outcome-unknown' && value.expiresAt !== null) throw invalidStore();
  if (EVICTABLE_STATES.has(value.state) && value.expiresAt === null) throw invalidStore();
  if (!foreignOperation && value.remotePublicationStarted && !['push', 'delete-remote-branch', 'sync'].includes(value.snapshot.target.operation)) throw invalidStore();
  if (!foreignOperation && value.localIntegrationStarted && !['pull', 'sync'].includes(value.snapshot.target.operation)) throw invalidStore();
}
const parseRecord = (value: JsonValue | undefined, id: JsonValue | undefined, allowUnknownVocabulary = false) => {
  validateRecord(value, id, allowUnknownVocabulary);
  return value;
};

function validateState(value: JsonValue | undefined, maxRecords: number, onForeignRecords?: (records: [string, StoredNetworkRecord][]) => void): asserts value is NetworkOperationState {
  if (!isJsonObject(value) || !exactKeys(value, ['version', 'records'])
    || value.version !== VERSION || !isJsonObject(value.records)
    || Object.keys(value.records).length > maxRecords) throw invalidStore();
  const foreign: [string, StoredNetworkRecord][] = [];
  for (const [id, record] of Object.entries(value.records)) {
    try {
      parseRecord(record, id);
    } catch (error) {
      if (errorCode(error) !== 'GIT_NETWORK_OPERATION_STORAGE_INVALID') throw error;
      const parsed = parseRecord(record, id, true);
      foreign.push([id, parsed]);
    }
  }
  onForeignRecords?.(foreign);
}
const parseState = (value: JsonValue | undefined, maxRecords: number, onForeignRecords?: (records: [string, StoredNetworkRecord][]) => void) => {
  validateState(value, maxRecords, onForeignRecords);
  return value;
};

const syncStepResults = (record: StoredNetworkRecord, planned: boolean) => {
  if (record.snapshot.target.operation !== 'sync') return undefined;
  if (planned) return ['fetch', 'pull', 'push'].map((step) => ({ step, status: 'skipped' }));
  const interrupted = (step: string) => ({
    step, status: 'cancelled', error: { code: 'OUTCOME_UNKNOWN', message: 'Server restarted before this step outcome was recorded' },
  });
  if (record.remotePublicationStarted) return [
    { step: 'fetch', status: 'succeeded' },
    { step: 'pull', status: 'succeeded' },
    interrupted('push'),
  ];
  if (record.localIntegrationStarted) return [
    { step: 'fetch', status: 'succeeded' },
    interrupted('pull'),
    { step: 'push', status: 'skipped' },
  ];
  return [interrupted('fetch'), { step: 'pull', status: 'skipped' }, { step: 'push', status: 'skipped' }];
};

const recoveredSnapshot = (record: StoredNetworkRecord, timestamp: number, terminalRetentionMs: number) => {
  const planned = record.state === 'planned';
  const state = planned ? 'cancelled' : 'outcome-unknown';
  let message = 'Server restarted while the Git operation was running; inspect repository state before retrying';
  if (planned) {
    message = 'Server restarted before the Git operation started; the operation was cancelled';
  } else if (record.remotePublicationStarted) {
    message = 'Server restarted after remote publication began; inspect remote and local state before retrying';
  } else if (record.localIntegrationStarted) {
    message = 'Server restarted after local integration began; inspect the repository before retrying';
  }
  const snapshot: StoredNetworkSnapshot = {
    ...record.snapshot,
    state,
    error: { code: planned ? 'CANCELLED' : 'OUTCOME_UNKNOWN', message },
  };
  const stepResults = syncStepResults(record, planned);
  if (stepResults) snapshot.stepResults = stepResults;
  else delete snapshot.stepResults;
  return {
    ...record,
    snapshot,
    state,
    finishedAt: timestamp,
    expiresAt: planned ? timestamp + terminalRetentionMs : null,
  };
};

export function createGitNetworkOperationStore({
  filePath,
  fsImpl = fs,
  now = Date.now,
  maxRecords = DEFAULT_MAX_RECORDS,
  terminalRetentionMs = DEFAULT_TERMINAL_RETENTION_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  lockWaitMs = 2_000,
}: NetworkOperationStoreOptions = {}) {
  if (!path.isAbsolute(filePath || '') || !(now instanceof Function)
    || !Number.isSafeInteger(maxRecords) || maxRecords < 1
    || !Number.isSafeInteger(terminalRetentionMs) || terminalRetentionMs < 0
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError('Git network operation store options are invalid');
  }
  const owner = Object.freeze({ pid: process.pid, host: os.hostname(), instance: randomUUID() });
  const ownerAlive = (recordOwner: NetworkOperationOwner | undefined) => {
    if (!recordOwner) return false;
    if (recordOwner.instance === owner.instance) return true;
    if (recordOwner.host !== owner.host || recordOwner.pid === owner.pid) return false;
    try { process.kill(recordOwner.pid, 0); return true; }
    catch (error) { return errorCode(error) === 'EPERM'; }
  };
  let writes = Promise.resolve();
  let reportedForeignRecords = new Set<string>();
  const reportForeignRecords = (foreign: [string, StoredNetworkRecord][]) => {
    for (const [id, record] of foreign) {
      if (reportedForeignRecords.has(id)) continue;
      console.warn(`[git] operation record ${id} is kept verbatim; this build does not know its ${foreignNames(record)}`);
    }
    reportedForeignRecords = new Set(foreign.map(([id]) => id));
  };
  const enqueue = <Result>(operation: () => Promise<Result>) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const emptyState = (): NetworkOperationState => ({ version: VERSION, records: {} });
  const readState = async () => {
    let handle;
    try {
      handle = await fsImpl.open(occupied(filePath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return emptyState();
      throw errorCode(error) === 'ELOOP' ? invalidStore(error) : error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maxBytes
        || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) throw invalidStore();
      return parseState(JSON.parse(await handle.readFile('utf8')), maxRecords, reportForeignRecords);
    } catch (error) {
      if (errorCode(error) === 'GIT_NETWORK_OPERATION_STORAGE_INVALID') throw error;
      throw invalidStore(error);
    } finally {
      await handle.close();
    }
  };
  const writeState = async (state: NetworkOperationState) => {
    const encoded = `${JSON.stringify(parseState(state, maxRecords), null, 2)}\n`;
    if (Buffer.byteLength(encoded) > maxBytes) throw capacityError();
    await fsImpl.mkdir(path.dirname(occupied(filePath)), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, occupied(filePath));
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const prune = (state: NetworkOperationState, timestamp: number) => {
    let changed = false;
    for (const [id, record] of Object.entries(state.records)) {
      if (EVICTABLE_STATES.has(record.state) && (record.expiresAt ?? 0) <= timestamp) {
        delete state.records[id];
        changed = true;
      }
    }
    return changed;
  };
  const makeCapacity = (state: NetworkOperationState) => {
    const candidates = Object.values(state.records)
      .filter((record) => EVICTABLE_STATES.has(record.state))
      .sort((left, right) => (left.finishedAt ?? 0) - (right.finishedAt ?? 0) || left.operationId.localeCompare(right.operationId));
    while (Object.keys(state.records).length >= maxRecords && candidates.length) {
      delete state.records[occupied(candidates.shift()).operationId];
    }
    if (Object.keys(state.records).length >= maxRecords) throw capacityError();
  };
  const buildRecord = ({ snapshot, createdAt, startedAt = null, finishedAt = null,
    remotePublicationStarted = false, localIntegrationStarted = false, recordOwner }: BuildNetworkRecordInput) => {
    const publicSnapshot = scrubPublicSnapshot(snapshot);
    const state = requiredField(publicSnapshot, 'state');
    const completedSteps = field(publicSnapshot, 'completedSteps');
    const expiresAt = memberOf(EVICTABLE_STATES, state) ? (finishedAt ?? 0) + terminalRetentionMs : null;
    const record: JsonObject = {
      operationId: field(publicSnapshot, 'operationId'),
      runtimeIdentity: field(publicSnapshot, 'runtimeIdentity'),
      repositoryId: repositoryIdFor(publicSnapshot),
      targetFingerprints: targetFingerprints(field(publicSnapshot, 'target')),
      snapshot: publicSnapshot,
      state,
      completedSteps,
      createdAt,
      startedAt,
      finishedAt,
      expiresAt,
      remotePublicationStarted,
      localIntegrationStarted,
    };
    if (recordOwner) record.owner = recordOwner;
    return parseRecord(record, record.operationId);
  };
  const claim = (snapshot: JsonValue) => enqueue(async () => {
    const timestamp = now();
    const record = buildRecord({ snapshot, createdAt: timestamp, recordOwner: owner });
    if (record.state !== 'planned') throw invalidStore();
    const state = await readState();
    prune(state, timestamp);
    if (Object.hasOwn(state.records, record.operationId)) throw conflict();
    makeCapacity(state);
    state.records[record.operationId] = record;
    await writeState(state);
    return clone(record.snapshot);
  });
  const update = (operationId: string, input: JsonValue) => enqueue(async () => {
    if (!isOperationId(operationId) || !isJsonObject(input)
      || !exactKeys(input, ['snapshot'], ['remotePublicationStarted', 'localIntegrationStarted'])
      || input.remotePublicationStarted !== undefined && !isBoolean(input.remotePublicationStarted)
      || input.localIntegrationStarted !== undefined && !isBoolean(input.localIntegrationStarted)) throw invalidStore();
    const state = await readState();
    const current = Object.hasOwn(state.records, operationId) ? state.records[operationId] : null;
    if (!current) throw Object.assign(new Error('Git network operation was not found'), { code: 'GIT_NETWORK_OPERATION_NOT_FOUND' });
    if (TERMINAL_STATES.has(current.state)) {
      if (JSON.stringify(current.snapshot) === JSON.stringify(scrubPublicSnapshot(input.snapshot))) return clone(current.snapshot);
      throw conflict();
    }
    const timestamp = now();
    const snapshot = scrubPublicSnapshot(input.snapshot);
    const nextState = requiredField(snapshot, 'state');
    const startedAt = current.startedAt ?? (nextState === 'running' ? timestamp : null);
    const finishedAt = memberOf(TERMINAL_STATES, nextState) ? timestamp : null;
    const next = buildRecord({
      snapshot,
      createdAt: current.createdAt,
      startedAt,
      finishedAt,
      remotePublicationStarted: current.remotePublicationStarted || input.remotePublicationStarted === true,
      localIntegrationStarted: current.localIntegrationStarted || input.localIntegrationStarted === true,
      recordOwner: current.owner,
    });
    if (JSON.stringify(current.runtimeIdentity) !== JSON.stringify(next.runtimeIdentity)
      || current.repositoryId !== next.repositoryId
      || JSON.stringify(current.targetFingerprints) !== JSON.stringify(next.targetFingerprints)
      || JSON.stringify(immutablePlan(current.snapshot)) !== JSON.stringify(immutablePlan(next.snapshot))
      || current.completedSteps.some((step) => !next.completedSteps.includes(step))
      || current.state === 'planned' && !['running', 'cancelled', 'outcome-unknown'].includes(next.state)
      || current.state === 'running' && next.state === 'planned') throw conflict();
    state.records[operationId] = next;
    await writeState(state);
    return clone(next.snapshot);
  });
  const recover = () => enqueue(async () => {
    const state = await readState();
    const timestamp = now();
    let changed = false;
    for (const [id, record] of Object.entries(state.records)) {
      if ((record.state === 'planned' || record.state === 'running') && !ownerAlive(record.owner)) {
        state.records[id] = parseRecord(recoveredSnapshot(record, timestamp, terminalRetentionMs), id, true);
        changed = true;
      }
    }
    changed = prune(state, timestamp) || changed;
    if (changed) await writeState(state);
    return Object.values(state.records).map((record) => clone(record.snapshot));
  });
  const read = (operationId: string) => enqueue(async () => {
    if (!isOperationId(operationId)) throw invalidStore();
    const state = await readState();
    const changed = prune(state, now());
    if (changed) await writeState(state);
    return Object.hasOwn(state.records, operationId) ? clone(occupied(state.records[operationId]).snapshot) : null;
  });

  return Object.freeze({ claim, update, recover, read });
}
