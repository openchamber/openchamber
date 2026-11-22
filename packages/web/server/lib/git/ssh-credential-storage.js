import { isPlainObject, isString } from '../shared/guards.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { withSourceControlFileLock } from '../source-control/file-lock.js';
import { renameWithRetry } from '../shared/atomic-rename.js';

const hasExactKeys = (value, keys) => {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
};
// Named generous byte cap for the store file (design #1655 rule 4):
// parseStore states no count or length clamp (a finding, not changed here),
// and append's maxKeys = 256 at ~4.2 KiB nominal per key (an absolute
// privateKeyPath, a 52-char fingerprint, an id, JSON overhead) puts a full
// legitimate store near 1.1 MiB — 4 MiB, the identity-store sibling shape,
// leaves generous headroom while still bounding the read.
const MAX_STORE_BYTES = 4 * 1024 * 1024;
// Chunk size for the in-flight capped handle read in readState (#1766,
// mirroring #1684): reads accumulate in pieces sized to the bytes
// present, never one maxBytes + 1 allocation up front.
const READ_CHUNK_BYTES = 64 * 1024;

const invalidStore = () => Object.assign(new Error('Managed SSH credential store is invalid'), {
  code: 'INVALID_MANAGED_SSH_CREDENTIAL_STORE',
});

const parseStore = (value) => {
  if (!isPlainObject(value) || !hasExactKeys(value, ['version', 'keys'])
    || value.version !== 1 || !Array.isArray(value.keys)) throw invalidStore();
  const ids = new Set();
  const keys = value.keys.map((record) => {
    if (!isPlainObject(record) || !hasExactKeys(record, ['id', 'privateKeyPath', 'fingerprint'])
      || !isString(record.id) || !record.id || record.id.trim() !== record.id || record.id.includes('\0')
      || !isString(record.privateKeyPath) || !path.isAbsolute(record.privateKeyPath) || /[\0\r\n]/.test(record.privateKeyPath)
      || !isString(record.fingerprint) || !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(record.fingerprint)
      || ids.has(record.id)) throw invalidStore();
    ids.add(record.id);
    return Object.freeze({
      id: record.id,
      privateKeyPath: record.privateKeyPath,
      fingerprint: record.fingerprint,
    });
  });
  return Object.freeze({ version: 1, keys: Object.freeze(keys) });
};

export function createManagedSshCredentialStore({ filePath, fsImpl = fs, lockWaitMs = 2_000 } = {}) {
  if (!isString(filePath) || !path.isAbsolute(filePath)
    || !Number.isSafeInteger(lockWaitMs) || lockWaitMs < 0) {
    throw new TypeError('Managed SSH credential store path is invalid');
  }
  let writes = Promise.resolve();
  const enqueue = (operation) => {
    const next = writes.then(() => withSourceControlFileLock(`${filePath}.lock`, operation, {
      fsImpl, waitMs: lockWaitMs,
    }));
    writes = next.then(() => undefined, () => undefined);
    return next;
  };
  const readState = async () => {
    let handle;
    try {
      // O_NONBLOCK (POSIX only) keeps open() from blocking on a FIFO
      // with no writer before the handle stat below can refuse it as
      // non-regular; O_NOFOLLOW stays so a symlink is judged at open.
      handle = await fsImpl.open(filePath, process.platform === 'win32'
        ? fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (error) {
      if (error?.code === 'ENOENT') return Object.freeze({ version: 1, keys: Object.freeze([]) });
      if (error?.code === 'ELOOP') throw invalidStore();
      throw error;
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || (process.platform !== 'win32' && (stats.mode & 0o077) !== 0)) throw invalidStore();
      if (stats.size > MAX_STORE_BYTES) throw invalidStore();
      // The stat size is only a hint (#1766): enforce the cap in flight
      // with a chunked handle read, so a file grown after the stat is
      // refused having buffered at most MAX_STORE_BYTES + 1 bytes.
      const chunks = [];
      let total = 0;
      while (total <= MAX_STORE_BYTES) {
        const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, MAX_STORE_BYTES + 1 - total));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
        if (bytesRead === 0) break;
        chunks.push(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
      if (total > MAX_STORE_BYTES) throw invalidStore();
      return parseStore(JSON.parse(Buffer.concat(chunks, total).toString('utf8')));
    } catch (error) {
      if (error?.code === 'INVALID_MANAGED_SSH_CREDENTIAL_STORE') throw error;
      throw invalidStore();
    } finally {
      await handle.close();
    }
  };
  const read = () => enqueue(readState);
  const lookup = (id) => {
    if (!isString(id) || !id || id.trim() !== id || id.includes('\0')) return Promise.resolve(null);
    return enqueue(async () => (await readState()).keys.find((record) => record.id === id) ?? null);
  };
  const writeState = async (keys) => {
    const state = parseStore({ version: 1, keys });
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${randomUUID()}.tmp`;
    try {
      await fsImpl.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fsImpl.chmod(temporary, 0o600);
      await renameWithRetry((from, to) => fsImpl.rename(from, to), temporary, filePath);
    } catch (error) {
      await fsImpl.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return state;
  };
  const replace = (keys) => enqueue(() => writeState(keys));
  const append = (record, { maxKeys = 256 } = {}) => {
    let committed = false;
    const operation = enqueue(async () => {
      if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new TypeError('Managed SSH credential limit is invalid');
      const current = await readState();
      if (current.keys.length >= maxKeys) {
        throw Object.assign(new Error('Managed SSH credential store is full'), { code: 'MANAGED_SSH_CREDENTIAL_LIMIT' });
      }
      const state = await writeState([...current.keys, record]);
      committed = true;
      return state;
    });
    return operation.catch((error) => {
      if (committed) error.managedSshRecordCommitted = true;
      throw error;
    });
  };
  return Object.freeze({ read, lookup, replace, append });
}
