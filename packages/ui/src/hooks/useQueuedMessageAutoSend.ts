import React from 'react';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getSyncSessionStatus } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';

type SessionStatusType = 'idle' | 'busy' | 'retry';

const RECENT_ABORT_WINDOW_MS = 2000;
const AUTO_SEND_RETRY_BASE_DELAY_MS = 2000;
const AUTO_SEND_RETRY_MAX_DELAY_MS = 60000;

export type QueuedAutoSendFailure = {
  messageId: string;
  failures: number;
  nextAttemptAt: number;
};

export const getQueuedAutoSendRetryDelayMs = (failures: number): number =>
  Math.min(AUTO_SEND_RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), AUTO_SEND_RETRY_MAX_DELAY_MS);

export const isQueuedAutoSendBackedOff = (
  failure: QueuedAutoSendFailure | undefined,
  messageId: string,
  now: number,
): boolean => failure !== undefined && failure.messageId === messageId && now < failure.nextAttemptAt;

type RetryState = {
  queuedMessageId: string;
  timer?: ReturnType<typeof setTimeout>;
};

export const hasRecentAbort = (sessionId: string): boolean => {
  const abortRecord = useSessionUIStore.getState().sessionAbortFlags.get(sessionId);
  if (!abortRecord) {
    return false;
  }
  return Date.now() - abortRecord.timestamp < RECENT_ABORT_WINDOW_MS;
};

export const getAbortWindowRetryDelayMs = (abortTimestamp: number, now: number = Date.now()): number => {
  return Math.max(RECENT_ABORT_WINDOW_MS - (now - abortTimestamp), 0);
};

export const buildQueuedAutoSendPayload = (queue: QueuedMessage[]) => {
  const queued = queue[0];
  if (!queued) {
    return null;
  }

  const agents = useConfigStore.getState().getVisibleAgents();
  const { sanitizedText, mention } = parseAgentMentions(queued.content, agents);

  return {
    queuedMessageId: queued.id,
    primaryText: sanitizedText,
    primaryAttachments: queued.attachments ?? [],
    agentMentionName: mention?.name,
    sendConfig: queued.sendConfig,
  };
};

type QueuedAutoSendPayload = NonNullable<ReturnType<typeof buildQueuedAutoSendPayload>>;
type ResolvedQueuedSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

export const sendQueuedAutoSendPayload = (
  sessionId: string,
  payload: QueuedAutoSendPayload,
  resolved: ResolvedQueuedSendConfig,
) => {
  return useSessionUIStore.getState().sendMessage(
    payload.primaryText,
    resolved.providerID,
    resolved.modelID,
    resolved.agent,
    payload.primaryAttachments,
    payload.agentMentionName,
    undefined,
    resolved.variant,
    'normal',
    { sessionId, delivery: 'steer' as const },
  );
};

const resolveSessionSendConfig = (sessionId: string) => {
  const context = useContextStore.getState();
  const config = useConfigStore.getState();
  const selection = useSelectionStore.getState();

  const selectedAgent =
    context.getSessionAgentSelection(sessionId)
    ?? context.getCurrentAgent(sessionId)
    ?? config.currentAgentName
    ?? undefined;

  const sessionModel = context.getSessionModelSelection(sessionId);
  const agentModel = selectedAgent
    ? context.getAgentModelForSession(sessionId, selectedAgent)
    : null;

  const providerID =
    agentModel?.providerId
    ?? sessionModel?.providerId
    ?? config.currentProviderId
    ?? selection.lastUsedProvider?.providerID;
  const modelID =
    agentModel?.modelId
    ?? sessionModel?.modelId
    ?? config.currentModelId
    ?? selection.lastUsedProvider?.modelID;

  const variant =
    selectedAgent && providerID && modelID
      ? (selection.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID)
        ?? context.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID))
      : undefined;

  return {
    providerID,
    modelID,
    agent: selectedAgent,
    variant,
  };
};

export const shouldDispatchQueuedAutoSend = (
  previousStatusType: SessionStatusType | undefined,
  currentStatusType: SessionStatusType,
  hasQueuedItems: boolean = false,
): boolean => {
  if (hasQueuedItems && currentStatusType === 'idle') return true;
  return (previousStatusType === 'busy' || previousStatusType === 'retry')
    && currentStatusType === 'idle';
};

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const autoReviewRuns = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  const sessionStatusRecord = useDirectorySync((state) => state.session_status);

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const sendFailuresRef = React.useRef<Map<string, QueuedAutoSendFailure>>(new Map());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());
  const autoReviewBlockedSessionsRef = React.useRef<Set<string>>(new Set());
  const retryStateRef = React.useRef<Map<string, RetryState>>(new Map());
  const dispatchRef = React.useRef<((sessionId: string) => void) | undefined>(undefined);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const clearRetryState = (sessionId: string) => {
      const state = retryStateRef.current.get(sessionId);
      if (state?.timer) {
        clearTimeout(state.timer);
      }
      retryStateRef.current.delete(sessionId);
    };

    const dispatchSessionQueue = async (sessionId: string, queueSnapshot: QueuedMessage[]) => {
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(sessionId)) {
        return;
      }
      if (hasRecentAbort(sessionId)) {
        return;
      }
      if (useAutoReviewStore.getState().isRunningForSession(sessionId)) {
        autoReviewBlockedSessionsRef.current.add(sessionId);
        return;
      }

      const currentStatus = getSyncSessionStatus(sessionId)?.type ?? 'idle';
      if (currentStatus !== 'idle') {
        return;
      }

      const payload = buildQueuedAutoSendPayload(queueSnapshot);
      if (!payload) {
        return;
      }

      const retryState = retryStateRef.current.get(sessionId);
      if (retryState && retryState.queuedMessageId !== payload.queuedMessageId) {
        clearRetryState(sessionId);
      }

      const currentRetryState = retryStateRef.current.get(sessionId);
      if (currentRetryState?.queuedMessageId === payload.queuedMessageId && currentRetryState.timer) {
        return;
      }

      const failure = sendFailuresRef.current.get(sessionId);
      if (failure && failure.messageId !== payload.queuedMessageId) {
        sendFailuresRef.current.delete(sessionId);
      } else if (isQueuedAutoSendBackedOff(failure, payload.queuedMessageId, Date.now())) {
        return;
      }

      const abortRecord = useSessionUIStore.getState().sessionAbortFlags.get(sessionId);
      if (abortRecord) {
        const ageMs = Date.now() - abortRecord.timestamp;
        if (ageMs < RECENT_ABORT_WINDOW_MS) {
          const currentAbortRetryState = retryStateRef.current.get(sessionId);
          if (currentAbortRetryState?.queuedMessageId === payload.queuedMessageId && currentAbortRetryState.timer) {
            return;
          }

          if (currentAbortRetryState?.timer) {
            clearTimeout(currentAbortRetryState.timer);
          }

          const timer = setTimeout(() => {
            retryStateRef.current.delete(sessionId);
            dispatchRef.current?.(sessionId);
          }, getAbortWindowRetryDelayMs(abortRecord.timestamp));
          retryStateRef.current.set(sessionId, {
            queuedMessageId: payload.queuedMessageId,
            timer,
          });
          return;
        }
      }
      // Use send config captured at queue time; fall back to current config
      const captured = payload.sendConfig;
      const resolved = captured?.providerID && captured?.modelID
        ? captured
        : resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        return;
      }

      inFlightSessionsRef.current.add(sessionId);

      try {
        await sendQueuedAutoSendPayload(sessionId, payload, {
          providerID: resolved.providerID,
          modelID: resolved.modelID,
          agent: resolved.agent,
          variant: resolved.variant,
        });
        useMessageQueueStore.getState().removeFromQueue(sessionId, payload.queuedMessageId);
        clearRetryState(sessionId);
        sendFailuresRef.current.delete(sessionId);
      } catch (error) {
        console.warn('[queue] queued auto-send failed:', error);
        const priorFailures = failure?.messageId === payload.queuedMessageId ? failure.failures : 0;
        const failures = priorFailures + 1;
        const nextAttemptAt = Date.now() + getQueuedAutoSendRetryDelayMs(failures);
        sendFailuresRef.current.set(sessionId, {
          messageId: payload.queuedMessageId,
          failures,
          nextAttemptAt,
        });
        const existingState = retryStateRef.current.get(sessionId);
        if (existingState?.timer) {
          clearTimeout(existingState.timer);
        }
        const timer = setTimeout(() => {
          retryStateRef.current.delete(sessionId);
          dispatchRef.current?.(sessionId);
        }, Math.max(nextAttemptAt - Date.now(), 0));
        retryStateRef.current.set(sessionId, {
          queuedMessageId: payload.queuedMessageId,
          timer,
        });
      } finally {
        inFlightSessionsRef.current.delete(sessionId);
      }
    };

    dispatchRef.current = (sessionId: string) => {
      const queue = useMessageQueueStore.getState().queuedMessages[sessionId];
      if (!queue || queue.length === 0) {
        return;
      }
      void dispatchSessionQueue(sessionId, queue);
    };

    const statusRecord = sessionStatusRecord ?? {};
    const nextStatusMap = new Map(previousStatusRef.current);
    for (const [sessionId, status] of Object.entries(statusRecord)) {
      if (status) {
        nextStatusMap.set(sessionId, status.type as SessionStatusType);
      }
    }

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([sessionId, queue]) => {
      const currentStatusType = (statusRecord[sessionId]?.type ?? 'idle') as SessionStatusType;
      const previousStatusType = previousStatusRef.current.get(sessionId);
      const wasAutoReviewBlocked = autoReviewBlockedSessionsRef.current.has(sessionId);
      const isAutoReviewRunning = useAutoReviewStore.getState().isRunningForSession(sessionId);
      if (isAutoReviewRunning) {
        autoReviewBlockedSessionsRef.current.add(sessionId);
      } else if (wasAutoReviewBlocked) {
        autoReviewBlockedSessionsRef.current.delete(sessionId);
      }

      if (queue.length > 0 && (
        shouldDispatchQueuedAutoSend(previousStatusType, currentStatusType, queue.length > 0)
        || (wasAutoReviewBlocked && !isAutoReviewRunning && currentStatusType === 'idle')
      )) {
        void dispatchSessionQueue(sessionId, queue);
      }

      nextStatusMap.set(sessionId, currentStatusType);
    });

    const activeQueueSessions = new Set(queueEntries.map(([sessionId]) => sessionId));
    for (const [sessionId, retryState] of retryStateRef.current.entries()) {
      if (activeQueueSessions.has(sessionId)) {
        continue;
      }
      if (retryState.timer) {
        clearTimeout(retryState.timer);
      }
      retryStateRef.current.delete(sessionId);
    }

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, sessionStatusRecord, autoReviewRuns]);

  React.useEffect(() => {
    const retryStateMap = retryStateRef.current;
    return () => {
      for (const retryState of retryStateMap.values()) {
        if (retryState.timer) {
          clearTimeout(retryState.timer);
        }
      }
      retryStateMap.clear();
    };
  }, []);
}
