import React from 'react';
import { getMessageQueueKey, parseMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getDirectoryState } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { HarnessClientError } from '@/lib/harness/client';

type SessionStatusType = 'idle' | 'busy' | 'retry';

const RECENT_ABORT_WINDOW_MS = 2000;

const AUTO_SEND_RETRY_BASE_DELAY_MS = 2000;
const AUTO_SEND_RETRY_MAX_DELAY_MS = 60000;
/** Re-check soon after TURN_IN_PROGRESS when busy/idle edges may be missed. */
const TURN_IN_PROGRESS_WAKE_MS = 1500;

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

export const createQueuedAutoSendRetryScheduler = (
  onWake: () => void,
  now: () => number = Date.now,
  scheduleTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
  cancelTimeout: (timer: ReturnType<typeof setTimeout>) => void = clearTimeout,
) => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let scheduledAt: number | null = null;

  return {
    schedule(retryAt: number) {
      if (scheduledAt !== null && scheduledAt <= retryAt) return;
      if (timer !== null) cancelTimeout(timer);
      scheduledAt = retryAt;
      timer = scheduleTimeout(() => {
        timer = null;
        scheduledAt = null;
        onWake();
      }, Math.max(0, retryAt - now()));
    },
    dispose() {
      if (timer !== null) cancelTimeout(timer);
      timer = null;
      scheduledAt = null;
    },
  };
};

/**
 * When the abort window is still open, returns the time it expires so the
 * caller can wake the queue then. Returns `null` once sending is allowed
 * again — a queued item must not wait for an unrelated state change to be
 * retried after the window closes.
 */
const getAbortHoldUntil = (sessionId: string): number | null => {
  const abortRecord = useSessionUIStore.getState().sessionAbortFlags.get(sessionId);
  if (!abortRecord) {
    return null;
  }
  const holdUntil = abortRecord.timestamp + RECENT_ABORT_WINDOW_MS;
  return Date.now() < holdUntil ? holdUntil : null;
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
  directory: string,
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
    { sessionId, directory },
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
  currentStatusType: SessionStatusType | undefined,
  hasQueuedItems: boolean = false,
): boolean => {
  if (hasQueuedItems && currentStatusType === 'idle') return true;
  return (previousStatusType === 'busy' || previousStatusType === 'retry')
    && currentStatusType === 'idle';
};

/**
 * Prefer the live global busy index (covers Claude harness events even when a
 * directory child store missed them), then fall back to the directory store.
 */
export const resolveQueuedSessionStatusType = (
  sessionId: string,
  directory: string,
): SessionStatusType | undefined => {
  const globalEntry = useGlobalSessionStatusStore.getState().statusById.get(sessionId);
  if (globalEntry?.status?.type === 'busy' || globalEntry?.status?.type === 'retry') {
    return globalEntry.status.type;
  }
  const directoryState = getDirectoryState(directory);
  const directoryStatus = directoryState?.session_status?.[sessionId]?.type;
  if (directoryStatus === 'busy' || directoryStatus === 'retry') {
    return directoryStatus;
  }
  return directoryState?.sessionStatusLoaded === true ? 'idle' : undefined;
};

const isTurnInProgressError = (error: unknown): boolean => (
  error instanceof HarnessClientError && error.code === 'TURN_IN_PROGRESS'
);

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const autoReviewRuns = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  // Directory child-store status must wake this effect: optimistic busy and
  // some Claude turns land here first, while global absence alone does not
  // re-render when the directory flips busy→idle.
  const directorySessionStatus = useDirectorySync((state) => state.session_status);
  const directorySessionStatusLoaded = useDirectorySync((state) => state.sessionStatusLoaded === true);
  const globalStatusById = useGlobalSessionStatusStore((state) => state.statusById);

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const sendFailuresRef = React.useRef<Map<string, QueuedAutoSendFailure>>(new Map());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());
  const autoReviewBlockedSessionsRef = React.useRef<Set<string>>(new Set());
  const [retryTick, setRetryTick] = React.useState(0);
  const retryScheduler = React.useMemo(
    () => createQueuedAutoSendRetryScheduler(() => setRetryTick((value) => value + 1)),
    [],
  );

  React.useEffect(() => () => retryScheduler.dispose(), [retryScheduler]);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const dispatchSessionQueue = async (target: MessageQueueTarget, queueSnapshot: QueuedMessage[]) => {
      const { sessionId } = target;
      const targetKey = getMessageQueueKey(target);
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(targetKey)) {
        return;
      }
      const abortHoldUntil = getAbortHoldUntil(sessionId);
      if (abortHoldUntil !== null) {
        retryScheduler.schedule(abortHoldUntil);
        return;
      }
      if (useAutoReviewStore.getState().isRunningForSession(sessionId)) {
        autoReviewBlockedSessionsRef.current.add(sessionId);
        return;
      }

      const currentStatus = resolveQueuedSessionStatusType(sessionId, target.directory);
      if (currentStatus !== 'idle') {
        return;
      }

      const payload = buildQueuedAutoSendPayload(queueSnapshot);
      if (!payload) {
        return;
      }

      const failure = sendFailuresRef.current.get(targetKey);
      if (failure && failure.messageId !== payload.queuedMessageId) {
        sendFailuresRef.current.delete(targetKey);
      } else if (failure && isQueuedAutoSendBackedOff(failure, payload.queuedMessageId, Date.now())) {
        retryScheduler.schedule(failure.nextAttemptAt);
        return;
      }

      // Use send config captured at queue time; fall back to current config
      const captured = payload.sendConfig;
      const resolved = captured?.providerID && captured?.modelID
        ? captured
        : resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        // Legacy queues may predate captured send configuration. Config
        // hydration is asynchronous, so retry instead of stranding the item
        // until an unrelated status or directory update happens.
        retryScheduler.schedule(Date.now() + AUTO_SEND_RETRY_BASE_DELAY_MS);
        return;
      }

      inFlightSessionsRef.current.add(targetKey);

      try {
        await sendQueuedAutoSendPayload(sessionId, target.directory, payload, {
          providerID: resolved.providerID,
          modelID: resolved.modelID,
          agent: resolved.agent,
          variant: resolved.variant,
        });
        useMessageQueueStore.getState().removeFromQueue(target, payload.queuedMessageId);
        sendFailuresRef.current.delete(targetKey);
      } catch (error) {
        console.warn('[queue] queued auto-send failed:', error);
        if (isTurnInProgressError(error)) {
          // Claude turn still active — leave the item queued. Treat as busy so
          // the next idle edge (or wake timer) can dispatch instead of stalling
          // on idle→idle with no status Map change.
          sendFailuresRef.current.delete(targetKey);
          previousStatusRef.current.set(sessionId, 'busy');
          retryScheduler.schedule(Date.now() + TURN_IN_PROGRESS_WAKE_MS);
          return;
        }
        const priorFailures = failure?.messageId === payload.queuedMessageId ? failure.failures : 0;
        const failures = priorFailures + 1;
        const nextAttemptAt = Date.now() + getQueuedAutoSendRetryDelayMs(failures);
        sendFailuresRef.current.set(targetKey, {
          messageId: payload.queuedMessageId,
          failures,
          nextAttemptAt,
        });
        retryScheduler.schedule(nextAttemptAt);
      } finally {
        inFlightSessionsRef.current.delete(targetKey);
      }
    };

    const nextStatusMap = new Map(previousStatusRef.current);
    // Keep previous busy/retry edges for sessions that only appear in the
    // directory status map (optimistic send / child-store events).
    for (const [sessionId, status] of Object.entries(directorySessionStatus ?? {})) {
      if (status?.type === 'busy' || status?.type === 'retry') {
        nextStatusMap.set(sessionId, status.type);
      }
    }
    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([key, queue]) => {
      const target = parseMessageQueueKey(key);
      if (!target || target.runtimeKey !== getRuntimeKey()) return;
      const { sessionId } = target;
      const currentStatusType = resolveQueuedSessionStatusType(sessionId, target.directory);
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
        void dispatchSessionQueue(target, queue);
      }

      if (currentStatusType) {
        nextStatusMap.set(sessionId, currentStatusType);
      }
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, directorySessionStatus, directorySessionStatusLoaded, globalStatusById, autoReviewRuns, retryTick, retryScheduler]);
}
