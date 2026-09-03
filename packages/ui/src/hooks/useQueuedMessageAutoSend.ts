import React from 'react';
import { getMessageQueueDirectoryKey, getMessageQueueKey, parseMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { isAutoReviewRunActiveForTarget, useAutoReviewStore } from '@/stores/useAutoReviewStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getDirectoryState } from '@/sync/sync-refs';
import { useChildStoreManager, useDirectorySync } from '@/sync/sync-context';
import type { ChildStoreManager } from '@/sync/child-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { buildContextParts } from '@/components/chat/composer/submit/buildOutgoingMessage';
import { consumeComposerContext, queuedContextTarget, type ComposerContextSnapshot } from '@/components/chat/composer/submit/contextHandoff';

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

export const buildQueuedAutoSendPayload = (
  queue: QueuedMessage[],
  context: ComposerContextSnapshot = { inlineComments: [], syntheticParts: [] },
) => {
  const queued = queue[0];
  if (!queued) {
    return null;
  }

  const agents = useConfigStore.getState().getVisibleAgents();
  const { sanitizedText, mention } = parseAgentMentions(queued.content, agents);

  const contextParts = buildContextParts(context.inlineComments, context.syntheticParts);
  const queuedAdditionalParts = queued.additionalParts;
  const additionalParts = contextParts.length === 0
    ? queuedAdditionalParts
    : [...(queuedAdditionalParts ?? []), ...contextParts];

  return {
    queuedMessageId: queued.id,
    primaryText: sanitizedText,
    primaryAttachments: queued.attachments ?? [],
    agentMentionName: mention?.name,
    additionalParts,
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
    payload.additionalParts,
    resolved.variant,
    'normal',
    { target },
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
  if (statusType === 'busy' || statusType === 'retry' || statusType === 'idle') {
    return statusType;
  }
  const sessionMessages = state?.message?.[sessionId];
  const lastMessage = sessionMessages && sessionMessages.length > 0
    ? sessionMessages[sessionMessages.length - 1]
    : undefined;
  if (
    lastMessage?.role === 'assistant'
    && lastMessage.time?.completed === undefined
  ) {
    return 'busy';
  }
  return 'idle';
};

const getReadyQueuedTargetState = (target: MessageQueueTarget) => {
  if (target.runtimeKey !== getRuntimeKey()) return undefined;
  const state = getDirectoryState(target.directory);
  // Directory bootstrap flips status complete before its authoritative session
  // list finishes, so the source marker is part of the readiness contract.
  return state?.status === 'complete' && state.sessionListSource === 'authoritative' ? state : undefined;
};

export const isQueuedSendBlockedForTarget = (target: MessageQueueTarget): boolean => {
  if (!getReadyQueuedTargetState(target)) return true;
  const autoReviewRun = useAutoReviewStore.getState().runsByOriginalSessionID[target.sessionId];
  return resolveQueuedSessionStatusType(target.sessionId, target.directory) !== 'idle'
    || isAutoReviewRunActiveForTarget(autoReviewRun, target);
};

const useQueuedTargetSyncRevision = (
  childStores: ChildStoreManager,
  targetKeys: readonly string[],
): number => {
  const revisionRef = React.useRef(0);
  const targetKeySignature = targetKeys.join('\u0000');
  // Queue targets can outlive the currently selected directory. Subscribe to
  // only their stores, plus registry/bootstrap changes so an unready target
  // is retried when its authoritative directory state arrives.
  const subscribe = React.useCallback((notify: () => void) => {
    const invalidate = () => {
      revisionRef.current += 1;
      notify();
    };
    const unsubscribers = [
      childStores.subscribeRegistry(invalidate),
      childStores.subscribeBootstrap(invalidate),
    ];
    const targetSessionIdsByDirectory = new Map<string, Set<string>>();
    const keys = targetKeySignature ? targetKeySignature.split('\u0000') : [];
    for (const key of keys) {
      const target = parseMessageQueueKey(key);
      if (!target) continue;
      let sessionIds = targetSessionIdsByDirectory.get(target.directory);
      if (!sessionIds) {
        sessionIds = new Set<string>();
        targetSessionIdsByDirectory.set(target.directory, sessionIds);
      }
      sessionIds.add(target.sessionId);
    }
    for (const [directory, sessionIds] of targetSessionIdsByDirectory) {
      const store = childStores.getChild(directory);
      if (!store) continue;
      unsubscribers.push(store.subscribe((state, previous) => {
        if (state.status !== previous.status || state.sessionListSource !== previous.sessionListSource) {
          invalidate();
          return;
        }
        for (const sessionId of sessionIds) {
          if (
            state.session_status[sessionId] !== previous.session_status[sessionId]
            || state.message[sessionId] !== previous.message[sessionId]
          ) {
            invalidate();
            return;
          }
        }
      }));
    }
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [childStores, targetKeySignature]);
  const getSnapshot = React.useCallback(() => revisionRef.current, []);
  return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

type QueuedBootstrapRequest = {
  failures: number;
  nextAttemptAt: number | null;
};

const requestQueuedTargetBootstrap = (childStores: ChildStoreManager, target: MessageQueueTarget): void => {
  if (target.runtimeKey !== getRuntimeKey()) return;

  const state = childStores.getState(target.directory);
  if (state?.status === 'complete' && state.sessionListSource === 'authoritative') return;

  const bootstrapState = childStores.getBootstrapState(target.directory);
  if (bootstrapState === 'queued' || bootstrapState === 'running') return;

  childStores.requestBootstrap({
    directory: target.directory,
    priority: 'selected',
    reason: 'selected-session',
    // A completed/failed bootstrap can still have a non-authoritative session
    // list after a partial child-session fetch. Force the explicit target
    // demand to retry that directory instead of trusting stale roots.
    force: bootstrapState === 'complete'
      || bootstrapState === 'failed'
      || state?.status === 'complete'
      || state?.sessionListSource === 'partial',
  });
};

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const sendingIds = useMessageQueueStore((state) => state.sendingIds);
  const autoReviewRuns = useAutoReviewStore((state) => state.runsByOriginalSessionID);
  const sessionStatusRecord = useDirectorySync((state) => state.session_status);
  // Message completion clears the in-flight fallback in
  // resolveQueuedSessionStatusType; subscribe so the queue drains the moment
  // the trailing assistant message completes even if status events were missed.
  const sessionMessages = useDirectorySync((state) => state.message);
  const childStores = useChildStoreManager();
  const activeRuntimeKey = getRuntimeKey();
  const queuedTargetKeys = React.useMemo(() => {
    return Object.keys(queuedMessages).filter((key) => {
      const target = parseMessageQueueKey(key);
      return target?.runtimeKey === activeRuntimeKey;
    }).sort();
  }, [activeRuntimeKey, queuedMessages]);
  const queuedBootstrapTargets = React.useMemo(() => {
    const targetsByDirectory = new Map<string, MessageQueueTarget>();
    for (const key of queuedTargetKeys) {
      const target = parseMessageQueueKey(key);
      if (!target) continue;
      const directoryKey = getMessageQueueDirectoryKey(target);
      if (!targetsByDirectory.has(directoryKey)) targetsByDirectory.set(directoryKey, target);
    }
    return [...targetsByDirectory.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [queuedTargetKeys]);
  const queuedTargetSyncRevision = useQueuedTargetSyncRevision(childStores, queuedTargetKeys);
  const [retryTick, setRetryTick] = React.useState(0);
  const retryScheduler = React.useMemo(
    () => createQueuedAutoSendRetryScheduler(() => setRetryTick((value) => value + 1)),
    [],
  );
  const requestedBootstrapDirectoriesRef = React.useRef<Map<string, QueuedBootstrapRequest>>(new Map());

  React.useEffect(() => () => retryScheduler.dispose(), [retryScheduler]);

  React.useEffect(() => {
    const activeDirectoryKeys = new Set(queuedBootstrapTargets.map(([directoryKey]) => directoryKey));
    for (const key of requestedBootstrapDirectoriesRef.current.keys()) {
      if (!activeDirectoryKeys.has(key)) requestedBootstrapDirectoriesRef.current.delete(key);
    }
    if (!enabled) return;

    const now = Date.now();
    for (const [directoryKey, target] of queuedBootstrapTargets) {
      if (getReadyQueuedTargetState(target)) {
        requestedBootstrapDirectoriesRef.current.delete(directoryKey);
        continue;
      }

      const state = childStores.getState(target.directory);
      const bootstrapState = childStores.getBootstrapState(target.directory);
      const bootstrapNeedsRetry = bootstrapState === 'failed'
        || state?.sessionListSource === 'partial'
        || (bootstrapState === 'complete' && state?.sessionListSource !== 'authoritative');
      const requested = requestedBootstrapDirectoriesRef.current.get(directoryKey);
      if (requested) {
        if (!bootstrapNeedsRetry) {
          // A scheduler or another consumer may have started the retry. Wait
          // for that run's result instead of issuing a duplicate request.
          if (bootstrapState === 'queued' || bootstrapState === 'running') continue;
          continue;
        }

        if (requested.nextAttemptAt === null) {
          requested.failures += 1;
          requested.nextAttemptAt = now + getQueuedAutoSendRetryDelayMs(requested.failures);
        }
        if (now < requested.nextAttemptAt) {
          retryScheduler.schedule(requested.nextAttemptAt);
          continue;
        }
        requested.nextAttemptAt = null;
      } else {
        requestedBootstrapDirectoriesRef.current.set(directoryKey, { failures: 0, nextAttemptAt: null });
      }

      requestQueuedTargetBootstrap(childStores, target);
    }
  }, [activeRuntimeKey, childStores, enabled, queuedBootstrapTargets, queuedTargetSyncRevision, retryScheduler, retryTick]);

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const sendFailuresRef = React.useRef<Map<string, QueuedAutoSendFailure>>(new Map());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());
  const autoReviewBlockedTargetsRef = React.useRef<Set<string>>(new Set());

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
      if (!getReadyQueuedTargetState(target)) {
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
      const autoReviewRun = useAutoReviewStore.getState().runsByOriginalSessionID[sessionId];
      if (isAutoReviewRunActiveForTarget(autoReviewRun, target)) {
        autoReviewBlockedTargetsRef.current.add(targetKey);
        return;
      }

      const currentStatus = resolveQueuedSessionStatusType(sessionId, target.directory);
      if (currentStatus !== 'idle') {
        return;
      }

      // Read the queue back at dispatch time. The store returns no sendable
      // item while this target already has an unresolved queued send.
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
      // Capture the deletion guard before publishing the claim. Deletion can
      // run synchronously from another queue transition while markSending is
      // returning.
      const queueStore = useMessageQueueStore.getState();
      const sendQueueGuard = queueStore.getQueueRestorationGuard(target);
      // The ref only guards this hook. Publish the dispatch to the store so the
      // composer cannot merge the same item into a parallel send while this one
      // is still awaiting the server.
      if (!queueStore.markSending(target, payload.queuedMessageId)) {
        inFlightSessionsRef.current.delete(targetKey);
        return;
      }

      if (!queueStore.isQueueRestorationGuardCurrent(target, sendQueueGuard)) {
        // Deletion keeps a claimed item visible until its request settles. This
        // transition drops the item and its claim without restoring context or
        // scheduling a retry for the deleted target.
        queueStore.completeSending(target, payload.queuedMessageId);
        inFlightSessionsRef.current.delete(targetKey);
        return;
      }

      const claimedMessage = queueStore.getQueueForTarget(target)
        .find((message) => message.id === payload.queuedMessageId);
      const context = claimedMessage?.contextClaimed
        ? { inlineComments: [], syntheticParts: [], restore: () => undefined }
        : consumeComposerContext(target, queuedContextTarget(target), sendQueueGuard);
      const payloadWithContext = buildQueuedAutoSendPayload(
        claimedMessage ? [claimedMessage] : [],
        context,
      );
      if (!payloadWithContext || payloadWithContext.queuedMessageId !== payload.queuedMessageId) {
        context.restore();
        useMessageQueueStore.getState().clearSending(target, payload.queuedMessageId);
        inFlightSessionsRef.current.delete(targetKey);
        return;
      }

      let queueEntrySettled = false;
      try {
        await sendQueuedAutoSendPayload(target, payloadWithContext, {
          providerID: resolved.providerID,
          modelID: resolved.modelID,
          agent: resolved.agent,
          variant: resolved.variant,
        });
        useMessageQueueStore.getState().completeSending(target, payload.queuedMessageId);
        queueEntrySettled = true;
        sendFailuresRef.current.delete(targetKey);
      } catch (error) {
        console.warn('[queue] queued auto-send failed:', error);
        const queueStore = useMessageQueueStore.getState();
        const targetWasDeleted = target.runtimeKey === getRuntimeKey()
          && !queueStore.isQueueRestorationGuardCurrent(target, sendQueueGuard);
        if (targetWasDeleted) {
          // Session deletion keeps an in-flight item visible until its request
          // settles. Drop that item and its claim atomically, but never restore
          // its context or schedule a retry for the deleted session.
          queueStore.completeSending(target, payload.queuedMessageId);
          queueEntrySettled = true;
          return;
        }
        context.restore();
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
        if (!queueEntrySettled) {
          useMessageQueueStore.getState().clearSending(target, payload.queuedMessageId);
        }
      }
    };

    const nextStatusMap = new Map(previousStatusRef.current);

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([key, queue]) => {
      const target = parseMessageQueueKey(key);
      if (!target || target.runtimeKey !== getRuntimeKey() || !getReadyQueuedTargetState(target)) return;
      const { sessionId } = target;
      const currentStatusType = resolveQueuedSessionStatusType(sessionId, target.directory);
      const targetKey = getMessageQueueKey(target);
      const previousStatusType = previousStatusRef.current.get(targetKey);
      const wasAutoReviewBlocked = autoReviewBlockedTargetsRef.current.has(targetKey);
      const autoReviewRun = useAutoReviewStore.getState().runsByOriginalSessionID[sessionId];
      const isAutoReviewRunning = isAutoReviewRunActiveForTarget(autoReviewRun, target);
      if (isAutoReviewRunning) {
        autoReviewBlockedTargetsRef.current.add(targetKey);
      } else if (wasAutoReviewBlocked) {
        autoReviewBlockedTargetsRef.current.delete(targetKey);
      }

      if (queue.length > 0 && (
        shouldDispatchQueuedAutoSend(previousStatusType, currentStatusType, queue.length > 0)
        || (wasAutoReviewBlocked && !isAutoReviewRunning && currentStatusType === 'idle')
      )) {
        void dispatchSessionQueue(target, queue);
      }

      nextStatusMap.set(targetKey, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [activeRuntimeKey, enabled, queuedMessages, sendingIds, sessionStatusRecord, sessionMessages, autoReviewRuns, queuedTargetSyncRevision, retryTick, retryScheduler]);
}
