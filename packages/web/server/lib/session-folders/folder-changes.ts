import { z } from 'zod';
import type { FolderChange, FolderChangesResult, FolderTombstones, SessionFolder, SessionFoldersMap, StoredFolderSnapshot } from './contracts.js';

const id = z.string().trim().min(1).max(32_768);
const ids = z.array(id).max(10_000);
const name = z.string().trim().min(1).max(10_000);
const chatPlacement = z.record(z.string(), id.nullable());

const folderSchema = z.object({
  id: z.string(),
  name: z.string(),
  sessionIds: z.array(z.string()),
  createdAt: z.number().finite(),
  parentId: z.string().nullable().optional(),
});

const folderChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create'),
    scopeKey: id,
    folder: z.object({ id, name, parentId: id.nullable(), createdAt: z.number().finite() }),
  }),
  z.object({ type: z.literal('rename'), scopeKey: id, folderId: id, name }),
  z.object({ type: z.literal('delete'), scopeKey: id, folderIds: ids.min(1) }),
  z.object({ type: z.literal('assign'), scopeKey: id, folderId: id, sessionIds: ids.min(1), from: chatPlacement.optional() }),
  z.object({ type: z.literal('unassign'), scopeKey: id, sessionIds: ids.min(1), from: chatPlacement.optional() }),
  z.object({ type: z.literal('forget-sessions'), sessionIds: ids.min(1) }),
  z.object({ type: z.literal('forget-scopes'), scopeKeys: ids.min(1) }),
  z.object({
    type: z.literal('import'),
    foldersMap: z.record(z.string(), z.array(folderSchema)),
    deletedFolderIds: z.record(z.string(), z.number().finite()).optional(),
  }),
]);

export const folderChangesBodySchema = z.object({ changes: z.array(folderChangeSchema).min(1).max(1_000) });

export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sameName = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

const withoutSessions = (folders: SessionFolder[], sessionIds: Set<string>) => {
  let changed = false;
  const next = folders.map((folder) => {
    const kept = folder.sessionIds.filter((sessionId) => !sessionIds.has(sessionId));
    if (kept.length === folder.sessionIds.length) return folder;
    changed = true;
    return { ...folder, sessionIds: kept };
  });
  return changed ? next : folders;
};

const folderHolding = (folders: SessionFolder[], sessionId: string) => (
  folders.find((folder) => folder.sessionIds.includes(sessionId))?.id ?? null
);

const chatsStillInPlace = (folders: SessionFolder[], sessionIds: string[], from: Record<string, string | null> | undefined) => (
  sessionIds.filter((sessionId) => {
    const expected = from?.[sessionId];
    if (expected === undefined) return true;
    const holding = folderHolding(folders, sessionId);
    return holding === expected || (holding === null && !folders.some((folder) => folder.id === expected));
  })
);

const descendantIds = (folders: SessionFolder[], rootIds: string[]) => {
  const result = new Set(rootIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        grew = true;
      }
    }
  }
  return result;
};

const importFolders = (foldersMap: SessionFoldersMap, deletedFolderIds: FolderTombstones, incomingMap: SessionFoldersMap, incomingDeletions: FolderTombstones | undefined, now: number) => {
  for (const [folderId, deletedAt] of Object.entries(incomingDeletions ?? {})) {
    if (now - deletedAt > TOMBSTONE_TTL_MS) continue;
    deletedFolderIds[folderId] = Math.max(deletedFolderIds[folderId] ?? 0, deletedAt);
  }
  for (const [scopeKey, incomingFolders] of Object.entries(incomingMap)) {
    const folders = [...(foldersMap[scopeKey] ?? [])].filter((folder) => deletedFolderIds[folder.id] === undefined);
    const filed = new Set(folders.flatMap((folder) => folder.sessionIds));
    const idMap = new Map<string, string>();
    const pending = incomingFolders.filter((folder) => deletedFolderIds[folder.id] === undefined && folder.id && folder.name.trim());
    const incomingIds = new Set(pending.map((folder) => folder.id));
    while (pending.length > 0) {
      const index = Math.max(0, pending.findIndex((folder) => !folder.parentId || !incomingIds.has(folder.parentId) || idMap.has(folder.parentId)));
      const folder = pending.splice(index, 1)[0];
      if (folder === undefined) throw new Error('Pending folder is missing');
      let parentId: string | null = null;
      const mappedParentId = folder.parentId ? idMap.get(folder.parentId) : undefined;
      if (mappedParentId !== undefined) parentId = mappedParentId;
      else if (folder.parentId && !incomingIds.has(folder.parentId) && folders.some((entry) => entry.id === folder.parentId)) parentId = folder.parentId;
      const target = folders.find((entry) => entry.id === folder.id)
        ?? folders.find((entry) => (entry.parentId ?? null) === parentId && sameName(entry.name, folder.name));
      const unfiled = [...new Set(folder.sessionIds)].filter((sessionId) => !filed.has(sessionId));
      for (const sessionId of unfiled) filed.add(sessionId);
      if (target) {
        idMap.set(folder.id, target.id);
        if (unfiled.length > 0) folders[folders.indexOf(target)] = { ...target, sessionIds: [...target.sessionIds, ...unfiled] };
        continue;
      }
      idMap.set(folder.id, folder.id);
      folders.push({ id: folder.id, name: folder.name.trim(), sessionIds: unfiled, createdAt: folder.createdAt, parentId });
    }
    foldersMap[scopeKey] = folders;
  }
  for (const [scopeKey, folders] of Object.entries(foldersMap)) {
    const kept = folders.filter((folder) => deletedFolderIds[folder.id] === undefined);
    if (kept.length > 0) foldersMap[scopeKey] = kept;
    else delete foldersMap[scopeKey];
  }
};

const hasFiniteRevision = (value: unknown): value is number => Number.isFinite(value);

export const applyFolderChanges = (snapshot: StoredFolderSnapshot, changes: FolderChange[], now: number): FolderChangesResult => {
  const foldersMap = { ...snapshot.foldersMap };
  const deletedFolderIds: FolderTombstones = {};
  for (const [folderId, deletedAt] of Object.entries(snapshot.deletedFolderIds ?? {})) {
    if (now - deletedAt <= TOMBSTONE_TTL_MS) deletedFolderIds[folderId] = deletedAt;
  }
  let collapsedFolderIds = snapshot.collapsedFolderIds ?? [];
  const before = JSON.stringify([foldersMap, deletedFolderIds]);

  const setScope = (scopeKey: string, folders: SessionFolder[]) => {
    if (folders.length > 0) foldersMap[scopeKey] = folders;
    else delete foldersMap[scopeKey];
  };
  const removeFolders = (scopeKey: string, folderIds: string[]) => {
    const folders = foldersMap[scopeKey] ?? [];
    const removed = descendantIds(folders, folderIds);
    for (const folderId of removed) deletedFolderIds[folderId] = now;
    setScope(scopeKey, folders.filter((folder) => !removed.has(folder.id)));
  };

  for (const change of changes) {
    switch (change.type) {
      case 'create': {
        const folders = foldersMap[change.scopeKey] ?? [];
        if (folders.some((folder) => folder.id === change.folder.id)) break;
        delete deletedFolderIds[change.folder.id];
        const parentId = change.folder.parentId && folders.some((folder) => folder.id === change.folder.parentId)
          ? change.folder.parentId
          : null;
        const { id: folderId, name: folderName, createdAt } = change.folder;
        setScope(change.scopeKey, [...folders, { id: folderId, name: folderName, sessionIds: [], createdAt, parentId }]);
        break;
      }
      case 'rename': {
        const folders = foldersMap[change.scopeKey] ?? [];
        if (!folders.some((folder) => folder.id === change.folderId && folder.name !== change.name)) break;
        setScope(change.scopeKey, folders.map((folder) => (folder.id === change.folderId ? { ...folder, name: change.name } : folder)));
        break;
      }
      case 'delete':
        removeFolders(change.scopeKey, change.folderIds);
        break;
      case 'assign': {
        const folders = foldersMap[change.scopeKey] ?? [];
        const target = folders.find((folder) => folder.id === change.folderId);
        if (!target) break;
        const moving = new Set(chatsStillInPlace(folders, change.sessionIds, change.from));
        const settled = [...moving].every((sessionId) => target.sessionIds.includes(sessionId))
          && folders.every((folder) => folder === target || !folder.sessionIds.some((sessionId) => moving.has(sessionId)));
        if (settled) break;
        setScope(change.scopeKey, withoutSessions(folders, moving).map((folder) => (
          folder.id === change.folderId ? { ...folder, sessionIds: [...folder.sessionIds, ...moving] } : folder
        )));
        break;
      }
      case 'unassign': {
        const folders = foldersMap[change.scopeKey] ?? [];
        setScope(change.scopeKey, withoutSessions(folders, new Set(chatsStillInPlace(folders, change.sessionIds, change.from))));
        break;
      }
      case 'forget-sessions': {
        const forgotten = new Set(change.sessionIds);
        for (const [scopeKey, folders] of Object.entries(foldersMap)) setScope(scopeKey, withoutSessions(folders, forgotten));
        break;
      }
      case 'forget-scopes':
        for (const scopeKey of change.scopeKeys) {
          removeFolders(scopeKey, (foldersMap[scopeKey] ?? []).map((folder) => folder.id));
        }
        break;
      case 'import':
        importFolders(foldersMap, deletedFolderIds, change.foldersMap, change.deletedFolderIds, now);
        break;
    }
  }

  if (JSON.stringify([foldersMap, deletedFolderIds]) === before) return { snapshot, changed: false };
  const known = new Set(Object.values(foldersMap).flatMap((folders) => folders.map((folder) => folder.id)));
  collapsedFolderIds = collapsedFolderIds.filter((folderId) => known.has(folderId));
  const updatedAt = Math.max(now, (hasFiniteRevision(snapshot.updatedAt) ? snapshot.updatedAt : 0) + 1);
  return {
    snapshot: { version: 1, foldersMap, collapsedFolderIds, deletedFolderIds, updatedAt },
    changed: true,
  };
};
