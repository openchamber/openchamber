import { randomUUID } from 'node:crypto';

import {
  SESSION_EVENTS_IDLE_MS,
  SESSION_EVENTS_PATH,
  SESSION_EVENTS_WIRE_VERSION,
  SESSION_EVENT_PENDING_MAX,
  SESSION_EVENT_REPLY_MAX,
  SESSION_EVENT_TIMEOUT_MS,
  isGuestApproved,
  requestedGuestCapabilities,
} from '@openchamber/sdk';
import { sessionEventResultSchema } from '@openchamber/sdk/schemas';

import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import type { SessionActivityOptions } from '../opencode/session-activity.js';
import { sessionParentId } from '../session-lineage.js';
import type { GuestSessionEventType, GuestSessionLinkedItem, GuestFormField, GuestSessionTitleContent } from '@openchamber/sdk';
import type { GuestRecord } from './contracts.js';
import type {
  PreparedSessionEvent, SessionEventAnnouncement, SessionEventAsk,
  SessionEventQueue, SessionEventRequest, SessionEventsOptions, SessionEventSubscriber, SessionParentCacheEntry, SessionEventPreparation, StoredMetadata,
} from './session-events-contracts.js';
import { hasErrorCode, hasErrorMessage } from './input-guards.js';
import type { JsonValue, JsonObject } from '../shared/json-values.js';


export const SESSION_EVENT_FAILURE_BACKOFF_MS = 30_000;
export const SESSION_EVENT_IDLE_DEDUPE_MS = 5_000;
const SESSION_EVENT_PERMISSION_DEBOUNCE_MS = 500;
export const SESSION_EVENT_ARCHIVE_DEDUPE_MS = 5_000;

const SESSION_PARENT_CACHE_MS = 60_000;
const TRACKED_SESSIONS_MAX = 2_000;
const DELIVERED_PERMISSIONS_MAX = 2_000;
const RESULT_MAX = 4_096;
const LOCATION_SCOPED_FORM_SESSION_ID = 'global';
const INELIGIBLE_CODES = new Set(['NO_SERVICE', 'DISABLED', 'CANCELLED']);
const ANNOUNCEMENT_EVENTS = new Set(['session.idle', 'session.error', 'permission.asked', 'form.created', 'openchamber:page-waiting', 'session.created', 'session.deleted', 'session.status', 'session.archived', 'openchamber:session-archived']);

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isString = (value: unknown): value is string => typeof value === 'string';
const hasProperty = <Key extends string>(value: unknown, key: Key): value is Record<Key, JsonValue | undefined> =>
  value != null && key in Object(value);
const propertyOf = (value: StoredMetadata, key: string): JsonValue | undefined => hasProperty(value, key) ? value[key] : undefined;
const isObject = (value: JsonValue | undefined): value is JsonObject | JsonValue[] => !!value && typeof value === 'object';
const isConditionValue = (value: unknown): value is string | number | boolean =>
  ['string', 'number', 'boolean'].includes(typeof value);
const isFiniteNumber = (value: unknown): value is number => Number.isFinite(value);
const hasFormId = (value: JsonValue | undefined): value is JsonObject & { id: string } =>
  !!value && isText(propertyOf(value, 'id'));

export const isSessionEventSubscriber = (guest: GuestRecord | null | undefined): guest is SessionEventSubscriber => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return !!guest
    && guest.enabled !== false
    && Array.isArray(guest.sessionEvents?.events)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

const sessionIdOf = (payload: JsonValue) => {
  const id = propertyOf(propertyOf(payload, 'properties'), 'sessionID');
  return isText(id) ? id : null;
};

const directoryOf = (payload: JsonValue, directory: string) => {
  const own = propertyOf(propertyOf(payload, 'properties'), 'directory');
  if (isText(own)) return own;
  return isText(directory) && directory !== 'global' ? directory : null;
};

const titleOf = (record: JsonObject | JsonValue[] | null) => {
  const title = propertyOf(record, 'title');
  return isText(title) ? title : null;
};
const recordDirectoryOf = (record: JsonObject | JsonValue[] | null) => {
  const directory = propertyOf(propertyOf(record, 'location'), 'directory');
  return isText(directory) ? directory : null;
};

const linkedItemsOf = (metadata: StoredMetadata) => {
  const entries = propertyOf(propertyOf(metadata, 'openchamber'), 'linked_issues');
  if (!Array.isArray(entries)) return [];
  const items: GuestSessionLinkedItem[] = [];
  for (const entry of entries) {
    const id = propertyOf(entry, 'id'), kind = propertyOf(entry, 'kind'), url = propertyOf(entry, 'url');
    if (!isText(id) || !isText(kind) || !isText(url)) continue;
    const item: GuestSessionLinkedItem = { id, kind, url };
    const provider = propertyOf(entry, 'provider'), identifier = propertyOf(entry, 'identifier'), number = propertyOf(entry, 'number');
    if (isText(provider)) item.provider = provider;
    if (isText(identifier)) item.identifier = identifier;
    if (isSafeInteger(number)) item.number = number;
    items.push(item);
  }
  return items;
};

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);
const stringList = (value: JsonValue | undefined): string[] => (Array.isArray(value) ? value.filter(isString) : []);

const FORM_FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'multiselect', 'external']);

const hasOptionValue = (option: JsonValue): option is JsonObject & { value: string } => isText(propertyOf(option, 'value'));
const isClause = (clause: JsonValue): clause is JsonObject & { key: string; op: 'eq' | 'neq'; value: string | number | boolean } =>
  isText(propertyOf(clause, 'key')) && (propertyOf(clause, 'op') === 'eq' || propertyOf(clause, 'op') === 'neq') && isConditionValue(propertyOf(clause, 'value'));
const isFormFieldType = (value: unknown): value is GuestFormField['type'] => isString(value) && FORM_FIELD_TYPES.has(value);
const isVisibleField = (field: JsonValue): field is JsonObject & { key: string; type: GuestFormField['type'] } =>
  isText(propertyOf(field, 'key')) && isFormFieldType(propertyOf(field, 'type')) && propertyOf(field, 'hidden') !== true;
const formFieldOf = (field: JsonObject & { key: string; type: GuestFormField['type'] }) => {
  const options = (Array.isArray(field.options) ? field.options : [])
    .filter(hasOptionValue)
    .map((option) => ({ value: option.value, label: isString(option.label) ? option.label : option.value }));
  const when = (Array.isArray(field.when) ? field.when : [])
    .filter(isClause)
    .map((clause) => ({ key: clause.key, op: clause.op, value: clause.value }));
  const result: GuestFormField = {
    key: field.key,
    type: field.type,
    title: isString(field.title) ? field.title : '',
    description: isString(field.description) ? field.description : null,
    required: field.required === true,
  };
  if (options.length > 0) result.options = options;
  if (field.type === 'multiselect' && field.custom === true) result.custom = true;
  if (when.length > 0) result.when = when;
  return result;
};

const formAskOf = (form: JsonObject & { id: string }): SessionEventAsk => ({
  kind: 'form',
  id: String(form.id),
  title: isString(form.title) ? form.title : '',
  fields: (Array.isArray(form.fields) ? form.fields : [])
    .filter(isVisibleField)
    .map(formFieldOf),
});

const parseJson = (text: string): JsonValue | undefined => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const createExtensionSessionEvents = ({
  listGuests,
  proxyServiceRequest,
  persistPath,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  fetchImpl = (...args) => fetch(...args),
  fetchLastAssistantMessageText,
  readSessionMetadata = null,
  isSessionAutoAccepting = async () => false,
  isInAutoReview = () => false,
  now = Date.now,
  timers = { setTimeout, clearTimeout },
  createId = () => randomUUID(),
  warn = (...args) => console.warn(...args),
}: SessionEventsOptions) => {
  const controller = new AbortController();
  let stopped = false;
  const openCode: Required<Pick<SessionActivityOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders' | 'fetchImpl'>> = {
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    fetchImpl: (url, options = {}) => {
      if (stopped) return Promise.reject(controller.signal.reason);
      return fetchImpl(url, {
        ...options,
        signal: options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal,
      });
    },
  };
  const activityProbe = createSessionActivityProbe({ ...openCode, timeoutMs: 2_000 });

  const openAsks = new Map<string, Set<string>>();
  const permissionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const deliveredPermissions = new Set<string>();
  const lastTerminalAt = new Map<string, { at: number | undefined }>();
  const parentCache = new Map<string | null, SessionParentCacheEntry>();
  const busySessions = new Map<string | null, boolean>();
  const archivedSessions = new Map<string | null, number>();
  const queues = new Map<string, SessionEventQueue>();

  const bound = <Key, Value>(map: Map<Key, Value>) => {
    if (map.size >= TRACKED_SESSIONS_MAX) {
      const first = map.keys().next();
      if (!first.done) map.delete(first.value);
    }
  };

  const addAsk = (sessionId: string, key: string) => {
    let asks = openAsks.get(sessionId);
    if (!asks) {
      bound(openAsks);
      asks = new Set<string>();
      openAsks.set(sessionId, asks);
    }
    asks.add(key);
  };

  const removeAsk = (sessionId: string, key: string) => {
    const asks = openAsks.get(sessionId);
    if (!asks) return;
    asks.delete(key);
    if (asks.size === 0) openAsks.delete(sessionId);
  };

  const hasAsk = (sessionId: string, key: string) => Boolean(openAsks.get(sessionId)?.has(key));

  const cancelPermissionTimer = (key: string) => {
    const timer = permissionTimers.get(key);
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    permissionTimers.delete(key);
  };

  const clearPermissionAsks = (sessionId: string) => {
    const asks = openAsks.get(sessionId);
    if (asks) {
      for (const key of [...asks]) if (key.startsWith('permission:')) asks.delete(key);
      if (asks.size === 0) openAsks.delete(sessionId);
    }
    for (const key of [...permissionTimers.keys()]) {
      if (key.startsWith(`${sessionId}:`)) cancelPermissionTimer(key);
    }
  };

  const markPermissionDelivered = (key: string) => {
    if (deliveredPermissions.size >= DELIVERED_PERMISSIONS_MAX) {
      const first = deliveredPermissions.values().next();
      if (!first.done) deliveredPermissions.delete(first.value);
    }
    deliveredPermissions.add(key);
  };

  const fetchSessionRecord = async (sessionId: string | null): Promise<JsonObject | JsonValue[] | null> => {
    if (stopped) return null;
    try {
      const response = await openCode.fetchImpl(buildOpenCodeUrl(`/api/session/${encodeURIComponent(String(sessionId))}`, ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const body: JsonValue = await response.json().catch(() => null);
      const session = unwrapOpenCodeResponse(body);
      return isObject(session) ? session : null;
    } catch {
      return null;
    }
  };

  const readMetadata = async (sessionId: string | null) => {
    if (stopped || !readSessionMetadata) return null;
    try {
      return (await readSessionMetadata(sessionId)) ?? null;
    } catch {
      return null;
    }
  };

  const hasActiveGoal = async (sessionId: string) => {
    const goal = propertyOf(propertyOf(await readMetadata(sessionId), 'openchamber'), 'goal');
    return Boolean(isObject(goal) && propertyOf(goal, 'status') === 'active');
  };

  const hasWorkingChildren = async (sessionId: string) => {
    if (stopped) return false;
    try {
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      if (stopped || !statuses) return false;
      return (await activityProbe.hasWorkingChildren(sessionId, statuses)) === true;
    } catch {
      return false;
    }
  };

  const subscribersFor = async (type: GuestSessionEventType) => {
    if (stopped) return [];
    let guests;
    try {
      guests = await listGuests();
    } catch (error) {
      warn('[session-events] the extension catalog could not be read:', hasErrorMessage(error) ? error.message ?? error : error);
      return [];
    }
    if (!Array.isArray(guests)) return [];
    return guests.filter((guest): guest is SessionEventSubscriber => isSessionEventSubscriber(guest) && guest.sessionEvents.events.includes(type));
  };

  const holdsTranscript = (guest: SessionEventSubscriber) => guest.sessionEvents.content === true && guest.capabilityGrants.includes('transcript');

  const announce = async ({ type, payload, directory, subscribers, permission, question, contentOf }: SessionEventAnnouncement): Promise<PreparedSessionEvent[]> => {
    if (stopped) return [];
    const sessionId = sessionIdOf(payload);
    const wantsContent = subscribers.some(holdsTranscript);
    let record = null;
    const cached = parentCache.get(sessionId);
    if (cached?.pending) {
      record = await cached.pending;
    } else if (wantsContent || !cached || now() - cached.at > SESSION_PARENT_CACHE_MS) {
      const loading = { at: now(), pending: fetchSessionRecord(sessionId) };
      bound(parentCache);
      parentCache.set(sessionId, loading);
      record = await loading.pending;
      if (parentCache.get(sessionId) === loading) {
        if (record) parentCache.set(sessionId, { at: now(), parentId: sessionParentId(record), directory: recordDirectoryOf(record) });
        else parentCache.delete(sessionId);
      }
    }
    if (stopped) return [];
    const parentId = record ? sessionParentId(record) : parentCache.get(sessionId)?.parentId ?? null;
    const linked = linkedItemsOf(await readMetadata(sessionId));
    if (stopped) return [];
    const id = propertyOf(payload, 'id'), created = propertyOf(payload, 'created');
    const event: SessionEventRequest['event'] = {
      id: isText(id) ? id : `oc-${createId()}`,
      type,
      at: isFiniteNumber(created) ? created : now(),
      session: { id: sessionId, parentId },
      project: { directory: directoryOf(payload, directory) ?? recordDirectoryOf(record) ?? parentCache.get(sessionId)?.directory ?? null },
      linked,
    };
    if (permission) event.permission = permission;
    if (question) event.question = question;
    const content = wantsContent ? await contentOf(record) : null;
    if (stopped) return [];
    return subscribers.map((guest) => {
      const request: SessionEventRequest = { v: SESSION_EVENTS_WIRE_VERSION, requestId: createId(), event };
      if (content && holdsTranscript(guest)) request.content = content;
      return { guest, type, body: JSON.stringify(request) };
    });
  };

  const queueOf = (guest: SessionEventSubscriber) => {
    let queue = queues.get(guest.id);
    if (!queue) {
      queue = { guest, items: [], running: false, backoffUntil: 0, warnedFull: false, warnedNoService: false };
      queues.set(guest.id, queue);
    }
    queue.guest = guest;
    return queue;
  };

  const enqueue = (guest: SessionEventSubscriber, type: GuestSessionEventType, body: string) => {
    if (stopped) return;
    const queue = queueOf(guest);
    if (queue.backoffUntil > now()) return;
    if (queue.items.length >= SESSION_EVENT_PENDING_MAX) {
      if (!queue.warnedFull) {
        warn(`[session-events] ${guest.id}: more than ${SESSION_EVENT_PENDING_MAX} events are waiting for its service; newer ones are dropped until it catches up`);
        queue.warnedFull = true;
      }
      return;
    }
    queue.items.push({ type, body });
    void pump(queue);
  };

  const fail = (queue: SessionEventQueue, type: GuestSessionEventType, reason: string) => {
    queue.items.length = 0;
    queue.backoffUntil = now() + SESSION_EVENT_FAILURE_BACKOFF_MS;
    warn(`[session-events] ${queue.guest.id}: delivering ${type} failed (${reason}); its events are dropped for the next ${SESSION_EVENT_FAILURE_BACKOFF_MS / 1000} s`);
  };

  const explainNoService = async (queue: SessionEventQueue, cause: unknown) => {
    if (queue.warnedNoService) return;
    let guests;
    try {
      guests = await listGuests();
    } catch {
      return;
    }
    if (!Array.isArray(guests) || !guests.some((guest) => guest.id === queue.guest.id && isSessionEventSubscriber(guest))) return;
    queue.warnedNoService = true;
    warn(`[session-events] ${queue.guest.id}: its service cannot be started (${hasErrorMessage(cause) ? cause.message : undefined}); no event reaches it until that is fixed`);
  };

  const deliver = async (queue: SessionEventQueue, { type, body }: Pick<PreparedSessionEvent, 'type' | 'body'>) => {
    const { guest } = queue;
    let answer;
    try {
      answer = await proxyServiceRequest({
        guestId: guest.id,
        guestName: guest.name,
        packageRoot: guest.packageRoot,
        service: guest.service,
        granted: guest.capabilityGrants,
        persistPath,
        method: 'POST',
        path: SESSION_EVENTS_PATH,
        body,
        timeoutMs: SESSION_EVENT_TIMEOUT_MS,
        idleStopMs: SESSION_EVENTS_IDLE_MS,
        signal: controller.signal,
        responseMax: RESULT_MAX,
      });
    } catch (error) {
      const code = hasErrorCode(error) ? error.code : undefined;
      if (isString(code) && INELIGIBLE_CODES.has(code)) {
        queue.items.length = 0;
        if (code === 'NO_SERVICE') await explainNoService(queue, error);
        return;
      }
      fail(queue, type, `${code ?? 'error'}: ${hasErrorMessage(error) ? error.message ?? error : error}`);
      return;
    }
    const parsed = answer.status === 200 ? sessionEventResultSchema.safeParse(parseJson(answer.body)) : null;
    if (parsed?.success && parsed.data.ok) {
      queue.warnedNoService = false;
      return;
    }
    fail(queue, type, parsed?.success ? `the service answered "${propertyOf(parsed.data, 'error')}"` : `HTTP ${answer.status} with an unexpected body`);
  };

  const pump = async (queue: SessionEventQueue) => {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.items.length > 0 && !stopped) {
        const item = queue.items.shift();
        if (item) await deliver(queue, item);
      }
    } finally {
      queue.running = false;
      queue.warnedFull = false;
    }
  };

  const preparations: SessionEventPreparation[] = [];
  let warnedPreparationFull = false;
  const prepareInOrder = (prepare: (admitted: boolean) => Promise<PreparedSessionEvent[] | undefined | void>) => {
    if (stopped) return;
    if (preparations.length > SESSION_EVENT_PENDING_MAX) {
      if (!warnedPreparationFull) {
        warn(`[session-events] more than ${SESSION_EVENT_PENDING_MAX} events are waiting for preparation; newer announcements are dropped until it catches up`);
        warnedPreparationFull = true;
      }
      prepare(false).catch(reportFailure);
      return;
    }
    const entry: SessionEventPreparation = { items: null };
    preparations.push(entry);
    Promise.resolve(prepare(true)).catch((error) => { reportFailure(error); return []; }).then((items) => {
      if (stopped) return;
      entry.items = items ?? [];
      while (preparations[0]?.items) {
        const ready = preparations.shift();
        if (ready?.items) for (const item of ready.items) enqueue(item.guest, item.type, item.body);
        warnedPreparationFull = false;
      }
    }).catch(reportFailure);
  };

  const onIdle = async (payload: JsonValue, directory: string, admitted: boolean) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return;
    if (propertyOf(propertyOf(payload, 'properties'), 'aborted') === true) {
      openAsks.delete(sessionId);
      clearPermissionAsks(sessionId);
      return;
    }
    if (!admitted) return;
    const turnEndedAt = now();
    if (openAsks.has(sessionId)) return;
    let turn = lastTerminalAt.get(sessionId);
    if (!turn) {
      bound(lastTerminalAt);
      turn = { at: undefined };
      lastTerminalAt.set(sessionId, turn);
    }
    if (turn.at !== undefined && turnEndedAt - turn.at < SESSION_EVENT_IDLE_DEDUPE_MS) return;
    turn.at = turnEndedAt;
    let announced = false;
    try {
      const subscribers = await subscribersFor('turn-finished');
      if (subscribers.length === 0) return;
      if (await hasWorkingChildren(sessionId)) return;
      if (await hasActiveGoal(sessionId)) return;
      if (isInAutoReview(sessionId, turnEndedAt)) return;
      const prepared = await announce({
        type: 'turn-finished',
        payload,
        directory,
        subscribers,
        contentOf: async (record) => {
          const text = await fetchLastAssistantMessageText(sessionId, undefined, SESSION_EVENT_REPLY_MAX + 1);
          const truncated = text.length > SESSION_EVENT_REPLY_MAX;
          return {
            type: 'turn-finished',
            sessionTitle: titleOf(record),
            reply: truncated ? text.slice(0, SESSION_EVENT_REPLY_MAX) : text,
            replyTruncated: truncated,
          };
        },
      });
      announced = true;
      return prepared;
    } finally {
      if (!announced) turn.at = undefined;
    }
  };

  const onError = async (payload: JsonValue, directory: string, admitted: boolean) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return;
    openAsks.delete(sessionId);
    clearPermissionAsks(sessionId);
    if (!admitted) return;
    const subscribers = await subscribersFor('turn-failed');
    if (subscribers.length === 0) return;
    const error = propertyOf(propertyOf(payload, 'properties'), 'error');
    return announce({
      type: 'turn-failed',
      payload,
      directory,
      subscribers,
      contentOf: async (record) => {
        const errorType = propertyOf(error, 'type'), errorName = propertyOf(error, 'name'), errorMessage = propertyOf(error, 'message');
        return {
          type: 'turn-failed',
          sessionTitle: titleOf(record),
          error: {
            type: isText(errorType) ? errorType : isText(errorName) ? errorName : 'Error',
            message: isString(errorMessage) ? errorMessage : '',
          },
        };
      },
    });
  };

  const onPermissionAsked = async (payload: JsonValue, directory: string, admitted: boolean) => {
    const sessionId = sessionIdOf(payload);
    const props = propertyOf(payload, 'properties');
    const requestId = propertyOf(props, 'id');
    if (!sessionId || !isText(requestId)) return;
    const askKey = `permission:${requestId}`;
    const key = `${sessionId}:${requestId}`;
    addAsk(sessionId, askKey);
    if (!admitted) return;
    if (deliveredPermissions.has(key) || permissionTimers.has(key)) return;
    const projectDirectory = directoryOf(payload, directory);
    if (await isSessionAutoAccepting(sessionId, projectDirectory, requestId)) {
      markPermissionDelivered(key);
      return;
    }
    if (stopped || permissionTimers.has(key) || !hasAsk(sessionId, askKey)) return;
    const timer = timers.setTimeout(() => {
      permissionTimers.delete(key);
      prepareInOrder(async (admitted) => {
        if (!admitted) return;
        if (!hasAsk(sessionId, askKey) || deliveredPermissions.has(key)) return;
        if (await isSessionAutoAccepting(sessionId, projectDirectory, requestId)) {
          markPermissionDelivered(key);
          return;
        }
        const subscribers = await subscribersFor('permission-asked');
        markPermissionDelivered(key);
        if (subscribers.length === 0) return;
        return announce({
          type: 'permission-asked',
          payload,
          directory,
          subscribers,
          permission: { requestId },
          contentOf: async (record) => {
            const properties = propertyOf(payload, 'properties');
            const action = propertyOf(properties, 'action'), message = propertyOf(properties, 'message');
            return {
              type: 'permission-asked',
              sessionTitle: titleOf(record),
              action: isText(action) ? action : '',
              resources: stringList(propertyOf(properties, 'resources')),
              message: isString(message) ? message : null,
            };
          },
        });
      });
    }, SESSION_EVENT_PERMISSION_DEBOUNCE_MS);
    permissionTimers.set(key, timer);
  };

  const onPermissionReplied = (payload: JsonValue) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return;
    const requestId = propertyOf(propertyOf(payload, 'properties'), 'requestID');
    if (!isText(requestId)) {
      clearPermissionAsks(sessionId);
      return;
    }
    removeAsk(sessionId, `permission:${requestId}`);
    cancelPermissionTimer(`${sessionId}:${requestId}`);
  };

  const onQuestion = async (payload: JsonValue, directory: string, askKey: string, ask: SessionEventAsk, admitted: boolean) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return;
    addAsk(sessionId, askKey);
    if (!admitted) return;
    const subscribers = await subscribersFor('question-asked');
    if (subscribers.length === 0) return;
    return announce({
      type: 'question-asked',
      payload,
      directory,
      subscribers,
      question: { kind: ask.kind, id: ask.id },
      contentOf: async (record) => ({ type: 'question-asked', sessionTitle: titleOf(record), ask }),
    });
  };

  const onLifecycle = async (type: GuestSessionTitleContent['type'], payload: JsonValue, directory: string, admitted: boolean) => {
    if (!admitted) return undefined;
    const subscribers = await subscribersFor(type);
    if (subscribers.length === 0) return undefined;
    return announce({
      type,
      payload,
      directory,
      subscribers,
      contentOf: async (record) => ({ type, sessionTitle: titleOf(record) }),
    });
  };

  const onArchived = (payload: JsonValue, directory: string, admitted: boolean) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId || !admitted) return undefined;
    const at = now();
    const announcedAt = archivedSessions.get(sessionId);
    if (announcedAt !== undefined && at - announcedAt < SESSION_EVENT_ARCHIVE_DEDUPE_MS) return undefined;
    bound(archivedSessions);
    archivedSessions.set(sessionId, at);
    return onLifecycle('session-archived', payload, directory, admitted);
  };

  const reportFailure = (cause: unknown) => {
    warn('[session-events] an event could not be handled:', hasErrorMessage(cause) ? cause.message ?? cause : cause);
  };

  const handle = async (payload: JsonValue, directory: string, admitted = true) => {
    const type = propertyOf(payload, 'type');
    const props = propertyOf(payload, 'properties');
    switch (type) {
      case 'session.idle':
        busySessions.delete(sessionIdOf(payload));
        return onIdle(payload, directory, admitted);
      case 'session.error':
        busySessions.delete(sessionIdOf(payload));
        return onError(payload, directory, admitted);
      case 'permission.asked':
        return onPermissionAsked(payload, directory, admitted);
      case 'permission.replied':
        return onPermissionReplied(payload);
      case 'session.status': {
        const sessionId = sessionIdOf(payload);
        if (!sessionId) return undefined;
        if (propertyOf(propertyOf(props, 'status'), 'type') === 'idle') busySessions.delete(sessionId);
        if (propertyOf(propertyOf(props, 'status'), 'type') !== 'busy') return undefined;
        lastTerminalAt.delete(sessionId);
        if (busySessions.has(sessionId)) return undefined;
        bound(busySessions);
        busySessions.set(sessionId, true);
        return onLifecycle('turn-started', payload, directory, admitted);
      }
      case 'session.created':
        return onLifecycle('session-created', payload, directory, admitted);
      case 'session.deleted': {
        const id = propertyOf(propertyOf(props, 'info'), 'id') ?? propertyOf(props, 'sessionID');
        const prepared = await onLifecycle('session-deleted', payload, directory, admitted);
        if (isText(id)) {
          parentCache.delete(id);
          busySessions.delete(id);
          archivedSessions.delete(id);
        }
        return prepared;
      }
      case 'session.archived':
        return onArchived(payload, directory, admitted);
      case 'openchamber:session-archived':
        if (Number.isFinite(propertyOf(props, 'archivedAt'))) return onArchived(payload, directory, admitted);
        archivedSessions.delete(sessionIdOf(payload));
        return undefined;
      case 'session.unarchived':
        archivedSessions.delete(sessionIdOf(payload));
        return undefined;
      case 'session.updated':
      case 'session.patched': {
        const id = propertyOf(propertyOf(props, 'info'), 'id') ?? propertyOf(props, 'sessionID');
        if (isText(id)) parentCache.delete(id);
        return undefined;
      }
      case 'form.created': {
        const form = propertyOf(props, 'form');
        if (!hasFormId(form) || propertyOf(props, 'sessionID') === LOCATION_SCOPED_FORM_SESSION_ID) return undefined;
        return onQuestion(payload, directory, `form:${form.id}`, formAskOf(form), admitted);
      }
      case 'form.settled': {
        const sessionId = sessionIdOf(payload);
        const formId = propertyOf(props, 'formID');
        if (sessionId && isText(formId)) removeAsk(sessionId, `form:${formId}`);
        return undefined;
      }
      case 'openchamber:page-waiting': {
        const page = propertyOf(props, 'page');
        if (!hasFormId(page)) return undefined;
        return onQuestion(payload, directory, `page:${page.id}`, {
          kind: 'page', id: page.id, title: isString(page.title) ? page.title : '',
        }, admitted);
      }
      case 'openchamber:page-settled': {
        const sessionId = sessionIdOf(payload);
        const pageId = propertyOf(props, 'pageID');
        if (sessionId && isText(pageId)) removeAsk(sessionId, `page:${pageId}`);
        return undefined;
      }
      default:
        return undefined;
    }
  };

  const processPayload = (payload: JsonValue | undefined, directory = '') => {
    if (stopped || !isObject(payload)) return;
    const type = propertyOf(payload, 'type');
    if (isString(type) && ANNOUNCEMENT_EVENTS.has(type)) prepareInOrder((admitted) => handle(payload, directory, admitted));
    else handle(payload, directory).catch(reportFailure);
  };

  const reconcile = async () => {
    let guests;
    try {
      guests = await listGuests();
    } catch {
      return;
    }
    const subscribers = new Map((Array.isArray(guests) ? guests : []).filter(isSessionEventSubscriber).map((guest) => [guest.id, guest]));
    for (const [id, queue] of queues) {
      const guest = subscribers.get(id);
      if (guest) {
        queue.guest = guest;
        queue.backoffUntil = 0;
        queue.warnedNoService = false;
      } else {
        queue.items.length = 0;
        queues.delete(id);
      }
    }
  };

  const stop = () => {
    stopped = true;
    controller.abort();
    for (const timer of permissionTimers.values()) timers.clearTimeout(timer);
    permissionTimers.clear();
    for (const queue of queues.values()) queue.items.length = 0;
    queues.clear();
    preparations.length = 0;
    parentCache.clear();
    openAsks.clear();
  };

  return { processPayload, reconcile, stop };
};
