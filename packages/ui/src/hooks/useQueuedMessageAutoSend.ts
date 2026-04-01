import React from 'react';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useConfigStore } from '@/stores/useConfigStore';
import { useContextStore } from '@/stores/contextStore';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { getSyncSessionStatus } from '@/sync/sync-refs';
import { useDirectorySync } from '@/sync/sync-context';

type SessionStatusType = 'idle' | 'busy' | 'retry';

const RECENT_ABORT_WINDOW_MS = 2000;

const hasRecentAbort = (sessionId: string): boolean => {
  const abortRecord = useSessionUIStore.getState().sessionAbortFlags.get(sessionId);
  if (!abortRecord) {
    return false;
  }
  return Date.now() - abortRecord.timestamp < RECENT_ABORT_WINDOW_MS;
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

export function useQueuedMessageAutoSend(enabledOrOptions?: boolean | { enabled?: boolean }) {
  const enabled = typeof enabledOrOptions === 'boolean' ? enabledOrOptions : (enabledOrOptions?.enabled ?? true);
  const queuedMessages = useMessageQueueStore((state) => state.queuedMessages);
  const sessionStatusRecord = useDirectorySync((state) => state.session_status);

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

      const currentStatus = getSyncSessionStatus(sessionId)?.type ?? 'idle';
      if (currentStatus !== 'idle') {
        return;
      }

      const payload = buildQueuedPayload(queueSnapshot);
      if (!payload.primaryText && !payload.additionalParts?.length) {
        return;
      }

      // Use send config captured at queue time; fall back to current config
      const captured = queueSnapshot[0]?.sendConfig;
      const resolved = captured?.providerID && captured?.modelID
        ? captured
        : resolveSessionSendConfig(sessionId);
      if (!resolved.providerID || !resolved.modelID) {
        return;
      }

      inFlightSessionsRef.current.add(sessionId);

      try {
        await useSessionUIStore.getState().sendMessage(
          payload.primaryText,
          resolved.providerID,
          resolved.modelID,
          resolved.agent,
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
        console.warn('[queue] queued auto-send failed:', error);
      } finally {
        inFlightSessionsRef.current.delete(sessionId);
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
    queueEntries.forEach(([sessionId, queue]) => {
      const currentStatusType = (statusRecord[sessionId]?.type ?? 'idle') as SessionStatusType;
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
  }, [enabled, queuedMessages, sessionStatusRecord]);
}
