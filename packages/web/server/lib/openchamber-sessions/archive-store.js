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

import { asNonEmptyString } from '../shared/guards.js';
import {
  isJsonObject,
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';
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

  // The value judgement stays this store's: a JSON object (judged by the
  // primitive's reader via isJsonObject) whose entries are positive
  // timestamps or explicit null unarchives; any other entry value is dropped.
  const parseValue = (parsed) => {
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

  const durableOptions = () => ({ fs: fsPromises, validateValue: isJsonObject });

  const readFile = async () => {
    // Up to three attempts: a preserve that answers 'replaced' means a valid
    // file landed while the malformed bytes were being judged - read that
    // file instead of answering from the stale judgement.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let result;
      try {
        result = await readDurableJsonFile(filePath, durableOptions());
      } catch (error) {
        // A read failure other than absence (absence is 'missing') is not
        // evidence that nothing is archived, and writing over a file we
        // could not read would drop exactly the state we are protecting.
        console.warn('[openchamber-sessions] could not read the archive file:', error?.message ?? error);
        return { ok: false, stored: null };
      }
      // No file yet (or an empty one) is the normal first run: nothing is
      // archived, and writing is safe because there is no state to lose.
      if (result.state === 'missing') return { ok: true, stored: new Map() };
      if (result.state === 'valid') return { ok: true, stored: parseValue(result.value) };
      // Malformed bytes are preserved aside by the shared primitive under
      // its collision-proof name instead of being overwritten on the next
      // archive, and whatever this process already knows stays in memory
      // rather than collapsing to "nothing archived". The raw bytes are
      // never logged: a parse error can quote the file.
      const preservation = await preserveMalformedJsonFile(filePath, durableOptions());
      if (preservation.outcome === 'replaced') continue;
      if (preservation.outcome === 'failed') {
        // Fail closed (the primitive's contract): preservation failed, so
        // the bytes are still live at the path and a write would destroy
        // them. Refuse like an unreadable file; a later load can retry.
        console.warn('[openchamber-sessions] could not preserve the unreadable archive file; writes are refused until it can be preserved');
        return { ok: false, stored: null };
      }
      if (preservation.preserved) {
        console.warn(
          `[openchamber-sessions] archive file was unreadable and was preserved at ${preservation.preservedPath}`,
        );
      }
      return { ok: true, stored: new Map() };
    }
    return { ok: true, stored: new Map() };
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
    // Preserve-before-write, fail-closed (the primitive's contract): a
    // malformed file that appeared after the load must be preserved before
    // any write replaces it, and a failed preservation refuses the write -
    // the batch then rolls back in applyBatchExclusive.
    const preservation = await preserveMalformedJsonFile(filePath, durableOptions());
    if (preservation.outcome === 'failed') {
      throw new Error('could not preserve the unreadable archive file; refusing to overwrite it');
    }
    if (preservation.preserved) {
      console.warn(
        `[openchamber-sessions] archive file was unreadable and was preserved at ${preservation.preservedPath}`,
      );
    }
    // Atomic write through the primitive: a unique temp file in the same
    // directory, renamed over the destination, so a reader sees either the
    // previous file or the complete new one. The mode is stated explicitly
    // at this store's previous effective behaviour (0o666, umask-governed):
    // archive stamps are session ids and timestamps, not secret-bearing.
    await writeDurableJsonFile(filePath, JSON.stringify(snapshot()), {
      fs: fsPromises,
      mode: 0o666,
    });
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
