import { isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from './file-lock.js';
import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 500;
// 500 records (DEFAULT_MAX_RECORDS) of idempotency state: keys, digests and
// fixed-shape results — 2 MiB is the named cap for the whole state file.
const MUTATION_STATE_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TERMINAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const KINDS = [
  'change-request-create',
  'change-request-update',
  'change-request-merge',
  'change-request-ready',
  'change-request-comment',
  'change-request-review',
  'issue-comment',
  'change-request-state',
  'issue-state',
  'change-request-labels',
  'issue-labels',
  'change-request-reviewers',
  'change-request-thread-reply',
  'change-request-thread-resolve',
  'change-request-thread-start',
];
const STATES = ['running', 'succeeded', 'failed', 'outcome-unknown'];
const TERMINAL_STATES = ['succeeded', 'failed'];
const TARGET_OPTIONAL_KEYS = ['number', 'head', 'base', 'headSha'];
const RESULT_KEYS = [...TARGET_OPTIONAL_KEYS, 'state', 'merged', 'ready', 'commented', 'failureStatus', 'failureCode'];

const emptyState = () => ({ version: VERSION, records: {} });
const isBoolean = (value) => Object.prototype.toString.call(value) === '[object Boolean]';
const isFunction = (value) => Object.prototype.toString.call(value) === '[object Function]';
const isNonEmptyString = (value) => isString(value) && value.length > 0;
const hasExactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const isTimestamp = (value) => Number.isSafeInteger(value) && value >= 0;
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
// Revision 0 is the designed no-binding state the binding service accepts
// (DOCUMENTATION.md, binding-service section), so the storage gate matches it.
const isNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const isFailureStatus = (value) => Number.isSafeInteger(value) && value >= 400 && value <= 599;

const invalidState = () => {
  const error = new Error('Source control mutation storage is invalid');
  error.code = 'INVALID_SOURCE_CONTROL_MUTATIONS';
  return error;
};

const mutationError = (code, message, record) => {
  const error = new Error(message);
  error.code = code;
  if (record !== undefined) error.record = record;
  return error;
};

const isActor = (value) => isPlainObject(value)
  && hasExactKeys(value, ['provider', 'instance', 'accountId'])
  && isNonEmptyString(value.provider)
  && isNonEmptyString(value.instance)
  && isNonEmptyString(value.accountId);

const isProject = (value) => isPlainObject(value)
  && hasExactKeys(value, ['id', 'owner', 'name'])
  && isNonEmptyString(value.id)
  && isNonEmptyString(value.owner)
  && isNonEmptyString(value.name);

const isTarget = (value) => isPlainObject(value)
  && hasExactKeys(
    value,
    ['repositoryId', 'bindingRevision', 'primaryRemote', 'project'],
    TARGET_OPTIONAL_KEYS,
  )
  && isNonEmptyString(value.repositoryId)
  && isNonNegativeInteger(value.bindingRevision)
  && isNonEmptyString(value.primaryRemote)
  && isProject(value.project)
  && (value.number === undefined || isPositiveInteger(value.number))
  && (value.head === undefined || isNonEmptyString(value.head))
  && (value.base === undefined || isNonEmptyString(value.base))
  && (value.headSha === undefined || isNonEmptyString(value.headSha));

const isTerminalResult = (value) => isPlainObject(value)
  && hasExactKeys(value, [], ['project', ...RESULT_KEYS])
  && (value.project === undefined || isProject(value.project))
  && (value.number === undefined || isPositiveInteger(value.number))
  && (value.head === undefined || isNonEmptyString(value.head))
  && (value.base === undefined || isNonEmptyString(value.base))
  && (value.headSha === undefined || isNonEmptyString(value.headSha))
  && (value.state === undefined || isNonEmptyString(value.state))
  && (value.merged === undefined || isBoolean(value.merged))
  && (value.commented === undefined || isBoolean(value.commented))
  && (value.ready === undefined || isBoolean(value.ready))
  && (value.failureStatus === undefined || isFailureStatus(value.failureStatus))
  && (value.failureCode === undefined || isNonEmptyString(value.failureCode));

const isRecord = (value, key) => {
  if (!isPlainObject(value)
    || !hasExactKeys(
      value,
      ['key', 'inputDigest', 'kind', 'actor', 'target', 'state', 'startedAt', 'updatedAt', 'expiresAt'],
      ['result'],
    )
    || value.key !== key
    || !isNonEmptyString(value.key)
    || !isNonEmptyString(value.inputDigest)
    || !KINDS.includes(value.kind)
    || !isActor(value.actor)
    || !isTarget(value.target)
    || !STATES.includes(value.state)
    || !isTimestamp(value.startedAt)
    || !isTimestamp(value.updatedAt)
    || !isTimestamp(value.expiresAt)
    || value.startedAt > value.updatedAt
    || value.updatedAt > value.expiresAt) return false;
  if (value.state === 'running') return value.result === undefined;
  return value.result === undefined || isTerminalResult(value.result);
};

const parseState = (value) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['version', 'records'])
    || value.version !== VERSION
    || !isPlainObject(value.records)) throw invalidState();
  for (const [key, record] of Object.entries(value.records)) {
    if (!isRecord(record, key)) throw invalidState();
  }
  return value;
};

const copyProject = (project) => ({ id: project.id, owner: project.owner, name: project.name });
const copyTarget = (target) => {
  const copy = {
    repositoryId: target.repositoryId,
    bindingRevision: target.bindingRevision,
    primaryRemote: target.primaryRemote,
    project: copyProject(target.project),
  };
  for (const key of TARGET_OPTIONAL_KEYS) {
    if (target[key] !== undefined) copy[key] = target[key];
  }
  return copy;
};
const copyResult = (result) => {
  if (result === undefined) return undefined;
  const copy = {};
  for (const key of RESULT_KEYS) {
    if (result[key] !== undefined) copy[key] = result[key];
  }
  if (result.project !== undefined) copy.project = copyProject(result.project);
  return copy;
};
const resultsMatch = (left, right) => JSON.stringify(copyResult(left)) === JSON.stringify(copyResult(right));

export function createMutationStore({
  filePath,
  fsImpl = fs,
  lockWaitMs = 2_000,
  now = Date.now,
  maxRecords = DEFAULT_MAX_RECORDS,
  terminalTtlMs = DEFAULT_TERMINAL_TTL_MS,
}) {
  if (!isNonEmptyString(filePath)
    || !isFunction(now)
    || !isPositiveInteger(maxRecords)
    || !isTimestamp(terminalTtlMs)) throw new TypeError('Invalid mutation store options');

  let writes = Promise.resolve();
  const enqueueWrite = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
// Bounded state read (#1663): the shared bounded reader judges the file
// from its opened handle under a named cap, so an over-cap file is refused
// before parsing and a FIFO is refused promptly instead of wedging this
// store's serialized chain. The cap is sized from the store's own record
// bound below. Missing still answers the empty state; over-cap and
// non-regular fail closed as the store's typed invalid-state error (never
// the empty state, which would silently discard the records this store is
// the safety layer for). The bounded reader goes through fsImpl like the
// write and lock paths (the reader's `fs` option, #2015), so a store
// built on an injected filesystem reads from that filesystem too.
  const readState = async () => {
    const result = await readBoundedFile(filePath, MUTATION_STATE_MAX_BYTES, { fs: fsImpl });
    if (!result.ok) {
      if (result.reason === 'missing') return emptyState();
      throw invalidState();
    }
    return parseState(JSON.parse(result.buffer.toString('utf8')));
  };
  const writeState = async (state) => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsImpl.chmod(temporary, 0o600);
      await renameWithRetry((from, to) => fsImpl.rename(from, to), temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const pruneExpired = (state, timestamp) => {
    let changed = false;
    for (const [key, record] of Object.entries(state.records)) {
      if (TERMINAL_STATES.includes(record.state) && record.expiresAt <= timestamp) {
        delete state.records[key];
        changed = true;
      }
    }
    return changed;
  };
  const makeCapacity = (state) => {
    const terminal = Object.values(state.records)
      .filter((record) => TERMINAL_STATES.includes(record.state))
      .sort((left, right) => left.updatedAt - right.updatedAt
        || left.startedAt - right.startedAt
        || left.key.localeCompare(right.key));
    while (Object.keys(state.records).length >= maxRecords && terminal.length) {
      delete state.records[terminal.shift().key];
    }
    if (Object.keys(state.records).length >= maxRecords) {
      throw mutationError('SOURCE_CONTROL_MUTATION_CAPACITY', 'Source control mutation storage is at capacity');
    }
  };
  const normalizeClaim = (record, timestamp) => {
    if (!isPlainObject(record)
      || !hasExactKeys(record, ['key', 'inputDigest', 'kind', 'actor', 'target'], ['state', 'startedAt', 'updatedAt', 'expiresAt'])
      || (record.state !== undefined && record.state !== 'running')) throw invalidState();
    const startedAt = record.startedAt ?? timestamp;
    const candidate = {
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

  const claim = (record) => enqueueWrite(async () => {
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

  const complete = (key, inputDigest, completion) => enqueueWrite(async () => {
    if (!isNonEmptyString(key)
      || !isNonEmptyString(inputDigest)
      || !isPlainObject(completion)
      || !hasExactKeys(completion, ['state'], ['result'])
      || ![...TERMINAL_STATES, 'outcome-unknown'].includes(completion.state)
      || (completion.result !== undefined && !isTerminalResult(completion.result))) throw invalidState();
    const result = copyResult(completion.result);
    const state = await readState();
    const existing = Object.hasOwn(state.records, key) ? state.records[key] : undefined;
    if (!existing) throw mutationError('SOURCE_CONTROL_MUTATION_NOT_FOUND', 'Source control mutation record was not found');
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
    const completed = {
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

  const read = (key) => enqueueWrite(async () => {
    if (!isNonEmptyString(key)) throw invalidState();
    const records = (await readState()).records;
    return Object.hasOwn(records, key) ? records[key] : null;
  });
  const list = () => enqueueWrite(async () => Object.values((await readState()).records)
    .sort((left, right) => left.startedAt - right.startedAt || left.key.localeCompare(right.key)));

  const withExecutionLock = (key, operation) => {
    if (!isNonEmptyString(key)) throw invalidState();
    const digest = createHash('sha256').update(key).digest('hex');
    return withSourceControlFileLock(`${filePath}.execution-${digest}.lock`, operation, { fsImpl, waitMs: lockWaitMs });
  };

  return { claim, complete, read, list, withExecutionLock };
}
