function clonePolicies(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('policies must be an object');
  }
  const policies = {};
  for (const [sessionId, enabled] of Object.entries(value)) {
    if (!sessionId || typeof enabled !== 'boolean') {
      throw new TypeError('policies must contain boolean values');
    }
    policies[sessionId] = enabled;
  }
  return policies;
}

export function createBackgroundAutoAcceptRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  broadcastGlobalUiEvent,
  fetchImpl = fetch,
}) {
  let enabled = false;
  let policies = {};
  const sessions = new Map();
  const attempted = new Set();

  const snapshot = () => ({ enabled });

  const rememberSession = (info, directoryHint) => {
    if (!info?.id) return;
    sessions.set(info.id, {
      parentID: typeof info.parentID === 'string' ? info.parentID : null,
      directory: info.directory || directoryHint,
    });
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
    });
    if (!response.ok) throw new Error(`OpenCode request failed (${response.status})`);
    return response.json().catch(() => null);
  };

  const getSession = async (sessionId, directory) => {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    try {
      const info = await request(`/session/${encodeURIComponent(sessionId)}`, { directory });
      rememberSession(info, directory);
      return sessions.get(sessionId) ?? null;
    } catch {
      return null;
    }
  };

  const matchesPolicy = async (sessionId, directory) => {
    const seen = new Set();
    let current = sessionId;
    while (current && !seen.has(current)) {
      if (Object.hasOwn(policies, current)) return policies[current];
      seen.add(current);
      const info = await getSession(current, directory);
      current = info?.parentID ?? null;
      directory = info?.directory ?? directory;
    }
    return false;
  };

  const reply = async (permission, directory) => {
    const requestId = permission?.id;
    const sessionId = permission?.sessionID;
    if (!enabled || !requestId || !sessionId || attempted.has(requestId)) return;
    if (!(await matchesPolicy(sessionId, directory)) || !enabled) return;
    attempted.add(requestId);
    try {
      await request(`/permission/${encodeURIComponent(requestId)}/reply`, {
        directory,
        method: 'POST',
        body: { reply: 'once' },
      });
    } catch (error) {
      console.warn('[background-auto-accept] permission reply failed:', error?.message ?? error);
    }
  };

  const setEnabled = ({ enabled: nextEnabled, policies: nextPolicies }) => {
    if (typeof nextEnabled !== 'boolean') throw new TypeError('enabled must be a boolean');
    if (nextEnabled === enabled) return snapshot();
    policies = nextEnabled ? clonePolicies(nextPolicies) : {};
    enabled = nextEnabled;
    broadcastGlobalUiEvent({
      type: 'openchamber:background-auto-accept',
      properties: { enabled },
    });
    if (enabled) {
      globalEventHub.start();
    }
    return snapshot();
  };

  const setSessionPolicy = ({ sessionId, enabled: sessionEnabled }) => {
    if (!enabled) return false;
    if (!sessionId || typeof sessionEnabled !== 'boolean') throw new TypeError('invalid session policy');
    policies[sessionId] = sessionEnabled;
    return true;
  };

  const processEvent = (event) => {
    const { payload, directory } = event;
    if (payload.type === 'session.created' || payload.type === 'session.updated') {
      rememberSession(payload.properties.info, directory);
    } else if (payload.type === 'permission.asked') {
      void reply(payload.properties, directory);
    }
  };

  const start = () => globalEventHub.subscribeEvent(processEvent);

  return { snapshot, setEnabled, setSessionPolicy, start };
}

export function registerBackgroundAutoAcceptRoutes(app, runtime) {
  app.get('/api/background-auto-accept', (_req, res) => res.json(runtime.snapshot()));

  app.put('/api/background-auto-accept', (req, res) => {
    try {
      res.json(runtime.setEnabled(req.body ?? {}));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error?.message });
    }
  });

  app.put('/api/background-auto-accept/sessions/:sessionId', (req, res) => {
    try {
      const updated = runtime.setSessionPolicy({
        sessionId: req.params.sessionId,
        enabled: req.body?.enabled,
      });
      res.status(updated ? 200 : 409).json({ enabled: updated });
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error?.message });
    }
  });
}
