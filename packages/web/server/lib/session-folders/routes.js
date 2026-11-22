import { isRecord as isObjectRecord } from '../shared/guards.js';
import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile as realReadBoundedFile } from '../shared/bounded-file-read.js';
import { TOMBSTONE_TTL_MS, applyFolderChanges, folderChangesBodySchema } from './folder-changes.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Read cap for the stored snapshot file, and the size invariant for the
 * whole store: no write path may persist a snapshot whose persisted form
 * - the pretty-printed JSON writeSnapshot writes, measured exactly -
 * exceeds this cap, so anything the writer produced stays readable.
 * Incoming POST bodies are additionally capped at MAX_BODY_BYTES
 * (4 MiB), but a POST's merged snapshot and a PATCH's resulting snapshot
 * are judged against this cap (8 MiB), the same limit for both, so a
 * store POST legitimately wrote can always be PATCHed again. The cap
 * also keeps one oversized file from being buffered whole - and a FIFO
 * from wedging the serialized save queue, whose reads go through it.
 */
export const MAX_STORED_SNAPSHOT_BYTES = 2 * MAX_BODY_BYTES;

const hasValidFolder = (folder) => (
  isObjectRecord(folder)
  && typeof folder.id === 'string'
  && typeof folder.name === 'string'
  && Array.isArray(folder.sessionIds)
  && folder.sessionIds.every((sessionId) => typeof sessionId === 'string')
  && typeof folder.createdAt === 'number'
  && Number.isFinite(folder.createdAt)
  && (folder.parentId === undefined || folder.parentId === null || typeof folder.parentId === 'string')
);

const hasValidFoldersMap = (foldersMap) => (
  isObjectRecord(foldersMap)
  && Object.values(foldersMap).every((folders) => (
    Array.isArray(folders) && folders.every(hasValidFolder)
  ))
);

// folderId -> deletedAt. Optional so snapshots written before tombstones
// existed stay valid.
const hasValidTombstones = (tombstones) => (
  tombstones === undefined
  || (isObjectRecord(tombstones)
    && Object.values(tombstones).every((deletedAt) => typeof deletedAt === 'number' && Number.isFinite(deletedAt)))
);

const hasValidFolderSnapshot = (snapshot) => (
  isObjectRecord(snapshot)
  && snapshot.version === 1
  && hasValidFoldersMap(snapshot.foldersMap)
  && Array.isArray(snapshot.collapsedFolderIds)
  && snapshot.collapsedFolderIds.every((folderId) => typeof folderId === 'string')
  && hasValidTombstones(snapshot.deletedFolderIds)
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
    readBoundedFile = realReadBoundedFile,
  } = dependencies;

  const filePath = path.join(openchamberDataDir, 'sessions-directories.json');
  let saveQueue = Promise.resolve();

  const ensureDir = async () => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  };

  /**
   * The stored file through the shared bounded reader. `missing` is
   * distinct from `malformed`: an over-cap or non-regular target is
   * malformed, never a false empty snapshot. Unexpected I/O errors
   * throw, as the plain readFile did.
   */
  const readStoredFile = async () => {
    const result = await readBoundedFile(filePath, MAX_STORED_SNAPSHOT_BYTES);
    if (!result.ok) {
      return result.reason === 'missing' ? { kind: 'missing' } : { kind: 'malformed' };
    }
    return { kind: 'ok', raw: result.buffer.toString('utf8') };
  };

  /** The stored snapshot; `null` when the file exists but cannot be read as one. */
  const readCurrent = async () => {
    const stored = await readStoredFile();
    if (stored.kind === 'missing') return EMPTY_SNAPSHOT;
    if (stored.kind === 'malformed') return null;
    if (!stored.raw) return EMPTY_SNAPSHOT;
    try {
      const parsed = JSON.parse(stored.raw);
      return hasValidFolderSnapshot(parsed) ? parsed : null;
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
      await renameWithRetry((from, to) => fsPromises.rename(from, to), tmp, filePath);
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
      const stored = await readStoredFile();
      if (stored.kind === 'missing') {
        return res.json({ version: 1, exists: false });
      }
      if (stored.kind === 'malformed') {
        return res.status(500).json({ error: 'Stored session folders are malformed' });
      }
      const raw = stored.raw;
      if (!raw) {
        return res.json({ version: 1, exists: false });
      }
      try {
        const parsed = JSON.parse(raw);
        if (
          !hasValidFolderSnapshot(parsed)
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
    if (!hasValidFolderSnapshot(body)) {
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
        // #2162: the merge persists more than the folder map — a
        // collapse-only or tombstone-only POST changes durable state
        // too, and must advance the revision and announce like any
        // other change, or connected clients keep stale state.
        const changed = JSON.stringify(merged.foldersMap) !== JSON.stringify(current.foldersMap ?? {})
          || JSON.stringify(merged.collapsedFolderIds) !== JSON.stringify(current.collapsedFolderIds ?? [])
          || JSON.stringify(merged.deletedFolderIds ?? {}) !== JSON.stringify(current.deletedFolderIds ?? {});
        // The writer's clock is its own; a change still moves the revision
        // past the stored one, or clients that saw it would skip the read.
        const outgoing = changed
          ? { ...merged, updatedAt: Math.max(merged.updatedAt, now(), (Number.isFinite(current.updatedAt) ? current.updatedAt : 0) + 1) }
          : merged;
        // The guard above measures the incoming body, never the thing
        // actually written: a merge with the stored snapshot can exceed
        // the read cap even when both halves are under their own caps,
        // and a stored file over MAX_STORED_SNAPSHOT_BYTES reads back as
        // malformed forever after (#1761). Measure the merged snapshot
        // in the persisted (pretty) form and refuse without writing.
        if (Buffer.byteLength(JSON.stringify(outgoing, null, 2), 'utf8') > MAX_STORED_SNAPSHOT_BYTES) {
          return res.status(413).json({ error: 'Session folders too large' });
        }
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
          // Measure the exact bytes writeSnapshot persists (pretty form),
          // not the compact form: for session-id-heavy snapshots pretty
          // can be ~3.75x compact, so a compact check let the writer
          // produce a file over the read cap that then wedged the store
          // as malformed (#1745).
          if (Buffer.byteLength(JSON.stringify(snapshot, null, 2), 'utf8') > MAX_STORED_SNAPSHOT_BYTES) {
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
