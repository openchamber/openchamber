import { getRuntimeUrlResolver } from './runtime-url';
import { runtimeFetch } from './runtime-fetch';
import { useAuthSessionStore, waitForAuthSession } from './runtime-auth-expiry';
import { isRelayModeActive } from './relay/runtime-tunnel';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';
import { isVSCodeRuntime } from './desktop';
import { canDriveBrowserPage } from './browser/hostCapability';
import { messageQueueUpdatedEventSchema, type MessageQueueUpdatedEvent } from '@/stores/messageQueueStore';
import { autoReviewUpdatedEventSchema, type AutoReviewUpdatedEvent } from '@/stores/useAutoReviewStore';
import { prWatchUpdatedEventSchema, type PrWatchUpdatedEvent } from '@/sync/pr-watch';
import { sessionWarmingSnapshotSchema, type SessionWarmingSnapshot } from '@/stores/useSessionWarmingStore';
import { z } from 'zod';
import { trackedItemRecordsSchema } from './trackedItems/model';
import type { SyncEvent } from './opencode/events';
import { classifyStreamPayload } from '@/sync/event-pipeline';

type ScheduledTaskRanEvent = {
  type: 'scheduled-task-ran';
  projectId: string;
  taskId: string;
  ranAt: number;
  status: 'running' | 'sent' | 'success' | 'error';
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
  context: BrowserControlRequestContext;
};

/**
 * The session that called the browser tool and the project it works in, each
 * null when unknown (an older server, or a caller with no session).
 */
const browserControlRequestContextSchema = z.object({
  directory: z.string().min(1).nullable().catch(null),
  sessionId: z.string().min(1).nullable().catch(null),
});
export type BrowserControlRequestContext = z.infer<typeof browserControlRequestContextSchema>;
const UNKNOWN_BROWSER_CONTROL_CONTEXT: BrowserControlRequestContext = { directory: null, sessionId: null };

/**
 * The agent asked for a file to be shown in the user's file panel. Every
 * client receives it; one showing that project opens the file.
 */
const fileOpenRequestSchema = z.object({
  path: z.string().min(1),
  directory: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
});
type FileOpenRequestEvent = { type: 'file-open-request' } & z.infer<typeof fileOpenRequestSchema>;

/**
 * The agent asked for a saved plan to be shown. `projectId` is the storage
 * owner; `directory` is where the asking session works, so the window that
 * shows that project opens the plan.
 */
const planOpenRequestSchema = z.object({
  projectId: z.string().min(1),
  planId: z.string().min(1),
  title: z.string(),
  directory: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
});
type PlanOpenRequestEvent = { type: 'plan-open-request' } & z.infer<typeof planOpenRequestSchema>;

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

const projectContextChangedSchema = z.object({ projectId: z.string().min(1) });
type ProjectContextChangedEvent = { type: 'project-context-changed' } & z.infer<typeof projectContextChangedSchema>;

/** A client changed the chat folders; `updatedAt` is the stored revision, so a client already showing it skips the read. */
const sessionFoldersChangedSchema = z.object({ updatedAt: z.number().finite() });
type SessionFoldersChangedEvent = { type: 'session-folders-changed' } & z.infer<typeof sessionFoldersChangedSchema>;

/** A client saved, sent or discarded a session draft; every client reads the drafts again. */
const sessionDraftsChangedSchema = z.object({ updatedAt: z.number().finite() });
type SessionDraftsChangedEvent = { type: 'session-drafts-changed' } & z.infer<typeof sessionDraftsChangedSchema>;

/**
 * The extension chosen as browser provider can no longer serve (paused,
 * removed, or approval withdrawn), so the server put the in-app browser back.
 * The setting is already written; listeners update the store and tell the user.
 */
const browserProviderResetSchema = z.object({
  guestId: z.string().min(1),
  guestName: z.string().min(1),
});
type BrowserProviderResetEvent = { type: 'browser-provider-reset' } & z.infer<typeof browserProviderResetSchema>;

/**
 * The set of source-control providers the server serves changed: an extension
 * that acts as a Git host was approved, enabled, updated, paused or removed.
 * Carries nothing; listeners re-read the provider list from the server, so the
 * event cannot go stale between being sent and being handled.
 */
type SourceControlProvidersChangedEvent = { type: 'source-control-providers-changed' };

/**
 * A usage limit stopped a session and the server moved on: the provider to
 * its next account (for every session), or this session to the fallback model.
 */
const limitFailoverSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('account'),
    sessionId: z.string().min(1),
    providerId: z.string().min(1),
    fromAccount: z.string().nullable(),
    toAccount: z.string().min(1),
  }),
  z.object({
    kind: z.literal('model'),
    sessionId: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    toProviderId: z.string().min(1),
    toModelId: z.string().min(1),
  }),
]);
type LimitFailoverEvent = { type: 'limit-failover'; failover: z.infer<typeof limitFailoverSchema> };

/** Jev routing events; each carries what the routing store needs and nothing the UI must re-derive. */
const routingUpdatedSchema = z.object({
  available: z.boolean(),
  autoReady: z.boolean(),
  // Absent from servers before the classifier pick, where Jev always answered.
  jevAvailable: z.boolean().default(true),
  tokenPresent: z.boolean(),
  jevSource: z.enum(['typesafe', 'zen-free']),
});

const routingDecisionSchema = z.object({
  sessionId: z.string().min(1),
  at: z.number(),
  category: z.string().nullable(),
  confidence: z.number(),
  reason: z.enum(['routed', 'low-confidence', 'unknown-category', 'error', 'not-ready']),
  providerID: z.string().optional(),
  modelID: z.string().optional(),
  variant: z.string().nullable().optional(),
  agent: z.string().nullable().optional(),
  error: z.string().optional(),
});

const routingPermissionHeldSchema = z.object({
  permissionId: z.string().min(1),
  sessionId: z.string().min(1),
  // Where the request lives, so the held request can be announced from its directory's store.
  directory: z.string().nullable().default(null),
  score: z.number(),
  kind: z.string().nullable(),
});

const routingSafetySkippedSchema = z.object({
  permissionId: z.string().min(1),
  sessionId: z.string().min(1),
  directory: z.string().nullable().default(null),
  error: z.string(),
});

type RoutingUpdatedEvent = { type: 'routing-updated' } & z.infer<typeof routingUpdatedSchema>;
type RoutingDecisionEvent = { type: 'routing-decision'; decision: z.infer<typeof routingDecisionSchema> };
type RoutingPermissionHeldEvent = { type: 'routing-permission-held' } & z.infer<typeof routingPermissionHeldSchema>;
type RoutingSafetySkippedEvent = { type: 'routing-safety-skipped' } & z.infer<typeof routingSafetySkippedSchema>;

/**
 * A permission mode change, or a request the server's auto-answer left for the
 * user. The main event stream carries both as well; a window whose main stream
 * runs over SSE hears them only here.
 */
export type PermissionPolicySyncEvent = Extract<SyncEvent, { type: 'openchamber.permission-auto-accept' | 'openchamber.permission-left-for-user' }>;
type PermissionPolicyEvent = { type: 'permission-policy'; event: PermissionPolicySyncEvent };

/** Followed pull requests, merge requests or issues whose state the server saw move. */
type TrackedItemsChangedEvent = { type: 'tracked-items-changed'; records: z.infer<typeof trackedItemRecordsSchema> };

const eventStreamReadySchema = z.object({ connectionId: z.string().min(1).optional() });
const sourceControlActivitySchema = z.object({ directory: z.string().min(1) });
// The host follows one isolated space's queue or permission modes again.
const spaceStreamConnectedSchema = z.object({ spaceId: z.string().regex(/^[0-9a-f]{12}$/), status: z.literal('connected') });

const notificationPropertiesSchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
  tag: z.string().optional(),
  kind: z.string().optional(),
  sessionId: z.string().optional(),
  directory: z.string().optional(),
  requireHidden: z.boolean().optional(),
  showWhenFocused: z.boolean().optional(),
});

type OpenChamberEvent =
  | { type: 'notification'; payload: z.infer<typeof notificationPropertiesSchema> }
  /** `connectionId` names this connection on the server; absent from servers before tracked items. */
  | { type: 'event-stream-ready'; connectionId: string | null }
  | TrackedItemsChangedEvent
  /** An agent turn finished in `directory`; its branches may have a new pull request. */
  | { type: 'source-control-activity'; directory: string }
  | RoutingUpdatedEvent
  | RoutingDecisionEvent
  | RoutingPermissionHeldEvent
  | RoutingSafetySkippedEvent
  | MessageQueueUpdatedEvent
  | AutoReviewUpdatedEvent
  | PrWatchUpdatedEvent
  | PermissionPolicyEvent
  /** Which sessions the server keeps warm, as a full snapshot. */
  | { type: 'session-warming'; snapshot: SessionWarmingSnapshot }
  /** The host follows this space's queue again; what changed in a gap is read from the space. */
  | { type: 'space-queue-stream'; spaceId: string }
  /** The host follows this space's permission modes again; what changed in a gap is read from the space. */
  | { type: 'space-permission-stream'; spaceId: string }
  | ScheduledTaskRanEvent
  | SessionCreatedEvent
  | WorktreeChangedEvent
  | BrowserControlRequestEvent
  | FileOpenRequestEvent
  | PlanOpenRequestEvent
  | BrowserProviderResetEvent
  | SourceControlProvidersChangedEvent
  | LimitFailoverEvent
  | ProjectContextChangedEvent
  | SessionFoldersChangedEvent
  | SessionDraftsChangedEvent
  | AgentMemoryChangedEvent;
type Listener = (event: OpenChamberEvent) => void;

const worktreeChangedPropertiesSchema = z.object({
  directories: z.array(z.string().min(1)).min(1),
  at: z.number().optional(),
});

let eventSource: EventSource | null = null;
let relayAbortController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let authSessionWait: AbortController | null = null;
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

const cancelAuthSessionWait = () => {
  authSessionWait?.abort();
  authSessionWait = null;
};

const scheduleReconnect = () => {
  if (reconnectTimer || authSessionWait || listeners.size === 0) {
    return;
  }
  // An expired session answers every attempt with 401; wait for the login
  // instead and reconnect right after it.
  if (useAuthSessionStore.getState().state !== 'ok') {
    const wait = new AbortController();
    authSessionWait = wait;
    void waitForAuthSession(wait.signal).then(() => {
      if (wait.signal.aborted) return;
      authSessionWait = null;
      reconnectAttempt = 0;
      connect();
    });
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
  relayAbortController?.abort();
  relayAbortController = null;
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
};

const connectRelay = (canControlBrowser: boolean) => {
  const controller = new AbortController();
  relayAbortController = controller;
  void (async () => {
    try {
      const response = await runtimeFetch('/api/openchamber/events', {
        query: canControlBrowser ? { browser: '1' } : undefined,
        headers: { Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        await response.body?.cancel();
        return;
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new Error(`OpenChamber events returned ${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      let data: string[] = [];
      resetHeartbeatTimer();
      try {
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value, { stream: true });
          let newline = pending.indexOf('\n');
          while (newline !== -1) {
            const line = pending.slice(0, newline).replace(/\r$/, '');
            pending = pending.slice(newline + 1);
            if (line === '') {
              if (data.length && !controller.signal.aborted) {
                resetHeartbeatTimer();
                const envelope = parseEnvelope(data.join('\n'));
                if (envelope) dispatchFromEnvelope(envelope);
              }
              data = [];
            } else if (line === 'data' || line.startsWith('data:')) {
              data.push(line === 'data' ? '' : line.slice(5).replace(/^ /, ''));
            }
            newline = pending.indexOf('\n');
          }
        }
      } finally {
        if (!controller.signal.aborted) await reader.cancel();
        reader.releaseLock();
      }
    } catch {
      // A failed or ended stream follows the same reconnect path as EventSource.
    }
    if (relayAbortController !== controller) return;
    cleanupSource();
    scheduleReconnect();
  })();
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
  if (envelope.type === 'openchamber:notification') {
    const parsed = notificationPropertiesSchema.safeParse(envelope.properties);
    if (parsed.success) {
      for (const listener of listeners) listener({ type: 'notification', payload: parsed.data });
    }
    return;
  }

  if (envelope.type === 'openchamber:event-stream-ready') {
    reconnectAttempt = 0;
    const ready = eventStreamReadySchema.safeParse(envelope.properties);
    const connectionId = ready.success ? ready.data.connectionId ?? null : null;
    for (const listener of listeners) listener({ type: 'event-stream-ready', connectionId });
    return;
  }

  if (envelope.type === 'openchamber:source-control.activity') {
    const parsed = sourceControlActivitySchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'source-control-activity', directory: parsed.data.directory });
    return;
  }

  if (envelope.type === 'openchamber:tracked-items.changed') {
    const records = trackedItemRecordsSchema.parse(getEventProperties(envelope.properties)?.states);
    if (records.length > 0) for (const listener of listeners) listener({ type: 'tracked-items-changed', records });
    return;
  }

  if (envelope.type === 'openchamber:message-queue.updated') {
    const parsed = messageQueueUpdatedEventSchema.safeParse(envelope);
    if (parsed.success) {
      for (const listener of listeners) listener(parsed.data);
    }
    return;
  }

  if (envelope.type === 'openchamber:pr-watch.updated') {
    const parsed = prWatchUpdatedEventSchema.safeParse(envelope);
    if (parsed.success) {
      for (const listener of listeners) listener(parsed.data);
    }
    return;
  }

  if (envelope.type === 'openchamber:auto-review.updated') {
    const parsed = autoReviewUpdatedEventSchema.safeParse(envelope);
    if (parsed.success) {
      for (const listener of listeners) listener(parsed.data);
    }
    return;
  }

  if (envelope.type === 'openchamber:permission-auto-accept.updated' || envelope.type === 'openchamber:permission-auto-accept.left-for-user') {
    const classified = classifyStreamPayload(envelope, undefined);
    if (classified.kind !== 'events') return;
    for (const { event } of classified.events) {
      if (event.type !== 'openchamber.permission-auto-accept' && event.type !== 'openchamber.permission-left-for-user') continue;
      for (const listener of listeners) listener({ type: 'permission-policy', event });
    }
    return;
  }

  if (envelope.type === 'openchamber:session-warming') {
    const parsed = sessionWarmingSnapshotSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'session-warming', snapshot: parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:space-queue-stream') {
    const parsed = spaceStreamConnectedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'space-queue-stream', spaceId: parsed.data.spaceId });
    return;
  }

  if (envelope.type === 'openchamber:space-permission-stream') {
    const parsed = spaceStreamConnectedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'space-permission-stream', spaceId: parsed.data.spaceId });
    return;
  }

  if (envelope.type === 'openchamber:heartbeat') {
    return;
  }

  if (envelope.type === 'openchamber:routing.updated') {
    const parsed = routingUpdatedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'routing-updated', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:routing.decision') {
    const parsed = routingDecisionSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'routing-decision', decision: parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:routing.permission-held') {
    const parsed = routingPermissionHeldSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'routing-permission-held', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:routing.safety-skipped') {
    const parsed = routingSafetySkippedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'routing-safety-skipped', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:plan-open-request') {
    const parsed = planOpenRequestSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'plan-open-request', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:file-open-request') {
    const parsed = fileOpenRequestSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'file-open-request', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:browser-provider-reset') {
    const parsed = browserProviderResetSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'browser-provider-reset', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:source-control-providers-changed') {
    for (const listener of listeners) listener({ type: 'source-control-providers-changed' });
    return;
  }

  if (envelope.type === 'openchamber:limit-failover') {
    const parsed = limitFailoverSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'limit-failover', failover: parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:project-context-changed') {
    const parsed = projectContextChangedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'project-context-changed', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:session-drafts-changed') {
    const parsed = sessionDraftsChangedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'session-drafts-changed', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:session-folders-changed') {
    const parsed = sessionFoldersChangedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'session-folders-changed', ...parsed.data });
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
      context: browserControlRequestContextSchema.safeParse(properties?.context).data ?? UNKNOWN_BROWSER_CONTROL_CONTEXT,
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
  const status = rawStatus === 'running' || rawStatus === 'sent' || rawStatus === 'error' ? rawStatus : 'success';
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
  if (relayAbortController || (eventSource && eventSource.readyState !== EventSource.CLOSED)) {
    return;
  }

  cleanupSource();

  // Tell the server what this client can do while the connection lasts. Only a
  // Chromium host can drive a page; a browser tab can display one but not be
  // driven, and the agent tool needs to know which it is talking to without a
  // setting anyone has to remember to change.
  const canControlBrowser = canDriveBrowserPage();
  if (isRelayModeActive()) {
    connectRelay(canControlBrowser);
    return;
  }
  if (typeof EventSource !== 'function') return;
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
    cancelAuthSessionWait();
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
      cancelAuthSessionWait();
      reconnectAttempt = 0;
      cleanupSource();
      cleanupRuntimeChangeSubscription();
    }
  };
};
