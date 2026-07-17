import { getActiveRelayTunnel } from './relay/runtime-tunnel';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeUrlResolver } from './runtime-url';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';
import { createSseDataParser } from './sse-data-parser';

type ScheduledTaskRanEvent = {
  type: 'scheduled-task-ran';
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'success' | 'error';
  sessionId?: string;
};

type OpenChamberEvent = ScheduledTaskRanEvent;
type Listener = (event: OpenChamberEvent) => void;

interface OpenChamberEventSource {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

interface OpenChamberEventsDependencies {
  isBrowserAvailable(): boolean;
  isTunnelActive(): boolean;
  runtimeFetch: typeof runtimeFetch;
  getSseUrl(path: string): string;
  subscribeRuntimeSwitch(listener: () => void): () => void;
  createEventSource(url: string): OpenChamberEventSource | null;
  eventSourceClosedState: number;
  setTimer(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}

const productionDependencies: OpenChamberEventsDependencies = {
  isBrowserAvailable: () => typeof window !== 'undefined',
  isTunnelActive: () => Boolean(getActiveRelayTunnel()),
  runtimeFetch,
  getSseUrl: (path) => getRuntimeUrlResolver().sse(path),
  subscribeRuntimeSwitch: subscribeRuntimeEndpointChanged,
  createEventSource: (url) => typeof EventSource === 'function' ? new EventSource(url) : null,
  eventSourceClosedState: typeof EventSource === 'function' ? EventSource.CLOSED : 2,
  setTimer: (callback, delay) => setTimeout(callback, delay),
  clearTimer: (timer) => clearTimeout(timer),
};

let dependencies = productionDependencies;
let eventSource: OpenChamberEventSource | null = null;
let streamAbortController: AbortController | null = null;
let connectionGeneration = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
const listeners = new Set<Listener>();

const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

const clearHeartbeatTimer = () => {
  if (!heartbeatTimer) {
    return;
  }
  dependencies.clearTimer(heartbeatTimer);
  heartbeatTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || listeners.size === 0) {
    return;
  }
  const delay = Math.min(1_000 * Math.pow(2, Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = dependencies.setTimer(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, delay);
};

const cleanupSource = () => {
  connectionGeneration += 1;
  clearHeartbeatTimer();
  streamAbortController?.abort();
  streamAbortController = null;
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
};

const isCurrentConnection = (generation: number): boolean => generation === connectionGeneration && listeners.size > 0;

const failConnection = (generation: number): void => {
  if (!isCurrentConnection(generation)) return;
  cleanupSource();
  scheduleReconnect();
};

const resetHeartbeatTimer = () => {
  clearHeartbeatTimer();
  if (listeners.size === 0) {
    return;
  }
  heartbeatTimer = dependencies.setTimer(() => {
    cleanupSource();
    scheduleReconnect();
  }, HEARTBEAT_TIMEOUT_MS);
};

const parseEnvelope = (raw: string): { type: string; properties: unknown } | null => {
  if (!raw || raw.trim().length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const type = typeof parsed?.type === 'string' ? parsed.type : '';
    const properties = parsed?.properties;
    if (!type) {
      return null;
    }
    return { type, properties };
  } catch {
    return null;
  }
};

const dispatchFromEnvelope = (envelope: { type: string; properties: unknown }) => {
  if (envelope.type === 'openchamber:event-stream-ready') {
    reconnectAttempt = 0;
    return;
  }

  if (envelope.type === 'openchamber:heartbeat') {
    return;
  }

  if (envelope.type !== 'openchamber:scheduled-task-ran') {
    return;
  }

  const parsed = envelope.properties && typeof envelope.properties === 'object'
    ? envelope.properties as Record<string, unknown>
    : null;
  const projectId = typeof parsed?.projectId === 'string' ? parsed.projectId : '';
  const taskId = typeof parsed?.taskId === 'string' ? parsed.taskId : '';
  const ranAt = typeof parsed?.ranAt === 'number' ? parsed.ranAt : Date.now();
  const rawStatus = parsed?.status;
  const status = rawStatus === 'running' || rawStatus === 'error' ? rawStatus : 'success';
  if (!projectId || !taskId) {
    return;
  }

  const nextEvent: ScheduledTaskRanEvent = {
    type: 'scheduled-task-ran',
    projectId,
    taskId,
    ranAt,
    status,
    ...(typeof parsed?.sessionId === 'string' && parsed.sessionId.length > 0 ? { sessionId: parsed.sessionId } : {}),
  };
  for (const listener of listeners) {
    listener(nextEvent);
  }
};

const connectTunnelStream = (generation: number, controller: AbortController): void => {
  void (async () => {
    try {
      const response = await dependencies.runtimeFetch('/api/openchamber/events', {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });
      if (!isCurrentConnection(generation)) return;

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (!response.ok || !response.body || !contentType.startsWith('text/event-stream')) {
        failConnection(generation);
        return;
      }

      resetHeartbeatTimer();
      const parser = createSseDataParser((data) => {
        if (!isCurrentConnection(generation)) return;
        resetHeartbeatTimer();
        const envelope = parseEnvelope(data);
        if (envelope) dispatchFromEnvelope(envelope);
      });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (isCurrentConnection(generation)) {
        const { done, value } = await reader.read();
        if (!isCurrentConnection(generation)) return;
        if (done) {
          parser.end();
          failConnection(generation);
          return;
        }
        parser.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      failConnection(generation);
    }
  })();
};

const connect = () => {
  if (!dependencies.isBrowserAvailable() || listeners.size === 0) {
    return;
  }

  if (streamAbortController || (eventSource && eventSource.readyState !== dependencies.eventSourceClosedState)) {
    return;
  }

  cleanupSource();
  const generation = connectionGeneration;

  if (dependencies.isTunnelActive()) {
    const controller = new AbortController();
    streamAbortController = controller;
    connectTunnelStream(generation, controller);
    return;
  }

  const source = dependencies.createEventSource(dependencies.getSseUrl('/api/openchamber/events'));
  if (!source) return;
  source.onopen = () => {
    if (!isCurrentConnection(generation)) return;
    resetHeartbeatTimer();
  };
  source.onmessage = (event) => {
    if (!isCurrentConnection(generation)) return;
    resetHeartbeatTimer();
    const envelope = parseEnvelope(event.data);
    if (!envelope) {
      return;
    }
    dispatchFromEnvelope(envelope);
  };

  source.onerror = () => {
    failConnection(generation);
  };

  eventSource = source;
};

const ensureRuntimeChangeSubscription = () => {
  if (runtimeChangeUnsubscribe || !dependencies.isBrowserAvailable()) return;
  runtimeChangeUnsubscribe = dependencies.subscribeRuntimeSwitch(() => {
    cleanupSource();
    reconnectAttempt = 0;
    connect();
  });
};

const cleanupRuntimeChangeSubscription = () => {
  runtimeChangeUnsubscribe?.();
  runtimeChangeUnsubscribe = null;
};

export const subscribeOpenchamberEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  ensureRuntimeChangeSubscription();
  connect();

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (reconnectTimer) {
        dependencies.clearTimer(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      cleanupSource();
      cleanupRuntimeChangeSubscription();
    }
  };
};

export const setOpenchamberEventsDependenciesForTests = (
  overrides: Partial<OpenChamberEventsDependencies>,
): void => {
  dependencies = { ...productionDependencies, ...overrides };
};

export const resetOpenchamberEventsForTests = (): void => {
  listeners.clear();
  if (reconnectTimer) dependencies.clearTimer(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
  cleanupSource();
  cleanupRuntimeChangeSubscription();
  dependencies = productionDependencies;
};
