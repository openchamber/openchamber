import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const VERSION = 3;
const DEFAULT_MAX_ACKNOWLEDGEMENTS = 512;
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const hasExactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const isRepositoryId = (value) => isString(value) && /^repo_[A-Za-z0-9_-]{43}$/.test(value);
const isDigest = (value) => isString(value) && /^[A-Za-z0-9_-]{43}$/.test(value);
const isRemoteName = (value) => isString(value)
  && value.length > 0
  && value.length <= 256
  && value.trim() === value
  && !value.startsWith('-')
  && !value.startsWith('/')
  && value !== '@'
  && !value.endsWith('.')
  && !/[\0-\x20\x7f~^:?*[\\]/.test(value)
  && !value.includes('..')
  && !value.includes('@{')
  && !value.includes('//')
  && !/(?:^|\/)\.|\.lock(?:\/|$)|\/$/.test(value);
const invalidStore = () => Object.assign(new Error('System push acknowledgement store is invalid'), {
  code: 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID',
});

const parseState = (value, maxAcknowledgements) => {
  if (!isPlainObject(value)
    || !hasExactKeys(value, ['version', 'acknowledgements'])
    || !Array.isArray(value.acknowledgements)
    || value.acknowledgements.length > maxAcknowledgements) throw invalidStore();
  if (value.version !== VERSION) throw invalidStore();
  const keys = new Set();
  const acknowledgements = value.acknowledgements.map((record) => {
    if (!isPlainObject(record) || !hasExactKeys(record, [
      'repositoryId', 'remoteName', 'endpointFingerprint', 'transportRevision',
    ]) || !isRepositoryId(record.repositoryId)
      || !isRemoteName(record.remoteName)
      || !isDigest(record.endpointFingerprint)
      || !isDigest(record.transportRevision)) throw invalidStore();
    const key = `${record.repositoryId}\0${record.remoteName}\0${record.endpointFingerprint}\0${record.transportRevision}`;
    if (keys.has(key)) throw invalidStore();
    keys.add(key);
    return Object.freeze({ ...record });
  });
  return Object.freeze({ version: VERSION, acknowledgements: Object.freeze(acknowledgements) });
};

export function createSystemPushAcknowledgementStore({
  filePath,
  fsImpl = fs,
  maxAcknowledgements = DEFAULT_MAX_ACKNOWLEDGEMENTS,
  lockWaitMs = 2_000,
} = {}) {
  if (!isString(filePath) || !path.isAbsolute(filePath)
    || !Number.isSafeInteger(maxAcknowledgements) || maxAcknowledgements < 1
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError('System push acknowledgement store options are invalid');
  }
  let writes = Promise.resolve();
  const enqueue = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, {
      fsImpl, waitMs: lockWaitMs,
    }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const emptyState = () => Object.freeze({ version: VERSION, acknowledgements: Object.freeze([]) });
  const readState = async () => {
    let handle;
    try {
      handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      if (error?.code === 'ELOOP') throw invalidStore();
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) throw invalidStore();
      return parseState(JSON.parse(await handle.readFile('utf8')), maxAcknowledgements);
    } catch (error) {
      if (error?.code === 'SYSTEM_PUSH_ACKNOWLEDGEMENT_STORE_INVALID') throw error;
      throw invalidStore();
    } finally {
      await handle.close();
    }
  };
  const matches = (record, repositoryId, remoteName, endpointFingerprint, transportRevision) => record.repositoryId === repositoryId
    && record.remoteName === remoteName
    && record.endpointFingerprint === endpointFingerprint
    && record.transportRevision === transportRevision;
  const validAuthority = (repositoryId, remoteName, endpointFingerprint, transportRevision) => (
    isRepositoryId(repositoryId) && isRemoteName(remoteName)
    && isDigest(endpointFingerprint) && isDigest(transportRevision)
  );
  const isAcknowledged = async (repositoryId, remoteName, endpointFingerprint, transportRevision) => {
    if (!validAuthority(repositoryId, remoteName, endpointFingerprint, transportRevision)) throw invalidStore();
    return enqueue(async () => (await readState()).acknowledgements
      .some((record) => matches(record, repositoryId, remoteName, endpointFingerprint, transportRevision)));
  };
  const acknowledge = (repositoryId, remoteName, endpointFingerprint, transportRevision) => {
    if (!validAuthority(repositoryId, remoteName, endpointFingerprint, transportRevision)) {
      return Promise.reject(invalidStore());
    }
    return enqueue(async () => {
      const state = await readState();
      if (state.acknowledgements.some((record) => (
        matches(record, repositoryId, remoteName, endpointFingerprint, transportRevision)
      ))) return;
      const acknowledgements = [
        ...(maxAcknowledgements === 1 ? [] : state.acknowledgements.slice(-(maxAcknowledgements - 1))),
        { repositoryId, remoteName, endpointFingerprint, transportRevision },
      ];
      const next = parseState({ version: VERSION, acknowledgements }, maxAcknowledgements);
      await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        await fsImpl.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
          encoding: 'utf8', mode: 0o600, flag: 'wx',
        });
        await fsImpl.chmod(temporary, 0o600);
        await fsImpl.rename(temporary, filePath);
      } catch (error) {
        await fsImpl.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
  };
  return Object.freeze({ isAcknowledged, acknowledge });
}
