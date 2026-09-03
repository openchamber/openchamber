import { getRuntimeKey } from '@/lib/runtime-switch';
import { clearChatDraft, createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { useInlineCommentDraftStore } from '@/stores/useInlineCommentDraftStore';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';

export const cleanupPersistedSessionState = async (identity: {
  runtimeKey: string;
  directory: string;
  sessionId: string;
}): Promise<void> => {
  if (identity.runtimeKey !== getRuntimeKey() || !identity.directory || identity.directory === 'global' || !identity.sessionId) return;

  const queueTarget = createMessageQueueTarget(identity.sessionId, identity.directory, identity.runtimeKey);
  const queueCleanup = queueTarget
    ? useMessageQueueStore.getState().purgeQueue(queueTarget)
    : null;
  useTodosPersistStore.getState().clearSessionTodos(identity.runtimeKey, identity.directory, identity.sessionId);
  useSessionFoldersStore.getState().removeSessionEverywhere(identity.runtimeKey, identity.sessionId);
  useInlineCommentDraftStore.getState().clearSessionDrafts(identity.runtimeKey, identity.directory, identity.sessionId);
  useSessionPinnedStore.getState().clearPinnedSession(identity.runtimeKey, identity.directory, identity.sessionId);
  const chatDraftIdentity = createChatDraftIdentity(identity.runtimeKey, identity.directory, identity.sessionId);
  if (chatDraftIdentity) clearChatDraft(chatDraftIdentity, true);
  if (queueCleanup) {
    await queueCleanup.catch((error) => {
      console.warn('[queue] failed to persist confirmed session deletion:', error);
    });
  }
};
