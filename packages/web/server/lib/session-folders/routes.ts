import { folderChangesBodySchema } from './folder-changes.js';
import {
  MAX_SESSION_FOLDERS_BODY_BYTES,
  SessionFoldersError,
  createSessionFoldersStore,
  isObjectRecord,
  isPositiveRevision,
  isStoredFolderSnapshot,
  type SessionFoldersStore,
} from './store.js';
import type { SessionFoldersApp, SessionFoldersDependencies } from './contracts.js';

export const registerSessionFoldersRoutes = (
  app: SessionFoldersApp,
  dependencies: SessionFoldersDependencies | { store: SessionFoldersStore },
) => {
  const store = 'store' in dependencies ? dependencies.store : createSessionFoldersStore(dependencies);

  app.get('/api/session-folders', async (_req, res) => {
    try {
      return res.json(await store.readSnapshot());
    } catch (error) {
      if (error instanceof SessionFoldersError) {
        return res.status(error.status).json({ error: error.message });
      }
      const message = error instanceof Error ? error.message : 'Failed to read session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/session-folders', async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (!isStoredFolderSnapshot(body)) {
      return res.status(400).json({ error: 'Invalid session folders payload' });
    }
    const serialized = JSON.stringify(body, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_FOLDERS_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    if (!isPositiveRevision(body.updatedAt)) {
      return res.status(400).json({ error: 'updatedAt must be a positive finite number' });
    }

    try {
      await store.mergeWholeCopy(body);
      return res.json({ success: true });
    } catch (error) {
      if (error instanceof SessionFoldersError) {
        return res.status(error.status).json({ error: error.message });
      }
      const message = error instanceof Error ? error.message : 'Failed to write session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.patch('/api/session-folders', async (req, res) => {
    const parsed = folderChangesBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid session folder changes' });
    }
    try {
      const { snapshot, exists } = await store.applyChanges(parsed.data.changes);
      return res.json({ ...snapshot, exists });
    } catch (error) {
      if (error instanceof SessionFoldersError) {
        return res.status(error.status).json({ error: error.message });
      }
      const message = error instanceof Error ? error.message : 'Failed to write session folders';
      return res.status(500).json({ error: message });
    }
  });
};
