import { OpenCode, type OpenCodeClient, type OpenCodeEvent } from '@opencode/client';
import type { OpenCodeManager } from './opencode';

// Session activity tracking (mirrors web server and desktop behavior)
type ActivityPhase = 'idle' | 'busy' | 'cooldown';

interface SessionActivity {
  sessionId: string;
  phase: ActivityPhase;
}

const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
const sessionActivityCooldowns = new Map<string, NodeJS.Timeout>();
const SESSION_COOLDOWN_DURATION_MS = 2000;

let globalEventWatcherAbortController: AbortController | null = null;
let chatViewProvider: { postMessage: (message: unknown) => void } | null = null;
let globalEventWatcherRetryTimer: NodeJS.Timeout | null = null;
let globalEventWatcherStartToken = 0;

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
 * agent loop. Anything not in it is idle, including sessions this process
 * believed were busy before the stream dropped.
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

export const getSessionActivitySnapshot = (): Record<string, { type: ActivityPhase }> => {
  const snapshot: Record<string, { type: ActivityPhase }> = {};
  for (const [sessionId, data] of sessionActivityPhases.entries()) {
    snapshot[sessionId] = { type: data.phase };
  }
  return snapshot;
};

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
 * off the instant the last token lands.
 */
const deriveSessionActivity = (event: OpenCodeEvent): SessionActivity | null => {
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
            // A healthy connection clears the backoff, so a long-lived watcher
            // does not carry a 30s delay into its next reconnect.
            attempt = 0;
            console.log('[VSCode:Activity] connected');
          }

          const activity = deriveSessionActivity(event);
          if (activity) {
            setSessionActivityPhase(activity.sessionId, activity.phase);
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

  if (globalEventWatcherAbortController) {
    try {
      globalEventWatcherAbortController.abort();
    } catch {
      // ignore
    }
  }
  globalEventWatcherAbortController = null;
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
