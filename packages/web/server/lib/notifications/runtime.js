import { z } from 'zod';
import { createHash } from 'node:crypto';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { sessionParentId } from '../session-lineage.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { genericNotificationTitle, truncateNotificationText } from './message.js';
import { pullRequestNotificationTitle } from './pull-request-locales.js';
import {
  defaultNotificationTemplates,
  notificationTexts,
  renderNotificationText,
  withTemplateDefaults,
} from './template-locales.js';

const LOCATION_SCOPED_FORM_SESSION_ID = 'global';

const SHARE_ANSWER_QUIET_MS = 2_000;
const SHARE_ANSWER_MAX_WAIT_MS = 10_000;

const sessionSummarySchema = z.object({
  title: z.string().optional(),
  directory: z.string().optional(),
  location: z.object({ directory: z.string().optional() }).optional(),
});

export const createNotificationTriggerRuntime = (deps) => {
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
    spaceFetchFor = () => null,
    isInAutoReview = () => false,
    deliverToExtensionChannels = null,
  } = deps;
  let getIsSessionAutoAccepting = deps.getIsSessionAutoAccepting;
  const hostSource = { buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl: (...args) => fetch(...args) };
  const unreachableSpaceFetch = async () => { throw new Error('isolated spaces are off'); };
  const sourceFor = (spaceId) => (spaceId
    ? {
        buildOpenCodeUrl: (fetchPath) => `http://space${fetchPath}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: spaceFetchFor(spaceId) ?? unreachableSpaceFetch,
        isSpace: true,
      }
    : hostSource);
  const hostActivityProbe = createSessionActivityProbe({ ...hostSource, timeoutMs: 2000 });

  const isPausedForSubagents = async (sessionId, spaceId) => {
    const activityProbe = spaceId ? createSessionActivityProbe({ ...sourceFor(spaceId), timeoutMs: 2000 }) : hostActivityProbe;
    const backgroundJobs = await activityProbe.fetchRunningBackgroundJobs(sessionId);
    if (backgroundJobs?.some((job) => job.kind !== 'shell')) return true;
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return false;
    return (await activityProbe.hasWorkingChildren(sessionId, statuses)) === true;
  };
  const setGetIsSessionAutoAccepting = (resolver) => {
    getIsSessionAutoAccepting = typeof resolver === 'function' ? resolver : undefined;
  };

  const pendingPushTags = new Set();
  const clearPendingPushBadge = () => {
    pendingPushTags.clear();
  };
  const trackPushAndCountBadge = (tag) => {
    if (typeof tag === 'string' && tag.length > 0) {
      pendingPushTags.add(tag);
    }
    return pendingPushTags.size;
  };

  const OPEN_PUSH_TAGS_LIMIT = 500;
  const RECENTLY_CLEARED_TAGS_LIMIT = 20;
  const openPushTags = new Map();
  const recentlyClearedTags = new Map();
  const claimedOver = new WeakMap();
  const sessionClearedAt = new Map();
  let lastNotificationId = 0;

  const nextNotificationId = () => {
    lastNotificationId = Math.max(Date.now(), lastNotificationId + 1);
    return String(lastNotificationId);
  };
  const clearEntryOf = (tag, open) => (open?.nid ? `${tag}@${open.nid}` : tag);
  const keepNewest = (map, limit) => {
    while (map.size > limit) map.delete(map.keys().next().value);
  };

  let persistQueued = false;
  let persistChain = Promise.resolve();
  const persistOpenPushTags = () => {
    if (!openPushTagsStore || persistQueued) return;
    persistQueued = true;
    persistChain = persistChain.then(async () => {
      persistQueued = false;
      try {
        await openPushTagsStore.write({ open: [...openPushTags], cleared: [...recentlyClearedTags] });
      } catch (error) {
        console.warn('[Push] failed to save open notification tags:', error?.message ?? error);
      }
    });
  };

  const restoredOpenPushTags = openPushTagsStore
    ? Promise.resolve()
      .then(() => openPushTagsStore.read())
      .then((saved) => {
        const open = (Array.isArray(saved?.open) ? saved.open : []).filter(([tag, entry]) =>
          tag && entry?.sessionId && !openPushTags.has(tag));
        const restoredOpen = open.map(([tag, entry]) => [tag, {
          sessionId: entry.sessionId,
          cause: entry.cause ?? null,
          native: entry.native === true,
          nid: entry.nid ?? null,
          skipTurnStart: entry.skipTurnStart === true,
        }]);
        const merged = new Map([...restoredOpen, ...openPushTags]);
        openPushTags.clear();
        for (const [tag, entry] of merged) openPushTags.set(tag, entry);
        keepNewest(openPushTags, OPEN_PUSH_TAGS_LIMIT);

        const cleared = (Array.isArray(saved?.cleared) ? saved.cleared : []).filter(([tag, entry]) =>
          tag && entry && !recentlyClearedTags.has(tag) && !openPushTags.has(tag));
        const mergedCleared = new Map([...cleared, ...recentlyClearedTags]);
        recentlyClearedTags.clear();
        for (const [tag, entry] of mergedCleared) recentlyClearedTags.set(tag, entry);
        keepNewest(recentlyClearedTags, RECENTLY_CLEARED_TAGS_LIMIT);
      })
      .catch((error) => {
        console.warn('[Push] failed to read open notification tags:', error?.message ?? error);
      })
    : Promise.resolve();

  const claimPushTag = async (tag, { sessionId, cause = null }) => {
    await restoredOpenPushTags;
    const previous = openPushTags.get(tag) ?? null;
    const claim = { sessionId, cause, native: previous?.native === true, nid: previous?.nid ?? null };
    openPushTags.delete(tag);
    openPushTags.set(tag, claim);
    keepNewest(openPushTags, OPEN_PUSH_TAGS_LIMIT);
    claimedOver.set(claim, previous);
    return claim;
  };
  const isClaimCurrent = (tag, claim) => openPushTags.get(tag) === claim;
  const releaseClaim = (tag, claim) => {
    if (!isClaimCurrent(tag, claim)) return;
    const previous = claimedOver.get(claim);
    openPushTags.delete(tag);
    if (previous) openPushTags.set(tag, previous);
  };

  const clearPushTags = (tags) => {
    if (tags.length === 0) return;
    const nativeEntries = [];
    for (const tag of tags) {
      const open = openPushTags.get(tag);
      openPushTags.delete(tag);
      pendingPushTags.delete(tag);
      if (!open?.nid) continue;
      const entry = clearEntryOf(tag, open);
      if (open.native) nativeEntries.push(entry);
      recentlyClearedTags.delete(tag);
      recentlyClearedTags.set(tag, entry);
    }
    keepNewest(recentlyClearedTags, RECENTLY_CLEARED_TAGS_LIMIT);
    persistOpenPushTags();
    if (nativeEntries.length === 0 || !clearApnsNotifications) return;
    Promise.resolve(clearApnsNotifications({ tags: nativeEntries, badge: pendingPushTags.size })).catch((error) => {
      console.warn('[APNs] clearing failed:', error?.message ?? error);
    });
  };

  const clearPushTag = async (tag, cause = null) => {
    await restoredOpenPushTags;
    const open = openPushTags.get(tag);
    if (!open) return;
    if (cause !== null && open.cause !== null && open.cause !== cause) return;
    clearPushTags([tag]);
  };

  let shareAnswerBatch = null;

  const dropPendingShareAnswers = (sessionId, turnStart) => {
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
    clearTimeout(batch.timer);
    shareAnswerBatch = null;
  };

  const clearSessionPushNotifications = async (sessionId, { turnStart = false } = {}) => {
    if (!sessionId) return;
    sessionClearedAt.delete(sessionId);
    sessionClearedAt.set(sessionId, Date.now());
    keepNewest(sessionClearedAt, OPEN_PUSH_TAGS_LIMIT);
    dropPendingShareAnswers(sessionId, turnStart);
    await restoredOpenPushTags;
    const tags = [];
    for (const [tag, open] of openPushTags) {
      if (open.sessionId !== sessionId) continue;
      if (turnStart && open.skipTurnStart) {
        open.skipTurnStart = false;
        persistOpenPushTags();
        continue;
      }
      tags.push(tag);
    }
    clearPushTags(tags);
  };

  const genericTitleOf = (payload) => genericNotificationTitle(payload?.data?.type);

  const toApnsGenericPayload = (payload) => {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const knownSessionName = typeof data.sessionName === 'string' ? data.sessionName.trim() : '';
    const sessionName = knownSessionName || (data.type === 'pull-request' ? '' : 'Session');
    const phoneBody = payload?.phoneBody ?? '';
    return {
      title: genericTitleOf(payload),
      body: isEnterpriseMode() ? '' : sessionName,
      sealed: phoneBody && !isEnterpriseMode()
        ? { title: knownSessionName || genericTitleOf(payload), body: phoneBody }
        : undefined,
      badge: trackPushAndCountBadge(typeof payload?.tag === 'string' ? payload.tag : undefined),
      tag: payload?.tag,
      data: {
        sessionId: data.sessionId,
        tag: payload?.tag,
        nid: payload?.nid,
        clear: payload?.clear?.join(','),
      },
    };
  };

  const phoneBodyOf = (prefix, text) => {
    const detail = truncateNotificationText((text ?? '').trim());
    if (!detail) return '';
    return prefix ? `${prefix}: ${detail}` : detail;
  };

  const PERMISSION_PREFIX_BY_ACTION = {
    bash: 'Wants to run',
    edit: 'Wants to edit',
    read: 'Wants to read',
  };

  const toWebPushPayload = (payload) => {
    if (!isEnterpriseMode()) return payload;
    const { sessionName: _sessionName, ...rest } = payload.data ?? {};
    return { ...payload, title: genericTitleOf(payload), body: '', data: rest };
  };

  const fanoutPush = ({ phoneBody, claim, ...pushPayload }, options) => {
    const tag = pushPayload.tag ?? '';
    if (claim && !isClaimCurrent(tag, claim)) return Promise.resolve();
    const interactiveVisible = isAnyInteractiveClientVisible?.() === true;
    recentlyClearedTags.delete(tag);
    const clear = [...recentlyClearedTags.values()];
    const payload = clear.length > 0 ? { ...pushPayload, clear } : pushPayload;
    if (claim) {
      claim.nid = nextNotificationId();
      if (!interactiveVisible) claim.native = true;
      persistOpenPushTags();
    }
    return Promise.all([
      Promise.resolve(sendPushToAllUiSessions?.(toWebPushPayload(claim ? { ...payload, data: { ...payload.data, nid: claim.nid } } : payload), options)).catch((error) => {
        console.warn('[Push] web-push fanout failed:', error?.message ?? error);
      }),
      interactiveVisible
        ? Promise.resolve()
        : Promise.resolve(sendApnsToAllUiSessions?.(toApnsGenericPayload({ ...payload, phoneBody, nid: claim?.nid }), options)).catch((error) => {
            console.warn('[APNs] fanout failed:', error?.message ?? error);
          }),
    ]);
  };

  const showInOpenClients = (payload) => {
    if (payload.requireHidden && isAnyUiVisible()) return;
    const desktopNotificationDelivered = emitDesktopNotification(payload);
    broadcastUiNotification(payload, { desktopNotificationDelivered });
  };

  const sendToChannels = ({ kind, title, body, tag, sessionId, directory, sessionName }, settings) => {
    if (typeof deliverToExtensionChannels !== 'function') return;
    const enterprise = isEnterpriseMode();
    const notification = {
      kind,
      title: enterprise ? genericNotificationTitle(kind) : title,
      body: enterprise ? '' : body,
      tag,
      at: Date.now(),
      sessionId: sessionId || null,
      sessionName: enterprise ? null : (typeof sessionName === 'string' && sessionName.trim() ? sessionName.trim() : null),
      directory: enterprise ? null : (typeof directory === 'string' && directory ? directory : null),
      url: sessionId ? buildSessionDeepLinkUrl(sessionId) : null,
    };
    Promise.resolve(deliverToExtensionChannels({ notification, requireHidden: settings?.notificationMode !== 'always' })).catch((error) => {
      console.warn('[Notification] extension channel delivery failed:', error?.message ?? error);
    });
  };

  let getIsWindowFocused = typeof deps.getIsWindowFocused === 'function'
    ? deps.getIsWindowFocused
    : null;

  const setGetIsWindowFocused = (cb) => {
    getIsWindowFocused = typeof cb === 'function' ? cb : null;
  };

  const PUSH_READY_COOLDOWN_MS = 5000;
  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  const pushQuestionDebounceTimers = new Map();
  const pushPermissionDebounceTimers = new Map();
  const notifiedPermissionRequests = new Set();
  const lastReadyNotificationAt = new Map();
  const lastErrorNotificationAt = new Map();

  const sessionParentIdCache = new Map();
  const SESSION_PARENT_CACHE_TTL_MS = 60 * 1000;

  const autoAcceptingSessions = new Set();
  const setAutoAcceptSession = (sessionId, enabled) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (enabled) {
      autoAcceptingSessions.add(sessionId);
    } else {
      autoAcceptingSessions.delete(sessionId);
    }
  };

  const buildSessionDeepLinkUrl = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') {
      return '/';
    }
    return `/?session=${encodeURIComponent(sessionId)}`;
  };

  const getSessionParentCacheKey = (sessionId, directory, spaceId) => `${spaceId || ''}\0${directory || ''}\0${sessionId}`;

  const getCachedSessionParentId = (sessionId, directory, spaceId) => {
    const cacheKey = getSessionParentCacheKey(sessionId, directory, spaceId);
    const entry = sessionParentIdCache.get(cacheKey);
    if (!entry) return undefined;
    if (Date.now() - entry.at > SESSION_PARENT_CACHE_TTL_MS) {
      sessionParentIdCache.delete(cacheKey);
      return undefined;
    }
    return entry.parentID;
  };

  const setCachedSessionParentId = (sessionId, directory, spaceId, parentID) => {
    sessionParentIdCache.set(getSessionParentCacheKey(sessionId, directory, spaceId), { parentID: parentID ?? null, at: Date.now() });
  };

  const getParentIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return undefined;
    if (payload.type !== 'session.created' && payload.type !== 'session.updated') return undefined;
    const parentID = payload.properties?.info?.parentID;
    if (typeof parentID === 'string' && parentID.length > 0) return parentID;
    return payload.type === 'session.created' ? null : undefined;
  };

  const ASSISTANT_STEP_CACHE_LIMIT = 500;
  const assistantStepMeta = new Map();
  const lastAssistantStepBySession = new Map();
  const rememberAssistantStep = (info) => {
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
      while (lastAssistantStepBySession.size > ASSISTANT_STEP_CACHE_LIMIT) {
        lastAssistantStepBySession.delete(lastAssistantStepBySession.keys().next().value);
      }
    }
    while (assistantStepMeta.size > ASSISTANT_STEP_CACHE_LIMIT) {
      assistantStepMeta.delete(assistantStepMeta.keys().next().value);
    }
  };
  const withRememberedStep = (info) => {
    const remembered = info ? assistantStepMeta.get(String(info.id ?? '')) : undefined;
    if (!remembered) return info;
    const merged = { ...info };
    if (!merged.agent && !merged.mode) {
      merged.agent = remembered.agent;
      merged.mode = remembered.agent;
    }
    if (!merged.modelID) merged.modelID = remembered.modelID;
    return merged;
  };

  const maybeCacheSessionParentFromPayload = (payload, spaceId) => {
    const sessionId = extractSessionIdFromPayload(payload);
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    const directory = extractDirectoryFromPayload(payload);
    const parentID = getParentIdFromPayload(payload);
    if (parentID === undefined) return;
    setCachedSessionParentId(sessionId, directory, spaceId, parentID);
  };

  const fetchSessionRecord = async (sessionId, directory, spaceId) => {
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
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) return null;
      const session = unwrapOpenCodeResponse(await response.json().catch(() => null));
      return session && typeof session === 'object' ? session : null;
    } catch {
      return null;
    }
  };

  const fetchSessionParentId = async (sessionId, directory, spaceId = null) => {
    if (!sessionId) return undefined;

    const cached = getCachedSessionParentId(sessionId, directory, spaceId);
    if (cached !== undefined) return cached;

    const session = await fetchSessionRecord(sessionId, directory, spaceId);
    if (!session) return undefined;
    const parentID = sessionParentId(session);
    setCachedSessionParentId(sessionId, directory, spaceId, parentID);
    return parentID;
  };

  const isSessionAutoAccepting = async (sessionId, directory) => {
    if (!sessionId || autoAcceptingSessions.size === 0) return false;
    let current = sessionId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      if (autoAcceptingSessions.has(current)) return true;
      seen.add(current);
      const parent = await fetchSessionParentId(current, directory);
      if (!parent) return false;
      current = parent;
    }
    return false;
  };

  const readFormAsk = (payload) => {
    const form = payload.properties?.form;
    const header = typeof form?.title === 'string' ? form.title.trim() : '';
    const firstField = Array.isArray(form?.fields) ? form.fields[0] : null;
    const fieldTitle = typeof firstField?.title === 'string' ? firstField.title.trim() : '';
    const fieldDescription = typeof firstField?.description === 'string' ? firstField.description.trim() : '';
    const id = form?.id || null;
    return { id, header, questionText: fieldDescription || fieldTitle };
  };

  const readPageAsk = (payload) => {
    const { id, title } = payload.properties?.page ?? {};
    return {
      id: id || null,
      header: '',
      questionText: String(title ?? '').trim(),
    };
  };

  const extractSessionIdFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const props = payload.properties;
    const info = props?.info;
    const sessionId =
      info?.sessionID ??
      info?.sessionId ??
      props?.sessionID ??
      props?.sessionId ??
      props?.session ??
      null;
    return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  };

  const extractDirectoryFromPayload = (payload) => {
    if (!payload || typeof payload !== 'object') return undefined;
    const props = payload.properties;
    const directory = props?.directory ?? props?.info?.directory;
    if (typeof directory !== 'string') return undefined;
    const trimmed = directory.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const formatMode = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    const normalized = value.length > 0 ? value : 'agent';
    return normalized
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
      .join(' ');
  };

  const formatModelId = (raw) => {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
      return 'Assistant';
    }

    const tokens = value.split(/[-_]+/).filter(Boolean);
    const result = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const current = tokens[i];
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

  const hasActiveSessionGoal = async (sessionId, spaceId) => {
    if (!sessionId || (!spaceId && typeof readSessionMetadata !== 'function')) return false;
    try {
      const metadata = spaceId
        ? (await fetchSessionRecord(sessionId, undefined, spaceId))?.metadata
        : await readSessionMetadata(sessionId);
      const goal = metadata?.openchamber?.goal;
      return Boolean(goal && typeof goal === 'object' && goal.status === 'active');
    } catch {
      return false;
    }
  };

  const maybeSendPushForTrigger = async (payload, { spaceId = null } = {}) => {
    if (!payload || typeof payload !== 'object') {
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
      const errorText = typeof error?.message === 'string'
        ? error.message
        : typeof error === 'string' ? error : '';
      await maybeSendPushForTrigger({
        ...payload,
        type: 'message.updated',
        properties: {
          ...payload.properties,
          turnEnded: true,
          turnEndedAt,
          info: {
            id: lastAssistantStepBySession.get(sessionId),
            sessionID: sessionId,
            role: 'assistant',
            finish: payload.type === 'session.error' ? 'error' : 'stop',
            ...(errorText ? { parts: [{ type: 'text', text: errorText }] } : {}),
          },
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
        const claim = await claimPushTag(readyTag, { sessionId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= (payload.properties?.turnEndedAt ?? now)) {
          releaseClaim(readyTag, claim);
          return;
        }

        const texts = notificationTexts(settings.locale);
        let title = renderNotificationText(texts.readyTitle, {
          agent_name: formatMode(info?.mode),
        });
        let body = renderNotificationText(texts.readyMessage, {
          model_name: formatModelId(info?.modelID),
        });
        let sessionName = '';
        let reply = '';

        try {
          const templates = settings.notificationTemplates || {};
          const defaults = defaultNotificationTemplates(settings.locale);
          const isSubtask = await fetchSessionParentId(sessionId, notificationDirectory, spaceId);
          const usesSubtaskTemplate = Boolean(isSubtask) && settings.notifyOnSubtasks !== false;
          const completionTemplate = withTemplateDefaults(
            usesSubtaskTemplate ? (templates.subtask ?? templates.completion) : templates.completion,
            usesSubtaskTemplate ? defaults.subtask : defaults.completion,
          );

          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;

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
          console.warn('[Notification] Template resolution failed, using defaults:', error?.message || error);
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
        if (info?.error?.type === 'aborted') {
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
        const claim = await claimPushTag(errorTag, { sessionId });
        if ((sessionClearedAt.get(sessionId) ?? 0) >= (payload.properties?.turnEndedAt ?? now)) {
          releaseClaim(errorTag, claim);
          return;
        }

        const texts = notificationTexts(settings.locale);
        let title = texts.errorTitle;
        let body = texts.errorBody;
        let sessionName = '';
        let errorText = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
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
            (settings.notificationTemplates || {}).error,
            defaultNotificationTemplates(settings.locale).error,
          );
          const resolvedTitle = resolveNotificationTemplate(errorTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(errorTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(errorTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Error template resolution failed, using defaults:', error?.message || error);
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
        const claim = await claimPushTag(questionTag, { sessionId, cause: ask.id });
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

        const texts = notificationTexts(settings.locale);
        let title = /plan\s*mode/i.test(header)
          ? texts.planModeTitle
          : /build\s*agent/i.test(header)
            ? texts.buildModeTitle
            : header || texts.questionTitle;
        let body = questionText || texts.questionBody;
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, formSessionId, source);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
          variables.last_message = questionText || header || '';

          const templates = settings.notificationTemplates || {};
          const questionTemplate = withTemplateDefaults(
            templates.question,
            defaultNotificationTemplates(settings.locale).question,
          );

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Question template resolution failed, using defaults:', error?.message || error);
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
      const permissionAction = typeof payload.properties?.action === 'string' ? payload.properties.action.trim() : '';
      const permissionResource = Array.isArray(payload.properties?.resources)
        ? String(payload.properties.resources[0] ?? '').trim()
        : '';
      const permissionMessage = typeof payload.properties?.message === 'string' ? payload.properties.message.trim() : '';
      const permission = permissionMessage
        || (permissionAction && permissionResource ? `${permissionAction}: ${permissionResource}` : permissionAction);
      const permissionPhoneBody = PERMISSION_PREFIX_BY_ACTION[permissionAction] && permissionResource
        ? phoneBodyOf(PERMISSION_PREFIX_BY_ACTION[permissionAction], permissionResource)
        : phoneBodyOf('Wants permission', permission);
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
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
        const claim = await claimPushTag(permissionTag, { sessionId, cause: requestKey });
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
        const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
        const texts = notificationTexts(settings.locale);
        const fallbackMessage = permissionText
          || (typeof sessionTitle === 'string' && sessionTitle.trim().length > 0 ? sessionTitle.trim() : '')
          || texts.permissionBody;

        let title = texts.permissionTitle;
        let body = fallbackMessage;
        let sessionName = '';

        try {
          const variables = await buildTemplateVariables(payload, sessionId, source);
          sessionName = typeof variables.session_name === 'string' ? variables.session_name : sessionName;
          variables.last_message = fallbackMessage;

          const templates = settings.notificationTemplates || {};
          const questionDefaults = defaultNotificationTemplates(settings.locale).question;
          const questionTemplate = withTemplateDefaults(
            templates.question,
            { ...questionDefaults, title: texts.permissionTitle },
          );

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Permission template resolution failed, using defaults:', error?.message || error);
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

  const sendSettlePush = async ({ sessionId, directory, type, tag, title, body }) => {
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
        const session = unwrapOpenCodeResponse(await response.json().catch(() => null));
        if (typeof session?.title === 'string') sessionName = session.title.trim();
      }
    } catch {
      // Session name is presentation sugar for the mobile push — never block on it.
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
    if (typeof deliverToExtensionChannels === 'function') {
      sendToChannels({ kind: type, title, body, tag, sessionId, directory, sessionName }, await readSettingsFromDisk());
    }
  };

  const sendGoalSettlePush = ({ sessionId, directory, status, title, body }) => sendSettlePush({
    sessionId,
    directory,
    type: status === 'complete' ? 'goal_complete' : (status === 'budgetLimited' ? 'goal_budget' : 'goal_blocked'),
    tag: `goal-${sessionId}`,
    title,
    body,
  });

  const notifyAutoReviewEnded = async ({ sessionId, directory, status, error }) => {
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) return;
    if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) return;
    const texts = notificationTexts(settings.locale);
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

  const notifyPullRequest = async ({ item, event }) => {
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnPullRequests === false) return;
    if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) return;
    const title = pullRequestNotificationTitle(settings.locale, event);
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

  const readSessionSummary = async (sessionId) => {
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

  const announceShareAnswers = async (answers) => {
    const settings = await readSettingsFromDisk();
    if (settings.notifyOnCompletion === false) return;
    const texts = notificationTexts(settings.locale);
    const newest = answers.at(-1);
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

  const notifyShareAnswer = (answer) => {
    const batch = shareAnswerBatch ?? { answers: [], firstAt: Date.now(), timer: null };
    shareAnswerBatch = batch;
    batch.answers.push({ ...answer, woken: false });
    clearTimeout(batch.timer);
    const wait = Math.max(0, Math.min(SHARE_ANSWER_QUIET_MS, batch.firstAt + SHARE_ANSWER_MAX_WAIT_MS - Date.now()));
    batch.timer = setTimeout(() => {
      if (shareAnswerBatch === batch) shareAnswerBatch = null;
      announceShareAnswers(batch.answers).catch((error) => {
        console.warn('[Notification] shared page answer notification failed:', error?.message ?? error);
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
