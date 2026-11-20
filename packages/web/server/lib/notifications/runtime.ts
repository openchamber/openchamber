import { z } from 'zod';
import { createHash } from 'node:crypto';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { sessionParentId } from '../session-lineage.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { genericNotificationTitle, truncateNotificationText } from './message.js';
import { pullRequestNotificationTitle } from './pull-request-locales.js';
import { hasErrorMessage, isJsonObject, isString } from './inputs.js';
import type { JsonValue, NotificationPayload, StoredSessionMetadata } from './contracts.js';
import { createPushTags, keepNewest, OPEN_PUSH_TAGS_LIMIT, type PushClaim, type PushTagsStore } from './push-tags.js';
import type { createNotificationTemplateRuntime, NotificationTemplateEvent, NotificationTemplateInfo } from './template-runtime.js';
import type { createNotificationEmitterRuntime } from './emitter-runtime.js';
import type { createApnsRuntime } from './apns-runtime.js';
import type { createPushRuntime } from './push-runtime.js';
import type { NotificationMessageSettings } from './message.js';
import type { ExtensionNotificationDelivery } from './extension-channels.js';
import type { AutoReviewOptions } from '../auto-review/runtime.js';
import type { SessionActivityOptions, SessionReadFetch } from '../opencode/session-activity.js';
import {
  defaultNotificationTemplates,
  notificationTexts,
  renderNotificationText,
  withTemplateDefaults,
} from './template-locales.js';

type TemplateRuntime = ReturnType<typeof createNotificationTemplateRuntime>;
type NotificationKind = ExtensionNotificationDelivery['notification']['kind'];
type PushOptions = Parameters<ReturnType<typeof createPushRuntime>['sendPushToAllUiSessions']>[1];
type TriggerSource = Pick<SessionActivityOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> & {
  fetchImpl: SessionReadFetch;
  isSpace?: boolean;
};
type AutoAcceptResolver = (sessionId: string, directory: string | undefined, requestId: JsonValue | undefined) => boolean | PromiseLike<boolean>;
type WindowFocusResolver = () => boolean;
type JsonField = JsonValue | undefined;
type Timer = ReturnType<typeof setTimeout>;

interface PermissionPrefixes {
  [action: string]: string | { toString(): string } | undefined;
}

interface TriggerPushPayload {
  title: string;
  body: string;
  tag: string;
  clear?: JsonValue[];
  data: {
    url: string;
    type: NotificationKind;
    sessionId?: string | undefined;
    sessionName?: string;
    nid?: JsonValue;
  };
}

interface TriggerInfo extends NotificationTemplateInfo {
  id?: JsonField;
  sessionID?: JsonField;
  sessionId?: JsonField;
  directory?: JsonField;
  parentID?: JsonField;
  role?: JsonField;
  finish?: JsonField;
  error?: JsonField;
}

export interface NotificationTriggerEvent extends NotificationTemplateEvent {
  properties?: NonNullable<NotificationTemplateEvent['properties']> & {
    info?: TriggerInfo;
    sessionID?: JsonField;
    sessionId?: JsonField;
    status?: { type?: JsonField } | null;
    turnStartedAt?: JsonField;
    turnEnded?: JsonField;
    turnEndedAt?: number;
    form?: { id?: JsonField; title?: JsonField; fields?: JsonField } | null;
    page?: { id?: JsonField; title?: JsonField } | null;
    formID?: JsonField;
    pageID?: JsonField;
    aborted?: JsonField;
    error?: JsonField;
    requestID?: JsonField;
    requestId?: JsonField;
    id?: JsonField;
    action?: JsonField;
    resources?: JsonField;
    message?: JsonField;
  };
}

type ChannelNotice = Pick<TriggerPushPayload, 'title' | 'body' | 'tag'> & {
  kind: NotificationKind;
  sessionId?: string | undefined;
  directory?: string | undefined;
  sessionName?: string;
};

export interface ShareAnswerNotice {
  sessionId: string;
  label: string;
  title: string;
  summary: string;
}

interface ShareAnswerBatch {
  answers: (ShareAnswerNotice & { woken: boolean })[];
  firstAt: number;
  timer: Timer | null;
}

interface SettleNotice {
  sessionId: string;
  directory?: string | undefined;
  title: string;
  body: string;
}

export interface GoalSettleNotice extends SettleNotice {
  status: 'complete' | 'budgetLimited' | 'blocked';
}

export interface PullRequestNotice {
  item: { instance?: string | undefined; owner: string; repo: string; number: number };
  event: Parameters<typeof pullRequestNotificationTitle>[1];
}

interface NotificationTriggerSettings extends NotificationMessageSettings {
  locale?: JsonField;
  notificationTemplates?: JsonField;
  notificationMode?: JsonField;
  nativeNotificationsEnabled?: JsonField;
  notifyOnSubtasks?: JsonField;
  notifyOnCompletion?: JsonField;
  notifyOnError?: JsonField;
  notifyOnQuestion?: JsonField;
  notifyOnPullRequests?: JsonField;
}

export interface NotificationTriggerDependencies extends Pick<TemplateRuntime,
  'buildTemplateVariables' | 'extractLastMessageText' | 'fetchLastAssistantMessageText'
  | 'resolveNotificationTemplate' | 'shouldApplyResolvedTemplateMessage'>,
  Pick<SessionActivityOptions, 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'> {
  readSettingsFromDisk: () => Promise<NotificationTriggerSettings>;
  prepareNotificationLastMessage: typeof import('./message.js').prepareNotificationLastMessage;
  emitDesktopNotification: ReturnType<typeof createNotificationEmitterRuntime>['emitDesktopNotification'];
  broadcastUiNotification: ReturnType<typeof createNotificationEmitterRuntime>['broadcastUiNotification'];
  sendPushToAllUiSessions?: (payload: TriggerPushPayload, options: PushOptions) => PromiseLike<void> | void;
  sendApnsToAllUiSessions?: ReturnType<typeof createApnsRuntime>['sendApnsToAllUiSessions'];
  clearApnsNotifications?: ReturnType<typeof createApnsRuntime>['clearApnsNotifications'] | null;
  openPushTagsStore?: PushTagsStore | null;
  isAnyInteractiveClientVisible?: () => boolean;
  isAnyUiVisible?: () => boolean;
  readSessionMetadata?: ((sessionId: string) => Promise<StoredSessionMetadata | undefined>) | null;
  getSpacesHost?: () => {
    openCodeFetchFor: (spaceId: string) => TriggerSource['fetchImpl'];
    index: { claimedBy: (sessionId: string) => string | null };
  } | null;
  isInAutoReview?: (sessionId: string, turnEndedAt: number) => boolean;
  deliverToExtensionChannels?: ((delivery: ExtensionNotificationDelivery) => PromiseLike<void> | void) | null;
  getIsSessionAutoAccepting?: AutoAcceptResolver;
  getIsWindowFocused?: WindowFocusResolver | null;
}

const jsonField = (value: JsonField | StoredSessionMetadata, key: string): JsonField => isJsonObject(value) ? value[key] : undefined;
const isJsonArray = (value: JsonField): value is JsonValue[] => Array.isArray(value);
const errorMessage = (cause: unknown) => hasErrorMessage(cause) ? cause.message : undefined;
const isTriggerEvent = (event: NotificationTriggerEvent | null | undefined): event is NotificationTriggerEvent =>
  event !== null && typeof event === 'object';
const localeOf = (value: JsonField) => {
  if (jsonField(value, 'trim') != null) throw new TypeError('value?.trim is not a function');
  return isString(value) ? value : undefined;
};
const templateOf = (entry: JsonField) => {
  const title = jsonField(entry, 'title');
  const message = jsonField(entry, 'message');
  if (jsonField(title, 'trim') != null || jsonField(message, 'trim') != null) throw new TypeError('candidate?.trim is not a function');
  return { title: isString(title) ? title : '', message: isString(message) ? message : '' };
};

const LOCATION_SCOPED_FORM_SESSION_ID = 'global';

const SHARE_ANSWER_QUIET_MS = 2_000;
const SHARE_ANSWER_MAX_WAIT_MS = 10_000;

const sessionSummarySchema = z.object({
  title: z.string().optional(),
  directory: z.string().optional(),
  location: z.object({ directory: z.string().optional() }).optional(),
});

export const createNotificationTriggerRuntime = (deps: NotificationTriggerDependencies) => {
  const {
    readSettingsFromDisk,
    prepareNotificationLastMessage,
    buildTemplateVariables,
    extractLastMessageText,
    fetchLastAssistantMessageText,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    sendApnsToAllUiSessions,
    clearApnsNotifications = null,
    openPushTagsStore = null,
    isAnyInteractiveClientVisible,
    isAnyUiVisible = () => false,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    readSessionMetadata = null,
    getSpacesHost = () => null,
    isInAutoReview = () => false,
    deliverToExtensionChannels = null,
  } = deps;
  let getIsSessionAutoAccepting = deps.getIsSessionAutoAccepting;
  const hostSource: TriggerSource = { buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl: (...args) => fetch(...args) };
  const unreachableSpaceFetch = async () => { throw new Error('isolated spaces are off'); };
  const sourceFor = (spaceId: string | null): TriggerSource => (spaceId
    ? {
        buildOpenCodeUrl: (fetchPath) => `http://space${fetchPath}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: getSpacesHost()?.openCodeFetchFor(spaceId) ?? unreachableSpaceFetch,
        isSpace: true,
      }
    : hostSource);
  const hostActivityProbe = createSessionActivityProbe({ ...hostSource, timeoutMs: 2000 });

  const isPausedForSubagents = async (sessionId: string, spaceId: string | null) => {
    const activityProbe = spaceId ? createSessionActivityProbe({ ...sourceFor(spaceId), timeoutMs: 2000 }) : hostActivityProbe;
    const backgroundJobs = await activityProbe.fetchRunningBackgroundJobs(sessionId);
    if (backgroundJobs?.some((job) => job.kind !== 'shell')) return true;
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return false;
    return (await activityProbe.hasWorkingChildren(sessionId, statuses)) === true;
  };
  const setGetIsSessionAutoAccepting = (resolver: AutoAcceptResolver | undefined) => {
    getIsSessionAutoAccepting = resolver;
  };

  const pushTags = createPushTags(openPushTagsStore, clearApnsNotifications);
  const {
    claimTag: claimPushTag, release: releaseClaim, clearTag: clearPushTag, clearPendingBadge: clearPendingPushBadge, isCurrent: isClaimCurrent,
  } = pushTags;
  const sessionClearedAt = new Map<string, number>();

  let shareAnswerBatch: ShareAnswerBatch | null = null;

  const dropPendingShareAnswers = (sessionId: string, turnStart: boolean) => {
    const batch = shareAnswerBatch;
    if (!batch) return;
    batch.answers = batch.answers.filter((answer) => {
      if (answer.sessionId !== sessionId) return true;
      if (turnStart && !answer.woken) {
        answer.woken = true;
        return true;
      }
      return false;
    });
    if (batch.answers.length > 0) return;
    if (batch.timer !== null) clearTimeout(batch.timer);
    shareAnswerBatch = null;
  };

  const clearSessionPushNotifications = async (sessionId: string, { turnStart = false, viewed = false } = {}) => {
    if (!sessionId) return;
    sessionClearedAt.delete(sessionId);
    sessionClearedAt.set(sessionId, Date.now());
    keepNewest(sessionClearedAt, OPEN_PUSH_TAGS_LIMIT);
    dropPendingShareAnswers(sessionId, turnStart);
    await pushTags.restored;
    const tags = [];
    for (const [tag, open] of pushTags.open) {
      if (open.sessionId !== sessionId) continue;
      if (turnStart && open.skipTurnStart) {
        open.skipTurnStart = false;
        pushTags.persist();
        continue;
      }
      tags.push(tag);
    }
    pushTags.clear(tags);
    if (viewed) await clearDescendantPushNotifications(sessionId);
  };

  const genericTitleOf = (payload: TriggerPushPayload) => genericNotificationTitle(payload.data.type);

  const toApnsGenericPayload = (payload: TriggerPushPayload & { phoneBody: string; nid: JsonField }) => {
    const data = payload.data;
    const knownSessionName = data.sessionName?.trim() ?? '';
    const sessionName = knownSessionName || (data.type === 'pull-request' ? '' : 'Session');
    const phoneBody = payload?.phoneBody ?? '';
    return {
      title: genericTitleOf(payload),
      body: isEnterpriseMode() ? '' : sessionName,
      sealed: phoneBody && !isEnterpriseMode()
        ? { title: knownSessionName || genericTitleOf(payload), body: phoneBody }
        : undefined,
      badge: pushTags.countBadge(payload.tag),
      tag: payload?.tag,
      data: {
        sessionId: data.sessionId,
        tag: payload?.tag,
        nid: payload?.nid,
        clear: payload?.clear?.join(','),
      },
    };
  };

  const phoneBodyOf = (prefix: PermissionPrefixes[string], text: string) => {
    const detail = truncateNotificationText((text ?? '').trim());
    if (!detail) return '';
    return prefix ? `${prefix}: ${detail}` : detail;
  };

  const PERMISSION_PREFIX_BY_ACTION: PermissionPrefixes = {
    bash: 'Wants to run',
    edit: 'Wants to edit',
    read: 'Wants to read',
  };

  const toWebPushPayload = (payload: TriggerPushPayload) => {
    if (!isEnterpriseMode()) return payload;
    const { sessionName: _sessionName, ...rest } = payload.data ?? {};
    return { ...payload, title: genericTitleOf(payload), body: '', data: rest };
  };

  const fanoutPush = ({ phoneBody, claim, ...pushPayload }: TriggerPushPayload & { phoneBody: string; claim?: PushClaim }, options: PushOptions) => {
    const tag = pushPayload.tag ?? '';
    if (claim && !isClaimCurrent(tag, claim)) return Promise.resolve();
    const interactiveVisible = isAnyInteractiveClientVisible?.() === true;
    const clear = pushTags.clearEntriesForPush(tag, !interactiveVisible);
    const payload = clear.length > 0 ? { ...pushPayload, clear } : pushPayload;
    if (claim) pushTags.recordDelivery(claim, !interactiveVisible);
    return Promise.all([
      Promise.resolve(sendPushToAllUiSessions?.(toWebPushPayload(claim ? { ...payload, data: { ...payload.data, nid: claim.nid } } : payload), options)).catch((error) => {
        console.warn('[Push] web-push fanout failed:', errorMessage(error) ?? error);
      }),
      interactiveVisible
        ? Promise.resolve()
        : Promise.resolve(sendApnsToAllUiSessions?.(toApnsGenericPayload({ ...payload, phoneBody, nid: claim?.nid }), options)).catch((error) => {
            console.warn('[APNs] fanout failed:', errorMessage(error) ?? error);
          }),
    ]);
  };

  const showInOpenClients = (payload: NotificationPayload) => {
    if (payload.requireHidden && isAnyUiVisible()) return;
    const desktopNotificationDelivered = emitDesktopNotification(payload);
    broadcastUiNotification(payload, { desktopNotificationDelivered });
  };

  const sendToChannels = ({ kind, title, body, tag, sessionId, directory, sessionName }: ChannelNotice, settings: NotificationTriggerSettings) => {
    if (!deliverToExtensionChannels) return;
    const enterprise = isEnterpriseMode();
    const notification = {
      kind,
      title: enterprise ? genericNotificationTitle(kind) : title,
      body: enterprise ? '' : body,
      tag,
      at: Date.now(),
      sessionId: sessionId || null,
      sessionName: enterprise ? null : (sessionName?.trim() || null),
      directory: enterprise ? null : (directory || null),
      url: sessionId ? buildSessionDeepLinkUrl(sessionId) : null,
    };
    Promise.resolve(deliverToExtensionChannels({ notification, requireHidden: settings?.notificationMode !== 'always' })).catch((error) => {
      console.warn('[Notification] extension channel delivery failed:', errorMessage(error) ?? error);
    });
  };

  let getIsWindowFocused = deps.getIsWindowFocused ?? null;

  const setGetIsWindowFocused = (cb: WindowFocusResolver | null | undefined) => {
    getIsWindowFocused = cb ?? null;
  };

  const PUSH_READY_COOLDOWN_MS = 5000;
  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  const pushQuestionDebounceTimers = new Map<string, { timer: Timer; cause: JsonValue }>();
  const pushPermissionDebounceTimers = new Map<string, { timer: Timer; requestKey: string | null }>();
  const notifiedPermissionRequests = new Set<string>();
  const lastReadyNotificationAt = new Map<string, number>();
  const lastErrorNotificationAt = new Map<string, number>();

  const sessionParentIdCache = new Map<string, { parentID: string | null; at: number }>();
  const SESSION_PARENT_CACHE_TTL_MS = 60 * 1000;

  const autoAcceptingSessions = new Set<string>();
  const setAutoAcceptSession = (sessionId: JsonField, enabled: boolean) => {
    if (!isString(sessionId) || sessionId.length === 0) return;
    if (enabled) {
      autoAcceptingSessions.add(sessionId);
    } else {
      autoAcceptingSessions.delete(sessionId);
    }
  };

  const buildSessionDeepLinkUrl = (sessionId: string | undefined) => {
    if (!sessionId) {
      return '/';
    }
    return `/?session=${encodeURIComponent(sessionId)}`;
  };

  const getSessionParentCacheKey = (sessionId: string, directory: string | undefined, spaceId: string | null) => `${spaceId || ''}\0${directory || ''}\0${sessionId}`;

  const getCachedSessionParentId = (sessionId: string, directory: string | undefined, spaceId: string | null) => {
    const cacheKey = getSessionParentCacheKey(sessionId, directory, spaceId);
    const entry = sessionParentIdCache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.at > SESSION_PARENT_CACHE_TTL_MS) {
      sessionParentIdCache.delete(cacheKey);
      return undefined;
    }
    return entry.parentID;
  };

  const setCachedSessionParentId = (sessionId: string, directory: string | undefined, spaceId: string | null, parentID: string | null) => {
    sessionParentIdCache.set(getSessionParentCacheKey(sessionId, directory, spaceId), { parentID: parentID ?? null, at: Date.now() });
  };

  const getParentIdFromPayload = (payload: NotificationTriggerEvent) => {
    if (!isTriggerEvent(payload)) return undefined;
    if (payload.type !== 'session.created' && payload.type !== 'session.updated') return undefined;
    const parentID = payload.properties?.info?.parentID;
    if (isString(parentID) && parentID.length > 0) return parentID;
    return payload.type === 'session.created' ? null : undefined;
  };

  const ASSISTANT_STEP_CACHE_LIMIT = 500;
  const assistantStepMeta = new Map<string, { agent: string; modelID: string }>();
  const lastAssistantStepBySession = new Map<string, string>();
  const rememberAssistantStep = (info: TriggerInfo | undefined) => {
    if (!info || info.role !== 'assistant') return;
    const id = String(info.id ?? '');
    const agent = String(info.agent ?? info.mode ?? '');
    const modelID = String(info.modelID ?? '');
    if (!id || (!agent && !modelID)) return;
    assistantStepMeta.delete(id);
    assistantStepMeta.set(id, { agent, modelID });
    const sessionId = String(info.sessionID ?? '');
    if (sessionId) {
      lastAssistantStepBySession.delete(sessionId);
      lastAssistantStepBySession.set(sessionId, id);
      keepNewest(lastAssistantStepBySession, ASSISTANT_STEP_CACHE_LIMIT);
    }
    keepNewest(assistantStepMeta, ASSISTANT_STEP_CACHE_LIMIT);
  };
  const withRememberedStep = (info: TriggerInfo | undefined) => {
    const remembered = info ? assistantStepMeta.get(String(info.id ?? '')) : undefined;
    if (!remembered || !info) return info;
    const merged = { ...info };
    if (!merged.agent && !merged.mode) {
      merged.agent = remembered.agent;
      merged.mode = remembered.agent;
    }
    if (!merged.modelID) merged.modelID = remembered.modelID;
    return merged;
  };

  const maybeCacheSessionParentFromPayload = (payload: NotificationTriggerEvent, spaceId: string | null) => {
    const sessionId = extractSessionIdFromPayload(payload);
    if (!sessionId) return;
    const directory = extractDirectoryFromPayload(payload);
    const parentID = getParentIdFromPayload(payload);
    if (parentID === undefined) return;
    setCachedSessionParentId(sessionId, directory, spaceId, parentID);
  };

  const fetchSessionRecord = async (sessionId: string, directory: string | undefined, spaceId: string | null, signal = AbortSignal.timeout(2000)) => {
    try {
      const source = sourceFor(spaceId);
      const base = source.buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory && !spaceId ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await source.fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...source.getOpenCodeAuthHeaders(),
        },
        signal,
      });
      if (!response.ok) return null;
      const session: JsonField = unwrapOpenCodeResponse(await response.json().catch(() => null));
      return isJsonObject(session) ? session : null;
    } catch {
      return null;
    }
  };

  const clearDescendantPushNotifications = async (sessionId: string) => {
    const spaceIndex = getSpacesHost()?.index;
    const spaceId = spaceIndex?.claimedBy(sessionId) ?? null;
    const claims = new Map<JsonValue, PushClaim>();
    for (const [tag, claim] of pushTags.open) {
      if (claim.sessionId !== sessionId && (claim.nid || claim.nativeNid)
        && (claim.spaceId ?? spaceIndex?.claimedBy(claim.sessionId) ?? null) === spaceId) {
        claims.set(tag, { ...claim });
      }
    }
    if (claims.size === 0) return;

    const signal = AbortSignal.timeout(2000);
    const parents = new Map<string, Promise<string | null>>();
    const isDescendant = async (id: string) => {
      const seen = new Set<string>();
      let current: string | null = id;
      while (current && !seen.has(current) && !signal.aborted) {
        if (current === sessionId) return true;
        seen.add(current);
        let pendingParent = parents.get(current);
        if (!pendingParent) {
          const childId: string = current;
          pendingParent = fetchSessionRecord(childId, undefined, spaceId, signal)
            .then((child) => child && child.id === childId ? sessionParentId(child) : null);
          parents.set(current, pendingParent);
        }
        current = await pendingParent;
      }
      return false;
    };
    const candidates = [...new Set([...claims.values()].map(({ sessionId: id }) => id))];
    const descendants = new Set<string>();
    for (let offset = 0; offset < candidates.length && !signal.aborted; offset += 8) {
      await Promise.all(candidates.slice(offset, offset + 8).map(async (id) => {
        if (await isDescendant(id)) descendants.add(id);
      }));
    }
    pushTags.clear([...claims].filter(([, claim]) => descendants.has(claim.sessionId)).map(([tag]) => tag), claims);
  };

  const fetchSessionParentId = async (sessionId: string, directory: string | undefined, spaceId: string | null = null) => {
    if (!sessionId) return undefined;

    const cached = getCachedSessionParentId(sessionId, directory, spaceId);
    if (cached !== undefined) return cached;

    const session = await fetchSessionRecord(sessionId, directory, spaceId);
    if (!session) return undefined;
    const parentID = sessionParentId(session);
    setCachedSessionParentId(sessionId, directory, spaceId, parentID);
    return parentID;
  };

  const isSessionAutoAccepting = async (sessionId: string, directory: string | undefined) => {
    if (!sessionId || autoAcceptingSessions.size === 0) return false;
    let current = sessionId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (autoAcceptingSessions.has(current)) return true;
      seen.add(current);
      const parent = await fetchSessionParentId(current, directory);
      if (!parent) return false;
      current = parent;
    }
    return false;
  };

  const readFormAsk = (payload: NotificationTriggerEvent) => {
    const form = payload.properties?.form;
    const header = isString(form?.title) ? form.title.trim() : '';
    const firstField = isJsonArray(form?.fields) ? form.fields[0] : null;
    const title = jsonField(firstField, 'title');
    const description = jsonField(firstField, 'description');
    const fieldTitle = isString(title) ? title.trim() : '';
    const fieldDescription = isString(description) ? description.trim() : '';
    const id = form?.id || null;
    return { id, header, questionText: fieldDescription || fieldTitle };
  };

  const readPageAsk = (payload: NotificationTriggerEvent) => {
    const { id, title } = payload.properties?.page ?? {};
    return {
      id: id || null,
      header: '',
      questionText: String(title ?? '').trim(),
    };
  };

  const extractSessionIdFromPayload = (payload: NotificationTriggerEvent) => {
    if (!isTriggerEvent(payload)) return null;
    const props = payload.properties;
    const info = props?.info;
    const sessionId =
      info?.sessionID ??
      info?.sessionId ??
      props?.sessionID ??
      props?.sessionId ??
      props?.session ??
      null;
    return isString(sessionId) && sessionId.length > 0 ? sessionId : null;
  };

  const extractDirectoryFromPayload = (payload: NotificationTriggerEvent) => {
    if (!isTriggerEvent(payload)) return undefined;
    const props = payload.properties;
    const directory = props?.directory ?? props?.info?.directory;
    if (!isString(directory)) return undefined;
    const trimmed = directory.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const formatMode = (raw: TriggerInfo['mode']) => {
    const value = isString(raw) ? raw.trim() : '';
    const normalized = value.length > 0 ? value : 'agent';
    return normalized
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  };

  const formatModelId = (raw: TriggerInfo['modelID']) => {
    const value = isString(raw) ? raw.trim() : '';
    if (!value) {
      return 'Assistant';
    }

    const tokens = value.split(/[-_]+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const current = tokens[i] ?? '';
      const next = tokens[i + 1];
      if (/^\d+$/.test(current) && next && /^\d+$/.test(next)) {
        result.push(`${current}.${next}`);
        i += 1;
        continue;
      }
      result.push(current);
    }

    return result
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  };

  const hasActiveSessionGoal = async (sessionId: string, spaceId: string | null) => {
    if (!sessionId || (!spaceId && !readSessionMetadata)) return false;
    try {
      const metadata = spaceId
        ? (await fetchSessionRecord(sessionId, undefined, spaceId))?.metadata
        : await readSessionMetadata?.(sessionId);
      const goal = jsonField(jsonField(metadata, 'openchamber'), 'goal');
      return isJsonObject(goal) && goal.status === 'active';
    } catch {
      return false;
    }
  };

  const maybeSendPushForTrigger = async (payload: NotificationTriggerEvent | null | undefined, { spaceId = null }: { spaceId?: string | null } = {}) => {
    if (!isTriggerEvent(payload)) {
      return;
    }

    maybeCacheSessionParentFromPayload(payload, spaceId);
    const source = sourceFor(spaceId);

    const sessionId = extractSessionIdFromPayload(payload);
    const notificationDirectory = extractDirectoryFromPayload(payload);

    if (payload.type === 'session.status' && sessionId
      && payload.properties?.status?.type === 'busy' && Number.isFinite(payload.properties?.turnStartedAt)) {
      await clearSessionPushNotifications(sessionId, { turnStart: true });
      return;
    }

    const settledAskId = payload.type === 'form.settled' ? payload.properties?.formID
      : payload.type === 'openchamber:page-settled' ? payload.properties?.pageID
        : undefined;
    if (settledAskId !== undefined && sessionId) {
      const cause = settledAskId || null;
      const pending = pushQuestionDebounceTimers.get(sessionId);
      if (pending && (cause === null || pending.cause === null || pending.cause === cause)) {
        clearTimeout(pending.timer);
        pushQuestionDebounceTimers.delete(sessionId);
      }
      await clearPushTag(`question-${sessionId}`, cause);
      return;
    }

    if (payload.type === 'session.idle' && payload.properties?.aborted === true) {
      return;
    }

    if ((payload.type === 'session.idle' || payload.type === 'session.error') && sessionId) {
      const turnEndedAt = Date.now();
      if (payload.type === 'session.idle' && await isPausedForSubagents(sessionId, spaceId)) {
        return;
      }
      const error = payload.properties?.error;
      const message = jsonField(error, 'message');
      const errorText = isString(message)
        ? message
        : isString(error) ? error : '';
      const info: TriggerInfo = {
        id: lastAssistantStepBySession.get(sessionId),
        sessionID: sessionId,
        role: 'assistant',
        finish: payload.type === 'session.error' ? 'error' : 'stop',
      };
      if (errorText) info.parts = [{ type: 'text', text: errorText }];
      await maybeSendPushForTrigger({
        ...payload,
        type: 'message.updated',
        properties: {
          ...payload.properties,
          turnEnded: true,
          turnEndedAt,
          info,
        },
      }, { spaceId });
      return;
    }

    if (payload.type === 'message.updated') {
      rememberAssistantStep(payload.properties?.info);
      const info = withRememberedStep(payload.properties?.info);
      if (info?.role === 'assistant' && info?.finish === 'stop' && sessionId && payload.properties?.turnEnded === true) {
        payload = { ...payload, properties: { ...payload.properties, info } };
        const settings = await readSettingsFromDisk();

        if (settings.notifyOnSubtasks === false) {
          const parentIDFromPayload = getParentIdFromPayload(payload);
          const parentID = parentIDFromPayload
            ? parentIDFromPayload
            : await fetchSessionParentId(sessionId, notificationDirectory, spaceId);

          if (parentID !== null) {
            return;
          }
        }

        if (settings.notifyOnCompletion === false) {
          return;
        }

        if (await hasActiveSessionGoal(sessionId, spaceId)) {
          return;
        }

        if (!spaceId && isInAutoReview(sessionId, payload.properties?.turnEndedAt ?? Date.now())) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const now = Date.now();
        const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
          return;
        }
        lastReadyNotificationAt.set(sessionId, now);

        const readyTag = `ready-${sessionId}`;
        const claim = await claimPushTag(readyTag, { sessionId, spaceId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= (payload.properties?.turnEndedAt ?? now)) {
          releaseClaim(readyTag, claim);
          return;
        }

        const texts = notificationTexts(localeOf(settings.locale));
        let title = renderNotificationText(texts.readyTitle, {
          agent_name: formatMode(info?.mode),
        });
        let body = renderNotificationText(texts.readyMessage, {
          model_name: formatModelId(info?.modelID),
        });
        let sessionName = '';
        let reply = '';

        try {
          const templates = settings.notificationTemplates;
          const defaults = defaultNotificationTemplates(localeOf(settings.locale));
          const isSubtask = await fetchSessionParentId(sessionId, notificationDirectory, spaceId);
          const usesSubtaskTemplate = Boolean(isSubtask) && settings.notifyOnSubtasks !== false;
          const completion = jsonField(templates, 'completion');
          const completionTemplate = withTemplateDefaults(
            templateOf(usesSubtaskTemplate ? (jsonField(templates, 'subtask') ?? completion) : completion),
            usesSubtaskTemplate ? defaults.subtask : defaults.completion,
          );

          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;

          const messageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, messageId, undefined, source);
          }

          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
          });
          reply = variables.last_message;

          const resolvedTitle = resolveNotificationTemplate(completionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(completionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(completionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(readyTag, claim)) return;

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `ready-${sessionId}`,
            kind: 'ready',
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        await fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('', reply),
            claim,
            tag: `ready-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'ready',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'ready', title, body, tag: `ready-${sessionId}`, sessionId, directory: notificationDirectory, sessionName }, settings);
      }

      if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
        if (jsonField(info.error, 'type') === 'aborted') {
          return;
        }

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnError === false) return;

        const now = Date.now();
        const lastAt = lastErrorNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) return;
        lastErrorNotificationAt.set(sessionId, now);

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const errorTag = `error-${sessionId}`;
        const claim = await claimPushTag(errorTag, { sessionId, spaceId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= (payload.properties?.turnEndedAt ?? now)) {
          releaseClaim(errorTag, claim);
          return;
        }

        const texts = notificationTexts(localeOf(settings.locale));
        let title = texts.errorTitle;
        let body = texts.errorBody;
        let sessionName = '';
        let errorText = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;
          const errorMessageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, errorMessageId, undefined, source);
          }

          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
          });
          errorText = variables.last_message;

          const errorTemplate = withTemplateDefaults(
            templateOf(jsonField(settings.notificationTemplates, 'error')),
            defaultNotificationTemplates(localeOf(settings.locale)).error,
          );
          const resolvedTitle = resolveNotificationTemplate(errorTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(errorTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(errorTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Error template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(errorTag, claim)) return;

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            title,
            body,
            tag: `error-${sessionId}`,
            kind: 'error',
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        await fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('Error', errorText),
            claim,
            tag: `error-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'error',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'error', title, body, tag: `error-${sessionId}`, sessionId, directory: notificationDirectory, sessionName }, settings);
      }

      return;
    }

    const ask = payload.type === 'form.created' ? readFormAsk(payload)
      : payload.type === 'openchamber:page-waiting' ? readPageAsk(payload)
        : null;
    if (ask && sessionId) {
      const askedAt = Date.now();
      const existingTimer = pushQuestionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushQuestionDebounceTimers.delete(sessionId);
        const questionTag = `question-${sessionId}`;
        const claim = await claimPushTag(questionTag, { sessionId, cause: ask.id, spaceId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= askedAt) {
          releaseClaim(questionTag, claim);
          return;
        }

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnQuestion === false
          || (settings.notificationMode !== 'always' && getIsWindowFocused?.())) {
          releaseClaim(questionTag, claim);
          return;
        }

        const { header, questionText } = ask;
        const formSessionId = sessionId === LOCATION_SCOPED_FORM_SESSION_ID ? undefined : sessionId;

        const texts = notificationTexts(localeOf(settings.locale));
        let title = /plan\s*mode/i.test(header)
          ? texts.planModeTitle
          : /build\s*agent/i.test(header)
            ? texts.buildModeTitle
            : header || texts.questionTitle;
        let body = questionText || texts.questionBody;
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, formSessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;
          variables.last_message = questionText || header || '';

          const templates = settings.notificationTemplates;
          const questionTemplate = withTemplateDefaults(
            templateOf(jsonField(templates, 'question')),
            defaultNotificationTemplates(localeOf(settings.locale)).question,
          );

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Question template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(questionTag, claim)) return;

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId: formSessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        void fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('Question', questionText || header),
            claim,
            tag: `question-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(formSessionId),
              sessionId: formSessionId,
              sessionName,
              type: 'question',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'question', title, body, tag: `question-${sessionId}`, sessionId: formSessionId, directory: notificationDirectory, sessionName }, settings);
      }, PUSH_QUESTION_DEBOUNCE_MS);

      pushQuestionDebounceTimers.set(sessionId, { timer, cause: ask.id });
      return;
    }

    if (payload.type === 'permission.replied' && sessionId) {
      const requestId = payload.properties?.requestID ?? payload.properties?.requestId ?? payload.properties?.id;
      const requestKey = requestId ? `${sessionId}:${requestId}` : null;
      if (requestKey) notifiedPermissionRequests.add(requestKey);
      await clearPushTag(`permission-${sessionId}`, requestKey);
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (!pendingNotification) {
        return;
      }

      if (!requestKey || !pendingNotification.requestKey || pendingNotification.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
      const requestId = payload.properties?.id ?? payload.properties?.requestID ?? payload.properties?.requestId;
      const permissionAction = isString(payload.properties?.action) ? payload.properties.action.trim() : '';
      const permissionResource = isJsonArray(payload.properties?.resources)
        ? String(payload.properties.resources[0] ?? '').trim()
        : '';
      const permissionMessage = isString(payload.properties?.message) ? payload.properties.message.trim() : '';
      const permission = permissionMessage
        || (permissionAction && permissionResource ? `${permissionAction}: ${permissionResource}` : permissionAction);
      const permissionPrefix = PERMISSION_PREFIX_BY_ACTION[permissionAction];
      const permissionPhoneBody = permissionPrefix && permissionResource
        ? phoneBodyOf(permissionPrefix, permissionResource)
        : phoneBodyOf('Wants permission', permission);
      const requestKey = isString(requestId) ? `${sessionId}:${requestId}` : null;
      if (requestKey && notifiedPermissionRequests.has(requestKey)) {
        return;
      }
      const askedAt = Date.now();
      const isHandledSince = () => (requestKey !== null && notifiedPermissionRequests.has(requestKey))
        || (sessionClearedAt.get(sessionId) ?? 0) >= askedAt;

      const isAutoAnswered = async () => !spaceId && await (getIsSessionAutoAccepting?.(sessionId, notificationDirectory, requestId)
        ?? isSessionAutoAccepting(sessionId, notificationDirectory));
      if (await isAutoAnswered()) {
        if (requestKey) notifiedPermissionRequests.add(requestKey);
        return;
      }
      if (isHandledSince()) return;

      const existingTimer = pushPermissionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushPermissionDebounceTimers.delete(sessionId);
        const permissionTag = `permission-${sessionId}`;
        const claim = await claimPushTag(permissionTag, { sessionId, cause: requestKey, spaceId });
        if (isHandledSince()) {
          releaseClaim(permissionTag, claim);
          return;
        }

        if (await isAutoAnswered()) {
          if (requestKey) notifiedPermissionRequests.add(requestKey);
          releaseClaim(permissionTag, claim);
          return;
        }

        const settings = await readSettingsFromDisk();

        if (settings.notifyOnQuestion === false
          || (settings.notificationMode !== 'always' && getIsWindowFocused?.())) {
          releaseClaim(permissionTag, claim);
          return;
        }

        const sessionTitle = payload.properties?.sessionTitle;
        const texts = notificationTexts(localeOf(settings.locale));
        const fallbackMessage = permission
          || (isString(sessionTitle) && sessionTitle.trim().length > 0 ? sessionTitle.trim() : '')
          || texts.permissionBody;

        let title = texts.permissionTitle;
        let body = fallbackMessage;
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = isString(variables.session_name) ? variables.session_name : sessionName;
          variables.last_message = fallbackMessage;

          const templates = settings.notificationTemplates;
          const questionDefaults = defaultNotificationTemplates(localeOf(settings.locale)).question;
          const questionTemplate = withTemplateDefaults(
            templateOf(jsonField(templates, 'question')),
            { ...questionDefaults, title: texts.permissionTitle },
          );

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Permission template resolution failed, using defaults:', errorMessage(error) || error);
        }

        if (!isClaimCurrent(permissionTag, claim)) {
          if (requestKey) notifiedPermissionRequests.add(requestKey);
          return;
        }

        if (settings.nativeNotificationsEnabled) {
          const notificationPayload = {
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            directory: notificationDirectory,
            requireHidden: settings.notificationMode !== 'always',
          };
          showInOpenClients(notificationPayload);
        }

        if (requestKey) {
          notifiedPermissionRequests.add(requestKey);
        }

        void fanoutPush(
          {
            title,
            body,
            phoneBody: permissionPhoneBody,
            claim,
            tag: `permission-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              sessionName,
              type: 'permission',
            },
          },
          { requireNoSse: true },
        );
        sendToChannels({ kind: 'permission', title, body, tag: `permission-${sessionId}`, sessionId, directory: notificationDirectory, sessionName }, settings);
      }, PUSH_PERMISSION_DEBOUNCE_MS);

      pushPermissionDebounceTimers.set(sessionId, { timer, requestKey });
    }
  };

  const sendSettlePush = async ({ sessionId, directory, type, tag, title, body }: SettleNotice & { type: NotificationKind; tag: string }) => {
    const claim = await claimPushTag(tag, { sessionId });
    let sessionName = '';
    try {
      const base = buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, '');
      const url = directory ? `${base}?directory=${encodeURIComponent(directory)}` : base;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const session: JsonField = unwrapOpenCodeResponse(await response.json().catch(() => null));
        const title = jsonField(session, 'title');
        if (isString(title)) sessionName = title.trim();
      }
    } catch {
      sessionName = '';
    }
    await fanoutPush(
      {
        title,
        body,
        phoneBody: phoneBodyOf(title, body) || title,
        claim,
        tag,
        data: {
          url: buildSessionDeepLinkUrl(sessionId),
          sessionId,
          sessionName,
          type,
        },
      },
      { requireNoSse: true },
    );
    if (deliverToExtensionChannels) {
      sendToChannels({ kind: type, title, body, tag, sessionId, directory, sessionName }, await readSettingsFromDisk());
    }
  };

  const sendGoalSettlePush = ({ sessionId, directory, status, title, body }: GoalSettleNotice) => sendSettlePush({
    sessionId,
    directory,
    type: status === 'complete' ? 'goal_complete' : (status === 'budgetLimited' ? 'goal_budget' : 'goal_blocked'),
    tag: `goal-${sessionId}`,
    title,
    body,
  });

  const notifyAutoReviewEnded = async ({ sessionId, directory, status, error }: Parameters<NonNullable<AutoReviewOptions['onRunEnded']>>[0]) => {
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) return;
    if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) return;
    const texts = notificationTexts(localeOf(settings.locale));
    const { title, body } = {
      clean: { title: texts.reviewCleanTitle, body: texts.reviewCleanBody },
      disputed: { title: texts.reviewDisputedTitle, body: texts.reviewDisputedBody },
      limit: { title: texts.reviewLimitTitle, body: texts.reviewLimitBody },
      failed: { title: texts.reviewFailedTitle, body: truncateNotificationText(error ?? '', 240) },
    }[status] ?? {};
    if (!title) return;
    const tag = `review-${sessionId}`;
    if (settings.nativeNotificationsEnabled) {
      const payload = { title, body, tag, kind: 'review', sessionId, directory, requireHidden: settings.notificationMode !== 'always' };
      showInOpenClients(payload);
    }
    await sendSettlePush({ sessionId, directory, type: 'review', tag, title, body });
  };

  const notifyPullRequest = async ({ item, event }: PullRequestNotice) => {
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnPullRequests === false) return;
    if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) return;
    const title = pullRequestNotificationTitle(String(settings.locale), event);
    if (!title) return;
    const body = `${item.owner}/${item.repo}#${item.number}`;
    const tag = `pull-request-${createHash('sha256').update(`${item.instance}\n${body}`).digest('hex').slice(0, 16)}-${event}`;
    const payload = { title, body, tag, kind: 'pull-request', requireHidden: settings.notificationMode !== 'always' };
    if (settings.nativeNotificationsEnabled) {
      showInOpenClients(payload);
    }
    await fanoutPush({ title, body, phoneBody: `${title}: ${body}`, tag, data: { url: '/', type: 'pull-request' } }, { requireNoSse: true });
    sendToChannels({ kind: 'pull-request', title, body, tag }, settings);
  };

  const readSessionSummary = async (sessionId: string) => {
    try {
      const response = await fetch(buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, ''), {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return { name: '', directory: '' };
      const session = sessionSummarySchema.safeParse(unwrapOpenCodeResponse(await response.json().catch(() => null)));
      if (!session.success) return { name: '', directory: '' };
      return { name: session.data.title?.trim() ?? '', directory: session.data.location?.directory ?? session.data.directory ?? '' };
    } catch {
      return { name: '', directory: '' };
    }
  };

  const announceShareAnswers = async (answers: ShareAnswerBatch['answers']) => {
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) return;
    const texts = notificationTexts(localeOf(settings.locale));
    const newest = answers.at(-1);
    if (!newest) throw new TypeError('Missing newest share answer');
    const labels = [...new Set(answers.map((answer) => answer.label))];
    const title = answers.length === 1
      ? texts.shareAnswerTitle.replace('{label}', () => newest.label).replace('{title}', () => newest.title)
      : texts.shareAnswersTitle.replace('{count}', () => String(answers.length));
    const body = truncateNotificationText(answers.length === 1 ? newest.summary : labels.join(', '), 240);
    const { sessionId } = newest;
    const tag = `share-${sessionId}`;
    const claim = await claimPushTag(tag, { sessionId });
    claim.skipTurnStart = !answers.some((answer) => answer.sessionId === sessionId && answer.woken);
    const { name: sessionName, directory } = await readSessionSummary(sessionId);
    const awayOnly = settings.notificationMode !== 'always';
    const osAllowed = settings.nativeNotificationsEnabled === true && !(awayOnly && (isAnyUiVisible() || getIsWindowFocused?.() === true));
    const payload = { title, body, tag, kind: 'share-answer', sessionId, directory, requireHidden: awayOnly };
    const desktopNotificationDelivered = osAllowed ? emitDesktopNotification(payload) : false;
    broadcastUiNotification({ ...payload, showWhenFocused: true, toastOnly: !osAllowed }, { desktopNotificationDelivered });
    await fanoutPush({
      title,
      body,
      phoneBody: phoneBodyOf(title, body) || title,
      claim,
      tag,
      data: { url: buildSessionDeepLinkUrl(sessionId), sessionId, sessionName, type: 'share-answer' },
    }, { requireNoSse: true });
    sendToChannels({ kind: 'share-answer', title, body, tag, sessionId, directory, sessionName }, settings);
  };

  const notifyShareAnswer = (answer: ShareAnswerNotice) => {
    const batch: ShareAnswerBatch = shareAnswerBatch ?? { answers: [], firstAt: Date.now(), timer: null };
    shareAnswerBatch = batch;
    batch.answers.push({ ...answer, woken: false });
    if (batch.timer !== null) clearTimeout(batch.timer);
    const wait = Math.max(0, Math.min(SHARE_ANSWER_QUIET_MS, batch.firstAt + SHARE_ANSWER_MAX_WAIT_MS - Date.now()));
    batch.timer = setTimeout(() => {
      if (shareAnswerBatch === batch) shareAnswerBatch = null;
      announceShareAnswers(batch.answers).catch((error) => {
        console.warn('[Notification] shared page answer notification failed:', errorMessage(error) ?? error);
      });
    }, wait);
    batch.timer.unref?.();
  };

  return {
    notifyShareAnswer,
    maybeSendPushForTrigger,
    setAutoAcceptSession,
    setGetIsWindowFocused,
    setGetIsSessionAutoAccepting,
    clearPendingPushBadge,
    clearSessionPushNotifications,
    sendGoalSettlePush,
    notifyAutoReviewEnded,
    notifyPullRequest,
  };
};
