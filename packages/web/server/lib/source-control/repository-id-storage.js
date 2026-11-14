import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from './file-lock.js';
import { birthtimeHoldsStill } from '../git/directory-birthtime.js';

const digest = (...values) => crypto.createHash('sha256').update(values.join('\0')).digest('base64url');
const invalidStore = () => Object.assign(new Error('Repository identity storage is invalid'), {
  code: 'INVALID_REPOSITORY_IDENTITY',
});
const sameDirectory = (record, stats) => record?.ino === String(stats.ino) && record.birthtimeMs === stats.birthtimeMs;
const hasBirthtime = (stats) => Number.isFinite(stats.birthtimeMs) && stats.birthtimeMs > 0;
const legacyId = (directory, stats) => `repo_${digest(directory, String(stats.dev), String(stats.ino))}`;

/** Keep the established ID while the same Git directory survives a remount. */
export async function resolveRepositoryFilesystemId(commonDirectory, { fsImpl = fs } = {}) {
  const stats = await fsImpl.stat(commonDirectory);
  const dataDir = process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber');
  const filePath = path.join(dataDir, 'repository-identities', `${digest(commonDirectory)}.json`);
  const read = async () => {
    let encoded;
    try { encoded = await fsImpl.readFile(filePath, 'utf8'); }
    catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
    let record;
    try { record = JSON.parse(encoded); } catch { throw invalidStore(); }
    if (!isPlainObject(record) || Object.keys(record).length !== 4 || record.version !== 1
      || !isString(record.ino) || !/^\d+$/.test(record.ino) || !hasBirthtime(record)
      || !isString(record.repositoryId) || !/^repo_[\w-]{43}$/.test(record.repositoryId)) throw invalidStore();
    return record;
  };
  const record = await read();
  if (sameDirectory(record, stats)) return record.repositoryId;
  if (!record && !hasBirthtime(stats)) return legacyId(commonDirectory, stats);

  return withSourceControlFileLock(`${filePath}.lock`, async () => {
    const currentStats = await fsImpl.stat(commonDirectory);
    const current = await read();
    if (sameDirectory(current, currentStats)) return current.repositoryId;
    if (!await birthtimeHoldsStill(fsImpl, path, commonDirectory, currentStats)) {
      // A reused inode must not restore the first repository's legacy grant.
      if (current) throw Object.assign(new Error('Repository directory identity cannot be verified'), {
        code: 'UNVERIFIABLE_REPOSITORY_IDENTITY',
      });
      return legacyId(commonDirectory, currentStats);
    }
    // First adoption keeps every existing binding, revision and receipt valid.
    // A replacement gets a new ID even if the filesystem reused the inode.
    const repositoryId = current
      ? `repo_${digest('repository-v3', commonDirectory, String(currentStats.ino), String(currentStats.birthtimeMs))}`
      : legacyId(commonDirectory, currentStats);
    const next = { version: 1, ino: String(currentStats.ino), birthtimeMs: currentStats.birthtimeMs, repositoryId };
    const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(next)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsImpl.chmod(temporary, 0o600);
      await fsImpl.rename(temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return repositoryId;
  }, { fsImpl });
}
