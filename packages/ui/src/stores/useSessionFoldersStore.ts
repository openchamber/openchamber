import { z } from 'zod';
import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getDeferredSafeStorage, getSafeStorage } from './utils/safeStorage';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  applyFolderChange,
  applyFolderChanges,
  collectFolderSubtree,
  folderChangeSchema,
  folderSnapshotSchema,
  type FolderChange,
  type FolderSnapshot,
} from '@/lib/sessionFolders/folderChanges';

// --- Types ---

export interface SessionFolder {
  id: string;
  name: string;
  sessionIds: string[];
  createdAt: number;
  /** If set, this folder is a sub-folder of the parent folder with this id */
  parentId?: string | null;
}

export type SessionFoldersMap = Record<string, SessionFolder[]>;

interface SessionFoldersState {
  foldersMap: SessionFoldersMap;
  collapsedFolderIds: Set<string>;
}

interface SessionFoldersActions {
  getFoldersForScope: (scopeKey: string) => SessionFolder[];
  /** `id` fixes the folder's id, so every client creating the same folder makes one. */
  createFolder: (scopeKey: string, name: string, parentId?: string | null, id?: string) => SessionFolder;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  removeSessionEverywhere: (runtimeKey: string, sessionId: string) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  /** Drop every folder of these scopes, for a project that was closed. */
  forgetScopes: (scopeKeys: string[]) => void;
  toggleFolderCollapse: (folderId: string) => void;
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

type SessionFoldersStore = SessionFoldersState & SessionFoldersActions;

// --- Storage ---

// This device's copy of the server's folders, shown at once on the next start
// and while the server cannot be reached. The server's copy replaces it.
const FOLDERS_STORAGE_KEY = 'oc.sessions.folders';
// Which folders are collapsed belongs to this device only.
const COLLAPSED_STORAGE_KEY = 'oc.sessions.folderCollapse';
const STORAGE_INDEX_KEY = 'oc.sessions.folders.v2.index';
// Folder deletions an older version recorded and did not hand to the server.
const LEGACY_DELETED_STORAGE_KEY = 'oc.sessions.folderDeletions';
// Changes this device made that the server has not stored yet.
const PENDING_CHANGES_STORAGE_KEY = 'oc.sessions.folderChanges';
// Set once this device's own folders went to the server.
const SHARED_STORAGE_KEY = 'oc.sessions.foldersShared';
const SESSION_FOLDERS_API_PATH = '/api/session-folders';
const SERVER_WRITE_DEBOUNCE_MS = 150;
// The server takes at most 1,000 changes per request; a longer queue (after a
// long time offline) goes in several.
const MAX_CHANGES_PER_REQUEST = 500;
const MAX_RETRY_DELAY_MS = 30_000;

const safeStorage = getDeferredSafeStorage();
const immediateSafeStorage = getSafeStorage();
let persistFoldersTimer: ReturnType<typeof setTimeout> | undefined;
let persistCollapsedTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFoldersMap: SessionFoldersMap | null = null;
let pendingCollapsedIds: Set<string> | null = null;
let pendingBrowserRuntimeKey: string | null = null;
let activeFolderRuntimeKey = getRuntimeKey();
let folderRuntimeGeneration = 0;

type FolderStorageIndex = {
  version: 2;
  legacyClaimed: boolean;
  runtimes: Array<{ runtimeKey: string; updatedAt: number }>;
};

const runtimeStorageKey = (base: string, runtimeKey: string) => `${base}.v2:${encodeURIComponent(runtimeKey)}`;
const readStorageIndex = (): FolderStorageIndex => {
  try {
    const parsed = JSON.parse(safeStorage.getItem(STORAGE_INDEX_KEY) ?? '') as Partial<FolderStorageIndex>;
    return parsed.version === 2 && Array.isArray(parsed.runtimes)
      ? { version: 2, legacyClaimed: Boolean(parsed.legacyClaimed), runtimes: parsed.runtimes }
      : { version: 2, legacyClaimed: false, runtimes: [] };
  } catch {
    return { version: 2, legacyClaimed: false, runtimes: [] };
  }
};

const touchRuntimeStorage = (runtimeKey: string, updatedAt = Date.now(), targetStorage: Storage = safeStorage): void => {
  const index = readStorageIndex();
  const runtimes = [
    { runtimeKey, updatedAt },
    ...index.runtimes.filter((entry) => entry.runtimeKey !== runtimeKey),
  ];
  targetStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify({ version: 2, legacyClaimed: index.legacyClaimed, runtimes }));
};

const claimLegacyStorage = (runtimeKey: string): void => {
  const index = readStorageIndex();
  if (index.legacyClaimed) return;
  const legacyFolders = safeStorage.getItem(FOLDERS_STORAGE_KEY);
  const legacyCollapsed = safeStorage.getItem(COLLAPSED_STORAGE_KEY);
  if (legacyFolders) safeStorage.setItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey), legacyFolders);
  if (legacyCollapsed) safeStorage.setItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey), legacyCollapsed);
  const next = { ...index, legacyClaimed: true };
  safeStorage.setItem(STORAGE_INDEX_KEY, JSON.stringify(next));
  if (safeStorage.getItem(STORAGE_INDEX_KEY) === JSON.stringify(next)) {
    safeStorage.removeItem(FOLDERS_STORAGE_KEY);
    safeStorage.removeItem(COLLAPSED_STORAGE_KEY);
  }
  touchRuntimeStorage(runtimeKey, 0);
};

const folderTombstonesSchema = z.record(z.string(), z.number().finite());
type FolderTombstones = z.infer<typeof folderTombstonesSchema>;

// Malformed tombstones are treated as none: they can only ever remove folders.
const readLegacyDeletions = (runtimeKey: string): FolderTombstones => {
  try {
    const result = folderTombstonesSchema.safeParse(
      JSON.parse(immediateSafeStorage.getItem(runtimeStorageKey(LEGACY_DELETED_STORAGE_KEY, runtimeKey)) ?? '{}'),
    );
    return result.success ? result.data : {};
  } catch {
    return {};
  }
};

// Unreadable entries are dropped one by one; the rest still reach the server.
const readPendingChanges = (runtimeKey: string): FolderChange[] => {
  try {
    const parsed: unknown = JSON.parse(immediateSafeStorage.getItem(runtimeStorageKey(PENDING_CHANGES_STORAGE_KEY, runtimeKey)) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const result = folderChangeSchema.safeParse(entry);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
};

// Written at once, not deferred: a reload right after a change must still send it.
const writePendingChanges = (runtimeKey: string, changes: readonly FolderChange[]): void => {
  const key = runtimeStorageKey(PENDING_CHANGES_STORAGE_KEY, runtimeKey);
  try {
    if (changes.length === 0) immediateSafeStorage.removeItem(key);
    else immediateSafeStorage.setItem(key, JSON.stringify(changes));
  } catch {
    // The change stays queued in memory for this session.
  }
};

const isFolderSharingDone = (runtimeKey: string): boolean => (
  immediateSafeStorage.getItem(runtimeStorageKey(SHARED_STORAGE_KEY, runtimeKey)) === '1'
);

const markFolderSharingDone = (runtimeKey: string): void => {
  immediateSafeStorage.setItem(runtimeStorageKey(SHARED_STORAGE_KEY, runtimeKey), '1');
  immediateSafeStorage.removeItem(runtimeStorageKey(LEGACY_DELETED_STORAGE_KEY, runtimeKey));
};

const isVSCodeWebview = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  if (isVSCodeRuntime()) {
    return true;
  }

  return (window as { __VSCODE_CONFIG__?: unknown }).__VSCODE_CONFIG__ !== undefined;
};

const readPersistedFolders = (runtimeKey = activeFolderRuntimeKey): SessionFoldersMap => {
  try {
    claimLegacyStorage(runtimeKey);
    const raw = safeStorage.getItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const result: SessionFoldersMap = {};
    for (const [scopeKey, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) {
        continue;
      }
      const folders: SessionFolder[] = [];
      for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const candidate = entry as Record<string, unknown>;
        const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        const createdAt = typeof candidate.createdAt === 'number' ? candidate.createdAt : 0;
        if (!id || !name) continue;
        const sessionIds = Array.isArray(candidate.sessionIds)
          ? (candidate.sessionIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
          : [];
        const parentId = typeof candidate.parentId === 'string' ? candidate.parentId : null;
        folders.push({ id, name, sessionIds, createdAt, parentId });
      }
      if (folders.length > 0) {
        result[scopeKey] = folders;
      }
    }
    return result;
  } catch {
    return {};
  }
};

const readPersistedCollapsed = (runtimeKey = activeFolderRuntimeKey): Set<string> => {
  try {
    claimLegacyStorage(runtimeKey);
    const raw = safeStorage.getItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((v): v is string => typeof v === 'string'));
  } catch {
    return new Set();
  }
};

const persistFolders = (foldersMap: SessionFoldersMap): void => {
  pendingFoldersMap = foldersMap;
  pendingBrowserRuntimeKey = activeFolderRuntimeKey;
  clearTimeout(persistFoldersTimer);
  persistFoldersTimer = setTimeout(() => {
    try {
      const runtimeKey = pendingBrowserRuntimeKey ?? activeFolderRuntimeKey;
      safeStorage.setItem(runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey), JSON.stringify(foldersMap));
      touchRuntimeStorage(runtimeKey);
      pendingFoldersMap = null;
    } catch {
      // ignored
    }
  }, 300);
};

const persistCollapsed = (collapsedFolderIds: Set<string>): void => {
  pendingCollapsedIds = collapsedFolderIds;
  pendingBrowserRuntimeKey = activeFolderRuntimeKey;
  clearTimeout(persistCollapsedTimer);
  persistCollapsedTimer = setTimeout(() => {
    try {
      const runtimeKey = pendingBrowserRuntimeKey ?? activeFolderRuntimeKey;
      safeStorage.setItem(runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey), JSON.stringify(Array.from(collapsedFolderIds)));
      touchRuntimeStorage(runtimeKey);
      pendingCollapsedIds = null;
    } catch {
      // ignored
    }
  }, 300);
};

const flushPendingBrowserPersistence = (): void => {
  if (persistFoldersTimer) clearTimeout(persistFoldersTimer);
  if (persistCollapsedTimer) clearTimeout(persistCollapsedTimer);
  persistFoldersTimer = undefined;
  persistCollapsedTimer = undefined;

  const runtimeKey = pendingBrowserRuntimeKey ?? activeFolderRuntimeKey;
  let wrote = false;
  if (pendingFoldersMap !== null) {
    const key = runtimeStorageKey(FOLDERS_STORAGE_KEY, runtimeKey);
    const value = JSON.stringify(pendingFoldersMap);
    safeStorage.setItem(key, value);
    immediateSafeStorage.setItem(key, value);
    pendingFoldersMap = null;
    wrote = true;
  }
  if (pendingCollapsedIds !== null) {
    const key = runtimeStorageKey(COLLAPSED_STORAGE_KEY, runtimeKey);
    const value = JSON.stringify(Array.from(pendingCollapsedIds));
    safeStorage.setItem(key, value);
    immediateSafeStorage.setItem(key, value);
    pendingCollapsedIds = null;
    wrote = true;
  }
  if (wrote) {
    const updatedAt = Date.now();
    touchRuntimeStorage(runtimeKey, updatedAt);
    touchRuntimeStorage(runtimeKey, updatedAt, immediateSafeStorage);
  }
  pendingBrowserRuntimeKey = null;
};

if (typeof window !== 'undefined') {
  const flushPending = () => {
    try { flushPendingBrowserPersistence(); } catch { /* ignored */ }
  };
  window.addEventListener('pagehide', flushPending, { capture: true });
  window.addEventListener('beforeunload', flushPending, { capture: true });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushPending();
    });
    document.addEventListener('freeze', flushPending);
  }
}

const createFolderId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

/** Collapse marks of folders that no longer exist, dropped; null when none was. */
const pruneCollapsed = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): Set<string> | null => {
  if (collapsedFolderIds.size === 0) return null;
  const known = new Set(Object.values(foldersMap).flatMap((folders) => folders.map((folder) => folder.id)));
  let next: Set<string> | null = null;
  for (const folderId of collapsedFolderIds) {
    if (known.has(folderId)) continue;
    next ??= new Set(collapsedFolderIds);
    next.delete(folderId);
  }
  return next;
};

// --- Server sync ---
//
// The server stores the folders and is the authority; this copy is the
// server's last answer with this device's not-yet-stored changes laid over it.

/** The server's answer, or why there is none. `legacy` is a server from before shared folders. */
type ServerResult =
  | { kind: 'snapshot'; snapshot: FolderSnapshot }
  | { kind: 'legacy' }
  | { kind: 'rejected' }
  | { kind: 'failed' };

const readServerResult = async (request: Promise<Response>): Promise<ServerResult> => {
  const response = await request.catch(() => null);
  if (!response) return { kind: 'failed' };
  if (response.status === 404 || response.status === 405) return { kind: 'legacy' };
  if (response.status === 400 || response.status === 413) return { kind: 'rejected' };
  if (!response.ok) return { kind: 'failed' };
  const body: unknown = await response.json().catch(() => null);
  const parsed = folderSnapshotSchema.safeParse(body);
  return parsed.success ? { kind: 'snapshot', snapshot: parsed.data } : { kind: 'failed' };
};

const sendChanges = (changes: readonly unknown[]): Promise<ServerResult> => readServerResult(runtimeFetch(SESSION_FOLDERS_API_PATH, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ changes }),
}));

/** The whole-copy write a server from before shared folders understands; it merges the copy in. */
const sendLegacySnapshot = async (foldersMap: SessionFoldersMap, deletedFolderIds: FolderTombstones): Promise<boolean> => {
  const response = await runtimeFetch(SESSION_FOLDERS_API_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: 1,
      foldersMap,
      collapsedFolderIds: Array.from(useSessionFoldersStore.getState().collapsedFolderIds),
      deletedFolderIds,
      updatedAt: Date.now(),
    }),
  }).catch(() => null);
  return Boolean(response?.ok);
};

let pendingChanges: FolderChange[] = readPendingChanges(activeFolderRuntimeKey);
let inflightChanges: readonly FolderChange[] = [];
let serverRevision = 0;
let serverHydrated = false;
let hydrationInFlight = false;
let legacyServer = false;
let refreshInFlight = false;
let refreshAgain = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

const isServerSyncAvailable = (): boolean => typeof window !== 'undefined' && !isVSCodeWebview();

const isCurrent = (runtimeKey: string, generation: number): boolean => (
  runtimeKey === activeFolderRuntimeKey && generation === folderRuntimeGeneration && runtimeKey === getRuntimeKey()
);

/** Show the server's copy with this device's pending changes on top. Older answers than the last one are ignored. */
const adoptServerSnapshot = (snapshot: FolderSnapshot): void => {
  if (snapshot.updatedAt < serverRevision) return;
  serverRevision = snapshot.updatedAt;
  const next = applyFolderChanges(snapshot.foldersMap, [...inflightChanges, ...pendingChanges]);
  const state = useSessionFoldersStore.getState();
  // An unchanged answer keeps the current references, so nothing re-renders.
  if (JSON.stringify(next) === JSON.stringify(state.foldersMap)) return;
  const nextCollapsed = pruneCollapsed(next, state.collapsedFolderIds);
  useSessionFoldersStore.setState(nextCollapsed ? { foldersMap: next, collapsedFolderIds: nextCollapsed } : { foldersMap: next });
  persistFolders(next);
  if (nextCollapsed) persistCollapsed(nextCollapsed);
};

const clearTimers = (): void => {
  if (flushTimer) clearTimeout(flushTimer);
  if (retryTimer) clearTimeout(retryTimer);
  flushTimer = null;
  retryTimer = null;
};

const scheduleRetry = (): void => {
  if (retryTimer) return;
  // Offline, the reconnecting event stream sends the changes once it is back.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
  const delay = Math.min(1_000 * 2 ** retryAttempt, MAX_RETRY_DELAY_MS);
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (serverHydrated) void flushChanges();
    else void hydrateFromServer();
  }, delay);
};

const scheduleFlush = (): void => {
  if (!serverHydrated || flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushChanges();
  }, SERVER_WRITE_DEBOUNCE_MS);
};

const enqueueChange = (change: FolderChange): void => {
  if (!isServerSyncAvailable()) return;
  pendingChanges = [...pendingChanges, change];
  writePendingChanges(activeFolderRuntimeKey, pendingChanges);
  scheduleFlush();
};

const flushChanges = async (): Promise<void> => {
  if (!serverHydrated || inflightChanges.length > 0 || pendingChanges.length === 0) return;
  const runtimeKey = activeFolderRuntimeKey;
  const generation = folderRuntimeGeneration;
  // The whole-copy write carries every change at once.
  const batch = legacyServer ? pendingChanges : pendingChanges.slice(0, MAX_CHANGES_PER_REQUEST);
  inflightChanges = batch;

  const settle = (stored: boolean): void => {
    inflightChanges = [];
    if (!stored) return;
    // Changes queued while this batch was on its way stay pending.
    pendingChanges = pendingChanges.slice(batch.length);
    writePendingChanges(runtimeKey, pendingChanges);
    retryAttempt = 0;
  };

  if (legacyServer) {
    const deletedFolderIds: FolderTombstones = {};
    for (const change of batch) {
      if (change.type === 'delete') for (const folderId of change.folderIds) deletedFolderIds[folderId] = Date.now();
    }
    const stored = await sendLegacySnapshot(useSessionFoldersStore.getState().foldersMap, deletedFolderIds);
    if (!isCurrent(runtimeKey, generation)) return;
    settle(stored);
    if (!stored) scheduleRetry();
    else if (pendingChanges.length > 0) scheduleFlush();
    return;
  }

  const result = await sendChanges(batch);
  if (!isCurrent(runtimeKey, generation)) return;
  switch (result.kind) {
    case 'snapshot':
      settle(true);
      adoptServerSnapshot(result.snapshot);
      if (pendingChanges.length > 0) scheduleFlush();
      return;
    case 'legacy':
      inflightChanges = [];
      legacyServer = true;
      void flushChanges();
      return;
    case 'rejected':
      // The server cannot store these changes; show what it has instead.
      settle(true);
      void refreshFromServer();
      if (pendingChanges.length > 0) scheduleFlush();
      return;
    case 'failed':
      settle(false);
      scheduleRetry();
  }
};

/** Read the server's folders again and show them. A failed read keeps what is shown. */
const refreshFromServer = async (): Promise<void> => {
  if (!serverHydrated) {
    await hydrateFromServer();
    return;
  }
  if (refreshInFlight) {
    refreshAgain = true;
    return;
  }
  const runtimeKey = activeFolderRuntimeKey;
  const generation = folderRuntimeGeneration;
  refreshInFlight = true;
  try {
    do {
      refreshAgain = false;
      const result = await readServerResult(runtimeFetch(SESSION_FOLDERS_API_PATH));
      if (!isCurrent(runtimeKey, generation)) return;
      if (result.kind === 'snapshot') adoptServerSnapshot(result.snapshot);
    } while (refreshAgain);
  } finally {
    if (isCurrent(runtimeKey, generation)) refreshInFlight = false;
  }
};

/**
 * First contact with this server: once per server, this device's own folders
 * from the time each device kept its own go to the server, which merges them
 * in; then the server's folders replace the local copy. Until that succeeds
 * the local copy stays as it is and changes wait.
 */
const hydrateFromServer = async (): Promise<void> => {
  if (!isServerSyncAvailable() || serverHydrated || hydrationInFlight) return;
  const runtimeKey = activeFolderRuntimeKey;
  const generation = folderRuntimeGeneration;
  hydrationInFlight = true;
  try {
    if (!isFolderSharingDone(runtimeKey)) {
      const localFolders = useSessionFoldersStore.getState().foldersMap;
      const localDeletions = readLegacyDeletions(runtimeKey);
      // Folders made, renamed, filed or deleted before this first contact are
      // already in the copy the import sends, deletions as tombstones. Sent
      // again as changes, a new folder the server joins by name would come
      // back as a second one under its local id, taking the chats with it.
      const importedAt = Date.now();
      for (const change of pendingChanges) {
        if (change.type === 'delete') for (const folderId of change.folderIds) localDeletions[folderId] = importedAt;
      }
      const coveredByImport = new Set<FolderChange>(pendingChanges.filter((change) => (
        change.type === 'create' || change.type === 'rename' || change.type === 'assign' || change.type === 'delete'
      )));
      const hasLocal = Object.values(localFolders).some((folders) => folders.length > 0) || Object.keys(localDeletions).length > 0;
      const dropCoveredChanges = (): void => {
        if (coveredByImport.size === 0) return;
        pendingChanges = pendingChanges.filter((change) => !coveredByImport.has(change));
        writePendingChanges(runtimeKey, pendingChanges);
      };
      if (hasLocal) {
        const result = await sendChanges([{ type: 'import', foldersMap: localFolders, deletedFolderIds: localDeletions }]);
        if (!isCurrent(runtimeKey, generation)) return;
        if (result.kind === 'legacy') {
          legacyServer = true;
          const stored = await sendLegacySnapshot(localFolders, localDeletions);
          if (!isCurrent(runtimeKey, generation)) return;
          if (!stored) {
            scheduleRetry();
            return;
          }
        } else if (result.kind !== 'snapshot') {
          // A rejected import would never pass; the folders stay on this device.
          if (result.kind === 'failed') scheduleRetry();
          return;
        }
      }
      dropCoveredChanges();
      markFolderSharingDone(runtimeKey);
    }

    const result = await readServerResult(runtimeFetch(SESSION_FOLDERS_API_PATH));
    if (!isCurrent(runtimeKey, generation)) return;
    if (result.kind !== 'snapshot') {
      scheduleRetry();
      return;
    }
    // A missing file on a server that stores shared folders is an empty
    // folder list: this device's folders are already on it.
    adoptServerSnapshot(result.snapshot);
    serverHydrated = true;
    retryAttempt = 0;
    scheduleFlush();
  } finally {
    if (isCurrent(runtimeKey, generation)) hydrationInFlight = false;
  }
};

/** Another client changed the folders; read them unless this answer is already shown. */
export const handleSessionFoldersChanged = (updatedAt: number): void => {
  if (!isServerSyncAvailable()) return;
  if (serverHydrated && updatedAt <= serverRevision) return;
  void refreshFromServer();
};

/** The event stream (re)connected: anything may have changed meanwhile, and waiting changes can go now. */
export const handleSessionFoldersStreamReady = (): void => {
  if (!isServerSyncAvailable()) return;
  if (!serverHydrated) {
    void hydrateFromServer();
    return;
  }
  void refreshFromServer();
  void flushChanges();
};

// --- Store ---

export const useSessionFoldersStore = create<SessionFoldersStore>()(
  devtools(
    (set, get) => {
      /** Apply a change here and queue it for the server; a change with no effect does neither. */
      const commit = (change: FolderChange): void => {
        const current = get().foldersMap;
        const next = applyFolderChange(current, change);
        if (next === current) return;
        const nextCollapsed = pruneCollapsed(next, get().collapsedFolderIds);
        set(nextCollapsed ? { foldersMap: next, collapsedFolderIds: nextCollapsed } : { foldersMap: next });
        persistFolders(next);
        if (nextCollapsed) persistCollapsed(nextCollapsed);
        enqueueChange(change);
      };

      return {
        foldersMap: readPersistedFolders(),
        collapsedFolderIds: readPersistedCollapsed(),

        resetForRuntimeSwitch: (runtimeKey: string): void => {
          try { flushPendingBrowserPersistence(); } catch { /* deferred storage retains failed writes */ }
          activeFolderRuntimeKey = runtimeKey;
          folderRuntimeGeneration += 1;
          clearTimers();
          // Changes still on their way to the old server stay queued for it.
          pendingChanges = readPendingChanges(runtimeKey);
          inflightChanges = [];
          serverRevision = 0;
          serverHydrated = false;
          hydrationInFlight = false;
          legacyServer = false;
          refreshInFlight = false;
          refreshAgain = false;
          retryAttempt = 0;
          set({
            foldersMap: readPersistedFolders(runtimeKey),
            collapsedFolderIds: readPersistedCollapsed(runtimeKey),
          });
          queueMicrotask(() => void hydrateFromServer());
        },

        getFoldersForScope: (scopeKey: string): SessionFolder[] => {
          if (!scopeKey) return [];
          return get().foldersMap[scopeKey] ?? [];
        },

        createFolder: (scopeKey: string, name: string, parentId?: string | null, id?: string): SessionFolder => {
          const folder: SessionFolder = {
            id: id ?? createFolderId(),
            name: name.trim() || 'New folder',
            sessionIds: [],
            createdAt: Date.now(),
            parentId: parentId ?? null,
          };
          const existing = get().foldersMap[scopeKey]?.find((entry) => entry.id === folder.id);
          if (existing) return existing;
          commit({ type: 'create', scopeKey, folder: { id: folder.id, name: folder.name, parentId: folder.parentId ?? null, createdAt: folder.createdAt } });
          return folder;
        },

        renameFolder: (scopeKey: string, folderId: string, name: string): void => {
          const trimmed = name.trim();
          if (!trimmed || !scopeKey) return;
          commit({ type: 'rename', scopeKey, folderId, name: trimmed });
        },

        deleteFolder: (scopeKey: string, folderId: string): void => {
          const scopeFolders = scopeKey ? get().foldersMap[scopeKey] : undefined;
          if (!scopeFolders) return;
          // Sub-folders go with their folder; naming them lets the server do the same even if they moved.
          commit({ type: 'delete', scopeKey, folderIds: Array.from(collectFolderSubtree(scopeFolders, folderId)) });
        },

        addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string): void => {
          if (!scopeKey || !folderId || !sessionId) return;
          commit({ type: 'assign', scopeKey, folderId, sessionIds: [sessionId] });
        },

        addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]): void => {
          const ids = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0)));
          if (!scopeKey || !folderId || ids.length === 0) return;
          commit({ type: 'assign', scopeKey, folderId, sessionIds: ids });
        },

        removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]): void => {
          const ids = Array.from(new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0)));
          if (!scopeKey || ids.length === 0) return;
          commit({ type: 'unassign', scopeKey, sessionIds: ids });
        },

        removeSessionFromFolder: (scopeKey: string, sessionId: string): void => {
          if (!scopeKey || !sessionId) return;
          commit({ type: 'unassign', scopeKey, sessionIds: [sessionId] });
        },

        removeSessionEverywhere: (runtimeKey: string, sessionId: string): void => {
          if (!runtimeKey || runtimeKey !== activeFolderRuntimeKey || runtimeKey !== getRuntimeKey() || !sessionId) return;
          commit({ type: 'forget-sessions', sessionIds: [sessionId] });
        },

        forgetScopes: (scopeKeys: string[]): void => {
          const keys = scopeKeys.filter((scopeKey) => scopeKey.length > 0);
          if (keys.length === 0) return;
          commit({ type: 'forget-scopes', scopeKeys: keys });
        },

        toggleFolderCollapse: (folderId: string): void => {
          const next = new Set(get().collapsedFolderIds);
          if (next.has(folderId)) {
            next.delete(folderId);
          } else {
            next.add(folderId);
          }
          set({ collapsedFolderIds: next });
          persistCollapsed(next);
        },

        getSessionFolderId: (scopeKey: string, sessionId: string): string | null => {
          if (!scopeKey || !sessionId) return null;
          const scopeFolders = get().foldersMap[scopeKey];
          if (!scopeFolders) return null;
          for (const folder of scopeFolders) {
            if (folder.sessionIds.includes(sessionId)) {
              return folder.id;
            }
          }
          return null;
        },
      };
    },
    { name: 'session-folders-store' },
  ),
);

void hydrateFromServer();
