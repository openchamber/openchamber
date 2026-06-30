import { subscribeRuntimeEndpointChanged } from './runtime-switch';

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

let eventSource: EventSource | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
const listeners = new Set<Listener>();

const MAX_RECONNECT_DELAY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;

// /api/openchamber/events is an OpenChamber-internal endpoint always served
// by the OpenChamber Express server (not the upstream OpenCode). Anchor to
// the page origin so the proxy-bypass deployment still works — see
// useWebNotificationStream for the same rationale.
const openchamberStreamUrl = (path: string): string => {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${path}`;
  }
  return path;
};

const clearHeartbeatTimer = () => {
  if (!heartbeatTimer) {
    return;
  }
  clearTimeout(heartbeatTimer);
  heartbeatTimer = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || listeners.size === 0) {
    return;
  }
  const delay = Math.min(1_000 * Math.pow(2, Math.min(reconnectAttempt, 5)), MAX_RECONNECT_DELAY_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt += 1;
    connect();
  }, delay);
};

const cleanupSource = () => {
  clearHeartbeatTimer();
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
};

const resetHeartbeatTimer = () => {
  clearHeartbeatTimer();
  if (listeners.size === 0) {
    return;
  }
  heartbeatTimer = setTimeout(() => {
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

const connect = () => {
  if (typeof window === 'undefined' || listeners.size === 0) {
    return;
  }
  if (typeof EventSource !== 'function') {
    return;
  }

  if (eventSource && eventSource.readyState !== EventSource.CLOSED) {
    return;
  }

  cleanupSource();

  const source = new EventSource(openchamberStreamUrl('/api/openchamber/events'));
  source.onopen = () => {
    resetHeartbeatTimer();
  };
  source.onmessage = (event) => {
    resetHeartbeatTimer();
    const envelope = parseEnvelope(event.data);
    if (!envelope) {
      return;
    }
    dispatchFromEnvelope(envelope);
  };

  source.onerror = () => {
    cleanupSource();
    scheduleReconnect();
  };

  eventSource = source;
};

const ensureRuntimeChangeSubscription = () => {
  if (runtimeChangeUnsubscribe || typeof window === 'undefined') return;
  runtimeChangeUnsubscribe = subscribeRuntimeEndpointChanged(() => {
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
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      cleanupSource();
      cleanupRuntimeChangeSubscription();
    }
  };
};
