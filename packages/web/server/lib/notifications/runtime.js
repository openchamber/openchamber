export const createNotificationTriggerRuntime = (deps) => {
  const {
    readSettingsFromDisk,
    prepareNotificationLastMessage,
    summarizeText,
    resolveZenModel,
    buildTemplateVariables,
    extractLastMessageText,
    fetchLastAssistantMessageText,
    resolveNotificationTemplate,
    shouldApplyResolvedTemplateMessage,
    emitDesktopNotification,
    broadcastUiNotification,
    sendPushToAllUiSessions,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
  } = deps;

  const PUSH_READY_COOLDOWN_MS = 5000;
  const PUSH_QUESTION_DEBOUNCE_MS = 500;
  const PUSH_PERMISSION_DEBOUNCE_MS = 500;
  const pushQuestionDebounceTimers = new Map();
  const pushPermissionDebounceTimers = new Map();
  const notifiedPermissionRequests = new Set();
  const lastReadyNotificationAt = new Map();

  const sessionParentIdCache = new Map();
  const SESSION_PARENT_CACHE_TTL_MS = 60 * 1000;

  const buildSessionDeepLinkUrl = (sessionId) => {
    if (!sessionId || typeof sessionId !== 'string') {
      return '/';
    }
    return `/?session=${encodeURIComponent(sessionId)}`;
  };

  const getCachedSessionParentId = (sessionId) => {
    const entry = sessionParentIdCache.get(sessionId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > SESSION_PARENT_CACHE_TTL_MS) {
      sessionParentIdCache.delete(sessionId);
      return undefined;
    }
    return entry.parentID;
  };

  const setCachedSessionParentId = (sessionId, parentID) => {
    sessionParentIdCache.set(sessionId, { parentID: parentID ?? null, at: Date.now() });
  };

  const fetchSessionParentId = async (sessionId) => {
    if (!sessionId) return undefined;

    const cached = getCachedSessionParentId(sessionId);
    if (cached !== undefined) return cached;

    try {
      const response = await fetch(buildOpenCodeUrl('/session', ''), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...getOpenCodeAuthHeaders(),
        },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        return undefined;
      }
      const data = await response.json().catch(() => null);
      if (!Array.isArray(data)) {
        return undefined;
      }

      const match = data.find((session) => session && typeof session === 'object' && session.id === sessionId);
      const parentID = match?.parentID ? match.parentID : null;
      setCachedSessionParentId(sessionId, parentID);
      return parentID;
    } catch {
      return undefined;
    }
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

  const maybeSendPushForTrigger = async (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const sessionId = extractSessionIdFromPayload(payload);
    if (payload.type === 'message.updated') {
      const info = payload.properties?.info;
      if (info?.role === 'assistant' && info?.finish === 'stop' && sessionId) {
        const settings = await readSettingsFromDisk();

        if (settings.notifyOnSubtasks === false) {
          const sessionInfo = payload.properties?.session;
          const parentIDFromPayload = sessionInfo?.parentID ?? payload.properties?.parentID;
          const parentID = parentIDFromPayload
            ? parentIDFromPayload
            : await fetchSessionParentId(sessionId);

          if (parentID) {
            return;
          }
        }

        if (settings.notifyOnCompletion === false) {
          return;
        }

        const now = Date.now();
        const lastAt = lastReadyNotificationAt.get(sessionId) ?? 0;
        if (now - lastAt < PUSH_READY_COOLDOWN_MS) {
          return;
        }
        lastReadyNotificationAt.set(sessionId, now);

        let title = `${formatMode(info?.mode)} agent is ready`;
        let body = `${formatModelId(info?.modelID)} completed the task`;

        try {
          const templates = settings.notificationTemplates || {};
          const isSubtask = await fetchSessionParentId(sessionId);
          const completionTemplate = isSubtask && settings.notifyOnSubtasks !== false
            ? (templates.subtask || templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' })
            : (templates.completion || { title: '{agent_name} is ready', message: '{model_name} completed the task' });

          const variables = await buildTemplateVariables(payload, sessionId);

          const messageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, messageId);
          }

          const notifZenModel = await resolveZenModel(settings?.zenModel);
          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
            summarize: (text, len) => summarizeText(text, len, notifZenModel),
          });

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
            requireHidden: settings.notificationMode !== 'always',
          };
          emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload);
        }

        await sendPushToAllUiSessions(
          {
            title,
            body,
            tag: `ready-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              type: 'ready',
            },
          },
          { requireNoSse: true },
        );
      }

      if (info?.role === 'assistant' && info?.finish === 'error' && sessionId) {
        const settings = await readSettingsFromDisk();
        if (settings.notifyOnError === false) return;

        let title = 'Tool error';
        let body = 'An error occurred';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          const errorMessageId = info?.id;
          let lastMessage = extractLastMessageText(payload);
          if (!lastMessage) {
            lastMessage = await fetchLastAssistantMessageText(sessionId, errorMessageId);
          }

          const errZenModel = await resolveZenModel(settings?.zenModel);
          variables.last_message = await prepareNotificationLastMessage({
            message: lastMessage,
            settings,
            summarize: (text, len) => summarizeText(text, len, errZenModel),
          });

          const errorTemplate = (settings.notificationTemplates || {}).error || { title: 'Tool error', message: '{last_message}' };
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
            requireHidden: settings.notificationMode !== 'always',
          };
          emitDesktopNotification(notificationPayload);
          broadcastUiNotification(notificationPayload);
        }

        await sendPushToAllUiSessions(
          {
            title,
            body,
            tag: `error-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              type: 'error',
            },
          },
          { requireNoSse: true },
        );
      }

      return;
    }

    if (payload.type === 'question.asked' && sessionId) {
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

        const firstQuestion = payload.properties?.questions?.[0];
        const header = typeof firstQuestion?.header === 'string' ? firstQuestion.header.trim() : '';
        const questionText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';

        let title = /plan\s*mode/i.test(header)
          ? 'Switch to plan mode'
          : /build\s*agent/i.test(header)
            ? 'Switch to build mode'
            : header || 'Input needed';
        let body = questionText || 'Agent is waiting for your response';

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          variables.last_message = questionText || header || '';

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Input needed', message: '{last_message}' };

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Question template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          emitDesktopNotification({
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });

          broadcastUiNotification({
            kind: 'question',
            title,
            body,
            tag: `question-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });
        }

        void sendPushToAllUiSessions(
          {
            title,
            body,
            tag: `question-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              type: 'question',
            },
          },
          { requireNoSse: true },
        );
      }, PUSH_QUESTION_DEBOUNCE_MS);

      pushQuestionDebounceTimers.set(sessionId, timer);
      return;
    }

    if (payload.type === 'permission.replied' && sessionId) {
      const requestId = payload.properties?.requestID;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      const pendingNotification = pushPermissionDebounceTimers.get(sessionId);
      if (requestKey && pendingNotification?.requestKey === requestKey) {
        clearTimeout(pendingNotification.timer);
        pushPermissionDebounceTimers.delete(sessionId);
      }
      return;
    }

    if (payload.type === 'permission.asked' && sessionId) {
      const requestId = payload.properties?.id;
      const permission = payload.properties?.permission;
      const requestKey = typeof requestId === 'string' ? `${sessionId}:${requestId}` : null;
      if (requestKey && notifiedPermissionRequests.has(requestKey)) {
        return;
      }

      const existingTimer = pushPermissionDebounceTimers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer.timer);
      }

      const timer = setTimeout(async () => {
        pushPermissionDebounceTimers.delete(sessionId);

        const settings = await readSettingsFromDisk();

        if (settings.notifyOnQuestion === false) {
          return;
        }

        const sessionTitle = payload.properties?.sessionTitle;
        const permissionText = typeof permission === 'string' && permission.length > 0 ? permission : '';
        const fallbackMessage = typeof sessionTitle === 'string' && sessionTitle.trim().length > 0
          ? sessionTitle.trim()
          : permissionText || 'Agent is waiting for your approval';

        let title = 'Permission required';
        let body = fallbackMessage;

        try {
          const variables = await buildTemplateVariables(payload, sessionId);
          variables.last_message = fallbackMessage;

          const templates = settings.notificationTemplates || {};
          const questionTemplate = templates.question || { title: 'Permission required', message: '{last_message}' };

          const resolvedTitle = resolveNotificationTemplate(questionTemplate.title, variables);
          const resolvedBody = resolveNotificationTemplate(questionTemplate.message, variables);
          if (resolvedTitle) title = resolvedTitle;
          if (shouldApplyResolvedTemplateMessage(questionTemplate.message, resolvedBody, variables)) body = resolvedBody;
        } catch (error) {
          console.warn('[Notification] Permission template resolution failed, using defaults:', error?.message || error);
        }

        if (settings.nativeNotificationsEnabled) {
          emitDesktopNotification({
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });

          broadcastUiNotification({
            kind: 'permission',
            title,
            body,
            tag: requestKey ? `permission-${requestKey}` : `permission-${sessionId}`,
            sessionId,
            requireHidden: settings.notificationMode !== 'always',
          });
        }

        if (requestKey) {
          notifiedPermissionRequests.add(requestKey);
        }

        void sendPushToAllUiSessions(
          {
            title,
            body,
            tag: `permission-${sessionId}`,
            data: {
              url: buildSessionDeepLinkUrl(sessionId),
              sessionId,
              type: 'permission',
            },
          },
          { requireNoSse: true },
        );
      }, PUSH_PERMISSION_DEBOUNCE_MS);

      pushPermissionDebounceTimers.set(sessionId, { timer, requestKey });
    }
  };

  return {
    maybeSendPushForTrigger,
  };
};
