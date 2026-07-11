const SESSION_LIMIT = 20;
const FULL_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 6_000;
const INTERACTIVE_YIELD_MS = 1_000;
const LONG_POLL_MAX_MS = 25_000;

const normalizeDirectory = (value) => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalized || null;
};

const updatedAt = (session) => {
  const value = session?.time?.updated ?? session?.time?.created;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

const mergeIncrementalSessions = (cached, changed) => {
  const byID = new Map();
  for (const session of cached ?? []) byID.set(session.id, session);
  for (const session of changed ?? []) {
    if (!session?.id) continue;
    if (session.time?.archived) byID.delete(session.id);
    else byID.set(session.id, session);
  }
  return [...byID.values()]
    .sort((left, right) => updatedAt(right) - updatedAt(left) || right.id.localeCompare(left.id))
    .slice(0, SESSION_LIMIT);
};

export const createSessionIndexSyncRuntime = ({
  sessionIndexService,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  waitForOpenCodeReady,
  fetchFn = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) => {
  if (!sessionIndexService) return null;

  let revision = 0;
  let stopped = false;
  let running = false;
  let currentController = null;
  let currentWasPreempted = false;
  let interactiveUntil = 0;
  let runtimeKey = sessionIndexService.getRuntimeKey();
  const queue = [];
  const queuedDirectories = new Set();
  const completedDirectories = new Set();
  const failedDirectories = new Set();
  const waiters = new Set();
  let batchDirectories = new Set();

  const syncState = () => ({
    active: running || queue.length > 0,
    completed: completedDirectories.size,
    total: batchDirectories.size,
    pendingDirectories: [...queuedDirectories],
    completedDirectories: [...completedDirectories],
    failedDirectories: [...failedDirectories],
  });

  const snapshot = () => ({
    revision,
    sync: syncState(),
    ...sessionIndexService.snapshot(),
  });

  const notify = () => {
    revision += 1;
    const value = snapshot();
    for (const resolve of [...waiters]) resolve(value);
  };

  const delay = (ms, signal) => new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimer(done, ms);
    const onAbort = () => {
      clearTimer(timer);
      done();
    };
    function done() {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });

  const readDirectory = (directory) => sessionIndexService.snapshot().directories
    .find((entry) => entry.directory === directory);

  const fetchDirectory = async (task) => {
    const cached = readDirectory(task.directory);
    const useIncremental = Boolean(
      cached?.lastSyncedAt > 0
      && now() - cached.lastFullSyncedAt < FULL_RECONCILE_INTERVAL_MS
    );
    // Keep parity with @opencode-ai/sdk/v2 experimental.session.list. The
    // regular /session endpoint has different pagination semantics.
    const url = new URL(buildOpenCodeUrl('/experimental/session'));
    url.searchParams.set('directory', task.directory);
    url.searchParams.set('roots', 'true');
    url.searchParams.set('limit', String(SESSION_LIMIT));
    if (useIncremental) url.searchParams.set('start', String(cached.lastSyncedAt));

    const controller = new AbortController();
    currentController = controller;
    currentWasPreempted = false;
    const timeout = setTimer(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = new Error(`OpenCode session list failed (${response.status})`);
        error.status = response.status;
        throw error;
      }
      const sessions = await response.json();
      if (!Array.isArray(sessions)) throw new Error('Invalid OpenCode session list payload');
      const nextSessions = useIncremental
        ? mergeIncrementalSessions(cached?.sessions, sessions)
        : sessions.slice(0, SESSION_LIMIT);
      const oldest = nextSessions[nextSessions.length - 1];
      sessionIndexService.replaceDirectory({
        directory: task.directory,
        sessions: nextSessions,
        cursor: useIncremental ? (cached?.cursor ?? null) : (updatedAt(oldest) || null),
        hasMore: useIncremental ? Boolean(cached?.hasMore) : sessions.length === SESSION_LIMIT,
        fullSync: !useIncremental,
        now: now(),
      });
      return 'completed';
    } catch (error) {
      if (stopped || task.runtimeKey !== runtimeKey) return 'discarded';
      if (currentWasPreempted) return 'preempted';
      throw error;
    } finally {
      clearTimer(timeout);
      if (currentController === controller) currentController = null;
      currentWasPreempted = false;
    }
  };

  const run = async () => {
    if (running || stopped) return;
    running = true;
    notify();
    try {
      const ready = await waitForOpenCodeReady?.(15_000);
      if (ready === false) throw new Error('OpenCode did not become ready');
      while (!stopped && queue.length > 0) {
        const waitMs = Math.max(0, interactiveUntil - now());
        if (waitMs > 0) await delay(waitMs);
        if (stopped) break;
        const task = queue.shift();
        if (!task) break;
        try {
          const result = await fetchDirectory(task);
          if (result === 'preempted') {
            queue.unshift(task);
            await delay(Math.max(0, interactiveUntil - now()));
            continue;
          }
          if (result === 'discarded' || stopped) continue;
          queuedDirectories.delete(task.directory);
          completedDirectories.add(task.directory);
        } catch (error) {
          queuedDirectories.delete(task.directory);
          failedDirectories.add(task.directory);
          console.warn(`[SessionIndex] Background sync failed for ${task.directory}:`, error);
        }
        notify();
      }
    } catch (error) {
      for (const task of queue.splice(0)) {
        queuedDirectories.delete(task.directory);
        failedDirectories.add(task.directory);
      }
      console.warn('[SessionIndex] Background sync could not reach OpenCode:', error);
    } finally {
      running = false;
      if (!stopped) notify();
    }
  };

  const enqueue = (directories) => {
    const nextRuntimeKey = sessionIndexService.getRuntimeKey();
    if (nextRuntimeKey !== runtimeKey) {
      runtimeKey = nextRuntimeKey;
      currentWasPreempted = true;
      currentController?.abort();
      queue.length = 0;
      queuedDirectories.clear();
      completedDirectories.clear();
      failedDirectories.clear();
      batchDirectories = new Set();
    }
    if (!running && queue.length === 0) {
      completedDirectories.clear();
      failedDirectories.clear();
      batchDirectories = new Set();
    }
    for (const value of directories ?? []) {
      const directory = normalizeDirectory(value);
      if (!directory || batchDirectories.has(directory)) continue;
      batchDirectories.add(directory);
      queuedDirectories.add(directory);
      queue.push({ directory, runtimeKey });
    }
    notify();
    void run();
    return snapshot();
  };

  const noteInteractiveRequest = () => {
    interactiveUntil = Math.max(interactiveUntil, now() + INTERACTIVE_YIELD_MS);
    if (currentController) {
      currentWasPreempted = true;
      currentController.abort();
    }
  };

  const waitForChange = (since, { signal, timeoutMs = LONG_POLL_MAX_MS } = {}) => {
    if (revision > since || stopped || signal?.aborted) return Promise.resolve(snapshot());
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value = snapshot()) => {
        if (settled) return;
        settled = true;
        waiters.delete(finish);
        signal?.removeEventListener?.('abort', onAbort);
        clearTimer(timer);
        resolve(value);
      };
      const onAbort = () => finish();
      const timer = setTimer(finish, Math.min(Math.max(1, timeoutMs), LONG_POLL_MAX_MS));
      waiters.add(finish);
      signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  };

  const stop = () => {
    stopped = true;
    currentController?.abort();
    queue.length = 0;
    queuedDirectories.clear();
    notify();
  };

  return { enqueue, noteInteractiveRequest, snapshot, waitForChange, stop };
};
