const MAX_BODY_BYTES = 4 * 1024 * 1024;

export const registerSessionFoldersRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
  } = dependencies;

  const filePath = path.join(openchamberDataDir, 'sessions-directories.json');

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
        return res.json({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 });
      }
      try {
        const parsed = JSON.parse(raw);
        return res.json(parsed);
      } catch {
        return res.json({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/session-folders', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    const serialized = JSON.stringify(body, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    let tmp;
    let saved = false;
    try {
      await ensureDir();
      tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await fsPromises.writeFile(tmp, serialized, 'utf8');
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
  });
};
