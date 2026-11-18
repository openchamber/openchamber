import { z } from 'zod';
import { PERMISSION_MODES, isAutoAnsweringMode, isPermissionMode, toPermissionMode } from './modes.js';
import { sessionParentId } from '../session-lineage.js';
import { isJsonObject, isString } from '../event-stream/guards.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { Application } from '../shared/http-contracts.js';
import type { GlobalStreamEvent } from '../event-stream/global-hub.js';
import type { PermissionMode } from './modes.js';
import type { CachedSession, PermissionAutoAcceptOptions, PermissionDirectory, PermissionOutcome, PermissionPolicy, PermissionPolicySnapshot, PermissionRequestHeaders } from './contracts.js';

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

const readStoredPolicy = (value: JsonValue | undefined) => storedPolicySchema.parse(value ?? {});

const createdSessionSchema = z.object({ id: z.string().min(1), parentID: z.string().nullish() });
const forkedSessionSchema = z.object({ sessionID: z.string().min(1), parentID: z.string().min(1) })
  .refine(({ sessionID, parentID }) => sessionID !== parentID);

const hasLegacyEntries = (stored: z.infer<typeof storedPolicySchema>) => Object.values(stored.sessions).some((entry) => entry === true || entry === false);

const normalizePolicy = (value?: JsonValue, legacyEnabledMode: PermissionMode = 'auto') => {
  const stored = readStoredPolicy(value);
  const sessions: PermissionPolicy['sessions'] = {};
  for (const [sessionId, entry] of Object.entries(stored.sessions)) {
    const mode = toPermissionMode(entry, legacyEnabledMode);
    if (mode) sessions[sessionId] = mode;
  }
  return { policy: { sessions, revision: stored.revision }, hadLegacy: hasLegacyEntries(stored) };
};

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const jsonProperty = (value: JsonValue | undefined, key: string) => isJsonObject(value) ? value[key] : undefined;
const isSessionInfo = (value: JsonValue | undefined): value is JsonObject & { id: string; parentID?: JsonValue; metadata?: JsonValue } =>
  isJsonObject(value) && typeof value.id === 'string' && Boolean(value.id);
const isDirectory = (value: PermissionDirectory): value is string => typeof value === 'string' && Boolean(value.trim());
const isSessionId = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const hasMessage = (value: unknown): value is { message: unknown } => value !== null
  && (typeof value === 'object' || typeof value === 'function') && 'message' in value;
const hasNotFoundStatus = (value: unknown): value is { status: 404 } => value !== null
  && (typeof value === 'object' || typeof value === 'function') && 'status' in value && value.status === 404;

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
}: PermissionAutoAcceptOptions) {
  let policy = normalizePolicy().policy;
  let loaded = false;
  let loadPromise: Promise<PermissionPolicySnapshot> | null = null;
  let writePromise: Promise<PermissionPolicySnapshot | void> = Promise.resolve();
  const sessions = new Map<JsonValue, CachedSession>();
  const pendingForkModes = new Map<JsonValue, Promise<void>>();
  const inFlight = new Map<JsonValue, Promise<boolean>>();
  const reconcilePromises = new Map<string, Promise<void>>();
  const outcomes = new Map<JsonValue, Promise<PermissionOutcome>>();

  const snapshot = () => {
    const legacySessions: PermissionPolicySnapshot['sessions'] = {};
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

  const persistUpdate = (update: (current: PermissionPolicy) => PermissionPolicy) => {
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

  const setSessionPolicy = async (sessionId: JsonValue | undefined, mode: JsonValue | undefined, directory?: PermissionDirectory) => {
    if (!isSessionId(sessionId)) throw new TypeError('sessionId is required');
    const next = isPermissionMode(mode) || mode === true || mode === false ? toPermissionMode(mode) : null;
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

  const applyDefaultMode = async (sessionId: string) => {
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

  const rememberSession = (info: JsonValue | undefined, directoryHint: PermissionDirectory, { complete = false } = {}) => {
    if (!isSessionInfo(info)) return;
    const previous = sessions.get(info.id);
    const parentID = sessionParentId(info)
      ?? (previous?.parentID !== undefined ? previous.parentID : (complete ? null : undefined));
    const directory = isString(info.directory) && info.directory
      ? info.directory
      : (isString(jsonProperty(info.location, 'directory')) && jsonProperty(info.location, 'directory')
        ? jsonProperty(info.location, 'directory')
        : previous?.directory ?? directoryHint);
    if (previous) sessions.delete(info.id);
    sessions.set(info.id, { parentID, directory });
    if (sessions.size > SESSION_CACHE_LIMIT) {
      const oldest = sessions.keys().next();
      if (!oldest.done) sessions.delete(oldest.value);
    }
  };

  const request = async (path: string, { directory, method = 'GET', body }: { directory?: PermissionDirectory; method?: string; body?: JsonValue } = {}): Promise<JsonValue> => {
    const url = new URL(buildOpenCodeUrl(path, ''));
    const headers: PermissionRequestHeaders = { Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    if (directory) headers['x-opencode-directory'] = encodeURIComponent(`${directory}`);
    const init: RequestInit = { method, headers: { ...headers, ...getOpenCodeAuthHeaders() } };
    if (body) init.body = JSON.stringify(body);
    init.signal = AbortSignal.timeout(requestTimeoutMs);
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      const error = Object.assign(new Error(`OpenCode request failed (${response.status})`), { status: response.status });
      throw error;
    }
    return response.json().catch(() => null);
  };

  const getSession = async (sessionId: JsonValue, directory?: PermissionDirectory) => {
    const cached = sessions.get(sessionId);
    if (cached && cached.parentID !== undefined) return cached;
    const info = await request(`/api/session/${encodeURIComponent(`${sessionId}`)}`, { directory: directory ?? cached?.directory });
    rememberSession(jsonProperty(info, 'data') ?? info, directory, { complete: true });
    return sessions.get(sessionId) ?? null;
  };

  const resolveLineageMode = async (sessionId: JsonValue, directory?: PermissionDirectory) => {
    await load();
    await writePromise.catch(() => undefined);
    const seen = new Set<JsonValue>();
    let current: JsonValue = sessionId;
    let currentDirectory = directory;
    while (current && !seen.has(current)) {
      await pendingForkModes.get(current);
      if (Object.hasOwn(policy.sessions, `${current}`)) return policy.sessions[`${current}`];
      seen.add(current);
      const info = await getSession(current, currentDirectory);
      current = info?.parentID ?? null;
      currentDirectory = info?.directory ?? currentDirectory;
    }
    return 'ask';
  };

  const inheritForkMode = async (sessionId: string, sourceId: string, directory?: PermissionDirectory) => {
    await load();
    if (Object.hasOwn(policy.sessions, sessionId)) return;
    const mode = await resolveLineageMode(sourceId, directory);
    await persistUpdate((current) => (Object.hasOwn(current.sessions, sessionId) ? current : {
      ...current,
      sessions: { ...current.sessions, [sessionId]: mode },
      revision: current.revision + 1,
    }));
  };

  const resolveSessionMode = (sessionId: JsonValue, directory?: PermissionDirectory) => resolveLineageMode(sessionId, directory).catch((): PermissionMode => 'ask');

  const isSessionAutoAccepting = async (sessionId: JsonValue, directory?: PermissionDirectory) => isAutoAnsweringMode(await resolveSessionMode(sessionId, directory));

  const replyOnce = async (permission: JsonObject, directory: PermissionDirectory) => {
    if (!permission?.id || !permission?.sessionID) return 'ignored';
    const mode = await resolveLineageMode(permission.sessionID, directory);
    if (mode === 'ask') return 'ignored';
    if (mode === 'safety') {
      const verdict = evaluatePermission ? await evaluatePermission(permission, directory) : null;
      if (verdict?.action !== 'accept') return 'held';
    }
    await request(`/api/session/${encodeURIComponent(`${permission.sessionID}`)}/permission/${encodeURIComponent(`${permission.id}`)}/reply`, {
      directory,
      method: 'POST',
      body: { decision: 'once' },
    });
    return 'replied';
  };

  const rememberOutcome = (permissionId: JsonValue, outcome: Promise<PermissionOutcome>) => {
    outcomes.delete(permissionId);
    outcomes.set(permissionId, outcome);
    if (outcomes.size > OUTCOME_CACHE_LIMIT) {
      const oldest = outcomes.keys().next();
      if (!oldest.done) outcomes.delete(oldest.value);
    }
  };

  const processPermission = (permission: JsonValue | undefined, directory?: PermissionDirectory) => {
    if (!isJsonObject(permission) || !permission.id) return Promise.resolve(false);
    const key = permission.id;
    const existing = inFlight.get(key);
    if (existing) return existing;
    const outcome = (async (): Promise<PermissionOutcome> => {
      for (const delay of retryDelaysMs) {
        if (delay > 0) await wait(delay);
        try {
          return await replyOnce(permission, directory);
        } catch (error) {
          if (hasNotFoundStatus(error)) return 'replied';
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

  const isPermissionAutoAnswered = async (sessionId: JsonValue, directory?: PermissionDirectory, permissionId?: JsonValue) => {
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
    const sessionIds = Object.keys(jsonProperty(payload, 'data') ?? {});
    const directories = await Promise.all(sessionIds.map((sessionId) =>
      getSession(sessionId).then((session) => session?.directory ?? null, () => null)));
    return directories.filter((directory) => directory);
  };

  async function reconcilePending({ directories = [] }: { directories?: PermissionDirectory[] } = {}) {
    const normalizedDirectories = Array.from(new Set(
      directories.filter(isDirectory).map((directory) => directory.trim()),
    ));
    const key = normalizedDirectories.length > 0 ? normalizedDirectories.join('\n') : 'all';
    const existing = reconcilePromises.get(key);
    if (existing) return existing;
    const task = (async () => {
      await load();
      const scopes = normalizedDirectories.length > 0
        ? normalizedDirectories
        : Array.from(new Set(await runningSessionDirectories().catch(() => [])));
      const pendingById = new Map<JsonValue, { permission: JsonObject; directory: PermissionDirectory }>();
      for (const directory of scopes) {
        let payload;
        try {
          payload = await request('/api/permission/request', { directory });
        } catch {
          continue;
        }
        const data = jsonProperty(payload, 'data');
        const pending = Array.isArray(payload) ? payload : Array.isArray(data) ? data : null;
        if (!pending) continue;
        for (const permission of pending) {
          if (!isJsonObject(permission) || !permission.id) continue;
          pendingById.set(permission.id, { permission, directory: permission.directory ?? directory });
        }
      }
      await Promise.all(Array.from(pendingById.values()).map(({ permission, directory }) =>
        processPermission(permission, directory)));
    })().finally(() => { reconcilePromises.delete(key); });
    reconcilePromises.set(key, task);
    return task;
  }

  const processEvent = (event: GlobalStreamEvent) => {
    const directory = event.directory !== 'global' ? event.directory : undefined;
    for (const payload of event?.translated?.() ?? []) {
      if (payload.type === 'session.forked') {
        const fork = forkedSessionSchema.safeParse(payload.properties);
        if (!fork.success || pendingForkModes.has(fork.data.sessionID)) continue;
        const { sessionID, parentID } = fork.data;
        const task = inheritForkMode(sessionID, parentID, directory)
          .finally(() => { pendingForkModes.delete(sessionID); });
        pendingForkModes.set(sessionID, task);
        void task.catch((error) => {
          console.warn('[permission-auto-accept] failed to inherit the fork mode:', (hasMessage(error) ? error.message : undefined) ?? error);
        });
        continue;
      }
      if (payload.type === 'session.created' || payload.type === 'session.updated') {
        const info = payload.properties?.info;
        rememberSession(info, directory ?? payload.properties?.directory, { complete: payload.type === 'session.created' });
        const created = payload.type === 'session.created' ? createdSessionSchema.safeParse(info) : null;
        if (created?.success && !created.data.parentID) {
          void applyDefaultMode(created.data.id).catch((error) => {
            console.warn('[permission-auto-accept] failed to apply the default mode:', (hasMessage(error) ? error.message : undefined) ?? error);
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
        if (isString(permissionId) && permissionId) onPermissionReplied?.(permissionId);
      }
    }
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') void reconcilePending();
    });
    void load().then(() => reconcilePending()).catch((error) => {
      console.warn('[permission-auto-accept] failed to load policy:', (hasMessage(error) ? error.message : undefined) ?? error);
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
    forgetSession: (sessionId: JsonValue) => sessions.delete(sessionId),
    start,
  };
}

export type PermissionAutoAcceptRuntime = ReturnType<typeof createPermissionAutoAcceptRuntime>;

export function registerPermissionAutoAcceptRoutes(app: Application, runtime: PermissionAutoAcceptRuntime) {
  app.get('/api/permission-auto-accept', async (_req, res) => {
    try {
      res.json(await runtime.load());
    } catch (error) {
      res.status(500).json({ error: (hasMessage(error) ? error.message : undefined) ?? 'Failed to load permission auto-accept policy' });
    }
  });

  app.put<JsonValue>('/api/permission-auto-accept/sessions/:sessionId', async (req, res) => {
    try {
      const body = isJsonObject(req.body) ? req.body : undefined;
      const directory = isString(body?.directory) ? body.directory : undefined;
      const mode = body?.mode ?? body?.enabled;
      res.json(await runtime.setSessionPolicy(req.params.sessionId, mode, directory));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: hasMessage(error) ? error.message : undefined });
    }
  });
}
