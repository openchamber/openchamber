import crypto, { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 512;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const STATUSES = new Set(['pending', 'ready', 'failed']);
const PHASES = new Set(['directory-created', 'git-ready', 'setup-ready']);
const ERROR_CODES = new Set([
  'INVALID_REQUEST', 'NOT_FOUND', 'STALE_REPOSITORY', 'STALE_BINDING', 'STALE_CONFIG',
  'REMOTE_CHANGED', 'AUTHENTICATION_REQUIRED', 'AUTHENTICATION_FAILED', 'TRANSPORT_FAILED',
  'CONFLICT', 'CANCELLED', 'TIMEOUT', 'OUTCOME_UNKNOWN', 'RUNTIME_UNSUPPORTED', 'UNKNOWN',
  'GIT_LFS_CLIENT_MISSING', 'PATH_LENGTH_LIMIT',
]);
const HYDRATION_STATUSES = new Set([
  'succeeded', 'authorization-required', 'invalid', 'client-missing', 'failed', 'cancelled', 'not-needed',
]);
const SAFE_ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Worktree checkout hydration configuration is invalid',
  NOT_FOUND: 'Worktree checkout target was not found',
  STALE_REPOSITORY: 'Worktree repository authority changed',
  STALE_BINDING: 'Worktree source control binding changed',
  STALE_CONFIG: 'Worktree repository configuration changed',
  REMOTE_CHANGED: 'Worktree checkout transport authority changed',
  AUTHENTICATION_REQUIRED: 'Worktree checkout authentication is required',
  AUTHENTICATION_FAILED: 'Worktree checkout authentication failed',
  TRANSPORT_FAILED: 'Worktree checkout hydration failed',
  CONFLICT: 'Worktree checkout requires conflict repair',
  CANCELLED: 'Worktree checkout hydration was cancelled',
  TIMEOUT: 'Worktree checkout hydration timed out',
  OUTCOME_UNKNOWN: 'Worktree bootstrap completion is unknown. Inspect the checkout and repair setup before use.',
  RUNTIME_UNSUPPORTED: 'Worktree checkout hydration is unsupported by this runtime',
  UNKNOWN: 'Worktree bootstrap completion is unknown. Inspect the checkout and repair setup before use.',
  GIT_LFS_CLIENT_MISSING: 'Git LFS is required but unavailable',
  PATH_LENGTH_LIMIT: 'Git reported "File name too long". The worktree checkout path exceeds this system\'s path-length limit. Enable OS long paths or use a shorter repository path.',
});

const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value, required, optional = []) => {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
};
const isText = (value, max = 4096) => typeof value === 'string' && value.length > 0
  && value.length <= max && value.trim() === value && !/[\0\r\n]/.test(value);
const invalidStore = (cause) => Object.assign(new Error('Worktree bootstrap storage is invalid', { cause }), {
  code: 'WORKTREE_BOOTSTRAP_STORAGE_INVALID',
});
const capacityError = () => Object.assign(new Error('Worktree bootstrap storage capacity reached'), {
  code: 'WORKTREE_BOOTSTRAP_STORAGE_CAPACITY',
});
const directoryFingerprint = async (directory, fsImpl) => {
  const absolutePath = path.resolve(directory);
  const realPath = await fsImpl.realpath(absolutePath).catch(() => absolutePath);
  const normalized = path.normalize(realPath);
  const identity = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  return crypto.createHash('sha256').update(identity).digest('base64url');
};
const clone = (value) => JSON.parse(JSON.stringify(value));
const redactDisplayEndpoint = (value) => {
  if (typeof value !== 'string' || value.includes('://')) return value;
  const match = value.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
  return match ? `${match[1]}:${match[2]}` : value;
};
const scrubBootstrapState = (bootstrapState) => {
  const value = clone(bootstrapState);
  const visit = (candidate) => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (!isPlainObject(candidate)) return;
    if (typeof candidate.code === 'string' && Object.hasOwn(SAFE_ERROR_MESSAGES, candidate.code)
      && Object.hasOwn(candidate, 'message')) candidate.message = SAFE_ERROR_MESSAGES[candidate.code];
    if (Object.hasOwn(candidate, 'displayUrl')) candidate.displayUrl = redactDisplayEndpoint(candidate.displayUrl);
    Object.values(candidate).forEach(visit);
  };
  visit(value);
  if (value.status === 'failed' && Object.hasOwn(SAFE_ERROR_MESSAGES, value.errorCode)) {
    value.error = SAFE_ERROR_MESSAGES[value.errorCode];
  }
  return value;
};
const isSafeDisplayEndpoint = (value) => {
  if (!isText(value)) return false;
  if (!value.includes('://')) {
    const match = value.match(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?:([^\s:\\]+)$/);
    return Boolean(match && !/[?#]/.test(value) && !match[1].startsWith('-')
      && match[1].split('/').every((part) => part && part !== '.' && part !== '..'));
  }
  try {
    const endpoint = new URL(value);
    const pathname = decodeURIComponent(endpoint.pathname);
    return ['https:', 'ssh:'].includes(endpoint.protocol)
      && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
      && Boolean(endpoint.hostname && endpoint.pathname && endpoint.pathname !== '/')
      && !/[\0-\x20\x7f\\]/.test(pathname)
      && pathname.split('/').slice(1).every((part) => part && part !== '.' && part !== '..');
  } catch {
    return false;
  }
};
const isRelativeCheckoutPath = (value) => isText(value)
  && !/[\0-\x1f\x7f]/.test(value)
  && value !== '..' && !value.startsWith('../') && !value.includes('/../')
  && !path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value) && !value.includes('\\');

const isPublicError = (value) => isPlainObject(value)
  && exactKeys(value, ['code', 'message']) && ERROR_CODES.has(value.code) && isText(value.message);
const isHydrationPart = (value) => isPlainObject(value)
  && exactKeys(value, ['path', 'status'], ['endpoint', 'error'])
  && isRelativeCheckoutPath(value.path)
  && HYDRATION_STATUSES.has(value.status)
  && (value.endpoint === undefined || (isPlainObject(value.endpoint)
    && exactKeys(value.endpoint, ['displayUrl', 'fingerprint'])
    && isSafeDisplayEndpoint(value.endpoint.displayUrl) && isText(value.endpoint.fingerprint, 1024)))
  && (['succeeded', 'not-needed'].includes(value.status)
    ? value.error === undefined
    : isPublicError(value.error));
const expectedHydrationStatus = (parts) => {
  const statuses = parts.map((entry) => entry.status);
  if (!statuses.length || statuses.every((status) => status === 'not-needed')) return 'not-needed';
  for (const status of ['cancelled', 'invalid', 'client-missing', 'authorization-required', 'failed']) {
    if (statuses.includes(status)) return status;
  }
  return 'succeeded';
};
const isHydration = (value) => isPlainObject(value)
  && exactKeys(value, ['status', 'submodules', 'lfs'])
  && HYDRATION_STATUSES.has(value.status)
  && Array.isArray(value.submodules) && value.submodules.length <= 256 && value.submodules.every(isHydrationPart)
  && Array.isArray(value.lfs) && value.lfs.length <= 256 && value.lfs.every(isHydrationPart)
  && expectedHydrationStatus([...value.submodules, ...value.lfs]) === value.status;
const parseBootstrapState = (value) => {
  if (!isPlainObject(value) || !exactKeys(value, ['status', 'phase', 'error', 'updatedAt'], ['errorCode', 'hydration'])
    || !STATUSES.has(value.status) || !PHASES.has(value.phase)
    || value.error !== null && !isText(value.error)
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
    || value.errorCode !== undefined && !ERROR_CODES.has(value.errorCode)
    || value.hydration !== undefined && !isHydration(value.hydration)
    || value.status !== 'failed' && (value.error !== null || value.errorCode !== undefined || value.hydration !== undefined)
    || value.status === 'failed' && (value.error === null || value.errorCode === undefined)
    || value.status !== 'ready' && value.phase === 'setup-ready'
    || value.status === 'ready' && value.phase !== 'setup-ready') throw invalidStore();
  return value;
};
const parseState = (value, maxRecords) => {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'records'])
    || value.version !== VERSION || !isPlainObject(value.records)
    || Object.keys(value.records).length > maxRecords) throw invalidStore();
  for (const [fingerprint, record] of Object.entries(value.records)) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(fingerprint)) throw invalidStore();
    parseBootstrapState(record);
  }
  return value;
};

export function createWorktreeBootstrapStore({
  filePath,
  fsImpl = fs,
  maxRecords = DEFAULT_MAX_RECORDS,
  maxBytes = DEFAULT_MAX_BYTES,
  lockWaitMs = 2_000,
} = {}) {
  if (!path.isAbsolute(filePath || '') || !Number.isSafeInteger(maxRecords) || maxRecords < 1
    || !Number.isSafeInteger(maxBytes) || maxBytes < 1024) {
    throw new TypeError('Worktree bootstrap store options are invalid');
  }
  let writes = Promise.resolve();
  const enqueue = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, { fsImpl, waitMs: lockWaitMs }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async () => {
    let handle;
    try {
      handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return { version: VERSION, records: {} };
      throw error?.code === 'ELOOP' ? invalidStore(error) : error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > maxBytes
        || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) throw invalidStore();
      return parseState(JSON.parse(await handle.readFile('utf8')), maxRecords);
    } catch (error) {
      if (error?.code === 'WORKTREE_BOOTSTRAP_STORAGE_INVALID') throw error;
      throw invalidStore(error);
    } finally {
      await handle.close();
    }
  };
  const writeState = async (state) => {
    const encoded = `${JSON.stringify(parseState(state, maxRecords), null, 2)}\n`;
    if (Buffer.byteLength(encoded) > maxBytes) throw capacityError();
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, encoded, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const write = (directory, bootstrapState) => enqueue(async () => {
    const fingerprint = await directoryFingerprint(directory, fsImpl);
    const record = parseBootstrapState(scrubBootstrapState(bootstrapState));
    const state = await readState();
    if (!Object.hasOwn(state.records, fingerprint) && Object.keys(state.records).length >= maxRecords) {
      const candidate = Object.entries(state.records)
        .filter(([, value]) => value.status !== 'pending')
        .sort((left, right) => left[1].updatedAt - right[1].updatedAt || left[0].localeCompare(right[0]))[0];
      if (!candidate) throw capacityError();
      delete state.records[candidate[0]];
    }
    state.records[fingerprint] = record;
    await writeState(state);
    return clone(record);
  });
  const read = (directory) => enqueue(async () => {
    const state = await readState();
    const record = state.records[await directoryFingerprint(directory, fsImpl)];
    return record ? clone(record) : null;
  });
  const completeHydration = (directory) => enqueue(async () => {
    const state = await readState();
    const fingerprint = await directoryFingerprint(directory, fsImpl);
    const current = state.records[fingerprint];
    if (current?.status !== 'failed' || !current.hydration
      || ['succeeded', 'not-needed'].includes(current.hydration.status)) return null;
    const record = parseBootstrapState({
      status: 'ready', phase: 'setup-ready', error: null, updatedAt: Date.now(),
    });
    state.records[fingerprint] = record;
    await writeState(state);
    return clone(record);
  });
  const remove = (directory) => enqueue(async () => {
    const state = await readState();
    const fingerprint = await directoryFingerprint(directory, fsImpl);
    if (!Object.hasOwn(state.records, fingerprint)) return false;
    delete state.records[fingerprint];
    await writeState(state);
    return true;
  });

  return Object.freeze({ write, read, completeHydration, remove });
}
