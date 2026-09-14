import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { withSourceControlFileLock } from '../source-control/file-lock.js';

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 512;
const isPlainObject = (value) => value === Object(value)
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const isString = (value) => Object.prototype.toString.call(value) === '[object String]';
const isIdentifier = (value) => isString(value) && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\0\r\n]/.test(value);
const exactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const invalidStore = () => Object.assign(new Error('Contributor provenance store is invalid'), {
  code: 'CONTRIBUTOR_PROVENANCE_STORE_INVALID',
});
const conflict = (current) => Object.assign(new Error('Contributor provenance changed'), {
  code: 'CONTRIBUTOR_PROVENANCE_CONFLICT', status: 409, current,
});

const parseRecord = (record) => {
  if (!isPlainObject(record) || !exactKeys(record, [
    'worktreeId', 'repositoryId', 'revision', 'provenance',
  ]) || !isIdentifier(record.worktreeId) || !isIdentifier(record.repositoryId)
    || !Number.isSafeInteger(record.revision) || record.revision < 1) throw invalidStore();
  if (record.provenance === null) return Object.freeze({ ...record, provenance: null });
  const provenance = record.provenance;
  if (!isPlainObject(provenance) || !exactKeys(provenance, [
    'kind', 'remoteName', 'endpointFingerprint', 'sourceSha', 'sourceRef',
    'sourceProjectId', 'targetProjectId', 'provider', 'instance', 'accountId',
    'bindingRevision', 'primaryRemote', 'projectId', 'setupCommand',
  ]) || provenance.kind !== 'contributor-fork' || !isIdentifier(provenance.remoteName)
    || !isIdentifier(provenance.endpointFingerprint)
    || !isIdentifier(provenance.sourceRef) || !provenance.sourceRef.startsWith('refs/heads/')
    || !isIdentifier(provenance.sourceProjectId) || !isIdentifier(provenance.targetProjectId)
    || !['github', 'gitlab'].includes(provenance.provider) || !isIdentifier(provenance.instance)
    || !isIdentifier(provenance.accountId) || !Number.isSafeInteger(provenance.bindingRevision)
    || provenance.bindingRevision < 1 || !isIdentifier(provenance.primaryRemote)
    || !isIdentifier(provenance.projectId) || !isString(provenance.setupCommand)
    || provenance.setupCommand.length > 65536 || /[\0]/.test(provenance.setupCommand)
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(provenance.sourceSha)) throw invalidStore();
  return Object.freeze({ ...record, provenance: Object.freeze({ ...provenance }) });
};

const parseState = (value, maxRecords) => {
  if (!isPlainObject(value) || !exactKeys(value, ['version', 'records'])
    || value.version !== VERSION || !Array.isArray(value.records)
    || value.records.length > maxRecords) throw invalidStore();
  const ids = new Set();
  const records = value.records.map(parseRecord);
  for (const record of records) {
    if (ids.has(record.worktreeId)) throw invalidStore();
    ids.add(record.worktreeId);
  }
  return Object.freeze({ version: VERSION, records: Object.freeze(records) });
};

export function createContributorProvenanceStore({
  filePath,
  resolveRepositoryIdentity,
  resolveGitPaths,
  fsImpl = fs,
  maxRecords = DEFAULT_MAX_RECORDS,
  lockWaitMs = 2_000,
} = {}) {
  if (!path.isAbsolute(filePath || '') || !(resolveRepositoryIdentity instanceof Function)
    || !(resolveGitPaths instanceof Function) || !Number.isSafeInteger(maxRecords) || maxRecords < 1
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError('Contributor provenance store options are invalid');
  }
  let writes = Promise.resolve();
  const enqueue = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, {
      fsImpl, waitMs: lockWaitMs,
    }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const emptyState = () => Object.freeze({ version: VERSION, records: Object.freeze([]) });
  const readState = async () => {
    let handle;
    try {
      handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error?.code === 'ENOENT') return emptyState();
      throw error?.code === 'ELOOP' ? invalidStore() : error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) throw invalidStore();
      return parseState(JSON.parse(await handle.readFile('utf8')), maxRecords);
    } catch (error) {
      if (error?.code === 'CONTRIBUTOR_PROVENANCE_STORE_INVALID') throw error;
      throw invalidStore();
    } finally {
      await handle.close();
    }
  };
  const writeState = async (state) => {
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600, flag: 'wx',
      });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  };
  const resolveIdentity = async (directory) => {
    const [repository, gitPaths] = await Promise.all([
      resolveRepositoryIdentity(directory), resolveGitPaths(directory),
    ]);
    if (!repository?.supported || !isIdentifier(repository.repositoryId) || !gitPaths?.supported || gitPaths.bare) {
      throw invalidStore();
    }
    const gitDirectory = await fsImpl.realpath(gitPaths.gitDirectory);
    const stats = await fsImpl.stat(gitDirectory);
    if (!stats.isDirectory()) throw invalidStore();
    const worktreeId = `worktree_${crypto.createHash('sha256')
      .update(repository.repositoryId).update('\0').update(gitDirectory).update('\0')
      .update(String(stats.dev)).update('\0').update(String(stats.ino)).digest('base64url')}`;
    return { worktreeId, repositoryId: repository.repositoryId };
  };
  const recordForIdentity = (record, identity) => {
    if (!record) return { ...identity, revision: 0, provenance: null };
    if (record.repositoryId !== identity.repositoryId) throw invalidStore();
    return record;
  };
  const read = (directory) => enqueue(async () => {
    const identity = await resolveIdentity(directory);
    const record = (await readState()).records.find((candidate) => candidate.worktreeId === identity.worktreeId);
    return recordForIdentity(record, identity);
  });
  const readMany = (directories) => {
    if (!Array.isArray(directories) || directories.length > maxRecords
      || directories.some((directory) => !isString(directory) || !directory)) return Promise.reject(invalidStore());
    return enqueue(async () => {
      const [state, identities] = await Promise.all([
        readState(),
        Promise.all(directories.map(resolveIdentity)),
      ]);
      const recordsByWorktree = new Map(state.records.map((record) => [record.worktreeId, record]));
      return identities.map((identity) => recordForIdentity(recordsByWorktree.get(identity.worktreeId), identity));
    });
  };
  const compareAndSwap = (directory, expectedRevision, provenance) => {
    return enqueue(async () => {
      const identity = await resolveIdentity(directory);
      const state = await readState();
      const current = state.records.find((candidate) => candidate.worktreeId === identity.worktreeId)
        ?? { ...identity, revision: 0, provenance: null };
      if (current.repositoryId !== identity.repositoryId || current.revision !== expectedRevision) throw conflict(current);
      const record = parseRecord({ ...identity, revision: current.revision + 1, provenance });
      const records = state.records.filter((candidate) => candidate.worktreeId !== identity.worktreeId);
      if (records.length >= maxRecords) {
        const tombstoneIndex = records.findIndex((candidate) => candidate.provenance === null);
        if (tombstoneIndex < 0) {
          throw Object.assign(new Error('Contributor provenance store capacity is exhausted'), {
            code: 'CONTRIBUTOR_PROVENANCE_STORE_CAPACITY',
          });
        }
        records.splice(tombstoneIndex, 1);
      }
      records.push(record);
      const next = parseState({ version: VERSION, records }, maxRecords);
      await writeState(next);
      return record;
    });
  };
  return Object.freeze({ read, readMany, compareAndSwap });
}
