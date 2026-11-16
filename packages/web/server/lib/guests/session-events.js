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
import { sessionParentId } from '../session-lineage.js';


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

const isText = (value) => typeof value === 'string' && value.length > 0;

export const isSessionEventSubscriber = (guest) => {
  const granted = Array.isArray(guest?.capabilityGrants) ? guest.capabilityGrants : [];
  return Boolean(guest)
    && guest.enabled !== false
    && Array.isArray(guest.sessionEvents?.events)
    && granted.includes('service')
    && isGuestApproved({ requested: requestedGuestCapabilities(guest), granted });
};

const sessionIdOf = (payload) => {
  const id = payload?.properties?.sessionID;
  return isText(id) ? id : null;
};

const directoryOf = (payload, directory) => {
  const own = payload?.properties?.directory;
  if (isText(own)) return own;
  return isText(directory) && directory !== 'global' ? directory : null;
};

const titleOf = (record) => (isText(record?.title) ? record.title : null);
const recordDirectoryOf = (record) => (isText(record?.location?.directory) ? record.location.directory : null);

const linkedItemsOf = (metadata) => {
  const entries = metadata?.openchamber?.linked_issues;
  if (!Array.isArray(entries)) return [];
  const items = [];
  for (const entry of entries) {
    if (!isText(entry?.id) || !isText(entry?.kind) || !isText(entry?.url)) continue;
    const item = { id: entry.id, kind: entry.kind, url: entry.url };
    if (isText(entry.provider)) item.provider = entry.provider;
    if (isText(entry.identifier)) item.identifier = entry.identifier;
    if (Number.isSafeInteger(entry.number)) item.number = entry.number;
    items.push(item);
  }
  return items;
};

const stringList = (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : []);

const FORM_FIELD_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'multiselect', 'external']);

const formFieldOf = (field) => {
  const options = (Array.isArray(field.options) ? field.options : [])
    .filter((option) => isText(option?.value))
    .map((option) => ({ value: option.value, label: typeof option.label === 'string' ? option.label : option.value }));
  const when = (Array.isArray(field.when) ? field.when : [])
    .filter((clause) => isText(clause?.key) && (clause.op === 'eq' || clause.op === 'neq') && ['string', 'number', 'boolean'].includes(typeof clause.value))
    .map((clause) => ({ key: clause.key, op: clause.op, value: clause.value }));
  const result = {
    key: field.key,
    type: field.type,
    title: typeof field.title === 'string' ? field.title : '',
    description: typeof field.description === 'string' ? field.description : null,
    required: field.required === true,
  };
  if (options.length > 0) result.options = options;
  if (field.type === 'multiselect' && field.custom === true) result.custom = true;
  if (when.length > 0) result.when = when;
  return result;
};

const formAskOf = (form) => ({
  kind: 'form',
  id: String(form.id),
  title: typeof form.title === 'string' ? form.title : '',
  fields: (Array.isArray(form.fields) ? form.fields : [])
    .filter((field) => isText(field?.key) && FORM_FIELD_TYPES.has(field.type) && field.hidden !== true)
    .map(formFieldOf),
});

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/**
 * @param {{
 *   listGuests: () => Promise<object[]>,
 *   proxyServiceRequest: (params: object) => Promise<{ status: number, body: string }>,
 *   persistPath: string,
 *   buildOpenCodeUrl: (path: string, query: string) => string,
 *   getOpenCodeAuthHeaders: () => Record<string, string>,
 *   fetchImpl?: typeof fetch,
 *   fetchLastAssistantMessageText: (sessionId: string, messageId: string | undefined, maxLength: number) => Promise<string>,
 *   readSessionMetadata?: ((sessionId: string) => unknown) | null,
 *   isSessionAutoAccepting?: (sessionId: string, directory: string | null, requestId: string) => Promise<boolean> | boolean,
 *   isInAutoReview?: (sessionId: string, turnEndedAt: number) => boolean,
 *   now?: () => number,
 *   timers?: { setTimeout: typeof setTimeout, clearTimeout: typeof clearTimeout },
 *   createId?: () => string,
 *   warn?: (...args: unknown[]) => void,
 * }} deps `listGuests` is the catalog listing (cached by the server);
 * `readSessionMetadata` is OpenChamber's own session metadata (linked items,
 * the goal); `isSessionAutoAccepting` is the permission-auto-accept runtime's
 * predicate; `isInAutoReview` the auto-review runtime's.
 */
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
}) => {
  const controller = new AbortController();
  let stopped = false;
  const openCode = {
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

  const openAsks = new Map();
  const permissionTimers = new Map();
  const deliveredPermissions = new Set();
  const lastTerminalAt = new Map();
  const parentCache = new Map();
  const busySessions = new Map();
  const archivedSessions = new Map();
  const queues = new Map();

  const bound = (map) => {
    if (map.size >= TRACKED_SESSIONS_MAX) map.delete(map.keys().next().value);
  };

  const addAsk = (sessionId, key) => {
    let asks = openAsks.get(sessionId);
    if (!asks) {
      bound(openAsks);
      asks = new Set();
      openAsks.set(sessionId, asks);
    }
    asks.add(key);
  };

  const removeAsk = (sessionId, key) => {
    const asks = openAsks.get(sessionId);
    if (!asks) return;
    asks.delete(key);
    if (asks.size === 0) openAsks.delete(sessionId);
  };

  const hasAsk = (sessionId, key) => Boolean(openAsks.get(sessionId)?.has(key));

  const cancelPermissionTimer = (key) => {
    const timer = permissionTimers.get(key);
    if (timer === undefined) return;
    timers.clearTimeout(timer);
    permissionTimers.delete(key);
  };

  const clearPermissionAsks = (sessionId) => {
    const asks = openAsks.get(sessionId);
    if (asks) {
      for (const key of [...asks]) if (key.startsWith('permission:')) asks.delete(key);
      if (asks.size === 0) openAsks.delete(sessionId);
    }
    for (const key of [...permissionTimers.keys()]) {
      if (key.startsWith(`${sessionId}:`)) cancelPermissionTimer(key);
    }
  };

  const markPermissionDelivered = (key) => {
    if (deliveredPermissions.size >= DELIVERED_PERMISSIONS_MAX) {
      deliveredPermissions.delete(deliveredPermissions.values().next().value);
    }
    deliveredPermissions.add(key);
  };

  const fetchSessionRecord = async (sessionId) => {
    if (stopped) return null;
    try {
      const response = await openCode.fetchImpl(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2_000),
      });
      if (!response.ok) return null;
      const session = unwrapOpenCodeResponse(await response.json().catch(() => null));
      return session && typeof session === 'object' ? session : null;
    } catch {
      return null;
    }
  };

  const readMetadata = async (sessionId) => {
    if (stopped || typeof readSessionMetadata !== 'function') return null;
    try {
      return (await readSessionMetadata(sessionId)) ?? null;
    } catch {
      return null;
    }
  };

  const hasActiveGoal = async (sessionId) => {
    const goal = (await readMetadata(sessionId))?.openchamber?.goal;
    return Boolean(goal && typeof goal === 'object' && goal.status === 'active');
  };

  const hasWorkingChildren = async (sessionId) => {
    if (stopped) return false;
    try {
      const statuses = await activityProbe.fetchActiveSessionStatuses();
      if (stopped || !statuses) return false;
      return (await activityProbe.hasWorkingChildren(sessionId, statuses)) === true;
    } catch {
      return false;
    }
  };

  const subscribersFor = async (type) => {
    if (stopped) return [];
    let guests;
    try {
      guests = await listGuests();
    } catch (error) {
      warn('[session-events] the extension catalog could not be read:', error?.message ?? error);
      return [];
    }
    if (!Array.isArray(guests)) return [];
    return guests.filter((guest) => isSessionEventSubscriber(guest) && guest.sessionEvents.events.includes(type));
  };

  const holdsTranscript = (guest) => guest.sessionEvents.content === true && guest.capabilityGrants.includes('transcript');

  const announce = async ({ type, payload, directory, subscribers, permission, question, contentOf }) => {
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
    const event = {
      id: isText(payload.id) ? payload.id : `oc-${createId()}`,
      type,
      at: Number.isFinite(payload.created) ? payload.created : now(),
      session: { id: sessionId, parentId },
      project: { directory: directoryOf(payload, directory) ?? recordDirectoryOf(record) ?? parentCache.get(sessionId)?.directory ?? null },
      linked,
    };
    if (permission) event.permission = permission;
    if (question) event.question = question;
    const content = wantsContent ? await contentOf(record) : null;
    if (stopped) return [];
    return subscribers.map((guest) => {
      const request = { v: SESSION_EVENTS_WIRE_VERSION, requestId: createId(), event };
      if (content && holdsTranscript(guest)) request.content = content;
      return { guest, type, body: JSON.stringify(request) };
    });
  };

  const queueOf = (guest) => {
    let queue = queues.get(guest.id);
    if (!queue) {
      queue = { guest, items: [], running: false, backoffUntil: 0, warnedFull: false, warnedNoService: false };
      queues.set(guest.id, queue);
    }
    queue.guest = guest;
    return queue;
  };

  const enqueue = (guest, type, body) => {
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

  const fail = (queue, type, reason) => {
    queue.items.length = 0;
    queue.backoffUntil = now() + SESSION_EVENT_FAILURE_BACKOFF_MS;
    warn(`[session-events] ${queue.guest.id}: delivering ${type} failed (${reason}); its events are dropped for the next ${SESSION_EVENT_FAILURE_BACKOFF_MS / 1000} s`);
  };

  const explainNoService = async (queue, error) => {
    if (queue.warnedNoService) return;
    let guests;
    try {
      guests = await listGuests();
    } catch {
      return;
    }
    if (!Array.isArray(guests) || !guests.some((guest) => guest.id === queue.guest.id && isSessionEventSubscriber(guest))) return;
    queue.warnedNoService = true;
    warn(`[session-events] ${queue.guest.id}: its service cannot be started (${error.message}); no event reaches it until that is fixed`);
  };

  const deliver = async (queue, { type, body }) => {
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
      if (INELIGIBLE_CODES.has(error?.code)) {
        queue.items.length = 0;
        if (error.code === 'NO_SERVICE') await explainNoService(queue, error);
        return;
      }
      fail(queue, type, `${error?.code ?? 'error'}: ${error?.message ?? error}`);
      return;
    }
    const parsed = answer.status === 200 ? sessionEventResultSchema.safeParse(parseJson(answer.body)) : null;
    if (parsed?.success && parsed.data.ok) {
      queue.warnedNoService = false;
      return;
    }
    fail(queue, type, parsed?.success ? `the service answered "${parsed.data.error}"` : `HTTP ${answer.status} with an unexpected body`);
  };

  const pump = async (queue) => {
    if (queue.running) return;
    queue.running = true;
    try {
      while (queue.items.length > 0 && !stopped) {
        await deliver(queue, queue.items.shift());
      }
    } finally {
      queue.running = false;
      queue.warnedFull = false;
    }
  };

  const preparations = [];
  let warnedPreparationFull = false;
  const prepareInOrder = (prepare) => {
    if (stopped) return;
    if (preparations.length > SESSION_EVENT_PENDING_MAX) {
      if (!warnedPreparationFull) {
        warn(`[session-events] more than ${SESSION_EVENT_PENDING_MAX} events are waiting for preparation; newer announcements are dropped until it catches up`);
        warnedPreparationFull = true;
      }
      prepare(false).catch(reportFailure);
      return;
    }
    const entry = { items: null };
    preparations.push(entry);
    Promise.resolve(prepare(true)).catch((error) => { reportFailure(error); return []; }).then((items) => {
      if (stopped) return;
      entry.items = items ?? [];
      while (preparations[0]?.items) {
        for (const item of preparations.shift().items) enqueue(item.guest, item.type, item.body);
        warnedPreparationFull = false;
      }
    }).catch(reportFailure);
  };

  const onIdle = async (payload, directory, admitted) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return;
    if (payload.properties?.aborted === true) {
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
          const raw = await fetchLastAssistantMessageText(sessionId, undefined, SESSION_EVENT_REPLY_MAX + 1);
          const text = typeof raw === 'string' ? raw : '';
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

  const onError = async (payload, directory, admitted) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return;
    openAsks.delete(sessionId);
    clearPermissionAsks(sessionId);
    if (!admitted) return;
    const subscribers = await subscribersFor('turn-failed');
    if (subscribers.length === 0) return;
    const error = payload.properties?.error;
    return announce({
      type: 'turn-failed',
      payload,
      directory,
      subscribers,
      contentOf: async (record) => ({
        type: 'turn-failed',
        sessionTitle: titleOf(record),
        error: {
          type: isText(error?.type) ? error.type : isText(error?.name) ? error.name : 'Error',
          message: typeof error?.message === 'string' ? error.message : '',
        },
      }),
    });
  };

  const onPermissionAsked = async (payload, directory, admitted) => {
    const sessionId = sessionIdOf(payload);
    const requestId = payload.properties?.id;
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
          contentOf: async (record) => ({
            type: 'permission-asked',
            sessionTitle: titleOf(record),
            action: isText(payload.properties?.action) ? payload.properties.action : '',
            resources: stringList(payload.properties?.resources),
            message: typeof payload.properties?.message === 'string' ? payload.properties.message : null,
          }),
        });
      });
    }, SESSION_EVENT_PERMISSION_DEBOUNCE_MS);
    permissionTimers.set(key, timer);
  };

  const onPermissionReplied = (payload) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId) return;
    const requestId = payload.properties?.requestID;
    if (!isText(requestId)) {
      clearPermissionAsks(sessionId);
      return;
    }
    removeAsk(sessionId, `permission:${requestId}`);
    cancelPermissionTimer(`${sessionId}:${requestId}`);
  };

  const onQuestion = async (payload, directory, askKey, ask, admitted) => {
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

  const onLifecycle = async (type, payload, directory, admitted) => {
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

  const onArchived = (payload, directory, admitted) => {
    const sessionId = sessionIdOf(payload);
    if (!sessionId || !admitted) return undefined;
    const at = now();
    const announcedAt = archivedSessions.get(sessionId);
    if (announcedAt !== undefined && at - announcedAt < SESSION_EVENT_ARCHIVE_DEDUPE_MS) return undefined;
    bound(archivedSessions);
    archivedSessions.set(sessionId, at);
    return onLifecycle('session-archived', payload, directory, admitted);
  };

  const reportFailure = (error) => {
    warn('[session-events] an event could not be handled:', error?.message ?? error);
  };

  const handle = async (payload, directory, admitted = true) => {
    const type = payload?.type;
    const props = payload?.properties;
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
        if (props?.status?.type === 'idle') busySessions.delete(sessionId);
        if (props?.status?.type !== 'busy') return undefined;
        lastTerminalAt.delete(sessionId);
        if (busySessions.has(sessionId)) return undefined;
        bound(busySessions);
        busySessions.set(sessionId, true);
        return onLifecycle('turn-started', payload, directory, admitted);
      }
      case 'session.created':
        return onLifecycle('session-created', payload, directory, admitted);
      case 'session.deleted': {
        const id = props?.info?.id ?? props?.sessionID;
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
        if (Number.isFinite(props?.archivedAt)) return onArchived(payload, directory, admitted);
        archivedSessions.delete(sessionIdOf(payload));
        return undefined;
      case 'session.unarchived':
        archivedSessions.delete(sessionIdOf(payload));
        return undefined;
      case 'session.updated':
      case 'session.patched': {
        const id = props?.info?.id ?? props?.sessionID;
        if (isText(id)) parentCache.delete(id);
        return undefined;
      }
      case 'form.created': {
        const form = props?.form;
        if (!form || !isText(form.id) || props.sessionID === LOCATION_SCOPED_FORM_SESSION_ID) return undefined;
        return onQuestion(payload, directory, `form:${form.id}`, formAskOf(form), admitted);
      }
      case 'form.settled': {
        const sessionId = sessionIdOf(payload);
        if (sessionId && isText(props?.formID)) removeAsk(sessionId, `form:${props.formID}`);
        return undefined;
      }
      case 'openchamber:page-waiting': {
        const page = props?.page;
        if (!page || !isText(page.id)) return undefined;
        return onQuestion(payload, directory, `page:${page.id}`, {
          kind: 'page', id: page.id, title: typeof page.title === 'string' ? page.title : '',
        }, admitted);
      }
      case 'openchamber:page-settled': {
        const sessionId = sessionIdOf(payload);
        if (sessionId && isText(props?.pageID)) removeAsk(sessionId, `page:${props.pageID}`);
        return undefined;
      }
      default:
        return undefined;
    }
  };

  const processPayload = (payload, directory = '') => {
    if (stopped || !payload || typeof payload !== 'object') return;
    if (ANNOUNCEMENT_EVENTS.has(payload.type)) prepareInOrder((admitted) => handle(payload, directory, admitted));
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
