import { isRecord } from '../shared/guards.js';
import { TOMBSTONE_TTL_MS, applyFolderChanges } from './folder-changes.js';
import type {
  FolderChange,
  FolderSnapshot,
  FolderTombstones,
  SessionFolder,
  SessionFoldersDependencies,
  SessionFoldersMap,
  StoredFolderSnapshot,
} from './contracts.js';

export const MAX_SESSION_FOLDERS_BODY_BYTES = 4 * 1024 * 1024;

export class SessionFoldersError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'SessionFoldersError';
    this.status = status;
  }
}

export const isObjectRecord = (value: unknown): value is object => isRecord(value);

const isSessionId = (value: unknown): value is string => typeof value === 'string';
const isDeletionTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export const isPositiveRevision = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const hasFiniteRevision = (value: unknown): value is number => Number.isFinite(value);

const isSessionFolder = (folder: unknown): folder is SessionFolder => (
  isObjectRecord(folder)
  && 'id' in folder && typeof folder.id === 'string'
  && 'name' in folder && typeof folder.name === 'string'
  && 'sessionIds' in folder && Array.isArray(folder.sessionIds)
  && folder.sessionIds.every(isSessionId)
  && 'createdAt' in folder && typeof folder.createdAt === 'number'
  && Number.isFinite(folder.createdAt)
  && (!('parentId' in folder) || folder.parentId === undefined || folder.parentId === null || typeof folder.parentId === 'string')
);

const isSessionFolderList = (value: unknown): value is SessionFolder[] => (
  Array.isArray(value) && value.every(isSessionFolder)
);

const isSessionFoldersMap = (foldersMap: unknown): foldersMap is SessionFoldersMap => (
  isObjectRecord(foldersMap)
  && Object.values(foldersMap).every(isSessionFolderList)
);

const isFolderTombstones = (tombstones: unknown): tombstones is FolderTombstones | undefined => (
  tombstones === undefined
  || (isObjectRecord(tombstones)
    && Object.values(tombstones).every(isDeletionTime))
);

export const isStoredFolderSnapshot = (snapshot: unknown): snapshot is StoredFolderSnapshot => (
  isObjectRecord(snapshot)
  && 'version' in snapshot && snapshot.version === 1
  && 'foldersMap' in snapshot && isSessionFoldersMap(snapshot.foldersMap)
  && 'collapsedFolderIds' in snapshot && Array.isArray(snapshot.collapsedFolderIds)
  && snapshot.collapsedFolderIds.every(isSessionId)
  && (!('deletedFolderIds' in snapshot) || isFolderTombstones(snapshot.deletedFolderIds))
);

const EMPTY_SNAPSHOT: FolderSnapshot = Object.freeze({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 });

const mergeTombstones = (current: FolderTombstones | undefined, incoming: FolderTombstones | undefined, now: number) => {
  const merged: FolderTombstones = {};
  for (const source of [current, incoming]) {
    if (source === undefined) continue;
    for (const [folderId, deletedAt] of Object.entries(source)) {
      if (now - deletedAt > TOMBSTONE_TTL_MS) continue;
      merged[folderId] = Math.max(merged[folderId] ?? 0, deletedAt);
    }
  }
  return merged;
};

const mergeSnapshots = (current: StoredFolderSnapshot, incoming: StoredFolderSnapshot, now: number): FolderSnapshot => {
  const deletedFolderIds = mergeTombstones(current.deletedFolderIds, incoming.deletedFolderIds, now);
  const currentMap = current.foldersMap;
  const incomingMap = incoming.foldersMap;
  const mergedScopes: SessionFoldersMap = {};
  for (const scope of new Set([...Object.keys(currentMap), ...Object.keys(incomingMap)])) {
    const currentFolders = currentMap[scope];
    const incomingFolders = incomingMap[scope];
    if (!Array.isArray(incomingFolders) || incomingFolders.length === 0) {
      if (Array.isArray(currentFolders) && currentFolders.length > 0) {
        mergedScopes[scope] = currentFolders;
      }
      continue;
    }
    if (!Array.isArray(currentFolders) || currentFolders.length === 0) {
      mergedScopes[scope] = incomingFolders;
      continue;
    }
    const foldersById = new Map(currentFolders.map((folder) => [folder.id, folder]));
    const idByName = new Map(currentFolders.map((folder) => [folder.name.toLowerCase(), folder.id]));
    for (const folder of incomingFolders) {
      const twinId = idByName.get(folder.name.toLowerCase());
      const twin = twinId !== undefined && twinId !== folder.id ? foldersById.get(twinId) : undefined;
      if (twinId !== undefined && twin !== undefined) {
        foldersById.delete(twinId);
        foldersById.set(folder.id, {
          ...folder,
          sessionIds: [...new Set([...twin.sessionIds, ...folder.sessionIds])],
        });
        continue;
      }
      foldersById.set(folder.id, folder);
    }
    mergedScopes[scope] = [...foldersById.values()];
  }
  for (const [scope, folders] of Object.entries(mergedScopes)) {
    const kept = folders.filter((folder) => deletedFolderIds[folder.id] === undefined);
    if (kept.length > 0) {
      mergedScopes[scope] = kept;
    } else {
      delete mergedScopes[scope];
    }
  }
  const incomingFolderIds = new Set(
    Object.values(incomingMap).flatMap((folders) => folders.map((folder) => folder.id)),
  );
  const incomingCollapsed = incoming.collapsedFolderIds;
  const currentCollapsed = current.collapsedFolderIds;
  const collapsedFolderIds = [
    ...new Set([
      ...incomingCollapsed,
      ...currentCollapsed.filter((folderId) => !incomingFolderIds.has(folderId)),
    ]),
  ].filter((folderId) => deletedFolderIds[folderId] === undefined);
  const updatedAt = Math.max(
    hasFiniteRevision(current.updatedAt) ? current.updatedAt : 0,
    hasFiniteRevision(incoming.updatedAt) ? incoming.updatedAt : 0,
  );
  return { version: 1, foldersMap: mergedScopes, collapsedFolderIds, deletedFolderIds, updatedAt };
};

const isMissingFileError = (error: unknown): error is { code: 'ENOENT' } => (
  error !== null
  && (typeof error === 'object' || typeof error === 'function')
  && 'code' in error
  && error.code === 'ENOENT'
);

export const createSessionFoldersStore = (dependencies: SessionFoldersDependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
    onChanged = () => {},
    now = Date.now,
  } = dependencies;

  const filePath = path.join(openchamberDataDir, 'sessions-directories.json');
  let saveQueue = Promise.resolve();

  const ensureDir = async () => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  };

  const readCurrentNullable = async () => {
    const currentRaw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (!currentRaw) return EMPTY_SNAPSHOT;
    try {
      const parsed: unknown = JSON.parse(currentRaw);
      return isStoredFolderSnapshot(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const writeSnapshot = async (snapshot: StoredFolderSnapshot) => {
    let tmp: string | undefined;
    try {
      await ensureDir();
      tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await fsPromises.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      if (tmp) await fsPromises.unlink(tmp).catch(() => {});
      throw error;
    }
  };

  const serialize = <T,>(task: () => Promise<T>) => {
    const pending = saveQueue.then(task, task);
    saveQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const announce = (updatedAt: number) => {
    try {
      onChanged(updatedAt);
    } catch {
      return;
    }
  };

  const readSnapshot = async (): Promise<(StoredFolderSnapshot & { exists: true }) | { version: 1; exists: false }> => {
    const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (isMissingFileError(error)) return null;
      throw error;
    });
    if (!raw) {
      return { version: 1, exists: false };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new SessionFoldersError('Stored session folders are malformed', 500);
    }
    if (!isStoredFolderSnapshot(parsed) || !isPositiveRevision(parsed.updatedAt)) {
      throw new SessionFoldersError('Stored session folders have an invalid shape', 500);
    }
    return { ...parsed, exists: true };
  };

  const readCurrent = async (): Promise<StoredFolderSnapshot> => {
    const current = await readCurrentNullable();
    if (!current) throw new SessionFoldersError('Stored session folders are malformed', 500);
    return current;
  };

  const applyChanges = (changes: FolderChange[]) => serialize(async () => {
    const current = await readCurrentNullable();
    if (!current) throw new SessionFoldersError('Stored session folders are malformed', 500);
    const { snapshot, changed } = applyFolderChanges(current, changes, now());
    if (changed) {
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SESSION_FOLDERS_BODY_BYTES) {
        throw new SessionFoldersError('Session folders too large', 413);
      }
      await writeSnapshot(snapshot);
      announce(snapshot.updatedAt);
    }
    return { snapshot, changed, exists: changed || current !== EMPTY_SNAPSHOT };
  });

  const mutate = <T,>(
    plan: (current: StoredFolderSnapshot, timestamp: number) => { changes: FolderChange[]; value: T },
  ) => serialize(async () => {
    const current = await readCurrentNullable();
    if (!current) throw new SessionFoldersError('Stored session folders are malformed', 500);
    const timestamp = now();
    const { changes, value } = plan(current, timestamp);
    if (changes.length === 0) {
      return { snapshot: current, changed: false, value };
    }
    const { snapshot, changed } = applyFolderChanges(current, changes, timestamp);
    if (changed) {
      if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_SESSION_FOLDERS_BODY_BYTES) {
        throw new SessionFoldersError('Session folders too large', 413);
      }
      await writeSnapshot(snapshot);
      announce(snapshot.updatedAt);
    }
    return { snapshot, changed, value };
  });

  const mergeWholeCopy = (body: StoredFolderSnapshot) => serialize(async () => {
    const current = await readCurrentNullable() ?? EMPTY_SNAPSHOT;
    const merged = mergeSnapshots(current, body, now());
    const changed = JSON.stringify(merged.foldersMap) !== JSON.stringify(current.foldersMap ?? {});
    const outgoing = changed
      ? { ...merged, updatedAt: Math.max(merged.updatedAt, now(), (hasFiniteRevision(current.updatedAt) ? current.updatedAt : 0) + 1) }
      : merged;
    await writeSnapshot(outgoing);
    if (changed) announce(outgoing.updatedAt);
    return { snapshot: outgoing, changed };
  });

  return {
    now,
    readSnapshot,
    readCurrent,
    applyChanges,
    mutate,
    mergeWholeCopy,
  };
};

export type SessionFoldersStore = ReturnType<typeof createSessionFoldersStore>;
