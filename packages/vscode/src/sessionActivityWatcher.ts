import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import type { OpenCodeManager } from './opencode';

// Session activity tracking (mirrors web server and desktop Tauri behavior)
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

const reconcileSessionActivityFromStatus = async (manager: OpenCodeManager): Promise<void> => {
  const baseUrl = manager.getApiUrl();
  if (!baseUrl) {
    return;
  }

  const url = new URL('/session/status', baseUrl);
  const response = await fetch(url.toString(), {
    headers: manager.getOpenCodeAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`session status fetch failed (${response.status})`);
  }

  const statuses = await response.json() as Record<string, { type?: string }>;
  const knownSessionIds = new Set(Object.keys(statuses || {}));

  for (const [sessionId, data] of Object.entries(statuses || {})) {
    const type = typeof data?.type === 'string' ? data.type : 'idle';
    const phase: ActivityPhase = type === 'busy' || type === 'retry' ? 'busy' : 'idle';
    setSessionActivityPhase(sessionId, phase);
  }

  // Drop stale in-memory activity entries not present in authoritative status.
  for (const sessionId of Array.from(sessionActivityPhases.keys())) {
    if (!knownSessionIds.has(sessionId)) {
      setSessionActivityPhase(sessionId, 'idle');
    }
  }
};

const setSessionActivityPhase = (sessionId: string, phase: ActivityPhase): void => {
  if (!sessionId) return;

  // Cancel existing cooldown timer
  const existingTimer = sessionActivityCooldowns.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
    sessionActivityCooldowns.delete(sessionId);
  }

  const current = sessionActivityPhases.get(sessionId);
  if (current?.phase === phase) return; // No change

  sessionActivityPhases.set(sessionId, { phase, updatedAt: Date.now() });

  // Notify webview if available
  if (chatViewProvider) {
    chatViewProvider.postMessage({
      type: 'openchamber:session-activity',
      properties: {
        sessionId,
        phase,
      },
    });
  }

  // Schedule transition from cooldown to idle
  if (phase === 'cooldown') {
    const timer = setTimeout(() => {
      const now = sessionActivityPhases.get(sessionId);
      if (now?.phase === 'cooldown') {
        sessionActivityPhases.set(sessionId, { phase: 'idle', updatedAt: Date.now() });
        if (chatViewProvider) {
          chatViewProvider.postMessage({
            type: 'openchamber:session-activity',
            properties: {
              sessionId,
              phase: 'idle',
            },
          });
        }
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

const deriveSessionActivity = (payload: Record<string, unknown>): SessionActivity | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const type = payload.type as string;
  const properties = (payload.properties ?? payload) as Record<string, unknown>;

  if (type === 'session.status') {
    const status = properties?.status as Record<string, unknown> | undefined;
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = (properties?.sessionID ?? properties?.sessionId) as string;
    const statusType = (status?.type ?? info?.type) as string;

    if (typeof sessionId === 'string' && sessionId.length > 0 && typeof statusType === 'string') {
      const phase = statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle';
      return { sessionId, phase };
    }
  }

  if (type === 'message.updated' || type === 'message.part.updated' || type === 'message.part.delta') {
    const info = properties?.info as Record<string, unknown> | undefined;
    const sessionId = (info?.sessionID ?? info?.sessionId ?? properties?.sessionID ?? properties?.sessionId) as string;
    const role = info?.role as string;
    const finish = info?.finish as string;
    if (typeof sessionId === 'string' && sessionId.length > 0 && role === 'assistant' && finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }
  }

  if (type === 'session.idle') {
    const sessionId = (properties?.sessionID ?? properties?.sessionId) as string;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      return { sessionId, phase: 'idle' };
    }
  }

  return null;
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

  chatViewProvider = provider;

  const port = await waitForOpenCodePort(manager);
  if (!port) {
    console.warn('[VSCode:Activity] OpenCode port unavailable; will retry');
    setTimeout(() => startGlobalEventWatcher(manager, provider), 2000);
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

        const client = createOpencodeClient({
          baseUrl,
          headers: manager.getOpenCodeAuthHeaders(),
        });
        try {
          await reconcileSessionActivityFromStatus(manager);
        } catch (error) {
          console.warn(
            '[VSCode:Activity] session status reconcile failed',
            error instanceof Error ? error.message : error,
          );
        }
        const result = await client.global.event({
          signal,
          sseMaxRetryAttempts: 0,
          onSseEvent: (event) => {
            const payload = event.data;
            if (!payload || typeof payload !== 'object') {
              return;
            }
            const activity = deriveSessionActivity(payload as Record<string, unknown>);
            if (activity) {
              setSessionActivityPhase(activity.sessionId, activity.phase);
            }
          },
        });

        console.log('[VSCode:Activity] connected');

        for await (const _ of result.stream) {
          void _;
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
  if (!globalEventWatcherAbortController) {
    return;
  }
  try {
    globalEventWatcherAbortController.abort();
  } catch {
    // ignore
  }
  globalEventWatcherAbortController = null;
  chatViewProvider = null;

  // Clear all cooldown timers
  for (const timer of sessionActivityCooldowns.values()) {
    clearTimeout(timer);
  }
  sessionActivityCooldowns.clear();
};

export const setChatViewProvider = (provider: { postMessage: (message: unknown) => void } | null): void => {
  chatViewProvider = provider;
};
