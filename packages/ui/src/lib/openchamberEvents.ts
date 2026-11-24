import { getRuntimeUrlResolver } from './runtime-url';
import { runtimeFetch } from './runtime-fetch';
import { useAuthSessionStore, waitForAuthSession } from './runtime-auth-expiry';
import { getRuntimeExtraHeadersSync } from './runtime-auth';
import { isCapacitorApp } from './platform';
import { isRelayModeActive } from './relay/runtime-tunnel';
import { subscribeRuntimeEndpointChanged } from './runtime-switch';
import { isDesktopShell, isVSCodeRuntime } from './desktop';
import { canDriveBrowserPage } from './browser/hostCapability';
import { parseBrowserControlEvent, type BrowserControlEvent } from './browser/controlEvents';
import { messageQueueUpdatedEventSchema, type MessageQueueUpdatedEvent } from '@/stores/messageQueueStore';
import { autoReviewUpdatedEventSchema, type AutoReviewUpdatedEvent } from '@/stores/useAutoReviewStore';
import { prWatchUpdatedEventSchema, type PrWatchUpdatedEvent } from '@/sync/pr-watch';
import { extensionWaitsUpdatedEventSchema, type ExtensionWaitsUpdatedEvent } from '@/sync/extension-waits';
import { laterPagesUpdatedEventSchema, type LaterPagesUpdatedEvent } from '@/sync/later-pages';
import { sessionWarmingSnapshotSchema, type SessionWarmingSnapshot } from '@/stores/useSessionWarmingStore';
import { sessionTodosEventSchema, type SessionTodosEvent } from '@/stores/useSessionTodosStore';
import { isJsonValue, type JsonValue } from '@openchamber/sdk';
import { z } from 'zod';
import { trackedItemRecordsSchema } from './trackedItems/model';
import type { SyncEvent } from './opencode/events';
import { classifyStreamPayload } from '@/sync/event-pipeline';
import { dispatchAppearanceChangedEvent, type AppearanceChangedEvent } from './appearanceEvents';

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

type WorktreeChangedEvent = {
  type: 'worktree-changed';
  directories: string[];
  changedAt: number;
};

const fileOpenRequestSchema = z.object({
  path: z.string().min(1),
  directory: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
});
type FileOpenRequestEvent = { type: 'file-open-request' } & z.infer<typeof fileOpenRequestSchema>;

const planOpenRequestSchema = z.object({
  projectId: z.string().min(1),
  planId: z.string().min(1),
  title: z.string(),
  directory: z.string().min(1).nullable(),
  sessionId: z.string().min(1).nullable(),
});
type PlanOpenRequestEvent = { type: 'plan-open-request' } & z.infer<typeof planOpenRequestSchema>;

type AgentMemoryChangedEvent = {
  type: 'agent-memory-changed';
  scope: 'global' | 'project';
  projectId?: string;
};

const projectContextChangedSchema = z.object({ projectId: z.string().min(1) });
type ProjectContextChangedEvent = { type: 'project-context-changed' } & z.infer<typeof projectContextChangedSchema>;

const sessionFoldersChangedSchema = z.object({ updatedAt: z.number().finite() });
type SessionFoldersChangedEvent = { type: 'session-folders-changed' } & z.infer<typeof sessionFoldersChangedSchema>;

const sessionDraftsChangedSchema = z.object({ updatedAt: z.number().finite() });
type SessionDraftsChangedEvent = { type: 'session-drafts-changed' } & z.infer<typeof sessionDraftsChangedSchema>;

const browserProviderResetSchema = z.object({
  guestId: z.string().min(1),
  guestName: z.string().min(1),
});
type BrowserProviderResetEvent = { type: 'browser-provider-reset' } & z.infer<typeof browserProviderResetSchema>;

type SourceControlProvidersChangedEvent = { type: 'source-control-providers-changed' };

type TrackerProvidersChangedEvent = { type: 'tracker-providers-changed' };

type QuotaProvidersChangedEvent = { type: 'quota-providers-changed' };
type QuotaCredentialsChangedEvent = { type: 'quota-credentials-changed' };

type GuestsChangedEvent = { type: 'guests-changed' };

type GuestMarksChangedEvent = { type: 'guest-marks-changed' };

type GuestServiceEvent = { type: 'guest-service-event'; guestId: string; topic: string; data: JsonValue };

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

const routingUpdatedSchema = z.object({
  available: z.boolean(),
  autoReady: z.boolean(),
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

export type PermissionPolicySyncEvent = Extract<SyncEvent, { type: 'openchamber.permission-auto-accept' | 'openchamber.permission-left-for-user' }>;
type PermissionPolicyEvent = { type: 'permission-policy'; event: PermissionPolicySyncEvent };

const CONTROL_STREAM_SYNC_TYPES = new Set([
  'openchamber:page-waiting',
  'openchamber:page-settled',
  'openchamber:session-assist',
  'openchamber:session-archived',
  'openchamber:workflow-run',
  'openchamber:workflow-run-removed',
]);
export type ControlStreamSyncEvent = Extract<SyncEvent, {
  type: 'openchamber.page-waiting' | 'openchamber.page-settled' | 'openchamber.session-assist' | 'session.patched'
    | 'openchamber.workflow-run' | 'openchamber.workflow-run-removed';
}>;
type ControlStreamSyncEnvelope = { type: 'control-sync'; event: ControlStreamSyncEvent };

const isControlStreamSyncEvent = (event: SyncEvent): event is ControlStreamSyncEvent => (
  event.type === 'openchamber.page-waiting' || event.type === 'openchamber.page-settled'
  || event.type === 'openchamber.session-assist' || event.type === 'session.patched'
  || event.type === 'openchamber.workflow-run' || event.type === 'openchamber.workflow-run-removed'
);

const sharePageChangedSchema = z.object({ sessionId: z.string().min(1), callId: z.string().min(1) });
type SharePageChangedEvent = { type: 'share-page-changed' } & z.infer<typeof sharePageChangedSchema>;

const receivedPageChangedSchema = z.object({ receivedId: z.string().min(1) });
type ReceivedPageChangedEvent = { type: 'received-page-changed' } & z.infer<typeof receivedPageChangedSchema>;

type TrackedItemsChangedEvent = { type: 'tracked-items-changed'; records: z.infer<typeof trackedItemRecordsSchema> };

const eventStreamReadySchema = z.object({ connectionId: z.string().min(1).optional() });
const sourceControlActivitySchema = z.object({ directory: z.string().min(1) });
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
  toastOnly: z.boolean().optional(),
});

type OpenChamberEvent =
  | AppearanceChangedEvent
  | { type: 'terminal-sessions-changed' }
  | { type: 'notification'; payload: z.infer<typeof notificationPropertiesSchema> }
  | { type: 'event-stream-ready'; connectionId: string | null }
  | TrackedItemsChangedEvent
  | { type: 'source-control-activity'; directory: string }
  | RoutingUpdatedEvent
  | RoutingDecisionEvent
  | RoutingPermissionHeldEvent
  | RoutingSafetySkippedEvent
  | MessageQueueUpdatedEvent
  | AutoReviewUpdatedEvent
  | PrWatchUpdatedEvent
  | ExtensionWaitsUpdatedEvent
  | LaterPagesUpdatedEvent
  | PermissionPolicyEvent
  | ControlStreamSyncEnvelope
  | { type: 'session-warming'; snapshot: SessionWarmingSnapshot }
  | { type: 'session-todos'; event: SessionTodosEvent }
  | { type: 'space-queue-stream'; spaceId: string }
  | { type: 'space-permission-stream'; spaceId: string }
  | ScheduledTaskRanEvent
  | SessionCreatedEvent
  | WorktreeChangedEvent
  | BrowserControlEvent
  | FileOpenRequestEvent
  | PlanOpenRequestEvent
  | BrowserProviderResetEvent
  | SourceControlProvidersChangedEvent
  | TrackerProvidersChangedEvent
  | QuotaProvidersChangedEvent
  | QuotaCredentialsChangedEvent
  | GuestsChangedEvent
  | GuestMarksChangedEvent
  | GuestServiceEvent
  | LimitFailoverEvent
  | ProjectContextChangedEvent
  | SharePageChangedEvent
  | ReceivedPageChangedEvent
  | SessionFoldersChangedEvent
  | SessionDraftsChangedEvent
  | AgentMemoryChangedEvent;
type Listener = (event: OpenChamberEvent) => void;

const worktreeChangedPropertiesSchema = z.object({
  directories: z.array(z.string().min(1)).min(1),
  at: z.number().optional(),
});

let eventSource: EventSource | null = null;
let streamAbortController: AbortController | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let authSessionWait: AbortController | null = null;
let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let runtimeChangeUnsubscribe: (() => void) | null = null;
const listeners = new Set<Listener>();
let readyEvent: Extract<OpenChamberEvent, { type: 'event-stream-ready' }> | null = null;

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
  readyEvent = null;
  clearHeartbeatTimer();
  streamAbortController?.abort();
  streamAbortController = null;
  if (eventSource) {
    eventSource.close();
  }
  eventSource = null;
};

const connectFetchStream = (canControlBrowser: boolean) => {
  const controller = new AbortController();
  streamAbortController = controller;
  void (async () => {
    try {
      const response = await runtimeFetch('/api/openchamber/events', {
        query: canControlBrowser ? { browser: '1' } : undefined,
        headers: { Accept: 'text/event-stream' },
        credentials: 'include',
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
    if (streamAbortController !== controller) return;
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

const guestServiceEventSchema = z.object({ guestId: z.string().min(1), topic: z.string().min(1), data: z.json() });

const signalEvents = new Map<string, OpenChamberEvent>([
  ['openchamber:source-control-providers-changed', { type: 'source-control-providers-changed' }],
  ['openchamber:tracker-providers-changed', { type: 'tracker-providers-changed' }],
  ['openchamber:quota-providers-changed', { type: 'quota-providers-changed' }],
  ['openchamber:quota-credentials-changed', { type: 'quota-credentials-changed' }],
  ['openchamber:guests-changed', { type: 'guests-changed' }],
  ['openchamber:guest-marks-changed', { type: 'guest-marks-changed' }],
]);

const dispatchFromEnvelope = (envelope: { type: string; properties: unknown }) => {
  if (envelope.type === 'openchamber:terminal-sessions-changed') {
    for (const listener of listeners) listener({ type: 'terminal-sessions-changed' });
    return;
  }
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
    const event = { type: 'event-stream-ready', connectionId } as const;
    readyEvent = event;
    for (const listener of listeners) listener(event);
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

  if (envelope.type === 'openchamber:extension-waits.updated') {
    const parsed = extensionWaitsUpdatedEventSchema.safeParse(envelope);
    if (parsed.success) {
      for (const listener of listeners) listener(parsed.data);
    }
    return;
  }

  if (envelope.type === 'openchamber:render-later.updated') {
    const parsed = laterPagesUpdatedEventSchema.safeParse(envelope);
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

  if (CONTROL_STREAM_SYNC_TYPES.has(envelope.type)) {
    const classified = classifyStreamPayload(envelope, undefined);
    if (classified.kind !== 'events') return;
    for (const { event } of classified.events) {
      if (!isControlStreamSyncEvent(event)) continue;
      for (const listener of listeners) listener({ type: 'control-sync', event });
    }
    return;
  }

  if (envelope.type === 'openchamber:session-warming') {
    const parsed = sessionWarmingSnapshotSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'session-warming', snapshot: parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:session-todos') {
    const parsed = sessionTodosEventSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'session-todos', event: parsed.data });
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

  const signal = signalEvents.get(envelope.type);
  if (signal) {
    for (const listener of listeners) listener(signal);
    return;
  }

  if (envelope.type === 'openchamber:guest-service-event') {
    const parsed = guestServiceEventSchema.safeParse(envelope.properties);
    if (!parsed.success || !isJsonValue(parsed.data.data)) return;
    for (const listener of listeners) listener({ type: 'guest-service-event', ...parsed.data });
    return;
  }

  if (dispatchAppearanceChangedEvent(envelope, listeners)) return;

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

  if (envelope.type === 'openchamber:share-page') {
    const parsed = sharePageChangedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'share-page-changed', ...parsed.data });
    return;
  }

  if (envelope.type === 'openchamber:received-page') {
    const parsed = receivedPageChangedSchema.safeParse(envelope.properties);
    if (parsed.success) for (const listener of listeners) listener({ type: 'received-page-changed', ...parsed.data });
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

  const browserControlEvent = parseBrowserControlEvent(envelope);
  if (browserControlEvent) {
    for (const listener of listeners) listener(browserControlEvent);
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
  if (streamAbortController || (eventSource && eventSource.readyState !== EventSource.CLOSED)) {
    return;
  }

  cleanupSource();

  const canControlBrowser = canDriveBrowserPage();
  if (isDesktopShell() || isRelayModeActive() || (Object.keys(getRuntimeExtraHeadersSync()).length > 0 && isCapacitorApp())) {
    connectFetchStream(canControlBrowser);
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
  if (isVSCodeRuntime()) return () => undefined;

  listeners.add(listener);
  ensureRuntimeChangeSubscription();
  connect();
  if (readyEvent) {
    const event = readyEvent;
    queueMicrotask(() => {
      if (readyEvent === event && listeners.has(listener)) listener(event);
    });
  }

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
