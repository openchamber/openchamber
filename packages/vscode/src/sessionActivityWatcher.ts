import { createOpencodeClient, type GlobalEvent } from '@opencode-ai/sdk/v2';
import { OpenCode, type EventSubscribeOutput } from '@opencode-ai/client';
import type { OpenCodeManager } from './opencode';

// Session activity tracking (mirrors web server and desktop behavior)
type ActivityPhase = 'idle' | 'busy' | 'cooldown';

interface SessionActivity {
  sessionId: string;
  phase: ActivityPhase;
}

type SessionActivityProperties = {
  sessionID?: string;
  sessionId?: string;
  status?: { type?: string };
  info?: {
    type?: string;
    sessionID?: string;
    sessionId?: string;
    role?: string;
    finish?: string;
  };
};

type SessionActivityPayload = {
  type?: string;
  properties?: SessionActivityProperties;
  data?: SessionActivityProperties;
  payload?: SessionActivityPayload;
};

type SessionActivityNotification = {
  type: 'openchamber:session-activity';
  properties: {
    sessionId: string;
    phase: ActivityPhase;
  };
};

type SessionActivityProvider = {
  postMessage: (message: SessionActivityNotification) => void;
};

type SessionActivityClients = {
  createLegacyClient: typeof createOpencodeClient;
  createV2Client: typeof OpenCode.make;
};

const defaultSessionActivityClients: SessionActivityClients = {
  createLegacyClient: createOpencodeClient,
  createV2Client: OpenCode.make,
};

const sessionActivityPhases = new Map<string, { phase: ActivityPhase; updatedAt: number }>();
const sessionActivityCooldowns = new Map<string, NodeJS.Timeout>();
const SESSION_COOLDOWN_DURATION_MS = 2000;

let globalEventWatcherAbortController: AbortController | null = null;
let chatViewProvider: SessionActivityProvider | null = null;
let globalEventWatcherRetryTimer: NodeJS.Timeout | null = null;
let globalEventWatcherStartToken = 0;

const clearGlobalEventWatcherRetry = (): void => {
  if (!globalEventWatcherRetryTimer) {
    return;
  }
  clearTimeout(globalEventWatcherRetryTimer);
  globalEventWatcherRetryTimer = null;
};

const unwrapGlobalEventPayload = (eventData: EventSubscribeOutput | GlobalEvent): SessionActivityPayload => {
  const payload = 'payload' in eventData ? eventData.payload : eventData;
  // SAFETY: both generated event unions use the discriminated fields read by
  // deriveSessionActivity; it ignores all event-specific fields.
  return payload as SessionActivityPayload;
};

export const reconcileSessionActivityFromStatus = async (
  manager: OpenCodeManager,
  clients: SessionActivityClients = defaultSessionActivityClients,
): Promise<void> => {
  const baseUrl = manager.getApiUrl();
  if (!baseUrl) {
    return;
  }

  if (manager.getProtocol() === 'opencode2') {
    const active = await clients.createV2Client({
      baseUrl,
      headers: manager.getOpenCodeAuthHeaders(),
    }).session.active();
    for (const sessionId of Object.keys(active)) {
      setSessionActivityPhase(sessionId, 'busy');
    }
    // V2 active-session omission is unknown, not authoritative idle. Terminal
    // execution events retire activity entries when the service supplies proof.
    return;
  }

  const result = await clients.createLegacyClient({
    baseUrl,
    headers: manager.getOpenCodeAuthHeaders(),
  }).session.status();
  if (result.error) throw result.error;
  const statuses = result.data;
  if (!statuses) {
    throw new Error('session status returned an invalid response');
  }
  const knownSessionIds = new Set(Object.keys(statuses || {}));

  for (const [sessionId, data] of Object.entries(statuses || {})) {
    const type = data?.type ?? 'idle';
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

export const getSessionActivitySnapshot = () => Object.fromEntries(
  Array.from(sessionActivityPhases, ([sessionId, data]) => [sessionId, { type: data.phase }]),
);

export const deriveSessionActivity = (payload: SessionActivityPayload): SessionActivity | null => {
  const type = payload.type;
  const properties = payload.properties ?? payload.data ?? {};

  if (type === 'session.execution.started') {
    const sessionId = properties.sessionID;
    return sessionId
      ? { sessionId, phase: 'busy' }
      : null;
  }

  if (type === 'session.execution.succeeded' || type === 'session.execution.failed' || type === 'session.execution.interrupted') {
    const sessionId = properties.sessionID;
    return sessionId
      ? { sessionId, phase: 'idle' }
      : null;
  }

  if (type === 'session.status') {
    const status = properties.status;
    const info = properties.info;
    const sessionId = properties.sessionID ?? properties.sessionId;
    const statusType = status?.type ?? info?.type;

    if (sessionId && statusType) {
      const phase = statusType === 'busy' || statusType === 'retry' ? 'busy' : 'idle';
      return { sessionId, phase };
    }
  }

  if (type === 'message.updated' || type === 'message.part.updated' || type === 'message.part.delta') {
    const info = properties.info;
    const sessionId = info?.sessionID ?? info?.sessionId ?? properties.sessionID ?? properties.sessionId;
    if (sessionId && info?.role === 'assistant' && info.finish === 'stop') {
      return { sessionId, phase: 'cooldown' };
    }
  }

  if (type === 'session.idle') {
    const sessionId = properties.sessionID ?? properties.sessionId;
    if (sessionId) {
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
  provider: SessionActivityProvider,
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

        try {
          await reconcileSessionActivityFromStatus(manager);
        } catch (error) {
          console.warn(
            '[VSCode:Activity] session status reconcile failed',
            error instanceof Error ? error.message : error,
          );
        }
        const protocol = manager.getProtocol();
        const stream = protocol === 'opencode2'
          ? OpenCode.make({ baseUrl, headers: manager.getOpenCodeAuthHeaders() }).event.subscribe({ signal })
          : (await createOpencodeClient({
              baseUrl,
              headers: manager.getOpenCodeAuthHeaders(),
            }).global.event({
              signal,
              sseMaxRetryAttempts: 0,
            })).stream;

        console.log('[VSCode:Activity] connected');

        for await (const event of stream) {
          const payload = unwrapGlobalEventPayload(event);
          if (payload) {
            const activity = deriveSessionActivity(payload);
            if (activity) {
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

export const setChatViewProvider = (provider: SessionActivityProvider | null): void => {
  chatViewProvider = provider;
};
