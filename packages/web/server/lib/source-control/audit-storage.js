import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from './file-lock.js';

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 1_000;
const DEFAULT_TERMINAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const EXECUTORS = new Set(['openchamber-server-git', 'provider-api']);
const STATES = new Set(['planned', 'running', 'succeeded', 'partial', 'conflicted', 'failed', 'cancelled', 'outcome-unknown']);
const TERMINAL_STATES = new Set(['succeeded', 'partial', 'conflicted', 'failed', 'cancelled']);
const GIT_OPERATIONS = new Set([
  'push', 'fetch', 'pull', 'delete-remote-branch', 'sync', 'clone',
  'contributor-fetch', 'checkout-hydration', 'checkout-actions',
]);
const PROVIDER_OPERATIONS = new Set([
  'change-request-create', 'change-request-update', 'change-request-merge', 'change-request-ready',
]);
const RESULT_STEPS = new Set([
  'validated', 'authenticated', 'transferred', 'updated-local-repository', 'checked-out', 'cleaned-up',
  'fetch:succeeded', 'fetch:skipped', 'fetch:conflicted', 'fetch:failed', 'fetch:cancelled',
  'pull:succeeded', 'pull:skipped', 'pull:conflicted', 'pull:failed', 'pull:cancelled',
  'push:succeeded', 'push:skipped', 'push:conflicted', 'push:failed', 'push:cancelled',
  'provider-request', 'provider-reconciliation',
]);

const emptyState = () => ({ version: VERSION, records: {} });
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const hasExactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const isBoundedText = (value, max = 512) => isString(value)
  && value.length > 0 && value.length <= max && value.trim() === value
  && !/[\0\r\n]/.test(value);
const isSafeText = (value, max = 512) => isBoundedText(value, max)
  && !/[a-z][a-z0-9+.-]*:\/\//i.test(value);
const isOpaqueReference = (value, max = 1024) => isBoundedText(value, max)
  && /^[A-Za-z0-9._:-]+$/.test(value);
const isFingerprint = (value) => isString(value) && /^[A-Za-z0-9_-]{43}$/.test(value);
const isNullableText = (value) => value === null || isSafeText(value);
const isNullableAccountId = (value) => value === null || isBoundedText(value);

const invalidStore = () => Object.assign(new Error('Source control audit storage is invalid'), {
  code: 'INVALID_SOURCE_CONTROL_AUDIT',
});
const conflict = (record) => Object.assign(new Error('Source control audit record conflicts with existing state'), {
  code: 'SOURCE_CONTROL_AUDIT_CONFLICT', record,
});

const isRuntime = (value) => isPlainObject(value)
  && hasExactKeys(value, ['id', 'platform'], ['label'])
  && isSafeText(value.id)
  && isSafeText(value.platform)
  && (value.label === undefined || isSafeText(value.label));
const isSingleTransportReference = (value) => isPlainObject(value)
  && ((hasExactKeys(value, ['kind']) && value.kind === 'anonymous')
    || (hasExactKeys(value, ['kind', 'credentialId'])
    && value.kind === 'managed' && isOpaqueReference(value.credentialId))
    || (hasExactKeys(value, ['kind', 'marker'])
      && value.kind === 'system' && ['system-credentials', 'local-checkout-actions'].includes(value.marker)));
const isAuxiliaryTransportEntry = (value) => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'endpointFingerprint', 'transport'])
  && ['submodule', 'lfs'].includes(value.kind)
  && isFingerprint(value.endpointFingerprint)
  && isSingleTransportReference(value.transport)
  && (value.transport.kind !== 'system' || value.transport.marker === 'system-credentials');
const isTransportReference = (value) => value === null
  || isSingleTransportReference(value)
  || (isPlainObject(value) && hasExactKeys(value, ['kind', 'entries'])
    && value.kind === 'auxiliary'
    && Array.isArray(value.entries) && value.entries.length > 0 && value.entries.length <= 256
    && value.entries.every(isAuxiliaryTransportEntry)
    && new Set(value.entries.map((entry) => `${entry.kind}\0${entry.endpointFingerprint}`)).size === value.entries.length)
  || (isPlainObject(value) && hasExactKeys(value, ['kind', 'fetch', 'push'])
    && value.kind === 'sync'
    && isSingleTransportReference(value.fetch)
    && isSingleTransportReference(value.push));
const isRemoteTarget = (value) => isPlainObject(value)
  && hasExactKeys(value, ['role', 'name', 'endpointFingerprint'], ['sourceRef', 'destinationRef'])
  && ['operation', 'fetch', 'push'].includes(value.role)
  && isSafeText(value.name)
  && isSafeText(value.endpointFingerprint, 1024)
  && (value.sourceRef === undefined || isSafeText(value.sourceRef, 1024))
  && (value.destinationRef === undefined || isSafeText(value.destinationRef, 1024));
const isAuxiliaryTarget = (value) => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'endpointFingerprint'])
  && ['submodule', 'lfs'].includes(value.kind)
  && isFingerprint(value.endpointFingerprint);
const isGitTarget = (value) => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'operation', 'remotes'], ['destination', 'fetchScope', 'force', 'auxiliaries'])
  && value.kind === 'git-network'
  && GIT_OPERATIONS.has(value.operation)
  && Array.isArray(value.remotes) && value.remotes.length <= 2 && value.remotes.every(isRemoteTarget)
  && (value.auxiliaries === undefined || (value.operation === 'checkout-hydration'
    && value.remotes.length === 0 && Array.isArray(value.auxiliaries) && value.auxiliaries.length <= 256
    && value.auxiliaries.every(isAuxiliaryTarget)
    && new Set(value.auxiliaries.map((entry) => `${entry.kind}\0${entry.endpointFingerprint}`)).size === value.auxiliaries.length))
  && (value.fetchScope === undefined ? value.force === undefined
    : value.operation === 'fetch' && value.fetchScope === 'remote'
      && (value.force === true || value.force === false) && value.destination === undefined
      && value.remotes.length === 1 && value.remotes[0].role === 'operation'
      && value.remotes[0].sourceRef === undefined && value.remotes[0].destinationRef === undefined)
  && (value.destination === undefined || (isPlainObject(value.destination)
    && hasExactKeys(value.destination, ['displayName', 'fingerprint'])
    && isSafeText(value.destination.displayName) && isSafeText(value.destination.fingerprint, 1024)));
const isProviderTarget = (value) => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'operation', 'projectId'], ['number', 'head', 'base', 'headSha'])
  && value.kind === 'change-request'
  && PROVIDER_OPERATIONS.has(value.operation)
  && isSafeText(value.projectId, 1024)
  && (value.number === undefined || isPositiveInteger(value.number))
  && (value.head === undefined || isSafeText(value.head, 1024))
  && (value.base === undefined || isSafeText(value.base, 1024))
  && (value.headSha === undefined || isSafeText(value.headSha, 1024));
const isTarget = (value) => isGitTarget(value) || isProviderTarget(value);
const hydrationTransportMatchesTarget = (reference, target) => {
  if (target.kind !== 'git-network') return false;
  if (target.operation !== 'checkout-hydration') {
    return target.operation === 'sync'
      ? isPlainObject(reference) && reference.kind === 'sync'
      : isSingleTransportReference(reference);
  }
  if (target.auxiliaries === undefined) return isSingleTransportReference(reference);
  if (reference === null) return true;
  if (reference.kind !== 'auxiliary') return false;
  const targets = new Set((target.auxiliaries ?? []).map((entry) => `${entry.kind}\0${entry.endpointFingerprint}`));
  return reference.entries.every((entry) => targets.has(`${entry.kind}\0${entry.endpointFingerprint}`));
};
const isResult = (value) => isPlainObject(value)
  && hasExactKeys(value, ['state', 'errorCode', 'steps'])
  && STATES.has(value.state) && !['planned', 'running'].includes(value.state)
  && isNullableText(value.errorCode)
  && Array.isArray(value.steps) && value.steps.length <= 32
  && value.steps.every((step) => RESULT_STEPS.has(step));
const isRecord = (value, id) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, [
      'id', 'initiator', 'executorKind', 'runtime', 'repositoryId', 'providerAccountId',
      'transportReference', 'target', 'state', 'plannedAt', 'startedAt', 'finishedAt', 'result', 'expiresAt',
    ])
    || value.id !== id || !isOpaqueReference(value.id) || value.initiator !== 'user'
    || !EXECUTORS.has(value.executorKind) || !isRuntime(value.runtime)
    || !isNullableText(value.repositoryId) || !isNullableAccountId(value.providerAccountId)
    || !isTransportReference(value.transportReference) || !isTarget(value.target)
    || (value.executorKind === 'provider-api' && (value.transportReference !== null || value.target.kind !== 'change-request'))
    || (value.executorKind === 'openchamber-server-git' && (value.target.kind !== 'git-network'
      || !hydrationTransportMatchesTarget(value.transportReference, value.target)))
    || (value.target.kind === 'git-network' && value.target.operation === 'checkout-hydration'
      && value.target.auxiliaries !== undefined
      && value.providerAccountId !== null)
    || !STATES.has(value.state) || !isTimestamp(value.plannedAt)
    || (value.startedAt !== null && (!isTimestamp(value.startedAt) || value.startedAt < value.plannedAt))
    || (value.finishedAt !== null && (!isTimestamp(value.finishedAt) || value.startedAt === null || value.finishedAt < value.startedAt))) {
    return false;
  }
  if (value.state === 'planned') return value.startedAt === null && value.finishedAt === null && value.result === null && value.expiresAt === null;
  if (value.state === 'running') return value.startedAt !== null && value.finishedAt === null && value.result === null && value.expiresAt === null;
  if (value.finishedAt === null || !isResult(value.result) || value.result.state !== value.state) return false;
  return TERMINAL_STATES.has(value.state)
    ? isTimestamp(value.expiresAt) && value.expiresAt >= value.finishedAt
    : value.expiresAt === null;
};
const parseState = (value) => {
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'records'])
    || value.version !== VERSION || !isPlainObject(value.records)) throw invalidStore();
  for (const [id, record] of Object.entries(value.records)) if (!isRecord(record, id)) throw invalidStore();
  return value;
};
const copy = (value) => JSON.parse(JSON.stringify(value));
const sameImmutableRecord = (left, right) => JSON.stringify({
  id: left.id, initiator: left.initiator, executorKind: left.executorKind, runtime: left.runtime,
  repositoryId: left.repositoryId, providerAccountId: left.providerAccountId,
  transportReference: left.transportReference, target: left.target,
}) === JSON.stringify({
  id: right.id, initiator: right.initiator, executorKind: right.executorKind, runtime: right.runtime,
  repositoryId: right.repositoryId, providerAccountId: right.providerAccountId,
  transportReference: right.transportReference, target: right.target,
});

export function createSourceControlAuditStore({
  filePath,
  fsImpl = fs,
  lockWaitMs = 2_000,
  now = Date.now,
  maxRecords = DEFAULT_MAX_RECORDS,
  terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
} = {}) {
  if (!isSafeText(filePath, 4096) || !(now instanceof Function)
    || !isPositiveInteger(maxRecords) || !isTimestamp(terminalTtlMs)) {
    throw new TypeError('Invalid source control audit store options');
  }
  let writes = Promise.resolve();
  const enqueue = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async () => {
    try {
      return parseState(JSON.parse(await fsImpl.readFile(filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error;
    }
  };
  const writeState = async (state) => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const prune = (state, timestamp) => {
    for (const [id, record] of Object.entries(state.records)) {
      if (TERMINAL_STATES.has(record.state) && record.expiresAt <= timestamp) delete state.records[id];
    }
  };
  const makeCapacity = (state) => {
    const terminal = Object.values(state.records)
      .filter((record) => TERMINAL_STATES.has(record.state))
      .sort((left, right) => left.finishedAt - right.finishedAt || left.id.localeCompare(right.id));
    while (Object.keys(state.records).length >= maxRecords && terminal.length) delete state.records[terminal.shift().id];
    if (Object.keys(state.records).length >= maxRecords) {
      throw Object.assign(new Error('Source control audit storage is at capacity'), { code: 'SOURCE_CONTROL_AUDIT_CAPACITY' });
    }
  };
  const plan = (input) => enqueue(async () => {
    const timestamp = now();
    const candidate = copy({ ...input, state: 'planned', plannedAt: input?.plannedAt ?? timestamp,
      startedAt: null, finishedAt: null, result: null, expiresAt: null });
    if (!isTimestamp(timestamp) || !isRecord(candidate, candidate.id)) throw invalidStore();
    const state = await readState();
    prune(state, timestamp);
    const existing = Object.hasOwn(state.records, candidate.id) ? state.records[candidate.id] : null;
    if (existing) {
      if (!sameImmutableRecord(existing, candidate)) throw conflict(existing);
      return { status: 'existing', record: existing };
    }
    makeCapacity(state);
    Object.defineProperty(state.records, candidate.id, { value: candidate, enumerable: true, configurable: true, writable: true });
    await writeState(state);
    return { status: 'planned', record: candidate };
  });
  const start = (id) => enqueue(async () => {
    if (!isOpaqueReference(id)) throw invalidStore();
    const state = await readState();
    const record = Object.hasOwn(state.records, id) ? state.records[id] : null;
    if (!record) throw Object.assign(new Error('Source control audit record was not found'), { code: 'SOURCE_CONTROL_AUDIT_NOT_FOUND' });
    if (record.state !== 'planned') return record;
    const timestamp = now();
    if (!isTimestamp(timestamp) || timestamp < record.plannedAt) throw invalidStore();
    state.records[id] = { ...record, state: 'running', startedAt: timestamp };
    await writeState(state);
    return state.records[id];
  });
  const finish = (id, result) => enqueue(async () => {
    if (!isOpaqueReference(id) || !isResult(result)) throw invalidStore();
    const state = await readState();
    const record = Object.hasOwn(state.records, id) ? state.records[id] : null;
    if (!record) throw Object.assign(new Error('Source control audit record was not found'), { code: 'SOURCE_CONTROL_AUDIT_NOT_FOUND' });
    if (!['planned', 'running'].includes(record.state)) {
      if (JSON.stringify(record.result) === JSON.stringify(result)) return record;
      throw conflict(record);
    }
    const timestamp = now();
    const startedAt = record.startedAt ?? timestamp;
    if (!isTimestamp(timestamp) || timestamp < record.plannedAt || timestamp < startedAt) throw invalidStore();
    const completed = { ...record, state: result.state, startedAt, finishedAt: timestamp, result: copy(result),
      expiresAt: TERMINAL_STATES.has(result.state) ? timestamp + terminalTtlMs : null };
    if (!isRecord(completed, id)) throw invalidStore();
    state.records[id] = completed;
    await writeState(state);
    return completed;
  });
  const read = (id) => enqueue(async () => {
    if (!isOpaqueReference(id)) throw invalidStore();
    const records = (await readState()).records;
    return Object.hasOwn(records, id) ? records[id] : null;
  });
  const list = () => enqueue(async () => Object.values((await readState()).records)
    .sort((left, right) => left.plannedAt - right.plannedAt || left.id.localeCompare(right.id)));
  return Object.freeze({ plan, start, finish, read, list });
}
