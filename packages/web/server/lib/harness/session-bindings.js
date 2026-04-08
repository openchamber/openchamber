export const createSessionBindingsRuntime = ({
  fsPromises,
  path,
  bindingsFilePath,
  defaultBackendId = 'opencode',
}) => {
  let bindings = new Map();
  let loaded = false;
  let writeLock = Promise.resolve();

  const ensureLoaded = async () => {
    if (loaded) {
      return;
    }

    try {
      const raw = await fsPromises.readFile(bindingsFilePath, 'utf8');
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.bindings) ? parsed.bindings : [];
      bindings = new Map(
        entries
          .filter((entry) => entry && typeof entry.sessionId === 'string' && entry.sessionId.trim().length > 0)
          .map((entry) => [entry.sessionId, entry]),
      );
    } catch (error) {
      if (!error || typeof error !== 'object' || error.code !== 'ENOENT') {
        console.warn('Failed to read session bindings:', error);
      }
      bindings = new Map();
    }

    loaded = true;
  };

  const persist = async () => {
    const payload = {
      version: 1,
      bindings: Array.from(bindings.values()).sort((a, b) => {
        const aCreated = typeof a.createdAt === 'number' ? a.createdAt : 0;
        const bCreated = typeof b.createdAt === 'number' ? b.createdAt : 0;
        return aCreated - bCreated;
      }),
    };

    writeLock = writeLock.then(async () => {
      await fsPromises.mkdir(path.dirname(bindingsFilePath), { recursive: true });
      await fsPromises.writeFile(bindingsFilePath, JSON.stringify(payload, null, 2), 'utf8');
    });

    return writeLock;
  };

  const normalizeBinding = (binding) => {
    const sessionId = typeof binding?.sessionId === 'string' ? binding.sessionId.trim() : '';
    if (!sessionId) {
      return null;
    }

    const backendId = typeof binding?.backendId === 'string' && binding.backendId.trim().length > 0
      ? binding.backendId.trim()
      : defaultBackendId;
    const backendSessionId =
      typeof binding?.backendSessionId === 'string' && binding.backendSessionId.trim().length > 0
        ? binding.backendSessionId.trim()
        : sessionId;
    const directory = typeof binding?.directory === 'string' && binding.directory.trim().length > 0
      ? binding.directory.trim()
      : null;
    const now = Date.now();

    return {
      sessionId,
      backendId,
      backendSessionId,
      directory,
      createdAt: typeof binding?.createdAt === 'number' ? binding.createdAt : now,
      updatedAt: now,
    };
  };

  const getBinding = async (sessionId) => {
    await ensureLoaded();
    return bindings.get(sessionId) || null;
  };

  const getBindingSync = (sessionId) => bindings.get(sessionId) || null;

  const getEffectiveBindingSync = (sessionId) => {
    const existing = bindings.get(sessionId);
    if (existing) {
      return existing;
    }
    if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      return null;
    }
    return {
      sessionId: sessionId.trim(),
      backendId: defaultBackendId,
      backendSessionId: sessionId.trim(),
      directory: null,
      createdAt: 0,
      updatedAt: 0,
    };
  };

  const upsertBinding = async (binding) => {
    await ensureLoaded();
    const normalized = normalizeBinding(binding);
    if (!normalized) {
      return null;
    }
    const existing = bindings.get(normalized.sessionId);
    const next = existing
      ? {
          ...existing,
          ...normalized,
          createdAt: existing.createdAt,
          updatedAt: Date.now(),
        }
      : normalized;
    bindings.set(next.sessionId, next);
    await persist();
    return next;
  };

  const removeBinding = async (sessionId) => {
    await ensureLoaded();
    if (!bindings.has(sessionId)) {
      return false;
    }
    bindings.delete(sessionId);
    await persist();
    return true;
  };

  const annotateSession = (session) => {
    if (!session || typeof session !== 'object') {
      return session;
    }
    const sessionId = typeof session.id === 'string' ? session.id : '';
    if (!sessionId) {
      return session;
    }
    const binding = getEffectiveBindingSync(sessionId);
    if (!binding) {
      return session;
    }
    return {
      ...session,
      backendId: binding.backendId,
    };
  };

  const annotateSessions = (sessions) => {
    if (!Array.isArray(sessions)) {
      return sessions;
    }
    return sessions.map((session) => annotateSession(session));
  };

  return {
    ensureLoaded,
    getBinding,
    getBindingSync,
    getEffectiveBindingSync,
    upsertBinding,
    removeBinding,
    annotateSession,
    annotateSessions,
  };
};
