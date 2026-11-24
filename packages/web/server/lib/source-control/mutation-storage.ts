import { isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from './file-lock.js';
import { allowsTopLevelProjects } from './project-path.js';
import { sourceControlProviderDescriptors } from './provider-descriptors.js';
import { hasSourceControlErrorCode } from './input-guards.js';
import type { SourceControlMutationTarget, SourceControlProjectRef } from '@openchamber/sdk';
import type { AccountIdentity, ResolvedMutationTarget } from './provider-contract.js';

export interface MutationResult {
  project?: SourceControlProjectRef;
  number?: number;
  head?: string;
  base?: string;
  headSha?: string;
  state?: string;
  merged?: boolean;
  outcome?: 'queued' | 'merging' | 'auto-merge' | 'cancelled';
  stacked?: boolean;
  ready?: boolean;
  draft?: boolean;
  commented?: boolean;
  failureStatus?: number;
  failureCode?: string;
}

export interface MutationRecord {
  key: string;
  inputDigest: string;
  kind: string;
  actor: AccountIdentity;
  target: SourceControlMutationTarget;
  state: 'running' | 'succeeded' | 'failed' | 'outcome-unknown';
  startedAt: number;
  updatedAt: number;
  expiresAt: number;
  result?: MutationResult;
}

export type MutationClaim = Omit<MutationRecord, 'state' | 'startedAt' | 'updatedAt' | 'expiresAt' | 'result' | 'target'> & {
  target: ResolvedMutationTarget;
  state?: 'running';
  startedAt?: number;
  updatedAt?: number;
  expiresAt?: number;
};

export interface MutationCompletion {
  state: Exclude<MutationRecord['state'], 'running'>;
  result?: MutationResult | undefined;
}
type MutationResultInput = { [Field in Exclude<keyof MutationResult, 'failureCode'>]?: MutationResult[Field] | undefined } & { failureCode?: unknown };
export interface MutationCompletionInput {
  state: MutationCompletion['state'];
  result?: MutationResultInput | undefined;
}

export interface MutationClaimResult {
  status: 'claimed' | 'existing' | 'conflict';
  record: MutationRecord;
}

interface MutationSnapshot {
  version: number;
  records: Record<string, MutationRecord>;
}

interface MutationStoreOptions {
  filePath: string;
  fsImpl?: typeof fs;
  lockWaitMs?: number;
  now?: () => number;
  maxRecords?: number;
  terminalTtlMs?: number;
}

type MutationValue = MutationSnapshot | MutationRecord | MutationClaim | MutationCompletionInput | AccountIdentity
  | SourceControlProjectRef | SourceControlMutationTarget | MutationResultInput;

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 500;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SOURCE_CONTROL_MUTATION_KINDS = Object.freeze([
  'change-request-create',
  'change-request-update',
  'change-request-merge',
  'change-request-ready',
  'change-request-draft',
  'change-request-comment',
  'change-request-comment-update',
  'change-request-comment-delete',
  'change-request-review',
  'change-request-review-comment',
  'change-request-review-comment-update',
  'change-request-review-comment-delete',
  'change-request-review-discard',
  'issue-comment',
  'issue-update',
  'issue-comment-update',
  'issue-comment-delete',
  'change-request-state',
  'issue-state',
  'change-request-labels',
  'issue-labels',
  'issue-assignees',
  'change-request-reviewers',
  'change-request-thread-reply',
  'change-request-thread-resolve',
  'change-request-thread-start',
  'discussion-comment',
  'discussion-comment-update',
  'discussion-comment-delete',
  'discussion-state',
  'discussion-answer',
  'discussion-labels',
  'discussion-update',
]);
const KINDS = new Set(SOURCE_CONTROL_MUTATION_KINDS);
const STATES = ['running', 'succeeded', 'failed', 'outcome-unknown'];
const TERMINAL_STATES = ['succeeded', 'failed'];
const TARGET_OPTIONAL_KEYS: Array<'number' | 'head' | 'base' | 'headSha'> = ['number', 'head', 'base', 'headSha'];
const RESULT_KEYS: Array<Exclude<keyof MutationResult, 'project'>> = [...TARGET_OPTIONAL_KEYS, 'state', 'merged', 'outcome', 'stacked', 'ready', 'draft', 'commented', 'failureStatus', 'failureCode'];
const MERGE_OUTCOMES = ['queued', 'merging', 'auto-merge', 'cancelled'];

const emptyState = (): MutationSnapshot => ({ version: VERSION, records: {} });
const isBoolean = (value: boolean) => Object.prototype.toString.call(value) === '[object Boolean]';
const isFunction = (value: () => number) => Object.prototype.toString.call(value) === '[object Function]';
const isNonEmptyString = (value: unknown): value is string => isString(value) && value.length > 0;
const hasExactKeys = (value: MutationValue, required: string[], optional: string[] = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const isTimestamp = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value: number) => Number.isSafeInteger(value) && value > 0;
const isNonNegativeInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;
const isFailureStatus = (value: number) => Number.isSafeInteger(value) && value >= 400 && value <= 599;

const invalidState = () => {
  return Object.assign(new Error('Source control mutation storage is invalid'), { code: 'INVALID_SOURCE_CONTROL_MUTATIONS' });
};

const mutationError = (code: string, message: string, record?: MutationRecord) => {
  const error: Error & { code: string; record?: MutationRecord } = Object.assign(new Error(message), { code });
  if (record !== undefined) error.record = record;
  return error;
};

const isActor = (value: AccountIdentity) => isPlainObject(value)
  && hasExactKeys(value, ['provider', 'instance', 'accountId'])
  && isNonEmptyString(value.provider)
  && isNonEmptyString(value.instance)
  && isNonEmptyString(value.accountId);

const isProject = (value: SourceControlProjectRef, provider: string) => isPlainObject(value)
  && hasExactKeys(value, ['id', 'owner', 'name'])
  && isNonEmptyString(value.id)
  && (isNonEmptyString(value.owner)
    || (value.owner === '' && allowsTopLevelProjects(sourceControlProviderDescriptors.get(provider))))
  && isNonEmptyString(value.name);

const isTarget = (value: ResolvedMutationTarget, provider: string) => isPlainObject(value)
  && hasExactKeys(
    value,
    ['repositoryId', 'bindingRevision', 'primaryRemote', 'project'],
    TARGET_OPTIONAL_KEYS,
  )
  && isNonEmptyString(value.repositoryId)
  && isNonNegativeInteger(value.bindingRevision)
  && isNonEmptyString(value.primaryRemote)
  && isProject(value.project, provider)
  && (value.number === undefined || isPositiveInteger(value.number))
  && (value.head === undefined || isNonEmptyString(value.head))
  && (value.base === undefined || isNonEmptyString(value.base))
  && (value.headSha === undefined || isNonEmptyString(value.headSha));

const isTerminalResult = (value: MutationResultInput, provider: string): value is MutationResult => isPlainObject(value)
  && hasExactKeys(value, [], ['project', ...RESULT_KEYS])
  && (value.project === undefined || isProject(value.project, provider))
  && (value.number === undefined || isPositiveInteger(value.number))
  && (value.head === undefined || isNonEmptyString(value.head))
  && (value.base === undefined || isNonEmptyString(value.base))
  && (value.headSha === undefined || isNonEmptyString(value.headSha))
  && (value.state === undefined || isNonEmptyString(value.state))
  && (value.merged === undefined || isBoolean(value.merged))
  && (value.outcome === undefined || MERGE_OUTCOMES.includes(value.outcome))
  && (value.stacked === undefined || isBoolean(value.stacked))
  && (value.commented === undefined || isBoolean(value.commented))
  && (value.ready === undefined || isBoolean(value.ready))
  && (value.draft === undefined || isBoolean(value.draft))
  && (value.failureStatus === undefined || isFailureStatus(value.failureStatus))
  && (value.failureCode === undefined || isNonEmptyString(value.failureCode));

const isRecord = (value: Omit<MutationRecord, 'target'> & { target: ResolvedMutationTarget }, key: string) => {
  if (!isPlainObject(value)
    || !hasExactKeys(
      value,
      ['key', 'inputDigest', 'kind', 'actor', 'target', 'state', 'startedAt', 'updatedAt', 'expiresAt'],
      ['result'],
    )
    || value.key !== key
    || !isNonEmptyString(value.key)
    || !isNonEmptyString(value.inputDigest)
    || !KINDS.has(value.kind)
    || !isActor(value.actor)
    || !isTarget(value.target, value.actor.provider)
    || !STATES.includes(value.state)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.updatedAt)
    || !isTimestamp(value.expiresAt)
    || value.startedAt > value.updatedAt
    || value.updatedAt > value.expiresAt) return false;
  if (value.state === 'running') return value.result === undefined;
  return value.result === undefined || isTerminalResult(value.result, value.actor.provider);
};

const parseState = (value: MutationSnapshot) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['version', 'records'])
    || value.version !== VERSION
    || !isPlainObject(value.records)) throw invalidState();
  for (const [key, record] of Object.entries(value.records)) {
    if (!isRecord(record, key)) throw invalidState();
  }
  return value;
};

const copyProject = (project: SourceControlProjectRef) => ({ id: project.id, owner: project.owner, name: project.name });
const copyTarget = (target: ResolvedMutationTarget) => {
  const copy: SourceControlMutationTarget = {
    repositoryId: target.repositoryId,
    bindingRevision: target.bindingRevision,
    primaryRemote: target.primaryRemote,
    project: copyProject(target.project),
  };
  for (const key of TARGET_OPTIONAL_KEYS) {
    if (target[key] !== undefined) Object.assign(copy, { [key]: target[key] });
  }
  return copy;
};
const copyResult = (result: MutationResult | undefined) => {
  if (result === undefined) return undefined;
  const copy: MutationResult = {};
  for (const key of RESULT_KEYS) {
    if (result[key] !== undefined) Object.assign(copy, { [key]: result[key] });
  }
  if (result.project !== undefined) copy.project = copyProject(result.project);
  return copy;
};
const resultsMatch = (left: MutationResult | undefined, right: MutationResult | undefined) => JSON.stringify(copyResult(left)) === JSON.stringify(copyResult(right));

export function createMutationStore({
  filePath,
  fsImpl = fs,
  lockWaitMs = 2_000,
  now = Date.now,
  maxRecords = DEFAULT_MAX_RECORDS,
  terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
}: MutationStoreOptions) {
  if (!isNonEmptyString(filePath)
    || !isFunction(now)
    || !isPositiveInteger(maxRecords)
    || !isTimestamp(terminalTtlMs)) throw new TypeError('Invalid mutation store options');

  let writes = Promise.resolve();
  const enqueueWrite = <Result>(operation: () => Promise<Result>) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async () => {
    try {
      return parseState(JSON.parse(await fsImpl.readFile(filePath, 'utf8')));
    } catch (error) {
      if (hasSourceControlErrorCode(error) && error.code === 'ENOENT') return emptyState();
      throw error;
    }
  };
  const writeState = async (state: MutationSnapshot) => {
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
  const pruneExpired = (state: MutationSnapshot, timestamp: number) => {
    let changed = false;
    for (const [key, record] of Object.entries(state.records)) {
      if (TERMINAL_STATES.includes(record.state) && record.expiresAt <= timestamp) {
        delete state.records[key];
        changed = true;
      }
    }
    return changed;
  };
  const makeCapacity = (state: MutationSnapshot) => {
    const terminal = Object.values(state.records)
      .filter((record) => TERMINAL_STATES.includes(record.state))
      .sort((left, right) => left.updatedAt - right.updatedAt
        || left.startedAt - right.startedAt
        || left.key.localeCompare(right.key));
    while (Object.keys(state.records).length >= maxRecords && terminal.length) {
      const oldest = terminal.shift();
      if (oldest) delete state.records[oldest.key];
    }
    if (Object.keys(state.records).length >= maxRecords) {
      throw mutationError('SOURCE_CONTROL_MUTATION_CAPACITY', 'Source control mutation storage is at capacity');
    }
  };
  const normalizeClaim = (record: MutationClaim, timestamp: number) => {
    if (!isPlainObject(record)
      || !hasExactKeys(record, ['key', 'inputDigest', 'kind', 'actor', 'target'], ['state', 'startedAt', 'updatedAt', 'expiresAt'])
      || (record.state !== undefined && record.state !== 'running')) throw invalidState();
    const startedAt = record.startedAt ?? timestamp;
    const candidate: Omit<MutationRecord, 'target'> & { target: ResolvedMutationTarget } = {
      key: record.key,
      inputDigest: record.inputDigest,
      kind: record.kind,
      actor: record.actor,
      target: record.target,
      state: 'running',
      startedAt,
      updatedAt: record.updatedAt ?? startedAt,
      expiresAt: record.expiresAt ?? (startedAt + terminalTtlMs),
    };
    if (!isRecord(candidate, candidate.key)) throw invalidState();
    return {
      ...candidate,
      actor: { provider: record.actor.provider, instance: record.actor.instance, accountId: record.actor.accountId },
      target: copyTarget(record.target),
    };
  };

  const claim = (record: MutationClaim) => enqueueWrite<MutationClaimResult>(async () => {
    const timestamp = now();
    if (!isTimestamp(timestamp)) throw new TypeError('Mutation store clock returned an invalid timestamp');
    const candidate = normalizeClaim(record, timestamp);
    const state = await readState();
    const pruned = pruneExpired(state, timestamp);
    const existing = Object.hasOwn(state.records, candidate.key) ? state.records[candidate.key] : undefined;
    if (existing) {
      if (pruned) await writeState(state);
      return existing.inputDigest === candidate.inputDigest
        ? { status: 'existing', record: existing }
        : { status: 'conflict', record: existing };
    }
    makeCapacity(state);
    Object.defineProperty(state.records, candidate.key, {
      value: candidate,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    await writeState(state);
    return { status: 'claimed', record: candidate };
  });

  const complete = (key: string, inputDigest: string, completion: MutationCompletionInput) => enqueueWrite(async () => {
    if (!isNonEmptyString(key)
      || !isNonEmptyString(inputDigest)
      || !isPlainObject(completion)
      || !hasExactKeys(completion, ['state'], ['result'])
      || ![...TERMINAL_STATES, 'outcome-unknown'].includes(completion.state)) throw invalidState();
    const state = await readState();
    const existing = Object.hasOwn(state.records, key) ? state.records[key] : undefined;
    if (!existing) throw mutationError('SOURCE_CONTROL_MUTATION_NOT_FOUND', 'Source control mutation record was not found');
    if (completion.result !== undefined && !isTerminalResult(completion.result, existing.actor.provider)) throw invalidState();
    const result = copyResult(completion.result);
    if (existing.inputDigest !== inputDigest) {
      throw mutationError('SOURCE_CONTROL_MUTATION_CONFLICT', 'Source control mutation digest changed', existing);
    }
    if (existing.state !== 'running') {
      if (existing.state === completion.state && resultsMatch(existing.result, result)) return existing;
      throw mutationError('SOURCE_CONTROL_MUTATION_CONFLICT', 'Source control mutation is already complete', existing);
    }
    const timestamp = now();
    if (!isTimestamp(timestamp) || timestamp < existing.updatedAt) {
      throw new TypeError('Mutation store clock returned an invalid timestamp');
    }
    const completed: MutationRecord = {
      ...existing,
      state: completion.state,
      updatedAt: timestamp,
      expiresAt: timestamp + terminalTtlMs,
    };
    if (result !== undefined) completed.result = result;
    if (!isRecord(completed, key)) throw invalidState();
    state.records[key] = completed;
    await writeState(state);
    return completed;
  });

  const read = (key: string) => enqueueWrite(async () => {
    if (!isNonEmptyString(key)) throw invalidState();
    const records = (await readState()).records;
    return Object.hasOwn(records, key) ? records[key] : null;
  });
  const list = () => enqueueWrite(async () => Object.values((await readState()).records)
    .sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key)));

  const withExecutionLock = <Result>(key: string, operation: () => Result | Promise<Result>) => {
    if (!isNonEmptyString(key)) throw invalidState();
    const digest = createHash('sha256').update(key).digest('hex');
    return withSourceControlFileLock(`${filePath}.execution-${digest}.lock`, operation, { fsImpl, waitMs: lockWaitMs });
  };

  return { claim, complete, read, list, withExecutionLock };
}
