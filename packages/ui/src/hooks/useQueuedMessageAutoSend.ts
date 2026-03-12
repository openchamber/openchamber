import React from 'react';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useMessageStore } from '@/stores/messageStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';

type SessionStatusType = 'idle' | 'busy' | 'retry';

const RECENT_ABORT_WINDOW_MS = 2000;

const hasRecentAbort = (sessionId: string): boolean => {
  const abortRecord = useSessionStore.getState().sessionAbortFlags.get(sessionId);
  if (!abortRecord) {
    return false;
  }
  return Date.now() - abortRecord.timestamp < RECENT_ABORT_WINDOW_MS;
};

const setSessionStatus = (sessionId: string, type: SessionStatusType) => {
  useSessionStore.setState((state) => {
    const next = new Map(state.sessionStatus ?? new Map());
    next.set(sessionId, { type });
    return { sessionStatus: next };
  });
};

const buildQueuedPayload = (queue: QueuedMessage[]) => {
  const agents = useConfigStore.getState().getVisibleAgents();
  let primaryText = '';
  let primaryAttachments: AttachedFile[] = [];
  let agentMentionName: string | undefined;
  const additionalParts: Array<{ text: string; attachments?: AttachedFile[] }> = [];

  for (let i = 0; i < queue.length; i += 1) {
    const queued = queue[i];
    const { sanitizedText, mention } = parseAgentMentions(queued.content, agents);

    if (!agentMentionName && mention?.name) {
      agentMentionName = mention.name;
    }

    if (i === 0) {
      primaryText = sanitizedText;
      primaryAttachments = queued.attachments ?? [];
    } else {
      additionalParts.push({
        text: sanitizedText,
        attachments: queued.attachments,
      });
    }
  }

  return {
    primaryText,
    primaryAttachments,
    agentMentionName,
    additionalParts: additionalParts.length > 0 ? additionalParts : undefined,
  };
};

const resolveSessionSendConfig = (sessionId: string) => {
  const context = useContextStore.getState();
  const config = useConfigStore.getState();
  const message = useMessageStore.getState();

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
    ?? message.lastUsedProvider?.providerID;
  const modelID =
    agentModel?.modelId
    ?? sessionModel?.modelId
    ?? config.currentModelId
    ?? message.lastUsedProvider?.modelID;

  const variant =
    selectedAgent && providerID && modelID
      ? context.getAgentModelVariantForSession(sessionId, selectedAgent, providerID, modelID)
      : undefined;

  return {
    providerID,
    modelID,
    agent: selectedAgent,
    variant,
  };
};

export function useQueuedMessageAutoSend(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const sessionStatus = useSessionStore((state) => state.sessionStatus);

  const inFlightSessionsRef = React.useRef<Set<string>>(new Set());
  const previousStatusRef = React.useRef<Map<string, SessionStatusType>>(new Map());

  React.useEffect(() => {
    if (!enabled) {
      return;
    }

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

      const currentStatus = useSessionStore.getState().sessionStatus?.get(sessionId)?.type ?? 'idle';
      if (currentStatus !== 'idle') {
        return;
      }

      const payload = buildQueuedPayload(queueSnapshot);
      if (!payload.primaryText && !payload.additionalParts?.length) {
        return;
      }

      const resolved = resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        return;
      }

      inFlightSessionsRef.current.add(sessionId);
      setSessionStatus(sessionId, 'busy');

      try {
        await useMessageStore.getState().sendMessage(
          payload.primaryText,
          resolved.providerID,
          resolved.modelID,
          resolved.agent,
          sessionId,
          payload.primaryAttachments,
          payload.agentMentionName,
          payload.additionalParts,
          resolved.variant,
          'normal'
        );

        const removeFromQueue = useMessageQueueStore.getState().removeFromQueue;
        queueSnapshot.forEach((item) => {
          removeFromQueue(sessionId, item.id);
        });
      } catch (error) {
        setSessionStatus(sessionId, 'idle');
        console.warn('[queue] queued auto-send failed:', error);
      } finally {
        inFlightSessionsRef.current.delete(sessionId);
      }
    };

    const nextStatusMap = new Map(previousStatusRef.current);
    const statusEntries = sessionStatus ? Array.from(sessionStatus.entries()) : [];
    statusEntries.forEach(([sessionId, status]) => {
      nextStatusMap.set(sessionId, status.type);
    });

    const queueEntries = Object.entries(queuedMessages);
    queueEntries.forEach(([sessionId, queue]) => {
      const currentStatusType = (sessionStatus?.get(sessionId)?.type ?? 'idle') as SessionStatusType;
      const previousStatusType = previousStatusRef.current.get(sessionId);
      const becameIdle =
        (previousStatusType === 'busy' || previousStatusType === 'retry')
        && currentStatusType === 'idle';
      const firstSeenIdle = previousStatusType === undefined && currentStatusType === 'idle';

      if (queue.length > 0 && (becameIdle || firstSeenIdle)) {
        void dispatchSessionQueue(sessionId, queue);
      }

      nextStatusMap.set(sessionId, currentStatusType);
    });

    previousStatusRef.current = nextStatusMap;
  }, [enabled, queuedMessages, sessionStatus]);
}
