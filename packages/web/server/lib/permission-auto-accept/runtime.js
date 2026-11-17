import { z } from 'zod';
import { PERMISSION_MODES, isAutoAnsweringMode, isPermissionMode, toPermissionMode } from './modes.js';
import { sessionParentId } from '../session-lineage.js';

const SETTINGS_KEY = 'permissionAutoAccept';
const DEFAULT_MODE_SETTINGS_KEY = 'permissionDefaultMode';
const RETRY_DELAYS_MS = [0, 250, 1000];
const REQUEST_TIMEOUT_MS = 5000;
const SESSION_CACHE_LIMIT = 10000;
const OUTCOME_CACHE_LIMIT = 1000;

const storedEntrySchema = z.union([z.boolean(), z.enum(PERMISSION_MODES)]).nullable().catch(null);
const storedPolicySchema = z.object({
  sessions: z.record(z.string().min(1), storedEntrySchema).catch({}).default({}),
  revision: z.number().int().nonnegative().catch(0).default(0),
}).catch({ sessions: {}, revision: 0 });

const readStoredPolicy = (value) => storedPolicySchema.parse(value ?? {});

const createdSessionSchema = z.object({ id: z.string().min(1), parentID: z.string().nullish() });
const forkedSessionSchema = z.object({ sessionID: z.string().min(1), parentID: z.string().min(1) })
  .refine(({ sessionID, parentID }) => sessionID !== parentID);

const hasLegacyEntries = (stored) => Object.values(stored.sessions).some((entry) => entry === true || entry === false);

const normalizePolicy = (value, legacyEnabledMode = 'auto') => {
  const stored = readStoredPolicy(value);
  const sessions = {};
  for (const [sessionId, entry] of Object.entries(stored.sessions)) {
    const mode = toPermissionMode(entry, legacyEnabledMode);
    if (mode) sessions[sessionId] = mode;
  }
  return { policy: { sessions, revision: stored.revision }, hadLegacy: hasLegacyEntries(stored) };
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createPermissionAutoAcceptRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent,
  evaluatePermission = null,
  onPermissionReplied = null,
  resolveLegacyEnabledMode = async () => 'auto',
  readDefaultMode = async () => (await readSettingsFromDiskMigrated())?.[DEFAULT_MODE_SETTINGS_KEY],
  fetchImpl = fetch,
  retryDelaysMs = RETRY_DELAYS_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}) {
  let policy = normalizePolicy().policy;
  let loaded = false;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  const sessions = new Map();
  const pendingForkModes = new Map();
  const inFlight = new Map();
  const reconcilePromises = new Map();
  const outcomes = new Map();

  const snapshot = () => {
    const legacySessions = {};
    for (const [sessionId, mode] of Object.entries(policy.sessions)) legacySessions[sessionId] = isAutoAnsweringMode(mode);
    return { sessions: legacySessions, modes: { ...policy.sessions }, revision: policy.revision };
  };

  const readPolicy = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.[SETTINGS_KEY];
    const legacyEnabledMode = hasLegacyEntries(readStoredPolicy(stored)) ? await resolveLegacyEnabledMode() : 'auto';
    const { policy: next, hadLegacy } = normalizePolicy(stored, legacyEnabledMode);
    if (hadLegacy) await persistSettings({ [SETTINGS_KEY]: next });
    return next;
  };

  const load = async () => {
    if (loaded) return snapshot();
    if (!loadPromise) {
      loadPromise = readPolicy()
        .then((next) => {
          policy = next;
          loaded = true;
          return snapshot();
        })
        .finally(() => { loadPromise = null; });
    }
    return loadPromise;
  };

  const persistUpdate = (update) => {
    const result = writePromise.then(async () => {
      const next = update(policy);
      await persistSettings({ [SETTINGS_KEY]: next });
      policy = next;
      loaded = true;
      broadcastGlobalUiEvent?.({
        type: 'openchamber:permission-auto-accept.updated',
        properties: snapshot(),
      });
      return snapshot();
    });
    writePromise = result.catch(() => {});
    return result;
  };

  const setSessionPolicy = async (sessionId, mode, directory) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('sessionId is required');
    const next = toPermissionMode(mode);
    if (!next) throw new TypeError('mode must be ask, safety or auto');
    await load();
    const result = await persistUpdate((current) => ({
      ...current,
      sessions: { ...current.sessions, [sessionId.trim()]: next },
      revision: current.revision + 1,
    }));
    if (isAutoAnsweringMode(next)) await reconcilePending({ directories: [directory] });
    return result;
  };

  const applyDefaultMode = async (sessionId) => {
    await load();
    if (Object.hasOwn(policy.sessions, sessionId)) return;
    const mode = await readDefaultMode();
    if (!isPermissionMode(mode) || mode === 'ask') return;
    await persistUpdate((current) => (Object.hasOwn(current.sessions, sessionId) ? current : {
      ...current,
      sessions: { ...current.sessions, [sessionId]: mode },
      revision: current.revision + 1,
    }));
  };

  const rememberSession = (info, directoryHint, { complete = false } = {}) => {
    if (!info || typeof info.id !== 'string' || !info.id) return;
    const previous = sessions.get(info.id);
    const parentID = sessionParentId(info)
      ?? (previous?.parentID !== undefined ? previous.parentID : (complete ? null : undefined));
    // external: https://github.com/anomalyco/opencode OpenCode v2 keeps a session's directory on `location`; translated events already flatten it.
    const directory = typeof info.directory === 'string' && info.directory
      ? info.directory
      : (typeof info.location?.directory === 'string' && info.location.directory
        ? info.location.directory
        : previous?.directory ?? directoryHint);
    if (previous) sessions.delete(info.id);
    sessions.set(info.id, { parentID, directory });
    if (sessions.size > SESSION_CACHE_LIMIT) {
      sessions.delete(sessions.keys().next().value);
    }
  };

  const request = async (path, { directory, method = 'GET', body } = {}) => {
    const url = new URL(buildOpenCodeUrl(path, ''));
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        // external: https://github.com/anomalyco/opencode OpenCode 2.x scopes a request to a directory with this header; the pending-permission list and services behind it are per location.
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory) } : {}),
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
    if (cached && cached.parentID !== undefined) return cached;
    const info = await request(`/api/session/${encodeURIComponent(sessionId)}`, { directory: directory ?? cached?.directory });
    rememberSession(info?.data ?? info, directory, { complete: true });
    return sessions.get(sessionId) ?? null;
  };

  const resolveLineageMode = async (sessionId, directory) => {
    await load();
    await writePromise.catch(() => undefined);
    const seen = new Set();
    let current = sessionId;
    let currentDirectory = directory;
    while (current && !seen.has(current)) {
      await pendingForkModes.get(current);
      if (Object.hasOwn(policy.sessions, current)) return policy.sessions[current];
      seen.add(current);
      const info = await getSession(current, currentDirectory);
      current = info?.parentID ?? null;
      currentDirectory = info?.directory ?? currentDirectory;
    }
    return 'ask';
  };

  const inheritForkMode = async (sessionId, sourceId, directory) => {
    await load();
    if (Object.hasOwn(policy.sessions, sessionId)) return;
    const mode = await resolveLineageMode(sourceId, directory);
    await persistUpdate((current) => (Object.hasOwn(current.sessions, sessionId) ? current : {
      ...current,
      sessions: { ...current.sessions, [sessionId]: mode },
      revision: current.revision + 1,
    }));
  };

  const resolveSessionMode = (sessionId, directory) => resolveLineageMode(sessionId, directory).catch(() => 'ask');

  const isSessionAutoAccepting = async (sessionId, directory) => isAutoAnsweringMode(await resolveSessionMode(sessionId, directory));

  const replyOnce = async (permission, directory) => {
    if (!permission?.id || !permission?.sessionID) return 'ignored';
    const mode = await resolveLineageMode(permission.sessionID, directory);
    if (mode === 'ask') return 'ignored';
    if (mode === 'safety') {
      const verdict = evaluatePermission ? await evaluatePermission(permission, directory) : null;
      if (verdict?.action !== 'accept') return 'held';
    }
    await request(`/api/session/${encodeURIComponent(permission.sessionID)}/permission/${encodeURIComponent(permission.id)}/reply`, {
      directory,
      method: 'POST',
      // external: https://github.com/anomalyco/opencode OpenCode 2.0.8 renamed the reply body field reply to decision.
      body: { decision: 'once' },
    });
    return 'replied';
  };

  const rememberOutcome = (permissionId, outcome) => {
    outcomes.delete(permissionId);
    outcomes.set(permissionId, outcome);
    if (outcomes.size > OUTCOME_CACHE_LIMIT) outcomes.delete(outcomes.keys().next().value);
  };

  const processPermission = (permission, directory) => {
    if (!permission?.id) return Promise.resolve(false);
    const key = permission.id;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const outcome = (async () => {
      for (const delay of retryDelaysMs) {
        if (delay > 0) await wait(delay);
        try {
          return await replyOnce(permission, directory);
        } catch (error) {
          if (error?.status === 404) return 'replied';
        }
      }
      return 'failed';
    })();
    rememberOutcome(key, outcome);
    void outcome.then((result) => {
      if (result !== 'held' && result !== 'failed') return;
      broadcastGlobalUiEvent?.({
        type: 'openchamber:permission-auto-accept.left-for-user',
        properties: { permissionId: key, sessionId: permission.sessionID, directory: directory ?? null },
      });
    });
    const task = outcome.then((result) => result !== 'ignored' && result !== 'failed').finally(() => inFlight.delete(key));
    inFlight.set(key, task);
    return task;
  };

  const isPermissionAutoAnswered = async (sessionId, directory, permissionId) => {
    const wasReplied = async () => {
      const outcome = permissionId ? outcomes.get(permissionId) : undefined;
      return outcome ? (await outcome) === 'replied' : false;
    };
    let mode;
    try {
      mode = await resolveLineageMode(sessionId, directory);
    } catch {
      return wasReplied();
    }
    if (mode === 'auto') return true;
    if (mode === 'ask') return false;
    return wasReplied();
  };

  const runningSessionDirectories = async () => {
    const payload = await request('/api/session/active');
    const sessionIds = Object.keys(payload?.data ?? {});
    const directories = await Promise.all(sessionIds.map((sessionId) =>
      getSession(sessionId).then((session) => session?.directory ?? null, () => null)));
    return directories.filter((directory) => directory);
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
      const scopes = normalizedDirectories.length > 0
        ? normalizedDirectories
        : Array.from(new Set(await runningSessionDirectories().catch(() => [])));
      const pendingById = new Map();
      for (const directory of scopes) {
        let payload;
        try {
          payload = await request('/api/permission/request', { directory });
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
    const directory = typeof event?.directory === 'string' && event.directory !== 'global' ? event.directory : undefined;
    for (const payload of event?.translated?.() ?? []) {
      if (payload.type === 'session.forked') {
        const fork = forkedSessionSchema.safeParse(payload.properties);
        if (!fork.success || pendingForkModes.has(fork.data.sessionID)) continue;
        const { sessionID, parentID } = fork.data;
        const task = inheritForkMode(sessionID, parentID, directory)
          .finally(() => { pendingForkModes.delete(sessionID); });
        pendingForkModes.set(sessionID, task);
        void task.catch((error) => {
          console.warn('[permission-auto-accept] failed to inherit the fork mode:', error?.message ?? error);
        });
        continue;
      }
      if (payload.type === 'session.created' || payload.type === 'session.updated') {
        const info = payload.properties?.info;
        rememberSession(info, directory ?? payload.properties?.directory, { complete: payload.type === 'session.created' });
        const created = payload.type === 'session.created' ? createdSessionSchema.safeParse(info) : null;
        if (created?.success && !created.data.parentID) {
          void applyDefaultMode(created.data.id).catch((error) => {
            console.warn('[permission-auto-accept] failed to apply the default mode:', error?.message ?? error);
          });
        }
        continue;
      }
      if (payload.type === 'permission.asked') {
        void processPermission(payload.properties, directory ?? payload.properties?.directory);
        continue;
      }
      if (payload.type === 'permission.replied') {
        const permissionId = payload.properties?.requestID;
        if (typeof permissionId === 'string' && permissionId) onPermissionReplied?.(permissionId);
      }
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
    setSessionPolicy,
    resolveSessionMode,
    isSessionAutoAccepting,
    isPermissionAutoAnswered,
    processPermission,
    reconcilePending,
    forgetSession: (sessionId) => sessions.delete(sessionId),
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
      const mode = req.body?.mode ?? req.body?.enabled;
      res.json(await runtime.setSessionPolicy(req.params.sessionId, mode, directory));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error?.message });
    }
  });
}
