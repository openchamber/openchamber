import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from '@opencode/client';
import type { OpenCodeManager } from './opencode';

// Session activity tracking (mirrors web server and desktop behavior)
type ActivityPhase = 'idle' | 'busy' | 'cooldown';

interface SessionActivity {
  sessionId: string;
  phase: ActivityPhase;
}

// External observability contract v1: design #612, phase 1 on the web server
// in #524, this parity snapshot in #621. The extension host tracks a
// session's phase and when that phase last changed, so lastActivityAt comes
// from the phase map. The host has no source for the session-state status,
// the observed model, or an in-flight tool, so those fields are explicit
// nulls. watcherReady turns true when the event stream delivers its first
// frame and stays true until the watcher stops, so an empty sessions map
// with watcherReady false means the watcher has not started yet.
interface SessionActivityV1Entry {
  type: ActivityPhase;
  lastActivityAt: number;
  status: null;
  model: null;
  toolInFlight: null;
}

interface SessionActivityV1Snapshot {
  version: 1;
  serverTime: number;
  watcherReady: boolean;
  sessions: Record<string, SessionActivityV1Entry>;
}

export const buildSessionActivityV1Snapshot = (
  phases: ReadonlyMap<string, { phase: ActivityPhase; updatedAt: number }>,
  watcherReady: boolean,
  serverTime: number,
): SessionActivityV1Snapshot => {
  const sessions: Record<string, SessionActivityV1Entry> = {};
  for (const [sessionId, data] of phases) {
    sessions[sessionId] = {
      type: data.phase,
      lastActivityAt: data.updatedAt,
      status: null,
      model: null,
      toolInFlight: null,
    };
  }
  return { version: 1, serverTime, watcherReady, sessions };
};

// Retention bound (#999): a deleted session is pruned the moment its
// `session.deleted` event arrives. A session whose deletion this host never
// observed (deleted while the stream was down, before the watcher started)
// is bounded instead by this idle TTL: an entry that has sat idle for a full
// day is a ghost, not a live session, and the reconcile pass removes it.
export const SESSION_ACTIVITY_IDLE_TTL_MS = 24 * 60 * 60 * 1000;

export const deleteSessionActivityEntry = (
  phases: Map<string, { phase: ActivityPhase; updatedAt: number }>,
  sessionId: string,
): boolean => phases.delete(sessionId);

export const pruneStaleSessionActivityEntries = (
  phases: Map<string, { phase: ActivityPhase; updatedAt: number }>,
  now: number,
): string[] => {
  const removed: string[] = [];
  for (const [sessionId, data] of phases) {
    if (data.phase === 'idle' && now - data.updatedAt >= SESSION_ACTIVITY_IDLE_TTL_MS) {
      phases.delete(sessionId);
      removed.push(sessionId);
    }
  }
  return removed;
};

// How often the running watcher re-runs the TTL prune while its event
// stream stays connected (#999, Codex review on PR #1010). The reconcile
// pass only runs before each (re)subscription, so without a periodic
// prune a session deleted during a disconnect and marked idle on
// reconnect would linger in the snapshot for as long as the healthy
// connection lasted — potentially indefinitely.
export const SESSION_ACTIVITY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export const pruneStaleSessionActivity = (
  phases: Map<string, { phase: ActivityPhase; updatedAt: number }>,
  cooldowns: Map<string, NodeJS.Timeout>,
  now: number,
): string[] => {
  const removed = pruneStaleSessionActivityEntries(phases, now);
  for (const sessionId of removed) {
    const timer = cooldowns.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      cooldowns.delete(sessionId);
    }
  }
  return removed;
};

const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
const sessionActivityCooldowns = new Map<string, NodeJS.Timeout>();
const SESSION_COOLDOWN_DURATION_MS = 2000;

let globalEventWatcherAbortController: AbortController | null = null;
let sessionActivityWatcherReady = false;
let chatViewProvider: { postMessage: (message: unknown) => void } | null = null;
let globalEventWatcherRetryTimer: NodeJS.Timeout | null = null;
let sessionActivityPruneTimer: NodeJS.Timeout | null = null;
let globalEventWatcherStartToken = 0;

const startSessionActivityPruneTimer = (): void => {
  if (sessionActivityPruneTimer) {
    return;
  }
  sessionActivityPruneTimer = setInterval(() => {
    pruneStaleSessionActivity(sessionActivityPhases, sessionActivityCooldowns, Date.now());
  }, SESSION_ACTIVITY_PRUNE_INTERVAL_MS);
  sessionActivityPruneTimer.unref?.();
};

const clearSessionActivityPruneTimer = (): void => {
  if (!sessionActivityPruneTimer) {
    return;
  }
  clearInterval(sessionActivityPruneTimer);
  sessionActivityPruneTimer = null;
};

const clearGlobalEventWatcherRetry = (): void => {
  if (!globalEventWatcherRetryTimer) {
    return;
  }
  clearTimeout(globalEventWatcherRetryTimer);
  globalEventWatcherRetryTimer = null;
};

const createActivityClient = (manager: OpenCodeManager, baseUrl: string): OpenCodeClient => OpenCode.make({
  baseUrl: baseUrl.replace(/\/+$/, ''),
  headers: manager.getOpenCodeAuthHeaders(),
});

/**
 * `GET /api/session/active` is the authoritative set of sessions running an
 * agent loop. Anything in it is busy. Anything tracked but absent is either
 * idle or deleted while the stream was down; absent entries are marked idle
 * so a live session survives a reconnect, and the idle-TTL prune below
 * removes the ones that stay idle past SESSION_ACTIVITY_IDLE_TTL_MS, so
 * missed deletions age out instead of being kept as idle ghosts forever.
 */
const reconcileSessionActivityFromStatus = async (client: OpenCodeClient): Promise<void> => {
  const active = await client.session.active({ signal: AbortSignal.timeout(8_000) });
  const activeSessionIds = new Set(Object.keys(active || {}));

  for (const sessionId of activeSessionIds) {
    setSessionActivityPhase(sessionId, 'busy');
  }

  for (const sessionId of Array.from(sessionActivityPhases.keys())) {
    if (!activeSessionIds.has(sessionId)) {
      setSessionActivityPhase(sessionId, 'idle');
    }
  }

  // Absent-from-active only proves a session is not running, not that it is
  // gone, so reconcile never deletes on absence alone. The TTL prune is the
  // bound for sessions deleted while this host was not watching (#999).
  pruneStaleSessionActivity(sessionActivityPhases, sessionActivityCooldowns, Date.now());
};

const removeSessionActivity = (sessionId: string): void => {
  if (!sessionId) return;

  const timer = sessionActivityCooldowns.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    sessionActivityCooldowns.delete(sessionId);
  }

  deleteSessionActivityEntry(sessionActivityPhases, sessionId);
};

const setSessionActivityPhase = (sessionId: string, phase: ActivityPhase): void => {
  if (!sessionId) return;

  const existingTimer = sessionActivityCooldowns.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionActivityCooldowns.delete(sessionId);
  }

  const current = sessionActivityPhases.get(sessionId);
  if (current?.phase === phase) return;

  sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

  chatViewProvider?.postMessage({
    type: 'openchamber:session-activity',
    properties: {
      sessionId,
      phase,
    },
  });

  if (phase === 'cooldown') {
    const timer = setTimeout(() => {
      const now = sessionActivityPhases.get(sessionId);
      if (now?.phase === 'cooldown') {
        sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
        chatViewProvider?.postMessage({
          type: 'openchamber:session-activity',
          properties: {
            sessionId,
            phase: 'idle',
          },
        });
      }
      sessionActivityCooldowns.delete(sessionId);
    }, SESSION_COOLDOWN_DURATION_MS);
    sessionActivityCooldowns.set(sessionId, timer);
  }
};

export const getSessionActivitySnapshot = (): SessionActivityV1Snapshot =>
  buildSessionActivityV1Snapshot(sessionActivityPhases, sessionActivityWatcherReady, Date.now());

/**
 * Live activity comes from the live channel only.
 *
 * `session.execution.*` is the signal that matters: a normal OpenCode 2.x turn
 * emits started → succeeded and NO `session.status` or `session.idle` at all, so
 * anything waiting on those would never see the session go busy. The two status
 * events are still handled because they do arrive outside a normal turn (retry,
 * explicit status pushes) and they are cheap to honour.
 *
 * A finished run passes through `cooldown` so the UI does not flip the indicator
 * off the instant the last token lands. A deleted session is pruned outright
 * (`session.deleted` carries no phase), including its pending cooldown timer.
 */
type SessionActivityUpdate = SessionActivity | { sessionId: string; deleted: true };

const deriveSessionActivity = (event: OpenCodeEvent): SessionActivityUpdate | null => {
  switch (event.type) {
    case 'session.status': {
      const statusType = event.data.status.type;
      return {
        sessionId: event.data.sessionID,
        phase: statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle',
      };
    }
    case 'session.execution.started':
      return { sessionId: event.data.sessionID, phase: 'busy' };
    case 'session.execution.succeeded':
      return { sessionId: event.data.sessionID, phase: 'cooldown' };
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      return { sessionId: event.data.sessionID, phase: 'idle' };
    case 'session.idle':
      return { sessionId: event.data.sessionID, phase: 'idle' };
    case 'session.deleted':
      return { sessionId: event.data.sessionID, deleted: true };
    default:
      return null;
  }
};

const waitForOpenCodePort = async (manager: OpenCodeManager, timeoutMs = 30000): Promise<number | null> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const apiUrl = manager.getApiUrl();
    if (apiUrl) {
      try {
        const url = new URL(apiUrl);
        if (url.port) {
          return parseInt(url.port, 10);
        }
      } catch {
        // ignore
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return null;
};

export const startGlobalEventWatcher = async (
  manager: OpenCodeManager,
  provider: { postMessage: (message: unknown) => void }
): Promise<void> => {
  if (globalEventWatcherAbortController) {
    return;
  }

  const startToken = ++globalEventWatcherStartToken;
  clearGlobalEventWatcherRetry();
  chatViewProvider = provider;

  const port = await waitForOpenCodePort(manager);
  if (startToken !== globalEventWatcherStartToken) {
    return;
  }
  if (!port) {
    console.warn('[VSCode:Activity] OpenCode port unavailable; will retry');
    globalEventWatcherRetryTimer = setTimeout(() => {
      globalEventWatcherRetryTimer = null;
      if (startToken === globalEventWatcherStartToken) {
        void startGlobalEventWatcher(manager, provider);
      }
    }, 2000);
    return;
  }

  globalEventWatcherAbortController = new AbortController();
  const signal = globalEventWatcherAbortController.signal;
  startSessionActivityPruneTimer();

  let attempt = 0;

  const run = async (): Promise<void> => {
    while (!signal.aborted) {
      attempt += 1;

      try {
        const baseUrl = manager.getApiUrl();
        if (!baseUrl) {
          throw new Error('OpenCode API URL not available');
        }

        const client = createActivityClient(manager, baseUrl);
        try {
          await reconcileSessionActivityFromStatus(client);
        } catch (error) {
          console.warn(
            '[VSCode:Activity] active session reconcile failed',
            error instanceof Error ? error.message : error,
          );
        }

        // The stream is lazy: it is only proven connected once a frame arrives.
        let connected = false;

        for await (const event of client.event.subscribe({ signal })) {
          if (!connected) {
            connected = true;
            sessionActivityWatcherReady = true;
            // A healthy connection clears the backoff, so a long-lived watcher
            // does not carry a 30s delay into its next reconnect.
            attempt = 0;
            console.log('[VSCode:Activity] connected');
          }

          const activity = deriveSessionActivity(event);
          if (activity) {
            if ('deleted' in activity) {
              removeSessionActivity(activity.sessionId);
            } else {
              setSessionActivityPhase(activity.sessionId, activity.phase);
            }
          }

          if (signal.aborted) {
            break;
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[VSCode:Activity] disconnected', error instanceof Error ? error.message : error);
      }

      const backoffMs = Math.min(1000 * Math.pow(2, Math.min(attempt, 5)), 30000);
      await new Promise(r => setTimeout(r, backoffMs));
    }
  };

  void run();
};

export const stopGlobalEventWatcher = (): void => {
  globalEventWatcherStartToken += 1;
  clearGlobalEventWatcherRetry();
  clearSessionActivityPruneTimer();

  if (globalEventWatcherAbortController) {
    try {
      globalEventWatcherAbortController.abort();
    } catch {
      // ignore
    }
  }
  globalEventWatcherAbortController = null;
  sessionActivityWatcherReady = false;
  chatViewProvider = null;

  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
  sessionActivityPhases.clear();
};

export const setChatViewProvider = (provider: { postMessage: (message: unknown) => void } | null): void => {
  chatViewProvider = provider;
};
