import { getRuntimeKey } from '@/lib/runtime-switch';
import { createMessageQueueTarget, useMessageQueueStore } from '@/stores/messageQueueStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';

export const cleanupPersistedSessionState = (identity: {
  runtimeKey: string;
  directory: string;
  sessionId: string;
}): void => {
  if (identity.runtimeKey !== getRuntimeKey() || !identity.directory || identity.directory === 'global' || !identity.sessionId) return;

  const queueTarget = createMessageQueueTarget(identity.sessionId, identity.directory, identity.runtimeKey);
  if (queueTarget) useMessageQueueStore.getState().clearQueue(queueTarget);
  useTodosPersistStore.getState().clearSessionTodos(identity.runtimeKey, identity.directory, identity.sessionId);
  useSessionFoldersStore.getState().removeSessionEverywhere(identity.runtimeKey, identity.sessionId);
};
