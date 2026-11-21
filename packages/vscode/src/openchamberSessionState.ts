
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';

const ARCHIVE_FILE_NAME = 'sessions-archive.json';
const METADATA_FILE_NAME = 'sessions-metadata.json';
const UNREAD_BASELINE_FILE_NAME = 'sessions-unread.json';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
export type SessionMetadata = JsonObject;

type ArchivedSessions = Record<string, number | null>;
type StoredSessionMetadata = Record<string, SessionMetadata>;

export type SessionStateFs = {
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
  writeFile: (filePath: string, data: string, encoding: 'utf8') => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<string | undefined>;
};

export type SessionMetadataOnOpenCode = {
  read: (sessionID: string) => Promise<SessionMetadata | null>;
  write: (sessionID: string, metadata: SessionMetadata) => Promise<void>;
};

export type SessionArchiveOnOpenCode = {
  setArchived: (sessionID: string, archived: boolean) => Promise<void>;
};

const ARCHIVE_CONCURRENCY = 6;

const pushArchiveState = async (openCode: SessionArchiveOnOpenCode, ids: string[], archived: boolean): Promise<boolean[]> => {
  const took: boolean[] = new Array(ids.length);
  let next = 0;
  const lane = async () => {
    while (next < ids.length) {
      const index = next;
      next += 1;
      took[index] = await openCode.setArchived(ids[index], archived).then(() => true, () => false);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ARCHIVE_CONCURRENCY, ids.length) }, lane));
  return took;
};

type SessionStateStoreOptions = {
  dataDir: string;
  fsPromises?: SessionStateFs;
  now?: () => number;
};


export const parseJson = (text: string): JsonValue | null => {
  try {
    // SAFETY: JSON.parse can only produce strings, numbers, booleans, null,
    // arrays, and plain objects, which is exactly the JsonValue union.
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
};

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonString = (value: JsonValue | undefined): value is string => typeof value === 'string';

const isTimestamp = (value: JsonValue | undefined): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export const asSessionId = (value: JsonValue | undefined): string | null => {
  if (!isJsonString(value)) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const asTimestamp = (value: JsonValue | undefined): number | null => (isTimestamp(value) ? value : null);

export const asSessionIdList = (value: JsonValue | undefined): string[] => {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const id = asSessionId(entry);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

export const asSessionMetadata = (value: JsonValue | undefined): SessionMetadata | null =>
  isJsonObject(value) ? value : null;

export const mergeMetadataPatch = (current: SessionMetadata | undefined, patch: SessionMetadata): SessionMetadata => {
  const base: SessionMetadata = current ? { ...current } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key];
      continue;
    }
    const previous = base[key];
    base[key] = isJsonObject(value) ? mergeMetadataPatch(isJsonObject(previous) ? previous : undefined, value) : value;
  }
  return base;
};

export const getOpenChamberDataDir = (): string => {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, 'openchamber');
  }
  return path.join(os.homedir(), '.config', 'openchamber');
};

const isMissingFileError = (error: Error): boolean => 'code' in error && error.code === 'ENOENT';

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const createSessionStateStore = ({
  dataDir,
  fsPromises = fs.promises,
  now = Date.now,
}: SessionStateStoreOptions) => {
  const archivePath = path.join(dataDir, ARCHIVE_FILE_NAME);
  const metadataPath = path.join(dataDir, METADATA_FILE_NAME);
  const unreadBaselinePath = path.join(dataDir, UNREAD_BASELINE_FILE_NAME);
  let writeChain: Promise<unknown> = Promise.resolve();
  const metadataWrites = new Map<string, Promise<unknown>>();
  let unreadBaseline: number | null = null;

  const readJsonObjectFile = async (filePath: string): Promise<JsonObject | null> => {
    let raw: string;
    try {
      raw = await fsPromises.readFile(filePath, 'utf8');
    } catch (error) {
      if (error instanceof Error && isMissingFileError(error)) return {};
      console.warn(`[openchamber-sessions] could not read ${path.basename(filePath)}:`, describeError(error));
      return null;
    }
    const parsed = parseJson(raw);
    if (isJsonObject(parsed)) return parsed;
    const backup = `${filePath}.corrupt-${now()}`;
    await fsPromises.rename(filePath, backup).catch(() => undefined);
    console.warn(`[openchamber-sessions] ${path.basename(filePath)} was not a JSON object and was moved to ${backup}`);
    return {};
  };

  const writeJsonObjectFile = (filePath: string, value: JsonObject): Promise<void> => {
    const write = async () => {
      await fsPromises.mkdir(dataDir, { recursive: true });
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await fsPromises.writeFile(tmpPath, JSON.stringify(value), 'utf8');
      await fsPromises.rename(tmpPath, filePath);
    };
    const next = writeChain.then(write, write);
    writeChain = next.catch(() => undefined);
    return next;
  };

  const readArchived = async (): Promise<ArchivedSessions | null> => {
    const parsed = await readJsonObjectFile(archivePath);
    if (!parsed) return null;
    const result: ArchivedSessions = {};
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asSessionId(sessionID);
      if (!id) continue;
      if (value === null) result[id] = null;
      else if (isTimestamp(value)) result[id] = value;
    }
    return result;
  };

  const readMetadata = async (): Promise<StoredSessionMetadata | null> => {
    const parsed = await readJsonObjectFile(metadataPath);
    if (!parsed) return null;
    const result: StoredSessionMetadata = {};
    for (const [sessionID, value] of Object.entries(parsed)) {
      const id = asSessionId(sessionID);
      if (id && isJsonObject(value)) result[id] = value;
    }
    return result;
  };

  const readUnreadBaseline = async (): Promise<number | null> => {
    if (unreadBaseline !== null) return unreadBaseline;
    let raw: string;
    try {
      raw = await fsPromises.readFile(unreadBaselinePath, 'utf8');
    } catch (error) {
      if (!(error instanceof Error && isMissingFileError(error))) {
        console.warn('[openchamber-sessions] could not read the unread baseline:', describeError(error));
        return null;
      }
      const since = now();
      unreadBaseline = since;
      await writeJsonObjectFile(unreadBaselinePath, { since }).catch((writeError) => {
        console.warn('[openchamber-sessions] could not save the unread baseline:', describeError(writeError));
      });
      return since;
    }
    const parsed = parseJson(raw);
    const since = isJsonObject(parsed) ? asTimestamp(parsed.since) : null;
    if (since === null) {
      console.warn(`[openchamber-sessions] the unread baseline in ${unreadBaselinePath} is unreadable; it is left as is`);
      return null;
    }
    unreadBaseline = since;
    return since;
  };

  const forgetEntries = async (ids: string[]): Promise<boolean> => {
    const current = await readArchived();
    if (!current) return false;
    if (!ids.some((id) => id in current)) return true;
    const next = { ...current };
    for (const id of ids) delete next[id];
    try {
      await writeJsonObjectFile(archivePath, next);
      return true;
    } catch (error) {
      console.warn('[openchamber-sessions] failed to persist archive state:', describeError(error));
      return false;
    }
  };

  const applyArchive = async (ids: string[], archivedAt: number | null, openCode: SessionArchiveOnOpenCode) => {
    const targets = asSessionIdList(ids);
    if (targets.length === 0) return { applied: [] as string[], failedIds: [] as string[] };
    const took = await pushArchiveState(openCode, targets, archivedAt !== null);
    const onOpenCode = targets.filter((_, index) => took[index]);
    const refused = targets.filter((_, index) => !took[index]);

    const forgotten = await forgetEntries(onOpenCode);
    const current = forgotten ? null : await readArchived();
    const stale = current ? onOpenCode.filter((id) => id in current) : [];
    return { applied: onOpenCode.filter((id) => !stale.includes(id)), failedIds: [...stale, ...refused] };
  };

  const updateMetadata = (sessionID: string, patch: SessionMetadata, openCode: SessionMetadataOnOpenCode, expected?: SessionMetadata) => {
    const run = async () => {
      const stored = await readMetadata();
      if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
      const upstream = await openCode.read(sessionID);
      if (!upstream) throw new Error(`session ${sessionID} was not found`);
      const legacy = stored[sessionID];
      const current = legacy ? { ...upstream, ...legacy } : upstream;
      if (expected && !isDeepStrictEqual(current, expected)) return { metadata: current, conflict: true };
      const merged = mergeMetadataPatch(current, patch);
      await openCode.write(sessionID, merged);
      if (legacy) {
        const latest = await readMetadata();
        if (latest && latest[sessionID]) {
          const next = { ...latest };
          delete next[sessionID];
          await writeJsonObjectFile(metadataPath, next).catch((error) => {
            console.warn('[openchamber-sessions] could not update the legacy metadata file:', describeError(error));
          });
        }
      }
      return { metadata: merged, conflict: false };
    };
    const next = (metadataWrites.get(sessionID) ?? Promise.resolve()).then(run, run);
    metadataWrites.set(sessionID, next);
    void next.finally(() => {
      if (metadataWrites.get(sessionID) === next) metadataWrites.delete(sessionID);
    }).catch(() => undefined);
    return next;
  };

  return {
    archivePath,
    metadataPath,
    readArchived,
    readMetadata,
    readUnreadBaseline,
    archive: async (ids: string[], archivedAt: number | null, openCode: SessionArchiveOnOpenCode) => {
      const stamp = archivedAt ?? now();
      const { applied, failedIds } = await applyArchive(ids, stamp, openCode);
      return { archived: applied.map((id) => ({ id, archivedAt: stamp })), failedIds };
    },
    unarchive: async (ids: string[], openCode: SessionArchiveOnOpenCode) => {
      const { applied, failedIds } = await applyArchive(ids, null, openCode);
      return { restored: applied.map((id) => ({ id, archivedAt: null })), failedIds };
    },
    getMetadata: async (sessionID: string, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
      const stored = await readMetadata();
      if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
      const upstream = await openCode.read(sessionID);
      const legacy = stored[sessionID];
      return legacy ? { ...(upstream ?? {}), ...legacy } : upstream ?? {};
    },
    setMetadata: async (sessionID: string, patch: SessionMetadata, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
      return (await updateMetadata(sessionID, patch, openCode)).metadata;
    },
    compareAndSetMetadata: (sessionID: string, expected: SessionMetadata, patch: SessionMetadata, openCode: SessionMetadataOnOpenCode) =>
      updateMetadata(sessionID, patch, openCode, expected),
  };
};

export type SessionStateStore = ReturnType<typeof createSessionStateStore>;

const withUnreadBaseline = (record: JsonObject, since: number) => {
  const time = isJsonObject(record.time) ? record.time : null;
  const idle = time ? asTimestamp(time.idle) : null;
  if (!time || idle === null || idle > since) return record;
  const viewed = asTimestamp(time.viewed);
  if (viewed !== null && viewed >= idle) return record;
  return { ...record, time: { ...time, viewed: idle } };
};

const overlaySessionRecord = (
  value: JsonValue,
  archived: ArchivedSessions | null,
  stored: StoredSessionMetadata | null,
  unreadSince: number | null,
): JsonValue => {
  if (!isJsonObject(value)) return value;
  const id = asSessionId(value.id);
  if (!id) return value;
  let result: JsonObject = value;
  if (archived && Object.prototype.hasOwnProperty.call(archived, id)) {
    const time = isJsonObject(result.time) ? result.time : {};
    const archivedAt = archived[id];
    if (typeof archivedAt === 'number') {
      result = { ...result, time: { ...time, archived: archivedAt } };
    } else if ('archived' in time) {
      const rest = { ...time };
      delete rest.archived;
      result = { ...result, time: rest };
    }
  }
  if (stored) {
    const ours = stored[id];
    if (ours) {
      const theirs = isJsonObject(result.metadata) ? result.metadata : {};
      result = { ...result, metadata: { ...theirs, ...ours } };
    }
  }
  if (unreadSince !== null) result = withUnreadBaseline(result, unreadSince);
  return result;
};

export const overlaySessionResponseBody = (
  body: JsonValue,
  archived: ArchivedSessions | null,
  stored: StoredSessionMetadata | null,
  unreadSince: number | null = null,
): JsonValue => {
  if (!archived && !stored && unreadSince === null) return body;
  const overlay = (entry: JsonValue) => overlaySessionRecord(entry, archived, stored, unreadSince);
  if (Array.isArray(body)) return body.map(overlay);
  if (!isJsonObject(body)) return body;
  const data = body.data;
  if (Array.isArray(data)) {
    return { ...body, data: data.map(overlay) };
  }
  if (isJsonObject(data)) {
    return { ...body, data: overlay(data) };
  }
  return overlay(body);
};

export const isSessionRecordPath = (pathname: string): boolean =>
  pathname === '/api/session' || /^\/api\/session\/[^/]+$/.test(pathname);
