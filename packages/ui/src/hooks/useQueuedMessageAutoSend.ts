import React from 'react';
import { getMessageQueueKey, MESSAGE_QUEUE_STORAGE_KEY, parseMessageQueueKey, useMessageQueueStore, withMessageQueueStateLock, withMessageQueueTargetLock, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getDirectoryState } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';

type SessionStatusType = 'idle' | 'busy' | 'retry';

const RECENT_ABORT_WINDOW_MS = 2000;

const AUTO_SEND_RETRY_BASE_DELAY_MS = 2000;
const AUTO_SEND_RETRY_MAX_DELAY_MS = 60000;
const QUEUE_LOCK_RETRY_DELAY_MS = 250;

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
    sendAttempt: queued.sendAttempt,
    additionalParts: queued.additionalParts,
  };
};

type QueuedAutoSendPayload = NonNullable<ReturnType<typeof buildQueuedAutoSendPayload>>;
type ResolvedQueuedSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

type QueuedAutoSendOptions = {
  target: MessageQueueTarget;
  messageID?: string;
  onMessageID?: (messageID: string) => void | Promise<void>;
  beforeSend?: () => void | Promise<void>;
  onSendFailure?: (ambiguous: boolean) => void;
};

export const sendQueuedAutoSendPayload = (
  target: MessageQueueTarget,
  payload: QueuedAutoSendPayload,
  resolved: ResolvedQueuedSendConfig,
  onMessageID?: (messageID: string) => void | Promise<void>,
  beforeSend?: () => void | Promise<void>,
  onSendFailure?: (ambiguous: boolean) => void,
) => {
  const options: QueuedAutoSendOptions = { target };
  if (payload.sendAttempt) options.messageID = payload.sendAttempt.messageID;
  if (onMessageID) options.onMessageID = onMessageID;
  if (beforeSend) options.beforeSend = beforeSend;
  if (onSendFailure) options.onSendFailure = onSendFailure;
  return useSessionUIStore.getState().sendMessage(
    payload.primaryText,
    resolved.providerID,
    resolved.modelID,
    resolved.agent,
    payload.primaryAttachments,
    payload.agentMentionName,
    payload.additionalParts,
    resolved.variant,
    'normal',
    options,
  );
};

export const reconcileQueuedAutoSendAttempt = async (
  target: MessageQueueTarget,
  queuedMessageId: string,
  messageID: string,
): Promise<boolean> => {
  if (target.runtimeKey !== getRuntimeKey()) {
    throw new Error('Queued send reconciliation was cancelled because the runtime changed.');
  }
  const confirmed = await opencodeClient.findSessionMessage(target.sessionId, messageID, target.directory);
  if (target.runtimeKey !== getRuntimeKey()) {
    throw new Error('Queued send reconciliation was cancelled because the runtime changed.');
  }
  if (!confirmed) return false;
  await useMessageQueueStore.getState().removeFromQueue(target, queuedMessageId);
  return true;
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

/**
 * Resolve the live status the queue gate should honor for a session.
 *
 * The server's `/session/status` map only lists busy/retry sessions — idle
 * sessions are absent — so a missing entry means "idle per the snapshot", not
 * "no information". A missed busy event therefore leaves no entry while a turn
 * is still streaming. The trailing in-flight assistant message is the live
 * evidence of that running turn: treat it as busy so the queue never dispatches
 * into it (mirrors `useSessionActivity`'s fallback). The entry becomes idle the
 * moment the message completes or an idle status event lands. This reads the
 * directory child store directly so both the effect-loop gate and the
 * dispatch-time re-check agree.
 */
export const resolveQueuedSessionStatusType = (
  sessionId: string,
  directory: string,
): SessionStatusType => {
  const state = getDirectoryState(directory);
  const statusType = state?.session_status?.[sessionId]?.type;
  if (statusType === 'busy' || statusType === 'retry') {
    return statusType;
  }
  const sessionMessages = state?.message?.[sessionId];
  const lastMessage = sessionMessages && sessionMessages.length > 0
    ? sessionMessages[sessionMessages.length - 1]
    : undefined;
  if (
    lastMessage?.role === 'assistant'
    && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number'
  ) {
    return 'busy';
  }
  return 'idle';
};

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const autoReviewRuns = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  const sessionStatusRecord = useDirectorySync((state) => state.session_status);
  // Message completion clears the in-flight fallback in
  // resolveQueuedSessionStatusType; subscribe so the queue drains the moment
  // the trailing assistant message completes even if status events were missed.
  const sessionMessages = useDirectorySync((state) => state.message);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

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
    if (!globalThis.window) return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== MESSAGE_QUEUE_STORAGE_KEY) return;
      void withMessageQueueStateLock(() => undefined).catch((error) => {
        console.warn('[queue] failed to hydrate an external queue update:', error);
      });
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

    const dispatchSessionQueue = async (
      target: MessageQueueTarget,
      queueSnapshot: QueuedMessage[],
      lockHeld = false,
    ) => {
      const { sessionId } = target;
      const targetKey = getMessageQueueKey(target);
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(targetKey)) {
        return;
      }
      if (!lockHeld) {
        const acquired = await withMessageQueueTargetLock(
          target,
          () => dispatchSessionQueue(target, queueSnapshot, true),
          { ifAvailable: true },
        );
        if (!acquired && globalThis.navigator?.locks) {
          retryScheduler.schedule(Date.now() + QUEUE_LOCK_RETRY_DELAY_MS);
        }
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

      // Read the queue back at dispatch time and skip anything already being
      // delivered, rather than trusting the render-time snapshot.
      const payload = buildQueuedAutoSendPayload(useMessageQueueStore.getState().getSendableQueue(target));
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

      const scheduleFailure = () => {
        const priorFailures = failure?.messageId === payload.queuedMessageId ? failure.failures : 0;
        const failures = priorFailures + 1;
        const nextAttemptAt = Date.now() + getQueuedAutoSendRetryDelayMs(failures);
        sendFailuresRef.current.set(targetKey, {
          messageId: payload.queuedMessageId,
          failures,
          nextAttemptAt,
        });
        retryScheduler.schedule(nextAttemptAt);
      };

      if (payload.sendAttempt?.dispatched) {
        inFlightSessionsRef.current.add(targetKey);
        let markedSending = false;
        try {
          markedSending = await useMessageQueueStore.getState().markSending(target, payload.queuedMessageId);
          if (!markedSending) return;
          const confirmed = await reconcileQueuedAutoSendAttempt(
            target,
            payload.queuedMessageId,
            payload.sendAttempt.messageID,
          );
          if (confirmed) {
            sendFailuresRef.current.delete(targetKey);
          } else {
            // A reload loses the original request promise. A 404 does not prove
            // the request was never admitted, so keep reconciling but never
            // auto-send an outcome-unknown attempt again.
            scheduleFailure();
          }
        } catch (error) {
          console.warn('[queue] queued auto-send reconciliation failed:', error);
          scheduleFailure();
        } finally {
          inFlightSessionsRef.current.delete(targetKey);
          if (markedSending) {
            await useMessageQueueStore.getState().clearSending(target, payload.queuedMessageId).catch((error) => {
              console.warn('[queue] failed to clear queued reconciliation state:', error);
            });
          }
        }
        return;
      }

      const currentStatus = resolveQueuedSessionStatusType(sessionId, target.directory);
      if (currentStatus !== 'idle') {
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
      // The ref only guards this hook. Publish the dispatch to the store so the
      // composer cannot merge the same item into a parallel send while this one
      // is still awaiting the server.
      let outcomeUnknown = false;
      let markedSending = false;
      let queuedMessageID: string | undefined;
      let sendAcknowledged = false;
      try {
        markedSending = await useMessageQueueStore.getState().markSending(target, payload.queuedMessageId);
        if (!markedSending) return;
        await sendQueuedAutoSendPayload(target, payload, {
          providerID: resolved.providerID,
          modelID: resolved.modelID,
          agent: resolved.agent,
          variant: resolved.variant,
        }, async (messageID) => {
          queuedMessageID = messageID;
          const recorded = await useMessageQueueStore.getState().recordSendAttempt(target, payload.queuedMessageId, messageID);
          if (!recorded) throw new Error('Queued send was cancelled before dispatch.');
        }, async () => {
          if (!queuedMessageID) throw new Error('Queued send has no durable message ID.');
          const active = await useMessageQueueStore.getState().markSendAttemptDispatched(
            target,
            payload.queuedMessageId,
            queuedMessageID,
          );
          if (!active) throw new Error('Queued send was cancelled before dispatch.');
        }, (ambiguous) => {
          outcomeUnknown = ambiguous;
        });
        sendAcknowledged = true;
        await useMessageQueueStore.getState().removeFromQueue(target, payload.queuedMessageId);
        sendFailuresRef.current.delete(targetKey);
      } catch (error) {
        if (sendAcknowledged) {
          console.warn('[queue] queued send succeeded but cleanup failed:', error);
          scheduleFailure();
          return;
        }
        console.warn('[queue] queued auto-send failed:', error);
        // Definite rejection can use the existing retry path. An unresolved
        // transport failure keeps its message ID and switches to exact-message
        // reconciliation, because the server may still admit the first request.
        if (!outcomeUnknown) {
          await useMessageQueueStore.getState().clearSendAttempt(target, payload.queuedMessageId);
        }
        scheduleFailure();
      } finally {
        inFlightSessionsRef.current.delete(targetKey);
        if (markedSending) {
          await useMessageQueueStore.getState().clearSending(target, payload.queuedMessageId).catch((error) => {
            console.warn('[queue] failed to clear queued send state:', error);
          });
        }
      }
    };

    const statusRecord = sessionStatusRecord ?? {};
    const nextStatusMap = new Map(previousStatusRef.current);
    for (const [sessionId, status] of Object.entries(statusRecord)) {
      if (status) {
        nextStatusMap.set(sessionId, status.type as SessionStatusType);
      }
    }

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([key, queue]) => {
      const target = parseMessageQueueKey(key);
      if (!target || target.runtimeKey !== getRuntimeKey() || target.directory !== currentDirectory) return;
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

      nextStatusMap.set(sessionId, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, sessionStatusRecord, sessionMessages, autoReviewRuns, currentDirectory, retryTick, retryScheduler]);
}
