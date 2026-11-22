import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';
import { GUEST_STORAGE_KEY_MAX, GUEST_STORAGE_KEYS_MAX, GUEST_STORAGE_TOTAL_BYTES, GUEST_STORAGE_VALUE_BYTES } from '@openchamber/sdk';

const stores = new Map();
const documentSchema = z.record(z.string().min(1).max(GUEST_STORAGE_KEY_MAX), z.json());
const storagePath = (persistPath, id) => {
  if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error('Invalid extension identity');
  return path.join(path.dirname(persistPath), 'guest-storage', `${id}.json`);
};

const withStorageLock = async (file, operation) => {
  const previous = stores.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(operation);
  stores.set(file, pending);
  try {
    return await pending;
  } finally {
    if (stores.get(file) === pending) stores.delete(file);
  }
};

export const removeGuestStorage = (persistPath, id) => {
  const file = storagePath(persistPath, id);
  return withStorageLock(file, () => fs.rm(file, { force: true }));
};

/** Authorization is rechecked inside the same lock that serializes removal. */
export const runGuestStorage = (persistPath, id, request, authorize) => {
  const file = storagePath(persistPath, id);
  return withStorageLock(file, async () => {
    await authorize();
    let entries = new Map();
    // Handle-judged bounded read (#1784): the createReadStream this
    // replaces opened without O_NONBLOCK, so a FIFO at the storage
    // path blocked the open forever — inside withStorageLock, wedging
    // every queued operation for the file — and judged nothing about
    // the file before streaming. The shared reader opens once with
    // O_NONBLOCK on POSIX, refuses non-regular files from the handle
    // stat, and enforces the cap in flight (at most cap + 1 bytes
    // read, so a file grown after the stat is refused, not buffered).
    const stored = await readBoundedFile(file, GUEST_STORAGE_TOTAL_BYTES);
    if (stored.ok) {
      const parsed = documentSchema.parse(JSON.parse(stored.buffer.toString('utf8')));
      entries = new Map(Object.entries(parsed));
    } else if (stored.reason === 'too-large') {
      throw new Error('Storage exceeds its size limit');
    } else if (stored.reason === 'not-regular') {
      const error = new Error('Storage file is not a regular file');
      error.code = stored.code;
      throw error;
    }
    // reason 'missing': entries stay empty, exactly as the old
    // ENOENT catch behaved. Malformed JSON and schema-invalid
    // documents still throw out of the lock, unchanged.
    if (request.op === 'get') {
      return entries.has(request.key)
        ? { storage: true, op: 'get', found: true, value: entries.get(request.key) }
        : { storage: true, op: 'get', found: false };
    }
    if (request.op === 'keys') return { storage: true, op: 'keys', keys: [...entries.keys()].sort() };
    if (request.op === 'set') {
      if (Buffer.byteLength(JSON.stringify(request.value)) > GUEST_STORAGE_VALUE_BYTES) throw new Error('Storage value exceeds 64 KiB');
      entries.set(request.key, request.value);
    } else {
      entries.delete(request.key);
    }
    const data = JSON.stringify(Object.fromEntries(entries));
    if (entries.size > GUEST_STORAGE_KEYS_MAX || Buffer.byteLength(data) > GUEST_STORAGE_TOTAL_BYTES) throw new Error('Extension storage is full');
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
      await renameWithRetry((from, to) => fs.rename(from, to), temporary, file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
    return { storage: true, op: request.op };
  });
};
