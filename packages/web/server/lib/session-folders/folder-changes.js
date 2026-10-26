import { z } from 'zod';

/**
 * One user action on the shared folders, sent by a client and applied here
 * against the stored state. Changes carry intent ("move these chats into this
 * folder"), never a copy of the whole map, so a client that has not seen the
 * latest state cannot undo what another client did. The client applies the
 * same changes to its own copy (`packages/ui/src/lib/sessionFolders/folderChanges.ts`);
 * both sides must keep the same semantics.
 */
// Scope keys are directory paths, so ids get the room a long path needs.
const id = z.string().trim().min(1).max(32_768);
const ids = z.array(id).max(10_000);
const name = z.string().trim().min(1).max(10_000);

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
  z.object({ type: z.literal('assign'), scopeKey: id, folderId: id, sessionIds: ids.min(1) }),
  z.object({ type: z.literal('unassign'), scopeKey: id, sessionIds: ids.min(1) }),
  z.object({ type: z.literal('forget-sessions'), sessionIds: ids.min(1) }),
  z.object({ type: z.literal('forget-scopes'), scopeKeys: ids.min(1) }),
  // Sent once by a client that still has folders from the time each device
  // kept its own. Server-only: the client waits for the answer instead of
  // applying it locally.
  z.object({
    type: z.literal('import'),
    foldersMap: z.record(z.string(), z.array(folderSchema)),
    deletedFolderIds: z.record(z.string(), z.number().finite()).optional(),
  }),
]);

export const folderChangesBodySchema = z.object({ changes: z.array(folderChangeSchema).min(1).max(1_000) });

// A deleted folder id is remembered this long, so a device on an older
// version that still holds the folder cannot bring it back by writing its
// whole copy.
export const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const sameName = (left, right) => left.trim().toLowerCase() === right.trim().toLowerCase();

const withoutSessions = (folders, sessionIds) => {
  let changed = false;
  const next = folders.map((folder) => {
    const kept = folder.sessionIds.filter((sessionId) => !sessionIds.has(sessionId));
    if (kept.length === folder.sessionIds.length) return folder;
    changed = true;
    return { ...folder, sessionIds: kept };
  });
  return changed ? next : folders;
};

const descendantIds = (folders, rootIds) => {
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

/**
 * Merge one device's folders into the stored ones without losing either side.
 * What the server already has wins: its folders keep their id, name and
 * place, and a chat the server already files stays where it is. A local
 * folder joins a stored one with the same name under the same parent; any
 * other local folder is added. Chats only the device had filed go into the
 * matching folder.
 */
const importFolders = (foldersMap, deletedFolderIds, incomingMap, incomingDeletions, now) => {
  for (const [folderId, deletedAt] of Object.entries(incomingDeletions ?? {})) {
    if (now - deletedAt > TOMBSTONE_TTL_MS) continue;
    deletedFolderIds[folderId] = Math.max(deletedFolderIds[folderId] ?? 0, deletedAt);
  }
  for (const [scopeKey, incomingFolders] of Object.entries(incomingMap)) {
    const folders = [...(foldersMap[scopeKey] ?? [])].filter((folder) => deletedFolderIds[folder.id] === undefined);
    const filed = new Set(folders.flatMap((folder) => folder.sessionIds));
    // Incoming id -> stored id, filled parents first so a child finds its parent.
    const idMap = new Map();
    const pending = incomingFolders.filter((folder) => deletedFolderIds[folder.id] === undefined && folder.id && folder.name.trim());
    const incomingIds = new Set(pending.map((folder) => folder.id));
    while (pending.length > 0) {
      // Parents first; a parent cycle, which only a corrupted copy can hold,
      // places its first folder at the top level.
      const index = Math.max(0, pending.findIndex((folder) => !folder.parentId || !incomingIds.has(folder.parentId) || idMap.has(folder.parentId)));
      const [folder] = pending.splice(index, 1);
      let parentId = null;
      if (folder.parentId && idMap.has(folder.parentId)) parentId = idMap.get(folder.parentId);
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
  // The device's own deletions also reach folders it no longer sent.
  for (const [scopeKey, folders] of Object.entries(foldersMap)) {
    const kept = folders.filter((folder) => deletedFolderIds[folder.id] === undefined);
    if (kept.length > 0) foldersMap[scopeKey] = kept;
    else delete foldersMap[scopeKey];
  }
};

/**
 * Apply changes in order to a stored snapshot. Returns the next snapshot and
 * whether anything changed; a change whose folder is gone does nothing, so a
 * change that raced a deletion on another client cannot recreate the folder.
 */
export const applyFolderChanges = (snapshot, changes, now) => {
  const foldersMap = { ...snapshot.foldersMap };
  const deletedFolderIds = {};
  for (const [folderId, deletedAt] of Object.entries(snapshot.deletedFolderIds ?? {})) {
    if (now - deletedAt <= TOMBSTONE_TTL_MS) deletedFolderIds[folderId] = deletedAt;
  }
  let collapsedFolderIds = snapshot.collapsedFolderIds ?? [];
  const before = JSON.stringify([foldersMap, deletedFolderIds]);

  const setScope = (scopeKey, folders) => {
    if (folders.length > 0) foldersMap[scopeKey] = folders;
    else delete foldersMap[scopeKey];
  };
  const removeFolders = (scopeKey, folderIds) => {
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
        // An explicit create wins over an old deletion of the same id: only a
        // folder with a fixed id (the archive's) can ever be created twice.
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
        const moving = new Set(change.sessionIds);
        const settled = [...moving].every((sessionId) => target.sessionIds.includes(sessionId))
          && folders.every((folder) => folder === target || !folder.sessionIds.some((sessionId) => moving.has(sessionId)));
        if (settled) break;
        setScope(change.scopeKey, withoutSessions(folders, moving).map((folder) => (
          folder.id === change.folderId ? { ...folder, sessionIds: [...folder.sessionIds, ...moving] } : folder
        )));
        break;
      }
      case 'unassign':
        setScope(change.scopeKey, withoutSessions(foldersMap[change.scopeKey] ?? [], new Set(change.sessionIds)));
        break;
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
  const updatedAt = Math.max(now, (Number.isFinite(snapshot.updatedAt) ? snapshot.updatedAt : 0) + 1);
  return {
    snapshot: { version: 1, foldersMap, collapsedFolderIds, deletedFolderIds, updatedAt },
    changed: true,
  };
};
