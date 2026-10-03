const MAX_BODY_BYTES = 4 * 1024 * 1024;

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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

// A deleted folder id is remembered this long, which is longer than any device
// plausibly stays offline with a stale copy that still holds it.
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const EMPTY_SNAPSHOT = { version: 1, foldersMap: {}, collapsedFolderIds: [] };

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

export const registerSessionFoldersRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
  } = dependencies;

  const filePath = path.join(openchamberDataDir, 'sessions-directories.json');
  let saveQueue = Promise.resolve();

  const ensureDir = async () => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
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

    const save = async () => {
      let tmp;
      let saved = false;
      try {
        const currentRaw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
          if (error && error.code === 'ENOENT') return null;
          throw error;
        });
        const now = Date.now();
        let current = EMPTY_SNAPSHOT;
        if (currentRaw) {
          try {
            const parsed = JSON.parse(currentRaw);
            if (hasValidFolderSnapshotShape(parsed)) {
              current = parsed;
            }
          } catch { /* A valid new snapshot repairs malformed prior state. */ }
        }
        const outgoing = mergeSnapshots(current, body, now);

        const outgoingSerialized = JSON.stringify(outgoing, null, 2);
        await ensureDir();
        tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        await fsPromises.writeFile(tmp, outgoingSerialized, 'utf8');
        await fsPromises.rename(tmp, filePath);
        saved = true;
        return res.json({ success: true });
      } catch (error) {
        if (tmp && !saved) {
          await fsPromises.unlink(tmp).catch(() => {});
        }
        const message = error instanceof Error ? error.message : 'Failed to write session folders';
        return res.status(500).json({ error: message });
      }
    };

    const pendingSave = saveQueue.then(save, save);
    saveQueue = pendingSave.then(() => undefined, () => undefined);
    return pendingSave;
  });
};
