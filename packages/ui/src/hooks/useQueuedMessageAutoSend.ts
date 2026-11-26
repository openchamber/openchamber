import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { getMessageQueueKey, parseMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { queuedContextToParts } from '@/components/chat/composer/submit/buildOutgoingMessage';
import { getDirectoryState } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { createInputHistorySubmission } from '@/stores/useInputHistoryStore';
import { buildSkillMentionInstruction } from '@/lib/skillMentionInstruction';

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

  return {
    queuedMessageId: queued.id,
    historySubmissions: [createInputHistorySubmission(queued.content, queued.attachments ?? [])],
    primaryText: queued.text,
    primaryAttachments: queued.attachments ?? [],
    agentMentionName: queued.agentMention,
    skillNames: queued.skills ?? [],
    additionalParts: queuedContextToParts(queued.context ?? []),
    sendConfig: queued.sendConfig,
    goal: queued.goal ?? null,
  };
};

type QueuedAutoSendPayload = NonNullable<ReturnType<typeof buildQueuedAutoSendPayload>>;
type ResolvedQueuedSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
  keepSessionModel?: boolean;
  keepSessionAgent?: boolean;
};

export const sendQueuedAutoSendPayload = (
  target: MessageQueueTarget,
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
    payload.additionalParts.length > 0 ? payload.additionalParts : undefined,
    resolved.variant,
    'normal',
    {
      target,
      historySubmissions: payload.historySubmissions,
      queuedGoal: payload.goal,
      ...(resolved.keepSessionModel && { keepSessionModel: true }),
      ...(resolved.keepSessionAgent && { keepSessionAgent: true }),
      ...(payload.skillNames.length > 0 && { skills: { names: payload.skillNames, instructionFor: buildSkillMentionInstruction } }),
    },
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

  const savedVariant =
    selectedAgent && providerID && modelID
      ? (() => {
        const live = selection.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID);
        return live !== undefined
          ? live
          : context.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID);
      })()
      : undefined;
  const variant = savedVariant ?? undefined;

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
  const sessionStatusRecord = useDirectorySync((state) => state.session_status);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const queuedSessionIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const key of Object.keys(queuedMessages)) {
      const target = parseMessageQueueKey(key);
      if (target && target.runtimeKey === getRuntimeKey() && target.directory === currentDirectory) ids.add(target.sessionId);
    }
    return [...ids].sort();
  }, [currentDirectory, queuedMessages]);
  const trailingMessageSignature = useDirectorySync(useShallow((state) => queuedSessionIds.map((sessionId) => {
    const messages = state.message[sessionId];
    const last = messages?.[messages.length - 1];
    if (!last) return '';
    const completed = last.role !== 'assistant' || last.time.completed !== undefined;
    return `${last.id}:${completed}`;
  })));

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const sendFailuresRef = React.useRef<Map<string, QueuedAutoSendFailure>>(new Map());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());
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
      const inFlightKey = `${target.runtimeKey}\n${sessionId}`;
      if (queueSnapshot.length === 0) {
        return;
      }
      if (inFlightSessionsRef.current.has(inFlightKey)) {
        return;
      }
      const abortHoldUntil = getAbortHoldUntil(sessionId);
      if (abortHoldUntil !== null) {
        retryScheduler.schedule(abortHoldUntil);
        return;
      }

      const currentStatus = resolveQueuedSessionStatusType(sessionId, target.directory);
      if (currentStatus !== 'idle') {
        return;
      }

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

      const captured = payload.sendConfig;
      const resolved = captured?.providerID && captured?.modelID
        ? captured
        : resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        retryScheduler.schedule(Date.now() + AUTO_SEND_RETRY_BASE_DELAY_MS);
        return;
      }

      inFlightSessionsRef.current.add(inFlightKey);
      useMessageQueueStore.getState().markSending(target, payload.queuedMessageId);

      try {
        await sendQueuedAutoSendPayload(target, payload, {
          providerID: resolved.providerID,
          modelID: resolved.modelID,
          agent: resolved.agent,
          variant: resolved.variant,
          keepSessionModel: resolved !== captured || captured?.keepSessionModel === true,
          keepSessionAgent: resolved !== captured || captured?.keepSessionAgent === true,
        });
        const queue = useMessageQueueStore.getState();
        queue.removeFromQueue(queue.locateQueuedMessage(target, payload.queuedMessageId), payload.queuedMessageId);
        sendFailuresRef.current.delete(targetKey);
      } catch (error) {
        console.warn('[queue] queued auto-send failed:', error);
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
        inFlightSessionsRef.current.delete(inFlightKey);
        const queue = useMessageQueueStore.getState();
        queue.clearSending(queue.locateQueuedMessage(target, payload.queuedMessageId), payload.queuedMessageId);
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
      if (queue.length > 0 && shouldDispatchQueuedAutoSend(previousStatusType, currentStatusType, queue.length > 0)) {
        void dispatchSessionQueue(target, queue);
      }

      nextStatusMap.set(sessionId, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, sessionStatusRecord, trailingMessageSignature, currentDirectory, retryTick, retryScheduler]);
}
