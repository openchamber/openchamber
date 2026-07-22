import type { Session } from '@opencode-ai/sdk/v2';

import { getLatestCompletedAssistantMessageId } from '@/components/chat/openChamberCommands';
import { focusEmbeddedSessionChatComposer } from '@/components/layout/contextPanelEmbeddedChat';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { captureSideChatRuntimeOperation, type SideChatRuntimeOperation } from '@/lib/sideChats/runtimeOperation';
import { getDisposableSideChatParentID } from '@/lib/opencode/sideChatMetadata';
import { useDisposableSideChatsStore } from '@/stores/useDisposableSideChatsStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { optimisticSend } from '@/sync/session-actions';
import { serializeDisposableSideChatSend } from '@/components/layout/disposableSideChatLifecycle';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getSyncMessages, registerSessionDirectory } from '@/sync/sync-refs';

export type OpenDisposableSideChatInput = {
  parentSessionId: string;
  directory: string;
  prompt: string;
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

const openDisposableSideChatPanel = (directory: string, session: { id: string; title?: string | null }): void => {
  const ownership = useDisposableSideChatsStore.getState().findBySide(getRuntimeKey(), directory, session.id);
  useUIStore.getState().openContextPanelTab(directory, {
    mode: 'chat',
    dedupeKey: `session:${session.id}`,
    sessionTitleFallback: session.title ?? null,
    readOnly: false,
    disposableSideChat: ownership ? {
      runtimeKey: ownership.runtimeKey,
      directory: ownership.directory,
      parentSessionId: ownership.parentSessionId,
      sideSessionId: session.id,
    } : null,
  });
  if (!focusEmbeddedSessionChatComposer(session.id) && typeof window !== 'undefined') {
    window.setTimeout(() => focusEmbeddedSessionChatComposer(session.id), 0);
  }
};

type SideChatFailurePayload = { error?: string; forkSessionID?: string; cleanupRequired?: boolean };

const sendSideChatPrompt = async (
  identity: { runtimeKey: string; directory: string; parentSessionId: string; sideSessionId: string },
  input: OpenDisposableSideChatInput,
  operation: SideChatRuntimeOperation,
): Promise<void> => {
  if (!input.prompt) return;
  await serializeDisposableSideChatSend(identity, () => optimisticSend({
    sessionId: identity.sideSessionId,
    directory: input.directory,
    content: input.prompt,
    providerID: input.providerID,
    modelID: input.modelID,
    agent: input.agent,
    send: async (messageID) => {
      const result = await operation.client.session.promptAsync({
        sessionID: identity.sideSessionId,
        directory: input.directory,
        model: { providerID: input.providerID, modelID: input.modelID },
        agent: input.agent,
        variant: input.variant,
        messageID,
        parts: [{ type: 'text', text: input.prompt }],
      });
      if (result.error) throw new Error('Side chat send failed');
    },
  }));
};

export async function openDisposableSideChat(input: OpenDisposableSideChatInput): Promise<{ sessionId: string; created: boolean }> {
  const runtimeKey = getRuntimeKey();
  const operation = captureSideChatRuntimeOperation();
  const target = { runtimeKey, directory: input.directory, parentSessionId: input.parentSessionId };
  const existing = useDisposableSideChatsStore.getState().findByParent(target);
  if (existing?.sideSessionId) {
    openDisposableSideChatPanel(input.directory, { id: existing.sideSessionId });
    await sendSideChatPrompt({ ...target, sideSessionId: existing.sideSessionId }, input, operation);
    return { sessionId: existing.sideSessionId, created: false };
  }
  if (existing) throw new Error('Side chat is still opening');

  const messageID = getLatestCompletedAssistantMessageId(getSyncMessages(input.parentSessionId, input.directory));
  if (!messageID) throw new Error('No completed assistant response is available');

  const openingKey = useDisposableSideChatsStore.getState().beginOpening(target);
  if (!openingKey) throw new Error('Failed to reserve side chat');

  let session: Session;
  try {
    const response = await operation.fetch('/api/openchamber/side-chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      query: { directory: input.directory },
      body: JSON.stringify({ parentSessionID: input.parentSessionId, messageID }),
    });
    const payload = await response.json().catch(() => null) as ((Session & SideChatFailurePayload) | SideChatFailurePayload) | null;
    if (!response.ok) {
      const forkSessionID = typeof payload?.forkSessionID === 'string' ? payload.forkSessionID.trim() : '';
      if (payload?.cleanupRequired === true && forkSessionID) {
        useDisposableSideChatsStore.getState().bindSideSession(openingKey, forkSessionID, runtimeKey);
        useDisposableSideChatsStore.getState().setPhase({ ...target, sideSessionId: forkSessionID }, 'cleanup-pending');
      } else {
        useDisposableSideChatsStore.getState().cancelOpening(openingKey, runtimeKey);
      }
      throw new Error(payload?.error || `Side chat request failed (${response.status})`);
    }
    const successfulSession = payload && 'id' in payload ? payload as Session : null;
    if (!successfulSession?.id || getDisposableSideChatParentID(successfulSession) !== input.parentSessionId) {
      throw new Error('Side chat request returned an invalid marked session');
    }
    session = successfulSession;
  } catch (error) {
    const owned = useDisposableSideChatsStore.getState().findByParent(target);
    if (!owned?.sideSessionId) useDisposableSideChatsStore.getState().cancelOpening(openingKey, runtimeKey);
    throw error;
  }

  if (!useDisposableSideChatsStore.getState().bindSideSession(openingKey, session.id, runtimeKey)) {
    throw new Error('Side chat stopped because the runtime changed');
  }

  if (getRuntimeKey() !== runtimeKey) {
    throw new Error('Side chat was created on the previous runtime and is available for recovery there');
  }

  registerSessionDirectory(session.id, input.directory);
  useGlobalSessionsStore.getState().upsertSession(session);
  useSessionUIStore.getState().setSessionDirectory(session.id, input.directory);
  useSelectionStore.getState().saveSessionModelSelection(session.id, input.providerID, input.modelID);
  if (input.agent) {
    useSelectionStore.getState().saveSessionAgentSelection(session.id, input.agent);
    useSelectionStore.getState().saveAgentModelForSession(session.id, input.agent, input.providerID, input.modelID);
    useSelectionStore.getState().saveAgentModelVariantForSession(session.id, input.agent, input.providerID, input.modelID, input.variant);
  }
  openDisposableSideChatPanel(input.directory, session);

  await sendSideChatPrompt({ ...target, sideSessionId: session.id }, input, operation);
  return { sessionId: session.id, created: true };
}
