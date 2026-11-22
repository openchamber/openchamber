import { useMemo } from 'react';
import { useChatColumnActions, useChatSessionSelection } from '@/components/chat/chatColumnSession';
import { resolveCommandDirectory } from '@/stores/useCommandsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const useComposerConfigDirectory = (directory: string | null | undefined) => {
  const { sessionId } = useChatSessionSelection();
  const { pinned } = useChatColumnActions();
  const draft = useSessionUIStore((state) => state.newSessionDraft);
  return useMemo(
    () => resolveCommandDirectory(directory, !pinned && !sessionId ? draft : null),
    [directory, draft, pinned, sessionId],
  );
};
