
import { asNonEmptyString } from '../shared/guards.js';
import {
  isJsonObject,
  preserveMalformedJsonFile,
  readDurableJsonFile,
  writeDurableJsonFile,
} from '../shared/durable-json-store.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { hasMessage, isTimestamp } from './contracts.js';
import type { FileStoreOptions } from './contracts.js';
import type { JsonValue } from '@opencode/client';

const ARCHIVE_FILE_NAME = 'sessions-archive.json';

/** The archive file as the durable reader hands it over: a JSON object (isJsonObject). */
type StoredArchiveFile = { [sessionID: string]: JsonValue | undefined };

const asTimestamp = (value: JsonValue | undefined) => (isTimestamp(value) ? value : null);

const asIdList = (ids: JsonValue | undefined) => {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of ids) {
    const id = asNonEmptyString(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

export const createArchiveStore = ({
  dataDir,
  fsPromises = fsDefault.promises,
  path = pathDefault,
}: FileStoreOptions) => {
  const filePath = path.join(dataDir, ARCHIVE_FILE_NAME);

  const entries = new Map<string, number | null>();
  let loadPromise: Promise<{ ok: boolean; entries: Record<string, number | null> }> | null = null;
  let writable = false;
  let transactionChain = Promise.resolve();
  const runExclusive = <T>(work: () => Promise<T>) => {
    const next = transactionChain.then(work, work);
    transactionChain = next.then(() => undefined, () => undefined);
    return next;
  };

  const snapshot = () => Object.fromEntries(entries);

  // The value judgement stays this store's: a JSON object (judged by the
  // primitive's reader via isJsonObject) whose entries are positive
  // timestamps or explicit null unarchives; any other entry value is dropped.
  const parseValue = (parsed: StoredArchiveFile) => {
    const result = new Map<string, number | null>();
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

  type ReadResult = { ok: true; stored: Map<string, number | null> } | { ok: false; stored: null };
  const readFile = async (): Promise<ReadResult> => {
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
        console.warn('[openchamber-sessions] could not read the archive file:', error instanceof Error ? error.message : error);
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
          for (const [id, archivedAt] of result.stored) {
            if (!entries.has(id)) entries.set(id, archivedAt);
          }
          writable = true;
        } else {
          loadPromise = null;
        }
        return { ok: result.ok, entries: snapshot() };
      });
    }
    return loadPromise;
  };

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

  const forgetExclusive = async (targets: string[]) => {
    const loadResult = await load();
    if (!loadResult.ok || !writable) return { failedIds: targets.filter((id) => entries.has(id)) };
    const removed = targets.filter((id) => entries.has(id)).map((id): [string, number | null] => {
      const value = entries.get(id);
      if (value === undefined) throw new Error('missing retained archive entry');
      return [id, value];
    });
    if (removed.length === 0) return { failedIds: [] };
    for (const [id] of removed) entries.delete(id);
    try {
      await persist();
    } catch (error) {
      for (const [id, value] of removed) entries.set(id, value);
      console.warn('[openchamber-sessions] failed to persist archive state:', (hasMessage(error) ? error.message : undefined) ?? error);
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
    entry: async (id: JsonValue | undefined) => {
      const sessionID = asNonEmptyString(id);
      if (!sessionID) return undefined;
      await load();
      return entries.get(sessionID);
    },
    forget: async (ids: JsonValue | undefined) => {
      const targets = asIdList(ids);
      if (targets.length === 0) return { failedIds: [] };
      return runExclusive(() => forgetExclusive(targets));
    },
    filePath,
  };
};
