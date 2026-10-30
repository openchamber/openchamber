import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { isEnterpriseMode } from '../enterprise-mode.js';
import { genericNotificationTitle, truncateNotificationText } from './message.js';
import {
  defaultNotificationTemplates,
  notificationTexts,
  renderNotificationText,
  withTemplateDefaults,
} from './template-locales.js';

/** The session id OpenCode gives an MCP elicitation form, which no session owns. */
const LOCATION_SCOPED_FORM_SESSION_ID = 'global';

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
    isAnyInteractiveClientVisible,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    // OpenChamber's own session metadata (the goal lives there, not on the
    // OpenCode record). Optional: without it no goal can suppress a push.
    readSessionMetadata = null,
    // `(spaceId) => fetch` for a session of an isolated space, whose record and messages only
    // the OpenCode inside that space has; null while the feature is off.
    spaceFetchFor = () => null,
    // `(sessionId, turnEndedAt)`: whether that turn was a step of an
    // auto-review loop; the loop's end notifies once (`notifyAutoReviewEnded`).
    isInAutoReview = () => false,
    // `({ notification, requireHidden })`: extension notification channels
    // (`extension-channels.js`), called where push is, with the text push gets.
    deliverToExtensionChannels = null,
  } = deps;
  let getIsSessionAutoAccepting = deps.getIsSessionAutoAccepting;
  // Where a session is read: the host's OpenCode for its own sessions, the OpenCode inside the
  // space for a session of a space. The host's OpenCode does not know a space's session, so it
  // is never asked about one; a space that cannot be asked answers nothing.
  const hostSource = { buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl: (...args) => fetch(...args) };
  const unreachableSpaceFetch = async () => { throw new Error('isolated spaces are off'); };
  const sourceFor = (spaceId) => (spaceId
    ? {
        buildOpenCodeUrl: (fetchPath) => `http://space${fetchPath}`,
        getOpenCodeAuthHeaders: () => ({}),
        fetchImpl: spaceFetchFor(spaceId) ?? unreachableSpaceFetch,
      }
    : hostSource);
  const hostActivityProbe = createSessionActivityProbe({ ...hostSource, timeoutMs: 2000 });

  // A parent goes idle while a background subagent still works; OpenCode then
  // hands the result back and the parent runs again. That first idle is a
  // pause, so it announces nothing. When the check cannot be made, the idle is
  // announced as before: a missed "ready" is worse than an early one.
  const isPausedForSubagents = async (sessionId, spaceId) => {
    const activityProbe = spaceId ? createSessionActivityProbe({ ...sourceFor(spaceId), timeoutMs: 2000 }) : hostActivityProbe;
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return false;
    return (await activityProbe.hasWorkingChildren(sessionId, statuses)) === true;
  };
  const setGetIsSessionAutoAccepting = (resolver) => {
    getIsSessionAutoAccepting = typeof resolver === 'function' ? resolver : undefined;
  };

  // App-icon badge for native push: the set of DISTINCT collapse-ids (the push
  // `tag`, e.g. `ready-<sessionId>` / `permission-<requestKey>`) we've sent since
  // the app was last foregrounded. The badge is the absolute APNs `aps.badge`.
  //
  // We key by `tag`, not sessionId, because the tag IS the banner identity: iOS
  // uses it as `apns-collapse-id`, so same-tag pushes REPLACE one banner while
  // different tags are distinct banners. One session can raise several banners
  // (ready + question + permission are different tags), so counting sessionIds
  // both over- and under-counts the lock-screen stack; counting tags mirrors it.
  //
  // We deliberately do NOT derive this from the in-app unread marks (OpenCode's
  // `time.viewed`): a backgrounded client can still be on the session, and the
  // mark changes on a separate event that races the push trigger. The
  // set is cleared when a UI client reports visible (`clearPendingPushBadge`),
  // the same moment the device zeroes its icon badge on becomeActive.
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

  // Generic notification for native push (per the mobile design): a fixed, scenario-based
  // title + the session name as the body. No model/project/message content crosses the relay
  // in the clear; a phone with a push key gets what happened sealed (`sealed` below).
  const genericTitleOf = (payload) => genericNotificationTitle(payload?.data?.type);

  const toApnsGenericPayload = (payload) => {
    const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
    const knownSessionName = typeof data.sessionName === 'string' ? data.sessionName.trim() : '';
    const sessionName = knownSessionName || 'Session';
    const phoneBody = payload?.phoneBody ?? '';
    return {
      title: genericTitleOf(payload),
      // A session name is derived from the conversation.
      body: isEnterpriseMode() ? '' : sessionName,
      // A phone with a push key opens this on the device; the relay and the
      // push service see only the title above. Enterprise mode keeps the
      // generic text even sealed: the push service is outside its boundary.
      sealed: phoneBody && !isEnterpriseMode()
        ? { title: knownSessionName || genericTitleOf(payload), body: phoneBody }
        : undefined,
      badge: trackPushAndCountBadge(typeof payload?.tag === 'string' ? payload.tag : undefined),
      tag: payload?.tag,
      // sessionId is forwarded so a tapped push can deep-link; it is an opaque id, not content.
      data: typeof data.sessionId === 'string' ? { sessionId: data.sessionId } : undefined,
    };
  };

  // The body a phone shows: what happened, after a word that says which kind
  // of event it is. A finished turn needs no word, its reply says it.
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

  // Fan a notification out to every delivery channel: browser web-push (full templated
  // payload) and native iOS APNs (generic model-based text). Both share the dedup tag and
  // `requireNoSse` focus gate; a failure in one channel must not block the other.
  // Web push leaves through the browser vendor's push service. It is
  // encrypted, but enterprise mode keeps conversation content off every
  // channel it does not control: the scenario title and the deep link only.
  const toWebPushPayload = (payload) => {
    if (!isEnterpriseMode()) return payload;
    // Every payload built in this file carries a `data` object.
    const { sessionName: _sessionName, ...rest } = payload.data ?? {};
    return { ...payload, title: genericTitleOf(payload), body: '', data: rest };
  };

  const fanoutPush = ({ phoneBody, ...payload }, options) => {
    // Presence-aware routing: if any interactive (non-mobile) client — desktop/web/vscode — is
    // currently visible, it already shows the in-app notification, so skip the native push to the
    // phone. Gated on the desktop's visibility (reliable), never the phone's own. When we skip we
    // also skip toApnsGenericPayload, so the badge isn't incremented for an undelivered push.
    const interactiveVisible = isAnyInteractiveClientVisible?.() === true;
    return Promise.all([
      Promise.resolve(sendPushToAllUiSessions?.(toWebPushPayload(payload), options)).catch((error) => {
        console.warn('[Push] web-push fanout failed:', error?.message ?? error);
      }),
      interactiveVisible
        ? Promise.resolve()
        : Promise.resolve(sendApnsToAllUiSessions?.(toApnsGenericPayload({ ...payload, phoneBody }), options)).catch((error) => {
            console.warn('[APNs] fanout failed:', error?.message ?? error);
          }),
    ]);
  };

  /**
   * What an extension channel receives: the same text as web push, after the
   * user's templates, and in enterprise mode the same generic title with no
   * body, session name or directory, since the channel's server is outside
   * the boundary. Sent beside `fanoutPush`, after the same toggles and
   * suppressions; the channel module applies the visibility gate itself.
   */
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

  // Sessions where the client has enabled Permission Auto-Accept. Mirrored
  // from the client-side permissionStore via POST /api/notifications/auto-accept
  // so the server can suppress permission notifications BEFORE dispatch (the
  // 500ms debounce race otherwise leaks notifications for auto-accepted
  // permissions when the replied round-trip is slower than the debounce).
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
    // Only the full record from `session.created` proves a session has no
    // parent. `session.updated` also carries partial records (usage, title)
    // without `parentID`, and reading those as "no parent" turned a subagent
    // into a main session, so its finish announced "ready" with subagent
    // notifications turned off.
    return payload.type === 'session.created' ? null : undefined;
  };

  // v2 splits one assistant turn over two events: `session.step.started`
  // names the agent and model, `session.step.ended` carries the finish. The
  // translator hands both over as `message.updated` on the same message id,
  // so the start is remembered here and folded into the finish, which is the
  // event the "ready" push is built from. Bounded: a session emits a handful
  // of steps and the map is per process.
  const ASSISTANT_STEP_CACHE_LIMIT = 500;
  const assistantStepMeta = new Map();
  // The reply a turn ended on: the idle event names only the session, so the
  // ready notification borrows this step's id for its agent, model and text.
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

  /** The session's own record, or null when it could not be read. */
  const fetchSessionRecord = async (sessionId, directory, spaceId) => {
    try {
      const source = sourceFor(spaceId);
      const base = source.buildOpenCodeUrl(`/api/session/${encodeURIComponent(sessionId)}`, '');
      // The space's own OpenCode finds its session by id; a directory names the host's instance.
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
    const parentID = typeof session.parentID === 'string' && session.parentID.length > 0
      ? session.parentID
      : null;
    setCachedSessionParentId(sessionId, directory, spaceId, parentID);
    return parentID;
  };

  // Mirrors client-side autoRespondsPermission: a session auto-accepts if it
  // OR any ancestor is flagged. Walks the parent chain via fetchSessionParentId.
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

  // v2 replaced questions with forms: the form's title is the ask, and the
  // first field carries the detail a question used to put in its body.
  const readFormAsk = (payload) => {
    const form = payload.properties?.form;
    const header = typeof form?.title === 'string' ? form.title.trim() : '';
    const firstField = Array.isArray(form?.fields) ? form.fields[0] : null;
    const fieldTitle = typeof firstField?.title === 'string' ? firstField.title.trim() : '';
    const fieldDescription = typeof firstField?.description === 'string' ? firstField.description.trim() : '';
    return { header, questionText: fieldDescription || fieldTitle };
  };

  // A waiting page's title says what it asks; the notification title stays
  // the generic "Input needed".
  const readPageAsk = (payload) => {
    const title = payload.properties?.page?.title;
    return { header: '', questionText: typeof title === 'string' ? title.trim() : '' };
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

  // A session with an ACTIVE goal suppresses per-turn ready notifications;
  // the session-goal runtime sends its own notification when the goal
  // settles. Fetch failures fall through to normal notification behavior.
  // A space's session keeps its metadata in its record inside the space.
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

  /** `spaceId` marks an event of an isolated space: its session is read inside that space. */
  const maybeSendPushForTrigger = async (payload, { spaceId = null } = {}) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    maybeCacheSessionParentFromPayload(payload, spaceId);
    const source = sourceFor(spaceId);

    const sessionId = extractSessionIdFromPayload(payload);
    const notificationDirectory = extractDirectoryFromPayload(payload);
    // A user abort arrives as `session.idle` with `aborted: true`: the turn
    // did not finish, so there is nothing to announce as ready.
    if (payload.type === 'session.idle' && payload.properties?.aborted === true) {
      return;
    }

    if ((payload.type === 'session.idle' || payload.type === 'session.error') && sessionId) {
      // Taken before any wait: an auto-review may settle meanwhile, and its
      // last step is told apart from a later turn by this time.
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
          // Only a turn end announces readiness; a step's `stop` does not.
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
      // v2 ends every step with a `message.updated`; the last one says `stop`,
      // but the execution can still drain steering input after it. Readiness
      // is announced from the execution's terminal `session.idle` instead.
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

        // While a goal drives the session, per-turn "ready" notifications are
        // noise produced by the goal loop itself — the goal's own settle
        // notification (complete/blocked/budget) is the final word instead.
        if (await hasActiveSessionGoal(sessionId, spaceId)) {
          return;
        }

        // The same for an auto-review: each step ends a turn of one of its
        // two sessions. A space's run lives in the space, so its steps notify.
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
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        await fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('', reply),
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
        // Interrupted steps carry `aborted`; terminal execution failures still
        // notify through session.error, including exhausted auto-resume attempts.
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
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        await fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('Error', errorText),
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

    // A form, and a page an agent shows that waits for the user's answer
    // (render.page with awaitAnswer, announced by this server), both mean the
    // agent waits for the user, so they notify the same way.
    const ask = payload.type === 'form.created' ? readFormAsk(payload)
      : payload.type === 'openchamber:page-waiting' ? readPageAsk(payload)
        : null;
    if (ask && sessionId) {
      const existingTimer = pushQuestionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(async () => {
        pushQuestionDebounceTimers.delete(sessionId);

        const settings = await readSettingsFromDisk();
        if (settings.notifyOnQuestion === false) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const { header, questionText } = ask;
        // An MCP elicitation belongs to the whole directory: OpenCode files it
        // under the `global` sentinel, which no session record carries, so the
        // notification opens the app instead of a session that cannot load.
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
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        void fanoutPush(
          {
            title,
            body,
            phoneBody: phoneBodyOf('Question', questionText || header),
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

      pushQuestionDebounceTimers.set(sessionId, timer);
      return;
    }

    if (payload.type === 'permission.replied' && sessionId) {
      const requestId = payload.properties?.requestID ?? payload.properties?.requestId ?? payload.properties?.id;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (!pendingNotification) {
        return;
      }

      // Some runtimes may omit requestID on permission.replied.
      // When request ID is missing, clear session debounce to avoid
      // showing stale permission notifications for auto-approved prompts.
      if (!requestKey || !pendingNotification.requestKey || pendingNotification.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
      const requestId = payload.properties?.id ?? payload.properties?.requestID ?? payload.properties?.requestId;
      // v2 describes a permission request as an action plus the resources it
      // touches; the v1 single `permission` string is gone.
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

      // The session (or an ancestor) answers permissions by itself. Skip the
      // notification when this request was answered automatically; one the
      // safety net held for the user still notifies. The host's permission
      // policy knows nothing of a space's session, so it is not asked about one.
      const isAutoAnswered = async () => !spaceId && await (getIsSessionAutoAccepting?.(sessionId, notificationDirectory, requestId)
        ?? isSessionAutoAccepting(sessionId, notificationDirectory));
      if (await isAutoAnswered()) {
        if (requestKey) notifiedPermissionRequests.add(requestKey);
        return;
      }

      const existingTimer = pushPermissionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushPermissionDebounceTimers.delete(sessionId);

        if (await isAutoAnswered()) {
          if (requestKey) notifiedPermissionRequests.add(requestKey);
          return;
        }

        const settings = await readSettingsFromDisk();

        if (settings.notifyOnQuestion === false) {
          return;
        }

        if (settings.notificationMode !== 'always' && getIsWindowFocused?.()) {
          return;
        }

        const sessionTitle = payload.properties?.sessionTitle;
        const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
        const texts = notificationTexts(settings.locale);
        // What the agent wants to do decides the answer, so it comes before the session name.
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
          // Permissions reuse the question template (as they always have), but
          // an empty field falls back to the permission wording, not to "input".
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
          const desktopNotificationDelivered = emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload, { desktopNotificationDelivered });
        }

        if (requestKey) {
          notifiedPermissionRequests.add(requestKey);
        }

        void fanoutPush(
          {
            title,
            body,
            phoneBody: permissionPhoneBody,
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

  // Goal and review settle push: same fanout as the trigger paths (web-push
  // with the full text; APNs with the generic per-type title and the session
  // name as body, so the relay never sees content).
  const sendSettlePush = async ({ sessionId, directory, type, tag, title, body }) => {
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

  /**
   * One notification when an auto-review ends on its own, for the reviewed
   * session: its steps notified nothing. It obeys the completion toggle, as
   * the "ready" notifications it replaces do. A stop by the user (the row's
   * Stop, an aborted turn) announces nothing: the user was there.
   */
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
      const desktopNotificationDelivered = emitDesktopNotification(payload);
      broadcastUiNotification(payload, { desktopNotificationDelivered });
    }
    await sendSettlePush({ sessionId, directory, type: 'review', tag, title, body });
  };

  return {
    maybeSendPushForTrigger,
    setAutoAcceptSession,
    setGetIsWindowFocused,
    setGetIsSessionAutoAccepting,
    clearPendingPushBadge,
    sendGoalSettlePush,
    notifyAutoReviewEnded,
  };
};
