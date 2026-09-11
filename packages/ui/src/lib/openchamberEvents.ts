import { getRuntimeUrlResolver } from './runtime-url';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';
import { isVSCodeRuntime } from './desktop';
import { messageQueueUpdatedEventSchema, type MessageQueueUpdatedEvent } from '@/stores/messageQueueStore';
import { z } from 'zod';

type ScheduledTaskRanEvent = {
  type: 'scheduled-task-ran';
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'success' | 'error';
  sessionId?: string;
};

type SessionCreatedEvent = {
  type: 'session-created';
  sessionId: string;
  directory: string;
  projectId?: string;
  createdAt: number;
  promptDispatched: boolean;
  dispatchedAsCommand: boolean;
};

/**
 * The set of linked worktrees of one repository changed: created or removed by
 * this server, by an agent, or from a terminal. `directories` are the
 * directories inside that repository the server has seen requests for, so a
 * listener can map them onto its registered projects and refresh only those.
 */
type WorktreeChangedEvent = {
  type: 'worktree-changed';
  directories: string[];
  changedAt: number;
};

/**
 * One in-app browser action requested by the agent tool. Broadcast to every
 * connected client; only the one owning a browser view answers.
 */
type BrowserControlRequestEvent = {
  type: 'browser-control-request';
  requestId: string;
  action: string;
  parameters: Record<string, unknown>;
};

/**
 * The agent changed what it remembers. Carries only which store moved, not the
 * entries: listeners re-read from the server, so the event cannot go stale
 * between being sent and being handled.
 */
type AgentMemoryChangedEvent = {
  type: 'agent-memory-changed';
  scope: 'global' | 'project';
  projectId?: string;
};

type OpenChamberEvent =
  | { type: 'event-stream-ready' }
  | MessageQueueUpdatedEvent
  | ScheduledTaskRanEvent
  | SessionCreatedEvent
  | WorktreeChangedEvent
  | BrowserControlRequestEvent
  | AgentMemoryChangedEvent;
type Listener = (event: OpenChamberEvent) => void;

const worktreeChangedPropertiesSchema = z.object({
  directories: z.array(z.string().min(1)).min(1),
  at: z.number().optional(),
});

let eventSource: EventSource | null = null;
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

const getEventProperties = (properties: unknown): Record<string, unknown> | null => {
  if (!properties || typeof properties !== 'object') {
    return null;
  }
  return properties as Record<string, unknown>;
};

const dispatchFromEnvelope = (envelope: { type: string; properties: unknown }) => {
  if (envelope.type === 'openchamber:event-stream-ready') {
    reconnectAttempt = 0;
    for (const listener of listeners) listener({ type: 'event-stream-ready' });
    return;
  }

  if (envelope.type === 'openchamber:message-queue.updated') {
    const parsed = messageQueueUpdatedEventSchema.safeParse(envelope);
    if (parsed.success) {
      for (const listener of listeners) listener(parsed.data);
    }
    return;
  }

  if (envelope.type === 'openchamber:heartbeat') {
    return;
  }

  if (envelope.type === 'openchamber:agent-memory-changed') {
    const properties = getEventProperties(envelope.properties);
    const scope = properties?.scope === 'project' ? 'project' : 'global';
    const nextEvent: AgentMemoryChangedEvent = {
      type: 'agent-memory-changed',
      scope,
      ...(typeof properties?.projectId === 'string' && properties.projectId.length > 0
        ? { projectId: properties.projectId }
        : {}),
    };
    for (const listener of listeners) {
      listener(nextEvent);
    }
    return;
  }

  if (envelope.type === 'openchamber:session-created') {
    const properties = getEventProperties(envelope.properties);
    const sessionId = typeof properties?.sessionId === 'string' ? properties.sessionId : '';
    const directory = typeof properties?.directory === 'string' ? properties.directory : '';
    if (!sessionId || !directory) {
      return;
    }

    const nextEvent: SessionCreatedEvent = {
      type: 'session-created',
      sessionId,
      directory,
      createdAt: typeof properties?.createdAt === 'number' ? properties.createdAt : Date.now(),
      promptDispatched: properties?.promptDispatched === true,
      dispatchedAsCommand: properties?.dispatchedAsCommand === true,
      ...(typeof properties?.projectId === 'string' && properties.projectId.length > 0
        ? { projectId: properties.projectId }
        : {}),
    };
    for (const listener of listeners) {
      listener(nextEvent);
    }
    return;
  }

  if (envelope.type === 'openchamber:worktree-changed') {
    const parsed = worktreeChangedPropertiesSchema.safeParse(envelope.properties);
    if (!parsed.success) return;
    const nextEvent: WorktreeChangedEvent = {
      type: 'worktree-changed',
      directories: parsed.data.directories,
      changedAt: parsed.data.at ?? Date.now(),
    };
    for (const listener of listeners) listener(nextEvent);
    return;
  }

  if (envelope.type === 'openchamber:browser-control-request') {
    const properties = getEventProperties(envelope.properties);
    const requestId = typeof properties?.requestId === 'string' ? properties.requestId : '';
    const action = typeof properties?.action === 'string' ? properties.action : '';
    if (!requestId || !action) {
      return;
    }

    const rawParameters = properties?.parameters;
    const nextEvent: BrowserControlRequestEvent = {
      type: 'browser-control-request',
      requestId,
      action,
      parameters: rawParameters && typeof rawParameters === 'object' && !Array.isArray(rawParameters)
        ? rawParameters as Record<string, unknown>
        : {},
    };
    for (const listener of listeners) {
      listener(nextEvent);
    }
    return;
  }

  if (envelope.type !== 'openchamber:scheduled-task-ran') {
    return;
  }

  const properties = getEventProperties(envelope.properties);
  const projectId = typeof properties?.projectId === 'string' ? properties.projectId : '';
  const taskId = typeof properties?.taskId === 'string' ? properties.taskId : '';
  const ranAt = typeof properties?.ranAt === 'number' ? properties.ranAt : Date.now();
  const rawStatus = properties?.status;
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
    ...(typeof properties?.sessionId === 'string' && properties.sessionId.length > 0
      ? { sessionId: properties.sessionId }
      : {}),
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

  // Tell the server what this client can do while the connection lasts. Only a
  // Chromium host can drive a page; a browser tab can display one but not be
  // driven, and the agent tool needs to know which it is talking to without a
  // setting anyone has to remember to change.
  const canControlBrowser = typeof window !== 'undefined' && Boolean(window.__OPENCHAMBER_ELECTRON__);
  const source = new EventSource(getRuntimeUrlResolver().sse(
    '/api/openchamber/events',
    canControlBrowser ? { browser: '1' } : undefined,
  ));
  source.onopen = () => {
    if (eventSource !== source) return;
    resetHeartbeatTimer();
  };
  source.onmessage = (event) => {
    if (eventSource !== source) return;
    resetHeartbeatTimer();
    const envelope = parseEnvelope(event.data);
    if (!envelope) {
      return;
    }
    dispatchFromEnvelope(envelope);
  };

  source.onerror = () => {
    if (eventSource !== source) return;
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
  // VS Code runs OpenCode through its bridge, not the OpenChamber server that
  // owns this stream. Opening it here retries against vscode-webview:// forever.
  if (isVSCodeRuntime()) return () => undefined;

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
