import { hasSourceControlErrorCode, isSourceControlInteger, isSourceControlObject as isPlainObject, isSourceControlString as isString } from './input-guards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from './file-lock.js';
import { SOURCE_CONTROL_MUTATION_KINDS } from './mutation-storage.js';

export interface AuditRuntime {
  id: string;
  platform: string;
  label?: string;
}

type SingleTransportReference = { kind: 'anonymous' } | { kind: 'managed'; credentialId: string }
  | { kind: 'system'; marker: 'system-credentials' | 'local-checkout-actions' };
interface AuxiliaryTransportEntry {
  kind: 'submodule' | 'lfs';
  endpointFingerprint: string;
  transport: SingleTransportReference;
}
type AuditTransportReference = SingleTransportReference | null
  | { kind: 'auxiliary'; entries: AuxiliaryTransportEntry[] }
  | { kind: 'sync'; fetch: SingleTransportReference; push: SingleTransportReference };
interface RemoteTarget {
  role: 'operation' | 'fetch' | 'push';
  name: string;
  endpointFingerprint: string;
  sourceRef?: string;
  destinationRef?: string;
}
interface AuxiliaryTarget {
  kind: 'submodule' | 'lfs';
  endpointFingerprint: string;
}
interface GitTarget {
  kind: 'git-network';
  operation: string;
  remotes: RemoteTarget[];
  destination?: { displayName: string; fingerprint: string };
  fetchScope?: 'remote';
  force?: boolean;
  auxiliaries?: AuxiliaryTarget[];
}
interface ProviderTarget {
  kind: 'issue' | 'discussion' | 'change-request';
  operation: string;
  projectId: string;
  number?: number;
  head?: string;
  base?: string;
  headSha?: string;
}
type AuditTarget = GitTarget | ProviderTarget;
type AuditState = 'planned' | 'running' | 'succeeded' | 'partial' | 'conflicted' | 'failed' | 'cancelled' | 'outcome-unknown';
export interface AuditResult {
  state: Exclude<AuditState, 'planned' | 'running'>;
  errorCode: string | null;
  steps: string[];
}
export type AuditResultInput = Omit<AuditResult, 'state'> & { state: string };
export interface AuditRecord {
  id: string;
  initiator: 'user';
  executorKind: 'openchamber-server-git' | 'provider-api';
  runtime: AuditRuntime;
  repositoryId: string | null;
  providerAccountId: string | null;
  transportReference: AuditTransportReference;
  target: AuditTarget;
  state: AuditState;
  plannedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: AuditResult | null;
  expiresAt: number | null;
}
export type AuditPlan = Omit<AuditRecord, 'state' | 'plannedAt' | 'startedAt' | 'finishedAt' | 'result' | 'expiresAt'> & {
  plannedAt?: number;
};
interface AuditSnapshot {
  version: number;
  records: Record<string, AuditRecord>;
}
interface AuditStoreOptions {
  filePath?: string;
  fsImpl?: typeof fs;
  lockWaitMs?: number;
  now?: () => number;
  maxRecords?: number;
  terminalTtlMs?: number;
}
type AuditValue = AuditRecord | AuditPlan | AuditResultInput | AuditSnapshot | AuditRuntime | SingleTransportReference
  | Exclude<AuditTransportReference, null> | RemoteTarget | AuxiliaryTarget | AuxiliaryTransportEntry | AuditTarget
  | NonNullable<GitTarget['destination']>;

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 1_000;
const DEFAULT_TERMINAL_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNSTARTED_GIT_PLAN_TTL_MS = 60 * 60 * 1000;
const EXECUTORS = new Set(['openchamber-server-git', 'provider-api']);
const STATES = new Set(['planned', 'running', 'succeeded', 'partial', 'conflicted', 'failed', 'cancelled', 'outcome-unknown']);
const TERMINAL_STATES = new Set(['succeeded', 'partial', 'conflicted', 'failed', 'cancelled']);
const GIT_OPERATIONS = new Set([
  'push', 'fetch', 'pull', 'delete-remote-branch', 'sync', 'clone',
  'contributor-fetch', 'checkout-hydration', 'checkout-actions',
]);
const PROVIDER_OPERATIONS = new Set(SOURCE_CONTROL_MUTATION_KINDS);
export const providerTargetKind = (operation: string) => {
  if (operation.startsWith('issue-')) return 'issue';
  return operation.startsWith('discussion-') ? 'discussion' : 'change-request';
};
const isKnownOperation = (operation: string) => PROVIDER_OPERATIONS.has(operation) || GIT_OPERATIONS.has(operation);
const isUnknownOperation = (value: AuditTarget, allowUnknownVocabulary: boolean) => allowUnknownVocabulary
  && isString(value.operation) && !isKnownOperation(value.operation);
const RESULT_STEPS = new Set([
  'validated', 'authenticated', 'transferred', 'updated-local-repository', 'checked-out', 'cleaned-up',
  'fetch:succeeded', 'fetch:skipped', 'fetch:conflicted', 'fetch:failed', 'fetch:cancelled',
  'pull:succeeded', 'pull:skipped', 'pull:conflicted', 'pull:failed', 'pull:cancelled',
  'push:succeeded', 'push:skipped', 'push:conflicted', 'push:failed', 'push:cancelled',
  'provider-request', 'provider-reconciliation',
]);

const emptyState = (): AuditSnapshot => ({ version: VERSION, records: {} });
const hasExactKeys = (value: AuditValue, required: string[], optional: string[] = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const isTimestamp = (value: unknown): value is number => isSourceControlInteger(value) && value >= 0;
const isPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const isBoundedText = (value: unknown, max = 512): value is string => isString(value)
  && value.length > 0 && value.length <= max && value.trim() === value
  && !/[\0\r\n]/.test(value);
const isSafeText = (value: unknown, max = 512): value is string => isBoundedText(value, max)
  && !/[a-z][a-z0-9+.-]*:\/\//i.test(value);
const isOpaqueReference = (value: unknown, max = 1024): value is string => isBoundedText(value, max)
  && /^[A-Za-z0-9._:-]+$/.test(value);
const isFingerprint = (value: unknown): value is string => isString(value) && /^[A-Za-z0-9_-]{43}$/.test(value);
const isNullableText = (value: string | null) => value === null || isSafeText(value);
const isNullableAccountId = (value: string | null) => value === null || isBoundedText(value);
const isVocabularyName = (value: unknown, max: number): value is string => isBoundedText(value, max) && /^[a-z][a-z0-9:-]*$/.test(value);

const invalidStore = () => Object.assign(new Error('Source control audit storage is invalid'), {
  code: 'INVALID_SOURCE_CONTROL_AUDIT',
});
const conflict = (record: AuditRecord) => Object.assign(new Error('Source control audit record conflicts with existing state'), {
  code: 'SOURCE_CONTROL_AUDIT_CONFLICT', record,
});

const isRuntime = (value: AuditRuntime) => isPlainObject(value)
  && hasExactKeys(value, ['id', 'platform'], ['label'])
  && isSafeText(value.id)
  && isSafeText(value.platform)
  && (value.label === undefined || isSafeText(value.label));
const isSingleTransportReference = (value: AuditTransportReference): value is SingleTransportReference => isPlainObject(value)
  && ((hasExactKeys(value, ['kind']) && value.kind === 'anonymous')
    || (hasExactKeys(value, ['kind', 'credentialId'])
    && value.kind === 'managed' && isOpaqueReference(value.credentialId))
    || (hasExactKeys(value, ['kind', 'marker'])
      && value.kind === 'system' && ['system-credentials', 'local-checkout-actions'].includes(value.marker)));
const isAuxiliaryTransportEntry = (value: AuxiliaryTransportEntry) => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'endpointFingerprint', 'transport'])
  && ['submodule', 'lfs'].includes(value.kind)
  && isFingerprint(value.endpointFingerprint)
  && isSingleTransportReference(value.transport)
  && (value.transport.kind !== 'system' || value.transport.marker === 'system-credentials');
const isTransportReference = (value: AuditTransportReference) => value === null
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
const isRemoteTarget = (value: RemoteTarget) => isPlainObject(value)
  && hasExactKeys(value, ['role', 'name', 'endpointFingerprint'], ['sourceRef', 'destinationRef'])
  && ['operation', 'fetch', 'push'].includes(value.role)
  && isSafeText(value.name)
  && isSafeText(value.endpointFingerprint, 1024)
  && (value.sourceRef === undefined || isSafeText(value.sourceRef, 1024))
  && (value.destinationRef === undefined || isSafeText(value.destinationRef, 1024));
const isAuxiliaryTarget = (value: AuxiliaryTarget) => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'endpointFingerprint'])
  && ['submodule', 'lfs'].includes(value.kind)
  && isFingerprint(value.endpointFingerprint);
const isGitTarget = (value: AuditTarget, allowUnknownVocabulary = false): value is GitTarget => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'operation', 'remotes'], ['destination', 'fetchScope', 'force', 'auxiliaries'])
  && value.kind === 'git-network'
  && (GIT_OPERATIONS.has(value.operation)
    || (isUnknownOperation(value, allowUnknownVocabulary) && isVocabularyName(value.operation, 128)))
  && Array.isArray(value.remotes) && value.remotes.length <= 2 && value.remotes.every(isRemoteTarget)
  && (value.auxiliaries === undefined || ((value.operation === 'checkout-hydration'
      || isUnknownOperation(value, allowUnknownVocabulary))
    && value.remotes.length === 0 && Array.isArray(value.auxiliaries) && value.auxiliaries.length <= 256
    && value.auxiliaries.every(isAuxiliaryTarget)
    && new Set(value.auxiliaries.map((entry) => `${entry.kind}\0${entry.endpointFingerprint}`)).size === value.auxiliaries.length))
  && (value.fetchScope === undefined ? value.force === undefined
    : (value.operation === 'fetch' || isUnknownOperation(value, allowUnknownVocabulary))
      && value.fetchScope === 'remote'
      && (value.force === true || value.force === false) && value.destination === undefined
      && value.remotes.length === 1 && value.remotes[0]?.role === 'operation'
      && value.remotes[0]?.sourceRef === undefined && value.remotes[0]?.destinationRef === undefined)
  && (value.destination === undefined || (isPlainObject(value.destination)
    && hasExactKeys(value.destination, ['displayName', 'fingerprint'])
    && isSafeText(value.destination.displayName) && isSafeText(value.destination.fingerprint, 1024)));
const isProviderTarget = (value: AuditTarget, allowUnknownVocabulary = false): value is ProviderTarget => isPlainObject(value)
  && hasExactKeys(value, ['kind', 'operation', 'projectId'], ['number', 'head', 'base', 'headSha'])
  && (PROVIDER_OPERATIONS.has(value.operation)
    || (isUnknownOperation(value, allowUnknownVocabulary) && isVocabularyName(value.operation, 128)))
  && value.kind === providerTargetKind(value.operation)
  && isSafeText(value.projectId, 1024)
  && (value.number === undefined || isPositiveInteger(value.number))
  && (value.head === undefined || isSafeText(value.head, 1024))
  && (value.base === undefined || isSafeText(value.base, 1024))
  && (value.headSha === undefined || isSafeText(value.headSha, 1024));
const isTarget = (value: AuditTarget, allowUnknownVocabulary = false) => isGitTarget(value, allowUnknownVocabulary)
  || isProviderTarget(value, allowUnknownVocabulary);
const hydrationTransportMatchesTarget = (reference: AuditTransportReference, target: AuditTarget, allowUnknownVocabulary = false) => {
  if (target.kind !== 'git-network') return false;
  const unknownOperation = isUnknownOperation(target, allowUnknownVocabulary);
  if (!unknownOperation && target.operation !== 'checkout-hydration') {
    return target.operation === 'sync'
      ? isPlainObject(reference) && reference.kind === 'sync'
      : isSingleTransportReference(reference);
  }
  if (target.auxiliaries === undefined) {
    return isSingleTransportReference(reference)
      || (unknownOperation && (reference === null || reference.kind === 'sync'));
  }
  if (reference === null) return true;
  if (reference.kind !== 'auxiliary') return unknownOperation && isSingleTransportReference(reference);
  const targets = new Set(target.auxiliaries.map((entry) => `${entry.kind}\0${entry.endpointFingerprint}`));
  return reference.entries.every((entry) => targets.has(`${entry.kind}\0${entry.endpointFingerprint}`));
};
const isResult = (value: AuditResultInput | null, allowUnknownVocabulary = false): value is AuditResult => isPlainObject(value)
  && hasExactKeys(value, ['state', 'errorCode', 'steps'])
  && STATES.has(value.state) && !['planned', 'running'].includes(value.state)
  && isNullableText(value.errorCode)
  && Array.isArray(value.steps) && value.steps.length <= 32
  && value.steps.every((step) => RESULT_STEPS.has(step)
    || (allowUnknownVocabulary && isVocabularyName(step, 64)));
const isRecord = (value: AuditRecord, id: string, allowUnknownVocabulary = false) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, [
      'id', 'initiator', 'executorKind', 'runtime', 'repositoryId', 'providerAccountId',
      'transportReference', 'target', 'state', 'plannedAt', 'startedAt', 'finishedAt', 'result', 'expiresAt',
    ])
    || value.id !== id || !isOpaqueReference(value.id) || value.initiator !== 'user'
    || !EXECUTORS.has(value.executorKind) || !isRuntime(value.runtime)
    || !isNullableText(value.repositoryId) || !isNullableAccountId(value.providerAccountId)
    || !isTransportReference(value.transportReference) || !isTarget(value.target, allowUnknownVocabulary)
    || (value.executorKind === 'provider-api' && (value.transportReference !== null || !isProviderTarget(value.target, allowUnknownVocabulary)))
    || (value.executorKind === 'openchamber-server-git' && (value.target.kind !== 'git-network'
      || !hydrationTransportMatchesTarget(value.transportReference, value.target, allowUnknownVocabulary)))
    || (value.target.kind === 'git-network' && value.target.auxiliaries !== undefined
      && value.providerAccountId !== null)
    || !STATES.has(value.state) || !isTimestamp(value.plannedAt)
    || (value.startedAt !== null && (!isTimestamp(value.startedAt) || value.startedAt < value.plannedAt))
    || (value.finishedAt !== null && (!isTimestamp(value.finishedAt) || value.startedAt === null || value.finishedAt < value.startedAt))) {
    return false;
  }
  if (value.state === 'planned') return value.startedAt === null && value.finishedAt === null && value.result === null && value.expiresAt === null;
  if (value.state === 'running') return value.startedAt !== null && value.finishedAt === null && value.result === null && value.expiresAt === null;
  if (value.finishedAt === null || !isResult(value.result, allowUnknownVocabulary) || value.result.state !== value.state) return false;
  return TERMINAL_STATES.has(value.state)
    ? isTimestamp(value.expiresAt) && value.expiresAt >= value.finishedAt
    : value.expiresAt === null;
};
const foreignNames = (record: AuditRecord) => {
  const operation = record?.target?.operation;
  const steps = Array.isArray(record?.result?.steps) ? record.result.steps.filter((step) => !RESULT_STEPS.has(step)) : [];
  return [
    ...(isKnownOperation(operation) ? [] : [`operation ${operation}`]),
    ...steps.map((step) => `step ${step}`),
  ].join(', ');
};
const parseState = (value: AuditSnapshot, onForeignRecords?: (foreign: Array<[string, AuditRecord]>) => void) => {
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'records'])
    || value.version !== VERSION || !isPlainObject(value.records)) throw invalidStore();
  const foreign: Array<[string, AuditRecord]> = [];
  const records = Object.fromEntries(Object.entries(value.records).map(([id, record]) => {
    if (!isRecord(record, id)) {
      if (!isRecord(record, id, true)) throw invalidStore();
      foreign.push([id, record]);
    }
    return [id, record];
  }));
  onForeignRecords?.(foreign);
  return { version: VERSION, records };
};
const copy = <Value extends AuditPlan | AuditResult>(value: Value): Value => JSON.parse(JSON.stringify(value));
const sameImmutableRecord = (left: AuditRecord, right: AuditRecord) => JSON.stringify({
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
}: AuditStoreOptions = {}) {
  if (!isSafeText(filePath, 4096) || !(now instanceof Function)
    || !isPositiveInteger(maxRecords) || !isTimestamp(terminalTtlMs)) {
    throw new TypeError('Invalid source control audit store options');
  }
  let writes = Promise.resolve();
  let reportedForeignRecords = new Set();
  const reportForeignRecords = (foreign: Array<[string, AuditRecord]>) => {
    for (const [id, record] of foreign) {
      if (reportedForeignRecords.has(id)) continue;
      console.warn(`[source-control] audit record ${id} is kept verbatim; this build does not know its ${foreignNames(record)}`);
    }
    reportedForeignRecords = new Set(foreign.map(([id]) => id));
  };
  const enqueue = <Result>(operation: () => Promise<Result>) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async () => {
    try {
      return parseState(JSON.parse(await fsImpl.readFile(filePath, 'utf8')), reportForeignRecords);
    } catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return emptyState();
      throw error;
    }
  };
  const writeState = async (state: AuditSnapshot) => {
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
  const prune = (state: AuditSnapshot, timestamp: number) => {
    for (const [id, record] of Object.entries(state.records)) {
      if (TERMINAL_STATES.has(record.state) && record.expiresAt !== null && record.expiresAt <= timestamp) delete state.records[id];
      else if (record.executorKind === 'openchamber-server-git' && record.state === 'planned'
        && record.plannedAt + UNSTARTED_GIT_PLAN_TTL_MS <= timestamp) delete state.records[id];
    }
  };
  const makeCapacity = (state: AuditSnapshot) => {
    const terminal = Object.values(state.records)
      .filter((record): record is AuditRecord & { finishedAt: number } => TERMINAL_STATES.has(record.state) && record.finishedAt !== null)
      .sort((left, right) => left.finishedAt - right.finishedAt || left.id.localeCompare(right.id));
    while (Object.keys(state.records).length >= maxRecords && terminal.length) {
      const oldest = terminal.shift();
      if (oldest) delete state.records[oldest.id];
    }
    if (Object.keys(state.records).length >= maxRecords) {
      throw Object.assign(new Error('Source control audit storage is at capacity'), { code: 'SOURCE_CONTROL_AUDIT_CAPACITY' });
    }
  };
  const plan = (input: AuditPlan) => enqueue(async () => {
    const timestamp = now();
    const candidate: AuditRecord = copy({ ...input, state: 'planned', plannedAt: input?.plannedAt ?? timestamp,
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
  const start = (id: string) => enqueue(async () => {
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
  const finish = (id: string, result: AuditResultInput) => enqueue(async () => {
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
    const completed: AuditRecord = { ...record, state: result.state, startedAt, finishedAt: timestamp, result: copy(result),
      expiresAt: TERMINAL_STATES.has(result.state) ? timestamp + terminalTtlMs : null };
    if (!isRecord(completed, id)) throw invalidStore();
    state.records[id] = completed;
    await writeState(state);
    return completed;
  });
  const read = (id: string) => enqueue(async () => {
    if (!isOpaqueReference(id)) throw invalidStore();
    const records = (await readState()).records;
    return Object.hasOwn(records, id) ? records[id] : null;
  });
  const list = () => enqueue(async () => Object.values((await readState()).records)
    .sort((left, right) => left.plannedAt - right.plannedAt || left.id.localeCompare(right.id)));
  return Object.freeze({ plan, start, finish, read, list });
}
