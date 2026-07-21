const SETTINGS_KEY = 'permissionAutoAccept';
const RETRY_DELAYS_MS = [0, 250, 1000];
const REQUEST_TIMEOUT_MS = 5000;
const SESSION_CACHE_LIMIT = 10000;
const SESSION_LIST_PAGE_SIZE = 500;

const normalizePolicy = (value) => {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaultEnabled = source.default === true;
  const sessions = {};
  const entries = source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions)
    ? Object.entries(source.sessions)
    : [];
  for (const [sessionId, enabled] of entries) {
    if (sessionId && typeof enabled === 'boolean') sessions[sessionId] = enabled;
  }
  return { default: defaultEnabled, sessions };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readCursorHeader = (response) => {
  const raw = response?.headers?.get?.('x-next-cursor');
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

const normalizeSessionInfo = (sessionId, payload) => {
  const candidate = payload?.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data
    : payload;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(`Invalid session payload for ${sessionId}`);
  }
  const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
  if (!id || id !== sessionId) {
    throw new Error(`Unexpected session payload for ${sessionId}`);
  }
  return {
    id,
    parentID: typeof candidate.parentID === 'string' && candidate.parentID ? candidate.parentID : null,
    directory: typeof candidate.directory === 'string' && candidate.directory ? candidate.directory : undefined,
    time: candidate.time && typeof candidate.time === 'object' ? candidate.time : undefined,
  };
};

export function createPermissionAutoAcceptRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
  retryDelaysMs = RETRY_DELAYS_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let policy = normalizePolicy();
  let loaded = false;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  const sessions = new Map();
  const inFlight = new Map();
  const reconcilePromises = new Map();

  const snapshot = () => ({
    default: policy.default === true,
    sessions: { ...policy.sessions },
  });

  const load = async () => {
    if (loaded) return snapshot();
    if (!loadPromise) {
      loadPromise = readSettingsFromDiskMigrated()
        .then((settings) => {
          policy = normalizePolicy(settings?.[SETTINGS_KEY]);
          loaded = true;
          return snapshot();
        })
        .finally(() => { loadPromise = null; });
    }
    return loadPromise;
  };

  const enqueueWrite = (operation) => {
    const task = writePromise.then(operation, operation);
    writePromise = task.then(() => undefined, () => undefined);
    return task;
  };

  const persistUpdateUnqueued = async (update) => {
    const next = update(policy);
    await persistSettings({ [SETTINGS_KEY]: next });
    policy = next;
    loaded = true;
    broadcastGlobalUiEvent?.({
      type: 'openchamber:permission-auto-accept.updated',
      properties: snapshot(),
    });
    return snapshot();
  };

  const persistUpdate = (update) => enqueueWrite(() => persistUpdateUnqueued(update));

  const setSessionPolicy = async (sessionId, enabled, directory) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('sessionId is required');
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    await load();
    const result = await persistUpdate((current) => ({
      ...current,
      sessions: { ...current.sessions, [sessionId.trim()]: enabled },
    }));
    if (enabled) await reconcilePending({ directories: [directory] });
    return result;
  };

  const setDefaultPolicy = async (enabled) => {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    return enqueueWrite(async () => {
      const reconcileDirectories = enabled ? await listKnownSessionDirectories() : [];
      await load();
      const result = await persistUpdateUnqueued((current) => ({
        ...current,
        default: enabled,
      }));
      if (enabled) await reconcilePending({ directories: reconcileDirectories });
      return result;
    });
  };

  const rememberSession = (info, directoryHint) => {
    if (!info || typeof info.id !== 'string' || !info.id) return;
    sessions.set(info.id, {
      parentID: typeof info.parentID === 'string' && info.parentID ? info.parentID : null,
      directory: typeof info.directory === 'string' && info.directory ? info.directory : directoryHint,
    });
    if (sessions.size > SESSION_CACHE_LIMIT) {
      sessions.delete(sessions.keys().next().value);
    }
  };

  const listKnownSessionDirectories = async () => {
    const directories = new Set();
    const seenIds = new Set();
    let cursor;

    while (true) {
      const url = new URL(buildOpenCodeUrl('/experimental/session', ''));
      url.searchParams.set('archived', 'false');
      url.searchParams.set('roots', 'true');
      url.searchParams.set('limit', String(SESSION_LIST_PAGE_SIZE));
      if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));

      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!response.ok) {
        const error = new Error(`OpenCode request failed (${response.status})`);
        error.status = response.status;
        throw error;
      }

      const payload = await response.json().catch(() => null);
      if (!Array.isArray(payload)) {
        throw new Error('Invalid experimental session list response');
      }
      if (payload.length === 0) break;

      let appended = 0;
      let lastUpdated;
      for (const raw of payload) {
        const sessionId = typeof raw?.id === 'string' ? raw.id.trim() : '';
        const session = normalizeSessionInfo(sessionId, raw);
        if (seenIds.has(session.id)) continue;
        seenIds.add(session.id);
        appended += 1;
        if (session.directory) directories.add(session.directory);
        lastUpdated = typeof session.time?.updated === 'number' && Number.isFinite(session.time.updated)
          ? session.time.updated
          : lastUpdated;
      }

      if (payload.length < SESSION_LIST_PAGE_SIZE) break;
      const nextCursor = readCursorHeader(response) ?? lastUpdated;
      if (nextCursor === undefined || nextCursor === null) break;
      if (cursor !== undefined && nextCursor >= cursor) break;
      if (appended === 0) break;
      cursor = nextCursor;
    }

    return Array.from(directories);
  };

  const request = async (path, { directory, method = 'GET', body } = {}) => {
    const url = new URL(buildOpenCodeUrl(path, ''));
    if (directory) url.searchParams.set('directory', directory);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...getOpenCodeAuthHeaders(),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      const error = new Error(`OpenCode request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return response.json().catch(() => null);
  };

  const getSession = async (sessionId, directory) => {
    const cached = sessions.get(sessionId);
    if (cached) return cached;
    const info = await request(`/session/${encodeURIComponent(sessionId)}`, { directory });
    rememberSession(normalizeSessionInfo(sessionId, info), directory);
    return sessions.get(sessionId) ?? null;
  };

  const isSessionAutoAccepting = async (sessionId, directory) => {
    await load();
    const seen = new Set();
    let current = sessionId;
    let currentDirectory = directory;
    let resolvedLineage = false;
    while (current && !seen.has(current)) {
      if (Object.hasOwn(policy.sessions, current)) return policy.sessions[current] === true;
      seen.add(current);
      let info;
      try {
        info = await getSession(current, currentDirectory);
      } catch {
        return false;
      }
      current = info?.parentID ?? null;
      currentDirectory = info?.directory ?? currentDirectory;
    }
    if (!current) resolvedLineage = true;
    return resolvedLineage ? policy.default === true : false;
  };

  const replyOnce = async (permission, directory) => {
    if (!permission?.id || !permission?.sessionID) return false;
    await load();
    if (!(await isSessionAutoAccepting(permission.sessionID, directory))) return false;
    await request(`/permission/${encodeURIComponent(permission.id)}/reply`, {
      directory,
      method: 'POST',
      body: { reply: 'once' },
    });
    return true;
  };

  const processPermission = (permission, directory) => {
    if (!permission?.id) return Promise.resolve(false);
    const key = permission.id;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const task = (async () => {
      for (const delay of retryDelaysMs) {
        if (delay > 0) await wait(delay);
        try {
          return await replyOnce(permission, directory);
        } catch (error) {
          if (error?.status === 404) return true;
        }
      }
      return false;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  };

  async function reconcilePending({ directories = [] } = {}) {
    const normalizedDirectories = Array.from(new Set(
      directories.filter((directory) => typeof directory === 'string' && directory.trim()).map((directory) => directory.trim()),
    ));
    const key = normalizedDirectories.length > 0 ? normalizedDirectories.join('\n') : 'all';
    const existing = reconcilePromises.get(key);
    if (existing) return existing;
    const task = (async () => {
      await load();
      const scopes = [undefined, ...normalizedDirectories];
      const pendingById = new Map();
      for (const directory of scopes) {
        let payload;
        try {
          payload = await request('/permission', { directory });
        } catch {
          continue;
        }
        const pending = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : null;
        if (!pending) continue;
        for (const permission of pending) {
          if (!permission?.id) continue;
          pendingById.set(permission.id, { permission, directory: permission.directory ?? directory });
        }
      }
      await Promise.all(Array.from(pendingById.values()).map(({ permission, directory }) =>
        processPermission(permission, directory)));
    })().finally(() => { reconcilePromises.delete(key); });
    reconcilePromises.set(key, task);
    return task;
  }

  const processEvent = (event) => {
    const raw = event?.payload;
    const payload = raw?.payload && typeof raw.payload === 'object' ? raw.payload : raw;
    const directory = typeof event?.directory === 'string' && event.directory !== 'global' ? event.directory : undefined;
    if (payload?.type === 'session.created' || payload?.type === 'session.updated') {
      rememberSession(payload.properties?.info, directory);
      return;
    }
    if (payload?.type === 'permission.asked') {
      void processPermission(payload.properties, directory);
    }
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') void reconcilePending();
    });
    void load().then(() => reconcilePending()).catch((error) => {
      console.warn('[permission-auto-accept] failed to load policy:', error?.message ?? error);
    });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  return {
    snapshot,
    load,
    setDefaultPolicy,
    setSessionPolicy,
    isSessionAutoAccepting,
    processPermission,
    reconcilePending,
    start,
  };
}

export function registerPermissionAutoAcceptRoutes(app, runtime) {
  app.get('/api/permission-auto-accept', async (_req, res) => {
    try {
      res.json(await runtime.load());
    } catch (error) {
      res.status(500).json({ error: error?.message ?? 'Failed to load permission auto-accept policy' });
    }
  });

  app.put('/api/permission-auto-accept/sessions/:sessionId', async (req, res) => {
    try {
      const directory = typeof req.body?.directory === 'string' ? req.body.directory : undefined;
      res.json(await runtime.setSessionPolicy(req.params.sessionId, req.body?.enabled, directory));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error?.message });
    }
  });

  app.put('/api/permission-auto-accept/default', async (req, res) => {
    try {
      res.json(await runtime.setDefaultPolicy(req.body?.enabled));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error?.message });
    }
  });
}
