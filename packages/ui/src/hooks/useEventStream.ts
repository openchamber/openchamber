import React from 'react';
import { opencodeClient, type RoutedOpencodeEvent } from '@/lib/opencode/client';
import { saveSessionCursor } from '@/lib/messageCursorPersistence';
import { useSessionStore } from '@/stores/useSessionStore';
import { useMessageStore } from '@/stores/messageStore';
import { getMessageLimit, STUCK_SESSION_TIMEOUT_MS } from '@/stores/types/sessionTypes';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore, type EventStreamStatus } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import type { Part, Session, Message } from '@opencode-ai/sdk/v2';
import type { PermissionRequest } from '@/types/permission';
import type { QuestionRequest } from '@/types/question';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { handleTodoUpdatedEvent } from '@/stores/useTodoStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useContextStore } from '@/stores/contextStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { triggerSessionStatusPoll } from '@/hooks/useServerSessionStatus';
import { PermissionToastActions } from '@/components/chat/PermissionToastActions';

interface EventData {
  type: string;
  properties?: Record<string, unknown>;
}

const readStringProp = (obj: unknown, keys: string[]): string | null => {
  if (!obj || typeof obj !== 'object') return null;
  const record = obj as Record<string, unknown>;
  for (let i = 0; i < keys.length; i++) {
    const value = record[keys[i]];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
};

const readStringArrayProp = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

const normalizePermissionRequest = (value: unknown): PermissionRequest | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const id = readStringProp(record, ['id']);
  const sessionID = readStringProp(record, ['sessionID']);
  if (!id || !sessionID) {
    return null;
  }

  const permission = typeof record.permission === 'string' ? record.permission : '';
  const patterns = readStringArrayProp(record.patterns);
  const metadata = typeof record.metadata === 'object' && record.metadata !== null
    ? record.metadata as Record<string, unknown>
    : {};
  const always = readStringArrayProp(record.always);

  const toolValue = record.tool;
  const tool = (toolValue && typeof toolValue === 'object')
    ? {
        messageID: readStringProp(toolValue, ['messageID']) ?? '',
        callID: readStringProp(toolValue, ['callID']) ?? '',
      }
    : undefined;

  return {
    id,
    sessionID,
    permission,
    patterns,
    metadata,
    always,
    tool: tool && tool.messageID.length > 0 && tool.callID.length > 0 ? tool : undefined,
  };
};

const readPermissionMetadataPreview = (metadata: Record<string, unknown>): string => {
  const preferredKeys = [
    'command',
    'cmd',
    'script',
    'path',
    'filePath',
    'filepath',
    'file_path',
    'directory',
    'working_directory',
    'cwd',
    'url',
    'uri',
    'endpoint',
    'description',
    'action',
    'operation',
  ];

  for (let i = 0; i < preferredKeys.length; i++) {
    const value = metadata[preferredKeys[i]];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
      continue;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }

    if (Array.isArray(value)) {
      const joined = value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .slice(0, 3)
        .join(', ')
        .trim();
      if (joined.length > 0) {
        return joined;
      }
    }
  }

  const metadataEntries = Object.entries(metadata);
  if (metadataEntries.length === 0) {
    return '';
  }

  try {
    return JSON.stringify(metadata);
  } catch {
    return '';
  }
};

const buildPermissionToastBody = (request: PermissionRequest): string => {
  const patterns = Array.isArray(request.patterns) ? request.patterns : [];
  const patternSummary = patterns
    .filter((pattern): pattern is string => typeof pattern === 'string' && pattern.trim().length > 0)
    .join(', ')
    .trim();

  const metadata = typeof request.metadata === 'object' && request.metadata !== null ? request.metadata : {};
  const metadataSummary = readPermissionMetadataPreview(metadata);

  if (patternSummary.length > 0 && metadataSummary.length > 0) {
    return `${patternSummary} | ${metadataSummary}`;
  }

  if (patternSummary.length > 0) {
    return patternSummary;
  }

  if (metadataSummary.length > 0) {
    return metadataSummary;
  }

  const fallback = typeof request.permission === 'string' ? request.permission.trim() : '';
  return fallback.length > 0 ? fallback : 'Permission details unavailable';
};

type MessageTracker = (messageId: string, event?: string, extraData?: Record<string, unknown>) => void;

declare global {
  interface Window {
    __messageTracker?: MessageTracker;
  }
}

const TEXT_SHRINK_TOLERANCE = 50;
const RESYNC_DEBOUNCE_MS = 750;
const QUESTION_RECONCILE_COOLDOWN_MS = 1500;
const PERMISSION_RECONCILE_COOLDOWN_MS = 1500;

const textLengthCache = new WeakMap<Part[], number>();
const computeTextLength = (parts: Part[] | undefined | null): number => {
  if (!parts || !Array.isArray(parts)) return 0;

  const cached = textLengthCache.get(parts);
  if (cached !== undefined) return cached;

  let length = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part?.type === 'text') {
      const text = (part as { text?: string; content?: string }).text ?? (part as { text?: string; content?: string }).content;
      if (typeof text === 'string') length += text.length;
    }
  }

  textLengthCache.set(parts, length);
  return length;
};

const MIN_SORTABLE_LENGTH = 10;
const extractSortableId = (id: unknown): string | null => {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  const underscoreIndex = trimmed.indexOf('_');
  const candidate = underscoreIndex >= 0 ? trimmed.slice(underscoreIndex + 1) : trimmed;
  if (!candidate || candidate.length < MIN_SORTABLE_LENGTH) return null;
  return candidate;
};

const isIdNewer = (id: string, referenceId: string): boolean => {
  const currentSortable = extractSortableId(id);
  const referenceSortable = extractSortableId(referenceId);
  if (!currentSortable || !referenceSortable) return true;
  if (currentSortable.length !== referenceSortable.length) return true;
  return currentSortable > referenceSortable;
};

const MAX_MESSAGE_CACHE_SIZE = 500;
const MESSAGE_CACHE_EVICT_COUNT = 100;
const messageCache = new Map<string, { sessionId: string; message: { info: Message; parts: Part[] } | null }>();
const getMessageFromStore = (sessionId: string, messageId: string): { info: Message; parts: Part[] } | null => {
  const cacheKey = `${sessionId}:${messageId}`;
  const cached = messageCache.get(cacheKey);
  if (cached && cached.sessionId === sessionId) {
    return cached.message;
  }

  const storeState = useSessionStore.getState();
  const sessionMessages = storeState.messages.get(sessionId) || [];
  const message = sessionMessages.find(m => m.info.id === messageId) || null;

  if (messageCache.size >= MAX_MESSAGE_CACHE_SIZE) {
    // Evict oldest entries (Map preserves insertion order)
    let count = 0;
    for (const key of messageCache.keys()) {
      if (count++ >= MESSAGE_CACHE_EVICT_COUNT) break;
      messageCache.delete(key);
    }
  }

  messageCache.set(cacheKey, { sessionId, message });
  return message;
};

export const useEventStream = () => {
  const {
    addStreamingPart,
    completeStreamingMessage,
    updateMessageInfo,
    updateSessionCompaction,
    addPermission,
    dismissPermission,
    addQuestion,
    dismissQuestion,
    currentSessionId,
    applySessionMetadata,
    getWorktreeMetadata,
    loadMessages,
    loadSessions,
    updateSession,
    removeSessionFromStore
  } = useSessionStore();

  const { checkConnection } = useConfigStore();
  const fallbackDirectory = useDirectoryStore((state) => state.currentDirectory);

  const activeSessionDirectory = React.useMemo(() => {
    if (!currentSessionId) return undefined;

    try {
      const metadata = getWorktreeMetadata?.(currentSessionId);
      if (metadata?.path) return metadata.path;
    } catch (error) {
      console.warn('Failed to inspect worktree metadata for session directory:', error);
    }

    // Use getState() to avoid sessions dependency which causes cascading updates
    const currentSessions = useSessionStore.getState().sessions;
    const sessionRecord = currentSessions.find((entry) => entry.id === currentSessionId);
    if (sessionRecord && typeof sessionRecord.directory === 'string' && sessionRecord.directory.trim().length > 0) {
      return sessionRecord.directory.trim();
    }

    return undefined;
  }, [currentSessionId, getWorktreeMetadata]);

  const effectiveDirectory = React.useMemo(() => {
    if (activeSessionDirectory && activeSessionDirectory.length > 0) {
      return activeSessionDirectory;
    }
    if (typeof fallbackDirectory === 'string' && fallbackDirectory.trim().length > 0) {
      return fallbackDirectory.trim();
    }
    return undefined;
  }, [activeSessionDirectory, fallbackDirectory]);

  const bootstrapPendingQuestions = React.useCallback(async () => {
    try {
      const projects = useProjectsStore.getState().projects;
      const projectDirs = projects.map((project) => project.path);
      // Use getState() to avoid sessions dependency which causes cascading updates
      const currentSessions = useSessionStore.getState().sessions;
      const sessionDirs = currentSessions.map((session) => (session as { directory?: string | null }).directory);

      const directories = [effectiveDirectory, ...projectDirs, ...sessionDirs];
      const pending = await opencodeClient.listPendingQuestions({ directories });
      if (pending.length === 0) {
        return;
      }

      for (const request of pending) {
        addQuestion(request as unknown as QuestionRequest);
      }
    } catch {
      // ignored
    }
  }, [addQuestion, effectiveDirectory]);

  const lastQuestionRefreshAtRef = React.useRef(0);
  const requestPendingQuestionsRefresh = React.useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastQuestionRefreshAtRef.current < QUESTION_RECONCILE_COOLDOWN_MS) {
      return;
    }
    lastQuestionRefreshAtRef.current = now;
    void bootstrapPendingQuestions();
  }, [bootstrapPendingQuestions]);

  const bootstrapPendingPermissions = React.useCallback(async () => {
    try {
      const projects = useProjectsStore.getState().projects;
      const projectDirs = projects.map((project) => project.path);
      // Use getState() to avoid sessions dependency which causes cascading updates
      const currentSessions = useSessionStore.getState().sessions;
      const sessionDirs = currentSessions.map((session) => (session as { directory?: string | null }).directory);

      const directories = [effectiveDirectory, ...projectDirs, ...sessionDirs];
      const pending = await opencodeClient.listPendingPermissions({ directories });
      if (pending.length === 0) {
        return;
      }

      for (const request of pending) {
        const normalizedRequest = normalizePermissionRequest(request);
        if (!normalizedRequest) {
          continue;
        }
        addPermission(normalizedRequest);
      }
    } catch {
      // ignored
    }
  }, [addPermission, effectiveDirectory]);

  const lastPermissionRefreshAtRef = React.useRef(0);
  const requestPendingPermissionsRefresh = React.useCallback((force = false) => {
    const now = Date.now();
    if (!force && now - lastPermissionRefreshAtRef.current < PERMISSION_RECONCILE_COOLDOWN_MS) {
      return;
    }
    lastPermissionRefreshAtRef.current = now;
    void bootstrapPendingPermissions();
  }, [bootstrapPendingPermissions]);

  const requestPendingPermissionsRefreshRef = React.useRef(requestPendingPermissionsRefresh);
  React.useEffect(() => {
    requestPendingPermissionsRefreshRef.current = requestPendingPermissionsRefresh;
  }, [requestPendingPermissionsRefresh]);

  React.useEffect(() => {
    requestPendingPermissionsRefresh(true);
    requestPendingQuestionsRefresh(true);
  }, [requestPendingPermissionsRefresh, requestPendingQuestionsRefresh]);

  const normalizeDirectory = React.useCallback((value: string | null | undefined): string | null => {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    const normalized = trimmed.replace(/\\/g, '/');
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
  }, []);

  const resolveSessionDirectoryForStatus = React.useCallback(
    (sessionId: string | null | undefined): string | null => {
      if (!sessionId) return null;
      try {
        const metadata = getWorktreeMetadata?.(sessionId);
        const metaPath = normalizeDirectory(metadata?.path ?? null);
        if (metaPath) return metaPath;
      } catch {
        // ignored
      }

      // Use getState() to avoid sessions dependency which causes cascading updates
      const currentSessions = useSessionStore.getState().sessions;
      const record = currentSessions.find((entry) => entry.id === sessionId);
      return normalizeDirectory((record as { directory?: string | null })?.directory ?? null);
    },
    [getWorktreeMetadata, normalizeDirectory]
  );

  const setEventStreamStatus = useUIStore((state) => state.setEventStreamStatus);
  const lastStatusRef = React.useRef<{ status: EventStreamStatus; hint: string | null } | null>(null);

  const publishStatus = React.useCallback(
    (status: EventStreamStatus, hint?: string | null) => {
      const normalizedHint = hint ?? null;
      const last = lastStatusRef.current;
      if (last && last.status === status && last.hint === normalizedHint) {
        return;
      }

      lastStatusRef.current = { status, hint: normalizedHint };

      if (streamDebugEnabled()) {
        const prefixMap: Record<EventStreamStatus, string> = {
          idle: '[IDLE]',
          connecting: '[CONNECT]',
          connected: '[CONNECTED]',
          reconnecting: '[RECONNECT]',
          paused: '[PAUSED]',
          offline: '[OFFLINE]',
          error: '[ERROR]'
        };

        const prefix = prefixMap[status] ?? '[INFO]';
        const message = normalizedHint ? `${prefix} SSE ${status}: ${normalizedHint}` : `${prefix} SSE ${status}`;
        console.info(message);
      }

      setEventStreamStatus(status, normalizedHint);
    },
    [setEventStreamStatus]
  );

  const resyncMessages = React.useCallback(
    (sessionId: string, reason: string, limit?: number) => {
      if (!sessionId) {
        return Promise.resolve();
      }
      const now = Date.now();
      if (resyncInFlightRef.current) {
        return resyncInFlightRef.current;
      }
      if (now - lastResyncAtRef.current < RESYNC_DEBOUNCE_MS) {
        return Promise.resolve();
      }
      const task = loadMessages(sessionId, limit)
        .catch((error) => {
          console.warn(`[useEventStream] Failed to resync messages (${reason}):`, error);
        })
        .finally(() => {
          resyncInFlightRef.current = null;
          lastResyncAtRef.current = Date.now();
        });
      resyncInFlightRef.current = task;
      return task;
    },
    [loadMessages]
  );

  const bootstrapState = React.useCallback(
    async (reason: string) => {
      if (streamDebugEnabled()) {
        console.info('[useEventStream] Bootstrapping state:', reason);
      }
      try {
        const activeLimit = getMessageLimit();
        await Promise.all([
          loadSessions(),
          currentSessionId ? resyncMessages(currentSessionId, reason, activeLimit) : Promise.resolve(),
        ]);
      } catch (error) {
        console.warn('[useEventStream] Bootstrap failed:', reason, error);
      }
    },
    [currentSessionId, loadSessions, resyncMessages]
  );

  const scheduleSoftResync = React.useCallback(
    (sessionId: string, reason: string, limit = getMessageLimit()): Promise<void> => {
      if (!sessionId) return Promise.resolve();

      const memory = useSessionStore.getState().sessionMemoryState.get(sessionId);
      const cooldownUntil = memory?.streamingCooldownUntil;
      const now = Date.now();
      if (typeof cooldownUntil === 'number' && cooldownUntil > now) {
        const delay = Math.min(3000, Math.max(0, cooldownUntil - now));
        return new Promise((resolve) => {
          setTimeout(() => {
            resyncMessages(sessionId, reason, limit).finally(resolve);
          }, delay);
        });
      }

      return resyncMessages(sessionId, reason, limit);
    },
    [resyncMessages]
  );

  React.useEffect(() => {
    scheduleSoftResyncRef.current = scheduleSoftResync;
  }, [scheduleSoftResync]);

  const trackMessage = React.useCallback((messageId: string, event?: string, extraData?: Record<string, unknown>) => {
    if (streamDebugEnabled()) {
      console.debug(`[MessageTracker] ${messageId}: ${event}`, extraData);
    }
  }, []);

  const reportMessage = React.useCallback((messageId: string) => {
    if (streamDebugEnabled()) {
      console.debug(`[MessageTracker] ${messageId}: reported`);
    }
  }, []);

  const unsubscribeRef = React.useRef<(() => void) | null>(null);
  const reconnectTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = React.useRef(0);
  const missingMessageHydrationRef = React.useRef<Set<string>>(new Set());
  const metadataRefreshTimestampsRef = React.useRef<Map<string, number>>(new Map());
  const sessionRefreshTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const isCleaningUpRef = React.useRef(false);
  const resyncInFlightRef = React.useRef<Promise<void> | null>(null);
  const lastResyncAtRef = React.useRef(0);
  const permissionToastShownRef = React.useRef<Set<string>>(new Set());
  const questionToastShownRef = React.useRef<Set<string>>(new Set());
  const notifiedMessagesRef = React.useRef<Set<string>>(new Set());
  const notifiedQuestionsRef = React.useRef<Set<string>>(new Set());
  const serverNotificationEventSeenRef = React.useRef(false);
  const modeSwitchToastShownRef = React.useRef<Set<string>>(new Set());
  const lastUserAgentSelectionRef = React.useRef<Map<string, { created: number; messageId: string }>>(new Map());

  const resolveVisibilityState = React.useCallback((): 'visible' | 'hidden' => {
    if (typeof document === 'undefined') return 'visible';

    const state = document.visibilityState;
    return state === 'hidden' && document.hasFocus() ? 'visible' : state;
  }, []);

  const visibilityStateRef = React.useRef<'visible' | 'hidden'>(resolveVisibilityState());
  const onlineStatusRef = React.useRef<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);
  const pendingResumeRef = React.useRef(false);
  const pauseTimeoutRef = React.useRef<NodeJS.Timeout | null>(null);
  const staleCheckIntervalRef = React.useRef<NodeJS.Timeout | null>(null);
  const lastEventTimestampRef = React.useRef<number>(Date.now());
  const lastMessageEventBySessionRef = React.useRef<Map<string, number>>(new Map());
  const pendingMessageStallTimersRef = React.useRef<Map<string, NodeJS.Timeout>>(new Map());
  const lastMessageStallRecoveryBySessionRef = React.useRef<Map<string, number>>(new Map());

  const scheduleSoftResyncRef = React.useRef<
    (sessionId: string, reason: string, limit?: number) => Promise<void>
  >(() => Promise.resolve());
  const scheduleReconnectRef = React.useRef<(hint?: string) => void>(() => {});

  const isNotificationContextHidden = React.useCallback((isVSCodeRuntime: boolean): boolean => {
    if (visibilityStateRef.current === 'hidden') {
      return true;
    }
    if (isVSCodeRuntime && typeof document !== 'undefined') {
      return !document.hasFocus();
    }
    return false;
  }, []);

  const dispatchRuntimeNotification = React.useCallback((payload: {
    title: string;
    body?: string;
    tag?: string;
    requireHidden?: boolean;
  }) => {
    const runtimeAPIs = getRegisteredRuntimeAPIs();
    if (!runtimeAPIs?.notifications) {
      return;
    }

    const title = typeof payload.title === 'string' ? payload.title.trim() : '';
    if (!title) {
      return;
    }

    const settings = useUIStore.getState();
    if (!settings.nativeNotificationsEnabled) {
      return;
    }

    const isVSCodeRuntime = Boolean(runtimeAPIs.runtime?.isVSCode);
    const shouldRequireHidden = Boolean(payload.requireHidden) || settings.notificationMode === 'hidden-only';
    if (shouldRequireHidden && !isNotificationContextHidden(isVSCodeRuntime)) {
      return;
    }

    void runtimeAPIs.notifications.notifyAgentCompletion({
      title,
      body: typeof payload.body === 'string' ? payload.body : '',
      tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    });
  }, [isNotificationContextHidden]);

  const maybeBootstrapIfStale = React.useCallback(
    (reason: string) => {
      const now = Date.now();
      if (now - lastEventTimestampRef.current > 25000) {
        void bootstrapState(reason);
        lastEventTimestampRef.current = now;
      }
    },
    [bootstrapState]
  );


  const currentSessionIdRef = React.useRef<string | null>(currentSessionId);
  const previousSessionIdRef = React.useRef<string | null>(null);
  const previousSessionDirectoryRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const requestSessionMetadataRefresh = React.useCallback(
    (sessionId: string | undefined | null, directoryOverride?: string | null) => {
      if (!sessionId) return;

      const now = Date.now();
      const timestamps = metadataRefreshTimestampsRef.current;
      const lastRefresh = timestamps.get(sessionId);

      if (lastRefresh && now - lastRefresh < 3000) return;

      timestamps.set(sessionId, now);

      const resolveDirectoryForSession = (id: string): string | null => {
        if (typeof directoryOverride === 'string' && directoryOverride.trim().length > 0) {
          return directoryOverride.trim();
        }

        try {
          const metadata = getWorktreeMetadata?.(id);
          if (metadata?.path) {
            return metadata.path;
          }
        } catch {
          // ignored
        }

        // Use getState() to avoid sessions dependency which causes cascading updates
        const currentSessions = useSessionStore.getState().sessions;
        const sessionRecord = currentSessions.find((entry) => entry.id === id) as Session & { directory?: string | null };
        if (sessionRecord && typeof sessionRecord.directory === 'string' && sessionRecord.directory.trim().length > 0) {
          return sessionRecord.directory.trim();
        }

        return null;
      };

      setTimeout(async () => {
        try {
          const directory = resolveDirectoryForSession(sessionId);
          const session = directory
            ? await opencodeClient.withDirectory(directory, () => opencodeClient.getSession(sessionId))
            : await opencodeClient.getSession(sessionId);

          if (session) {
            const patch: Partial<Session> = {};
            if (typeof session.title === 'string' && session.title.length > 0) {
              patch.title = session.title;
            }
            if (session.summary !== undefined) {
              patch.summary = session.summary;
            }
            if (Object.keys(patch).length > 0) {
              applySessionMetadata(sessionId, patch);
            }
          }
        } catch (error) {
          console.warn('Failed to refresh session metadata:', error);
        }
      }, 100);
    },
    [applySessionMetadata, getWorktreeMetadata]
  );

  type SessionStatusPayload = {
    type: 'idle' | 'busy' | 'retry';
    attempt?: number;
    message?: string;
    next?: number;
  };

  const updateSessionStatus = React.useCallback((
    sessionId: string,
    status: SessionStatusPayload,
    source: string = 'unknown'
  ) => {
    if (!sessionId) return;

    const storeStatus = useSessionStore.getState().sessionStatus?.get(sessionId);
    const prevType = storeStatus?.type ?? 'idle';
    const nextType = status?.type ?? 'idle';

    // Note: needs_attention logic is now handled by the server
    // Server maintains authoritative state based on view tracking and message events

    if (process.env.NODE_ENV === 'development' && prevType !== nextType) {
      try {
        console.info('[SESSION-STATUS]', {
          sessionId,
          from: prevType,
          to: nextType,
          source,
          ...(nextType === 'retry'
            ? {
              attempt: status.attempt,
              next: status.next,
              message: status.message,
            }
            : {}),
        });
      } catch {
        // ignore
      }
    }

    const shouldArmMessageStallCheck = prevType === 'idle' && (nextType === 'busy' || nextType === 'retry');
    const shouldDisarmMessageStallCheck = nextType === 'idle';

    if (shouldDisarmMessageStallCheck) {
      const pending = pendingMessageStallTimersRef.current.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        pendingMessageStallTimersRef.current.delete(sessionId);
      }
    }

    if (shouldArmMessageStallCheck) {
      const pending = pendingMessageStallTimersRef.current.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        pendingMessageStallTimersRef.current.delete(sessionId);
      }

      const startAt = Date.now();
      const timer = setTimeout(() => {
        const current = useSessionStore.getState().sessionStatus?.get(sessionId);
        if (current?.type !== 'busy' && current?.type !== 'retry') {
          return;
        }

        const lastRecoveryAt = lastMessageStallRecoveryBySessionRef.current.get(sessionId) ?? 0;
        if (Date.now() - lastRecoveryAt < 15000) {
          return;
        }

        const lastMsgAt = lastMessageEventBySessionRef.current.get(sessionId) ?? 0;
        if (lastMsgAt >= startAt) {
          return;
        }

        lastMessageStallRecoveryBySessionRef.current.set(sessionId, Date.now());
        void scheduleSoftResyncRef.current(sessionId, 'status_busy_no_message', getMessageLimit())
          .finally(() => {
            scheduleReconnectRef.current('No message events after busy status');
          });
      }, 2000);

      pendingMessageStallTimersRef.current.set(sessionId, timer);
    }

    const next = new Map(useSessionStore.getState().sessionStatus ?? new Map());
    if (nextType === 'idle') {
      next.set(sessionId, { ...status, confirmedAt: Date.now() });
    } else {
      const existing = next.get(sessionId);
      if (existing?.confirmedAt) {
        next.set(sessionId, { ...status, confirmedAt: existing.confirmedAt });
      } else {
        next.set(sessionId, status);
      }
    }
    useSessionStore.setState({ sessionStatus: next });
  }, []);

  React.useEffect(() => {
    const nextSessionId = currentSessionId ?? null;
    const prevSessionId = previousSessionIdRef.current;
    const nextDirectory = resolveSessionDirectoryForStatus(nextSessionId);
    const prevDirectory = previousSessionDirectoryRef.current;

    if (prevSessionId && nextSessionId && prevSessionId !== nextSessionId) {
      // Clear the message cache on session switch to free memory
      messageCache.clear();

      if (prevDirectory && nextDirectory && prevDirectory !== nextDirectory) {
        // Removed: void refreshSessionStatus();
      }
    }

    previousSessionIdRef.current = nextSessionId;
    previousSessionDirectoryRef.current = nextDirectory;
  }, [currentSessionId,  resolveSessionDirectoryForStatus]);

  const handleEvent = React.useCallback((event: EventData) => {
    lastEventTimestampRef.current = Date.now();

    if (streamDebugEnabled()) {
      console.debug('[useEventStream] Received event:', event.type, event.properties);
    }

    if (!event.properties) return;

    const props = event.properties as Record<string, unknown>;
    const nonMetadataSessionEvents = new Set(['session.abort', 'session.error']);

    if (!nonMetadataSessionEvents.has(event.type)) {
      const sessionPayload = (typeof props.session === 'object' && props.session !== null ? props.session : null) ||
                           (typeof props.sessionInfo === 'object' && props.sessionInfo !== null ? props.sessionInfo : null) as Record<string, unknown> | null;

      if (sessionPayload) {
        const sessionPayloadAny = sessionPayload as Record<string, unknown>;
        const sessionId = (typeof sessionPayloadAny.id === 'string' && sessionPayloadAny.id.length > 0) ? sessionPayloadAny.id :
                         (typeof sessionPayloadAny.sessionID === 'string' && sessionPayloadAny.sessionID.length > 0) ? sessionPayloadAny.sessionID :
                         (typeof props.sessionID === 'string' && props.sessionID.length > 0) ? props.sessionID :
                         (typeof props.id === 'string' && props.id.length > 0) ? props.id : undefined;

        if (sessionId) {
          const titleCandidate = typeof sessionPayloadAny.title === 'string' ? sessionPayloadAny.title :
                                typeof props.title === 'string' ? props.title : undefined;

          const summaryCandidate = (typeof sessionPayloadAny.summary === 'object' && sessionPayloadAny.summary !== null) ? sessionPayloadAny.summary as Session['summary'] :
                                  (typeof props.summary === 'object' && props.summary !== null) ? props.summary as Session['summary'] : undefined;

          if (titleCandidate !== undefined || summaryCandidate !== undefined) {
            const patch: Partial<Session> = {};
            if (titleCandidate !== undefined) patch.title = titleCandidate;
            if (summaryCandidate !== undefined) patch.summary = summaryCandidate;
            applySessionMetadata(sessionId, patch);
          }
        }
      }
    }

    switch (event.type) {
      case 'server.connected':
        checkConnection();
        break;
      case 'global.disposed':
      case 'server.instance.disposed': {
        void bootstrapState('server_disposed_event');
        break;
      }

      case 'mcp.tools.changed': {
        const directory = typeof props.directory === 'string' ? props.directory : effectiveDirectory;
        void useMcpStore.getState().refresh({ directory: directory ?? null, silent: true });
        break;
      }

      case 'session.status':
        {
          const sessionId = readStringProp(props, ['sessionID', 'sessionId']);
          const statusRaw = (props as { status?: unknown }).status;
          const statusObj = (typeof statusRaw === 'object' && statusRaw !== null) ? statusRaw as Record<string, unknown> : null;
          const statusType =
            typeof statusRaw === 'string'
              ? statusRaw
              : typeof statusObj?.type === 'string'
                ? statusObj.type
                : typeof statusObj?.status === 'string'
                  ? statusObj.status
                  : typeof (props as { type?: unknown }).type === 'string'
                    ? ((props as { type: string }).type)
                    : typeof (props as { phase?: unknown }).phase === 'string'
                      ? ((props as { phase: string }).phase)
                      : typeof (props as { state?: unknown }).state === 'string'
                        ? ((props as { state: string }).state)
                        : null;
          const statusInfo = statusObj ?? ({} as Record<string, unknown>);
          const metadata = (props as { metadata?: unknown }).metadata;
          const metadataObj = (typeof metadata === 'object' && metadata !== null) ? metadata as Record<string, unknown> : null;

          if (sessionId && statusType) {
            if (statusType === 'busy') {
             updateSessionStatus(sessionId, { type: 'busy' }, 'sse:session.status');
            } else if (statusType === 'retry') {
              updateSessionStatus(sessionId, {
                type: 'retry',
                attempt:
                  typeof statusInfo.attempt === 'number'
                    ? statusInfo.attempt
                    : typeof (props as { attempt?: unknown }).attempt === 'number'
                      ? (props as { attempt: number }).attempt
                      : typeof metadataObj?.attempt === 'number'
                        ? metadataObj.attempt
                      : undefined,
                message:
                  typeof statusInfo.message === 'string'
                    ? statusInfo.message
                    : typeof (props as { message?: unknown }).message === 'string'
                      ? (props as { message: string }).message
                      : typeof metadataObj?.message === 'string'
                        ? metadataObj.message
                      : undefined,
                next:
                  typeof statusInfo.next === 'number'
                    ? statusInfo.next
                    : typeof (props as { next?: unknown }).next === 'number'
                      ? (props as { next: number }).next
                      : typeof metadataObj?.next === 'number'
                        ? metadataObj.next
                      : undefined,
              }, 'sse:session.status');
            } else {
              updateSessionStatus(sessionId, { type: 'idle' }, 'sse:session.status');
            }
            requestSessionMetadataRefresh(sessionId, typeof props.directory === 'string' ? props.directory : null);
          }
        }
        break;

      case 'openchamber:session-status':
        {
          const sessionId = readStringProp(props, ['sessionId', 'sessionID']);
          const status = typeof props.status === 'string' ? props.status : null;
          const needsAttention = typeof props.needsAttention === 'boolean' ? props.needsAttention : false;
          const timestamp = typeof props.timestamp === 'number' ? props.timestamp : Date.now();

          if (sessionId && status) {
            // Update session status
            if (status === 'busy') {
              updateSessionStatus(sessionId, { type: 'busy' }, 'sse:openchamber:session-status');
            } else if (status === 'retry') {
              const metadata = (typeof props.metadata === 'object' && props.metadata !== null) ? props.metadata as Record<string, unknown> : {};
              updateSessionStatus(sessionId, {
                type: 'retry',
                attempt: typeof metadata.attempt === 'number' ? metadata.attempt : undefined,
                message: typeof metadata.message === 'string' ? metadata.message : undefined,
                next: typeof metadata.next === 'number' ? metadata.next : undefined,
              }, 'sse:openchamber:session-status');
            } else {
              updateSessionStatus(sessionId, { type: 'idle' }, 'sse:openchamber:session-status');
            }

            // Update attention state in the same update to ensure atomicity
            const currentAttentionStates = useSessionStore.getState().sessionAttentionStates || new Map();
            const newAttentionStates = new Map(currentAttentionStates);
            const existing = newAttentionStates.get(sessionId);

            newAttentionStates.set(sessionId, {
              needsAttention,
              lastStatusChangeAt: timestamp,
              lastUserMessageAt: existing?.lastUserMessageAt ?? null,
              status: status as 'idle' | 'busy' | 'retry',
              isViewed: existing?.isViewed ?? false,
            });

            useSessionStore.setState({ sessionAttentionStates: newAttentionStates });
          }
        }
        break;

      case 'message.part.updated': {
        const part = (typeof props.part === 'object' && props.part !== null) ? (props.part as Part) : null;
        if (!part) break;

        const partExt = part as Record<string, unknown>;
        const messageInfo = (typeof props.info === 'object' && props.info !== null) ? (props.info as Record<string, unknown>) : props;

        const messageInfoSessionId = readStringProp(messageInfo, ['sessionID', 'sessionId']);

        const resolvedSessionId =
          readStringProp(partExt, ['sessionID', 'sessionId']) ||
          messageInfoSessionId ||
          readStringProp(props, ['sessionID', 'sessionId']);

        const messageInfoId = readStringProp(messageInfo, ['messageID', 'messageId', 'id']);

        const resolvedMessageId =
          readStringProp(partExt, ['messageID', 'messageId']) ||
          messageInfoId ||
          readStringProp(props, ['messageID', 'messageId']);

        if (!resolvedSessionId || !resolvedMessageId) {
          if (streamDebugEnabled()) {
            console.debug('[useEventStream] Skipping message.part.updated without resolvable session/message id', {
              sessionID: partExt.sessionID ?? messageInfoSessionId ?? props.sessionID,
              messageID: partExt.messageID ?? messageInfoId ?? props.messageID,
            });
          }
          break;
        }

        const sessionId = resolvedSessionId;
        const messageId = resolvedMessageId;

        lastMessageEventBySessionRef.current.set(sessionId, Date.now());
        const pendingTimer = pendingMessageStallTimersRef.current.get(sessionId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingMessageStallTimersRef.current.delete(sessionId);
        }

        const trimmedHeadMaxId = useSessionStore.getState().sessionMemoryState.get(sessionId)?.trimmedHeadMaxId;
        if (trimmedHeadMaxId && !isIdNewer(messageId, trimmedHeadMaxId)) {
          if (streamDebugEnabled()) {
            console.debug('[useEventStream] Skipping message.part.updated for trimmed message', {
              sessionId,
              messageId,
              trimmedHeadMaxId,
            });
          }
          break;
        }

        const shouldKeepSyntheticUserText = (value: unknown): boolean => {
          const text = typeof value === 'string' ? value.trim() : '';
          if (!text) return false;
          return (
            text.startsWith('User has requested to enter plan mode') ||
            text.startsWith('The plan at ') ||
            text.startsWith('The following tool was executed by the user')
          );
        };

        const inferUserRoleFromPart = (): boolean => {
          const partType = typeof partExt.type === 'string' ? partExt.type : '';
          if (partType === 'subtask' || partType === 'agent' || partType === 'file') {
            return true;
          }
          if (partType === 'text' && partExt.synthetic === true) {
            const text = (partExt as { text?: unknown }).text;
            return shouldKeepSyntheticUserText(text);
          }
          return false;
        };

        let roleInfo = 'assistant';
        if (messageInfo && typeof (messageInfo as { role?: unknown }).role === 'string') {
          roleInfo = (messageInfo as { role?: string }).role as string;
        } else {
          const existingMessage = getMessageFromStore(sessionId, messageId);
          if (existingMessage) {
            const existingRole = (existingMessage.info as Record<string, unknown>).role;
            if (typeof existingRole === 'string') {
              roleInfo = existingRole;
            }
          }
        }

        if (roleInfo !== 'user' && inferUserRoleFromPart()) {
          roleInfo = 'user';
        }

        trackMessage(messageId, 'part_received', { role: roleInfo });

        if (roleInfo === 'user' && partExt.synthetic === true) {
          const text = (partExt as { text?: unknown }).text;
          if (!shouldKeepSyntheticUserText(text)) {
            trackMessage(messageId, 'skipped_synthetic_user_part');
            break;
          }
        }

        const messagePart: Part = {
          ...part,
          type: part.type || 'text',
        } as Part;

        if (roleInfo === 'assistant') {
          const partType = (messagePart as { type?: unknown }).type;
          const partTime = (messagePart as { time?: { end?: unknown } }).time;
          const partHasEnded = typeof partTime?.end === 'number';
          const toolState = (messagePart as { state?: { status?: unknown } }).state?.status;
          const toolName = typeof (messagePart as { tool?: unknown }).tool === 'string'
            ? (messagePart as { tool: string }).tool.toLowerCase()
            : null;
          const textContent = (messagePart as { text?: unknown }).text;

          if (partType === 'tool' && toolName === 'question') {
            requestPendingQuestionsRefresh();
          }

          const isStreamingPart = (() => {
            if (partType === 'tool') {
              return toolState === 'running' || toolState === 'pending';
            }
            if (partType === 'reasoning') {
              return !partHasEnded;
            }
            if (partType === 'text') {
              const hasText = typeof textContent === 'string' && textContent.trim().length > 0;
              return hasText && !partHasEnded;
            }
            if (partType === 'step-start') {
              return true;
            }
            return false;
          })();

          if (isStreamingPart) {
            const currentStatus = useSessionStore.getState().sessionStatus?.get(sessionId);
            const recentlyConfirmedIdle =
              currentStatus?.type === 'idle' &&
              typeof currentStatus.confirmedAt === 'number' &&
              Date.now() - currentStatus.confirmedAt < 1200;
            if (!currentStatus || currentStatus.type === 'idle') {
              if (recentlyConfirmedIdle) {
                break;
              }
              updateSessionStatus(sessionId, { type: 'busy' }, 'sse:message.part.updated');
            }
          }
        }

        trackMessage(messageId, 'addStreamingPart_called');
        addStreamingPart(sessionId, messageId, messagePart, roleInfo);
        break;
      }

      case 'message.part.delta': {
        const sessionId = readStringProp(props, ['sessionID', 'sessionId']);
        const messageId = readStringProp(props, ['messageID', 'messageId']);
        const partId = readStringProp(props, ['partID', 'partId']);
        const field = readStringProp(props, ['field']);
        const delta = typeof props.delta === 'string' ? props.delta : null;

        if (!sessionId || !messageId || !partId || !field || delta === null) {
          if (streamDebugEnabled()) {
            console.debug('[useEventStream] Skipping message.part.delta with missing payload', {
              sessionID: props.sessionID,
              messageID: props.messageID,
              partID: props.partID,
              field: props.field,
            });
          }
          break;
        }

        lastMessageEventBySessionRef.current.set(sessionId, Date.now());
        const pendingTimer = pendingMessageStallTimersRef.current.get(sessionId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingMessageStallTimersRef.current.delete(sessionId);
        }

        const trimmedHeadMaxId = useSessionStore.getState().sessionMemoryState.get(sessionId)?.trimmedHeadMaxId;
        if (trimmedHeadMaxId && !isIdNewer(messageId, trimmedHeadMaxId)) {
          if (streamDebugEnabled()) {
            console.debug('[useEventStream] Skipping message.part.delta for trimmed message', {
              sessionId,
              messageId,
              trimmedHeadMaxId,
            });
          }
          break;
        }

        const existingMessage = getMessageFromStore(sessionId, messageId);
        const existingPart = existingMessage?.parts?.find((item) => item?.id === partId);
        if (!existingPart) {
          break;
        }

        const existingPartRecord = existingPart as Record<string, unknown>;
        const existingFieldValue = existingPartRecord[field];
        const updatedPart: Part = {
          ...existingPart,
          [field]: `${typeof existingFieldValue === 'string' ? existingFieldValue : ''}${delta}`,
        } as Part;

        let roleInfo = 'assistant';
        const existingRole = (existingMessage?.info as Record<string, unknown> | undefined)?.role;
        if (typeof existingRole === 'string') {
          roleInfo = existingRole;
        }

        if (roleInfo === 'assistant' && delta.length > 0) {
          const currentStatus = useSessionStore.getState().sessionStatus?.get(sessionId);
          const recentlyConfirmedIdle =
            currentStatus?.type === 'idle' &&
            typeof currentStatus.confirmedAt === 'number' &&
            Date.now() - currentStatus.confirmedAt < 1200;
          if (!currentStatus || currentStatus.type === 'idle') {
            if (!recentlyConfirmedIdle) {
              updateSessionStatus(sessionId, { type: 'busy' }, 'sse:message.part.delta');
            }
          }
        }

        trackMessage(messageId, 'part_delta_received', { role: roleInfo, field });
        addStreamingPart(sessionId, messageId, updatedPart, roleInfo);
        break;
      }

      case 'message.updated': {
        const message = (typeof props.info === 'object' && props.info !== null) ? (props.info as Record<string, unknown>) : props;
        const messageExt = message as Record<string, unknown>;

        const resolvedSessionId =
          readStringProp(messageExt, ['sessionID', 'sessionId']) ||
          readStringProp(props, ['sessionID', 'sessionId']);

        const resolvedMessageId =
          readStringProp(messageExt, ['messageID', 'messageId', 'id']) ||
          readStringProp(props, ['messageID', 'messageId']);

        if (!resolvedSessionId || !resolvedMessageId) {
          if (streamDebugEnabled()) {
            console.debug('[useEventStream] Skipping message.updated without resolvable session/message id', {
              sessionID: messageExt.sessionID ?? props.sessionID,
              messageID: messageExt.id ?? props.messageID,
            });
          }
          break;
        }

        const sessionId = resolvedSessionId;
        const messageId = resolvedMessageId;

        lastMessageEventBySessionRef.current.set(sessionId, Date.now());
        const pendingTimer = pendingMessageStallTimersRef.current.get(sessionId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingMessageStallTimersRef.current.delete(sessionId);
        }

        const trimmedHeadMaxId = useSessionStore.getState().sessionMemoryState.get(sessionId)?.trimmedHeadMaxId;
        if (trimmedHeadMaxId && !isIdNewer(messageId, trimmedHeadMaxId)) {
          if (streamDebugEnabled()) {
            console.debug('[useEventStream] Skipping message.updated for trimmed message', {
              sessionId,
              messageId,
              trimmedHeadMaxId,
            });
          }
          break;
        }

        if (streamDebugEnabled()) {
          try {
            const serverParts = (props as { parts?: unknown }).parts || (messageExt as { parts?: unknown }).parts || [];
            const textParts = Array.isArray(serverParts)
              ? serverParts.filter((p: unknown) => (p as { type?: string })?.type === 'text')
              : [];
            const textJoined = textParts
              .map((p: unknown) => {
                const part = p as { text?: string; content?: string };
                return typeof part?.text === 'string' ? part.text : typeof part?.content === 'string' ? part.content : '';
              })
              .join('\n');
            console.info('[STREAM-TRACE] message.updated', {
              messageId,
              role: (messageExt as { role?: unknown }).role,
              status: (messageExt as { status?: unknown }).status,
              textLen: textJoined.length,
              textPreview: textJoined.slice(0, 120),
              partsCount: Array.isArray(serverParts) ? serverParts.length : 0,
            });
          } catch { /* ignored */ }
        }

        trackMessage(messageId, 'message_updated', { role: (messageExt as { role?: unknown }).role });

        if ((messageExt as { role?: unknown }).role === 'user') {
          // Update lastUserMessageAt in session memory state
          const { sessionMemoryState } = useMessageStore.getState();
          const currentMemory = sessionMemoryState.get(sessionId);
          if (currentMemory) {
            const newMemoryState = new Map(sessionMemoryState);
            newMemoryState.set(sessionId, {
              ...currentMemory,
              lastUserMessageAt: Date.now(),
            });
            useMessageStore.setState({ sessionMemoryState: newMemoryState });
          }

          const serverParts = (props as { parts?: unknown }).parts || (messageExt as { parts?: unknown }).parts;
          const partsArray = Array.isArray(serverParts) ? (serverParts as Part[]) : [];
          const existingUserMessage = getMessageFromStore(sessionId, messageId);

          const agentCandidate = (() => {
            const rawAgent = (messageExt as { agent?: unknown }).agent;
            if (typeof rawAgent === 'string' && rawAgent.trim().length > 0) return rawAgent.trim();
            const rawMode = (messageExt as { mode?: unknown }).mode;
            if (typeof rawMode === 'string' && rawMode.trim().length > 0) return rawMode.trim();
            return '';
          })();

          const createdAt = (() => {
            const rawTime = (messageExt as { time?: unknown }).time as { created?: unknown } | undefined;
            const created = rawTime?.created;
            return typeof created === 'number' ? created : null;
          })();

          const isSyntheticOnly =
            partsArray.length > 0 &&
            partsArray.every((part) => (part as unknown as { synthetic?: boolean })?.synthetic === true);

          const shouldApplyUserAgentSelection = (() => {
            if (!agentCandidate) return false;

            // Mode switches are server-injected synthetic user messages; always accept.
            if (isSyntheticOnly && (agentCandidate === 'plan' || agentCandidate === 'build')) {
              return true;
            }

            const last = lastUserAgentSelectionRef.current.get(sessionId);
            if (!last) return true;

            if (createdAt === null) {
              // If timestamp is missing, never allow it to override a newer selection.
              return false;
            }

            if (messageId === last.messageId) return true;
            return createdAt >= last.created;
          })();

          if (agentCandidate && shouldApplyUserAgentSelection) {
            try {
              const agents = useConfigStore.getState().agents;
              if (Array.isArray(agents) && agents.some((agent) => agent?.name === agentCandidate)) {
                const context = useContextStore.getState();
                context.saveSessionAgentSelection(sessionId, agentCandidate);

                lastUserAgentSelectionRef.current.set(sessionId, {
                  created: createdAt ?? Date.now(),
                  messageId,
                });

                if (currentSessionIdRef.current === sessionId) {
                  try {
                    useConfigStore.getState().setAgent(agentCandidate);
                  } catch {
                    // ignored
                  }
                }

                const modelObj = (messageExt as { model?: { providerID?: unknown; modelID?: unknown } }).model;
                const providerID = typeof modelObj?.providerID === 'string' ? modelObj.providerID : null;
                const modelID = typeof modelObj?.modelID === 'string' ? modelObj.modelID : null;
                if (providerID && modelID) {
                  context.saveSessionModelSelection(sessionId, providerID, modelID);
                  context.saveAgentModelForSession(sessionId, agentCandidate, providerID, modelID);
                  const variant = typeof (messageExt as { variant?: unknown }).variant === 'string'
                    ? (messageExt as { variant: string }).variant
                    : undefined;
                  context.saveAgentModelVariantForSession(sessionId, agentCandidate, providerID, modelID, variant);

                  if (currentSessionIdRef.current === sessionId) {
                    try {
                      useConfigStore.getState().setProvider(providerID);
                      useConfigStore.getState().setModel(modelID);
                    } catch {
                      // ignored
                    }
                  }
                }
              }
            } catch {
              // ignored
            }
          }

          if (
            isSyntheticOnly &&
            (agentCandidate === 'plan' || agentCandidate === 'build') &&
            currentSessionIdRef.current === sessionId
          ) {
            const toastKey = `${sessionId}:${messageId}:${agentCandidate}`;
            if (!modeSwitchToastShownRef.current.has(toastKey)) {
              modeSwitchToastShownRef.current.add(toastKey);
              import('sonner').then(({ toast }) => {
                toast.info(agentCandidate === 'plan' ? 'Plan mode active' : 'Build mode active', {
                  description: agentCandidate === 'plan'
                    ? 'Edits restricted to plan file'
                    : 'You can now edit files',
                  duration: 5000,
                });
              });
            }
          }

          const userMessageInfo = {
            ...message,
            userMessageMarker: true,
            clientRole: 'user',
            ...(agentCandidate ? { mode: agentCandidate } : {}),
          } as unknown as Message;

          updateMessageInfo(sessionId, messageId, userMessageInfo);

          // Some backends send user message updates without parts. Hydrate from session history.
          if (!existingUserMessage && partsArray.length === 0) {
            const hydrateKey = `${sessionId}:${messageId}`;
            if (!missingMessageHydrationRef.current.has(hydrateKey)) {
              missingMessageHydrationRef.current.add(hydrateKey);
              void opencodeClient
                .getSessionMessages(sessionId, 50)
                .then((messages) => {
                  useSessionStore.getState().syncMessages(sessionId, messages);
                })
                .catch(() => {
                  // ignored
                });
            }
          }

          if (partsArray.length > 0) {
            for (let i = 0; i < partsArray.length; i++) {
              const serverPart = partsArray[i];
              const isSynthetic = (serverPart as Record<string, unknown>).synthetic === true;
              if (isSynthetic) {
                const text = (serverPart as { text?: unknown }).text;
                const textStr = typeof text === 'string' ? text.trim() : '';
                const shouldKeep =
                  textStr.startsWith('User has requested to enter plan mode') ||
                  textStr.startsWith('The plan at ') ||
                  textStr.startsWith('The following tool was executed by the user');
                if (!shouldKeep) continue;
              }

              const enrichedPart: Part = {
                ...serverPart,
                type: serverPart?.type || 'text',
                sessionID: (serverPart as { sessionID?: string })?.sessionID || sessionId,
                messageID: (serverPart as { messageID?: string })?.messageID || messageId,
              } as Part;
              addStreamingPart(sessionId, messageId, enrichedPart, 'user');
            }
          }

          trackMessage(messageId, 'user_message_created_from_event', { partsCount: partsArray.length });
          break;
        }

        const existingMessage = getMessageFromStore(sessionId, messageId);
        const existingLen = computeTextLength(existingMessage?.parts || []);
        const existingStopMarker = (existingMessage?.info as { finish?: string } | undefined)?.finish === 'stop';

        const serverParts = (props as { parts?: unknown }).parts || (messageExt as { parts?: unknown }).parts;
        const partsArray = Array.isArray(serverParts) ? (serverParts as Part[]) : [];
        const hasParts = partsArray.length > 0;
        const timeObj = (messageExt as { time?: { completed?: number } }).time || {};
        const completedFromServer = typeof timeObj?.completed === 'number';
        const rawStatus = (message as { status?: unknown }).status;
        const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : null;
        const hasCompletedStatus = status === 'completed' || status === 'complete';
        const finishCandidate = (message as { finish?: unknown }).finish;
        const finish = typeof finishCandidate === 'string' ? finishCandidate : null;
        const eventHasStopFinish = finish === 'stop';
        const eventHasErrorFinish = finish === 'error';

        if (!hasParts && !completedFromServer && !hasCompletedStatus && !eventHasStopFinish && !eventHasErrorFinish) break;

        if ((messageExt as { role?: unknown }).role === 'assistant' && hasParts) {
          const hasQuestionTool = partsArray.some((part) => (
            part?.type === 'tool'
            && typeof (part as { tool?: unknown }).tool === 'string'
            && (part as { tool: string }).tool.toLowerCase() === 'question'
          ));
          if (hasQuestionTool) {
            requestPendingQuestionsRefresh();
          }

          const incomingLen = computeTextLength(partsArray);
          const wouldShrink = existingLen > 0 && incomingLen + TEXT_SHRINK_TOLERANCE < existingLen;

          if (wouldShrink && !eventHasStopFinish) {
            trackMessage(messageId, 'skipped_shrinking_update', { incomingLen, existingLen });
            break;
          }
        }

        updateMessageInfo(sessionId, messageId, message as unknown as Message);

        const messageRole = typeof (message as { role?: unknown }).role === 'string'
          ? (message as { role: string }).role
          : null;
        const runtimeAPIs = getRegisteredRuntimeAPIs();
        const shouldSynthesizeNotifications = Boolean(runtimeAPIs?.runtime?.isVSCode) && !serverNotificationEventSeenRef.current;
        if (shouldSynthesizeNotifications && messageRole === 'assistant') {
          const settings = useUIStore.getState();
          const sessionInfo = useSessionStore.getState().sessions.find((entry) => entry.id === sessionId);
          const sessionTitle = typeof sessionInfo?.title === 'string' ? sessionInfo.title.trim() : '';

          if (eventHasStopFinish && settings.notifyOnCompletion !== false) {
            const isSubtask = Boolean(sessionInfo?.parentID);
            if (!(settings.notifyOnSubtasks === false && isSubtask)) {
              const notificationKey = `ready:${sessionId}:${messageId}`;
              if (!notifiedMessagesRef.current.has(notificationKey)) {
                notifiedMessagesRef.current.add(notificationKey);
                dispatchRuntimeNotification({
                  title: 'Agent is ready',
                  body: sessionTitle || 'Task completed',
                  tag: `ready-${sessionId}`,
                });
              }
            }
          }

          if (eventHasErrorFinish && settings.notifyOnError !== false) {
            const notificationKey = `error:${sessionId}:${messageId}`;
            if (!notifiedMessagesRef.current.has(notificationKey)) {
              notifiedMessagesRef.current.add(notificationKey);
              dispatchRuntimeNotification({
                title: 'Tool error',
                body: sessionTitle || 'An error occurred',
                tag: `error-${sessionId}`,
              });
            }
          }
        }

        if (hasParts && (messageExt as { role?: unknown }).role !== 'user') {
          const storeState = useSessionStore.getState();
          const existingMessages = storeState.messages.get(sessionId) || [];
          const existingMessageForSession = existingMessages.find((m) => m.info.id === messageId);
          const needsInjection = !existingMessageForSession || existingMessageForSession.parts.length === 0;

          trackMessage(
            messageId,
            needsInjection ? 'server_parts_injected' : 'server_parts_refreshed',
            { count: partsArray.length }
          );

          const partsToInject = partsArray;

          for (let i = 0; i < partsToInject.length; i++) {
            const serverPart = partsToInject[i];
            const enrichedPart: Part = {
              ...serverPart,
              type: serverPart?.type || 'text',
              sessionID: serverPart?.sessionID || sessionId,
              messageID: serverPart?.messageID || messageId,
            } as Part;
            addStreamingPart(sessionId, messageId, enrichedPart, (messageExt as { role?: string }).role as string);
            trackMessage(messageId, `server_part_${i}`);
          }
        }

        const messageTime = (message as { time?: { completed?: unknown } }).time;
        const completedCandidate = (messageTime as { completed?: unknown } | undefined)?.completed;
        const hasCompletedTimestamp = typeof completedCandidate === 'number' && Number.isFinite(completedCandidate);

        const stopMarkerPresent = finish === 'stop' || existingStopMarker;

        const shouldFinalizeAssistantMessage =
          (message as { role?: string }).role === 'assistant' &&
          (hasCompletedTimestamp || hasCompletedStatus || stopMarkerPresent);

          if (shouldFinalizeAssistantMessage && (message as { role?: string }).role === 'assistant') {

            const storeState = useSessionStore.getState();
            const sessionMessages = storeState.messages.get(sessionId) || [];
          let latestAssistantMessageId: string | null = null;
          let maxId = '';

          for (let i = 0; i < sessionMessages.length; i++) {
            const msg = sessionMessages[i];
            if (msg.info.role === 'assistant' && msg.info.id > maxId) {
              maxId = msg.info.id;
              latestAssistantMessageId = msg.info.id;
            }
          }

          const isActiveSession = currentSessionId === sessionId;
          if (isActiveSession && messageId !== latestAssistantMessageId) break;

          const timeCompleted =
            hasCompletedTimestamp
              ? (completedCandidate as number)
              : Date.now();

          if (!hasCompletedTimestamp) {
            updateMessageInfo(sessionId, messageId, {
              ...message,
              time: { ...(messageTime ?? {}), completed: timeCompleted },
            } as unknown as Message);
          }

          trackMessage(messageId, 'completed', { timeCompleted });
          reportMessage(messageId);

          void saveSessionCursor(sessionId, messageId, timeCompleted);

	          completeStreamingMessage(sessionId, messageId);
	          // Removed: void refreshSessionStatus();

	          const rawMessageSessionId = (message as { sessionID?: string }).sessionID;
          const messageSessionId: string =
            typeof rawMessageSessionId === 'string' && rawMessageSessionId.length > 0
              ? rawMessageSessionId
              : sessionId;
          requestSessionMetadataRefresh(
            messageSessionId,
            typeof props.directory === 'string' ? props.directory : null,
          );


          const summaryInfo = message as Message & { summary?: boolean };
          if (summaryInfo.summary && typeof messageSessionId === 'string') {
            updateSessionCompaction(messageSessionId, null);
          }
        }
        break;
      }

      case 'session.created':
      case 'session.updated': {
        const candidate = (typeof props.info === 'object' && props.info !== null) ? props.info as Record<string, unknown> :
                         (typeof props.sessionInfo === 'object' && props.sessionInfo !== null) ? props.sessionInfo as Record<string, unknown> :
                         (typeof props.session === 'object' && props.session !== null) ? props.session as Record<string, unknown> : props;

        const sessionId = (typeof candidate.id === 'string' && candidate.id.length > 0) ? candidate.id :
                         (typeof candidate.sessionID === 'string' && candidate.sessionID.length > 0) ? candidate.sessionID :
                         (typeof props.sessionID === 'string' && props.sessionID.length > 0) ? props.sessionID :
                         (typeof props.id === 'string' && props.id.length > 0) ? props.id : undefined;

        if (sessionId) {
          const timeSource = (typeof candidate.time === 'object' && candidate.time !== null) ? candidate.time as Record<string, unknown> :
                            (typeof props.time === 'object' && props.time !== null) ? props.time as Record<string, unknown> : null;
          const compactingTimestamp = timeSource && typeof timeSource.compacting === 'number' ? timeSource.compacting as number : null;
          updateSessionCompaction(sessionId, compactingTimestamp);

          const sessionDirectory = typeof (candidate as { directory?: unknown }).directory === 'string'
            ? (candidate as { directory: string }).directory
            : typeof props.directory === 'string'
              ? (props.directory as string)
              : null;

          const patchedSession = {
            ...(candidate as unknown as Record<string, unknown>),
            id: sessionId,
            ...(sessionDirectory ? { directory: sessionDirectory } : {}),
          } as unknown as Session;

          updateSession(patchedSession);
        }
        break;
      }

      case 'session.deleted': {
        const sessionId = typeof props.sessionID === 'string'
          ? props.sessionID
          : typeof props.id === 'string'
            ? props.id
            : null;
        if (sessionId) {
          removeSessionFromStore(sessionId);
        }
        break;
      }

      case 'session.abort': {
        const sessionId =
          typeof props.sessionID === 'string' && (props.sessionID as string).length > 0
            ? (props.sessionID as string)
            : null;
        const messageId =
          typeof props.messageID === 'string' && (props.messageID as string).length > 0
            ? (props.messageID as string)
            : null;

        if (sessionId) {
          updateSessionStatus(sessionId, { type: 'idle' }, 'sse:session.abort');
        }
        if (sessionId && messageId) {
          completeStreamingMessage(sessionId, messageId);
        }
        break;
      }

      case 'permission.asked': {
        const request = normalizePermissionRequest(props);
        if (!request) {
          break;
        }

        addPermission(request);

        const runtimeAPIs = getRegisteredRuntimeAPIs();
        if (runtimeAPIs?.runtime?.isVSCode && !serverNotificationEventSeenRef.current) {
          const settings = useUIStore.getState();
          if (settings.notifyOnQuestion !== false) {
            const notificationKey = `permission:${request.sessionID}:${request.id}`;
            if (!notifiedQuestionsRef.current.has(notificationKey)) {
              notifiedQuestionsRef.current.add(notificationKey);
              const sessionTitle =
                useSessionStore.getState().sessions.find((s) => s.id === request.sessionID)?.title ||
                'Agent is waiting for your approval';
              dispatchRuntimeNotification({
                title: 'Permission required',
                body: sessionTitle,
                tag: `permission-${request.sessionID}:${request.id}`,
              });
            }
          }
        }

        // Notify if permission is for another session (common with child sessions).
        const toastKey = `${request.sessionID}:${request.id}`;
        if (!permissionToastShownRef.current.has(toastKey)) {
          setTimeout(() => {
            const current = currentSessionIdRef.current;
            if (current === request.sessionID) {
              return;
            }

            const requestSession = useSessionStore.getState().sessions.find((session) => session.id === request.sessionID);
            if (requestSession?.parentID && requestSession.parentID === current) {
              return;
            }

            const pending = useSessionStore
              .getState()
              .permissions
              .get(request.sessionID)
              ?.some((entry) => entry.id === request.id);

            if (!pending) {
              return;
            }

            permissionToastShownRef.current.add(toastKey);

            const sessionTitle =
              useSessionStore.getState().sessions.find((s) => s.id === request.sessionID)?.title ||
              'Session';
            const permissionBody = buildPermissionToastBody(request);

              import('sonner').then(({ toast }) => {
                const isMobile = useUIStore.getState().isMobile;

                if (isMobile) {
                  toast.warning('Permission required', {
                    id: toastKey,
                    description: sessionTitle,
                    duration: 30000,
                    action: {
                      label: 'Open',
                      onClick: () => {
                        useUIStore.getState().setActiveMainTab('chat');
                        void useSessionStore.getState().setCurrentSession(request.sessionID);
                      },
                    },
                  });
                } else {
                  toast.warning('Permission required', {
                    id: toastKey,
                    description: React.createElement(PermissionToastActions, {
                      sessionTitle,
                      permissionBody,
                      onOnce: async () => {
                        try {
                          await useSessionStore.getState().respondToPermission(request.sessionID, request.id, 'once');
                          toast.dismiss(toastKey);
                        } catch (error) {
                          console.error('Failed to respond to permission:', error);
                        }
                      },
                      onAlways: async () => {
                        try {
                          await useSessionStore.getState().respondToPermission(request.sessionID, request.id, 'always');
                          toast.dismiss(toastKey);
                        } catch (error) {
                          console.error('Failed to respond to permission:', error);
                        }
                      },
                      onDeny: async () => {
                        try {
                          await useSessionStore.getState().respondToPermission(request.sessionID, request.id, 'reject');
                          toast.dismiss(toastKey);
                        } catch (error) {
                          console.error('Failed to respond to permission:', error);
                        }
                      },
                    }),
                    duration: 30000,
                  });
                }
              });

          }, 0);
        }

        break;
      }

      case 'permission.replied': {
        const sessionId = typeof props.sessionID === 'string' ? props.sessionID : null;
        const requestId =
          typeof props.requestID === 'string' ? props.requestID :
          typeof props.id === 'string' ? props.id : null;
        if (sessionId && requestId) {
          dismissPermission(sessionId, requestId);
        }
        break;
      }

      case 'question.asked': {
        if (!('sessionID' in props) || typeof props.sessionID !== 'string') {
          break;
        }

        const request = props as unknown as QuestionRequest;
        addQuestion(request);

        const runtimeAPIs = getRegisteredRuntimeAPIs();
        if (runtimeAPIs?.runtime?.isVSCode && !serverNotificationEventSeenRef.current) {
          const settings = useUIStore.getState();
          if (settings.notifyOnQuestion !== false) {
            const notificationKey = `question:${request.sessionID}:${request.id}`;
            if (!notifiedQuestionsRef.current.has(notificationKey)) {
              notifiedQuestionsRef.current.add(notificationKey);
              const firstQuestion = Array.isArray(request.questions) ? request.questions[0] : undefined;
              const questionHeader = typeof firstQuestion?.header === 'string' ? firstQuestion.header.trim() : '';
              const questionText = typeof firstQuestion?.question === 'string' ? firstQuestion.question.trim() : '';
              dispatchRuntimeNotification({
                title: questionHeader || 'Input needed',
                body: questionText || 'Agent is waiting for your response',
                tag: `question-${request.sessionID}:${request.id}`,
              });
            }
          }
        }

        const toastKey = `${request.sessionID}:${request.id}`;

	        // web/desktop use server-emitted notifications; VS Code may synthesize locally

        if (!questionToastShownRef.current.has(toastKey)) {
          setTimeout(() => {
            const current = currentSessionIdRef.current;
            if (current === request.sessionID) {
              return;
            }

            const requestSession = useSessionStore.getState().sessions.find((session) => session.id === request.sessionID);
            if (requestSession?.parentID && requestSession.parentID === current) {
              return;
            }

            const pending = useSessionStore
              .getState()
              .questions
              .get(request.sessionID)
              ?.some((entry) => entry.id === request.id);

            if (!pending) {
              return;
            }

            questionToastShownRef.current.add(toastKey);

            const sessionTitle =
              useSessionStore.getState().sessions.find((s) => s.id === request.sessionID)?.title ||
              'Session';

            import('sonner').then(({ toast }) => {
              toast.info('Input needed', {
                id: toastKey,
                description: sessionTitle,
                duration: 30000,
                action: {
                  label: 'Open',
                  onClick: () => {
                    useUIStore.getState().setActiveMainTab('chat');
                    void useSessionStore.getState().setCurrentSession(request.sessionID);
                  },
                },
              });
            });
          }, 0);
        }

        break;
      }

      case 'question.replied': {
        const sessionId = typeof props.sessionID === 'string' ? props.sessionID : null;
        const requestId = typeof props.requestID === 'string' ? props.requestID : null;
        if (sessionId && requestId) {
          dismissQuestion(sessionId, requestId);
        }
        break;
      }

      case 'question.rejected': {
        const sessionId = typeof props.sessionID === 'string' ? props.sessionID : null;
        const requestId = typeof props.requestID === 'string' ? props.requestID : null;
        if (sessionId && requestId) {
          dismissQuestion(sessionId, requestId);
        }
        break;
      }

      case 'openchamber:notification': {
        serverNotificationEventSeenRef.current = true;
        const title = typeof (props as { title?: unknown }).title === 'string' ? (props as { title: string }).title : '';
        const body = typeof (props as { body?: unknown }).body === 'string' ? (props as { body: string }).body : '';
        const tag = typeof (props as { tag?: unknown }).tag === 'string' ? (props as { tag: string }).tag : undefined;
        const requireHidden = Boolean((props as { requireHidden?: unknown }).requireHidden);

        // When the sidecar stdout notification channel is active (production desktop builds),
        // skip this SSE notification to avoid duplicating the native notification already
        // shown by the Tauri process. In dev mode the stdout channel is not available,
        // so we fall through and let the UI handle it via Tauri IPC.
        if (isDesktopLocalOriginActive() && Boolean((props as { desktopStdoutActive?: unknown }).desktopStdoutActive)) {
          break;
        }

        dispatchRuntimeNotification({ title, body, tag, requireHidden });

        break;
      }

      case 'todo.updated': {
        const sessionId = typeof props.sessionID === 'string' ? props.sessionID : null;
        const todos = Array.isArray(props.todos) ? props.todos : null;
        if (sessionId && todos) {
          handleTodoUpdatedEvent(
            sessionId,
            todos as Array<{ id: string; content: string; status: string; priority: string }>
          );
        }
        break;
      }
    }
  }, [
    currentSessionId,
    addStreamingPart,
    completeStreamingMessage,
    updateMessageInfo,
    addPermission,
    dismissPermission,
    addQuestion,
    dismissQuestion,
    checkConnection,
    requestSessionMetadataRefresh,
    updateSessionCompaction,
    applySessionMetadata,
    trackMessage,
    reportMessage,
    requestPendingQuestionsRefresh,

    updateSession,
    removeSessionFromStore,
    bootstrapState,
    effectiveDirectory,
    updateSessionStatus,
    dispatchRuntimeNotification,
  ]);

  // --- Stable callback refs (Part A) ---
  // Keep refs up to date with the latest version of each callback.
  // This lets startStream use stable wrappers with empty deps so SSE connections
  // are NOT torn down on every session switch.
  const handleEventRef = React.useRef(handleEvent);
  React.useEffect(() => {
    handleEventRef.current = handleEvent;
  }, [handleEvent]);

  const bootstrapStateRef = React.useRef(bootstrapState);
  React.useEffect(() => {
    bootstrapStateRef.current = bootstrapState;
  }, [bootstrapState]);

  // Stable wrappers — identity never changes, so startStream deps stay minimal.
  const stableHandleEvent = React.useCallback((event: EventData) => {
    handleEventRef.current(event);
  }, []); // intentionally empty deps

  const stableBootstrapState = React.useCallback((reason: string) => {
    return bootstrapStateRef.current(reason);
  }, []); // intentionally empty deps

  const shouldHoldConnection = React.useCallback(() => {
    const currentVisibility = resolveVisibilityState();
    visibilityStateRef.current = currentVisibility;
    return currentVisibility === 'visible' && onlineStatusRef.current;
  }, [resolveVisibilityState]);

  const debugConnectionState = React.useCallback(() => {
    if (streamDebugEnabled()) {
      console.debug('[useEventStream] Connection state:', {
        hasUnsubscribe: Boolean(unsubscribeRef.current),
        currentSessionId: currentSessionIdRef.current,
        effectiveDirectory,
        onlineStatus: onlineStatusRef.current,
        visibilityState: visibilityStateRef.current,
        lastEventTimestamp: lastEventTimestampRef.current,
        reconnectAttempts: reconnectAttemptsRef.current,
      });
    }
  }, [effectiveDirectory]);

  const stopStream = React.useCallback(() => {
    if (isCleaningUpRef.current) {
      if (streamDebugEnabled()) {
        console.info('[useEventStream] Already cleaning up, skipping stopStream');
      }
      return;
    }

    isCleaningUpRef.current = true;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (unsubscribeRef.current) {
      const unsubscribe = unsubscribeRef.current;
      unsubscribeRef.current = null;
      try {

        unsubscribe();
      } catch (error) {
        console.warn('[useEventStream] Error during unsubscribe:', error);
      }
    }


    isCleaningUpRef.current = false;
  }, []);

  const startStream = React.useCallback(async (options?: { resetAttempts?: boolean }) => {
    debugConnectionState();

    if (!shouldHoldConnection()) {
      pendingResumeRef.current = true;
      if (!onlineStatusRef.current) {
        publishStatus('offline', 'Waiting for network');
      } else {
        publishStatus('paused', 'Paused while hidden');
      }
      return;
    }

    if (options?.resetAttempts) {
      reconnectAttemptsRef.current = 0;
    }

    stopStream();
    lastEventTimestampRef.current = Date.now();
    publishStatus('connecting', null);

    if (streamDebugEnabled()) {
      console.info('[useEventStream] Starting event stream...');
    }

    const onError = (error: unknown) => {
      console.warn('Event stream error:', error);

    };

    const onOpen = () => {
      const shouldRefresh = pendingResumeRef.current;
      reconnectAttemptsRef.current = 0;
      pendingResumeRef.current = false;
      lastEventTimestampRef.current = Date.now();
      publishStatus('connected', null);
      checkConnection();
      triggerSessionStatusPoll();

      requestPendingPermissionsRefreshRef.current(shouldRefresh);

       if (shouldRefresh) {
         void stableBootstrapState('sse_reconnected');
       } else {
         const sessionId = currentSessionIdRef.current;
         if (sessionId) {
           setTimeout(() => {
           scheduleSoftResyncRef.current(sessionId, 'sse_reconnected', getMessageLimit())
             .then(() => requestSessionMetadataRefresh(sessionId))
             .catch((error: unknown) => {
               console.warn('[useEventStream] Failed to resync messages after reconnect:', error);
             });
           }, 0);
         }
       }
      };

    if (streamDebugEnabled()) {
      console.info('[useEventStream] Connecting to event source (SDK SSE only):', {
        effectiveDirectory,
        isCleaningUp: isCleaningUpRef.current,
      });
    }

    if (isCleaningUpRef.current) {
      if (streamDebugEnabled()) {
        console.info('[useEventStream] Skipping subscription due to cleanup in progress');
      }
      return;
    }

    try {
      const sdkUnsub = opencodeClient.subscribeToGlobalEvents(
        (event: RoutedOpencodeEvent) => {
          const payload = event.payload as unknown as EventData;
          const payloadRecord = event.payload as unknown as Record<string, unknown>;
          const baseProperties =
            typeof payloadRecord.properties === 'object' && payloadRecord.properties !== null
              ? (payloadRecord.properties as Record<string, unknown>)
              : {};

          const properties =
            event.directory && event.directory !== 'global'
              ? { ...baseProperties, directory: event.directory }
              : baseProperties;

          stableHandleEvent({
            type: typeof (payload as { type?: unknown }).type === 'string' ? (payload as { type: string }).type : '',
            properties,
          });
        },
        onError,
        onOpen,
      );


      const compositeUnsub = () => {
        try {
          sdkUnsub();
        } catch (cleanupError) {
          console.warn('[useEventStream] Error during unsubscribe:', cleanupError);
        }
      };

      if (!isCleaningUpRef.current) {
        unsubscribeRef.current = compositeUnsub;
      } else {
        compositeUnsub();
      }
    } catch (subscriptionError) {
      console.error('[useEventStream] Error during subscription:', subscriptionError);
      onError(subscriptionError);
    }
  }, [
    shouldHoldConnection,
    stopStream,
    publishStatus,
    checkConnection,
    requestSessionMetadataRefresh,
    stableHandleEvent,
    stableBootstrapState,
    effectiveDirectory,
    debugConnectionState,
  ]);

  const scheduleReconnect = React.useCallback((hint?: string) => {
    if (!shouldHoldConnection()) {
      pendingResumeRef.current = true;
      stopStream();
      if (!onlineStatusRef.current) {
        publishStatus('offline', 'Waiting for network');
      } else {
        publishStatus('paused', 'Paused while hidden');
      }
      return;
    }

    if (reconnectTimeoutRef.current) {
      return;
    }

    const nextAttempt = reconnectAttemptsRef.current + 1;
    reconnectAttemptsRef.current = nextAttempt;
    const statusHint = hint ?? `Retrying (${nextAttempt})`;
    publishStatus('reconnecting', statusHint);

    const baseDelay = nextAttempt <= 3
      ? Math.min(1000 * Math.pow(2, nextAttempt - 1), 8000)
      : Math.min(2000 * Math.pow(2, nextAttempt - 3), 32000);
    const jitter = Math.floor(Math.random() * 250);
    const delay = baseDelay + jitter;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    reconnectTimeoutRef.current = setTimeout(() => {
      startStream({ resetAttempts: false });
    }, delay);
  }, [shouldHoldConnection, stopStream, publishStatus, startStream]);

  React.useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  React.useEffect(() => {
    if (typeof window !== 'undefined') {
      window.__messageTracker = trackMessage;
    }

    // No-op

    const desktopActivityHandler = null;

    const clearPauseTimeout = () => {
      if (pauseTimeoutRef.current) {
        clearTimeout(pauseTimeoutRef.current);
        pauseTimeoutRef.current = null;
      }
    };

    const handleVisibilityChange = () => {
      visibilityStateRef.current = resolveVisibilityState();

      if (visibilityStateRef.current !== 'visible') {
        // Keep SSE connection alive while hidden; browsers may briefly toggle
        // visibility during tab/window transitions.
        return;
      }

      clearPauseTimeout();
      maybeBootstrapIfStale('visibility_restore');
      triggerSessionStatusPoll();

      const isStalled = Date.now() - lastEventTimestampRef.current > 45000;
      if (isStalled) {
        console.info('[useEventStream] Visibility restored with stalled stream, reconnecting...');
        pendingResumeRef.current = true;
      }

      if (pendingResumeRef.current || !unsubscribeRef.current) {
        console.info('[useEventStream] Visibility restored, triggering soft refresh...');
        const sessionId = currentSessionIdRef.current;
        if (sessionId) {
          scheduleSoftResync(sessionId, 'visibility_restore', getMessageLimit());
          requestSessionMetadataRefresh(sessionId);
        }
        requestPendingPermissionsRefreshRef.current(false);

        // Removed: void refreshSessionStatus();
        triggerSessionStatusPoll();
        publishStatus('connecting', 'Resuming stream');
        startStream({ resetAttempts: true });
      }
    };

      const handleWindowFocus = () => {
        visibilityStateRef.current = resolveVisibilityState();

    if (visibilityStateRef.current === 'visible') {
      clearPauseTimeout();
      maybeBootstrapIfStale('window_focus');
      triggerSessionStatusPoll();

      const isStalled = Date.now() - lastEventTimestampRef.current > 45000;
      if (isStalled) {
        pendingResumeRef.current = true;
      }

      if (pendingResumeRef.current || !unsubscribeRef.current) {
        console.info('[useEventStream] Window focused after pause, triggering soft refresh...');
          const sessionId = currentSessionIdRef.current;
           if (sessionId) {
             requestSessionMetadataRefresh(sessionId);
             scheduleSoftResync(sessionId, 'window_focus', getMessageLimit());
           }
           requestPendingPermissionsRefreshRef.current(false);
           // Removed: void refreshSessionStatus();
           triggerSessionStatusPoll();

           publishStatus('connecting', 'Resuming stream');
           startStream({ resetAttempts: true });
         }
      }
    };

      const handleOnline = () => {
        onlineStatusRef.current = true;
        maybeBootstrapIfStale('network_restored');
        requestPendingPermissionsRefreshRef.current(false);
        if (pendingResumeRef.current || !unsubscribeRef.current) {
          triggerSessionStatusPoll();
          publishStatus('connecting', 'Network restored');
          startStream({ resetAttempts: true });
        }
      };

      const handleOffline = () => {
        onlineStatusRef.current = false;
        pendingResumeRef.current = true;
        publishStatus('offline', 'Waiting for network');
        stopStream();
      };

      const handlePageHide = () => {
        pendingResumeRef.current = true;
        stopStream();
        publishStatus('paused', 'Paused while hidden');
      };

      const handlePageShow = (event: PageTransitionEvent) => {
        // If page was restored from bfcache, SSE is definitely gone.
        pendingResumeRef.current = pendingResumeRef.current || Boolean(event.persisted);
        visibilityStateRef.current = resolveVisibilityState();
        if (visibilityStateRef.current === 'visible') {
          const sessionId = currentSessionIdRef.current;
          if (sessionId) {
            void scheduleSoftResync(sessionId, 'page_show', getMessageLimit());
            requestSessionMetadataRefresh(sessionId);
          }
          requestPendingPermissionsRefreshRef.current(false);
          // Removed: void refreshSessionStatus();
          triggerSessionStatusPoll();
          startStream({ resetAttempts: true });
        }
      };

     if (typeof document !== 'undefined') {
       document.addEventListener('visibilitychange', handleVisibilityChange);
     }

      if (typeof window !== 'undefined') {
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        window.addEventListener('focus', handleWindowFocus);
        window.addEventListener('pagehide', handlePageHide);
        window.addEventListener('pageshow', handlePageShow as EventListener);
      }

    const startTimer = setTimeout(() => {
      startStream({ resetAttempts: true });
    }, 100);

    if (staleCheckIntervalRef.current) {
      clearInterval(staleCheckIntervalRef.current);
    }

        staleCheckIntervalRef.current = setInterval(() => {
          if (!shouldHoldConnection()) return;

          const now = Date.now();
          const hasBusySessions = Array.from(useSessionStore.getState().sessionStatus?.values?.() ?? []).some(
            (status) => status?.type === 'busy' || status?.type === 'retry'
          );

          if (hasBusySessions) {
            triggerSessionStatusPoll();
          }
          if (now - lastEventTimestampRef.current > 45000) {
            Promise.resolve().then(async () => {
              try {
                const healthy = await opencodeClient.checkHealth();
                if (!healthy) {
                  scheduleReconnect('Refreshing stalled stream');
                  return;
                }

                // If health is ok but SSE has been silent (including heartbeat),
                // treat it as a stalled connection and reconnect.
                scheduleReconnect('Refreshing stalled stream');
              } catch (error) {
                console.warn('Health check after stale stream failed:', error);
                scheduleReconnect('Refreshing stalled stream');
              }
            });
          }
        }, 10000);

    // Part B: Idle timeout recovery — scan for sessions stuck in 'busy'/'retry'
    // with no recent SSE events and force-reset them to 'idle'.
    const stuckCheckInterval = setInterval(() => {
      const sessionStatus = useSessionStore.getState().sessionStatus;
      if (!sessionStatus) return;
      const now = Date.now();
      sessionStatus.forEach((status, sessionId) => {
        if (status.type !== 'busy' && status.type !== 'retry') return;
        const lastMsgAt = lastMessageEventBySessionRef.current.get(sessionId) ?? 0;
        const busyTooLong = now - lastMsgAt > STUCK_SESSION_TIMEOUT_MS;
        const noRecentEvents = now - lastMsgAt > 60000;
        if (busyTooLong && noRecentEvents) {
          console.warn('[useEventStream] Session stuck in busy state, forcing idle:', sessionId);
          updateSessionStatus(sessionId, { type: 'idle' }, 'timeout_recovery');
        }
      });
    }, 30000); // check every 30s

    return () => {
      clearTimeout(startTimer);
      clearInterval(stuckCheckInterval);

      void desktopActivityHandler;

      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
      }

      if (typeof window !== 'undefined') {
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
        window.removeEventListener('focus', handleWindowFocus);
        window.removeEventListener('pagehide', handlePageHide);
        window.removeEventListener('pageshow', handlePageShow as EventListener);
      }

      clearPauseTimeout();

      if (staleCheckIntervalRef.current) {
        clearInterval(staleCheckIntervalRef.current);
        staleCheckIntervalRef.current = null;
      }

      messageCache.clear();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally accessing current ref value at cleanup time
      notifiedMessagesRef.current.clear();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentionally accessing current ref value at cleanup time
      notifiedQuestionsRef.current.clear();
      serverNotificationEventSeenRef.current = false;

      pendingResumeRef.current = false;
      visibilityStateRef.current = resolveVisibilityState();
      onlineStatusRef.current = typeof navigator === 'undefined' ? true : navigator.onLine;

      stopStream();

      if (sessionRefreshTimeoutRef.current) {
        clearTimeout(sessionRefreshTimeoutRef.current);
        sessionRefreshTimeoutRef.current = null;
      }

      publishStatus('idle', null);
    };
  }, [
    effectiveDirectory,
    trackMessage,
    resolveVisibilityState,
    stopStream,
    publishStatus,
    startStream,
    scheduleReconnect,
    loadMessages,
    requestSessionMetadataRefresh,
    
    
    shouldHoldConnection,
    loadSessions,
    maybeBootstrapIfStale,
    resyncMessages,
    scheduleSoftResync,
    updateSessionStatus,
  ]);
};
