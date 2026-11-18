
import { asNonEmptyString } from '../shared/guards.js';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { hasCode, hasMessage, isRecord, isTimestamp } from './contracts.js';
import type { FileStoreOptions } from './contracts.js';
import type { JsonValue } from '@opencode/client';

const ARCHIVE_FILE_NAME = 'sessions-archive.json';

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
  now = Date.now,
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

  const parseStored = (raw: string) => {
    const parsed: JsonValue = JSON.parse(raw);
    if (!isRecord(parsed)) {
      throw new Error('archive file is not a JSON object');
    }
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

  const readFile = async (): Promise<{ ok: true; stored: Map<string, number | null> } | { ok: false; stored: null }> => {
    let raw;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (hasCode(error) && error.code === 'ENOENT') return { ok: true, stored: new Map() };
      console.warn('[openchamber-sessions] could not read the archive file:', (hasMessage(error) ? error.message : undefined) ?? error);
      return { ok: false, stored: null };
    }

    try {
      return { ok: true, stored: parseStored(raw) };
    } catch (error) {
      const backup = `${filePath}.corrupt-${now()}`;
      await fsPromises.rename(filePath, backup).catch(() => undefined);
      console.warn(
        `[openchamber-sessions] archive file was unreadable and was moved to ${backup}: ${(hasMessage(error) ? error.message : undefined) ?? error}`,
      );
      return { ok: true, stored: new Map() };
    }
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
    const payload = JSON.stringify(snapshot());
    await fsPromises.mkdir(dataDir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fsPromises.writeFile(tmpPath, payload, 'utf8');
    await fsPromises.rename(tmpPath, filePath);
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
