import { sendBridgeMessage } from './api/bridge';
import { opencodeClient } from '@openchamber/ui/lib/opencode/client';
import { processVSCodePermissionAutoAccept } from '@openchamber/ui/sync/vscode-permission-auto-accept';
import type { PermissionRequest } from '@opencode-ai/sdk/v2/client';
import { onCommand } from './api/bridge';

export const registerWebviewNotifications = (): void => {
  const getNotificationClaimKey = (payload: { title?: unknown; body?: unknown; sessionId?: unknown; tag?: unknown } | undefined): string => {
    const tag = typeof payload?.tag === 'string' ? payload.tag.trim() : '';
    if (tag) return tag;
    return [payload?.sessionId, payload?.title, payload?.body]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())
      .join('|');
  };

  const claimOpenChamberNotification = async (payload: { title?: unknown; body?: unknown; sessionId?: unknown; tag?: unknown } | undefined): Promise<boolean> => {
    const key = getNotificationClaimKey(payload);
    if (!key) return true;
    try {
      const result = await sendBridgeMessage<{ claimed?: boolean }>('api:notifications:claim', { key });
      return result?.claimed === true;
    } catch {
      return true;
    }
  };

  const showOpenChamberNotification = (payload: { title?: unknown; body?: unknown; sessionId?: unknown; tag?: unknown; requireHidden?: unknown } | undefined) => {
    if (typeof Notification === 'undefined') {
      return false;
    }

    const show = async () => {
      const isVSCodeWindowFocused = window.__OPENCHAMBER_VSCODE_WINDOW_FOCUSED__ ?? document.hasFocus();
      if (payload?.requireHidden === true && isVSCodeWindowFocused) {
        return false;
      }
      if (Notification.permission !== 'granted') {
        return false;
      }

      const title = typeof payload?.title === 'string' && payload.title.trim().length > 0
        ? payload.title.trim()
        : 'OpenChamber';
      const body = typeof payload?.body === 'string' ? payload.body : '';
      const sessionId = typeof payload?.sessionId === 'string' && payload.sessionId.trim().length > 0
        ? payload.sessionId.trim()
        : '';
      if (!await claimOpenChamberNotification({ ...payload, title, body, sessionId })) {
        return false;
      }

      const notification = new Notification(title, { body });
      notification.onclick = () => {
        if (sessionId) {
          import('@/sync/session-ui-store').then(({ useSessionUIStore }) => {
            useSessionUIStore.getState().setCurrentSession(sessionId);
          });
        }
        window.dispatchEvent(new CustomEvent('openchamber:navigate', { detail: { view: 'chat' } }));
      };
      return true;
    };

    if (Notification.permission === 'default') {
      void Notification.requestPermission().then((permission) => {
        if (permission === 'granted') {
          void show();
        }
      });
      return true;
    }

    void show();
    return true;
  };

  onCommand('showNotification', (payload) => {
    showOpenChamberNotification(payload as { title?: unknown; body?: unknown; sessionId?: unknown; requireHidden?: unknown } | undefined);
  });

  onCommand('windowFocusChanged', (payload) => {
    if (typeof payload === 'object' && payload && typeof (payload as { focused?: unknown }).focused === 'boolean') {
      window.__OPENCHAMBER_VSCODE_WINDOW_FOCUSED__ = (payload as { focused: boolean }).focused;
    }
  });

  const readyNotificationCooldowns = new Map<string, number>();
  const errorNotificationCooldowns = new Map<string, number>();
  const READY_NOTIFICATION_COOLDOWN_MS = 5000;
  const DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH = 250;
  let notificationSettingsSyncPromise: Promise<void> | null = null;

  const getPayloadString = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

  const normalizeNotificationPlainText = (text: string): string => text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^[\t ]*[-*+]\s+/gm, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const truncateNotificationText = (text: string, maxLength: number): string => (
    text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`
  );

  const resolvePositiveNotificationNumber = (value: unknown, fallback: number): number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  );

  const ensureNotificationSettingsSynced = async () => {
    if (!notificationSettingsSyncPromise) {
      notificationSettingsSyncPromise = import('@/lib/persistence')
        .then(({ syncDesktopSettings }) => syncDesktopSettings())
        .catch((error) => {
          notificationSettingsSyncPromise = null;
          console.warn('[OpenChamber] Failed to sync notification settings:', error);
        });
    }
    await notificationSettingsSyncPromise;
  };

  const prepareNotificationLastMessage = (
    message: string,
    settings: { maxLastMessageLength: number },
  ): string => {
    const maxLength = resolvePositiveNotificationNumber(settings.maxLastMessageLength, DEFAULT_NOTIFICATION_MESSAGE_MAX_LENGTH);
    return truncateNotificationText(normalizeNotificationPlainText(message), maxLength);
  };

  const resolveTemplate = (template: string, variables: Record<string, string>): string => (
    template.replace(/\{(\w+)\}/g, (_match, key: string) => variables[key] ?? '')
  );

  const shouldApplyTemplateMessage = (template: string, resolved: string, variables: Record<string, string>) => {
    if (!resolved) return false;
    if (template.includes('{last_message}')) {
      return variables.last_message.trim().length > 0;
    }
    return true;
  };

  const formatNotificationLabel = (raw: string, fallback: string): string => {
    if (!raw) return fallback;
    return raw.split(/[-_\s]+/).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
  };

  const extractNotificationTextFromParts = (parts: unknown): string => {
    if (!Array.isArray(parts)) return '';
    return parts
      .map((part) => {
        if (!part || typeof part !== 'object') return '';
        const entry = part as { type?: unknown; text?: unknown; content?: unknown };
        if (entry.type === 'text') {
          return typeof entry.text === 'string' ? entry.text : typeof entry.content === 'string' ? entry.content : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  };

  const extractNotificationLastMessage = (payload: Record<string, unknown>): string => {
    const properties = (payload.properties ?? payload) as Record<string, unknown>;
    const info = properties.info as Record<string, unknown> | undefined;
    if (!info) return '';
    return extractNotificationTextFromParts(info.parts ?? properties.parts) || extractNotificationTextFromParts(info.content);
  };

  const fetchLastAssistantMessageText = async (sessionId: string, messageId?: string): Promise<string> => {
    if (!sessionId) return '';

    try {
      const messages = await opencodeClient.getSessionMessages(sessionId, 5);
      if (!Array.isArray(messages)) return '';

      let target = messageId
        ? messages.find((message) => {
            const info = message && typeof message === 'object'
              ? (message as { info?: { id?: unknown; role?: unknown } }).info
              : undefined;
            return info?.id === messageId && info?.role === 'assistant';
          })
        : null;

      if (!target) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          const info = message && typeof message === 'object'
            ? (message as { info?: { role?: unknown; finish?: unknown } }).info
            : undefined;
          if (info?.role === 'assistant' && info?.finish === 'stop') {
            target = message;
            break;
          }
        }
      }

      if (!target || typeof target !== 'object') return '';
      const message = target as { parts?: unknown; content?: unknown; info?: { parts?: unknown; content?: unknown } };
      return extractNotificationTextFromParts(message.parts ?? message.info?.parts)
        || extractNotificationTextFromParts(message.content ?? message.info?.content);
    } catch {
      return '';
    }
  };

  const getNotificationTemplate = (
    settings: { notificationTemplates?: Record<string, { title?: string; message?: string }> },
    key: 'completion' | 'subtask' | 'error' | 'question',
    fallback: { title: string; message: string },
  ) => {
    const candidate = settings.notificationTemplates?.[key];
    return {
      title: typeof candidate?.title === 'string' ? candidate.title : fallback.title,
      message: typeof candidate?.message === 'string' ? candidate.message : fallback.message,
    };
  };

  const buildNotificationVariables = (payload: Record<string, unknown>, sessionId: string, lastMessage: string): Record<string, string> => {
    const properties = (payload.properties ?? payload) as Record<string, unknown>;
    const info = properties.info as Record<string, unknown> | undefined;
    const pathInfo = info?.path as { root?: unknown; cwd?: unknown } | undefined;
    const worktree = getPayloadString(pathInfo?.root ?? pathInfo?.cwd);
    const modelId = getPayloadString(info?.modelID ?? info?.modelId ?? (info?.model as { modelID?: unknown } | undefined)?.modelID);
    return {
      project_name: worktree.split(/[\\/]/).filter(Boolean).pop() || '',
      worktree,
      branch: '',
      session_name: getPayloadString(properties.sessionTitle ?? (properties.session as { title?: unknown } | undefined)?.title ?? info?.sessionTitle),
      agent_name: formatNotificationLabel(getPayloadString(info?.agent ?? info?.mode), 'Agent'),
      model_name: formatNotificationLabel(modelId, 'Assistant'),
      last_message: lastMessage,
      session_id: sessionId,
    };
  };

  const getNotificationSessionId = (payload: Record<string, unknown>): string => {
    const properties = (payload.properties ?? payload) as Record<string, unknown>;
    const info = properties.info as Record<string, unknown> | undefined;
    return getPayloadString(info?.sessionID ?? info?.sessionId ?? properties.sessionID ?? properties.sessionId ?? properties.session);
  };

  const getNotificationDirectory = (payload: Record<string, unknown>): string | null => {
    const properties = (payload.properties ?? payload) as Record<string, unknown>;
    const info = properties.info as Record<string, unknown> | undefined;
    return getPayloadString(properties.directory ?? info?.directory) || null;
  };

  window.addEventListener('openchamber:vscode-notification-event', (event) => {
    const detail = (event as CustomEvent<{ directory?: string; payload?: unknown }>).detail;
    const payload = detail?.payload;
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const record = payload as Record<string, unknown>;
    const type = getPayloadString(record.type);
    const properties = (record.properties ?? record) as Record<string, unknown>;
    const info = properties.info as Record<string, unknown> | undefined;
    const sessionId = getNotificationSessionId(record);
    if (!sessionId) {
      return;
    }

    Promise.all([
      import('@/stores/useUIStore'),
    ]).then(async ([{ useUIStore }]) => {
      await ensureNotificationSettingsSynced();
      const settings = useUIStore.getState();
      if (!settings.nativeNotificationsEnabled) {
        return;
      }
      const requireHidden = settings.notificationMode !== 'always';
      const messageId = getPayloadString(info?.id);
      const error = properties.error;
      const errorMessage = getPayloadString(
        typeof error === 'object' && error
          ? (error as { message?: unknown }).message
          : error,
      );
      const rawLastMessage = extractNotificationLastMessage(record)
        || errorMessage
        || await fetchLastAssistantMessageText(sessionId, messageId);
      const lastMessage = prepareNotificationLastMessage(
        rawLastMessage,
        settings,
      );
      const variables = buildNotificationVariables(record, sessionId, lastMessage);

      const isAssistantMessage = type === 'message.updated' && getPayloadString(info?.role) === 'assistant';
      const finish = isAssistantMessage ? getPayloadString(info?.finish) : '';
      const isCompletion = type === 'session.idle' || finish === 'stop';
      const isError = type === 'session.error' || finish === 'error';

      if (isCompletion) {
        const session = await opencodeClient.getSession(sessionId, getNotificationDirectory(record)).catch(() => undefined);
        if (!session) return;
        const isSubtask = Boolean(session?.parentID);
        if (isSubtask ? !settings.notifyOnSubtasks : !settings.notifyOnCompletion) return;
        const now = Date.now();
        const lastAt = readyNotificationCooldowns.get(sessionId) ?? 0;
        if (now - lastAt < READY_NOTIFICATION_COOLDOWN_MS) return;
        readyNotificationCooldowns.set(sessionId, now);
        const template = getNotificationTemplate(settings, isSubtask ? 'subtask' : 'completion', { title: '{agent_name} is ready', message: '{model_name} completed the task' });
        const title = resolveTemplate(template.title, variables) || 'Agent is ready';
        const body = resolveTemplate(template.message, variables);
        showOpenChamberNotification({
          title,
          body: shouldApplyTemplateMessage(template.message, body, variables) ? body : `${variables.model_name} completed the task`,
          sessionId,
          requireHidden,
        });
        return;
      }

      if (isError) {
        if (!settings.notifyOnError) return;
        const now = Date.now();
        const lastAt = errorNotificationCooldowns.get(sessionId) ?? 0;
        if (now - lastAt < READY_NOTIFICATION_COOLDOWN_MS) return;
        errorNotificationCooldowns.set(sessionId, now);
        const template = getNotificationTemplate(settings, 'error', { title: 'Tool error', message: '{last_message}' });
        const title = resolveTemplate(template.title, variables) || 'Tool error';
        const body = resolveTemplate(template.message, variables);
        showOpenChamberNotification({
          title,
          body: shouldApplyTemplateMessage(template.message, body, variables) ? body : 'An error occurred',
          sessionId,
          requireHidden,
        });
        return;
      }

      if (type === 'question.asked') {
        if (!settings.notifyOnQuestion) return;
        const questions = Array.isArray(properties.questions) ? properties.questions : [];
        const firstQuestion = questions[0] as Record<string, unknown> | undefined;
        const header = getPayloadString(firstQuestion?.header);
        const questionText = getPayloadString(firstQuestion?.question);
        const questionVariables = { ...variables, last_message: questionText || header };
        const template = getNotificationTemplate(settings, 'question', { title: 'Input needed', message: '{last_message}' });
        const title = resolveTemplate(template.title, questionVariables) || (/plan\s*mode/i.test(header) ? 'Switch to plan mode' : /build\s*agent/i.test(header) ? 'Switch to build mode' : header || 'Input needed');
        const body = resolveTemplate(template.message, questionVariables);
        showOpenChamberNotification({
          title,
          body: shouldApplyTemplateMessage(template.message, body, questionVariables) ? body : questionText || 'Agent is waiting for your response',
          sessionId,
          requireHidden,
        });
        return;
      }

      if (type === 'permission.asked') {
        if (!settings.notifyOnQuestion) return;
        const requestId = getPayloadString(properties.id);
        if (requestId) {
          const accepted = await processVSCodePermissionAutoAccept(
            properties as unknown as PermissionRequest,
            detail?.directory,
          );
          if (accepted) return;
        }
        const permission = getPayloadString(properties.permission);
        const sessionTitle = getPayloadString(properties.sessionTitle);
        const fallbackMessage = sessionTitle || permission || 'Agent is waiting for your approval';
        const permissionVariables = { ...variables, last_message: fallbackMessage };
        const template = getNotificationTemplate(settings, 'question', { title: 'Permission required', message: '{last_message}' });
        const title = resolveTemplate(template.title, permissionVariables) || 'Permission required';
        const body = resolveTemplate(template.message, permissionVariables);
        showOpenChamberNotification({
          title,
          body: shouldApplyTemplateMessage(template.message, body, permissionVariables) ? body : fallbackMessage,
          sessionId,
          requireHidden,
        });
      }
    });
  });
};
