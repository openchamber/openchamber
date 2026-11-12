import { isRecord as isObjectRecord } from '../shared/guards.js';
import { TOMBSTONE_TTL_MS, applyFolderChanges, folderChangesBodySchema } from './folder-changes.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const hasValidFolderShape = (folder) => (
  isObjectRecord(folder)
  && typeof folder.id === 'string'
  && typeof folder.name === 'string'
  && Array.isArray(folder.sessionIds)
  && folder.sessionIds.every((sessionId) => typeof sessionId === 'string')
  && typeof folder.createdAt === 'number'
  && Number.isFinite(folder.createdAt)
  && (folder.parentId === undefined || folder.parentId === null || typeof folder.parentId === 'string')
);

const hasValidFoldersMapShape = (foldersMap) => (
  isObjectRecord(foldersMap)
  && Object.values(foldersMap).every((folders) => (
    Array.isArray(folders) && folders.every(hasValidFolderShape)
  ))
);

// folderId -> deletedAt. Optional so snapshots written before tombstones
// existed stay valid.
const hasValidTombstonesShape = (tombstones) => (
  tombstones === undefined
  || (isObjectRecord(tombstones)
    && Object.values(tombstones).every((deletedAt) => typeof deletedAt === 'number' && Number.isFinite(deletedAt)))
);

const hasValidFolderSnapshotShape = (snapshot) => (
  isObjectRecord(snapshot)
  && snapshot.version === 1
  && hasValidFoldersMapShape(snapshot.foldersMap)
  && Array.isArray(snapshot.collapsedFolderIds)
  && snapshot.collapsedFolderIds.every((folderId) => typeof folderId === 'string')
  && hasValidTombstonesShape(snapshot.deletedFolderIds)
);

const EMPTY_SNAPSHOT = Object.freeze({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 });

const mergeTombstones = (current, incoming, now) => {
  const merged = {};
  for (const source of [current, incoming]) {
    if (!isObjectRecord(source)) continue;
    for (const [folderId, deletedAt] of Object.entries(source)) {
      if (now - deletedAt > TOMBSTONE_TTL_MS) continue;
      merged[folderId] = Math.max(merged[folderId] ?? 0, deletedAt);
    }
  }
  return merged;
};

// POST bodies are whole-device maps from clients that may never have seen the
// current server state (bootstrap-only hydration, long-open tabs, clock skew),
// so absence of a scope or folder is not deletion. Merge per scope instead of
// replacing the file: keep what the writer never saw, let the incoming
// version win per folder id, and keep updatedAt monotonic. Deletion travels
// explicitly as tombstones: a tombstoned id is dropped from every scope even
// when a stale device sends it again.
const mergeSnapshots = (current, incoming, now) => {
  const deletedFolderIds = mergeTombstones(current.deletedFolderIds, incoming.deletedFolderIds, now);
  const currentMap = isObjectRecord(current.foldersMap) ? current.foldersMap : {};
  const incomingMap = isObjectRecord(incoming.foldersMap) ? incoming.foldersMap : {};
  const mergedScopes = {};
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
      // Devices that auto-create archive folders for the same scope produce
      // same-name folders with different ids; union their session lists.
      const twinId = idByName.get(folder.name.toLowerCase());
      if (twinId !== undefined && twinId !== folder.id && foldersById.has(twinId)) {
        const twin = foldersById.get(twinId);
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
  // The writer's collapse state is authoritative for folders it knows; a
  // union would keep a folder it just expanded collapsed forever.
  const incomingFolderIds = new Set(
    Object.values(incomingMap).flatMap((folders) => (Array.isArray(folders) ? folders.map((folder) => folder.id) : [])),
  );
  const incomingCollapsed = Array.isArray(incoming.collapsedFolderIds) ? incoming.collapsedFolderIds : [];
  const currentCollapsed = Array.isArray(current.collapsedFolderIds) ? current.collapsedFolderIds : [];
  const collapsedFolderIds = [
    ...new Set([
      ...incomingCollapsed,
      ...currentCollapsed.filter((folderId) => !incomingFolderIds.has(folderId)),
    ]),
  ].filter((folderId) => deletedFolderIds[folderId] === undefined);
  const updatedAt = Math.max(
    Number.isFinite(current.updatedAt) ? current.updatedAt : 0,
    Number.isFinite(incoming.updatedAt) ? incoming.updatedAt : 0,
  );
  return { version: 1, foldersMap: mergedScopes, collapsedFolderIds, deletedFolderIds, updatedAt };
};

/**
 * `onChanged(updatedAt)` runs after a write that changed the stored folders,
 * so the server can tell every connected client to read them again.
 */
export const registerSessionFoldersRoutes = (app, dependencies) => {
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

  /** The stored snapshot; `null` when the file exists but cannot be read as one. */
  const readCurrent = async () => {
    const currentRaw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    });
    if (!currentRaw) return EMPTY_SNAPSHOT;
    try {
      const parsed = JSON.parse(currentRaw);
      return hasValidFolderSnapshotShape(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const writeSnapshot = async (snapshot) => {
    let tmp;
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

  const serialize = (task) => {
    const pending = saveQueue.then(task, task);
    saveQueue = pending.then(() => undefined, () => undefined);
    return pending;
  };

  const announce = (updatedAt) => {
    try {
      onChanged(updatedAt);
    } catch { /* A failed announcement leaves the write in place. */ }
  };

  app.get('/api/session-folders', async (_req, res) => {
    try {
      const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
        if (error && error.code === 'ENOENT') return null;
        throw error;
      });
      if (!raw) {
        return res.json({ version: 1, exists: false });
      }
      try {
        const parsed = JSON.parse(raw);
        if (
          !hasValidFolderSnapshotShape(parsed)
          || typeof parsed.updatedAt !== 'number'
          || !Number.isFinite(parsed.updatedAt)
          || parsed.updatedAt <= 0
        ) {
          return res.status(500).json({ error: 'Stored session folders have an invalid shape' });
        }
        return res.json({ ...parsed, exists: true });
      } catch {
        return res.status(500).json({ error: 'Stored session folders are malformed' });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/session-folders', async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!hasValidFolderSnapshotShape(body)) {
      return res.status(400).json({ error: 'Invalid session folders payload' });
    }
    const serialized = JSON.stringify(body, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    if (typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt) || body.updatedAt <= 0) {
      return res.status(400).json({ error: 'updatedAt must be a positive finite number' });
    }

    // The whole-copy write of clients from before shared folders; current
    // clients send changes to PATCH instead.
    return serialize(async () => {
      try {
        // A valid whole copy repairs a malformed file, as it always did.
        const current = await readCurrent() ?? EMPTY_SNAPSHOT;
        const merged = mergeSnapshots(current, body, now());
        const changed = JSON.stringify(merged.foldersMap) !== JSON.stringify(current.foldersMap ?? {});
        // The writer's clock is its own; a change still moves the revision
        // past the stored one, or clients that saw it would skip the read.
        const outgoing = changed
          ? { ...merged, updatedAt: Math.max(merged.updatedAt, now(), (Number.isFinite(current.updatedAt) ? current.updatedAt : 0) + 1) }
          : merged;
        await writeSnapshot(outgoing);
        if (changed) announce(outgoing.updatedAt);
        return res.json({ success: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to write session folders';
        return res.status(500).json({ error: message });
      }
    });
  });

  app.patch('/api/session-folders', async (req, res) => {
    const parsed = folderChangesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid session folder changes' });
    }
    return serialize(async () => {
      try {
        const current = await readCurrent();
        // Changes on top of an unreadable file would replace every folder in it.
        if (!current) return res.status(500).json({ error: 'Stored session folders are malformed' });
        const { snapshot, changed } = applyFolderChanges(current, parsed.data.changes, now());
        if (changed) {
          if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > MAX_BODY_BYTES) {
            return res.status(413).json({ error: 'Session folders too large' });
          }
          await writeSnapshot(snapshot);
          announce(snapshot.updatedAt);
        }
        // The stored state after the changes, so the writer needs no extra read.
        return res.json({ ...snapshot, exists: changed || current !== EMPTY_SNAPSHOT });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to write session folders';
        return res.status(500).json({ error: message });
      }
    });
  });
};
