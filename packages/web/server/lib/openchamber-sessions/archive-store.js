/**
 * Session archive state OpenChamber kept before OpenCode held it.
 *
 * OpenCode archives sessions itself (`PATCH /api/session/{id}` with
 * `archived`), and `session-archive.js` sends every archive there. This file
 * only drains: it holds entries written before 2.1, and for sessions of
 * deleted directories before 2.2, until the migration pushes them.
 *
 * One JSON file per data dir, `{ [sessionID]: archivedAt | null }`, folded onto
 * the session records the proxy serves: a number archives, `null` is an
 * explicit unarchive that overrides what OpenCode carries, and a session the
 * file does not mention keeps whatever OpenCode says. An entry leaves the file
 * once OpenCode holds the session's state.
 */

import { asNonEmptyString } from '../shared/guards.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';

const ARCHIVE_FILE_NAME = 'sessions-archive.json';

const asTimestamp = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

const asIdList = (ids) => {
  if (!Array.isArray(ids)) return [];
  const seen = new Set();
  const result = [];
  for (const value of ids) {
    const id = asNonEmptyString(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

/**
 * @param {object} options
 * @param {string} options.dataDir OpenChamber data directory for this instance.
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {() => number} [options.now]
 */
export const createArchiveStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
  now = Date.now,
}) => {
  const filePath = path.join(dataDir, ARCHIVE_FILE_NAME);

  /** sessionID → archivedAt (ms), or null for an explicit unarchive. */
  const entries = new Map();
  let loadPromise = null;
  /**
   * Writes stay disabled until one load has told us what is already on disk.
   * A failed read is not evidence that nothing is archived, and writing over
   * a file we could not read would drop exactly the state we are protecting.
   */
  let writable = false;
  /**
   * One batch at a time: mutate memory, persist, roll back on failure.
   * Serializing only the file write is not enough — a rollback that runs after
   * a later batch has already committed would erase that batch's memory while
   * its bytes stay on disk, and the next write would then erase the bytes too.
   */
  let transactionChain = Promise.resolve();
  const runExclusive = (work) => {
    const next = transactionChain.then(work, work);
    transactionChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const snapshot = () => Object.fromEntries(entries);

  const parseStored = (raw) => {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('archive file is not a JSON object');
    }
    const result = new Map();
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asNonEmptyString(sessionID);
      if (!id) continue;
      if (value === null) {
        result.set(id, null);
        continue;
      }
      const archivedAt = asTimestamp(value);
      if (archivedAt) result.set(id, archivedAt);
    }
    return result;
  };

  const readFile = async () => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      // No file yet is the normal first run: nothing is archived, and writing
      // is safe because there is no state to lose.
      if (error?.code === 'ENOENT') return { ok: true, stored: new Map() };
      console.warn('[openchamber-sessions] could not read the archive file:', error?.message ?? error);
      return { ok: false, stored: null };
    }

    try {
      return { ok: true, stored: parseStored(raw) };
    } catch (error) {
      // Malformed bytes are kept for the user instead of being overwritten on
      // the next archive, and whatever this process already knows stays in
      // memory rather than collapsing to "nothing archived".
      const backup = `${filePath}.corrupt-${now()}`;
      await fsPromises.rename(filePath, backup).catch(() => undefined);
      console.warn(
        `[openchamber-sessions] archive file was unreadable and was moved to ${backup}: ${error?.message ?? error}`,
      );
      return { ok: true, stored: new Map() };
    }
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile().then((result) => {
        if (result.ok) {
          // Merge rather than replace: an archive that happened while the first
          // load was still running must survive it.
          for (const [id, archivedAt] of result.stored) {
            if (!entries.has(id)) entries.set(id, archivedAt);
          }
          writable = true;
        } else {
          // Let a later call retry; until one succeeds the store answers reads
          // from memory and refuses writes.
          loadPromise = null;
        }
        return { ok: result.ok, entries: snapshot() };
      });
    }
    return loadPromise;
  };

  /** Only ever called inside `runExclusive`, so two batches cannot interleave their renames. */
  const persist = async () => {
    const payload = JSON.stringify(snapshot());
    await fsPromises.mkdir(dataDir, { recursive: true });
    // Temp file in the same directory so the rename is atomic on one device:
    // a reader sees either the previous file or the complete new one.
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, payload, 'utf8');
    await fsPromises.rename(tmpPath, filePath);
  };

  /**
   * Drops entries OpenCode now holds the state for. Writes only when one of
   * the ids had an entry; a failed write restores them and reports them.
   */
  const forgetExclusive = async (targets) => {
    const loadResult = await load();
    if (!loadResult.ok || !writable) return { failedIds: targets.filter((id) => entries.has(id)) };
    const removed = targets.filter((id) => entries.has(id)).map((id) => [id, entries.get(id)]);
    if (removed.length === 0) return { failedIds: [] };
    for (const [id] of removed) entries.delete(id);
    try {
      await persist();
    } catch (error) {
      for (const [id, value] of removed) entries.set(id, value);
      console.warn('[openchamber-sessions] failed to persist archive state:', error?.message ?? error);
      return { failedIds: removed.map(([id]) => id) };
    }
    return { failedIds: [] };
  };

  const getAll = async () => {
    await load();
    return snapshot();
  };

  return {
    load,
    getAll,
    /**
     * The file's entry for a session: a timestamp, `null` for an explicit
     * unarchive, `undefined` when the file does not mention it and OpenCode's
     * record decides.
     */
    entry: async (id) => {
      const sessionID = asNonEmptyString(id);
      if (!sessionID) return undefined;
      await load();
      return entries.get(sessionID);
    },
    forget: async (ids) => {
      const targets = asIdList(ids);
      if (targets.length === 0) return { failedIds: [] };
      return runExclusive(() => forgetExclusive(targets));
    },
    filePath,
  };
};
