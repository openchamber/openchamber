import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { PERMISSION_MODES, isAutoAnsweringMode, isPermissionMode, toPermissionMode } from './modes.js';

const SETTINGS_KEY = 'permissionAutoAccept';
const DEFAULT_MODE_SETTINGS_KEY = 'permissionDefaultMode';
const RETRY_DELAYS_MS = [0, 250, 1000];
const REQUEST_TIMEOUT_MS = 5000;
const REVIEW_TIMEOUT_MS = 25000;
const SESSION_CACHE_LIMIT = 10000;
const OUTCOME_CACHE_LIMIT = 1000;

// A stored entry is a mode, or a boolean from before the modes existed; an
// entry that is neither is dropped rather than failing the whole policy.
const storedEntrySchema = z.union([z.boolean(), z.enum(PERMISSION_MODES)]).nullable().catch(null);
const storedPolicySchema = z.object({
  sessions: z.record(z.string().min(1), storedEntrySchema).catch({}).default({}),
  revision: z.number().int().nonnegative().catch(0).default(0),
}).catch({ sessions: {}, revision: 0 });

const readStoredPolicy = (value) => storedPolicySchema.parse(value ?? {});

const createdSessionSchema = z.object({ id: z.string().min(1), parentID: z.string().nullish() });

const hasLegacyEntries = (stored) => Object.values(stored.sessions).some((entry) => entry === true || entry === false);

/**
 * `sessions` maps a session id to its mode. Returns whether any entry was a
 * pre-modes boolean, so the caller can persist the converted policy once.
 */
const normalizePolicy = (value, legacyEnabledMode = 'auto') => {
  const stored = readStoredPolicy(value);
  const sessions = {};
  for (const [sessionId, entry] of Object.entries(stored.sessions)) {
    const mode = toPermissionMode(entry, legacyEnabledMode);
    if (mode) sessions[sessionId] = mode;
  }
  return { policy: { sessions, revision: stored.revision }, hadLegacy: hasLegacyEntries(stored) };
};

export function createPermissionAutoAcceptRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  readSettingsFromDiskMigrated,
  persistSettings,
  broadcastGlobalUiEvent,
  broadcastPermissionReviewEvent,
  // The routing safety net, asked once per request in a `safety` session.
  // `accept` replies; anything else leaves the request for the user. Absent
  // means `safety` sessions wait for the user on every request.
  evaluatePermission = null,
  onPermissionReplied = null,
  // What a pre-modes `true` becomes: `safety` when the old global safety-net
  // switch was on, else `auto`. Asked only while converting such a policy.
  resolveLegacyEnabledMode = async () => 'auto',
  fetchImpl = fetch,
  retryDelaysMs = RETRY_DELAYS_MS,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  reviewTimeoutMs = REVIEW_TIMEOUT_MS,
  now = () => performance.now(),
}) {
  if (!z.function().safeParse(broadcastPermissionReviewEvent).success) {
    throw new TypeError('broadcastPermissionReviewEvent is required');
  }
  if (!Number.isFinite(reviewTimeoutMs) || reviewTimeoutMs <= 0 || reviewTimeoutMs > REVIEW_TIMEOUT_MS) {
    throw new TypeError('reviewTimeoutMs must be positive and at most 25000');
  }
  let policy = normalizePolicy().policy;
  let loaded = false;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  const sessions = new Map();
  const inFlight = new Map();
  const reconcilePromises = new Map();
  // What the runtime did with each recent request, so notifications can tell a
  // request the safety net held (the user must hear about it) from one it
  // accepted.
  const outcomes = new Map();
  const reviews = new Map();
  const manual = new Map();
  let reviewRevision = 0;
  const instanceId = randomUUID();
  let stopped = false;

  const reviewSnapshot = () => {
    const at = now();
    const permissions = [];
    for (const [permissionId, review] of reviews) {
      const remainingMs = Math.min(reviewTimeoutMs, review.deadline - at);
      if (remainingMs > 0) permissions.push({ permissionId, remainingMs, phase: review.phase });
    }
    for (const permissionId of manual.keys()) permissions.push({ permissionId, remainingMs: 0, phase: 'manual' });
    return { dispositionVersion: 1, instanceId, revision: reviewRevision, permissions };
  };

  const publishReview = () => {
    reviewRevision += 1;
    broadcastPermissionReviewEvent({ type: 'openchamber:permission-review.updated', properties: reviewSnapshot() });
  };

  const endReview = (permissionId) => {
    const review = reviews.get(permissionId);
    if (!review) return;
    clearTimeout(review.timer);
    reviews.delete(permissionId);
    manual.set(permissionId, true);
    if (manual.size > OUTCOME_CACHE_LIMIT) manual.delete(manual.keys().next().value);
    publishReview();
  };

  const beginReview = (permissionId, operation) => {
    manual.delete(permissionId);
    clearTimeout(reviews.get(permissionId)?.timer);
    operation.deadline = now() + reviewTimeoutMs;
    const timer = setTimeout(() => {
      if (reviews.get(permissionId)?.phase !== 'answered') {
        console.warn('[permission-auto-accept] review lease expired', { permissionId });
        operation.cancel();
      }
      if (reviews.get(permissionId)?.phase === 'answered') {
        reviews.delete(permissionId);
        publishReview();
      } else endReview(permissionId);
    }, reviewTimeoutMs);
    timer.unref?.();
    reviews.set(permissionId, { deadline: operation.deadline, timer, phase: 'admitting' });
    publishReview();
  };

  const setReviewPhase = (permissionId, phase) => {
    const review = reviews.get(permissionId);
    if (!review || review.phase === phase) return;
    review.phase = phase;
    publishReview();
  };

  const recordAnswered = (permissionId) => {
    manual.delete(permissionId);
    if (reviews.has(permissionId)) return setReviewPhase(permissionId, 'answered');
    const timer = setTimeout(() => { reviews.delete(permissionId); publishReview(); }, reviewTimeoutMs);
    timer.unref?.();
    reviews.set(permissionId, { deadline: now() + reviewTimeoutMs, timer, phase: 'answered' });
    publishReview();
  };

  // `sessions` keeps the on/off shape clients from before the modes read;
  // `modes` is the policy itself.
  const snapshot = () => {
    const legacySessions = {};
    for (const [sessionId, mode] of Object.entries(policy.sessions)) legacySessions[sessionId] = isAutoAnsweringMode(mode);
    return { sessions: legacySessions, modes: { ...policy.sessions }, revision: policy.revision, review: reviewSnapshot() };
  };

  const readPolicy = async () => {
    const settings = await readSettingsFromDiskMigrated();
    const stored = settings?.[SETTINGS_KEY];
    const legacyEnabledMode = hasLegacyEntries(readStoredPolicy(stored)) ? await resolveLegacyEnabledMode() : 'auto';
    const { policy: next, hadLegacy } = normalizePolicy(stored, legacyEnabledMode);
    // Converted once: the answer to "was the safety net on" is gone after the
    // routing config is next saved.
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
    writePromise = writePromise.then(async () => {
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
    return writePromise;
  };

  /**
   * `mode` is a permission mode; a boolean is accepted from callers that only
   * know on/off (clients from before the modes, scheduled tasks) and means
   * `auto` or `ask`.
   */
  const setSessionPolicy = async (sessionId, mode, directory) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('sessionId is required');
    const next = toPermissionMode(mode);
    if (!next) throw new TypeError('mode must be ask, safety or auto');
    await load();
    await persistUpdate((current) => ({
      ...current,
      sessions: { ...current.sessions, [sessionId.trim()]: next },
      revision: current.revision + 1,
    }));
    if (next === 'ask') {
      await Promise.all(Array.from(inFlight.values(), async (operation) => {
        let revision;
        let currentMode;
        do {
          revision = policy.revision;
          currentMode = await resolveSessionMode(operation.sessionId, operation.directory);
        } while (revision !== policy.revision);
        if (currentMode === 'ask') operation.cancel();
      }));
    }
    if (isAutoAnsweringMode(next)) await reconcilePending({ directories: [directory], retry: true });
    return snapshot();
  };

  /**
   * A new top-level session starts in the default mode from Settings. Written
   * once, at creation, so changing the default never reaches back into older
   * sessions; a policy the creating flow already set wins. Subagents inherit
   * from their parent instead.
   */
  const applyDefaultMode = async (sessionId) => {
    await load();
    if (Object.hasOwn(policy.sessions, sessionId)) return;
    const settings = await readSettingsFromDiskMigrated();
    const mode = settings?.[DEFAULT_MODE_SETTINGS_KEY];
    if (!isPermissionMode(mode) || mode === 'ask') return;
    await persistUpdate((current) => (Object.hasOwn(current.sessions, sessionId) ? current : {
      ...current,
      sessions: { ...current.sessions, [sessionId]: mode },
      revision: current.revision + 1,
    }));
  };

  const rememberSession = (info, directoryHint) => {
    if (!info || typeof info.id !== 'string' || !info.id) return;
    // v2 session updates are partial (a rename carries only the title), so a
    // field the update does not name keeps what an earlier record said.
    const previous = sessions.get(info.id);
    const parentID = typeof info.parentID === 'string' && info.parentID ? info.parentID : previous?.parentID ?? null;
    // v2 keeps the directory on `location`; translated events already flatten it.
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
        // OpenCode 2.x scopes a request to a directory through this header;
        // the pending-permission list and services behind it are per location.
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
    if (cached) return cached;
    const info = await request(`/api/session/${encodeURIComponent(sessionId)}`, { directory });
    rememberSession(info?.data ?? info, directory);
    return sessions.get(sessionId) ?? null;
  };

  /** The nearest explicit mode up the session's lineage; unknown lineage fails closed to `ask`. */
  const resolveSessionMode = async (sessionId, directory) => {
    await load();
    // A default being written for a just-created session must be visible to
    // its first permission request.
    await writePromise.catch(() => undefined);
    const seen = new Set();
    let current = sessionId;
    let currentDirectory = directory;
    while (current && !seen.has(current)) {
      if (Object.hasOwn(policy.sessions, current)) return policy.sessions[current];
      seen.add(current);
      let info;
      try {
        info = await getSession(current, currentDirectory);
      } catch {
        return 'ask';
      }
      current = info?.parentID ?? null;
      currentDirectory = info?.directory ?? currentDirectory;
    }
    return 'ask';
  };

  const isSessionAutoAccepting = async (sessionId, directory) => isAutoAnsweringMode(await resolveSessionMode(sessionId, directory));

  /** `replied`, `held` (left for the user by the safety net), or `ignored` (an `ask` session). */
  const replyOnce = async (permission, directory, operation) => {
    operation.replyAttempted = false;
    if (!permission?.id || !permission?.sessionID) return 'ignored';
    const mode = await resolveSessionMode(permission.sessionID, directory);
    if (operation.cancelled) return 'held';
    if (mode === 'ask') return 'ignored';
    if (mode === 'safety') {
      if (!evaluatePermission) return 'held';
      if (!operation.accepted) {
        setReviewPhase(permission.id, 'reviewing');
        // Classifier errors are not reply errors, especially a provider 404.
        const verdict = await evaluatePermission(permission, directory, operation.controller.signal);
        if (verdict?.action !== 'accept') return 'held';
        operation.accepted = true;
      }
    }
    // Classification and lineage lookup both yield. Re-read committed policy,
    // then check the lease synchronously before sending, even if its timer has
    // not run yet. A policy write during lookup requires another read.
    if (operation.cancelled) return 'held';
    let revision;
    let currentMode;
    do {
      revision = policy.revision;
      currentMode = await resolveSessionMode(permission.sessionID, directory);
    } while (revision !== policy.revision);
    if (currentMode === 'ask' || (currentMode === 'safety' && !operation.accepted)
      || (operation.deadline !== null && now() >= operation.deadline)) operation.cancel();
    if (operation.cancelled) return 'held';
    // v2 scopes a permission reply under its session.
    operation.replyAttempted = true;
    try {
      await request(`/api/session/${encodeURIComponent(permission.sessionID)}/permission/${encodeURIComponent(permission.id)}/reply`, {
        directory,
        method: 'POST',
        // OpenCode 2.0.8 renamed the reply body field `reply` to `decision`.
        body: { decision: 'once' },
      });
    } catch (error) {
      if (error?.status === 404) return 'replied';
      throw error;
    }
    return 'replied';
  };

  const rememberOutcome = (permissionId, outcome) => {
    outcomes.delete(permissionId);
    outcomes.set(permissionId, outcome);
    if (outcomes.size > OUTCOME_CACHE_LIMIT) outcomes.delete(outcomes.keys().next().value);
  };

  /** Resolves to whether the request was handled here (replied to, or deliberately held). */
  const processPermission = (permission, directory, { retry = false } = {}) => {
    if (stopped || !permission?.id || !permission?.sessionID) return Promise.resolve(false);
    const key = permission.id;
    const existing = inFlight.get(key);
    if (existing) return existing.task;
    if (reviews.get(key)?.phase === 'answered') return Promise.resolve(true);
    if (!retry && outcomes.has(key)) return outcomes.get(key).then((result) => result !== 'ignored' && result !== 'failed');
    let resolveCancellation;
    const cancellation = new Promise((resolve) => { resolveCancellation = resolve; });
    const operation = {
      cancelled: false,
      accepted: false,
      replyAttempted: false,
      controller: new AbortController(),
      deadline: null,
      sessionId: permission.sessionID,
      directory,
      cancel: (result = 'held') => {
        operation.cancelled = true;
        operation.controller.abort();
        if (result === 'replied') setReviewPhase(key, 'answered');
        else endReview(key);
        resolveCancellation(result);
      },
    };
    // Admission is synchronous with pending delivery, before policy lookup yields.
    // Its deadline covers every phase and is never renewed by retries or reads.
    beginReview(key, operation);
    const processing = (async () => {
      for (const delay of retryDelaysMs) {
        if (delay > 0) {
          let timer;
          try {
            await Promise.race([new Promise((resolve) => { timer = setTimeout(resolve, delay); }), cancellation]);
          } finally {
            clearTimeout(timer);
          }
        }
        if (operation.cancelled) return 'held';
        try {
          return await replyOnce(permission, directory, operation);
        } catch (error) {
          if (operation.cancelled) return 'held';
          const status = z.number().int().min(100).max(599).safeParse(error?.status);
          // Provider/fetch error text may contain credentials or request data.
          // Report trusted HTTP status and standard failure categories instead.
          const message = status.success ? `Upstream returned HTTP ${status.data}`
            : error?.name === 'TimeoutError' ? 'Upstream request timed out'
              : error?.name === 'AbortError' ? 'Upstream request aborted'
                : 'Upstream operation failed; untrusted error text withheld';
          console.warn('[permission-auto-accept] permission processing failed', {
            permissionId: key,
            sessionId: permission.sessionID,
            status: status.success ? status.data : null,
            message,
          });
          // A failed evaluation exposes the request immediately. Only an
          // accepted verdict or auto mode may retry the reply.
          if (!operation.replyAttempted) return 'failed';
        }
      }
      return 'failed';
    })();
    const outcome = Promise.race([processing, cancellation]).then((result) => {
      if (result === 'replied') setReviewPhase(key, 'answered');
      else endReview(key);
      return result;
    });
    rememberOutcome(key, outcome);
    const task = outcome.then((result) => result !== 'ignored' && result !== 'failed').finally(() => inFlight.delete(key));
    operation.task = task;
    inFlight.set(key, operation);
    return task;
  };

  /**
   * Whether the user can skip hearing about this request: it was, or is being,
   * answered automatically. A held or unanswered request is not.
   */
  const isPermissionAutoAnswered = async (sessionId, directory, permissionId) => {
    const mode = await resolveSessionMode(sessionId, directory);
    if (mode === 'auto') return true;
    if (mode === 'ask') return false;
    const outcome = permissionId ? outcomes.get(permissionId) : undefined;
    return outcome ? (await outcome) === 'replied' : false;
  };

  async function reconcilePending({ directories = [], retry = false } = {}) {
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
        processPermission(permission, directory, { retry })));
    })().finally(() => { reconcilePromises.delete(key); });
    reconcilePromises.set(key, task);
    return task;
  }

  const processEvent = (event) => {
    const directory = typeof event?.directory === 'string' && event.directory !== 'global' ? event.directory : undefined;
    for (const payload of event?.translated?.() ?? []) {
      if (payload.type === 'session.created' || payload.type === 'session.updated') {
        const info = payload.properties?.info;
        rememberSession(info, directory ?? payload.properties?.directory);
        const created = payload.type === 'session.created' ? createdSessionSchema.safeParse(info) : null;
        if (created?.success && !created.data.parentID) {
          void applyDefaultMode(created.data.id).catch((error) => {
            console.warn('[permission-auto-accept] failed to apply the default mode:', error?.message ?? error);
          });
        }
        continue;
      }
      // A v2 permission request is `{ id, sessionID, action, resources, ... }`;
      // only the id and session id are used to reply.
      if (payload.type === 'permission.asked') {
        void processPermission(payload.properties, directory ?? payload.properties?.directory);
        continue;
      }
      // The authoritative event can beat our own POST response. Settle as
      // replied so notifications do not mistake that success for a hold.
      if (payload.type === 'permission.replied') {
        const permissionId = payload.properties?.requestID;
        if (typeof permissionId === 'string' && permissionId) {
          inFlight.get(permissionId)?.cancel('replied');
          recordAnswered(permissionId);
          onPermissionReplied?.(permissionId);
        }
      }
    }
  };

  const start = () => {
    stopped = false;
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') void reconcilePending();
    });
    void load().then(() => reconcilePending()).catch((error) => {
      console.warn('[permission-auto-accept] failed to load policy:', error?.message ?? error);
    });
    return () => {
      stopped = true;
      for (const operation of inFlight.values()) operation.cancel();
      for (const permissionId of reviews.keys()) endReview(permissionId);
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  return {
    async dispositions(requests) {
      await Promise.all(requests.map(async ({ id, sessionID, directory }) => {
        if (reviews.has(id) || manual.has(id)) return;
        let permission;
        try {
          const response = await request(`/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(id)}`, { directory });
          permission = response?.data ?? response;
          if (permission?.id !== id || permission?.sessionID !== sessionID) throw new Error('Invalid pending permission response');
        } catch (error) {
          if (error?.status === 404) { recordAnswered(id); return; }
          throw error;
        }
        // A reply or classification may have completed during the upstream read.
        if (reviews.has(id) || manual.has(id)) return;
        const mode = await resolveSessionMode(sessionID, directory);
        if (reviews.has(id) || manual.has(id)) return;
        if (mode === 'ask' || (mode === 'safety' && !evaluatePermission)) {
          manual.set(id, true);
          if (manual.size > OUTCOME_CACHE_LIMIT) manual.delete(manual.keys().next().value);
          publishReview();
        } else void processPermission(permission, directory);
      }));
      return reviewSnapshot();
    },
    snapshot,
    load,
    setSessionPolicy,
    resolveSessionMode,
    isSessionAutoAccepting,
    isPermissionAutoAnswered,
    processPermission,
    reconcilePending,
    start,
  };
}

export function registerPermissionAutoAcceptRoutes(app, runtime) {
  app.post('/api/permission-auto-accept/dispositions', async (req, res) => {
    const parsed = z.object({ requests: z.array(z.object({
      id: z.string().min(1), sessionID: z.string().min(1), directory: z.string().optional(),
    })).max(100) }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid disposition request' });
    try {
      res.json(await runtime.dispositions(parsed.data.requests));
    } catch {
      console.warn('[permission-auto-accept] disposition lookup failed');
      res.status(503).json({ error: 'Permission disposition lookup failed' });
    }
  });
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
      // Clients from before the modes send only `enabled`.
      const mode = req.body?.mode ?? req.body?.enabled;
      res.json(await runtime.setSessionPolicy(req.params.sessionId, mode, directory));
    } catch (error) {
      res.status(error instanceof TypeError ? 400 : 500).json({ error: error?.message });
    }
  });
}
