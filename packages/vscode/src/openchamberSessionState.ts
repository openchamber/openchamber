/**
 * OpenChamber session state for the VS Code runtime: archive flags and
 * per-session metadata.
 *
 * OpenCode holds archive state since 2.1 (`PATCH /api/session/{id}` with
 * `archived`), and every archive goes there first. OpenCode cannot change a
 * session whose directory was deleted (`LocationNotFoundError`); those keep
 * their state in the archive file the OpenChamber server uses
 * (`packages/web/server/lib/openchamber-sessions/session-archive.js`), kept
 * here in the shared OpenChamber config directory, which is also the web
 * server's default data directory. The file's entries win over OpenCode's
 * record, so a session OpenCode took leaves the file. The web server pushes
 * entries an older OpenChamber wrote.
 *
 * Metadata lives on the OpenCode session record (`PATCH /api/session/{id}`,
 * OpenCode 2.0.15+). Before that it lived in `sessions-metadata.json` in the
 * same directory. An entry still in that file is the newest metadata its
 * session has: reads lay it over OpenCode's record, and the session's next
 * write pushes the result to OpenCode and drops the entry. The web server
 * sweeps the rest.
 *
 * Two processes may write these files, so nothing is cached between calls:
 * every read parses the file and every write re-reads it first, then replaces
 * it atomically. The files are a few kilobytes, and the reads sit behind
 * session list requests, not on a hot path.
 *
 * Metadata writes are a JSON Merge Patch (RFC 7386): nested objects merge key
 * by key and `null` deletes. OpenCode replaces the whole object on PATCH, so
 * the merge happens here, and two features writing into the same `openchamber`
 * namespace (goal mode, session assist, pinned context, review links) do not
 * erase each other.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ARCHIVE_FILE_NAME = 'sessions-archive.json';
const METADATA_FILE_NAME = 'sessions-metadata.json';
/** Shared with the web server (`unread-baseline.js`): `{ since }`, written once. */
const UNREAD_BASELINE_FILE_NAME = 'sessions-unread.json';

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
/** Free-form JSON attached to a session; the same shape the shared UI's `Metadata` has. */
export type SessionMetadata = JsonObject;

/**
 * Archive state per session: a number archives, `null` is an explicit
 * unarchive that drops the stamp OpenCode still carries (sessions migrated
 * from v1), and a session that is absent keeps whatever OpenCode says.
 */
type ArchivedSessions = Record<string, number | null>;
type StoredSessionMetadata = Record<string, SessionMetadata>;

export type SessionStateFs = {
  readFile: (filePath: string, encoding: 'utf8') => Promise<string>;
  writeFile: (filePath: string, data: string, encoding: 'utf8') => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  mkdir: (dirPath: string, options: { recursive: true }) => Promise<string | undefined>;
};

/** One session's metadata on OpenCode. `read` resolves `null` for a session OpenCode does not know. */
export type SessionMetadataOnOpenCode = {
  read: (sessionID: string) => Promise<SessionMetadata | null>;
  write: (sessionID: string, metadata: SessionMetadata) => Promise<void>;
};

/**
 * Archive state on OpenCode. `setArchived` throws OpenCode's tagged error;
 * `relocate` moves a session whose directory is gone to its project's main
 * folder and sets its state there, resolving false when it could not.
 */
export type SessionArchiveOnOpenCode = {
  setArchived: (sessionID: string, archived: boolean) => Promise<void>;
  relocate: (sessionID: string, archived: boolean) => Promise<boolean>;
};

/** PATCHes in flight at once; one batch is a worktree's sessions. */
const ARCHIVE_CONCURRENCY = 6;

const isLocationNotFound = (error: Error): boolean => error.name === 'LocationNotFoundError';

type ArchiveOutcome = 'opencode' | 'location-gone' | 'failed';

const pushArchiveState = async (openCode: SessionArchiveOnOpenCode, ids: string[], archived: boolean): Promise<ArchiveOutcome[]> => {
  const outcomes: ArchiveOutcome[] = new Array(ids.length);
  let next = 0;
  const lane = async () => {
    while (next < ids.length) {
      const index = next;
      next += 1;
      try {
        await openCode.setArchived(ids[index], archived);
        outcomes[index] = 'opencode';
      } catch (error) {
        outcomes[index] = error instanceof Error && isLocationNotFound(error) ? 'location-gone' : 'failed';
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ARCHIVE_CONCURRENCY, ids.length) }, lane));
  return outcomes;
};

type SessionStateStoreOptions = {
  dataDir: string;
  fsPromises?: SessionStateFs;
  now?: () => number;
};

// ---------------------------------------------------------------------------
// JSON boundary: every byte from disk or from a proxied response enters as a
// `JsonValue` here, and the guards below are the only narrowing in the module.
// ---------------------------------------------------------------------------

/** Parses text into a JSON value; `null` when it is not JSON. */
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

/** A session id as the bridge or a file carries it: a non-empty trimmed string, else `null`. */
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

/**
 * RFC 7386 merge. Returns a new object; `null` in the patch removes the key,
 * and a non-object patch value replaces whatever was there.
 */
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

/** The shared OpenChamber config directory, the web server's default data dir. */
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
  let unreadBaseline: number | null = null;

  /**
   * Parses one state file. A missing file is the normal first run and reads
   * as empty; unreadable bytes are moved aside so the next write cannot
   * overwrite what the user had, and read as empty too. An I/O failure other
   * than "missing" is reported as `null`: unknown, not empty.
   */
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
      // Temp file in the same directory so the rename is atomic on one device.
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

  /**
   * When unread marks start for this data dir (see `withUnreadBaseline`). The
   * first read creates it; an unreadable file is left alone and reads as
   * unknown, since a new baseline would mark every turn up to now as seen.
   */
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

  /** Drops entries OpenCode now holds; false when the file could not be updated. */
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

  const writeEntries = async (ids: string[], archivedAt: number | null): Promise<boolean> => {
    if (ids.length === 0) return true;
    const current = await readArchived();
    if (!current) return false;
    const next = { ...current };
    for (const id of ids) next[id] = archivedAt;
    try {
      await writeJsonObjectFile(archivePath, next);
      return true;
    } catch (error) {
      console.warn('[openchamber-sessions] failed to persist archive state:', describeError(error));
      return false;
    }
  };

  const relocateAll = async (openCode: SessionArchiveOnOpenCode, ids: string[], archived: boolean) => {
    const moved: string[] = [];
    for (const id of ids) {
      if (await openCode.relocate(id, archived).catch(() => false)) moved.push(id);
    }
    return moved;
  };

  /**
   * Sets a batch's archive state on OpenCode. A session whose directory is
   * gone moves to its project's main folder first; when archiving, the file
   * marks it archived before the move, so it never shows as active while
   * OpenCode announces the move. The file keeps a session that cannot move.
   * `null` restores. Resolves the ids whose state now holds and the ids that
   * failed.
   */
  const applyArchive = async (ids: string[], archivedAt: number | null, openCode: SessionArchiveOnOpenCode) => {
    const targets = asSessionIdList(ids);
    if (targets.length === 0) return { applied: [] as string[], failedIds: [] as string[] };
    const archived = archivedAt !== null;
    const outcomes = await pushArchiveState(openCode, targets, archived);
    const onOpenCode = targets.filter((_, index) => outcomes[index] === 'opencode');
    const gone = targets.filter((_, index) => outcomes[index] === 'location-gone');
    const refused = targets.filter((_, index) => outcomes[index] === 'failed');

    // A stale entry would override what OpenCode now holds; an unreadable file
    // is not folded onto reads, so OpenCode's state shows either way.
    const forgotten = await forgetEntries(onOpenCode);
    const current = forgotten ? null : await readArchived();
    const stale = current ? onOpenCode.filter((id) => id in current) : [];
    const applied = onOpenCode.filter((id) => !stale.includes(id));
    const failedIds = [...stale, ...refused];
    if (gone.length === 0) return { applied, failedIds };

    if (archived) {
      if (!(await writeEntries(gone, archivedAt))) return { applied, failedIds: [...failedIds, ...gone] };
      const moved = await relocateAll(openCode, gone, true);
      await forgetEntries(moved);
      return { applied: [...applied, ...gone], failedIds };
    }
    const moved = await relocateAll(openCode, gone, false);
    const kept = gone.filter((id) => !moved.includes(id));
    const movedForgotten = await forgetEntries(moved);
    const keptWritten = await writeEntries(kept, null);
    return {
      applied: [...applied, ...(movedForgotten ? moved : []), ...(keptWritten ? kept : [])],
      failedIds: [...failedIds, ...(movedForgotten ? [] : moved), ...(keptWritten ? [] : kept)],
    };
  };

  return {
    archivePath,
    metadataPath,
    /** `{ [sessionID]: archivedAt }`, or `null` when the file could not be read. */
    readArchived,
    /** `{ [sessionID]: metadata }`, or `null` when the file could not be read. */
    readMetadata,
    /** The unread baseline in epoch ms, or `null` when it cannot be known. */
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
    /** The session's full metadata: a legacy entry laid over OpenCode's record. `{}` for an unknown session. */
    getMetadata: async (sessionID: string, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
      const stored = await readMetadata();
      if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
      const upstream = await openCode.read(sessionID);
      const legacy = stored[sessionID];
      return legacy ? { ...(upstream ?? {}), ...legacy } : upstream ?? {};
    },
    /**
     * Applies a merge patch on OpenCode and resolves with the session's full
     * metadata afterwards. A legacy entry is folded in and then dropped from
     * the file, since OpenCode now holds it.
     */
    setMetadata: async (sessionID: string, patch: SessionMetadata, openCode: SessionMetadataOnOpenCode): Promise<SessionMetadata> => {
      const stored = await readMetadata();
      if (!stored) throw new Error('session metadata is unavailable: its file could not be read');
      const upstream = await openCode.read(sessionID);
      if (!upstream) throw new Error(`session ${sessionID} was not found`);
      const legacy = stored[sessionID];
      const merged = mergeMetadataPatch(legacy ? { ...upstream, ...legacy } : upstream, patch);
      await openCode.write(sessionID, merged);
      if (legacy) {
        // Re-read: the web server or another window may have changed the file.
        const latest = await readMetadata();
        if (latest && latest[sessionID]) {
          const next = { ...latest };
          delete next[sessionID];
          await writeJsonObjectFile(metadataPath, next).catch((error) => {
            // OpenCode holds the record; a stale entry is pushed again later.
            console.warn('[openchamber-sessions] could not update the legacy metadata file:', describeError(error));
          });
        }
      }
      return merged;
    },
  };
};

export type SessionStateStore = ReturnType<typeof createSessionStateStore>;

/**
 * OpenCode's unread state (`time.idle` past `time.viewed`) predates OpenChamber
 * reading it, so a turn that ended before the baseline and has no newer view
 * is served as viewed when it ended. Mirrors the web server's `unread-baseline.js`.
 */
const withUnreadBaseline = (record: JsonObject, since: number) => {
  const time = isJsonObject(record.time) ? record.time : null;
  const idle = time ? asTimestamp(time.idle) : null;
  if (!time || idle === null || idle > since) return record;
  const viewed = asTimestamp(time.viewed);
  if (viewed !== null && viewed >= idle) return record;
  return { ...record, time: { ...time, viewed: idle } };
};

/**
 * Folds owned state onto one OpenCode session record: `time.archived` from the
 * archive file (dropped when the file says the session is not archived),
 * legacy metadata not yet migrated merged over OpenCode's record, and the
 * unread baseline. A value that is not a session record passes through
 * untouched.
 */
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

/**
 * Applies `overlaySessionRecord` to a proxied `GET /api/session` list or
 * `GET /api/session/:id` body. Both shapes OpenCode uses are handled: a bare
 * record/array and the `{ data }` envelope. Anything else passes through.
 */
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

/** `GET /api/session` (list) and `GET /api/session/:id` (one record) carry session records to overlay. */
export const isSessionRecordPath = (pathname: string): boolean =>
  pathname === '/api/session' || /^\/api\/session\/[^/]+$/.test(pathname);
