import { isPlainObject, isString } from '../shared/object-guards.js';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { isProviderId } from '../source-control/provider-id.js';
import { directoryReachability } from '../directory-reachability/index.js';
import { mapLimited } from '../shared/map-limited.js';
import type { Stats } from 'node:fs';
import type { ProviderId } from '../source-control/provider-id.js';

export interface ContributorProvenance {
  kind: 'contributor-fork';
  remoteName: string;
  endpointFingerprint: string;
  sourceSha: unknown;
  sourceRef: string;
  sourceProjectId: string;
  targetProjectId: string;
  provider: ProviderId;
  instance: string;
  accountId: string;
  bindingRevision: number;
  primaryRemote: string;
  projectId: string;
  setupCommand: string;
}
export interface ContributorProvenanceRead {
  worktreeId: string;
  repositoryId: string;
  gitDirectory?: string | undefined;
  revision: number;
  provenance: ContributorProvenance | null;
}
export interface ContributorProvenanceStoreOptions {
  filePath?: string;
  resolveRepositoryIdentity?(directory: string | undefined): Promise<ProvenanceRepositoryIdentity>;
  resolveGitPaths?(directory: string | undefined): Promise<ProvenanceGitPaths>;
  fsImpl?: typeof fs;
  maxRecords?: number;
  lockWaitMs?: number;
}
export interface ProvenanceGitPaths {
  supported: boolean;
  bare?: boolean;
  gitDirectory?: string;
}
export interface ProvenanceRepositoryIdentity extends ProvenanceGitPaths {
  repositoryId?: string;
}
interface ProvenanceFile {
  version: number;
  records: readonly ContributorProvenanceRead[];
}
type WorktreeIdentity = Pick<ContributorProvenanceRead, 'worktreeId' | 'repositoryId' | 'gitDirectory'>;
const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const hasCode = (value: unknown): value is { code?: unknown } => value !== null && value !== undefined;
const errorCode = <Value>(value: Value) => hasCode(value) ? value.code : undefined;
function matchesSourceSha<Value>(value: Value): boolean;
function matchesSourceSha(value: string) { return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value); }

const VERSION = 1;
const DEFAULT_MAX_RECORDS = 512;
const LISTING_IDENTITY_CONCURRENCY = 4;
const MAX_GITFILE_BYTES = 1024 * 1024;
const isIdentifier = (value: unknown): value is string => isString(value) && value.length > 0 && value.length <= 512
  && value.trim() === value && !/[\0\r\n]/.test(value);
const exactKeys = <Value extends object>(value: Value, keys: string[]) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
const invalidStore = () => Object.assign(new Error('Contributor provenance store is invalid'), {
  code: 'CONTRIBUTOR_PROVENANCE_STORE_INVALID',
});
const conflict = (current: ContributorProvenanceRead) => Object.assign(new Error('Contributor provenance changed'), {
  code: 'CONTRIBUTOR_PROVENANCE_CONFLICT', status: 409, current,
});

const worktreeIdFor = (repositoryId: string, gitDirectory: string, stats: Stats) => `worktree_${crypto.createHash('sha256')
  .update(repositoryId).update('\0').update(gitDirectory).update('\0')
  .update(String(stats.dev)).update('\0').update(String(stats.ino)).digest('base64url')}`;

const isRecordHeader = (record: unknown): record is Omit<ContributorProvenanceRead, 'provenance'> & { provenance: unknown } => {
  const keys = Object.hasOwn(record ?? {}, 'gitDirectory')
    ? ['worktreeId', 'repositoryId', 'revision', 'provenance', 'gitDirectory']
    : ['worktreeId', 'repositoryId', 'revision', 'provenance'];
  if (!isPlainObject(record) || !exactKeys(record, keys)
    || (record.gitDirectory !== undefined && (!isString(record.gitDirectory) || !path.isAbsolute(record.gitDirectory)))
    || !isIdentifier(record.worktreeId) || !isIdentifier(record.repositoryId)
    || !isSafeInteger(record.revision) || record.revision < 1) throw invalidStore();
  return true;
};
const isProvenance = (provenance: unknown): provenance is ContributorProvenance => {
  return !(!isPlainObject(provenance) || !exactKeys(provenance, [
    'kind', 'remoteName', 'endpointFingerprint', 'sourceSha', 'sourceRef',
    'sourceProjectId', 'targetProjectId', 'provider', 'instance', 'accountId',
    'bindingRevision', 'primaryRemote', 'projectId', 'setupCommand',
  ]) || provenance.kind !== 'contributor-fork' || !isIdentifier(provenance.remoteName)
    || !isIdentifier(provenance.endpointFingerprint)
    || !isIdentifier(provenance.sourceRef) || !provenance.sourceRef.startsWith('refs/heads/')
    || !isIdentifier(provenance.sourceProjectId) || !isIdentifier(provenance.targetProjectId)
    || !isProviderId(provenance.provider) || !isIdentifier(provenance.instance)
    || !isIdentifier(provenance.accountId) || !isSafeInteger(provenance.bindingRevision)
    || provenance.bindingRevision < 0 || !isIdentifier(provenance.primaryRemote)
    || !isIdentifier(provenance.projectId) || !isString(provenance.setupCommand)
    || provenance.setupCommand.length > 65536 || /[\0]/.test(provenance.setupCommand)
    || !matchesSourceSha(provenance.sourceSha));
};
const parseRecord = <Value>(record: Value): ContributorProvenanceRead => {
  if (!isRecordHeader(record)) throw invalidStore();
  if (record.provenance === null) return Object.freeze({ ...record, provenance: null });
  const provenance = record.provenance;
  if (!isProvenance(provenance)) throw invalidStore();
  return Object.freeze({ ...record, provenance: Object.freeze({ ...provenance }) });
};

const parseState = <Value>(value: Value, maxRecords: number): ProvenanceFile => {
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

const emptyState = (): ProvenanceFile => Object.freeze({ version: VERSION, records: Object.freeze([]) });

const readProvenanceState = async (filePath: string, fsImpl: typeof fs, maxRecords: number) => {
  let handle;
  try {
    handle = await fsImpl.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return emptyState();
    throw errorCode(error) === 'ELOOP' ? invalidStore() : error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) throw invalidStore();
    return parseState(JSON.parse(await handle.readFile('utf8')), maxRecords);
  } catch (error) {
    if (errorCode(error) === 'CONTRIBUTOR_PROVENANCE_STORE_INVALID') throw error;
    throw invalidStore();
  } finally {
    await handle.close();
  }
};

export const isContributorForkGitDirectory = async ({
  filePath,
  gitDirectory,
  fsImpl = fs,
  maxRecords = DEFAULT_MAX_RECORDS,
}: { filePath: string; gitDirectory: string; fsImpl?: typeof fs; maxRecords?: number }) => {
  const state = await readProvenanceState(filePath, fsImpl, maxRecords);
  const canonicalGitDirectory = await fsImpl.realpath(gitDirectory);
  const stats = await fsImpl.stat(canonicalGitDirectory);
  return state.records.some((record) => record.provenance !== null
    && record.worktreeId === worktreeIdFor(record.repositoryId, canonicalGitDirectory, stats));
};

export function createContributorProvenanceStore({
  filePath,
  resolveRepositoryIdentity,
  resolveGitPaths,
  fsImpl = fs,
  maxRecords = DEFAULT_MAX_RECORDS,
  lockWaitMs = 2_000,
}: ContributorProvenanceStoreOptions = {}) {
  if (!filePath || !path.isAbsolute(filePath || '') || !(resolveRepositoryIdentity instanceof Function)
    || !(resolveGitPaths instanceof Function) || !Number.isSafeInteger(maxRecords) || maxRecords < 1
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError('Contributor provenance store options are invalid');
  }
  let writes = Promise.resolve();
  const enqueue = <Value>(operation: () => Promise<Value>) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, {
      fsImpl, waitMs: lockWaitMs,
    }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = () => readProvenanceState(filePath, fsImpl, maxRecords);
  const writeState = async (state: ProvenanceFile) => {
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
  const resolveIdentity = async (directory: string | undefined) => {
    const repository = await resolveRepositoryIdentity(directory);
    if (!repository?.supported || !isIdentifier(repository.repositoryId) || repository.bare === true) {
      throw invalidStore();
    }
    const gitDirectoryPath = isString(repository.gitDirectory)
      ? repository.gitDirectory
      : await resolveGitPaths(directory)
        .then((gitPaths) => (gitPaths?.supported && !gitPaths.bare ? gitPaths.gitDirectory : null))
        .catch(() => null);
    if (!isString(gitDirectoryPath) || !path.isAbsolute(gitDirectoryPath)) throw invalidStore();
    const gitDirectory = await fsImpl.realpath(gitDirectoryPath);
    const stats = await fsImpl.stat(gitDirectory);
    if (!stats.isDirectory()) throw invalidStore();
    return { worktreeId: worktreeIdFor(repository.repositoryId, gitDirectory, stats), repositoryId: repository.repositoryId, gitDirectory };
  };
  const isOrphaned = async (record: ContributorProvenanceRead) => {
    if (!record.gitDirectory) return false;
    try {
      const stats = await fsImpl.stat(record.gitDirectory);
      return !stats.isDirectory() || worktreeIdFor(record.repositoryId, record.gitDirectory, stats) !== record.worktreeId;
    } catch (error) {
      return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
    }
  };
  const readGitfile = async (entry: string, size: number) => {
    const handle = await fsImpl.open(entry, fsConstants.O_RDONLY);
    try {
      const bytes = Buffer.alloc(size + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      return bytesRead > size ? null : bytes.toString('utf8', 0, bytesRead);
    } finally {
      await handle.close();
    }
  };
  function dotGitDirectory<Directory extends string | undefined>(directory: Directory): Promise<string | null>;
  async function dotGitDirectory(directory: string) {
    const entry = path.join(directory, '.git');
    try {
      const stats = await fsImpl.stat(entry);
      if (stats.isDirectory()) return await fsImpl.realpath(entry);
      if (!stats.isFile() || stats.size > MAX_GITFILE_BYTES) return null;
      const contents = await readGitfile(entry, stats.size);
      if (!contents?.startsWith('gitdir: ')) return null;
      const target = contents.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
      if (!target) return null;
      return await fsImpl.realpath(path.isAbsolute(target) ? target : `${directory}${path.sep}${target}`);
    } catch {
      return null;
    }
  }
  const recordedIdentity = async (directory: string, records: ContributorProvenanceRead[]) => {
    for (const { worktreeId, repositoryId, gitDirectory } of records) {
      if (!gitDirectory || await directoryReachability.isUnreachable(gitDirectory)) continue;
      const link = (await fsImpl.readFile(path.join(gitDirectory, 'gitdir'), 'utf8').catch(() => '')).trim();
      if (!link || path.resolve(gitDirectory, link) !== path.resolve(directory, '.git')) continue;
      const stats = await fsImpl.stat(gitDirectory).catch(() => null);
      if (stats && worktreeIdFor(repositoryId, gitDirectory, stats) === worktreeId) return { worktreeId, repositoryId, gitDirectory };
    }
    return null;
  };
  const recordForIdentity = (record: ContributorProvenanceRead | undefined, identity: WorktreeIdentity): ContributorProvenanceRead => {
    if (!record) return { ...identity, revision: 0, provenance: null };
    if (record.repositoryId !== identity.repositoryId) throw invalidStore();
    return record;
  };
  const read = (directory: string) => enqueue(async () => {
    const identity = await resolveIdentity(directory);
    const record = (await readState()).records.find((candidate) => candidate.worktreeId === identity.worktreeId);
    return recordForIdentity(record, identity);
  });
  const readMany = (directories: string[]) => {
    if (!Array.isArray(directories) || directories.length > maxRecords
      || directories.some((directory) => !isString(directory) || !directory)) return Promise.reject(invalidStore());
    return enqueue(readState).then(async (state) => {
      const marking = state.records.filter((record) => record.provenance !== null);
      if (marking.length === 0) {
        return directories.map(() => ({ revision: 0, provenance: null }));
      }
      const markedGitDirectories = marking.every((record) => record.gitDirectory)
        ? new Set(marking.map((record) => record.gitDirectory))
        : null;
      const identities = await mapLimited(directories, LISTING_IDENTITY_CONCURRENCY, async (directory) => {
        if (directory && await directoryReachability.isUnreachable(directory)) return recordedIdentity(directory, marking);
        if (markedGitDirectories) {
          const gitDirectory = await dotGitDirectory(directory);
          if (gitDirectory && !markedGitDirectories.has(gitDirectory)) return null;
        }
        return resolveIdentity(directory).catch(() => null);
      });
      const recordsByWorktree = new Map(state.records.map((record) => [record.worktreeId, record]));
      return identities.map((identity) => (identity
        ? recordForIdentity(recordsByWorktree.get(identity.worktreeId), identity)
        : { revision: 0, provenance: null }));
    });
  };
  const compareAndSwap = <Provenance>(directory: string, expectedRevision: number, provenance: Provenance) => {
    return enqueue(async () => {
      const identity = await resolveIdentity(directory);
      const state = await readState();
      const current = state.records.find((candidate) => candidate.worktreeId === identity.worktreeId)
        ?? { ...identity, revision: 0, provenance: null };
      if (current.repositoryId !== identity.repositoryId || current.revision !== expectedRevision) throw conflict(current);
      const record = parseRecord({ ...identity, revision: current.revision + 1, provenance });
      let records = state.records.filter((candidate) => candidate.worktreeId !== identity.worktreeId);
      if (records.length >= maxRecords) {
        const orphaned = await Promise.all(records.map(isOrphaned));
        records = records.filter((_record, index) => !orphaned[index]);
      }
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
