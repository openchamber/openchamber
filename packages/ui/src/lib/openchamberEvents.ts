export type ScheduledTaskRanEvent = {
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
let reconnectAttempt = 0;
const listeners = new Set<Listener>();

const MAX_RECONNECT_DELAY_MS = 30_000;

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
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
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
  cleanupSource();

  const source = new EventSource('/api/openchamber/events');
  source.onmessage = (event) => {
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

export const subscribeOpenchamberEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
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
    }
  };
};
