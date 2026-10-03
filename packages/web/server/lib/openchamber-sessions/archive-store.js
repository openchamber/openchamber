/**
 * OpenChamber-owned session archive state.
 *
 * OpenCode 2.x still carries `SessionInfo.time.archived` on the wire (sessions
 * migrated from v1 keep the flag) but has no route that sets or clears it, so
 * archiving is an OpenChamber capability now. The state lives beside the
 * OpenCode instance it describes — one JSON file per data dir,
 * `{ [sessionID]: archivedAt | null }` — and the proxy folds it back onto the
 * session records it serves: a number archives, `null` is an explicit
 * unarchive that overrides what OpenCode still carries, and a session the file
 * does not mention keeps whatever OpenCode says.
 */

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

const ARCHIVE_FILE_NAME = 'sessions-archive.json';

const asNonEmptyString = (value) => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

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

  /** sessionID → archivedAt (ms). Authoritative once `loaded` is true. */
  const entries = new Map();
  let loaded = false;
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
          loaded = true;
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

  /** Applies a batch and rolls the memory back when the file write fails. */
  const applyBatch = async (ids, archivedAt) => {
    const targets = asIdList(ids);
    if (targets.length === 0) return { applied: [], failedIds: [] };
    return runExclusive(() => applyBatchExclusive(targets, archivedAt));
  };

  const applyBatchExclusive = async (targets, archivedAt) => {
    const loadResult = await load();
    if (!loadResult.ok || !writable) {
      return { applied: [], failedIds: targets };
    }

    const previous = targets.map((id) => [id, entries.has(id) ? { value: entries.get(id) } : undefined]);
    // `null` is kept as an entry on purpose: it tells the overlay to drop an
    // archived stamp OpenCode still carries (migrated v1 sessions).
    for (const id of targets) entries.set(id, archivedAt);

    try {
      await persist();
    } catch (error) {
      for (const [id, restore] of previous) {
        if (restore === undefined) entries.delete(id);
        else entries.set(id, restore.value);
      }
      console.warn('[openchamber-sessions] failed to persist archive state:', error?.message ?? error);
      return { applied: [], failedIds: targets };
    }

    return { applied: targets, failedIds: [] };
  };

  const getAll = async () => {
    await load();
    return snapshot();
  };

  return {
    load,
    getAll,
    list: getAll,
    isLoaded: () => loaded,
    isArchived: async (id) => {
      const sessionID = asNonEmptyString(id);
      if (!sessionID) return false;
      await load();
      return typeof entries.get(sessionID) === 'number';
    },
    archivedAt: async (id) => {
      const sessionID = asNonEmptyString(id);
      if (!sessionID) return null;
      await load();
      return entries.get(sessionID) ?? null;
    },
    archive: async (ids, archivedAt) => {
      const stamp = asTimestamp(archivedAt) ?? now();
      const { applied, failedIds } = await applyBatch(ids, stamp);
      return { archived: applied.map((id) => ({ id, archivedAt: stamp })), failedIds };
    },
    unarchive: async (ids) => {
      const { applied, failedIds } = await applyBatch(ids, null);
      return { restored: applied.map((id) => ({ id, archivedAt: null })), failedIds };
    },
    filePath,
  };
};
