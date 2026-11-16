import { z } from 'zod';
import type { SessionFolder, SessionFoldersMap } from '@/stores/useSessionFoldersStore';

/**
 * One user action on the shared folders. The client applies it to its own copy
 * at once and sends it to the server, which applies it to the stored folders
 * (`packages/web/server/lib/session-folders/folder-changes.js`); both sides
 * keep the same semantics, so a change still pending is laid over every newer
 * server copy the same way the server will apply it.
 */
export type FolderChange =
  | { type: 'create'; scopeKey: string; folder: { id: string; name: string; parentId: string | null; createdAt: number } }
  | { type: 'rename'; scopeKey: string; folderId: string; name: string }
  | { type: 'delete'; scopeKey: string; folderIds: string[] }
  | { type: 'assign'; scopeKey: string; folderId: string; sessionIds: string[]; from?: ChatPlacement }
  | { type: 'unassign'; scopeKey: string; sessionIds: string[]; from?: ChatPlacement }
  | { type: 'forget-sessions'; sessionIds: string[] }
  | { type: 'forget-scopes'; scopeKeys: string[] };

/**
 * Which folder of the scope each chat was in when the user moved it (null: in
 * none). A chat that has since moved elsewhere stays there, so a move sent late
 * or sent twice cannot undo a newer one from another client.
 */
export type ChatPlacement = Record<string, string | null>;

const id = z.string().min(1);
const chatPlacementSchema = z.record(z.string(), id.nullable());
export const folderChangeSchema: z.ZodType<FolderChange> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('create'), scopeKey: id, folder: z.object({ id, name: id, parentId: id.nullable(), createdAt: z.number() }) }),
  z.object({ type: z.literal('rename'), scopeKey: id, folderId: id, name: id }),
  z.object({ type: z.literal('delete'), scopeKey: id, folderIds: z.array(id).min(1) }),
  z.object({ type: z.literal('assign'), scopeKey: id, folderId: id, sessionIds: z.array(id).min(1), from: chatPlacementSchema.optional() }),
  z.object({ type: z.literal('unassign'), scopeKey: id, sessionIds: z.array(id).min(1), from: chatPlacementSchema.optional() }),
  z.object({ type: z.literal('forget-sessions'), sessionIds: z.array(id).min(1) }),
  z.object({ type: z.literal('forget-scopes'), scopeKeys: z.array(id).min(1) }),
]);

const storedFolderSchema = z.object({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  sessionIds: z.array(z.string()).transform((ids) => ids.filter((value) => value.trim().length > 0)),
  createdAt: z.number().catch(0),
  parentId: z.string().nullable().optional().transform((value) => value ?? null),
});

/** The server's answer to a read or a write of the shared folders. */
export const folderSnapshotSchema = z.object({
  exists: z.boolean().optional(),
  foldersMap: z.record(z.string(), z.array(storedFolderSchema)).default({}),
  updatedAt: z.number().finite().default(0),
});
export type FolderSnapshot = z.infer<typeof folderSnapshotSchema>;

const withoutSessions = (folders: SessionFolder[], sessionIds: ReadonlySet<string>): SessionFolder[] => {
  let changed = false;
  const next = folders.map((folder) => {
    const kept = folder.sessionIds.filter((sessionId) => !sessionIds.has(sessionId));
    if (kept.length === folder.sessionIds.length) return folder;
    changed = true;
    return { ...folder, sessionIds: kept };
  });
  return changed ? next : folders;
};

const folderHolding = (folders: readonly SessionFolder[], sessionId: string): string | null => (
  folders.find((folder) => folder.sessionIds.includes(sessionId))?.id ?? null
);

export const chatPlacement = (folders: readonly SessionFolder[] | undefined, sessionIds: readonly string[]): ChatPlacement => (
  Object.fromEntries(sessionIds.map((sessionId) => [sessionId, folderHolding(folders ?? [], sessionId)]))
);

const chatsStillInPlace = (folders: readonly SessionFolder[], sessionIds: readonly string[], from: ChatPlacement | undefined): string[] => (
  sessionIds.filter((sessionId) => {
    const expected = from?.[sessionId];
    if (expected === undefined) return true;
    const holding = folderHolding(folders, sessionId);
    // A chat left in no folder because its folder was deleted was not moved by anyone.
    return holding === expected || (holding === null && !folders.some((folder) => folder.id === expected));
  })
);

/** A folder and every folder under it. */
export const collectFolderSubtree = (folders: readonly SessionFolder[], rootId: string): Set<string> => {
  const result = new Set([rootId]);
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

const withScope = (map: SessionFoldersMap, scopeKey: string, folders: SessionFolder[]): SessionFoldersMap => {
  if (folders === map[scopeKey]) return map;
  return { ...map, [scopeKey]: folders };
};

/**
 * Apply one change. Returns the same map when nothing changes, so a caller can
 * skip the write, and keeps every untouched scope and folder by reference.
 */
export const applyFolderChange = (map: SessionFoldersMap, change: FolderChange): SessionFoldersMap => {
  switch (change.type) {
    case 'create': {
      const folders = map[change.scopeKey] ?? [];
      if (folders.some((folder) => folder.id === change.folder.id)) return map;
      const parentId = change.folder.parentId && folders.some((folder) => folder.id === change.folder.parentId) ? change.folder.parentId : null;
      // Field order matches a parsed server answer, so laying this over one compares equal.
      const { id, name, createdAt } = change.folder;
      return withScope(map, change.scopeKey, [...folders, { id, name, sessionIds: [], createdAt, parentId }]);
    }
    case 'rename': {
      const folders = map[change.scopeKey];
      if (!folders?.some((folder) => folder.id === change.folderId && folder.name !== change.name)) return map;
      return withScope(map, change.scopeKey, folders.map((folder) => (folder.id === change.folderId ? { ...folder, name: change.name } : folder)));
    }
    case 'delete': {
      const folders = map[change.scopeKey];
      if (!folders) return map;
      const removed = new Set<string>();
      for (const folderId of change.folderIds) for (const id of collectFolderSubtree(folders, folderId)) removed.add(id);
      const kept = folders.filter((folder) => !removed.has(folder.id));
      return kept.length === folders.length ? map : withScope(map, change.scopeKey, kept);
    }
    case 'assign': {
      const folders = map[change.scopeKey];
      const target = folders?.find((folder) => folder.id === change.folderId);
      if (!folders || !target) return map;
      const moving = new Set(chatsStillInPlace(folders, change.sessionIds, change.from));
      const settled = [...moving].every((sessionId) => target.sessionIds.includes(sessionId))
        && folders.every((folder) => folder === target || !folder.sessionIds.some((sessionId) => moving.has(sessionId)));
      if (settled) return map;
      return withScope(map, change.scopeKey, withoutSessions(folders, moving).map((folder) => (
        folder.id === change.folderId ? { ...folder, sessionIds: [...folder.sessionIds, ...moving] } : folder
      )));
    }
    case 'unassign': {
      const folders = map[change.scopeKey];
      return folders ? withScope(map, change.scopeKey, withoutSessions(folders, new Set(chatsStillInPlace(folders, change.sessionIds, change.from)))) : map;
    }
    case 'forget-sessions': {
      const forgotten = new Set(change.sessionIds);
      let next = map;
      for (const [scopeKey, folders] of Object.entries(map)) next = withScope(next, scopeKey, withoutSessions(folders, forgotten));
      return next;
    }
    case 'forget-scopes': {
      if (!change.scopeKeys.some((scopeKey) => scopeKey in map)) return map;
      const next = { ...map };
      for (const scopeKey of change.scopeKeys) delete next[scopeKey];
      return next;
    }
  }
};

export const applyFolderChanges = (map: SessionFoldersMap, changes: readonly FolderChange[]): SessionFoldersMap => (
  changes.reduce(applyFolderChange, map)
);
