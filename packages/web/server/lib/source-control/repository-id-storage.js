import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPlainObject, isString } from '../shared/guards.js';
import { withSourceControlFileLock } from './file-lock.js';

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
  // Without a creation time, an inode on another volume cannot be distinguished
  // from this directory. Retain the device-sensitive identity in that case.
  if (!hasBirthtime(stats)) return legacyId(commonDirectory, stats);
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

  return withSourceControlFileLock(`${filePath}.lock`, async () => {
    const currentStats = await fsImpl.stat(commonDirectory);
    if (!hasBirthtime(currentStats)) return legacyId(commonDirectory, currentStats);
    const current = await read();
    if (sameDirectory(current, currentStats)) return current.repositoryId;
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
