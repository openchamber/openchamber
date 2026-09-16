import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { getDeferredSafeStorage, getSafeStorage } from './utils/safeStorage';
import { isVSCodeRuntime } from '@/lib/desktop';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { getSessionFolderIdentityKey, isArchivedFolderScope } from '@/lib/sessionFolderIdentity';

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

export type ArchivedFolderAssignment = {
  name: string;
  sessionIds: readonly string[];
};

interface SessionFoldersState {
  foldersMap: SessionFoldersMap;
  /** UI identity keys, encoded as scopeKey + NUL + folderId. */
  collapsedFolderIds: Set<string>;
}

interface SessionFoldersActions {
  getFoldersForScope: (scopeKey: string) => SessionFolder[];
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => SessionFolder;
  renameFolder: (scopeKey: string, folderId: string, name: string) => void;
  deleteFolder: (scopeKey: string, folderId: string) => void;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
  addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]) => void;
  reconcileArchivedFolders: (
    scopeKey: string,
    assignments: readonly ArchivedFolderAssignment[],
    knownSessionIds?: readonly string[],
  ) => void;
  removeSessionFromFolder: (scopeKey: string, sessionId: string) => void;
  removeSessionEverywhere: (runtimeKey: string, sessionId: string) => void;
  removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]) => void;
  toggleFolderCollapse: (scopeKey: string, folderId: string) => void;
  getSessionFolderId: (scopeKey: string, sessionId: string) => string | null;
  resetForRuntimeSwitch: (runtimeKey: string) => void;
}

type SessionFoldersStore = SessionFoldersState & SessionFoldersActions;

// --- Storage ---

const FOLDERS_STORAGE_KEY = 'oc.sessions.folders';
const COLLAPSED_STORAGE_KEY = 'oc.sessions.folderCollapse';
const STORAGE_INDEX_KEY = 'oc.sessions.folders.v2.index';
const SESSION_FOLDERS_API_PATH = '/api/session-folders';
const DISK_WRITE_DEBOUNCE_MS = 250;

const safeStorage = getDeferredSafeStorage();
const immediateSafeStorage = getSafeStorage();
let diskWriteTimer: ReturnType<typeof setTimeout> | null = null;
let diskHydrated = false;
let diskHydrationInFlight = false;
let persistFoldersTimer: ReturnType<typeof setTimeout> | undefined;
let persistCollapsedTimer: ReturnType<typeof setTimeout> | undefined;
let pendingFoldersMap: SessionFoldersMap | null = null;
let pendingCollapsedIds: Set<string> | null = null;
let pendingBrowserRuntimeKey: string | null = null;
let activeFolderRuntimeKey = getRuntimeKey();
let folderRuntimeGeneration = 0;
let folderMutationRevision = 0;
const lastDiskUpdatedAtByRuntime = new Map<string, number>();

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

const isVSCodeWebview = (): boolean => {
  if (typeof window === 'undefined') {
    return false;
  }

  if (isVSCodeRuntime()) {
    return true;
  }

  return (window as { __VSCODE_CONFIG__?: unknown }).__VSCODE_CONFIG__ !== undefined;
};

const schedulePersistToDisk = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): void => {
  if (typeof window === 'undefined') {
    return;
  }

  if (isVSCodeWebview()) {
    return;
  }

  if (diskWriteTimer) {
    clearTimeout(diskWriteTimer);
  }

  const foldersSnapshot = JSON.parse(JSON.stringify(foldersMap)) as SessionFoldersMap;
  const collapsedSnapshot = Array.from(collapsedFolderIds);
  const runtimeKey = activeFolderRuntimeKey;
  const generation = folderRuntimeGeneration;

  diskWriteTimer = setTimeout(() => {
    diskWriteTimer = null;
    if (runtimeKey !== getRuntimeKey() || generation !== folderRuntimeGeneration) return;
    const updatedAt = Math.max(Date.now(), (lastDiskUpdatedAtByRuntime.get(runtimeKey) ?? 0) + 1);
    lastDiskUpdatedAtByRuntime.set(runtimeKey, updatedAt);
    const payload = {
      version: 1,
      foldersMap: foldersSnapshot,
      collapsedFolderIds: collapsedSnapshot,
      updatedAt,
    };
    void runtimeFetch(SESSION_FOLDERS_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => { /* best-effort */ });
  }, DISK_WRITE_DEBOUNCE_MS);
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

const normalizePersistedCollapsed = (
  foldersMap: SessionFoldersMap,
  values: readonly string[],
): Set<string> => {
  const legacyMatches = new Map<string, string[]>();
  for (const [scopeKey, folders] of Object.entries(foldersMap)) {
    for (const folder of folders) {
      const key = getSessionFolderIdentityKey(scopeKey, folder.id);
      const matches = legacyMatches.get(folder.id) ?? [];
      matches.push(key);
      legacyMatches.set(folder.id, matches);
    }
  }

  const result = new Set<string>();
  for (const value of values) {
    if (value.includes('\u0000')) {
      // Keep scoped values even if their folder is not in this snapshot. A
      // later folder snapshot can make that UI state valid again.
      result.add(value);
      continue;
    }
    // Older snapshots stored bare ids. Migrate only an unambiguous id. An id
    // found in multiple scopes cannot safely be assigned by a global-id guess.
    const matches = legacyMatches.get(value) ?? [];
    if (matches.length === 1 && matches[0]) result.add(matches[0]);
  }
  return result;
};

const readPersistedCollapsed = (
  runtimeKey = activeFolderRuntimeKey,
  foldersMap: SessionFoldersMap = {},
): Set<string> => {
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
    return normalizePersistedCollapsed(
      foldersMap,
      parsed.filter((v): v is string => typeof v === 'string'),
    );
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

const persistState = (foldersMap: SessionFoldersMap, collapsedFolderIds: Set<string>): void => {
  folderMutationRevision += 1;
  persistFolders(foldersMap);
  persistCollapsed(collapsedFolderIds);
  schedulePersistToDisk(foldersMap, collapsedFolderIds);
};

const createFolderId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `folder_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

type NormalizedArchivedFolderAssignment = {
  name: string;
  sessionIds: string[];
};

const normalizeArchivedFolderAssignments = (
  assignments: readonly ArchivedFolderAssignment[],
): NormalizedArchivedFolderAssignment[] => {
  const byName = new Map<string, NormalizedArchivedFolderAssignment>();
  const assignedSessionIds = new Set<string>();

  for (const assignment of assignments) {
    const name = assignment.name.trim();
    if (!name) continue;
    const nameKey = name.toLowerCase();
    let normalized = byName.get(nameKey);
    if (!normalized) {
      normalized = { name, sessionIds: [] };
      byName.set(nameKey, normalized);
    }

    for (const sessionId of assignment.sessionIds) {
      const normalizedSessionId = sessionId.trim();
      if (!normalizedSessionId || assignedSessionIds.has(normalizedSessionId)) continue;
      assignedSessionIds.add(normalizedSessionId);
      normalized.sessionIds.push(normalizedSessionId);
    }
  }

  return [...byName.values()].filter((assignment) => assignment.sessionIds.length > 0);
};

const normalizeSessionIds = (sessionIds: readonly string[]): Set<string> => {
  const result = new Set<string>();
  for (const sessionId of sessionIds) {
    const normalizedSessionId = sessionId.trim();
    if (normalizedSessionId) result.add(normalizedSessionId);
  }
  return result;
};

const sessionIdsEqual = (left: readonly string[], right: readonly string[]): boolean => (
  left.length === right.length && left.every((sessionId, index) => sessionId === right[index])
);

const syncCollapsedAfterFolderCleanup = (
  scopeKey: string,
  prevFolders: SessionFolder[],
  nextFolders: SessionFolder[],
  collapsedFolderIds: Set<string>,
): Set<string> | null => {
  const nextFolderIds = new Set(nextFolders.map((folder) => folder.id));
  let nextCollapsed: Set<string> | null = null;

  for (const folder of prevFolders) {
    const collapseKey = getSessionFolderIdentityKey(scopeKey, folder.id);
    if (!nextFolderIds.has(folder.id) && collapsedFolderIds.has(collapseKey)) {
      if (!nextCollapsed) {
        nextCollapsed = new Set(collapsedFolderIds);
      }
      nextCollapsed.delete(collapseKey);
    }
  }

  return nextCollapsed;
};

// --- Store ---

const initialFoldersMap = readPersistedFolders();

export const useSessionFoldersStore = create<SessionFoldersStore>()(
  devtools(
    (set, get) => ({
      foldersMap: initialFoldersMap,
      collapsedFolderIds: readPersistedCollapsed(activeFolderRuntimeKey, initialFoldersMap),

      resetForRuntimeSwitch: (runtimeKey: string): void => {
        try { flushPendingBrowserPersistence(); } catch { /* deferred storage retains failed writes */ }
        activeFolderRuntimeKey = runtimeKey;
        folderRuntimeGeneration += 1;
        folderMutationRevision = 0;
        diskHydrated = false;
        diskHydrationInFlight = false;
        if (diskWriteTimer) clearTimeout(diskWriteTimer);
        diskWriteTimer = null;
        const nextFoldersMap = readPersistedFolders(runtimeKey);
        set({
          foldersMap: nextFoldersMap,
          collapsedFolderIds: readPersistedCollapsed(runtimeKey, nextFoldersMap),
        });
        queueMicrotask(() => void hydrateSessionFoldersFromDisk());
      },

      getFoldersForScope: (scopeKey: string): SessionFolder[] => {
        if (!scopeKey) return [];
        return get().foldersMap[scopeKey] ?? [];
      },

      createFolder: (scopeKey: string, name: string, parentId?: string | null): SessionFolder => {
        const trimmed = name.trim() || 'New folder';
        const folder: SessionFolder = {
          id: createFolderId(),
          name: trimmed,
          sessionIds: [],
          createdAt: Date.now(),
          parentId: parentId ?? null,
        };
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey] ?? [];
        const nextMap: SessionFoldersMap = {
          ...current,
          [scopeKey]: [...scopeFolders, folder],
        };
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
        return folder;
      },

      renameFolder: (scopeKey: string, folderId: string, name: string): void => {
        const trimmed = name.trim();
        if (!trimmed || !scopeKey) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;
        const nextFolders = scopeFolders.map((folder) =>
          folder.id === folderId ? { ...folder, name: trimmed } : folder,
        );
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
      },

      deleteFolder: (scopeKey: string, folderId: string): void => {
        if (!scopeKey) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;
        // Also delete all sub-folders of this folder
        const idsToDelete = new Set<string>([folderId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const f of scopeFolders) {
            if (f.parentId && idsToDelete.has(f.parentId) && !idsToDelete.has(f.id)) {
              idsToDelete.add(f.id);
              changed = true;
            }
          }
        }
        const nextFolders = scopeFolders.filter((folder) => !idsToDelete.has(folder.id));
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const collapsed = get().collapsedFolderIds;
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeKey, scopeFolders, nextFolders, collapsed);
        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? collapsed);
      },

      addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string): void => {
        if (!scopeKey || !folderId || !sessionId) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const targetFolder = scopeFolders.find((folder) => folder.id === folderId);
        if (!targetFolder) return;

        const sessionFolderCount = scopeFolders.reduce(
          (count, folder) => count + (folder.sessionIds.includes(sessionId) ? 1 : 0),
          0,
        );
        if (targetFolder.sessionIds.includes(sessionId) && sessionFolderCount === 1) {
          return;
        }

        // Remove session from any existing folder first, then add to target
        const nextFolders = scopeFolders.map((folder) => {
          const withoutSession = folder.sessionIds.filter((id) => id !== sessionId);
          if (folder.id === folderId) {
            return { ...folder, sessionIds: [...withoutSession, sessionId] };
          }
          if (withoutSession.length !== folder.sessionIds.length) {
            return { ...folder, sessionIds: withoutSession };
          }
          return folder;
        });

        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeKey, scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      addSessionsToFolder: (scopeKey: string, folderId: string, sessionIds: string[]): void => {
        if (!scopeKey || !folderId || sessionIds.length === 0) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const idSet = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0));
        if (idSet.size === 0) return;

        const targetFolder = scopeFolders.find((folder) => folder.id === folderId);
        if (!targetFolder) return;

        let changed = false;
        for (const folder of scopeFolders) {
          for (const id of idSet) {
            if (!folder.sessionIds.includes(id)) continue;
            if (folder.id !== folderId || !targetFolder.sessionIds.includes(id)) {
              changed = true;
              break;
            }
          }
          if (changed) break;
        }
        if (!changed) {
          for (const id of idSet) {
            if (!targetFolder.sessionIds.includes(id)) {
              changed = true;
              break;
            }
          }
        }
        if (!changed) return;

        const nextFolders = scopeFolders.map((folder) => {
          const withoutSessions = folder.sessionIds.filter((id) => !idSet.has(id));
          if (folder.id === folderId) {
            return { ...folder, sessionIds: [...withoutSessions, ...idSet] };
          }
          if (withoutSessions.length !== folder.sessionIds.length) {
            return { ...folder, sessionIds: withoutSessions };
          }
          return folder;
        });

        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeKey, scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      reconcileArchivedFolders: (
        scopeKey: string,
        assignments: readonly ArchivedFolderAssignment[],
        knownSessionIds: readonly string[] = [],
      ): void => {
        if (!isArchivedFolderScope(scopeKey)) return;

        const normalizedAssignments = normalizeArchivedFolderAssignments(assignments);
        const current = get().foldersMap;
        const existingFolders = current[scopeKey] ?? [];
        const knownIds = normalizeSessionIds(knownSessionIds);
        const sessionIdsToReconcile = new Set(knownIds);
        const targetAssignments: Array<{ folder: SessionFolder; sessionIds: Set<string> }> = [];
        const folderByName = new Map<string, SessionFolder>();

        for (const folder of existingFolders) {
          const name = folder.name.trim();
          if (name && !folderByName.has(name.toLowerCase())) {
            folderByName.set(name.toLowerCase(), folder);
          }
        }

        let foldersWereCreated = false;
        const nextFolders = [...existingFolders];
        for (const assignment of normalizedAssignments) {
          const assignmentSessionIds = normalizeSessionIds(assignment.sessionIds);
          if (assignmentSessionIds.size === 0) continue;
          for (const sessionId of assignmentSessionIds) sessionIdsToReconcile.add(sessionId);

          const nameKey = assignment.name.toLowerCase();
          let folder = folderByName.get(nameKey);
          if (!folder) {
            folder = {
              id: createFolderId(),
              name: assignment.name,
              sessionIds: [],
              createdAt: Date.now(),
              parentId: null,
            };
            folderByName.set(nameKey, folder);
            nextFolders.push(folder);
            foldersWereCreated = true;
          }
          targetAssignments.push({ folder, sessionIds: assignmentSessionIds });
        }

        const targetSessionIdsByFolder = new Map<SessionFolder, Set<string>>(
          targetAssignments.map(({ folder, sessionIds }) => [folder, sessionIds]),
        );
        let foldersChanged = foldersWereCreated;
        const reconciledFolders = nextFolders.map((folder) => {
          const targetSessionIds = targetSessionIdsByFolder.get(folder);
          const retainedSessionIds: string[] = [];
          const retainedTargetIds = new Set<string>();

          for (const sessionId of folder.sessionIds) {
            if (!sessionIdsToReconcile.has(sessionId)) {
              retainedSessionIds.push(sessionId);
              continue;
            }
            if (targetSessionIds?.has(sessionId) && !retainedTargetIds.has(sessionId)) {
              retainedSessionIds.push(sessionId);
              retainedTargetIds.add(sessionId);
            }
          }

          if (targetSessionIds) {
            for (const sessionId of targetSessionIds) {
              if (retainedTargetIds.has(sessionId)) continue;
              retainedSessionIds.push(sessionId);
              retainedTargetIds.add(sessionId);
            }
          }

          if (sessionIdsEqual(folder.sessionIds, retainedSessionIds)) return folder;
          foldersChanged = true;
          return { ...folder, sessionIds: retainedSessionIds };
        });

        if (!foldersChanged) return;
        const nextMap = { ...current, [scopeKey]: reconciledFolders };
        const collapsed = get().collapsedFolderIds;
        set({ foldersMap: nextMap });
        persistState(nextMap, collapsed);
      },

      removeSessionsFromFolders: (scopeKey: string, sessionIds: string[]): void => {
        if (!scopeKey || sessionIds.length === 0) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        const idSet = new Set(sessionIds.filter((id) => typeof id === 'string' && id.length > 0));
        if (idSet.size === 0) return;

        let changed = false;
        const nextFolders = scopeFolders.map((folder) => {
          const filtered = folder.sessionIds.filter((id) => !idSet.has(id));
          if (filtered.length !== folder.sessionIds.length) {
            changed = true;
            return { ...folder, sessionIds: filtered };
          }
          return folder;
        });

        if (!changed) return;
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeKey, scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      removeSessionFromFolder: (scopeKey: string, sessionId: string): void => {
        if (!scopeKey || !sessionId) return;
        const current = get().foldersMap;
        const scopeFolders = current[scopeKey];
        if (!scopeFolders) return;

        let changed = false;
        const nextFolders = scopeFolders.map((folder) => {
          const filtered = folder.sessionIds.filter((id) => id !== sessionId);
          if (filtered.length !== folder.sessionIds.length) {
            changed = true;
            return { ...folder, sessionIds: filtered };
          }
          return folder;
        });

        if (!changed) return;
        const nextMap: SessionFoldersMap = { ...current, [scopeKey]: nextFolders };
        const nextCollapsed = syncCollapsedAfterFolderCleanup(scopeKey, scopeFolders, nextFolders, get().collapsedFolderIds);

        set(nextCollapsed
          ? { foldersMap: nextMap, collapsedFolderIds: nextCollapsed }
          : { foldersMap: nextMap });
        persistState(nextMap, nextCollapsed ?? get().collapsedFolderIds);
      },

      removeSessionEverywhere: (runtimeKey: string, sessionId: string): void => {
        if (!runtimeKey || runtimeKey !== activeFolderRuntimeKey || runtimeKey !== getRuntimeKey() || !sessionId) return;
        const current = get().foldersMap;
        let nextMap: SessionFoldersMap | null = null;

        for (const [scopeKey, scopeFolders] of Object.entries(current)) {
          let scopeChanged = false;
          const nextFolders = scopeFolders.map((folder) => {
            const sessionIds = folder.sessionIds.filter((id) => id !== sessionId);
            if (sessionIds.length === folder.sessionIds.length) return folder;
            scopeChanged = true;
            return { ...folder, sessionIds };
          });
          if (!scopeChanged) continue;
          nextMap ??= { ...current };
          nextMap[scopeKey] = nextFolders;
        }

        if (!nextMap) return;
        set({ foldersMap: nextMap });
        persistState(nextMap, get().collapsedFolderIds);
      },

      toggleFolderCollapse: (scopeKey: string, folderId: string): void => {
        if (!scopeKey || !folderId) return;
        const collapsed = get().collapsedFolderIds;
        const collapseKey = getSessionFolderIdentityKey(scopeKey, folderId);
        const next = new Set(collapsed);
        if (next.has(collapseKey)) {
          next.delete(collapseKey);
        } else {
          next.add(collapseKey);
        }
        set({ collapsedFolderIds: next });
        persistState(get().foldersMap, next);
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
    }),
    { name: 'session-folders-store' },
  ),
);

const hydrateSessionFoldersFromDisk = async (): Promise<void> => {
  if (diskHydrated || diskHydrationInFlight || typeof window === 'undefined') {
    return;
  }

  if (isVSCodeWebview()) {
    diskHydrated = true;
    return;
  }

  diskHydrationInFlight = true;
  const runtimeKey = activeFolderRuntimeKey;
  const generation = folderRuntimeGeneration;
  const baselineMutationRevision = folderMutationRevision;
  let completed = false;

  try {
    const response = await runtimeFetch(SESSION_FOLDERS_API_PATH).catch(() => null);
    if (!response || !response.ok) {
      return;
    }

    const parsed = await response.json().catch(() => null) as {
      exists?: boolean;
      foldersMap?: SessionFoldersMap;
      collapsedFolderIds?: string[];
      updatedAt?: number;
    } | null;

    if (!parsed) {
      return;
    }

    if (parsed.exists === false) {
      completed = true;
      return;
    }

    const diskFolders = parsed.foldersMap && typeof parsed.foldersMap === 'object'
      ? parsed.foldersMap
      : {};
    const diskCollapsed = Array.isArray(parsed.collapsedFolderIds)
      ? normalizePersistedCollapsed(
        diskFolders,
        parsed.collapsedFolderIds.filter((value): value is string => typeof value === 'string'),
      )
      : new Set<string>();

    if (generation !== folderRuntimeGeneration || runtimeKey !== getRuntimeKey()) return;
    const browserUpdatedAt = readStorageIndex().runtimes.find((entry) => entry.runtimeKey === runtimeKey)?.updatedAt ?? 0;
    const diskUpdatedAt = typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0;
    if (diskUpdatedAt > 0) {
      lastDiskUpdatedAtByRuntime.set(runtimeKey, Math.max(lastDiskUpdatedAtByRuntime.get(runtimeKey) ?? 0, diskUpdatedAt));
    }
    const hasDiskAuthority = parsed.exists === true || diskUpdatedAt > 0;
    if (hasDiskAuthority && folderMutationRevision === baselineMutationRevision && diskUpdatedAt >= browserUpdatedAt) {
      useSessionFoldersStore.setState({ foldersMap: diskFolders, collapsedFolderIds: diskCollapsed });
      persistFolders(diskFolders);
      persistCollapsed(diskCollapsed);
    }
    completed = true;
  } catch {
    // ignored
  } finally {
    if (generation === folderRuntimeGeneration && runtimeKey === getRuntimeKey()) {
      diskHydrationInFlight = false;
      if (completed) diskHydrated = true;
    }
  }
};

const bootstrapSessionFoldersDiskHydration = (): void => {
  if (typeof window === 'undefined') {
    return;
  }

  void hydrateSessionFoldersFromDisk();
};

bootstrapSessionFoldersDiskHydration();
